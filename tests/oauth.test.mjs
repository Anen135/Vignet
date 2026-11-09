import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { createOwnerOAuth } from "../bridge/oauth.mjs";

const origin = "https://vignet-test.trycloudflare.com";
const redirect = "https://chatgpt.com/connector_platform/oauth_redirect";
const resource = `${origin}/mcp`;
const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const initialization = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "oauth-test", version: "1" },
  },
};

async function fixture(t, approve = async () => true, options = {}) {
  let time = Date.now();
  const oauth = createOwnerOAuth({ approve, now: () => time, ...options });
  oauth.setOrigin(origin);
  const server = createServer(async (req, res) => {
    if (!(await oauth.handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    oauth,
    base,
    advance: (ms) => {
      time += ms;
    },
  };
}
async function register(base, metadata = {}) {
  return fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      ...metadata,
    }),
  });
}
function authorization(clientId, params = {}) {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    resource,
    scope: "vignet",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "owner-state",
    ...params,
  });
}
async function getCode(base, clientId, params) {
  const response = await fetch(
    `${base}/oauth/authorize?${authorization(clientId, params)}`,
    { redirect: "manual" },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<h2>[A-F0-9]{8}<\/h2>/);
  assert.match(
    response.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  const ticket = html.match(/const ticket="([A-Za-z0-9_-]+)"/)[1];
  let destination;
  for (let n = 0; n < 20; n++) {
    const poll = await fetch(`${base}/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    const result = await poll.json();
    if (result.redirect) {
      destination = result.redirect;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(destination, "owner consent did not complete");
  const location = new URL(destination);
  assert.equal(location.searchParams.get("state"), "owner-state");
  return location.searchParams.get("code");
}
const exchange = (base, clientId, code, extra = {}, headers = {}) =>
  fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirect,
      resource,
      code_verifier: verifier,
      ...extra,
    }),
  });

test("OAuth discovery is pinned to configured HTTPS origin; DCR rejects unsafe redirects", async (t) => {
  const { oauth, base } = await fixture(t);
  const metadata = await (
    await fetch(`${base}/.well-known/oauth-authorization-server`, {
      headers: { "X-Forwarded-Host": "evil.example" },
    })
  ).json();
  assert.equal(metadata.issuer, origin);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(
    (
      await (
        await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)
      ).json()
    ).resource,
    resource,
  );
  assert.match(oauth.challenge(), /resource_metadata=/);
  for (const uri of [
    "https://chatgpt.com.evil.example/callback",
    "https://evil.example/callback",
    "http://chatgpt.com/callback",
    "https://user@chatgpt.com/callback",
    "https://chatgpt.com/callback#fragment",
  ]) {
    assert.equal((await register(base, { redirect_uris: [uri] })).status, 400);
  }
  assert.equal(
    (await register(base, { token_endpoint_auth_method: "unsupported" }))
      .status,
    400,
  );
});

test("owner consent, S256 PKCE, resource binding, single-use codes and rotating refresh", async (t) => {
  let approved = false;
  const { oauth, base, advance } = await fixture(t, async () => approved);
  const client = await (await register(base)).json();
  assert.equal(
    await getCode(base, client.client_id),
    null,
    "denial cannot issue a code",
  );
  approved = true;
  const code = await getCode(base, client.client_id);
  const response = await exchange(base, client.client_id, code);
  assert.equal(response.status, 200);
  const token = await response.json();
  assert.ok(oauth.accepts(token.access_token));
  assert.ok(!oauth.accepts(token.refresh_token));
  assert.equal((await exchange(base, client.client_id, code)).status, 400);
  const wrongVerifierCode = await getCode(base, client.client_id);
  assert.equal(
    (
      await exchange(base, client.client_id, wrongVerifierCode, {
        code_verifier: "x".repeat(64),
      })
    ).status,
    400,
  );
  assert.equal(
    (await exchange(base, client.client_id, wrongVerifierCode)).status,
    400,
  );
  const wrongResourceCode = await getCode(base, client.client_id);
  assert.equal(
    (
      await exchange(base, client.client_id, wrongResourceCode, {
        resource: "https://evil.example/mcp",
      })
    ).status,
    400,
  );
  const invalidAuthorize = await fetch(
    `${base}/oauth/authorize?${authorization(client.client_id, { code_challenge_method: "plain" })}`,
  );
  assert.equal(invalidAuthorize.status, 400);
  const swappedRedirect = await fetch(
    `${base}/oauth/authorize?${authorization(client.client_id, { redirect_uri: "https://chatgpt.com/other" })}`,
  );
  assert.equal(swappedRedirect.status, 400);
  advance(3600001);
  assert.ok(!oauth.accepts(token.access_token));
  const refreshBody = {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: token.refresh_token,
    resource,
  };
  const refreshCall = () =>
    fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(refreshBody),
    });
  const refreshed = await refreshCall();
  assert.equal(refreshed.status, 200);
  const renewed = await refreshed.json();
  assert.ok(oauth.accepts(renewed.access_token));
  assert.equal((await refreshCall()).status, 400);
  assert.ok(
    !oauth.accepts(renewed.access_token),
    "refresh replay must revoke the active token family",
  );
  assert.equal(
    (
      await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...refreshBody,
          refresh_token: renewed.refresh_token,
        }),
      })
    ).status,
    400,
  );
  const expired = await getCode(base, client.client_id);
  advance(60001);
  assert.equal((await exchange(base, client.client_id, expired)).status, 400);
  oauth.setOrigin("https://different.trycloudflare.com/mcp");
  assert.ok(!oauth.accepts(token.access_token));
});

test("confidential DCR clients must authenticate at the token endpoint", async (t) => {
  const { base } = await fixture(t);
  const client = await (
    await register(base, { token_endpoint_auth_method: "client_secret_basic" })
  ).json();
  const code = await getCode(base, client.client_id);
  assert.equal((await exchange(base, client.client_id, code)).status, 401);
  assert.equal(
    (
      await exchange(base, client.client_id, code, {
        client_secret: client.client_secret,
      })
    ).status,
    401,
  );
  const basic = Buffer.from(
    `${client.client_id}:${client.client_secret}`,
  ).toString("base64");
  assert.equal(
    (
      await exchange(
        base,
        client.client_id,
        code,
        {},
        { Authorization: `Basic ${basic}` },
      )
    ).status,
    200,
  );
});

test("approved registrations survive a day and can be restored without storing access tokens", async (t) => {
  let stored;
  const first = await fixture(t, async () => true, {
    persist: async (snapshot) => {
      stored = snapshot;
    },
  });
  const client = await (await register(first.base)).json();
  const code = await getCode(first.base, client.client_id);
  let token = await (await exchange(first.base, client.client_id, code)).json();
  const refreshCall = () =>
    fetch(`${first.base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: token.refresh_token,
        resource,
      }),
    });
  first.advance(23 * 3600000);
  let response = await refreshCall();
  assert.equal(response.status, 200);
  token = await response.json();
  first.advance(2 * 3600000);
  response = await refreshCall();
  assert.equal(
    response.status,
    200,
    "client registration must not expire at 24h",
  );
  assert.ok(!JSON.stringify(stored).includes(token.access_token));
  const restored = await fixture(t, async () => true, {
    registrations: stored,
  });
  assert.ok(await getCode(restored.base, client.client_id));
});

