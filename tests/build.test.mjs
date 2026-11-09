import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { packAsset } from "../scripts/pack-asset.mjs";
import { inspectPackage } from "../extension/core/installer.js";
import { buildExtension } from "../scripts/build.mjs";

function fixture() {
  return {
    schemaVersion: 1,
    id: "test.lifecycle",
    name: "Lifecycle fixture",
    version: "1.0.0",
    description: "Packaged JavaScript fixture",
    entry: "scripts/main.js",
    scripts: [],
    styles: ["styles/main.css"],
    media: [],
    permissions: ["user_scripts", "dom_access", "dom_overlay"],
    execution: {
      world: "USER_SCRIPT",
      multipleInstances: false,
      cleanupGuarantee: "managed",
      requiresReloadOnStop: false,
    },
    defaultScope: "chat",
    compatibility: { minimumChromeVersion: 135 },
    settingsSchema: { type: "object", additionalProperties: false },
    actions: {
      start: {
        description: "Mount",
        parameters: { type: "object", additionalProperties: false },
      },
    },
  };
}

test("packer bundles imported lifecycle module and creates independently installable integrity-checked ZIP", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "vignet-pack-test-"));
  try {
    await mkdir(path.join(temporary, "scripts"));
    await mkdir(path.join(temporary, "styles"));
    await writeFile(
      path.join(temporary, "asset.json"),
      JSON.stringify(fixture()),
    );
    await writeFile(
      path.join(temporary, "scripts/main.js"),
      "import {value} from './value.js'; export function mount() { return value; } export function unmount() {}\n",
    );
    await writeFile(
      path.join(temporary, "scripts/value.js"),
      "export const value=42;\n",
    );
    await writeFile(
      path.join(temporary, "styles/main.css"),
      ".fixture { color: red; }\n",
    );
    const destination = path.join(temporary, "output/test.vignet");
    const { archive } = await packAsset(temporary, destination);
    assert.deepEqual(new Uint8Array(await readFile(destination)), archive);
    const installed = await inspectPackage(archive);
    assert.equal(installed.manifest.id, "test.lifecycle");
    assert.equal(
      installed.files.length,
      2,
      "unreferenced source imports are included in bundle, not physical archive",
    );
    assert.equal(Object.keys(installed.manifest.integrity).length, 2);
    const js = installed.files.find((file) => file.path === "scripts/main.js");
    const world = vm.createContext({});
    vm.runInContext(new TextDecoder().decode(js.bytes), world);
    assert.equal(world.VignetAssetLifecycle.mount(), 42);
    assert.equal(typeof world.VignetAssetLifecycle.unmount, "function");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("build bundles extension modules and exposes options UI without bare dependency imports", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "vignet-build-test-"));
  try {
    await buildExtension(temporary);
    const manifest = JSON.parse(
      await readFile(path.join(temporary, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.type, "module");
    assert.equal(manifest.options_ui.page, "ui/index.html");
    for (const filename of ["background.js", "content.js", "ui/app.js"]) {
      const source = await readFile(path.join(temporary, filename), "utf8");
      assert.ok(source.length > 100);
      assert.doesNotMatch(source, /from\s+["'](?:fflate|css-tree|ajv)["']/);
    }
    const html = await readFile(path.join(temporary, "ui/index.html"), "utf8");
    assert.match(html, /type="module" src="app.js"/);
    assert.doesNotMatch(html, /on(?:click|load)=/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("packer rejects source imports escaping the independent package boundary", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "vignet-import-test-"));
  try {
    const root = path.join(temporary, "package");
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, "styles"));
    await writeFile(path.join(root, "asset.json"), JSON.stringify(fixture()));
    await writeFile(
      path.join(root, "styles/main.css"),
      ".fixture { color: red; }",
    );
    await writeFile(
      path.join(temporary, "outside.js"),
      "export const value=42;",
    );
    await writeFile(
      path.join(root, "scripts/main.js"),
      "import {value} from '../../outside.js'; export function mount() { return value; }",
    );
    await assert.rejects(packAsset(root), /Script import escapes package/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
