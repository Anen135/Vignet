// This function is serialized into USER_SCRIPT. Never evaluated in a privileged world.
export async function executeLifecycle(operation, payload) {
  const global = globalThis;
  const registry =
    global.__vignetInstances || (global.__vignetInstances = new Map());
  const { instance } = payload;
  const id = instance.instanceId;
  const existing = registry.get(id);
  const failure = (error) => ({
    ok: false,
    code: error.code || "SCRIPT_EXECUTION_FAILED",
    error: error.message,
  });
  const budget = Math.max(
    10,
    Math.min(4000, payload.lifecycleTimeoutMs || 4000),
  );
  function bounded(call, signal) {
    let timer;
    let aborted;
    const pending = new Promise((resolve, reject) => {
      aborted = () =>
        reject(
          Object.assign(new Error("Instance stopped"), {
            code: "CONTEXT_UNAVAILABLE",
          }),
        );
      timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error("Asset lifecycle timed out"), {
              code: "TIMEOUT",
            }),
          ),
        budget,
      );
      signal?.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(call).then(resolve, reject);
      if (signal?.aborted) aborted();
    });
    return pending.finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    });
  }
  async function stop(record) {
    if (record.stopped) return record.stopPromise;
    record.stopped = true;
    // Managed resources disappear synchronously, before arbitrary user teardown.
    record.controller.abort();
    for (const dispose of record.cleanup.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        /* best effort */
      }
    }
    record.host.remove();
    if (registry.get(id) === record) registry.delete(id);
    record.stopPromise = bounded(() =>
      Promise.all([
        Promise.resolve().then(() =>
          record.lifecycle.unmount?.(record.context),
        ),
        Promise.resolve().then(() =>
          typeof record.handle === "function" ? record.handle() : undefined,
        ),
      ]),
    );
    return record.stopPromise;
  }
  try {
    if (operation === "unmount") {
      if (existing) await stop(existing);
      return { ok: true, status: "stopped", instanceId: id };
    }
    if (operation === "status")
      return {
        ok: true,
        status: existing ? "running" : "stopped",
        instanceId: id,
      };
    if (operation === "action") {
      if (!existing)
        throw Object.assign(new Error("Instance is not running"), {
          code: "INSTANCE_NOT_FOUND",
        });
      const action =
        existing.lifecycle.actions?.[payload.action] ||
        existing.lifecycle[payload.action];
      if (typeof action !== "function")
        throw Object.assign(new Error("Action not implemented"), {
          code: "UNSUPPORTED_ACTION",
        });
      try {
        const value = await bounded(
          () => action(existing.context, payload.parameters),
          existing.controller.signal,
        );
        return {
          ok: true,
          status: "running",
          instanceId: id,
          result: value ?? null,
        };
      } catch (error) {
        stop(existing).catch(() => {});
        throw error;
      }
    }
    if (operation === "update" && existing) {
      if (typeof existing.lifecycle.update !== "function")
        throw Object.assign(new Error("Asset does not support live updates"), {
          code: "UNSUPPORTED_ACTION",
        });
      try {
        await bounded(
          () =>
            existing.lifecycle.update(existing.context, instance.parameters),
          existing.controller.signal,
        );
      } catch (error) {
        stop(existing).catch(() => {});
        throw error;
      }
      return {
        ok: true,
        status: "running",
        instanceId: id,
        warnings: existing.warnings,
      };
    }
    if (existing) await stop(existing);
    const host = document.createElement("div");
    host.dataset.vignetInstance = id;
    host.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    const root = host.attachShadow({ mode: "open" });
    const controller = new AbortController();
    const cleanup = [];
    const warnings = [];
    const resources = new Map();
    const record = {
      host,
      controller,
      cleanup,
      warnings,
      lifecycle: global.VignetAssetLifecycle || {},
      context: null,
    };
    registry.set(id, record);
    const active = () => {
      if (controller.signal.aborted)
        throw Object.assign(
          new Error("Instance stopped; managed resources cannot be created"),
          { code: "CONTEXT_UNAVAILABLE" },
        );
    };
    const resource = (path) => {
      active();
      path = path.replace(/^vignet-media:\/\//, "");
      if (!resources.has(path)) {
        const item = payload.media[path];
        if (!item) throw new Error(`Resource not found: ${path}`);
        const bytes = Uint8Array.from(atob(item.base64), (c) =>
          c.charCodeAt(0),
        );
        const url = URL.createObjectURL(new Blob([bytes], { type: item.mime }));
        resources.set(path, url);
        cleanup.push(() => URL.revokeObjectURL(url));
      }
      return resources.get(path);
    };
    const context = {
      root,
      signal: controller.signal,
      instanceId: id,
      resource,
      onCleanup(fn) {
        if (controller.signal.aborted) {
          fn();
          active();
        }
        cleanup.push(fn);
      },
      interval(fn, ms) {
        active();
        const timer = setInterval(() => {
          if (!controller.signal.aborted) fn();
        }, ms);
        cleanup.push(() => clearInterval(timer));
        return timer;
      },
      timeout(fn, ms) {
        active();
        const timer = setTimeout(() => {
          if (!controller.signal.aborted) fn();
        }, ms);
        cleanup.push(() => clearTimeout(timer));
        return timer;
      },
      listen(target, event, fn, options) {
        active();
        target.addEventListener(event, fn, options);
        cleanup.push(() => target.removeEventListener(event, fn, options));
      },
      observe(observer, target, options) {
        active();
        observer.observe(target, options);
        cleanup.push(() => observer.disconnect());
      },
      async playAudio(path) {
        const audio = new Audio(resource(path));
        audio.loop = true;
        cleanup.push(() => {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        });
        try {
          await audio.play();
        } catch {
          warnings.push("AUTOPLAY_BLOCKED: Click the page and restart sound.");
        }
        return audio;
      },
    };
    record.context = context;
    try {
      // CSS was parsed and canonicalized by css-tree before injection. Replace only URL tokens.
      for (let css of payload.styles || []) {
        css = css.replace(
          /url\(vignet-media:\/\/([^)]*)\)/g,
          (_, path) => `url("${resource(path)}")`,
        );
        const style = document.createElement("style");
        style.textContent = css;
        root.appendChild(style);
      }
      document.documentElement.appendChild(host);
      // Safety guard covers navigation even if the service worker is temporarily asleep.
      const initial = location.pathname;
      if (instance.scope !== "global") {
        let stopping = false;
        const changed = (event) => {
          const destination = event?.destination?.url;
          const nextPath = destination
            ? new URL(destination).pathname
            : location.pathname;
          if (nextPath !== initial && !stopping) {
            stopping = true;
            stop(record).catch(() => {});
          }
        };
        if (global.navigation?.addEventListener) {
          context.listen(global.navigation, "navigate", changed);
          context.listen(global.navigation, "currententrychange", changed);
        }
        context.listen(global, "popstate", changed);
      }
      const mounting = Promise.resolve().then(() =>
        record.lifecycle.mount?.(context, instance.parameters),
      );
      mounting.then(
        (handle) => {
          if (record.stopped && typeof handle === "function")
            bounded(handle).catch(() => {});
          else record.handle = handle;
        },
        () => {},
      );
      await bounded(() => mounting, controller.signal);
      return { ok: true, status: "running", instanceId: id, warnings };
    } catch (error) {
      stop(record).catch(() => {});
      throw error;
    }
  } catch (error) {
    return failure(error);
  }
}

