import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const html = await readFile(
  new URL("../extension/ui/index.html", import.meta.url),
  "utf8",
);
const script = await readFile(
  new URL("../extension/ui/app.js", import.meta.url),
  "utf8",
);
const manifest = {
  id: "test.rain",
  name: "<img src=x onerror=alert(1)>",
  version: "1.0.0",
  description: "Rain fixture",
  entry: "scripts/main.js",
  permissions: ["user_scripts", "dom_access"],
  execution: { cleanupGuarantee: "managed", requiresReloadOnStop: false },
  settingsSchema: {
    type: "object",
    properties: {
      intensity: { type: "number", minimum: 0, maximum: 100, default: 50 },
      sound: { type: "boolean", default: false },
    },
    additionalProperties: false,
  },
  actions: {
    start: {
      description: "Start rain",
      parameters: {
        type: "object",
        properties: {
          intensity: { type: "number", minimum: 0, maximum: 100, default: 50 },
          sound: { type: "boolean", default: false },
        },
      },
    },
  },
};
const flush = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
async function setup({ installError } = {}) {
  const dom = new JSDOM(html, {
    url: "https://extension.test/ui/index.html",
    runScripts: "outside-only",
  });
  const calls = [];
  dom.window.chrome = {
    runtime: {
      sendMessage: async (packet) => {
        calls.push(packet);
        if (packet.command === "dashboard")
          return {
            ok: true,
            assets: [
              {
                manifest,
                enabled: true,
                grantedPermissions: manifest.permissions,
                files: [],
              },
            ],
            instances: [],
            contexts: [
              { tabId: 11, chatId: "A" },
              { tabId: 22, chatId: "B" },
            ],
            media: [],
            diagnostics: { endpoint: "ws://127.0.0.1:8788/extension" },
          };
        if (packet.command === "inspect_package")
          return {
            ok: true,
            review: { manifest, totalSize: 200, fileCount: 1 },
          };
        if (packet.command === "install_package" && installError)
          return {
            ok: false,
            error: { code: "INSTALL_FAILED", message: "Out of quota" },
          };
        return { ok: true };
      },
    },
  };
  dom.window.confirm = () => true;
  vm.runInContext(script, dom.getInternalVMContext());
  await flush();
  return { dom, calls, doc: dom.window.document };
}
async function reviewFile(ui) {
  const picker = ui.doc.getElementById("file");
  Object.defineProperty(picker, "files", {
    value: [
      {
        name: "rain.vignet",
        size: 3,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      },
    ],
    configurable: true,
  });
  picker.dispatchEvent(new ui.dom.window.Event("change"));
  await flush();
}
function findButton(root, text) {
  const found = [...root.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  );
  assert.ok(found, `Button ${text}`);
  return found;
}

test("UI displays metadata as text, reviews package before install, and grants only explicitly checked permissions", async () => {
  const ui = await setup();
  try {
    assert.equal(
      ui.doc.querySelectorAll("img").length,
      0,
      "untrusted name must not create DOM",
    );
    assert.equal(ui.doc.querySelector("#assets h3").textContent, manifest.name);
    await reviewFile(ui);
    const area = ui.doc.getElementById("review");
    assert.equal(area.hidden, false);
    assert.equal(
      ui.calls.filter((call) => call.command === "install_package").length,
      0,
    );
    const install = findButton(area, "Подтвердить обновление");
    install.click();
    await flush();
    assert.equal(
      ui.calls.filter((call) => call.command === "install_package").length,
      0,
      "no installation without confirmation",
    );
    for (const box of area.querySelectorAll("input[type=checkbox]"))
      box.checked = true;
    install.click();
    await flush();
    const call = ui.calls.find((call) => call.command === "install_package");
    assert.equal(call.args.confirmed, true);
    assert.equal(call.args.replace, true);
    assert.deepEqual(Array.from(call.args.grantedPermissions), [
      "user_scripts",
      "dom_access",
    ]);
    assert.deepEqual(Array.from(call.args.bytes), [1, 2, 3]);
    assert.equal(area.hidden, true);
    assert.match(
      ui.doc.getElementById("notice").textContent,
      /Пакет установлен/,
    );
  } finally {
    ui.dom.window.close();
  }
});

test("UI reports installer failure and retains review instead of claiming success", async () => {
  const ui = await setup({ installError: true });
  try {
    await reviewFile(ui);
    const area = ui.doc.getElementById("review");
    for (const box of area.querySelectorAll("input[type=checkbox]"))
      box.checked = true;
    findButton(area, "Подтвердить обновление").click();
    await flush();
    assert.equal(area.hidden, false);
    assert.match(
      ui.doc.getElementById("notice").textContent,
      /INSTALL_FAILED: Out of quota/,
    );
    assert.equal(ui.doc.getElementById("notice").className, "error");
  } finally {
    ui.dom.window.close();
  }
});

test("UI schema form preserves typed parameters and requires explicit target with multiple contexts", async () => {
  const ui = await setup();
  try {
    const card = ui.doc.querySelector("#assets .card");
    const execute = findButton(card, "Выполнить");
    execute.click();
    await flush();
    assert.equal(
      ui.calls.filter((call) => call.command === "run_asset").length,
      0,
    );
    ui.doc.getElementById("target").value = "22";
    card.querySelector("input[type=number]").value = "80";
    card.querySelector("input[type=checkbox]").checked = true;
    execute.click();
    await flush();
    const call = ui.calls.find((call) => call.command === "run_asset");
    assert.equal(call.args.target.tabId, 22);
    assert.equal(call.args.scope, "current_chat");
    assert.equal(call.args.parameters.intensity, 80);
    assert.equal(call.args.parameters.sound, true);
    assert.equal(call.args.assetId, "test.rain");
  } finally {
    ui.dom.window.close();
  }
});

test("UI connection save omits blank password to preserve existing device token", async () => {
  const ui = await setup();
  try {
    ui.doc
      .getElementById("connection")
      .dispatchEvent(new ui.dom.window.Event("submit", { cancelable: true }));
    await flush();
    const call = ui.calls.find((call) => call.command === "settings");
    assert.equal(call.args.endpoint, "ws://127.0.0.1:8788/extension");
    assert.equal(Object.hasOwn(call.args, "deviceToken"), false);
  } finally {
    ui.dom.window.close();
  }
});
