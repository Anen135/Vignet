import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { ownerCredentials } from "../scripts/credentials.mjs";
import {
  quickTunnelArgs,
  quickTunnelUrl,
  findCloudflared,
  findNgrok,
  ngrokArgs,
  ngrokTunnelUrl,
  ngrokCommand,
  normalizeNgrokDomain,
  ensurePortFree,
  run,
} from "../scripts/cloudflare.mjs";
import { publicOrigin } from "../bridge/oauth.mjs";

test("setup preserves existing owner credentials and rejects corrupt credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vignet-setup-"));
  try {
    const filename = path.join(directory, "credentials.json");
    const first = await ownerCredentials(filename);
    assert.equal(first.credentials.deviceToken.length, 64);
    const original = await readFile(filename, "utf8");
    assert.deepEqual(
      (await ownerCredentials(filename)).credentials,
      first.credentials,
    );
    assert.equal(await readFile(filename, "utf8"), original);
    await writeFile(filename, '{"deviceToken":"short"}');
    await assert.rejects(ownerCredentials(filename), /Invalid/);
    assert.equal(await readFile(filename, "utf8"), '{"deviceToken":"short"}');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cloudflare uses a loopback HTTP origin and accepts only HTTPS public MCP URLs", () => {
  const args = quickTunnelArgs(8789, "C:/User Data/quick.yml");
  assert.equal(args[args.indexOf("--url") + 1], "http://127.0.0.1:8789");
  assert.equal(args[args.indexOf("--config") + 1], "C:/User Data/quick.yml");
  assert.ok(!args.some((value) => /api-key|token|8788/.test(value)));
  assert.throws(() => quickTunnelArgs(0, "config"));
  assert.equal(
    quickTunnelUrl("INF | https://example-test.trycloudflare.com |"),
    "https://example-test.trycloudflare.com",
  );
  assert.equal(quickTunnelUrl("https://example.com"), "");
  assert.equal(
    publicOrigin("https://example.trycloudflare.com/mcp"),
    "https://example.trycloudflare.com",
  );
  for (const value of [
    "http://example.com/mcp",
    "https://user:secret@example.com/mcp",
    "https://example.com/other",
    "https://example.com/mcp?key=secret",
    "https://example.com/mcp#key",
  ])
    assert.throws(() => publicOrigin(value));
});

test("setup detects a busy bridge port and releases its probe", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await assert.rejects(ensurePortFree(port), /занят/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await ensurePortFree(port);
  await ensurePortFree(port);
});

test("setup finds an unpacked client without PATH edits", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vignet-client-"));
  // A root executable wins over PATH candidates.
  const filename = path.join(
    directory,
    process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
  try {
    await writeFile(filename, "test fixture");
    assert.equal(await findCloudflared(directory), filename);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup runner propagates process failures without a shell", async () => {
  await run(process.execPath, ["-e", "process.exit(0)"]);
  await assert.rejects(run(process.execPath, ["-e", "process.exit(7)"]), /7/);
  await assert.rejects(
    run(path.join(tmpdir(), "vignet-nonexistent-executable"), []),
    /ENOENT/,
  );
});

test("ngrok discovers only HTTPS startup URLs for the owned upstream and keeps credentials out of arguments", async () => {
  const args = ngrokArgs(8789, "fixed.ngrok-free.app");
  assert.equal(args[1], "http://127.0.0.1:8789");
  assert.ok(args.includes("--inspect=false"));
  assert.equal(args[args.indexOf("--url") + 1], "https://fixed.ngrok-free.app");
  assert.equal(
    normalizeNgrokDomain("https://fixed.ngrok-free.app/mcp"),
    "https://fixed.ngrok-free.app",
  );
  assert.throws(() => ngrokArgs(8789), /Постоянный домен/);
  assert.throws(() => normalizeNgrokDomain("http://fixed.ngrok-free.app"));
  assert.ok(!args.some((value) => /authtoken|Bearer|api-key/.test(value)));
  assert.throws(() => ngrokArgs(0));
  const entry = {
    msg: "started tunnel",
    addr: "http://127.0.0.1:8789",
    url: "https://fixed.ngrok-free.app",
  };
  assert.equal(ngrokTunnelUrl(JSON.stringify(entry), 8789), entry.url);
  for (const modified of [
    { msg: "starting tunnel" },
    { addr: "http://127.0.0.1:9999" },
    { url: "http://fixed.ngrok-free.app" },
    { url: "https://user:secret@fixed.ngrok-free.app" },
  ]) {
    assert.equal(
      ngrokTunnelUrl(JSON.stringify({ ...entry, ...modified }), 8789),
      "",
    );
  }
  assert.equal(ngrokTunnelUrl("error https://ngrok.com/docs/errors", 8789), "");
  const directory = await mkdtemp(path.join(tmpdir(), "vignet-ngrok-find-"));
  try {
    const filename = path.join(
      directory,
      process.platform === "win32" ? "ngrok.exe" : "ngrok",
    );
    await writeFile(filename, "fixture");
    assert.equal(await findNgrok(directory), filename);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ngrok Store aliases remain executable commands rather than project-relative paths", () => {
  assert.equal(ngrokCommand("ngrok"), "ngrok");
  assert.equal(ngrokCommand(" ngrok.exe "), "ngrok.exe");
  assert.equal(ngrokCommand('"ngrok"'), "ngrok");
  assert.equal(ngrokCommand(""), "ngrok");
  const filename = path.join(tmpdir(), "WindowsApps", "ngrok.exe");
  assert.equal(ngrokCommand(`"${filename}"`), filename);
});
