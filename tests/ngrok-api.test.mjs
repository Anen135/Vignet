import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { discoverNgrokUrl } from "../scripts/cloudflare.mjs";

test("ngrok API discovers the matching HTTPS upstream without startup logs", async (t) => {
  let legacy = false;
  let endpoints = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    if (legacy && req.url === "/api/endpoints") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(legacy ? { tunnels: endpoints } : { endpoints }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const apiPort = server.address().port;
  const valid = {
    url: "https://fixed.ngrok-free.app",
    upstream: { url: "http://127.0.0.1:8789" },
  };
  endpoints = [{ ...valid, upstream: { url: "http://127.0.0.1:9999" } }, valid];
  assert.equal(await discoverNgrokUrl(8789, apiPort), valid.url);
  assert.equal(await discoverNgrokUrl(8789, apiPort, valid.url), valid.url);
  assert.equal(
    await discoverNgrokUrl(8789, apiPort, "https://other.ngrok-free.app"),
    "",
  );
  for (const entry of [
    { ...valid, upstream: { url: "http://remote.example:8789" } },
    { ...valid, upstream: { url: "http://127.0.0.1:8789/other" } },
    { ...valid, url: "http://fixed.ngrok-free.app" },
    { ...valid, url: "https://secret@fixed.ngrok-free.app" },
  ]) {
    endpoints = [entry];
    assert.equal(await discoverNgrokUrl(8789, apiPort), "");
  }
  legacy = true;
  endpoints = [{ public_url: valid.url, config: { addr: "localhost:8789" } }];
  assert.equal(await discoverNgrokUrl(8789, apiPort), valid.url);
  await assert.rejects(discoverNgrokUrl(8789, -1), /порт/);
});
