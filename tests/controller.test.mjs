import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { VignetStore } from "../extension/storage/store.js";
import { VignetController } from "../extension/core/controller.js";
import { packPackage, inspectPackage } from "../extension/core/installer.js";
import { builtinVignette } from "../extension/core/model.js";

async function setup(
  t,
  { urls = ["https://chatgpt.com/c/a"], session = {}, legacy } = {},
) {
  const store = new VignetStore(`controller-${crypto.randomUUID()}`);
  const local = { vignetteSettings: legacy };
  const chromeApi = {
    storage: {
      local: {
        get: async (key) => ({ [key]: local[key] }),
        set: async (o) => Object.assign(local, o),
      },
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (o) => Object.assign(session, structuredClone(o)),
      },
    },
    tabs: {
      query: async () => urls.map((url, index) => ({ id: index + 1, url })),
    },
  };
  const events = [];
  const runtime = {
    mount: async (tab, i) => {
      events.push(["mount", tab, i.instanceId]);
      if (runtime.failMount)
        throw Object.assign(new Error("Bad script"), {
          code: "SCRIPT_EXECUTION_FAILED",
        });
      return { status: "running" };
    },
    update: async (tab, i) => events.push(["update", tab, i.instanceId]),
    unmount: async (tab, i, record) => {
      events.push(["unmount", tab, i.instanceId, record?.manifest.version]);
      if (runtime.failStop) throw new Error("Could not run cleanup");
    },
    action: async () => ({}),
  };
  const controller = new VignetController({ store, runtime, chromeApi });
  await controller.init();
  t.after(() => store.close());
  return { store, controller, runtime, events, chromeApi, session };
}
const start = (target = 1, extra = {}) => ({
  assetId: "builtin.vignette",
  parameters: { color: "#ff0000", opacity: 0.7 },
  target: { tabId: target },
  ...extra,
});

test("global start rejects partial failure and rolls back all successful targets", async (t) => {
  const { controller: c, runtime } = await setup(t, {
    urls: ["https://chatgpt.com/c/a", "https://chatgpt.com/c/b"],
  });
  const active = new Set();
  runtime.mount = async (tab, i) => {
    if (tab === 2)
      throw Object.assign(new Error("Tab unavailable"), {
        code: "CONTEXT_UNAVAILABLE",
      });
    active.add(i.instanceId);
  };
  runtime.unmount = async (_tab, i) => {
    active.delete(i.instanceId);
  };
  await assert.rejects(c.run(start(1, { scope: "global" })), {
    code: "CONTEXT_UNAVAILABLE",
  });
  assert.equal(active.size, 0);
  assert.equal(c.state.instances.length, 0);
});

test("status tools report suspended rather than stale running after chat navigation", async (t) => {
  const { controller: c } = await setup(t);
  const a = await c.run(start());
  await c.navigate(1, "https://chatgpt.com/c/b");
  const status = await c.execute("get_asset_status", {
    instanceId: a.instanceId,
  });
  assert.equal(status.instances[0].status, "suspended");
});

test("legacy migration is persisted once and worker recreation restores without duplicating", async (t) => {
  const x = await setup(t, {
    legacy: { enabled: true, color: "#ff0000", opacity: 0.7, innerRadius: 40 },
  });
  assert.equal(x.controller.state.instances.length, 1);
  assert.equal(x.controller.state.instances[0].parameters.opacity, 0.7);
  const second = new VignetController({
    store: x.store,
    runtime: x.runtime,
    chromeApi: x.chromeApi,
  });
  await second.init();
  assert.equal(second.state.instances.length, 1);
  assert.equal(second.mounted.get(1).size, 1);
});
test("A/B suspend/restore and explicit global survives navigation; update and stop confirmed", async (t) => {
  const { controller: c, events } = await setup(t);
  const a = await c.run(start());
  assert.equal(a.phase, "applied");
  await c.navigate(1, "https://chatgpt.com/c/b");
  assert.equal(c.mounted.get(1).size, 0);
  await c.navigate(1, "https://chatgpt.com/c/a");
  assert.ok(c.mounted.get(1).has(a.instanceId));
  await c.update({ instanceId: a.instanceId, parameters: { opacity: 0.2 } });
  assert.equal(events.at(-1)[0], "update");
  await c.stop({ instanceId: a.instanceId });
  assert.equal(c.state.instances.length, 0);
  await c.run(start(1, { scope: "global" }));
  await c.navigate(1, "https://chatgpt.com/c/b");
  assert.equal(c.mounted.get(1).size, 1);
});
test("multiple tabs and cross-chat instance ID never falsely acknowledge applied", async (t) => {
  const { controller: c, events } = await setup(t, {
    urls: ["https://chatgpt.com/c/a", "https://chatgpt.com/c/b"],
  });
  await assert.rejects(c.execute("set_vignette", { enabled: true }), {
    code: "TARGET_AMBIGUOUS",
  });
  const a = await c.run(start(1));
  const before = events.length;
  await assert.rejects(c.run(start(2, { instanceId: a.instanceId })), {
    code: "CONTEXT_UNAVAILABLE",
  });
  assert.equal(events.length, before);
});
test("temporary state survives MV3 wake, migrates to permanent context and remounts", async (t) => {
  const x = await setup(t, { urls: ["https://chatgpt.com/"] });
  const a = await x.controller.run(start());
  const key = x.controller.state.instances[0].contextKey;
  const worker = new VignetController({
    store: x.store,
    runtime: x.runtime,
    chromeApi: x.chromeApi,
  });
  await worker.init();
  assert.equal(worker.state.instances[0].contextKey, key);
  const count = x.events.length;
  await worker.navigate(1, "https://chatgpt.com/c/new");
  assert.equal(worker.state.instances[0].scope, "chat");
  assert.equal(worker.state.instances[0].contextKey, "chat:new");
  assert.deepEqual(
    x.events.slice(count).map((e) => e[0]),
    ["unmount", "mount"],
  );
  assert.ok(worker.mounted.get(1).has(a.instanceId));
});
test("worker wake migrates temporary configuration when URL acquired an ID while asleep", async (t) => {
  const x = await setup(t, { urls: ["https://chatgpt.com/"] });
  const a = await x.controller.run(start());
  x.chromeApi.tabs.query = async () => [
    { id: 1, url: "https://chatgpt.com/c/created" },
  ];
  const worker = new VignetController({
    store: x.store,
    runtime: x.runtime,
    chromeApi: x.chromeApi,
  });
  await worker.init();
  assert.equal(worker.state.instances.length, 1);
  assert.equal(worker.state.instances[0].instanceId, a.instanceId);
  assert.equal(worker.state.instances[0].contextKey, "chat:created");
  assert.equal(worker.state.instances[0].scope, "chat");
  assert.equal(worker.mounted.get(1).size, 1);
});

