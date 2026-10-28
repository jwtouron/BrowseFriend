import assert from "node:assert/strict";
import test from "node:test";
import { installAppController } from "../../extension/app/background.js";

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map((listener) => listener(...args)); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function createHarness({
  authStatus,
  authStatusRequest,
  modelListError,
  modelPreference,
  modelPreferenceGate,
  models,
  pageCapture,
  signInRequest,
  storedSession,
  streamRequest,
} = {}) {
  const stored = storedSession
    ? { "browsefriend.chat.session": structuredClone(storedSession) }
    : {};
  const settingsStored = modelPreference
    ? { "browsefriend.settings.model": modelPreference }
    : {};
  const broadcasts = [];
  const companionCalls = [];
  const companionListeners = [];
  const dirtyListeners = [];
  const onMessage = createEvent();
  let nextId = 1;
  let captureCount = 0;
  let settingsGetCount = 0;
  const signedIn = {
    state: "signed_in",
    profile: { name: "Person", email: "person@example.com" },
    planUsageEnabled: true,
  };
  const runtime = {
    id: "extension",
    onMessage,
    async sendMessage(message) { broadcasts.push(structuredClone(message)); },
  };
  const storage = {
    async get(key) { return { [key]: structuredClone(stored[key]) }; },
    async set(values) { Object.assign(stored, structuredClone(values)); },
  };
  const settingsStorage = {
    async get(key) {
      settingsGetCount += 1;
      if (modelPreferenceGate && settingsGetCount > 1) return modelPreferenceGate.promise;
      return { [key]: settingsStored[key] };
    },
    async set(values) { Object.assign(settingsStored, structuredClone(values)); },
  };
  const companion = {
    subscribe(listener) {
      companionListeners.push(listener);
      return () => undefined;
    },
    async request(method, params, onEvent, explicitId) {
      companionCalls.push({ method, params: structuredClone(params), explicitId });
      if (method === "auth.status") {
        if (authStatusRequest) return authStatusRequest.promise;
        return { result: authStatus || signedIn };
      }
      if (method === "auth.signIn") {
        if (signInRequest) return signInRequest.promise;
        return { result: signedIn };
      }
      if (method === "auth.cancel") {
        return { result: { state: "signed_out", profile: null, planUsageEnabled: false } };
      }
      if (method === "auth.signOut") {
        return { result: { state: "signed_out", profile: null, planUsageEnabled: false } };
      }
      if (method === "model.list") {
        if (modelListError) throw modelListError;
        return {
          result: {
            models: models || [{ slug: "model-1", displayName: "Model One" }],
          },
        };
      }
      if (method === "model.stream") {
        if (streamRequest) return streamRequest({ params, onEvent, explicitId });
        onEvent({ event: "model.delta", requestId: explicitId, delta: "Answer" });
        return { result: { completed: true } };
      }
      return { result: { cancelled: true } };
    },
  };
  const pageReader = {
    async capture() {
      captureCount += 1;
      if (pageCapture) return pageCapture(captureCount);
      return {
        available: true,
        tabId: 4,
        snapshot: {
          version: 1,
          documentId: `doc-${captureCount}`,
          revision: captureCount,
          title: "Fixture page",
          url: "https://example.test/",
          records: [{ type: "text", text: `Page ${captureCount}` }],
        },
      };
    },
    onDirty(listener) { dirtyListeners.push(listener); },
  };
  const controller = installAppController({
    runtime,
    storage,
    settingsStorage,
    companion,
    pageReader,
    randomUUID: () => `generated-${nextId++}`,
  });
  return {
    broadcasts,
    companionCalls,
    companionListeners,
    controller,
    dirtyListeners,
    get captureCount() { return captureCount; },
    onMessage,
    runtime,
    settingsStored,
    signedIn,
    storage,
  };
}

test("readiness loads the saved session and model catalog before becoming ready", async () => {
  const harness = createHarness();
  const before = await harness.controller.getState();
  assert.equal(before.connection.phase, "checking");

  const ready = await harness.controller.ensureReady();
  assert.equal(ready.connection.phase, "ready");
  assert.equal(ready.connection.auth.state, "signed_in");
  assert.deepEqual(ready.models, [{ slug: "model-1", displayName: "Model One" }]);
  assert.deepEqual(
    harness.companionCalls.map((call) => call.method),
    ["auth.status", "model.list"],
  );
});

