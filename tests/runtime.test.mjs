import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { rewriteCss } from "../extension/engines/style.js";
import { executeLifecycle, ScriptEngine } from "../extension/engines/script.js";
import { AssetRuntime } from "../extension/core/runtime.js";

function environment() {
  class Element {
    constructor() {
      this.children = [];
      this.style = {};
      this.dataset = {};
      this.parent = null;
    }
    appendChild(node) {
      this.children.push(node);
      node.parent = this;
      return node;
    }
    attachShadow() {
      return (this.shadowRoot = new Element());
    }
    replaceChildren(...nodes) {
      this.children = [];
      for (const n of nodes) this.appendChild(n);
    }
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter((n) => n !== this);
    }
  }
  const root = new Element();
  const timers = new Map();
  let sequence = 0;
  const revoked = [];
  const navigationListeners = new Map();
  const globalListeners = new Map();
  function find(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) {
      const result = find(child, id);
      if (result) return result;
    }
  }
  const context = vm.createContext({
    document: {
      createElement: () => new Element(),
      documentElement: root,
      getElementById: (id) => find(root, id),
    },
    location: { pathname: "/c/a" },
    AbortController,
    Blob,
    atob,
    setInterval(fn) {
      const id = ++sequence;
      timers.set(id, fn);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    setTimeout,
    clearTimeout,
    URL: Object.assign(class extends URL {}, {
      createObjectURL: () => `blob:${++sequence}`,
      revokeObjectURL: (url) => revoked.push(url),
    }),
    navigation: {
      addEventListener: (name, fn) => navigationListeners.set(name, fn),
      removeEventListener: (name) => navigationListeners.delete(name),
    },
    addEventListener: (name, fn) => globalListeners.set(name, fn),
    removeEventListener: (name) => globalListeners.delete(name),
    Audio: class {
      constructor(src) {
        this.src = src;
      }
      async play() {
        throw new Error("blocked");
      }
      pause() {}
      removeAttribute() {}
      load() {}
    },
  });
  const invoke = (operation, payload) =>
    vm.runInContext(
      `(${executeLifecycle.toString()})(${JSON.stringify(operation)},${JSON.stringify(payload)})`,
      context,
    );
  return {
    root,
    timers,
    context,
    invoke,
    revoked,
    navigationListeners,
    globalListeners,
  };
}

test("content engine confirms legacy vignette and CSS-only mount/update/stop with Blob URL cleanup", async () => {
  const env = environment();
  let listener;
  env.context.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
      sendMessage: async () => ({ ok: true }),
    },
  };
  env.context.addEventListener = () => {};
  vm.runInContext(await readFile("extension/content.js", "utf8"), env.context);
  const call = (message) => {
    let response;
    listener(message, {}, (value) => {
      response = value;
    });
    return response;
  };
  assert.equal(
    call({
      type: "VIGNETTE_APPLY",
      settings: {
        enabled: true,
        color: "#ff0000",
        opacity: 0.7,
        innerRadius: 40,
      },
    }).ok,
    true,
  );
  assert.equal(env.root.children.length, 1);
  call({ type: "VIGNETTE_APPLY", settings: { enabled: false } });
  assert.equal(env.root.children.length, 0);
  const instance = {
    instanceId: "css",
    assetId: "example.theme",
    parameters: {},
  };
  const payload = {
    type: "VIGNET_RUNTIME",
    operation: "mount",
    instance,
    styles: ["a{background:url(vignet-media://media/drop.webp)}"],
    media: { "media/drop.webp": { mime: "image/webp", base64: "AAAA" } },
  };
  assert.equal(call(payload).ok, true);
  assert.match(env.root.children[0].textContent, /blob:/);
  assert.equal(call({ ...payload, operation: "update" }).ok, true);
  assert.equal(env.root.children.length, 1);
  assert.equal(env.revoked.length, 1);
  assert.equal(
    call({ type: "VIGNET_RUNTIME", operation: "unmount", instance }).ok,
    true,
  );
  assert.equal(env.root.children.length, 0);
  assert.equal(env.revoked.length, 2);
});

