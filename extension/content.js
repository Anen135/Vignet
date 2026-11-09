// Package JavaScript executes only in USER_SCRIPT, never in this content world.
(() => {
  const records = new Map();
  function vignette(settings, id = "__chatgpt_vignette_mvp_host__") {
    let host = document.getElementById(id);
    if (!settings.enabled || settings.opacity === 0) {
      host?.remove();
      return;
    }
    if (
      !/^#[0-9a-f]{6}$/i.test(settings.color) ||
      !Number.isFinite(settings.opacity) ||
      settings.opacity < 0 ||
      settings.opacity > 1 ||
      !Number.isFinite(settings.innerRadius) ||
      settings.innerRadius < 0 ||
      settings.innerRadius > 90
    )
      throw new Error("Invalid vignette settings");
    if (!host) {
      host = document.createElement("div");
      host.id = id;
      host.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
      host.attachShadow({ mode: "open" });
      document.documentElement.appendChild(host);
    }
    const rgb = [1, 3, 5].map((offset) =>
      parseInt(settings.color.slice(offset, offset + 2), 16),
    );
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center,transparent ${settings.innerRadius}%,rgba(${rgb.join(",")},${settings.opacity}) 100%);`;
    host.shadowRoot.replaceChildren(overlay);
  }
  function cleanup(id) {
    const record = records.get(id);
    if (!record) return;
    for (const node of record.nodes) node.remove();
    for (const url of record.urls) URL.revokeObjectURL(url);
    records.delete(id);
  }
  function apply(message) {
    const { operation, instance } = message;
    const id = instance.instanceId;
    if (operation === "status")
      return { ok: true, status: records.has(id) ? "running" : "stopped" };
    cleanup(id);
    if (operation === "unmount")
      return { ok: true, status: "stopped", instanceId: id };
    const record = { nodes: [], urls: [], instance };
    records.set(id, record);
    try {
      if (instance.assetId === "builtin.vignette") {
        const hostId = `vignet-${id}`;
        vignette(instance.parameters, hostId);
        const host = document.getElementById(hostId);
        if (host) record.nodes.push(host);
      } else {
        const urls = new Map();
        const resolve = (path) => {
          if (!urls.has(path)) {
            const item = message.media[path];
            if (!item) throw new Error(`Missing media: ${path}`);
            const url = URL.createObjectURL(
              new Blob(
                [
                  Uint8Array.from(atob(item.base64), (char) =>
                    char.charCodeAt(0),
                  ),
                ],
                { type: item.mime },
              ),
            );
            record.urls.push(url);
            urls.set(path, url);
          }
          return urls.get(path);
        };
        for (const css of message.styles || []) {
          const style = document.createElement("style");
          style.textContent = css.replace(
            /url\(vignet-media:\/\/([^)]*)\)/g,
            (_, path) => `url("${resolve(path)}")`,
          );
          document.documentElement.appendChild(style);
          record.nodes.push(style);
        }
      }
      return { ok: true, status: "running", instanceId: id };
    } catch (error) {
      cleanup(id);
      throw error;
    }
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!["VIGNET_RUNTIME", "VIGNETTE_APPLY"].includes(message?.type)) return;
    try {
      if (message.type === "VIGNETTE_APPLY") {
        vignette(message.settings);
        sendResponse({ ok: true });
      } else sendResponse(apply(message));
    } catch (error) {
      sendResponse({
        ok: false,
        error: error.message,
        code: "SCRIPT_EXECUTION_FAILED",
      });
    }
  });
  chrome.runtime
    .sendMessage({ type: "VIGNET_READY", url: location.href })
    .catch(() => {});
  chrome.runtime.sendMessage({ type: "VIGNETTE_CONNECT" }).catch(() => {});
  addEventListener("pagehide", () => {
    for (const id of records.keys()) cleanup(id);
  });
})();