test("a queued prompt survives sign-in and sends automatically after readiness", async () => {
  const harness = createHarness({
    authStatus: { state: "signed_out", profile: null, planUsageEnabled: false },
  });
  let state = await harness.controller.ensureReady();
  assert.equal(state.connection.phase, "auth_required");

  state = await harness.controller.submit("submission-1", "Question");
  assert.equal(state.submission.phase, "queued");
  await harness.controller.signIn();
  await settle();

  state = await harness.controller.getState();
  assert.equal(state.connection.phase, "ready");
  assert.equal(state.submission, null);
  assert.equal(state.messages[0].text, "Question");
  assert.equal(state.messages[1].text, "Answer");
});

test("Stop restores a queued draft without cancelling shared readiness", async () => {
  const status = deferred();
  const harness = createHarness({ authStatusRequest: status });
  const readiness = harness.controller.ensureReady();
  await settle();
  await harness.controller.submit("submission-1", "Waiting question");

  const stopped = await harness.controller.stop("submission-1");
  assert.equal(stopped.draft, "Waiting question");
  assert.equal(stopped.state.submission, null);

  status.resolve({ result: harness.signedIn });
  await readiness;
  await settle();
  const state = await harness.controller.getState();
  assert.equal(state.connection.phase, "ready");
  assert.deepEqual(state.messages, []);
  assert.equal(harness.companionCalls.some((call) => call.method === "model.stream"), false);
});

test("Stop during page capture prevents a late capture from sending", async () => {
  const capture = deferred();
  const harness = createHarness({ pageCapture: () => capture.promise });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Question");
  await settle();

  const stopped = await harness.controller.stop("submission-1");
  assert.equal(stopped.draft, "Question");
  capture.resolve({ available: false, error: { code: "page_unavailable", message: "Gone" } });
  await settle();

  const state = await harness.controller.getState();
  assert.deepEqual(state.messages, []);
  assert.equal(harness.companionCalls.some((call) => call.method === "model.stream"), false);
});

test("Stop during model preparation prevents a model request", async () => {
  const preference = deferred();
  const harness = createHarness({ modelPreferenceGate: preference });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Question");
  await settle();

  const stopped = await harness.controller.stop("submission-1");
  assert.equal(stopped.draft, "Question");
  preference.resolve({ "browsefriend.settings.model": "automatic" });
  await settle();

  assert.equal(harness.companionCalls.some((call) => call.method === "model.stream"), false);
  assert.equal(harness.companionCalls.some((call) => call.method === "model.cancel"), false);
});

test("Stop during streaming preserves the stopped exchange and restores its draft", async () => {
  const stream = deferred();
  const harness = createHarness({
    streamRequest({ onEvent, explicitId }) {
      onEvent({ event: "model.delta", requestId: explicitId, delta: "Partial" });
      return stream.promise;
    },
  });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Question");
  await settle();

  const stopped = await harness.controller.stop("submission-1");
  assert.equal(stopped.draft, "Question");
  assert.equal(stopped.state.messages[0].text, "Question");
  assert.equal(stopped.state.messages[1].text, "Partial");
  assert.equal(stopped.state.messages[1].status, "stopped");

  stream.reject({ code: "cancelled", message: "Cancelled.", retryable: false });
  await settle();
  assert.equal((await harness.controller.getState()).messages[1].status, "stopped");
});

test("Retry replaces a failed response and captures fresh page context", async () => {
  let attempts = 0;
  const harness = createHarness({
    async streamRequest({ onEvent, explicitId }) {
      attempts += 1;
      if (attempts === 1) {
        onEvent({ event: "model.delta", requestId: explicitId, delta: "Partial" });
        throw { code: "network_error", message: "Try again.", retryable: true };
      }
      onEvent({ event: "model.delta", requestId: explicitId, delta: "Replacement" });
      return { result: { completed: true } };
    },
  });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Question");
  await settle();
  let state = await harness.controller.getState();
  const assistantId = state.messages[1].id;
  assert.equal(state.messages[1].status, "error");

  await harness.controller.retry();
  await settle();
  state = await harness.controller.getState();
  assert.equal(state.messages[1].id, assistantId);
  assert.equal(state.messages[1].text, "Replacement");
  assert.equal(state.messages[1].status, "complete");
  assert.equal(state.messages[0].context.revision, 2);
  assert.equal(harness.captureCount, 2);
});

test("completed exchanges become bounded history without old page snapshots", async () => {
  const harness = createHarness();
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "First");
  await settle();
  await harness.controller.submit("submission-2", "Second");
  await settle();

  const streams = harness.companionCalls.filter((call) => call.method === "model.stream");
  assert.deepEqual(streams[0].params.history, []);
  assert.deepEqual(streams[1].params.history, [
    { role: "user", content: "First" },
    { role: "assistant", content: "Answer" },
  ]);
  assert.equal(JSON.stringify(streams[1].params.history).includes("Page 1"), false);
  assert.match(streams[1].params.pageContext, /Page 2/);
});

