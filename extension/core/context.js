export function parseContext(url, tabId, temporaryId = `temporary:${tabId}`) {
  const parsed = new URL(url);
  if (parsed.origin !== "https://chatgpt.com")
    throw Object.assign(new Error("Not a ChatGPT tab"), {
      code: "CONTEXT_UNAVAILABLE",
    });
  const match = parsed.pathname.match(/(?:^|\/)c\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  const chatId = match?.[1] || null;
  const contextKey = chatId ? `chat:${chatId}` : temporaryId;
  return {
    tabId,
    url: parsed.href,
    chatId,
    contextKey,
    key: contextKey,
    scope: chatId ? "chat" : "temporary",
  };
}

export function contextApplies(instance, context) {
  return (
    instance.scope === "global" || instance.contextKey === context.contextKey
  );
}

// A chat-specific singleton overrides a global singleton of the same asset.
export function effectiveInstances(instances, context) {
  const applicable = instances.filter(
    (item) => item.enabled !== false && contextApplies(item, context),
  );
  const overrides = new Set(
    applicable
      .filter((item) => item.scope !== "global" && !item.multipleInstances)
      .map((item) => item.assetId),
  );
  return applicable.filter(
    (item) =>
      item.scope !== "global" ||
      item.multipleInstances ||
      !overrides.has(item.assetId),
  );
}

export class ContextManager {
  constructor() {
    this.tabs = new Map();
    this.sequence = 0;
    this.epoch = crypto.randomUUID();
  }
  transition(tabId, url) {
    const previous = this.tabs.get(tabId);
    const candidate = parseContext(
      url,
      tabId,
      previous?.scope === "temporary"
        ? previous.contextKey
        : `temporary:${tabId}:${this.epoch}:${++this.sequence}`,
    );
    const migrateFrom =
      previous?.scope === "temporary" && candidate.chatId
        ? previous.contextKey
        : null;
    // Leaving one temporary URL for another creates a fresh ephemeral context.
    if (
      previous?.scope === "temporary" &&
      !candidate.chatId &&
      new URL(previous.url).pathname !== new URL(url).pathname
    ) {
      candidate.contextKey = `temporary:${tabId}:${this.epoch}:${++this.sequence}`;
      candidate.key = candidate.contextKey;
    }
    this.tabs.set(tabId, candidate);
    return { context: candidate, previous, migrateFrom };
  }
  remove(tabId) {
    const previous = this.tabs.get(tabId);
    this.tabs.delete(tabId);
    return previous;
  }
  list() {
    return [...this.tabs.values()];
  }
}