export class ScriptEngine {
  constructor(
    chromeApi = globalThis.chrome,
    { timeoutMs = 6000, lifecycleTimeoutMs = 4000 } = {},
  ) {
    this.chrome = chromeApi;
    this.timeoutMs = timeoutMs;
    this.lifecycleTimeoutMs = lifecycleTimeoutMs;
  }
  async execute(tabId, operation, payload, source = "") {
    let timer;
    try {
      return await Promise.race([
        this.inject(
          tabId,
          operation,
          { ...payload, lifecycleTimeoutMs: this.lifecycleTimeoutMs },
          source,
        ),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(new Error("Browser script execution timed out"), {
                  code: "TIMEOUT",
                }),
              ),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async inject(tabId, operation, payload, source) {
    let api;
    try {
      api = this.chrome.userScripts;
      if (!api?.execute) throw new Error("missing");
      await api.getScripts();
    } catch {
      throw Object.assign(
        new Error(
          "Chrome 135+ and Allow User Scripts are required. Open chrome://extensions, Details, Allow User Scripts.",
        ),
        { code: "UNSUPPORTED_BROWSER_FEATURE" },
      );
    }
    const worldId = `vignet-${payload.instance.instanceId.replace(/[^a-zA-Z0-9-]/g, "-")}`;
    await api.configureWorld({ worldId, messaging: false });
    const invocation = `(${executeLifecycle.toString()})(${JSON.stringify(operation)},${JSON.stringify(payload)})`;
    // Each isolated instance world serializes lifecycle calls, including rapid navigation.
    const code = `${source}\n;(globalThis.__vignetQueue=(globalThis.__vignetQueue||Promise.resolve()).catch(()=>{}).then(()=>${invocation}))`;
    let failed = true;
    try {
      const results = await api.execute({
        target: { tabId, frameIds: [0] },
        world: "USER_SCRIPT",
        worldId,
        js: [{ code }],
      });
      const result = results?.[0];
      if (result?.error || !result?.result?.ok)
        throw Object.assign(
          new Error(
            result?.error || result?.result?.error || "No applied response",
          ),
          { code: result?.result?.code || "SCRIPT_EXECUTION_FAILED" },
        );
      failed = false;
      return result.result;
    } finally {
      // Remove configuration entries after disposal/failure; this does not destroy a JS world.
      if (operation === "unmount" || failed)
        await api.resetWorldConfiguration?.(worldId).catch(() => {});
    }
  }
}