test("page changes mark the captured exchange stale and New chat clears it", async () => {
  const harness = createHarness();
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Question");
  await settle();

  harness.dirtyListeners[0]({ tabId: 4, documentId: "doc-1", revision: 2 });
  await settle();
  let state = await harness.controller.getState();
  assert.equal(state.messages[0].context.stale, true);
  assert.equal(state.messages[1].stale, true);

  state = await harness.controller.clear();
  assert.deepEqual(state.messages, []);
  assert.equal(state.model.slug, "model-1");
});

test("a restored in-flight response becomes stopped after worker restart", async () => {
  const harness = createHarness({
    storedSession: {
      messages: [
        { id: "user", role: "user", text: "Question" },
        { id: "assistant", role: "assistant", text: "Partial", status: "streaming" },
      ],
      model: null,
      historyTruncated: false,
      submission: {
        id: "old-submission",
        text: "Question",
        userId: "user",
        assistantId: "assistant",
        phase: "streaming",
      },
    },
  });

  const state = await harness.controller.getState();
  assert.equal(state.submission, null);
  assert.equal(state.messages[1].status, "stopped");
});

test("model preferences select explicit models and reset unavailable choices", async () => {
  const models = [
    { slug: "model-1", displayName: "Model One" },
    { slug: "model-2", displayName: "Model Two" },
  ];
  const harness = createHarness({ modelPreference: "model-2", models });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "First");
  await settle();
  assert.equal(
    harness.companionCalls.find((call) => call.method === "model.stream").params.model,
    "model-2",
  );

  harness.settingsStored["browsefriend.settings.model"] = "model-1";
  await harness.controller.submit("submission-2", "Second");
  await settle();
  const streams = harness.companionCalls.filter((call) => call.method === "model.stream");
  assert.equal(streams.at(-1).params.model, "model-1");

  harness.settingsStored["browsefriend.settings.model"] = "missing-model";
  const state = await harness.controller.ensureReady({ force: true });
  assert.equal(state.modelPreference, "automatic");
  assert.equal(harness.settingsStored["browsefriend.settings.model"], "automatic");
});

test("one submission runs at a time and an early Stop cannot be revived", async () => {
  const stream = deferred();
  const harness = createHarness({ streamRequest: () => stream.promise });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "First");
  await settle();
  await assert.rejects(
    harness.controller.submit("submission-2", "Second"),
    (error) => error.code === "model_busy",
  );
  await harness.controller.stop("submission-1");
  stream.reject({ code: "cancelled", message: "Cancelled.", retryable: false });
  await settle();

  await harness.controller.stop("submission-race");
  const state = await harness.controller.submit("submission-race", "Late submit");
  assert.equal(state.submission, null);
  assert.equal(state.messages.some((message) => message.text === "Late submit"), false);
});

test("an auth event cannot replace the result of active readiness work", async () => {
  const status = deferred();
  const harness = createHarness({ authStatusRequest: status });
  const readiness = harness.controller.ensureReady();
  await settle();
  harness.companionListeners[0]({
    type: "auth.changed",
    state: { state: "signed_out", profile: null, planUsageEnabled: false },
  });
  status.resolve({ result: harness.signedIn });

  const state = await readiness;
  assert.equal(state.connection.phase, "ready");
  assert.equal(state.connection.auth.state, "signed_in");
});

test("concurrent readiness and sign-in intents share one operation", async () => {
  const status = deferred();
  const readinessHarness = createHarness({ authStatusRequest: status });
  const firstReadiness = readinessHarness.controller.ensureReady();
  const secondReadiness = readinessHarness.controller.ensureReady();
  await settle();
  assert.equal(
    readinessHarness.companionCalls.filter((call) => call.method === "auth.status").length,
    1,
  );
  status.resolve({ result: readinessHarness.signedIn });
  await Promise.all([firstReadiness, secondReadiness]);

  const signIn = deferred();
  const signInHarness = createHarness({ signInRequest: signIn });
  const firstSignIn = signInHarness.controller.signIn();
  const secondSignIn = signInHarness.controller.signIn();
  await settle();
  assert.equal(
    signInHarness.companionCalls.filter((call) => call.method === "auth.signIn").length,
    1,
  );
  signIn.resolve({ result: signInHarness.signedIn });
  await Promise.all([firstSignIn, secondSignIn]);
});
