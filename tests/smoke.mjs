// Minimal smoke test of the stdio MCP API + mocked Chrome extension WS.
// Usage: npm test (after npm install). Does not need a browser or OpenAI account.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import { createServer } from "node:net";

const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

const child = spawn(process.execPath, ["bridge/server.mjs"], {
  cwd: new URL("../", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VIGNETTE_PORT: String(port),
    VIGNETTE_DEVICE_TOKEN: "",
  },
});
const responses = new Map();
const awaiting = new Map();
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let packet;
  try {
    packet = JSON.parse(line);
  } catch {
    return;
  }
  if (packet.id === undefined) return;
  const receiver = awaiting.get(packet.id);
  if (receiver) {
    awaiting.delete(packet.id);
    receiver(packet);
  } else responses.set(packet.id, packet);
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

let nextId = 1;
function call(method, params = {}) {
  const id = nextId++;
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
  );
  let timer;
  return Promise.race([
    new Promise((resolve) => {
      if (responses.has(id)) {
        resolve(responses.get(id));
        responses.delete(id);
      } else awaiting.set(id, resolve);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`MCP timeout: ${method}`)),
        20000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
const notify = (method, params = {}) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const assert = (condition, description) => {
  if (!condition) throw new Error(description);
};

async function connectMockExtension() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
        origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "set_vignette") {
          ws.send(
            JSON.stringify({
              type: "ack",
              requestId: message.requestId,
              ok: true,
              tabsUpdated: 1,
            }),
          );
        }
      });
      return ws;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Cannot connect fake extension");
}

let mock;
try {
  const init = await call("initialize", {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "vignette-smoke", version: "0.1.0" },
  });
  assert(
    init.result?.serverInfo?.name === "chatgpt-vignette",
    "MCP initialize failed",
  );
  notify("notifications/initialized");
  const tools = await call("tools/list");
  assert(
    tools.result?.tools?.some((t) => t.name === "set_vignette"),
    "set_vignette missing",
  );
  mock = await connectMockExtension();
  const response = await call("tools/call", {
    name: "set_vignette",
    arguments: {
      enabled: true,
      color: "#cc0000",
      opacity: 0.6,
      innerRadius: 35,
    },
  });
  assert(
    response.result?.structuredContent?.ok === true,
    `Tool failed: ${JSON.stringify(response)}`,
  );
  const status = await call("tools/call", {
    name: "get_vignette_status",
    arguments: {},
  });
  assert(
    status.result?.structuredContent?.extensionConnected,
    "Extension connection not reported",
  );
  console.error(
    "[TEST] MCP initialize / tools/list / WebSocket ack / set_vignette / status: PASS",
  );
} catch (error) {
  console.error("[TEST] FAIL:", error);
  process.exitCode = 1;
} finally {
  mock?.close();
  rl.close();
  child.kill();
}