test("a registration cannot expire while its owner consent is pending", async (t) => {
  let f;
  f = await fixture(t, async () => {
    f.advance(2);
    f.oauth.accepts("trigger-sweep");
    return true;
  });
  const client = await (await register(f.base)).json();
  f.advance(599999);
  const code = await getCode(f.base, client.client_id);
  assert.equal((await exchange(f.base, client.client_id, code)).status, 200);
});

test("bounded refresh history expires a grant and fresh owner authorization recovers immediately", async (t) => {
  const f = await fixture(t);
  const client = await (await register(f.base)).json();
  let code = await getCode(f.base, client.client_id);
  let token = await (await exchange(f.base, client.client_id, code)).json();
  async function refreshInMemory() {
    const req = Readable.from([
      Buffer.from(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: token.refresh_token,
          resource,
        }).toString(),
      ),
    ]);
    req.url = "/oauth/token";
    req.method = "POST";
    req.headers = { "content-type": "application/x-www-form-urlencoded" };
    let status;
    let result;
    await f.oauth.handle(req, {
      writeHead(code) {
        status = code;
      },
      end(value) {
        result = JSON.parse(value);
      },
    });
    return { status, json: async () => result };
  }
  for (let n = 0; n < 1000; n++) {
    f.advance(61000);
    const response = await refreshInMemory();
    assert.equal(response.status, 200);
    token = await response.json();
  }
  f.advance(61000);
  const exhausted = await fetch(`${f.base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: token.refresh_token,
      resource,
    }),
  });
  assert.equal(exhausted.status, 400);
  assert.equal((await exhausted.json()).error, "invalid_grant");
  assert.ok(!f.oauth.accepts(token.access_token));
  code = await getCode(f.base, client.client_id);
  assert.equal((await exchange(f.base, client.client_id, code)).status, 200);
});

test(
  "HTTP Bridge discovers OAuth, requires local IPC consent and accepts the issued access token",
  { timeout: 15000 },
  async () => {
    async function port() {
      const s = createServer();
      await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
      const p = s.address().port;
      await new Promise((resolve) => s.close(resolve));
      return p;
    }
    const httpPort = await port();
    const wsPort = await port();
    const child = spawn(process.execPath, ["bridge/http.mjs"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      env: {
        ...process.env,
        VIGNETTE_HTTP_PORT: String(httpPort),
        VIGNETTE_PORT: String(wsPort),
        VIGNETTE_OAUTH: "1",
        VIGNETTE_PUBLIC_URL: origin,
        VIGNETTE_API_TOKEN: "local-test-owner-token",
        VIGNETTE_DEVICE_TOKEN: "local-test-device-token",
      },
    });
    let logs = "";
    child.stdout.on("data", (b) => (logs += b));
    child.stderr.on("data", (b) => (logs += b));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    let approvals = 0;
    child.on("message", (message) => {
      if (message?.type === "oauth-approval") {
        approvals++;
        child.send({
          type: "oauth-decision",
          requestId: message.requestId,
          approved: true,
        });
      }
    });
    const base = `http://127.0.0.1:${httpPort}`;
    try {
      let healthy = false;
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch(`${base}/health`)).ok) {
            healthy = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.ok(healthy, logs);
      const request = (token) =>
        fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(initialization),
        });
      const denied = await request();
      assert.equal(denied.status, 401);
      assert.match(
        denied.headers.get("www-authenticate"),
        /resource_metadata=/,
      );
      const client = await (await register(base)).json();
      const code = await getCode(base, client.client_id);
      assert.equal(approvals, 1);
      const token = await (await exchange(base, client.client_id, code)).json();
      assert.equal((await request(token.access_token)).status, 200);
      assert.equal((await request("wrong-token")).status, 401);
      assert.ok(!logs.includes(token.access_token));
      assert.ok(!logs.includes("local-test-owner-token"));
    } finally {
      if (child.connected) child.send({ type: "shutdown" });
      await exited;
    }
  },
);
