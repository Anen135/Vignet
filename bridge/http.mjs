// JSON-response HTTP adapter for the local stdio MCP bridge (no SSE required).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { secretMatches } from "./routing.mjs";
import { createOwnerOAuth } from "./oauth.mjs";
import { readFile, writeFile, rename } from "node:fs/promises";

const port = Number(process.env.VIGNETTE_HTTP_PORT || 8789);
const maxBody = 64 * 1024;
const apiToken = process.env.VIGNETTE_API_TOKEN || "";
const pending = new Map();
let nextId = 1;
let stopping = false;
let childRunning = false;
const approvals = new Map();
let registrations = null;
const registrationFile = process.env.VIGNETTE_OAUTH_CLIENTS;
if (process.env.VIGNETTE_OAUTH === "1" && registrationFile) {
  try {
    registrations = JSON.parse(await readFile(registrationFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
let persistence = Promise.resolve();
const oauth =
  process.env.VIGNETTE_OAUTH === "1"
    ? createOwnerOAuth({
        registrations,
        persist: (snapshot) => {
          if (!registrationFile) return Promise.resolve();
          persistence = persistence
            .catch(() => {})
            .then(async () => {
              const temporary = `${registrationFile}.tmp`;
              await writeFile(temporary, JSON.stringify(snapshot), {
                mode: 0o600,
              });
              await rename(temporary, registrationFile);
            });
          return persistence;
        },
        approve: ({ redirect, verificationCode }) =>
          new Promise((resolve) => {
            if (!process.send || !process.connected) return resolve(false);
            const requestId = nextId++;
            const timer = setTimeout(() => {
              approvals.delete(requestId);
              resolve(false);
            }, 45000);
            approvals.set(requestId, { resolve, timer });
            process.send({
              type: "oauth-approval",
              requestId,
              redirect,
              verificationCode,
              expiresAt: Date.now() + 45000,
            });
          }),
      })
    : null;
if (oauth && process.env.VIGNETTE_PUBLIC_URL)
  oauth.setOrigin(process.env.VIGNETTE_PUBLIC_URL);
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./server.mjs", import.meta.url))],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  },
);
const lines = createInterface({ input: child.stdout });

function reply(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function finish(id, status, packet) {
  const task = pending.get(id);
  if (!task) return;
  pending.delete(id);
  clearTimeout(task.timer);
  reply(task.res, status, { ...packet, id: task.originalId });
}

function failPending(message) {
  for (const id of pending.keys()) {
    finish(id, 502, { jsonrpc: "2.0", error: { code: -32603, message } });
  }
}

lines.on("line", (line) => {
  let packet;
  try {
    packet = JSON.parse(line);
  } catch {
    return;
  }
  if (packet && Object.hasOwn(packet, "id")) finish(packet.id, 200, packet);
});
child.once("spawn", () => {
  childRunning = true;
});
child.once("error", (error) => {
  console.error("[HTTP] MCP process failed:", error.message);
  shutdown(1);
});
child.once("exit", (code, signal) => {
  childRunning = false;
  if (!stopping) {
    console.error(`[HTTP] MCP process exited (${code ?? signal})`);
    shutdown(1);
  }
});
child.stdin.on("error", () => failPending("MCP input closed"));

const server = createServer(async (req, res) => {
  if (oauth && (await oauth.handle(req, res))) return;
  if (req.url === "/health" && req.method === "GET") {
    reply(res, childRunning ? 200 : 503, {
      ok: childRunning,
      ...(process.env.VIGNETTE_INSTANCE_ID
        ? { instanceId: process.env.VIGNETTE_INSTANCE_ID }
        : {}),
    });
    return;
  }
  if (req.url !== "/mcp") {
    reply(res, 404, { error: "Not found" });
    return;
  }
  // Each deployment serves one owner. Public access requires an owner credential;
  // separate processes/storage/credentials are required for separate owners.
  const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(
    req.headers.host || "",
  );
  if (
    apiToken || oauth
      ? !(
          Boolean(apiToken) &&
          secretMatches(
            req.headers.authorization?.replace(/^Bearer /, ""),
            apiToken,
          )
        ) && !oauth?.accepts(req.headers.authorization?.replace(/^Bearer /, ""))
      : !localHost ||
        Boolean(
          req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"],
        )
  ) {
    res.setHeader("WWW-Authenticate", oauth?.challenge() || "Bearer");
    reply(res, 401, {
      error: "AUTH_REQUIRED",
      message: oauth
        ? "Connect using OAuth and approve in the local Vignet terminal"
        : "Configure VIGNETTE_API_TOKEN and provide Authorization: Bearer <token>",
    });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    reply(res, 405, { error: "Use POST; SSE is not supported" });
    return;
  }
  if (!childRunning || stopping) {
    reply(res, 503, { error: "MCP process unavailable" });
    return;
  }
  if (
    req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    reply(res, 415, { error: "Content-Type must be application/json" });
    return;
  }
  if (
    req.headers.accept &&
    !req.headers.accept.includes("application/json") &&
    !req.headers.accept.includes("*/*")
  ) {
    reply(res, 406, { error: "Accept must include application/json" });
    return;
  }
  // A browser must come from the endpoint's own origin; server clients omit Origin.
  if (req.headers.origin) {
    let origin;
    try {
      origin = new URL(req.headers.origin);
    } catch {
      /* invalid origin */
    }
    if (!origin || origin.host !== req.headers.host) {
      reply(res, 403, { error: "Origin not allowed" });
      return;
    }
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBody) {
        reply(res, 413, { error: "Request too large" });
        return;
      }
      chunks.push(chunk);
    }
  } catch {
    reply(res, 400, { error: "Could not read request" });
    return;
  }
  let packet;
  try {
    packet = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    reply(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }
  if (
    !packet ||
    Array.isArray(packet) ||
    packet.jsonrpc !== "2.0" ||
    typeof packet.method !== "string" ||
    (Object.hasOwn(packet, "id") &&
      typeof packet.id !== "string" &&
      typeof packet.id !== "number")
  ) {
    reply(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
    return;
  }
  if (!Object.hasOwn(packet, "id")) {
    // Client IDs are remapped; forwarding cancellation could target another request.
    if (packet.method === "notifications/cancelled") {
      reply(res, 202);
      return;
    }
    child.stdin.write(JSON.stringify(packet) + "\n", (error) => {
      reply(
        res,
        error ? 502 : 202,
        error ? { error: "MCP input closed" } : undefined,
      );
    });
    return;
  }
  const id = nextId++;
  const timer = setTimeout(() => {
    finish(id, 504, {
      jsonrpc: "2.0",
      error: { code: -32603, message: "MCP request timed out" },
    });
  }, 15000);
  pending.set(id, { res, originalId: packet.id, timer });
  res.once("close", () => {
    const task = pending.get(id);
    if (task) {
      clearTimeout(task.timer);
      pending.delete(id);
    }
  });
  child.stdin.write(JSON.stringify({ ...packet, id }) + "\n", (error) => {
    if (error)
      finish(id, 502, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "MCP input closed" },
      });
  });
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.on("error", (error) => {
  console.error("[HTTP] Listen failed:", error.message);
  shutdown(1);
});

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { resolve, timer } of approvals.values()) {
    clearTimeout(timer);
    resolve(false);
  }
  approvals.clear();
  failPending("MCP bridge stopping");
  server.close();
  server.closeAllConnections();
  lines.close();
  child.kill();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}
process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());
if (process.connected) process.once("disconnect", () => shutdown());
// A supervising local parent/test can request graceful shutdown over Node IPC.
process.on("message", (message) => {
  if (message?.type === "shutdown") shutdown();
  if (message?.type === "public-url" && oauth) {
    try {
      oauth.setOrigin(message.url);
    } catch {
      console.error("[HTTP] Invalid public URL");
      shutdown(1);
    }
  }
  if (message?.type === "oauth-decision") {
    const approval = approvals.get(message.requestId);
    if (approval) {
      clearTimeout(approval.timer);
      approvals.delete(message.requestId);
      approval.resolve(message.approved === true);
    }
  }
});
server.listen(port, "127.0.0.1", () => {
  console.error(`[HTTP] MCP listening on http://127.0.0.1:${port}/mcp`);
});
