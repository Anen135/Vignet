import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
test("private launcher provisions external owner credentials, enforces auth and shuts down its process tree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vignet-launcher-"));
  const config = path.join(dir, "credentials.json");
  const port = await freePort();
  const wsPort = await freePort();
  const child = spawn(process.execPath, ["scripts/start-private.mjs"], {
    env: {
      ...process.env,
      VIGNETTE_CONFIG: config,
      VIGNETTE_HTTP_PORT: String(port),
      VIGNETTE_PORT: String(wsPort),
      VIGNETTE_API_TOKEN: "",
      VIGNETTE_DEVICE_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let logs = "";
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const url = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let n = 0; n < 150; n++) {
      try {
        if ((await fetch(`${url}/health`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ready, `launcher did not become healthy: ${logs}`);
    const credentials = JSON.parse(await readFile(config, "utf8"));
    assert.equal(credentials.apiToken.length, 64);
    assert.equal(credentials.deviceToken.length, 64);
    assert.notEqual(credentials.apiToken, credentials.deviceToken);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "launcher-test", version: "1" },
      },
    });
    assert.equal(
      (
        await fetch(`${url}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      ).status,
      401,
    );
    const response = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.apiToken}`,
      },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).result.serverInfo.name,
      "chatgpt-vignette",
    );
    assert.ok(!logs.includes(credentials.apiToken));
    assert.ok(!logs.includes(credentials.deviceToken));
  } finally {
    if (child.connected) child.send({ type: "shutdown" });
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
  await assert.rejects(fetch(`${url}/health`));
});