test("CSS URLs parsed including quotes, multiple references, traversal rejected", async () => {
  const result = await rewriteCss(
    'a{background:url("../media/drop.webp"),url(../media/drop.webp)}',
    "styles/a.css",
    (p) => `vignet-media://${p}`,
  );
  assert.equal(
    (result.match(/vignet-media:\/\/media\/drop.webp/g) || []).length,
    2,
  );
  await assert.rejects(
    rewriteCss("a{background:url(https://evil/x)}", "a.css", () => ""),
    { code: "INVALID_RESOURCE" },
  );
  await assert.rejects(
    rewriteCss('@import "https://evil";', "a.css", () => ""),
  );
});

test("real Rain source lifecycle updates without extra timers and cleans all resources", async () => {
  const bundle = await build({
    entryPoints: ["packages/rain/scripts/main.js"],
    bundle: true,
    format: "iife",
    globalName: "VignetAssetLifecycle",
    write: false,
  });
  const env = environment();
  vm.runInContext(bundle.outputFiles[0].text, env.context);
  const instance = {
    instanceId: "rain-a",
    assetId: "community.rain",
    scope: "chat",
    parameters: { intensity: 80, sound: true },
  };
  const payload = {
    instance,
    styles: [await readFile("packages/rain/styles/rain.css", "utf8")],
    media: { "media/ambient.mp3": { base64: "AAAA", mime: "audio/mpeg" } },
  };
  const result = await env.invoke("mount", payload);
  assert.equal(result.ok, true);
  assert.match(result.warnings[0], /AUTOPLAY_BLOCKED/);
  assert.equal(env.root.children.length, 1);
  assert.equal(env.timers.size, 0);
  instance.parameters = { intensity: 10, sound: false };
  assert.equal((await env.invoke("update", { instance })).ok, true);
  assert.equal(env.timers.size, 0);
  const layer = env.root.children[0].shadowRoot.children[1];
  assert.equal(layer.children.length, 14);
  assert.equal((await env.invoke("unmount", { instance })).ok, true);
  assert.equal(env.root.children.length, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(env.revoked.length, 1);
});

test("managed cleanup executes even when user unmount throws; navigation guard stops", async () => {
  const env = environment();
  vm.runInContext(
    'globalThis.VignetAssetLifecycle={mount(c){c.interval(()=>{},1)},unmount(){throw Error("bad cleanup")}}',
    env.context,
  );
  const instance = { instanceId: "a", scope: "chat", parameters: {} };
  assert.equal(
    (await env.invoke("mount", { instance, styles: [], media: {} })).ok,
    true,
  );
  assert.equal(env.timers.size, 1);
  assert.equal((await env.invoke("unmount", { instance })).ok, false);
  assert.equal(env.root.children.length, 0);
  assert.equal(env.timers.size, 0);
  await env.invoke("mount", { instance, styles: [], media: {} });
  env.context.location.pathname = "/c/b";
  env.navigationListeners.get("navigate")({
    destination: { url: "https://chatgpt.com/c/b" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.root.children.length, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(env.navigationListeners.size, 0);
  assert.equal(env.globalListeners.size, 0);
});

test("ScriptEngine rejects unavailable API and propagates application failures", async () => {
  await assert.rejects(
    new ScriptEngine({}).execute(1, "mount", { instance: { instanceId: "a" } }),
    { code: "UNSUPPORTED_BROWSER_FEATURE" },
  );
  let injected;
  const engine = new ScriptEngine({
    userScripts: {
      getScripts: async () => [],
      configureWorld: async () => {},
      execute: async (p) => {
        injected = p;
        return [{ result: { ok: false, code: "FAILURE", error: "failed" } }];
      },
    },
  });
  await assert.rejects(
    engine.execute(1, "mount", { instance: { instanceId: "a" } }),
    { code: "FAILURE" },
  );
  assert.equal(injected.world, "USER_SCRIPT");
  assert.deepEqual(injected.target.frameIds, [0]);
});

test("runtime rejects missing grants before executing", async () => {
  const runtime = new AssetRuntime({
    store: {
      getAsset: async () => ({
        enabled: true,
        manifest: { permissions: ["user_scripts"] },
        grantedPermissions: [],
      }),
    },
    chromeApi: {},
  });
  await assert.rejects(runtime.mount(1, { assetId: "a" }), {
    code: "PERMISSION_REQUIRED",
  });
});

test("unresolved mount times out, cleans immediately, rejects late managed resources, and next mount works", async () => {
  const env = environment();
  vm.runInContext(
    "globalThis.VignetAssetLifecycle={mount(c){globalThis.savedContext=c;c.interval(()=>{},5);return new Promise(()=>{})},unmount(){return new Promise(()=>{})}}",
    env.context,
  );
  const instance = { instanceId: "hung", scope: "chat", parameters: {} };
  const result = await env.invoke("mount", {
    instance,
    styles: [],
    media: {},
    lifecycleTimeoutMs: 20,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TIMEOUT");
  assert.equal(env.root.children.length, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(env.context.savedContext.signal.aborted, true);
  for (const code of [
    "savedContext.interval(()=>{},5)",
    "savedContext.timeout(()=>{},5)",
    'savedContext.resource("x")',
    'savedContext.listen(globalThis,"x",()=>{})',
  ]) {
    assert.throws(() => vm.runInContext(code, env.context), {
      code: "CONTEXT_UNAVAILABLE",
    });
  }
  vm.runInContext("globalThis.VignetAssetLifecycle={mount(){}}", env.context);
  assert.equal(
    (
      await env.invoke("mount", {
        instance,
        styles: [],
        media: {},
        lifecycleTimeoutMs: 20,
      })
    ).ok,
    true,
  );
  await env.invoke("unmount", { instance, lifecycleTimeoutMs: 20 });
});

test("unresolved update and action time out and clean managed state", async () => {
  for (const operation of ["update", "action"]) {
    const env = environment();
    vm.runInContext(
      "globalThis.VignetAssetLifecycle={mount(c){c.interval(()=>{},5)},update(){return new Promise(()=>{})},actions:{wait(){return new Promise(()=>{})}},unmount(){return new Promise(()=>{})}}",
      env.context,
    );
    const instance = { instanceId: "hung", scope: "chat", parameters: {} };
    await env.invoke("mount", {
      instance,
      styles: [],
      media: {},
      lifecycleTimeoutMs: 20,
    });
    const result = await env.invoke(operation, {
      instance,
      action: "wait",
      parameters: {},
      lifecycleTimeoutMs: 20,
    });
    assert.equal(result.code, "TIMEOUT");
    assert.equal(env.root.children.length, 0);
    assert.equal(env.timers.size, 0);
    assert.equal(env.navigationListeners.size, 0);
  }
});

test("unresolved unmount and navigation remove resources before teardown finishes", async () => {
  for (const navigation of [false, true]) {
    const env = environment();
    vm.runInContext(
      "globalThis.VignetAssetLifecycle={mount(c){c.interval(()=>{},5);return ()=>{globalThis.disposed=true}},unmount(){return new Promise(()=>{})}}",
      env.context,
    );
    const instance = { instanceId: "hung", scope: "chat", parameters: {} };
    await env.invoke("mount", {
      instance,
      styles: [],
      media: {},
      lifecycleTimeoutMs: 20,
    });
    let stopping;
    if (navigation)
      env.navigationListeners.get("navigate")({
        destination: { url: "https://chatgpt.com/c/b" },
      });
    else stopping = env.invoke("unmount", { instance, lifecycleTimeoutMs: 20 });
    assert.equal(env.root.children.length, 0);
    assert.equal(env.timers.size, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(env.context.disposed, true);
    if (stopping) assert.equal((await stopping).code, "TIMEOUT");
  }
});

test("ScriptEngine bounds browser API promise and releases caller", async () => {
  const engine = new ScriptEngine(
    {
      userScripts: {
        getScripts: async () => [],
        configureWorld: async () => {},
        execute: async () => new Promise(() => {}),
      },
    },
    { timeoutMs: 20 },
  );
  await assert.rejects(
    engine.execute(1, "mount", { instance: { instanceId: "hung" } }),
    { code: "TIMEOUT" },
  );
});

test("ScriptEngine clears disposed world configuration without claiming world destruction", async () => {
  const reset = [];
  const engine = new ScriptEngine({
    userScripts: {
      getScripts: async () => [],
      configureWorld: async () => {},
      execute: async () => [{ result: { ok: true, status: "stopped" } }],
      resetWorldConfiguration: async (id) => reset.push(id),
    },
  });
  await engine.execute(1, "unmount", { instance: { instanceId: "a" } });
  assert.deepEqual(reset, ["vignet-a"]);
});
