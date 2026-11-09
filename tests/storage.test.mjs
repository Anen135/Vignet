import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBObjectStore } from "fake-indexeddb";
import { zipSync, strToU8 } from "fflate";
import {
  inspectPackage,
  packPackage,
  sha256,
  PACKAGE_LIMITS,
} from "../extension/core/installer.js";
import { VignetStore } from "../extension/storage/store.js";

const css = strToU8("body { color: #abcdef; }");
function manifest(id = "example.theme", version = "1.0.0") {
  return {
    schemaVersion: 1,
    id,
    name: "Theme",
    description: "Test theme",
    version,
    scripts: [],
    styles: ["styles/main.css"],
    media: [],
    actions: {
      start: {
        description: "Apply theme",
        parameters: { type: "object", additionalProperties: false },
      },
    },
    settingsSchema: { type: "object", additionalProperties: false },
    permissions: ["dom_access"],
    execution: { cleanupGuarantee: "managed" },
    defaultScope: "chat",
    compatibility: {},
  };
}
const files = [{ path: "styles/main.css", bytes: css }];
const store = () => new VignetStore(`test-${crypto.randomUUID()}`);
async function pkg(m = manifest()) {
  return inspectPackage(await packPackage(m, files));
}
const options = { confirmed: true, grantedPermissions: ["dom_access"] };
function rawZip(m, entries = {}) {
  return zipSync({
    "asset.json": strToU8(JSON.stringify(m)),
    "styles/main.css": css,
    ...entries,
  });
}

