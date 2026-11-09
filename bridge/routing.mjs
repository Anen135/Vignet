import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";

export const failure = (code, message) =>
  Object.assign(new Error(message), { code });
export function secretMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual || "");
  const b = Buffer.from(expected || "");
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}
export class ExtensionRouter {
  constructor({ token = "", timeout = 12000 } = {}) {
    this.token = token;
    this.timeout = timeout;
    this.clients = new Map();
    this.pending = new Map();
  }
  attach(ws) {
    const client = {
      deviceId: randomUUID(),
      authenticated: !this.token,
      modern: false,
    };
    this.clients.set(ws, client);
    const authTimer = setTimeout(() => {
      if (!client.authenticated) ws.close(1008, "Authentication required");
    }, 5000);
    authTimer.unref();
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!m || typeof m !== "object" || Array.isArray(m)) return;
      if (m.type === "hello") {
        if (this.token && !secretMatches(m.token, this.token)) {
          ws.close(1008, "Authentication failed");
          return;
        }
        if (
          typeof m.deviceId !== "string" ||
          !/^[\w-]{1,100}$/.test(m.deviceId)
        )
          return;
        client.deviceId = m.deviceId;
        client.modern = true;
        client.authenticated = true;
        clearTimeout(authTimer);
        ws.send(JSON.stringify({ type: "welcome", deviceId: client.deviceId }));
        return;
      }
      if (!client.authenticated || m.type !== "ack") return;
      const task = this.pending.get(m.requestId);
      if (
        !task ||
        task.ws !== ws ||
        m.phase === "received" ||
        (client.modern && m.phase !== "applied")
      )
        return;
      this.pending.delete(m.requestId);
      clearTimeout(task.timer);
      if (m.ok) task.resolve(m.result ?? m);
      else
        task.reject(
          failure(
            m.error?.code || "EXECUTION_FAILED",
            m.error?.message || m.error || "Extension rejected command",
          ),
        );
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      this.clients.delete(ws);
      for (const [id, task] of this.pending)
        if (task.ws === ws) {
          clearTimeout(task.timer);
          this.pending.delete(id);
          task.reject(failure("EXTENSION_OFFLINE", "Extension disconnected"));
        }
    });
    ws.on("error", (error) =>
      console.error("[Bridge] WebSocket:", error.message),
    );
  }
  available() {
    return [...this.clients].filter(
      ([ws, c]) => c.authenticated && ws.readyState === WebSocket.OPEN,
    );
  }
  select(target) {
    const clients = this.available().filter(
      ([, c]) => !target?.deviceId || c.deviceId === target.deviceId,
    );
    if (!clients.length)
      throw failure("EXTENSION_OFFLINE", "No matching connected extension");
    if (clients.length !== 1)
      throw failure(
        "TARGET_AMBIGUOUS",
        "Select a device using get_contexts and target.deviceId",
      );
    return clients[0];
  }
  request(ws, command, args = {}) {
    const id = randomUUID();
    const client = this.clients.get(ws);
    const packet =
      !client.modern && command === "set_vignette"
        ? { type: "set_vignette", requestId: id, settings: args }
        : { type: "command", requestId: id, command, args };
    const payload = JSON.stringify(packet);
    if (Buffer.byteLength(payload) > 30 * 1024)
      throw failure(
        "PAYLOAD_TOO_LARGE",
        "Use the local package installer for large data",
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure("TIMEOUT", "Extension did not apply command"));
      }, this.timeout);
      this.pending.set(id, { ws, resolve, reject, timer });
      ws.send(payload, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(failure("EXTENSION_OFFLINE", error.message));
        }
      });
    });
  }
  async execute(command, args = {}) {
    if (command === "get_contexts") {
      const clients = this.available();
      const results = await Promise.all(
        clients.map(async ([ws, c]) => ({
          deviceId: c.deviceId,
          ...(await this.request(ws, command, args)),
        })),
      );
      return {
        contexts: results.flatMap((r) =>
          (r.contexts || []).map((c) => ({ ...c, deviceId: r.deviceId })),
        ),
      };
    }
    const [ws] = this.select(args.target);
    return this.request(ws, command, args);
  }
}
