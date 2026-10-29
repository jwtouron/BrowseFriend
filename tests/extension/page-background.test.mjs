import assert from "node:assert/strict";
import test from "node:test";
import { installPageReader } from "../../extension/page/read/background.js";

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map((listener) => listener(...args)); },
  };
}

test("page reader injects on demand and retries the snapshot request", async () => {
  const onMessage = createEvent();
  const injections = [];
  let sends = 0;
  const snapshot = { documentId: "doc-1", revision: 2, title: "Page" };
  const reader = installPageReader({
    runtime: { id: "extension", onMessage, async sendMessage() {} },
    tabs: {
      async query() { return [{ id: 7, url: "https://example.test/page" }]; },
      async sendMessage() {
        sends += 1;
        if (sends === 1) throw new Error("No receiver");
        return { ok: true, snapshot };
      },
    },
    scripting: { async executeScript(options) { injections.push(options); } },
  });

  assert.deepEqual(await reader.capture(), { available: true, tabId: 7, snapshot });
  assert.equal(sends, 2);
  assert.deepEqual(injections, [{
    target: { tabId: 7 },
    files: ["extension/page/read/content-script.js"],
  }]);
});

test("page reader waits for navigation to expose a different document", async () => {
  const onMessage = createEvent();
  let snapshots = 0;
  const reader = installPageReader({
    runtime: { id: "extension", onMessage, async sendMessage() {} },
    tabs: {
      async query() { return [{ id: 7, url: "https://example.test/next" }]; },
      async sendMessage() {
        snapshots += 1;
        return {
          ok: true,
          snapshot: snapshots === 1
            ? { documentId: "doc-1", revision: 2, url: "https://example.test/start" }
            : { documentId: "doc-2", revision: 0, url: "https://example.test/next" },
        };
      },
    },
    scripting: { async executeScript() {} },
  });

  const result = await reader.captureAfterNavigation({
    tabId: 7,
    documentId: "doc-1",
    url: "https://example.test/start",
  });

  assert.equal(result.snapshot.documentId, "doc-2");
  assert.equal(snapshots, 2);
});

test("page reader reports unsupported browser pages without injecting", async () => {
  const onMessage = createEvent();
  let injected = false;
  const reader = installPageReader({
    runtime: { id: "extension", onMessage, async sendMessage() {} },
    tabs: {
      async query() { return [{ id: 7, url: "chrome://settings" }]; },
    },
    scripting: { async executeScript() { injected = true; } },
  });

  const result = await reader.capture();
  assert.equal(result.available, false);
  assert.equal(result.error.code, "page_unavailable");
  assert.equal(injected, false);
});

test("page reader degrades to unavailable when Chrome rejects injection", async () => {
  const onMessage = createEvent();
  const reader = installPageReader({
    runtime: { id: "extension", onMessage, async sendMessage() {} },
    tabs: {
      async query() { return [{ id: 7, url: "https://chromewebstore.google.com/detail/example" }]; },
      async sendMessage() { throw new Error("No receiver"); },
    },
    scripting: { async executeScript() { throw new Error("Cannot access this page"); } },
  });

  const result = await reader.capture();
  assert.equal(result.available, false);
  assert.match(result.error.message, /did not allow/);
});

test("page reader accepts dirty events only from the top frame", () => {
  const onMessage = createEvent();
  const broadcasts = [];
  const reader = installPageReader({
    runtime: {
      id: "extension",
      onMessage,
      async sendMessage(message) { broadcasts.push(message); },
    },
    tabs: {},
    scripting: {},
  });
  const received = [];
  reader.onDirty((event) => received.push(event));
  const dirty = { channel: "page", event: "dirty", documentId: "doc", revision: 3 };

  onMessage.emit(dirty, { id: "extension", frameId: 2, tab: { id: 4 } }, () => {});
  onMessage.emit(dirty, { id: "extension", frameId: 0, tab: { id: 4 } }, () => {});

  assert.deepEqual(received, [{ tabId: 4, documentId: "doc", revision: 3 }]);
  assert.equal(broadcasts.length, 1);
});

test("page reader reports top-level tab navigation as a page change", () => {
  const onMessage = createEvent();
  const onUpdated = createEvent();
  const onActivated = createEvent();
  const reader = installPageReader({
    runtime: { id: "extension", onMessage, async sendMessage() {} },
    tabs: { onUpdated, onActivated },
    scripting: {},
  });
  const received = [];
  reader.onDirty((event) => received.push(event));

  onUpdated.emit(9, { status: "complete" });
  onUpdated.emit(9, { status: "loading", url: "https://example.test/next" });
  onActivated.emit({ tabId: 12, windowId: 3 });

  assert.deepEqual(received, [
    {
      tabId: 9,
      documentId: null,
      revision: Number.MAX_SAFE_INTEGER,
      url: "https://example.test/next",
    },
    {
      tabId: 12,
      windowId: 3,
      activated: true,
      documentId: null,
      revision: Number.MAX_SAFE_INTEGER,
    },
  ]);
});
