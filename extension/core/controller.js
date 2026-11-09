import { builtinVignette, error, validateParameters } from "./model.js";
import { ContextManager, effectiveInstances } from "./context.js";
import { inspectPackage } from "./installer.js";

// All mutations (including navigation) pass through one queue in background.js.
export class VignetController {
  constructor({ store, runtime, chromeApi }) {
    this.store = store;
    this.runtime = runtime;
    this.chrome = chromeApi;
    this.contexts = new ContextManager();
    this.mounted = new Map();
    this.executionFailures = new Map();
    this.state = null;
    this.diagnostics = { connected: false };
  }
  async init() {
    await this.store.init();
    this.state = await this.store.loadState();
    if (this.state.schemaVersion !== 1)
      throw error(
        "STORAGE_VERSION_UNSUPPORTED",
        "Unknown runtime state version",
      );
    this.state.instances ||= [];
    // storage.session survives worker suspension, but is cleared at browser restart.
    const { vignetContexts = [] } =
      await this.chrome.storage.session.get("vignetContexts");
    const liveTabs = await this.chrome.tabs.query({
      url: "https://chatgpt.com/*",
    });
    for (const c of vignetContexts)
      if (liveTabs.some((t) => t.id === c.tabId))
        this.contexts.tabs.set(c.tabId, c);
    const ephemeral = new Set(this.contexts.list().map((c) => c.contextKey));
    this.state.instances = this.state.instances.filter(
      (i) => i.scope !== "temporary" || ephemeral.has(i.contextKey),
    );
    if (!this.state.legacyMigrated) {
      const { vignetteSettings } =
        await this.chrome.storage.local.get("vignetteSettings");
      if (vignetteSettings)
        this.state.instances.push({
          instanceId: crypto.randomUUID(),
          assetId: "builtin.vignette",
          parameters: validateParameters(
            builtinVignette.settingsSchema,
            vignetteSettings,
          ),
          scope: "global",
          enabled: true,
        });
      this.state.legacyMigrated = true;
    }
    await this.save();
    for (const tab of liveTabs) {
      await this.navigate(tab.id, tab.url);
    }
    await this.saveContexts();
  }
  save() {
    return this.store.saveState(this.state);
  }
  saveContexts() {
    return this.chrome.storage.session.set({
      vignetContexts: this.contexts.list(),
    });
  }
  async navigate(tabId, url, { reload = false } = {}) {
    let transition;
    try {
      transition = this.contexts.transition(tabId, url);
    } catch {
      await this.closeTab(tabId);
      return;
    }
    const { context, previous, migrateFrom } = transition;
    if (migrateFrom) {
      for (const i of this.state.instances)
        if (i.scope === "temporary" && i.contextKey === migrateFrom) {
          i.scope = "chat";
          i.contextKey = context.contextKey;
          delete i.tabId;
        }
    } else if (
      previous?.scope === "temporary" &&
      previous.contextKey !== context.contextKey
    )
      this.state.instances = this.state.instances.filter(
        (i) => i.contextKey !== previous.contextKey,
      );
    if (migrateFrom) {
      const current = this.mounted.get(tabId);
      for (const [id, i] of current || [])
        if (i.contextKey === migrateFrom) {
          await this.runtime.unmount(tabId, i).catch(() => {});
          current.delete(id);
        }
    }
    if (reload) this.mounted.delete(tabId);
    await this.saveContexts();
    await this.save();
    await this.reconcile(tabId);
  }
  async closeTab(tabId) {
    const previous = this.contexts.remove(tabId);
    for (const i of this.mounted.get(tabId)?.values() || [])
      await this.runtime.unmount(tabId, i).catch(() => {});
    this.mounted.delete(tabId);
    this.executionFailures.delete(tabId);
    await this.saveContexts();
    if (previous?.scope === "temporary")
      this.state.instances = this.state.instances.filter(
        (i) => i.contextKey !== previous.contextKey,
      );
    await this.save();
  }
  target(target) {
    const contexts = this.contexts
      .list()
      .filter((c) => target?.tabId === undefined || c.tabId === target.tabId);
    if (!contexts.length)
      throw error("CONTEXT_UNAVAILABLE", "Open and reload a ChatGPT tab");
    if (contexts.length !== 1)
      throw error("TARGET_AMBIGUOUS", "Choose target.tabId using get_contexts");
    return contexts[0];
  }
  async reconcile(tabId, { strict = false } = {}) {
    const context = this.contexts.list().find((c) => c.tabId === tabId);
    if (!context) return;
    const current = this.mounted.get(tabId) || new Map();
    this.mounted.set(tabId, current);
    const failures = this.executionFailures.get(tabId) || new Map();
    this.executionFailures.set(tabId, failures);
    const desired = [];
    for (const i of effectiveInstances(this.state.instances, context)) {
      const record = await this.store.getAsset(i.assetId);
      if (record?.enabled) desired.push(i);
    }
    let firstError;
    for (const id of failures.keys())
      if (!desired.some((i) => i.instanceId === id) && !current.has(id))
        failures.delete(id);
    for (const [id, i] of current)
      if (!desired.some((d) => d.instanceId === id)) {
        try {
          await this.runtime.unmount(tabId, i);
          current.delete(id);
          failures.delete(id);
        } catch (e) {
          firstError ||= e;
          i.error = { code: e.code || "CLEANUP_FAILED", message: e.message };
          failures.set(id, i.error);
        }
      }
    for (const i of desired) {
      try {
        let previous = current.get(i.instanceId);
        if (previous?.dirty) {
          await this.runtime.unmount(tabId, previous);
          current.delete(i.instanceId);
          previous = undefined;
        }
        let result;
        if (!previous) result = await this.runtime.mount(tabId, i);
        else if (
          JSON.stringify(previous.parameters) !== JSON.stringify(i.parameters)
        )
          result = await this.runtime.update(tabId, i);
        current.set(i.instanceId, structuredClone(i));
        failures.delete(i.instanceId);
        i.status = "running";
        delete i.error;
        if (result?.warnings) i.warnings = result.warnings;
      } catch (e) {
        const tracked = current.get(i.instanceId);
        if (tracked) tracked.dirty = true;
        i.status = "error";
        i.error = {
          code: e.code || "SCRIPT_EXECUTION_FAILED",
          message: e.message,
        };
        failures.set(i.instanceId, i.error);
        firstError ||= e;
      }
    }
    await this.save();
    if (strict && firstError) throw firstError;
  }
  async reconcileAll(options) {
    for (const c of this.contexts.list())
      await this.reconcile(c.tabId, options);
  }
  describe(record) {
    if (!record) throw error("ASSET_NOT_FOUND", "Asset not installed");
    const { manifest: m } = record;
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      version: m.version,
      enabled: record.enabled,
      actions: m.actions,
      settingsSchema: m.settingsSchema,
      permissions: m.permissions,
      grantedPermissions: record.grantedPermissions,
      execution: m.execution,
      defaultScope: m.defaultScope,
      scopes: ["global", "chat", "temporary"],
      compatibility: m.compatibility,
    };
  }
  async run(args) {
    const record = await this.store.getAsset(args.assetId);
    if (!record) throw error("ASSET_NOT_FOUND", args.assetId);
    if (!record.enabled) throw error("ASSET_DISABLED", args.assetId);
    const action = args.action || "start";
    if (!record.manifest.actions[action])
      throw error("ACTION_NOT_FOUND", action);
    const parameters = validateParameters(
      record.manifest.actions[action].parameters,
      args.parameters || {},
    );
    if (action === "stop") return this.stop(args);
    const context = this.target(args.target);
    if (action !== "start") {
      const i = this.state.instances.find(
        (i) =>
          i.assetId === args.assetId &&
          (args.instanceId
            ? i.instanceId === args.instanceId
            : i.contextKey === context.contextKey || i.scope === "global"),
      );
      if (!i) throw error("INSTANCE_NOT_FOUND", "Start the asset first");
      const result = await this.runtime.action(
        context.tabId,
        i,
        action,
        parameters,
      );
      return {
        ok: true,
        phase: "applied",
        instanceId: i.instanceId,
        status: "running",
        result,
      };
    }
    const scope = args.scope === "global" ? "global" : context.scope;
    if (args.scope === "temporary" && context.scope !== "temporary")
      throw error(
        "CONTEXT_UNAVAILABLE",
        "Temporary scope is available only before a chat receives an ID",
      );
    if (args.scope === "chat" && context.scope !== "chat")
      throw error("CONTEXT_UNAVAILABLE", "This new chat has no permanent ID");
    const contextKey = scope === "global" ? undefined : context.contextKey;
    const multipleInstances = Boolean(
      record.manifest.execution.multipleInstances,
    );
    let i = args.instanceId
      ? this.state.instances.find((i) => i.instanceId === args.instanceId)
      : !multipleInstances &&
        this.state.instances.find(
          (i) =>
            i.assetId === args.assetId &&
            i.scope === scope &&
            i.contextKey === contextKey,
        );
    if (args.instanceId && !i)
      throw error("INSTANCE_NOT_FOUND", args.instanceId);
    if (i && i.assetId !== args.assetId)
      throw error("INVALID_PARAMETERS", "Instance belongs to another asset");
    if (i && i.scope !== "global" && i.contextKey !== context.contextKey)
      throw error(
        "CONTEXT_UNAVAILABLE",
        "Instance belongs to a different chat",
      );
    const old = i && structuredClone(i);
    if (!i) {
      i = {
        instanceId: crypto.randomUUID(),
        assetId: args.assetId,
        scope,
        contextKey,
        multipleInstances,
        enabled: true,
      };
      this.state.instances.push(i);
    }
    i.parameters = parameters;
    i.enabled = true;
    await this.save();
    try {
      await this.reconcile(context.tabId, { strict: true });
      if (!this.mounted.get(context.tabId)?.has(i.instanceId))
        throw error(
          "CONTEXT_UNAVAILABLE",
          "Instance is overridden in this context",
        );
      if (scope === "global") await this.reconcileAll({ strict: true });
    } catch (e) {
      if (old) Object.assign(i, old);
      else this.state.instances = this.state.instances.filter((x) => x !== i);
      await this.save();
      await this.reconcileAll();
      throw e;
    }
    return {
      ok: true,
      phase: "applied",
      instanceId: i.instanceId,
      status: i.status,
      scope: i.scope,
      contextKey: i.contextKey,
      warnings: i.warnings,
    };
  }
  async update(args) {
    const i = this.state.instances.find(
      (i) => i.instanceId === args.instanceId,
    );
    if (!i) throw error("INSTANCE_NOT_FOUND", args.instanceId);
    const record = await this.store.getAsset(i.assetId);
    const parameters = validateParameters(record.manifest.settingsSchema, {
      ...i.parameters,
      ...args.parameters,
    });
    const targets = this.contexts
      .list()
      .filter((c) => this.mounted.get(c.tabId)?.has(i.instanceId));
    if (!targets.length)
      throw error(
        "CONTEXT_UNAVAILABLE",
        "Instance is suspended; return to its chat before updating",
      );
    const previous = i.parameters;
    i.parameters = parameters;
    try {
      for (const c of targets) await this.reconcile(c.tabId, { strict: true });
    } catch (e) {
      i.parameters = previous;
      await this.reconcileAll();
      throw e;
    }
    await this.save();
    return {
      ok: true,
      phase: "applied",
      instanceId: i.instanceId,
      status: i.status,
      parameters,
    };
  }
  async stop(args) {
    if (!args.instanceId && !args.assetId)
      throw error("INVALID_PARAMETERS", "Select instanceId or assetId");
    const context =
      args.instanceId || args.scope === "global"
        ? null
        : this.target(args.target);
    const selected = this.state.instances.filter(
      (i) =>
        (!args.instanceId || i.instanceId === args.instanceId) &&
        (!args.assetId || i.assetId === args.assetId) &&
        (!context || i.contextKey === context.contextKey) &&
        (!args.scope ||
          args.scope === "current_chat" ||
          i.scope === args.scope),
    );
    const ids = new Set(selected.map((i) => i.instanceId));
    const reloadRequired = [];
    for (const i of selected) {
      const record = await this.store.getAsset(i.assetId);
      if (record?.manifest.execution.requiresReloadOnStop)
        reloadRequired.push(i.instanceId);
    }
    for (const i of selected) i.enabled = false;
    await this.save();
    await this.reconcileAll({ strict: true });
    this.state.instances = this.state.instances.filter(
      (i) => !ids.has(i.instanceId),
    );
    await this.save();
    return {
      ok: true,
      phase: "applied",
      stopped: [...ids],
      reloadRequired,
      warnings: selected.filter((i) => i.error).map((i) => i.error),
    };
  }
  instanceView(instance) {
    const executions = this.contexts.list().map((c) => {
      const failure = this.executionFailures
        .get(c.tabId)
        ?.get(instance.instanceId);
      const mounted = this.mounted.get(c.tabId)?.get(instance.instanceId);
      return {
        tabId: c.tabId,
        contextKey: c.contextKey,
        status:
          failure || mounted?.dirty
            ? "error"
            : mounted
              ? "running"
              : "suspended",
        error: failure,
      };
    });
    const failed = executions.find((e) => e.status === "error");
    return {
      ...instance,
      status: failed
        ? "error"
        : executions.some((e) => e.status === "running")
          ? "running"
          : "suspended",
      error: failed?.error,
      executions,
    };
  }
  async execute(command, args = {}) {
    switch (command) {
      case "get_contexts":
        return { contexts: this.contexts.list() };
      case "list_assets":
        return {
          assets: (await this.store.listAssets())
            .filter(
              (r) =>
                (args.includeDisabled || r.enabled) &&
                (!args.query ||
                  `${r.manifest.id} ${r.manifest.name} ${r.manifest.description}`
                    .toLowerCase()
                    .includes(args.query.toLowerCase())),
            )
            .map((r) => {
              const d = this.describe(r);
              return {
                ...d,
                actions: Object.entries(d.actions).map(([name, a]) => ({
                  name,
                  description: a.description,
                })),
                settingsSchema: undefined,
              };
            }),
        };
      case "describe_asset":
        return this.describe(await this.store.getAsset(args.assetId));
      case "run_asset":
        return this.run(args);
      case "update_asset_instance":
        return this.update(args);
      case "stop_asset":
        return this.stop(args);
      case "list_asset_instances":
        return {
          instances: this.state.instances
            .filter((i) =>
              !args.scope || args.scope === "current_chat"
                ? !args.scope ||
                  i.contextKey === this.target(args.target).contextKey
                : i.scope === args.scope,
            )
            .map((i) => this.instanceView(i)),
        };
      case "get_asset_status":
        return {
          extensionConnected: true,
          asset: args.assetId
            ? this.describe(await this.store.getAsset(args.assetId))
            : undefined,
          instances: this.state.instances
            .filter(
              (i) =>
                (!args.assetId || i.assetId === args.assetId) &&
                (!args.instanceId || i.instanceId === args.instanceId),
            )
            .map((i) => this.instanceView(i)),
        };
      case "set_vignette": {
        const context = this.target();
        const result = await this.run({
          assetId: "builtin.vignette",
          parameters: args,
          scope: "current_chat",
          target: { tabId: context.tabId },
        });
        await this.chrome.storage.local.set({ vignetteSettings: args });
        return { ...result, tabsUpdated: 1, settings: args };
      }
      default:
        throw error("COMMAND_NOT_FOUND", command);
    }
  }
  async ui(command, args = {}) {
    switch (command) {
      case "dashboard":
        return {
          assets: await this.store.listAssets(),
          instances: this.state.instances.map((i) => this.instanceView(i)),
          contexts: this.contexts.list(),
          media: await this.store.listMedia(),
          diagnostics: {
            ...this.diagnostics,
            userScriptsAvailable: Boolean(this.chrome.userScripts?.execute),
          },
        };
      case "inspect_package": {
        const p = await inspectPackage(new Uint8Array(args.bytes));
        return {
          manifest: p.manifest,
          totalSize: p.totalSize,
          fileCount: p.files.length,
        };
      }
      case "install_package": {
        const p = await inspectPackage(new Uint8Array(args.bytes));
        const previous = await this.store.getAsset(p.manifest.id);
        const active = [...this.mounted.values()].some((m) =>
          [...m.values()].some((i) => i.assetId === p.manifest.id),
        );
        const record = await this.store.installPackage(p, args);
        try {
          for (const [tabId, instances] of this.mounted)
            for (const [id, i] of instances)
              if (i.assetId === record.manifest.id) {
                await this.runtime.unmount(tabId, i, previous);
                instances.delete(id);
              }
          if (active) await this.reconcileAll({ strict: true });
        } catch (e) {
          for (const [tabId, instances] of this.mounted)
            for (const [id, i] of instances)
              if (i.assetId === record.manifest.id) {
                try {
                  await this.runtime.unmount(tabId, i, record);
                  instances.delete(id);
                } catch {
                  /* retained for cleanup retry */
                }
              }
          await this.store.restoreAsset(previous, record.manifest.id);
          await this.reconcileAll();
          throw error(
            "UPDATE_ROLLED_BACK",
            `Update failed; previous package restored: ${e.message}`,
          );
        }
        return { asset: this.describe(record) };
      }
      case "export_asset":
        return {
          bytes: [...(await this.store.exportPackage(args.assetId))],
          filename: `${args.assetId}.vignet`,
        };
      case "delete_asset": {
        for (const i of [...this.state.instances].filter(
          (i) => i.assetId === args.assetId,
        ))
          await this.stop({ instanceId: i.instanceId });
        await this.store.removeAsset(args.assetId);
        return {};
      }
      case "enable_asset":
        await this.store.setAssetEnabled(args.assetId, args.enabled);
        await this.reconcileAll({ strict: true });
        return {};
      case "gc_media":
        return { removed: await this.store.gc() };
      default:
        return this.execute(command, args);
    }
  }
}
