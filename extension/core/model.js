// CSP-safe validation: no runtime compilation or evaluation of schemas.
export function error(code, message) {
  return Object.assign(new Error(message), { code });
}
export const permissions = [
  "dom_overlay",
  "dom_access",
  "audio",
  "user_scripts",
];
const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
export function safePath(path) {
  return (
    typeof path === "string" &&
    /^[a-zA-Z0-9_./-]+$/.test(path) &&
    path.length < 240 &&
    !path.startsWith("/") &&
    !path.split("/").some((p) => !p || p === "." || p === "..")
  );
}
const schemaKeys = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "default",
  "description",
  "title",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
]);
export function validateSchema(schema, depth = 0) {
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    depth > 12
  )
    throw error("INVALID_MANIFEST", "Invalid or deeply nested JSON Schema");
  for (const key of Object.keys(schema))
    if (!schemaKeys.has(key))
      throw error(
        "INVALID_MANIFEST",
        `Unsupported JSON Schema keyword: ${key}`,
      );
  if (
    ![
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(schema.type)
  )
    throw error("INVALID_MANIFEST", "Schema type is required");
  if (schema.pattern !== undefined) {
    // Restrict patterns to a known, bounded format to avoid package-supplied ReDoS.
    if (schema.pattern !== "^#[a-fA-F0-9]{6}$")
      throw error(
        "INVALID_MANIFEST",
        "Only the documented color pattern is supported",
      );
  }
  if (schema.properties)
    for (const [key, child] of Object.entries(schema.properties)) {
      if (dangerousKeys.has(key))
        throw error("INVALID_MANIFEST", "Unsafe property name");
      validateSchema(child, depth + 1);
    }
  if (
    schema.properties &&
    (typeof schema.properties !== "object" || Array.isArray(schema.properties))
  )
    throw error("INVALID_MANIFEST", "properties must be an object");
  if (schema.items) validateSchema(schema.items, depth + 1);
  if (
    schema.required &&
    (!Array.isArray(schema.required) ||
      schema.required.some(
        (k) =>
          typeof k !== "string" || !Object.hasOwn(schema.properties || {}, k),
      ))
  )
    throw error("INVALID_MANIFEST", "Invalid required properties");
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  )
    throw error("INVALID_MANIFEST", "additionalProperties must be boolean");
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.length))
    throw error("INVALID_MANIFEST", "Invalid enum");
  for (const key of [
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ])
    if (schema[key] !== undefined && !Number.isFinite(schema[key]))
      throw error("INVALID_MANIFEST", `Invalid ${key}`);
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"])
    if (
      schema[key] !== undefined &&
      (!Number.isInteger(schema[key]) || schema[key] < 0)
    )
      throw error("INVALID_MANIFEST", `Invalid ${key}`);
  for (const [min, max] of [
    ["minimum", "maximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
  ])
    if (
      schema[min] !== undefined &&
      schema[max] !== undefined &&
      schema[min] > schema[max]
    )
      throw error("INVALID_MANIFEST", `Invalid ${min}/${max} range`);
  return schema;
}
export function validateParameters(schema, parameters = {}) {
  validateSchema(schema);
  const copy = structuredClone(parameters);
  function walk(s, value, path) {
    if (value === undefined && Object.hasOwn(s, "default"))
      value = structuredClone(s.default);
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (s.type === "integer" ? !Number.isInteger(value) : type !== s.type)
      throw error("INVALID_PARAMETERS", `${path}: expected ${s.type}`);
    if (
      s.enum &&
      !s.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))
    )
      throw error("INVALID_PARAMETERS", `${path}: not in enum`);
    if (
      type === "number" &&
      (!Number.isFinite(value) ||
        (s.minimum !== undefined && value < s.minimum) ||
        (s.maximum !== undefined && value > s.maximum))
    )
      throw error("INVALID_PARAMETERS", `${path}: outside allowed range`);
    if (
      type === "string" &&
      ((s.minLength !== undefined && value.length < s.minLength) ||
        (s.maxLength !== undefined && value.length > s.maxLength) ||
        (s.pattern && !new RegExp(s.pattern).test(value)))
    )
      throw error("INVALID_PARAMETERS", `${path}: invalid string`);
    if (type === "object") {
      for (const key of Object.keys(value))
        if (
          dangerousKeys.has(key) ||
          (s.additionalProperties === false &&
            !Object.hasOwn(s.properties || {}, key))
        )
          throw error("INVALID_PARAMETERS", `${path}: unknown property ${key}`);
      for (const [key, child] of Object.entries(s.properties || {})) {
        if (value[key] !== undefined || Object.hasOwn(child, "default"))
          value[key] = walk(child, value[key], `${path}.${key}`);
      }
      for (const key of s.required || [])
        if (!Object.hasOwn(value, key))
          throw error("INVALID_PARAMETERS", `${path}: missing ${key}`);
    }
    if (type === "array") {
      if (
        (s.minItems !== undefined && value.length < s.minItems) ||
        value.length > (s.maxItems ?? 1000)
      )
        throw error("INVALID_PARAMETERS", `${path}: invalid array length`);
      if (s.items)
        value = value.map((v, i) => walk(s.items, v, `${path}[${i}]`));
    }
    return value;
  }
  return walk(schema, copy, "parameters");
}
export function validateManifest(input) {
  const m = structuredClone(input);
  const fail = (message) => {
    throw error("INVALID_MANIFEST", message);
  };
  if (!m || typeof m !== "object" || Array.isArray(m))
    fail("Manifest must be an object");
  const allowed = new Set([
    "schemaVersion",
    "id",
    "name",
    "version",
    "description",
    "entry",
    "scripts",
    "styles",
    "media",
    "actions",
    "settingsSchema",
    "permissions",
    "execution",
    "defaultScope",
    "compatibility",
    "author",
    "license",
    "integrity",
  ]);
  if (Object.keys(m).some((k) => !allowed.has(k)))
    fail("Unknown manifest field");
  if (
    m.schemaVersion !== 1 ||
    !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(m.id || "")
  )
    fail("Invalid schemaVersion or namespaced id");
  for (const k of ["name", "description", "version"])
    if (typeof m[k] !== "string" || !m[k].length || m[k].length > 4096)
      fail(`Missing or invalid ${k}`);
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      m.version,
    )
  )
    fail("Version must be SemVer");
  for (const k of ["author", "license"])
    if (m[k] !== undefined && (typeof m[k] !== "string" || m[k].length > 4096))
      fail(`Invalid ${k}`);
  if (m.entry !== undefined && (!safePath(m.entry) || !m.entry.endsWith(".js")))
    fail("Invalid JS entry");
  if (!m.entry && !Array.isArray(m.scripts))
    fail("entry or scripts is required (empty scripts for CSS-only assets)");
  for (const k of ["scripts", "styles", "media"]) {
    if (k === "scripts" && m[k] === undefined) m[k] = [];
    if (
      !Array.isArray(m[k]) ||
      m[k].length > 256 ||
      m[k].some((p) => !safePath(p)) ||
      new Set(m[k]).size !== m[k].length
    )
      fail(`Invalid ${k}`);
  }
  if (
    m.scripts.some((p) => !p.endsWith(".js")) ||
    m.styles.some((p) => !p.endsWith(".css"))
  )
    fail("Invalid script/style extension");
  if (
    !Array.isArray(m.permissions) ||
    m.permissions.some((p) => !permissions.includes(p)) ||
    new Set(m.permissions).size !== m.permissions.length
  )
    fail("Invalid permissions");
  if (
    (m.entry || m.scripts.length) &&
    (!m.permissions.includes("user_scripts") ||
      !m.permissions.includes("dom_access"))
  )
    fail("JS requires user_scripts and dom_access permissions");
  if (!["global", "chat", "temporary"].includes(m.defaultScope))
    fail("Invalid defaultScope");
  if (
    !m.execution ||
    typeof m.execution !== "object" ||
    Array.isArray(m.execution)
  )
    fail("execution required");
  if (
    Object.keys(m.execution).some(
      (k) =>
        ![
          "world",
          "multipleInstances",
          "cleanupGuarantee",
          "requiresReloadOnStop",
        ].includes(k),
    )
  )
    fail("Unknown execution field");
  m.execution = {
    world: "USER_SCRIPT",
    multipleInstances: false,
    cleanupGuarantee: "best-effort",
    requiresReloadOnStop: false,
    ...m.execution,
  };
  if (
    m.execution.world !== "USER_SCRIPT" ||
    typeof m.execution.multipleInstances !== "boolean" ||
    typeof m.execution.requiresReloadOnStop !== "boolean" ||
    !["managed", "best-effort"].includes(m.execution.cleanupGuarantee)
  )
    fail("Invalid execution contract");
  if (
    !m.compatibility ||
    typeof m.compatibility !== "object" ||
    Array.isArray(m.compatibility) ||
    Object.keys(m.compatibility).some((k) => k !== "minimumChromeVersion")
  )
    fail("Invalid compatibility");
  if (
    m.compatibility.minimumChromeVersion !== undefined &&
    (!Number.isInteger(m.compatibility.minimumChromeVersion) ||
      m.compatibility.minimumChromeVersion < 116)
  )
    fail("Invalid Chrome version");
  if (
    !m.actions ||
    typeof m.actions !== "object" ||
    Array.isArray(m.actions) ||
    !Object.keys(m.actions).length ||
    Object.keys(m.actions).length > 32
  )
    fail("Actions required");
  for (const [name, action] of Object.entries(m.actions)) {
    if (
      !/^[a-z][a-zA-Z0-9_]*$/.test(name) ||
      dangerousKeys.has(name) ||
      !action ||
      typeof action.description !== "string" ||
      !action.description ||
      Object.keys(action).some(
        (k) => !["description", "parameters"].includes(k),
      )
    )
      fail("Invalid action");
    validateSchema(action.parameters);
    if (action.parameters.type !== "object")
      fail("Action parameters must be object");
  }
  validateSchema(m.settingsSchema);
  if (m.settingsSchema.type !== "object") fail("settingsSchema must be object");
  if (
    m.integrity !== undefined &&
    (!m.integrity ||
      typeof m.integrity !== "object" ||
      Array.isArray(m.integrity) ||
      Object.entries(m.integrity).some(
        ([p, h]) => !safePath(p) || !/^[a-f0-9]{64}$/.test(h),
      ))
  )
    fail("Invalid integrity map");
  return m;
}
const settings = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean", default: true },
    color: { type: "string", pattern: "^#[a-fA-F0-9]{6}$", default: "#000000" },
    opacity: { type: "number", minimum: 0, maximum: 1, default: 0.7 },
    innerRadius: { type: "number", minimum: 0, maximum: 90, default: 45 },
  },
};
export const builtinVignette = validateManifest({
  schemaVersion: 1,
  id: "builtin.vignette",
  name: "Vignette",
  version: "1.0.0",
  description: "Затемнение краёв ChatGPT",
  scripts: [],
  styles: [],
  media: [],
  actions: {
    start: { description: "Apply vignette", parameters: settings },
    stop: {
      description: "Hide vignette",
      parameters: { type: "object", additionalProperties: false },
    },
  },
  settingsSchema: settings,
  permissions: ["dom_overlay"],
  execution: { cleanupGuarantee: "managed" },
  defaultScope: "global",
  compatibility: {},
});
export function migrateState(input = {}, legacySettings) {
  const state = structuredClone(input);
  if ((state.schemaVersion || 0) > 1)
    throw error(
      "STORAGE_VERSION_UNSUPPORTED",
      "Storage was created by a newer Vignet",
    );
  state.schemaVersion = 1;
  state.configurations ||= [];
  if (!state.legacyMigrated && legacySettings) {
    state.configurations.push({
      instanceId: "legacy-vignette",
      assetId: "builtin.vignette",
      scope: "global",
      parameters: validateParameters(settings, legacySettings),
      enabled: true,
    });
  }
  state.legacyMigrated = true;
  return state;
}
