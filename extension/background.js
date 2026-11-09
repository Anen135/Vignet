import { VignetStore } from "./storage/store.js";
import { AssetRuntime } from "./core/runtime.js";
import { VignetController } from "./core/controller.js";

const store = new VignetStore();
const controller = new VignetController({
  store,
  runtime: new AssetRuntime({ store, chromeApi: chrome }),
  chromeApi: chrome,
});
let queue = Promise.resolve();
let socket = null,
  retryTimer,
  heartbeatTimer;
const completed = new Map();
const ready = controller.init();
ready.catch((e) => console.error("[Vignet] Initialization failed", e));
function serialize(fn) {
  const result = queue.then(() => ready).then(fn);
  queue = result.catch(() => {});
  return result;
}
function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function coded(e) {
  return {
    code: e.code || "EXECUTION_FAILED",
    message: String(e.message || e),
  };
}
async function config() {
  const { vignetConnection = {} } =
    await chrome.storage.local.get("vignetConnection");
  return { endpoint: "ws://127.0.0.1:8788/extension", ...vignetConnection };
}
async function connect() {
  if (
    socket &&
    [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)
  )
    return;
  clearTimeout(retryTimer);
  try {
    const cfg = await config();
    const { vignetDeviceId } = await chrome.storage.local.get("vignetDeviceId");
    const deviceId = vignetDeviceId || crypto.randomUUID();
    if (!vignetDeviceId)
      await chrome.storage.local.set({ vignetDeviceId: deviceId });
    const ws = new WebSocket(cfg.endpoint);
    socket = ws;
    ws.onopen = () => {
      send(ws, {
        type: "hello",
        deviceId,
        token: cfg.deviceToken || "",
        protocolVersion: 1,
      });
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => send(ws, { type: "ping" }), 20000);
    };
    ws.onmessage = ({ data }) => {
      if (new TextEncoder().encode(data).length > 32 * 1024) {
        ws.close(1009, "Payload too large");
        return;
      }
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (!m || typeof m !== "object" || Array.isArray(m)) return;
      if (m.type === "welcome") {
        controller.diagnostics = {
          connected: true,
          deviceId,
          endpoint: cfg.endpoint,
        };
        return;
      }
      if (
        !["command", "set_vignette"].includes(m.type) ||
        typeof m.requestId !== "string"
      )
        return;
      const fingerprint = JSON.stringify([
        m.command || m.type,
        m.args || m.settings,
      ]);
      const old = completed.get(m.requestId);
      if (old) {
        if (old.fingerprint !== fingerprint)
          send(ws, {
            type: "ack",
            requestId: m.requestId,
            phase: "applied",
            ok: false,
            error: {
              code: "REQUEST_ID_CONFLICT",
              message: "requestId already used",
            },
          });
        else old.promise.then((result) => send(ws, result));
        return;
      }
      send(ws, { type: "ack", requestId: m.requestId, phase: "received" });
      const promise = serialize(async () => {
        const { vignetReceipts = [] } =
          await chrome.storage.local.get("vignetReceipts");
        const saved = vignetReceipts.find((r) => r.requestId === m.requestId);
        if (saved)
          return saved.fingerprint === fingerprint
            ? saved.result
            : {
                type: "ack",
                requestId: m.requestId,
                phase: "applied",
                ok: false,
                error: {
                  code: "REQUEST_ID_CONFLICT",
                  message: "requestId already used",
                },
              };
        let result;
        try {
          result = {
            type: "ack",
            requestId: m.requestId,
            phase: "applied",
            ok: true,
            result: await controller.execute(
              m.command || m.type,
              m.args || m.settings,
            ),
          };
        } catch (e) {
          result = {
            type: "ack",
            requestId: m.requestId,
            phase: "applied",
            ok: false,
            error: coded(e),
          };
        }
        if (new TextEncoder().encode(JSON.stringify(result)).length > 30000)
          result = {
            type: "ack",
            requestId: m.requestId,
            phase: "applied",
            ok: false,
            error: {
              code: "PAYLOAD_TOO_LARGE",
              message:
                "Result exceeds WebSocket limit; use local management UI",
            },
          };
        await chrome.storage.local.set({
          vignetReceipts: [
            ...vignetReceipts.slice(-31),
            { requestId: m.requestId, fingerprint, result },
          ],
        });
        return result;
      }).catch((e) => ({
        type: "ack",
        requestId: m.requestId,
        phase: "applied",
        ok: false,
        error: coded(e),
      }));
      completed.set(m.requestId, { fingerprint, promise });
      if (completed.size > 64) completed.delete(completed.keys().next().value);
      promise.then((result) => send(ws, result));
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      controller.diagnostics.connected = false;
      clearInterval(heartbeatTimer);
      retryTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => {};
  } catch (e) {
    controller.diagnostics = { connected: false, error: coded(e) };
    retryTimer = setTimeout(connect, 3000);
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "VIGNET_READY" && sender.tab) {
    serialize(() =>
      controller.navigate(sender.tab.id, sender.tab.url, { reload: true }),
    ).then(
      () => respond({ ok: true }),
      (e) => respond({ ok: false, error: coded(e) }),
    );
    return true;
  }
  if (message?.type === "VIGNETTE_CONNECT") {
    connect();
    respond({ ok: true });
    return;
  }
  if (message?.type !== "VIGNET_UI") return;
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL("ui/"))
  ) {
    respond({
      ok: false,
      error: { code: "PERMISSION_REQUIRED", message: "Open Vignet management" },
    });
    return;
  }
  serialize(async () => {
    if (message.command === "settings") {
      const args = message.args || {};
      if (args.endpoint === undefined) return { connection: await config() };
      const url = new URL(args.endpoint);
      if (
        url.protocol !== "wss:" &&
        !(
          url.protocol === "ws:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )
      )
        throw Object.assign(new Error("Remote endpoints must use wss://"), {
          code: "INVALID_PARAMETERS",
        });
      if (url.username || url.password || url.search || url.hash)
        throw new Error("Use deviceToken field for authentication");
      const deviceToken =
        args.deviceToken || (await config()).deviceToken || "";
      if (url.protocol === "wss:" && !deviceToken)
        throw new Error("Remote connection requires a device token");
      await chrome.storage.local.set({
        vignetConnection: { endpoint: url.href, deviceToken },
      });
      socket?.close();
      socket = null;
      await connect();
      return {};
    }
    return controller.ui(message.command, message.args || {});
  }).then(
    (result) => respond({ ok: true, ...result }),
    (e) => respond({ ok: false, error: coded(e) }),
  );
  return true;
});
chrome.webNavigation.onHistoryStateUpdated.addListener(
  ({ tabId, frameId, url }) => {
    if (frameId === 0)
      serialize(() => controller.navigate(tabId, url)).catch(console.error);
  },
  { url: [{ hostEquals: "chatgpt.com" }] },
);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url)
    serialize(() => controller.navigate(tabId, change.url)).catch(
      console.error,
    );
});
chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => controller.closeTab(tabId)).catch(console.error);
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("bridge-reconnect", { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bridge-reconnect") connect();
});
chrome.alarms.create("bridge-reconnect", { periodInMinutes: 0.5 });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
connect();
