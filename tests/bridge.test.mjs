import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import { ExtensionRouter } from "../bridge/routing.mjs";

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(25);
  }
  throw new Error(message);
}

test(
  "HTTP MCP preserves tools, authenticates devices, and returns only confirmed routed execution",
  { timeout: 20000 },
  async (t) => {
    const [httpPort, wsPort] = await Promise.all([freePort(), freePort()]);
    const apiToken = "test-owner-credential";
    const deviceToken = "test-device-credential";
    const child = spawn(process.execPath, ["bridge/http.mjs"], {
      cwd: new URL("../", import.meta.url),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        VIGNETTE_HTTP_PORT: String(httpPort),
        VIGNETTE_PORT: String(wsPort),
        VIGNETTE_API_TOKEN: apiToken,
        VIGNETTE_DEVICE_TOKEN: deviceToken,
        VIGNETTE_EXTENSION_ID: "",
      },
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.stdout.resume();
    const sockets = [];
    let nextId = 1;
    const base = `http://127.0.0.1:${httpPort}`;
    async function rpc(method, params = {}) {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    const call = (name, args = {}) =>
      rpc("tools/call", { name, arguments: args });
    async function connect(deviceId, token = deviceToken) {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/extension`, {
        origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      sockets.push(ws);
      await once(ws, "open");
      const seen = [];
      const client = { ws, seen, catalog: ["builtin.vignette"], held: null };
      ws.on("message", (raw) => {
        const packet = JSON.parse(String(raw));
        seen.push(packet);
        if (packet.type !== "command") return;
        ws.send(
          JSON.stringify({
            type: "ack",
            requestId: packet.requestId,
            phase: "received",
            ok: true,
          }),
        );
        let result;
        if (packet.command === "list_assets")
          result = { assets: client.catalog.map((id) => ({ id })) };
        else if (packet.command === "get_contexts")
          result = {
            contexts: [
              { tabId: deviceId === "device-a" ? 11 : 22, chatId: deviceId },
            ],
          };
        else if (packet.command === "set_vignette")
          result = { ok: true, tabsUpdated: 1 };
        else
          result = {
            ok: true,
            instanceId: "confirmed-instance",
            status: "running",
            deviceId,
          };
        const apply = () =>
          ws.send(
            JSON.stringify({
              type: "ack",
              requestId: packet.requestId,
              phase: "applied",
              ok: true,
              result,
            }),
          );
        if (client.hold) client.held = apply;
        else apply();
      });
      ws.send(JSON.stringify({ type: "hello", deviceId, token }));
      if (token === deviceToken)
        await until(
          () => seen.some((packet) => packet.type === "welcome"),
          "Device did not authenticate",
        );
      return client;
    }
    try {
      await until(async () => {
        try {
          return (await fetch(`${base}/health`)).ok;
        } catch {
          return false;
        }
      }, `HTTP not started: ${errors}`);
      await t.test(
        "bearer credential required and protocol initializes",
        async () => {
          for (const authorization of [undefined, "Bearer wrong"]) {
            const response = await fetch(`${base}/mcp`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(authorization ? { Authorization: authorization } : {}),
              },
              body: "{}",
            });
            assert.equal(response.status, 401);
          }
          const initialized = await rpc("initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "bridge-test", version: "1" },
          });
          assert.equal(initialized.result.serverInfo.name, "chatgpt-vignette");
        },
      );
      const before = (await rpc("tools/list")).result.tools;
      assert.equal(before.length, 10);
      assert.deepEqual(
        before.map((tool) => tool.name).sort(),
        [
          "describe_asset",
          "get_asset_status",
          "get_contexts",
          "get_vignette_status",
          "list_asset_instances",
          "list_assets",
          "run_asset",
          "set_vignette",
          "stop_asset",
          "update_asset_instance",
        ].sort(),
      );
      await t.test(
        "offline extension returns machine-readable error",
        async () => {
          const response = await call("list_assets");
          assert.equal(response.result.isError, true);
          assert.equal(
            response.result.structuredContent.error.code,
            "EXTENSION_OFFLINE",
          );
        },
      );
      await t.test(
        "wrong and malformed device credentials cannot authenticate or crash bridge",
        async () => {
          for (const token of ["wrong", {}]) {
            const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/extension`, {
              origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            });
            sockets.push(ws);
            await once(ws, "open");
            ws.send("null");
            ws.send("[]");
            ws.send(
              JSON.stringify({ type: "hello", deviceId: "bad-device", token }),
            );
            const [code] = await once(ws, "close");
            assert.equal(code, 1008);
          }
          assert.equal((await fetch(`${base}/health`)).status, 200);
          assert.equal(
            (await call("list_assets")).result.structuredContent.error.code,
            "EXTENSION_OFFLINE",
          );
        },
      );
      const a = await connect("device-a");
      await t.test(
        "catalog changes without adding tools or restarting MCP",
        async () => {
          assert.deepEqual(
            (await call("list_assets")).result.structuredContent.assets.map(
              (asset) => asset.id,
            ),
            ["builtin.vignette"],
          );
          a.catalog.push("community.rain");
          assert.deepEqual(
            (await call("list_assets")).result.structuredContent.assets.map(
              (asset) => asset.id,
            ),
            ["builtin.vignette", "community.rain"],
          );
          assert.deepEqual((await rpc("tools/list")).result.tools, before);
        },
      );
      await t.test(
        "received ACK cannot complete execution before applied ACK",
        async () => {
          a.hold = true;
          let settled = false;
          const response = call("run_asset", {
            assetId: "community.rain",
            parameters: { intensity: 80, sound: false },
            scope: "current_chat",
          }).then((packet) => {
            settled = true;
            return packet;
          });
          await until(() => a.held, "Command not received");
          await delay(60);
          assert.equal(settled, false);
          a.held();
          a.hold = false;
          const result = (await response).result.structuredContent;
          assert.equal(result.instanceId, "confirmed-instance");
          assert.equal(result.status, "running");
        },
      );
      await t.test(
        "legacy vignette tools retain compatible results",
        async () => {
          const settings = {
            enabled: true,
            color: "#ff0000",
            opacity: 0.7,
            innerRadius: 40,
          };
          const result = (await call("set_vignette", settings)).result
            .structuredContent;
          assert.equal(result.ok, true);
          assert.equal(result.tabsUpdated, 1);
          assert.deepEqual(result.settings, settings);
          const status = (await call("get_vignette_status")).result
            .structuredContent;
          assert.equal(status.extensionConnected, true);
          assert.deepEqual(status.lastSettings, settings);
        },
      );
      const b = await connect("device-b");
      await t.test(
        "ambiguous devices do not receive mutation; explicit device target routes once",
        async () => {
          const sentA = a.seen.filter(
            (packet) => packet.type === "command",
          ).length;
          const sentB = b.seen.filter(
            (packet) => packet.type === "command",
          ).length;
          const ambiguous = await call("run_asset", {
            assetId: "community.rain",
          });
          assert.equal(
            ambiguous.result.structuredContent.error.code,
            "TARGET_AMBIGUOUS",
          );
          assert.equal(
            a.seen.filter((packet) => packet.type === "command").length,
            sentA,
          );
          assert.equal(
            b.seen.filter((packet) => packet.type === "command").length,
            sentB,
          );
          const routed = (
            await call("run_asset", {
              assetId: "community.rain",
              target: { deviceId: "device-b", tabId: 22 },
            })
          ).result.structuredContent;
          assert.equal(routed.deviceId, "device-b");
          assert.equal(
            a.seen.filter((packet) => packet.type === "command").length,
            sentA,
          );
          const contexts = (await call("get_contexts")).result.structuredContent
            .contexts;
          assert.deepEqual(contexts.map((context) => context.deviceId).sort(), [
            "device-a",
            "device-b",
          ]);
        },
      );
    } finally {
      for (const ws of sockets) ws.terminate();
      if (child.connected) child.send({ type: "shutdown" });
      let cleanupTimer;
      try {
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => {
            cleanupTimer = setTimeout(() => {
              if (child.exitCode === null) child.kill();
              resolve();
            }, 4000);
          }),
        ]);
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
  },
);

test("router rejects oversized payloads before sending and times out unconfirmed execution", async () => {
  class Socket extends EventEmitter {
    readyState = WebSocket.OPEN;
    sent = [];
    send(text, callback) {
      this.sent.push(JSON.parse(text));
      callback?.();
    }
    close() {
      this.emit("close");
    }
  }
  const router = new ExtensionRouter({ timeout: 30 });
  const ws = new Socket();
  router.attach(ws);
  ws.emit(
    "message",
    JSON.stringify({ type: "hello", deviceId: "unit-device" }),
  );
  await assert.rejects(
    router.execute("run_asset", {
      assetId: "test.asset",
      parameters: { text: "x".repeat(31000) },
    }),
    (error) => error.code === "PAYLOAD_TOO_LARGE",
  );
  const result = router.execute("run_asset", { assetId: "test.asset" });
  const command = ws.sent.at(-1);
  ws.emit(
    "message",
    JSON.stringify({
      type: "ack",
      requestId: command.requestId,
      phase: "received",
      ok: true,
    }),
  );
  await assert.rejects(result, (error) => error.code === "TIMEOUT");
  assert.equal(router.pending.size, 0);
  ws.close();
});