test("ZIP inspection and export roundtrip preserve manifest and content hash", async () => {
  const s = store();
  try {
    const p = await pkg();
    await s.installPackage(p, options);
    const exported = await inspectPackage(
      await s.exportPackage("example.theme"),
    );
    assert.equal(exported.manifest.id, "example.theme");
    assert.equal(exported.files[0].hash, await sha256(css));
    assert.deepEqual(
      new Uint8Array(
        await (await s.getMedia(exported.files[0].hash)).arrayBuffer(),
      ),
      css,
    );
  } finally {
    s.close();
  }
});
test("explicit confirmation, permissions, version conflicts, failed updates preserve old package", async () => {
  const s = store();
  try {
    const p = await pkg();
    await assert.rejects(s.installPackage(p), {
      code: "INSTALL_CONFIRMATION_REQUIRED",
    });
    await assert.rejects(s.installPackage(p, { confirmed: true }), {
      code: "PERMISSION_REQUIRED",
    });
    await s.installPackage(p, options);
    await assert.rejects(s.installPackage(p, { ...options, replace: true }), {
      code: "VERSION_CONFLICT",
    });
    const invalid = await pkg(manifest("example.theme", "2.0.0"));
    invalid.files[0].hash = "0".repeat(64);
    await assert.rejects(
      s.installPackage(invalid, { ...options, replace: true }),
      { code: "INTEGRITY_MISMATCH" },
    );
    assert.equal((await s.getAsset("example.theme")).manifest.version, "1.0.0");
    await s.installPackage(await pkg(manifest("example.theme", "2.0.0")), {
      ...options,
      replace: true,
    });
    assert.equal((await s.getAsset("example.theme")).manifest.version, "2.0.0");
  } finally {
    s.close();
  }
});
test("shared media deduplicates physically and removal preserves other ownership", async () => {
  const s = store();
  try {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    for (const id of ["example.one", "example.two"]) {
      const m = manifest(id);
      m.media = ["media/shared.png"];
      await s.installPackage(
        await inspectPackage(
          await packPackage(m, [
            ...files,
            { path: "media/shared.png", bytes: png },
          ]),
        ),
        options,
      );
    }
    const hash = await sha256(png);
    assert.equal((await s.listMedia()).length, 2); // shared CSS and PNG
    assert.equal(
      (await s.listMedia()).find((m) => m.hash === hash).owners.length,
      2,
    );
    await s.removeAsset("example.one");
    assert.ok(await s.getMedia(hash));
    await s.removeAsset("example.two");
    assert.equal(await s.getMedia(hash), undefined);
  } finally {
    s.close();
  }
});
test("IndexedDB reopen persists catalog and runtime JSON state", async () => {
  const s = store();
  try {
    await s.installPackage(await pkg(), options);
    await s.saveState({
      schemaVersion: 1,
      instances: [{ instanceId: "x", assetId: "example.theme" }],
      extra: 123,
    });
    s.close();
    assert.equal((await s.loadState()).extra, 123);
    assert.equal((await s.listAssets()).length, 2);
    await s.removeAsset("example.theme");
    assert.equal((await s.loadState()).instances.length, 0);
  } finally {
    s.close();
  }
});
test("quota failure occurs before mutation and leaves prior data intact", async () => {
  const s = store();
  const prior = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    await s.installPackage(await pkg(), options);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { storage: { estimate: async () => ({ quota: 50, usage: 20 }) } },
    });
    await assert.rejects(
      s.installPackage(await pkg(manifest("example.second")), options),
      { code: "QUOTA_EXCEEDED" },
    );
    assert.ok(await s.getAsset("example.theme"));
    assert.equal(await s.getAsset("example.second"), undefined);
  } finally {
    s.close();
    if (prior) Object.defineProperty(globalThis, "navigator", prior);
    else delete globalThis.navigator;
  }
});
test("an IndexedDB write quota error aborts a package update atomically", async () => {
  const s = store();
  const put = IDBObjectStore.prototype.put;
  try {
    await s.installPackage(await pkg(), options);
    const update = manifest("example.theme", "2.0.0");
    const changed = await inspectPackage(
      await packPackage(update, [
        { path: "styles/main.css", bytes: strToU8("body { color: red; }") },
      ]),
    );
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "media")
        throw new DOMException("Full", "QuotaExceededError");
      return put.apply(this, args);
    };
    await assert.rejects(
      s.installPackage(changed, { ...options, replace: true }),
      { code: "QUOTA_EXCEEDED" },
    );
    assert.equal((await s.getAsset("example.theme")).manifest.version, "1.0.0");
    assert.equal((await s.listMedia()).length, 1);
  } finally {
    IDBObjectStore.prototype.put = put;
    s.close();
  }
});
test("activation rollback restores exact prior record and retained resource blobs", async () => {
  const s = store();
  try {
    await s.installPackage(await pkg(), options);
    await s.setAssetEnabled("example.theme", false);
    const old = await s.getAsset("example.theme");
    const changed = await inspectPackage(
      await packPackage(manifest("example.theme", "2.0.0"), [
        { path: "styles/main.css", bytes: strToU8("body { color: green; }") },
      ]),
    );
    await s.installPackage(changed, { ...options, replace: true });
    assert.equal((await s.listMedia()).length, 2);
    assert.deepEqual(await s.restoreAsset(old), old);
    assert.deepEqual(await s.getAsset("example.theme"), old);
    assert.ok(await s.getMedia(old.files[0].hash));
    assert.equal(
      (await s.listMedia()).length,
      2,
      "Rollback does not GC either blob",
    );
    const invalid = structuredClone(old);
    invalid.files[0].hash = "0".repeat(64);
    await assert.rejects(s.restoreAsset(invalid), { code: "MEDIA_NOT_FOUND" });
    assert.deepEqual(
      await s.getAsset("example.theme"),
      old,
      "Failed rollback leaves current record intact",
    );
  } finally {
    s.close();
  }
});
test("first-install rollback removes only the new record without GC or state mutation", async () => {
  const s = store();
  try {
    await s.installPackage(await pkg(), options);
    await s.saveState({ schemaVersion: 1, instances: [], marker: "retained" });
    assert.equal(await s.restoreAsset(null, "example.theme"), null);
    assert.equal(await s.getAsset("example.theme"), undefined);
    assert.equal((await s.listMedia()).length, 1);
    assert.equal((await s.loadState()).marker, "retained");
    await assert.rejects(s.restoreAsset(null), { code: "INVALID_PACKAGE" });
  } finally {
    s.close();
  }
});
test("ZIP rejects traversal, backslash, absolute, duplicate-case and native content", async () => {
  for (const name of [
    "../bad.js",
    "/bad.js",
    "scripts\\bad.js",
    "styles/MAIN.css",
    "evil.exe",
  ])
    await assert.rejects(
      inspectPackage(rawZip(manifest(), { [name]: strToU8("bad") })),
      { code: "INVALID_PACKAGE" },
    );
});
test("ZIP rejects bad integrity, active SVG, spoofed media, invalid permission/schema", async () => {
  const badHash = manifest();
  badHash.integrity = { "styles/main.css": "0".repeat(64) };
  await assert.rejects(inspectPackage(rawZip(badHash)), {
    code: "INTEGRITY_MISMATCH",
  });
  const svgManifest = manifest();
  svgManifest.media = ["media/icon.svg"];
  for (const svg of [
    "<svg><script>alert(1)</script></svg>",
    '<svg onload="evil()"/>',
    '<svg><image href="https://evil.test"/></svg>',
  ])
    await assert.rejects(
      inspectPackage(rawZip(svgManifest, { "media/icon.svg": strToU8(svg) })),
      { code: "INVALID_PACKAGE" },
    );
  const spoof = manifest();
  spoof.media = ["media/picture.png"];
  await assert.rejects(
    inspectPackage(
      rawZip(spoof, { "media/picture.png": strToU8("<html>evil</html>") }),
    ),
    { code: "INVALID_PACKAGE" },
  );
  for (const patch of [
    { permissions: ["all_powerful"] },
    { settingsSchema: { type: "object", oneOf: [] } },
  ])
    await assert.rejects(inspectPackage(rawZip({ ...manifest(), ...patch })), {
      code: "INVALID_MANIFEST",
    });
});
test("ZIP rejects compression bombs and corrupt CRC before storage", async () => {
  await assert.rejects(
    inspectPackage(
      rawZip(manifest(), { "bomb.txt": new Uint8Array(1024 * 1024) }),
    ),
    { code: "INVALID_PACKAGE" },
  );
  const valid = rawZip(manifest());
  const bad = valid.slice();
  const view = new DataView(bad.buffer);
  let pos = 0;
  while (view.getUint32(pos, true) !== 0x02014b50) pos++;
  view.setUint32(pos + 16, 1234, true);
  await assert.rejects(inspectPackage(bad), { code: "INVALID_PACKAGE" });
  assert.equal(PACKAGE_LIMITS.files, 256);
});