test("failed stop remains tracked and retry really attempts cleanup", async (t) => {
  const { controller: c, runtime, events } = await setup(t);
  const a = await c.run(start());
  runtime.failStop = true;
  await assert.rejects(c.stop({ instanceId: a.instanceId }));
  assert.ok(c.mounted.get(1).has(a.instanceId));
  runtime.failStop = false;
  await c.stop({ instanceId: a.instanceId });
  assert.equal(c.mounted.get(1).size, 0);
  assert.equal(events.filter((e) => e[0] === "unmount").length, 2);
});
test("failed mount never reports applied or leaves a desired ghost instance", async (t) => {
  const { controller: c, runtime } = await setup(t);
  runtime.failMount = true;
  await assert.rejects(c.run(start()), { code: "SCRIPT_EXECUTION_FAILED" });
  assert.equal(c.state.instances.length, 0);
});
test("failed live update remounts previous parameters instead of trusting stale mounted cache", async (t) => {
  const { controller: c, runtime, events } = await setup(t);
  const a = await c.run(start());
  runtime.update = async () => {
    throw Object.assign(new Error("Update timed out after managed cleanup"), {
      code: "TIMEOUT",
    });
  };
  await assert.rejects(
    c.update({ instanceId: a.instanceId, parameters: { opacity: 0.1 } }),
    { code: "TIMEOUT" },
  );
  assert.equal(c.state.instances[0].parameters.opacity, 0.7);
  assert.equal(c.state.instances[0].status, "running");
  assert.equal(
    events.filter((e) => e[0] === "mount").length,
    2,
    "rollback must actually mount again",
  );
  assert.equal(events.filter((e) => e[0] === "unmount").length, 1);
});
test("failed active package upgrade restores exact prior installed version and cleanup engine", async (t) => {
  const { controller: c, store, runtime, events } = await setup(t);
  const manifest = {
    ...structuredClone(builtinVignette),
    id: "example.rollback",
    name: "Rollback",
    version: "1.0.0",
    styles: ["styles/main.css"],
    settingsSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    actions: {
      start: {
        description: "Start",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
  };
  const bytes = await packPackage(manifest, [
    {
      path: "styles/main.css",
      bytes: new TextEncoder().encode("body { color: red }"),
    },
  ]);
  await store.installPackage(await inspectPackage(bytes), {
    confirmed: true,
    grantedPermissions: manifest.permissions,
  });
  await c.run({ assetId: manifest.id, target: { tabId: 1 } });
  const newer = await packPackage({ ...manifest, version: "2.0.0" }, [
    {
      path: "styles/main.css",
      bytes: new TextEncoder().encode("body { color: blue }"),
    },
  ]);
  let calls = 0;
  runtime.mount = async () => {
    if (calls++ === 0) throw new Error("Broken replacement");
    return { status: "running" };
  };
  await assert.rejects(
    c.ui("install_package", {
      bytes: [...newer],
      confirmed: true,
      grantedPermissions: manifest.permissions,
      replace: true,
    }),
    { code: "UPDATE_ROLLED_BACK" },
  );
  assert.equal((await store.getAsset(manifest.id)).manifest.version, "1.0.0");
  assert.equal(events.find((e) => e[0] === "unmount")[3], "1.0.0");
  assert.equal(c.mounted.get(1).size, 1);
});
