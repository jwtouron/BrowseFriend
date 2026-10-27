import assert from "node:assert/strict";
import test from "node:test";
import { installChatController } from "../../extension/chat/background.js";

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map((listener) => listener(...args)); },
  };
}

function createHarness({ streamRequest } = {}) {
  const stored = {};
  const broadcasts = [];
  const companionCalls = [];
  const dirtyListeners = [];
  const onMessage = createEvent();
  let nextId = 1;
  const runtime = {
    id: "extension",
    onMessage,
    async sendMessage(message) { broadcasts.push(message); },
  };
  const storage = {
    async get(key) { return { [key]: stored[key] }; },
    async set(values) { Object.assign(stored, structuredClone(values)); },
  };
  const companion = {
    async request(method, params, onEvent, explicitId) {
      companionCalls.push({ method, params: structuredClone(params), explicitId });
      if (method === "model.list") {
        return { result: { models: [{ slug: "model-1", displayName: "Model One" }] } };
      }
      if (method === "model.stream") {
        if (streamRequest) return streamRequest({ method, params, onEvent, explicitId });
        onEvent({ event: "model.delta", requestId: explicitId, delta: "Answer" });
        return { result: { completed: true } };
      }
      return { result: { cancelled: true } };
    },
  };
  const pageReader = {
    async capture() {
      return {
        available: true,
        tabId: 4,
        snapshot: {
          version: 1,
          documentId: "doc-1",
          revision: 1,
          title: "Fixture page",
          url: "https://example.test/",
          records: [{ type: "text", text: "Page words" }],
        },
      };
    },
    onDirty(listener) { dirtyListeners.push(listener); },
  };
  const controller = installChatController({
    runtime,
    storage,
    companion,
    pageReader,
    randomUUID: () => `id-${nextId++}`,
  });
  return { broadcasts, companionCalls, controller, dirtyListeners, onMessage, runtime, storage };
}

function dispatch(harness, message) {
  return new Promise((resolve) => {
    const [keepOpen] = harness.onMessage.emit(message, { id: "extension" }, resolve);
    assert.equal(keepOpen, true);
  });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("chat controller stores session messages, streams deltas, and omits old page snapshots", async () => {
  const harness = createHarness();

  const first = await dispatch(harness, { channel: "chat", method: "chat.send", text: "First" });
  assert.equal(first.ok, true);
  await settle();
  let state = await harness.controller.getState();
  assert.equal(state.messages[0].context.snapshot.title, "Fixture page");
  assert.equal(state.messages[1].text, "Answer");
  assert.equal(state.messages[1].status, "complete");
  assert.equal(state.model.displayName, "Model One");

  await dispatch(harness, { channel: "chat", method: "chat.send", text: "Second" });
  await settle();
  const streams = harness.companionCalls.filter((call) => call.method === "model.stream");
  assert.deepEqual(streams[0].params.history, []);
  assert.deepEqual(streams[1].params.history, [
    { role: "user", content: "First" },
    { role: "assistant", content: "Answer" },
  ]);
  assert.equal(JSON.stringify(streams[1].params.history).includes("Page words"), false);
  assert.match(streams[1].params.pageContext, /Fixture page/);

  state = await harness.controller.getState();
  assert.equal(state.messages.length, 4);
  assert.equal(harness.broadcasts.some((message) => message.event === "delta"), true);
});

test("chat controller marks answers stale and New chat clears session state", async () => {
  const harness = createHarness();
  await dispatch(harness, { channel: "chat", method: "chat.send", text: "Question" });
  await settle();

  harness.dirtyListeners[0]({ tabId: 4, documentId: "doc-1", revision: 2 });
  await settle();
  let state = await harness.controller.getState();
  assert.equal(state.messages[0].context.stale, true);
  assert.equal(state.messages[1].stale, true);

  const cleared = await dispatch(harness, { channel: "chat", method: "chat.clear" });
  state = cleared.result;
  assert.deepEqual(state.messages, []);
  assert.equal(state.model.slug, "model-1");
});

test("chat controller marks captured context stale when its tab navigates", async () => {
  const harness = createHarness();
  await dispatch(harness, { channel: "chat", method: "chat.send", text: "Question" });
  await settle();

  harness.dirtyListeners[0]({
    tabId: 4,
    documentId: null,
    revision: Number.MAX_SAFE_INTEGER,
  });
  await settle();

  const state = await harness.controller.getState();
  assert.equal(state.messages[0].context.stale, true);
  assert.equal(state.messages[1].stale, true);
});

test("chat controller restores a streaming message as stopped after worker restart", async () => {
  const onMessage = createEvent();
  const saved = {
    messages: [{ id: "a", role: "assistant", text: "Partial", status: "streaming" }],
    model: null,
    generating: true,
    requestId: "old",
    error: null,
  };
  const controller = installChatController({
    runtime: { id: "extension", onMessage, async sendMessage() {} },
    storage: { async get() { return { "browsefriend.chat.session": saved }; }, async set() {} },
    companion: {},
    pageReader: { onDirty() {} },
    randomUUID: () => "id",
  });

  const state = await controller.getState();
  assert.equal(state.generating, false);
  assert.equal(state.messages[0].status, "stopped");
});

test("clearing a chat prevents a cancelled generation from restoring old messages", async () => {
  let rejectStream;
  const harness = createHarness({
    streamRequest() {
      return new Promise((_resolve, reject) => {
        rejectStream = reject;
      });
    },
  });

  await dispatch(harness, { channel: "chat", method: "chat.send", text: "Question" });
  await settle();
  assert.equal(typeof rejectStream, "function");

  await dispatch(harness, { channel: "chat", method: "chat.clear" });
  rejectStream({ code: "cancelled", message: "Cancelled.", retryable: false });
  await settle();

  const state = await harness.controller.getState();
  assert.deepEqual(state.messages, []);
  const stateBroadcasts = harness.broadcasts.filter((message) => message.event === "state");
  assert.deepEqual(stateBroadcasts.at(-1).state.messages, []);
});
