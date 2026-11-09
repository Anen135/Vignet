// Single-owner OAuth: authorization is approved only by the local launcher over IPC.
import { createHash, randomBytes } from "node:crypto";
import { secretMatches } from "./routing.mjs";

const random = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("base64url");
const scope = "vignet";

export function publicOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/mcp"].includes(url.pathname)
  ) {
    throw new Error("Укажи публичный HTTPS адрес Cloudflare с путём /mcp.");
  }
  return url.origin;
}

function validRedirect(value) {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      ((url.protocol === "https:" &&
        ["chatgpt.com", "chat.openai.com"].includes(url.hostname) &&
        !url.port) ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

export function createOwnerOAuth({
  approve = async () => false,
  now = Date.now,
  registrations = null,
  persist = async () => {},
} = {}) {
  let origin = "";
  const clients = new Map();
  const codes = new Map();
  const tokens = new Map();
  const refresh = new Map();
  const usedRefresh = new Map();
  const consents = new Map();
  let rate = { start: now(), count: 0 };
  function sweep() {
    for (const map of [clients, codes, tokens, refresh, consents]) {
      for (const [id, entry] of map)
        if (entry.expires <= now() && !entry.pending) map.delete(id);
    }
    const activeFamilies = new Set(
      [...refresh.values()].map((token) => token.family),
    );
    for (const [id, token] of usedRefresh)
      if (!activeFamilies.has(token.family)) usedRefresh.delete(id);
  }
  function snapshot() {
    return {
      origin,
      clients: [...clients]
        .filter(([, client]) => client.approved)
        .map(([id, client]) => [id, { ...client, pending: false }]),
    };
  }
  function revokeFamily(family) {
    for (const map of [tokens, refresh, usedRefresh]) {
      for (const [id, entry] of map)
        if (entry.family === family) map.delete(id);
    }
  }
  function issue(clientId, resource, family = random()) {
    const accessToken = random();
    const refreshToken = random();
    tokens.set(hash(accessToken), {
      clientId,
      resource,
      family,
      expires: now() + 3600000,
    });
    refresh.set(hash(refreshToken), {
      clientId,
      resource,
      family,
      expires: now() + 86400000,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope,
    };
  }
  return {
    setOrigin(value) {
      const next = publicOrigin(value);
      if (next !== origin) {
        clients.clear();
        codes.clear();
        tokens.clear();
        refresh.clear();
        usedRefresh.clear();
        consents.clear();
      }
      origin = next;
      if (
        registrations?.origin === origin &&
        Array.isArray(registrations.clients)
      ) {
        for (const [id, client] of registrations.clients.slice(0, 100)) {
          if (
            /^[A-Za-z0-9_-]{43}$/.test(id) &&
            client?.approved === true &&
            Array.isArray(client.redirects) &&
            client.redirects.every(validRedirect) &&
            ["none", "client_secret_post", "client_secret_basic"].includes(
              client.method,
            ) &&
            (client.method === "none" ||
              /^[A-Za-z0-9_-]{43}$/.test(client.secretHash))
          ) {
            clients.set(id, {
              ...client,
              pending: false,
              expires: Number.MAX_SAFE_INTEGER,
            });
          }
        }
      }
      registrations = null;
    },
    registrations: snapshot,
    challenge() {
      return origin
        ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${scope}"`
        : "Bearer";
    },
    accepts(token) {
      if (!token) return false;
      sweep();
      return tokens.get(hash(token))?.resource === `${origin}/mcp`;
    },
    async handle(req, res) {
      const url = new URL(req.url, "http://localhost");
      if (
        !url.pathname.startsWith("/oauth/") &&
        !url.pathname.startsWith("/.well-known/")
      )
        return false;
      if (!origin) {
        json(res, 503, { error: "temporarily_unavailable" });
        return true;
      }
      sweep();
      if (now() - rate.start > 60000) rate = { start: now(), count: 0 };
      if (++rate.count > 120) {
        json(res, 429, { error: "rate_limit_exceeded" });
        return true;
      }
      try {
        if (
          req.method === "GET" &&
          [
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/mcp",
          ].includes(url.pathname)
        ) {
          json(res, 200, {
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            scopes_supported: [scope],
            bearer_methods_supported: ["header"],
          });
        } else if (
          req.method === "GET" &&
          url.pathname === "/.well-known/oauth-authorization-server"
        ) {
          json(res, 200, {
            issuer: origin,
            authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/oauth/token`,
            registration_endpoint: `${origin}/oauth/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: [
              "none",
              "client_secret_post",
              "client_secret_basic",
            ],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: [scope],
          });
        } else if (
          req.method === "POST" &&
          url.pathname === "/oauth/register"
        ) {
          if (clients.size >= 100) {
            const disposable = [...clients].find(
              ([, client]) => !client.approved && !client.pending,
            );
            if (disposable) clients.delete(disposable[0]);
            else {
              json(res, 429, { error: "registration_limit" });
              return true;
            }
          }
          if (req.headers["content-type"]?.split(";")[0] !== "application/json")
            throw new Error("Expected JSON");
          const input = JSON.parse(await body(req));
          const method =
            input.token_endpoint_auth_method || "client_secret_basic";
          if (
            !Array.isArray(input.redirect_uris) ||
            !input.redirect_uris.length ||
            input.redirect_uris.length > 10 ||
            !input.redirect_uris.every(validRedirect) ||
            !["none", "client_secret_post", "client_secret_basic"].includes(
              method,
            )
          ) {
            json(res, 400, { error: "invalid_client_metadata" });
            return true;
          }
          const clientId = random();
          const clientSecret = method === "none" ? undefined : random();
          clients.set(clientId, {
            redirects: input.redirect_uris,
            method,
            secretHash: clientSecret ? hash(clientSecret) : "",
            expires: now() + 600000,
            approved: false,
          });
          json(res, 201, {
            client_id: clientId,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
            redirect_uris: input.redirect_uris,
            token_endpoint_auth_method: method,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          });
        } else if (
          req.method === "GET" &&
          url.pathname === "/oauth/authorize"
        ) {
          const p = url.searchParams;
          const client = clients.get(p.get("client_id"));
          const redirect = p.get("redirect_uri");
          const resource = p.get("resource");
          if (
            !client ||
            !client.redirects.includes(redirect) ||
            p.get("response_type") !== "code" ||
            p.get("code_challenge_method") !== "S256" ||
            !/^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") || "") ||
            resource !== `${origin}/mcp` ||
            (p.get("scope") && p.get("scope") !== scope)
          ) {
            json(res, 400, { error: "invalid_request" });
            return true;
          }
          if (consents.size >= 5 || client.pending || codes.size >= 100) {
            json(res, 429, { error: "too_many_requests" });
            return true;
          }
          // Pair the browser and terminal request so the owner cannot accidentally
          // approve a different caller's authorization attempt.
          const ticket = random();
          const verificationCode = randomBytes(4).toString("hex").toUpperCase();
          const consent = { expires: now() + 60000, destination: null };
          consents.set(ticket, consent);
          client.pending = true;
          const issuedOrigin = origin;
          const destination = new URL(redirect);
          if (p.has("state"))
            destination.searchParams.set("state", p.get("state"));
          let timer;
          const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 45000);
            timer.unref?.();
          });
          Promise.race([
            Promise.resolve().then(() =>
              approve({
                redirect,
                clientId: p.get("client_id"),
                verificationCode,
              }),
            ),
            timeout,
          ])
            .then(async (granted) => {
              if (
                granted &&
                issuedOrigin === origin &&
                consent.expires > now() &&
                consents.get(ticket) === consent
              ) {
                client.approved = true;
                client.expires = Number.MAX_SAFE_INTEGER;
                await persist(snapshot());
                if (issuedOrigin !== origin) throw new Error("Origin changed");
                const code = random();
                codes.set(hash(code), {
                  clientId: p.get("client_id"),
                  redirect,
                  resource,
                  challenge: p.get("code_challenge"),
                  expires: now() + 60000,
                });
                destination.searchParams.set("code", code);
              } else destination.searchParams.set("error", "access_denied");
              consent.destination = destination.href;
            })
            .catch(() => {
              destination.searchParams.set("error", "access_denied");
              consent.destination = destination.href;
            })
            .finally(() => {
              clearTimeout(timer);
              client.pending = false;
            });
          const nonce = random();
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
            "X-Content-Type-Options": "nosniff",
          });
          res.end(
            `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Подключение Vignet</title><h1>Подключение Vignet</h1><p>Сверь код с запросом в терминале Vignet и введи там «да».</p><h2>${verificationCode}</h2><p id="status">Ожидание подтверждения владельца…</p><script nonce="${nonce}">const ticket="${ticket}"; async function poll(){try{const r=await fetch('/oauth/consent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})});const d=await r.json();if(d.redirect){location.assign(d.redirect);return}if(!r.ok){document.getElementById('status').textContent='Запрос истёк. Повтори подключение из ChatGPT.';return}setTimeout(poll,1000)}catch{document.getElementById('status').textContent='Связь прервана. Повтори подключение.'}}poll();</script></html>`,
          );
        } else if (req.method === "POST" && url.pathname === "/oauth/consent") {
          if (req.headers["content-type"]?.split(";")[0] !== "application/json")
            throw new Error("Expected JSON");
          const { ticket } = JSON.parse(await body(req));
          const consent = consents.get(ticket);
          if (!consent) json(res, 400, { error: "expired_request" });
          else if (!consent.destination) json(res, 200, { pending: true });
          else {
            consents.delete(ticket);
            json(res, 200, { redirect: consent.destination });
          }
        } else if (req.method === "POST" && url.pathname === "/oauth/token") {
          if (
            req.headers["content-type"]?.split(";")[0] !==
            "application/x-www-form-urlencoded"
          )
            throw new Error("Expected form data");
          const p = new URLSearchParams(await body(req));
          let clientId = p.get("client_id");
          let secret = p.get("client_secret");
          const basic = req.headers.authorization?.startsWith("Basic ");
          if (basic) {
            const decoded = Buffer.from(
              req.headers.authorization.slice(6),
              "base64",
            ).toString();
            const separator = decoded.indexOf(":");
            clientId = decodeURIComponent(decoded.slice(0, separator));
            secret = decodeURIComponent(decoded.slice(separator + 1));
          }
          const client = clients.get(clientId);
          if (
            !client ||
            (client.method === "none"
              ? basic || Boolean(secret)
              : (client.method === "client_secret_basic") !== Boolean(basic) ||
                !secretMatches(secret ? hash(secret) : "", client.secretHash))
          ) {
            json(res, 401, { error: "invalid_client" });
            return true;
          }
          if (p.get("grant_type") === "authorization_code") {
            const codeKey = hash(p.get("code") || "");
            const code = codes.get(codeKey);
            // Consume even a failed exchange: codes are single use.
            codes.delete(codeKey);
            const verifier = p.get("code_verifier") || "";
            if (
              !code ||
              code.clientId !== clientId ||
              code.redirect !== p.get("redirect_uri") ||
              code.resource !== p.get("resource") ||
              !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
              !secretMatches(hash(verifier), code.challenge)
            ) {
              json(res, 400, { error: "invalid_grant" });
              return true;
            }
            if (tokens.size >= 200 || refresh.size >= 200)
              json(res, 429, { error: "token_limit" });
            else json(res, 200, issue(clientId, code.resource));
          } else if (p.get("grant_type") === "refresh_token") {
            const key = hash(p.get("refresh_token") || "");
            const token = refresh.get(key);
            const reused = usedRefresh.get(key);
            if (reused?.clientId === clientId) {
              revokeFamily(reused.family);
            }
            if (
              !token ||
              token.clientId !== clientId ||
              (p.has("resource") && p.get("resource") !== token.resource) ||
              token.resource !== `${origin}/mcp`
            ) {
              json(res, 400, { error: "invalid_grant" });
              return true;
            }
            if (usedRefresh.size >= 1000) {
              const oldestFamily = usedRefresh.values().next().value.family;
              revokeFamily(oldestFamily);
              if (oldestFamily === token.family) {
                json(res, 400, { error: "invalid_grant" });
                return true;
              }
            }
            if (tokens.size >= 200) {
              json(res, 429, { error: "token_limit" });
              return true;
            }
            refresh.delete(key);
            usedRefresh.set(key, { clientId, family: token.family });
            json(res, 200, issue(clientId, token.resource, token.family));
          } else json(res, 400, { error: "unsupported_grant_type" });
        } else json(res, 404, { error: "not_found" });
      } catch {
        if (!res.headersSent) json(res, 400, { error: "invalid_request" });
      }
      return true;
    },
  };
}
