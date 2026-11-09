import test from "node:test";
import assert from "node:assert/strict";
import {
  parseContext,
  ContextManager,
  effectiveInstances,
} from "../extension/core/context.js";

test("chat URL forms and independent temporary contexts", () => {
  assert.equal(parseContext("https://chatgpt.com/c/abc", 1).key, "chat:abc");
  assert.equal(
    parseContext("https://chatgpt.com/g/g-abc/project/c/def", 1).key,
    "chat:def",
  );
  assert.throws(() => parseContext("https://evil.example/c/a", 1), {
    code: "CONTEXT_UNAVAILABLE",
  });
  const manager = new ContextManager();
  const a = manager.transition(1, "https://chatgpt.com/").context;
  const b = manager.transition(2, "https://chatgpt.com/").context;
  assert.notEqual(a.key, b.key);
  assert.equal(
    manager.transition(1, "https://chatgpt.com/c/new").migrateFrom,
    a.key,
  );
  manager.remove(1);
  assert.equal(manager.list().length, 1);
});

test("A/B restores chat configs, global persists, chat singleton overrides global", () => {
  const items = [
    { instanceId: "g", assetId: "theme", scope: "global" },
    { instanceId: "a", assetId: "rain", scope: "chat", contextKey: "chat:a" },
    { instanceId: "ga", assetId: "theme", scope: "chat", contextKey: "chat:a" },
  ];
  const a = parseContext("https://chatgpt.com/c/a", 1);
  const b = parseContext("https://chatgpt.com/c/b", 1);
  assert.deepEqual(
    effectiveInstances(items, a).map((x) => x.instanceId),
    ["a", "ga"],
  );
  assert.deepEqual(
    effectiveInstances(items, b).map((x) => x.instanceId),
    ["g"],
  );
  assert.deepEqual(
    effectiveInstances(items, a).map((x) => x.instanceId),
    ["a", "ga"],
  );
});
