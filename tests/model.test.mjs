import test from "node:test";
import assert from "node:assert/strict";
import {
  builtinVignette,
  validateManifest,
  validateParameters,
  migrateState,
} from "../extension/core/model.js";

test("builtin vignette preserves legacy parameters and defaults without mutating input", () => {
  const input = { color: "#ff0000", opacity: 0.7 };
  const result = validateParameters(builtinVignette.settingsSchema, input);
  assert.deepEqual(result, {
    enabled: true,
    color: "#ff0000",
    opacity: 0.7,
    innerRadius: 45,
  });
  assert.deepEqual(input, { color: "#ff0000", opacity: 0.7 });
  for (const parameters of [
    { opacity: 2 },
    { innerRadius: -1 },
    { color: "red" },
    { enabled: 1 },
    { unknown: true },
  ])
    assert.throws(
      () => validateParameters(builtinVignette.settingsSchema, parameters),
      { code: "INVALID_PARAMETERS" },
    );
});
test("manifest rejects unsafe ids, code permissions, schema keywords and unsupported worlds", () => {
  const m = structuredClone(builtinVignette);
  for (const patch of [
    { id: "../bad" },
    { version: "1.2" },
    { permissions: ["fake"] },
    { execution: { world: "MAIN" } },
    { entry: "scripts/main.js" },
    { settingsSchema: { type: "object", oneOf: [] } },
  ])
    assert.throws(() => validateManifest({ ...m, ...patch }), {
      code: "INVALID_MANIFEST",
    });
  assert.equal(validateManifest(m).id, "builtin.vignette");
});
test("legacy state migration is idempotent and preserves existing state", () => {
  const state = migrateState(
    { unrelated: 42 },
    { color: "#ff0000", enabled: true, opacity: 0.7, innerRadius: 45 },
  );
  assert.equal(state.unrelated, 42);
  assert.equal(state.configurations[0].assetId, "builtin.vignette");
  assert.deepEqual(migrateState(state, { color: "#00ff00" }), state);
  assert.throws(() => migrateState({ schemaVersion: 2 }), {
    code: "STORAGE_VERSION_UNSUPPORTED",
  });
});
