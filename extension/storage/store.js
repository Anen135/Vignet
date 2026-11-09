import {
  builtinVignette,
  error,
  migrateState,
  validateManifest,
} from "../core/model.js";
import {
  detectMime,
  packPackage,
  sha256,
  PACKAGE_LIMITS,
} from "../core/installer.js";

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
function storageError(e) {
  return e?.name === "QuotaExceededError"
    ? error(
        "QUOTA_EXCEEDED",
        "Local storage quota exceeded; free unused media and retry",
      )
    : e;
}
function builtin() {
  return {
    manifest: structuredClone(builtinVignette),
    enabled: true,
    grantedPermissions: ["dom_overlay"],
    files: [],
    source: "builtin",
  };
}
export class VignetStore {
  constructor(dbName = "vignet") {
    this.dbName = dbName;
    this.db = null;
  }
  async init() {
    if (this.db) return this;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        for (const name of ["assets", "media", "state"])
          if (!req.result.objectStoreNames.contains(name))
            req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(storageError(req.error));
      req.onblocked = () =>
        reject(
          error(
            "STORAGE_BLOCKED",
            "Close other Vignet management pages and retry",
          ),
        );
    });
    this.db.onversionchange = () => {
      this.db.close();
      this.db = null;
    };
    return this;
  }
  async transaction(names, mode, fn) {
    await this.init();
    const tx = this.db.transaction(names, mode);
    const completed = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () =>
        reject(
          storageError(
            tx.error || error("STORAGE_ERROR", "Transaction aborted"),
          ),
        );
      tx.onerror = () => {};
    });
    try {
      const result = await fn(tx);
      await completed;
      return result;
    } catch (e) {
      try {
        tx.abort();
      } catch {}
      await completed.catch(() => {});
      throw storageError(e);
    }
  }
  async listAssets() {
    return [
      builtin(),
      ...(await this.transaction(["assets"], "readonly", (tx) =>
        request(tx.objectStore("assets").getAll()),
      )),
    ];
  }
  async getAsset(id) {
    return id === "builtin.vignette"
      ? builtin()
      : this.transaction(["assets"], "readonly", (tx) =>
          request(tx.objectStore("assets").get(id)),
        );
  }
  async installPackage(
    pkg,
    { confirmed = false, grantedPermissions = [], replace = false } = {},
  ) {
    if (!confirmed)
      throw error(
        "INSTALL_CONFIRMATION_REQUIRED",
        "Review package and explicitly confirm installation",
      );
    const manifest = validateManifest(pkg.manifest);
    if (manifest.id.startsWith("builtin."))
      throw error("INVALID_PACKAGE", "Reserved asset ID");
    if (manifest.permissions.some((p) => !grantedPermissions.includes(p)))
      throw error(
        "PERMISSION_REQUIRED",
        "Grant each declared permission before installation",
      );
    const expected = new Set(
      [
        manifest.entry,
        ...manifest.scripts,
        ...manifest.styles,
        ...manifest.media,
      ].filter(Boolean),
    );
    if (
      !Array.isArray(pkg.files) ||
      pkg.files.length !== expected.size ||
      pkg.files.length >= PACKAGE_LIMITS.files
    )
      throw error("INVALID_PACKAGE", "Resource count mismatch");
    const files = [];
    const blobs = new Map();
    let totalSize = 0;
    for (const file of pkg.files) {
      if (!expected.delete(file.path))
        throw error("INVALID_PACKAGE", "Unexpected/duplicate resource");
      const bytes =
        file.bytes instanceof Uint8Array
          ? file.bytes
          : new Uint8Array(file.bytes);
      totalSize += bytes.length;
      if (totalSize > PACKAGE_LIMITS.unpacked)
        throw error("INVALID_PACKAGE", "Package exceeds unpacked size limit");
      const hash = await sha256(bytes),
        mime = detectMime(file.path, bytes);
      if (
        (file.hash && file.hash !== hash) ||
        (manifest.integrity?.[file.path] &&
          manifest.integrity[file.path] !== hash)
      )
        throw error(
          "INTEGRITY_MISMATCH",
          "Resource content does not match hash",
        );
      files.push({
        path: file.path,
        hash,
        mime,
        size: bytes.length,
        integrity: hash,
      });
      blobs.set(hash, new Blob([bytes], { type: mime }));
    }
    if (expected.size) throw error("INVALID_PACKAGE", "Missing resources");
    // Reserve 1 MiB, leave existing installation untouched if capacity is insufficient.
    if (globalThis.navigator?.storage?.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      let needed = 0;
      for (const [hash, blob] of blobs)
        if (!(await this.getMedia(hash))) needed += blob.size;
      if (
        Number.isFinite(quota) &&
        Number.isFinite(usage) &&
        usage + needed + 1024 * 1024 > quota
      )
        throw error(
          "QUOTA_EXCEEDED",
          "Insufficient free storage for package and reserve",
        );
    }
    const record = {
      manifest,
      enabled: true,
      grantedPermissions: [...manifest.permissions],
      files,
      source: "local-package",
      installedAt: Date.now(),
    };
    await this.transaction(["assets", "media"], "readwrite", async (tx) => {
      const assets = tx.objectStore("assets"),
        media = tx.objectStore("media");
      const previous = await request(assets.get(manifest.id));
      if (
        previous &&
        (!replace || !newer(manifest.version, previous.manifest.version))
      )
        throw error(
          "VERSION_CONFLICT",
          "A newer SemVer package and explicit update confirmation are required",
        );
      if (previous) record.enabled = previous.enabled;
      for (const [hash, blob] of blobs)
        if (!(await request(media.getKey(hash))))
          media.put({ blob, size: blob.size }, hash);
      assets.put(record, manifest.id);
    });
    return record;
  }
  async setAssetEnabled(id, enabled) {
    if (id === "builtin.vignette")
      throw error(
        "PERMISSION_REQUIRED",
        "Built-in vignette is controlled through its instance",
      );
    return this.transaction(["assets"], "readwrite", async (tx) => {
      const store = tx.objectStore("assets");
      const record = await request(store.get(id));
      if (!record) throw error("ASSET_NOT_FOUND", id);
      record.enabled = Boolean(enabled);
      store.put(record, id);
      return record;
    });
  }
  // Internal activation rollback only: restore a previously read installation.
  // Resource blobs are intentionally retained until a separate explicit GC.
  async restoreAsset(record, assetId = record?.manifest?.id) {
    if (
      typeof assetId !== "string" ||
      !assetId ||
      assetId.startsWith("builtin.")
    )
      throw error("INVALID_PACKAGE", "Invalid rollback asset ID");
    if (record && record.manifest?.id !== assetId)
      throw error("INVALID_PACKAGE", "Rollback asset ID mismatch");
    const restored = record ? structuredClone(record) : null;
    if (restored) {
      validateManifest(restored.manifest);
      if (!Array.isArray(restored.files))
        throw error("INVALID_PACKAGE", "Invalid rollback resources");
    }
    return this.transaction(["assets", "media"], "readwrite", async (tx) => {
      const assets = tx.objectStore("assets"),
        media = tx.objectStore("media");
      if (!restored) {
        assets.delete(assetId);
        return null;
      }
      for (const file of restored.files) {
        const resource = await request(media.get(file.hash));
        if (!resource?.blob || resource.blob.size !== file.size)
          throw error(
            "MEDIA_NOT_FOUND",
            `Cannot restore missing resource: ${file.path}`,
          );
      }
      assets.put(restored, assetId);
      return restored;
    });
  }
  async removeAsset(id) {
    if (id === "builtin.vignette")
      throw error("PERMISSION_REQUIRED", "Cannot delete built-in asset");
    await this.transaction(["assets", "state"], "readwrite", async (tx) => {
      tx.objectStore("assets").delete(id);
      const state = await request(tx.objectStore("state").get("runtime"));
      if (state) {
        for (const key of ["instances", "configurations"])
          if (Array.isArray(state[key]))
            state[key] = state[key].filter((i) => i.assetId !== id);
        tx.objectStore("state").put(state, "runtime");
      }
    });
    await this.gc();
  }
  async getMedia(hash) {
    return this.transaction(
      ["media"],
      "readonly",
      async (tx) => (await request(tx.objectStore("media").get(hash)))?.blob,
    );
  }
  async listMedia() {
    return this.transaction(["assets", "media"], "readonly", async (tx) => {
      const assets = await request(tx.objectStore("assets").getAll()),
        media = tx.objectStore("media");
      const keys = await request(media.getAllKeys()),
        records = await request(media.getAll());
      return keys.map((hash, i) => ({
        hash,
        size: records[i].size,
        mime: records[i].blob.type,
        owners: assets
          .filter((a) => a.files.some((f) => f.hash === hash))
          .map((a) => a.manifest.id),
        paths: assets.flatMap((a) =>
          a.files
            .filter((f) => f.hash === hash)
            .map((f) => ({ assetId: a.manifest.id, path: f.path })),
        ),
      }));
    });
  }
  async gc() {
    return this.transaction(["assets", "media"], "readwrite", async (tx) => {
      const assets = await request(tx.objectStore("assets").getAll());
      const used = new Set(assets.flatMap((a) => a.files.map((f) => f.hash)));
      const media = tx.objectStore("media"),
        keys = await request(media.getAllKeys());
      let removed = 0;
      for (const hash of keys)
        if (!used.has(hash)) {
          media.delete(hash);
          removed++;
        }
      return removed;
    });
  }
  async exportPackage(id) {
    const record = await this.getAsset(id);
    if (!record) throw error("ASSET_NOT_FOUND", id);
    if (id === "builtin.vignette")
      throw error("INVALID_PACKAGE", "Built-in asset is shipped with Vignet");
    const files = [];
    for (const file of record.files) {
      const blob = await this.getMedia(file.hash);
      if (!blob) throw error("MEDIA_NOT_FOUND", file.path);
      files.push({
        path: file.path,
        bytes: new Uint8Array(await blob.arrayBuffer()),
      });
    }
    return packPackage(record.manifest, files);
  }
  async loadState() {
    return this.transaction(
      ["state"],
      "readonly",
      async (tx) =>
        (await request(tx.objectStore("state").get("runtime"))) || {
          schemaVersion: 1,
          instances: [],
        },
    );
  }
  async saveState(state) {
    if (state.schemaVersion !== 1)
      throw error("STORAGE_VERSION_UNSUPPORTED", "Unknown state schemaVersion");
    return this.transaction(["state"], "readwrite", (tx) => {
      tx.objectStore("state").put(structuredClone(state), "runtime");
    });
  }
  async migrateLegacy(settings) {
    const state = migrateState(await this.loadState(), settings);
    await this.saveState(state);
    return state;
  }
  close() {
    this.db?.close();
    this.db = null;
  }
}
function newer(a, b) {
  const parse = (v) => v.split("+")[0].split("-");
  const aa = parse(a),
    bb = parse(b);
  const coreA = aa[0].split(".").map(Number),
    coreB = bb[0].split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (coreA[i] !== coreB[i]) return coreA[i] > coreB[i];
  if (!aa[1] || !bb[1]) return !aa[1] && !!bb[1];
  const ap = aa.slice(1).join("-").split("."),
    bp = bb.slice(1).join("-").split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return false;
    if (bp[i] === undefined) return true;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]),
      bn = /^\d+$/.test(bp[i]);
    return an && bn
      ? Number(ap[i]) > Number(bp[i])
      : an !== bn
        ? !an
        : ap[i] > bp[i];
  }
  return false;
}
