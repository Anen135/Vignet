import { prepareStyles } from "../engines/style.js";
import { ScriptEngine } from "../engines/script.js";

export class AssetRuntime {
  constructor({ store, chromeApi = globalThis.chrome }) {
    this.store = store;
    this.chrome = chromeApi;
    this.script = new ScriptEngine(chromeApi);
  }
  async asset(id) {
    const asset = await this.store.getAsset(id);
    if (!asset)
      throw Object.assign(new Error(`Asset not installed: ${id}`), {
        code: "ASSET_NOT_FOUND",
      });
    if (!asset.enabled)
      throw Object.assign(new Error("Asset disabled"), {
        code: "PERMISSION_REQUIRED",
      });
    for (const permission of asset.manifest.permissions || []) {
      if (!asset.grantedPermissions?.includes(permission))
        throw Object.assign(
          new Error(`Permission not granted: ${permission}`),
          { code: "PERMISSION_REQUIRED" },
        );
    }
    if (asset.manifest.execution?.world === "MAIN")
      throw Object.assign(new Error("MAIN world packages are not supported"), {
        code: "PERMISSION_REQUIRED",
      });
    return asset;
  }
  async prepare(asset, instance) {
    const styles = await prepareStyles(asset, this.store);
    const media = {};
    for (const file of asset.files) {
      if (!asset.manifest.media?.includes(file.path)) continue;
      const bytes = new Uint8Array(
        await (await this.store.getMedia(file.hash)).arrayBuffer(),
      );
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      media[file.path] = { mime: file.mime, base64: btoa(binary) };
    }
    return { instance, styles, media };
  }
  async source(asset) {
    const paths = asset.manifest.entry
      ? [asset.manifest.entry]
      : asset.manifest.scripts || [];
    return (
      await Promise.all(
        paths.map(async (path) => {
          const file = asset.files.find((entry) => entry.path === path);
          if (!file) throw new Error(`Missing script ${path}`);
          return (await this.store.getMedia(file.hash)).text();
        }),
      )
    ).join("\n;\n");
  }
  async content(tabId, operation, payload) {
    let result;
    try {
      result = await this.chrome.tabs.sendMessage(tabId, {
        type: "VIGNET_RUNTIME",
        operation,
        ...payload,
      });
    } catch (error) {
      throw Object.assign(new Error(`Reload ChatGPT tab: ${error.message}`), {
        code: "CONTEXT_UNAVAILABLE",
      });
    }
    if (!result?.ok)
      throw Object.assign(new Error(result?.error || "No applied response"), {
        code: result?.code || "SCRIPT_EXECUTION_FAILED",
      });
    return result;
  }
  async mount(tabId, instance) {
    const asset = await this.asset(instance.assetId);
    const payload = await this.prepare(asset, instance);
    if (asset.manifest.entry || asset.manifest.scripts?.length)
      return this.script.execute(
        tabId,
        "mount",
        payload,
        await this.source(asset),
      );
    return this.content(tabId, "mount", payload);
  }
  async update(tabId, instance) {
    const asset = await this.asset(instance.assetId);
    if (asset.manifest.entry || asset.manifest.scripts?.length)
      return this.script.execute(tabId, "update", { instance });
    return this.content(tabId, "update", await this.prepare(asset, instance));
  }
  async unmount(tabId, instance, installedRecord) {
    const asset =
      installedRecord || (await this.store.getAsset(instance.assetId));
    if (asset?.manifest.entry || asset?.manifest.scripts?.length)
      return this.script.execute(tabId, "unmount", { instance });
    return this.content(tabId, "unmount", { instance });
  }
  async action(tabId, instance, action, parameters) {
    const asset = await this.asset(instance.assetId);
    if (!(asset.manifest.entry || asset.manifest.scripts?.length))
      throw Object.assign(new Error("CSS-only asset has no custom actions"), {
        code: "UNSUPPORTED_ACTION",
      });
    return this.script.execute(tabId, "action", {
      instance,
      action,
      parameters,
    });
  }
}
