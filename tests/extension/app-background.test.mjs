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
  compactRequest,
  modelListError,
  modelPreference,
  modelPreferenceGate,
  models,
  reasoningPreference,
  pageCapture,
  pageActorCancelFile,
  pageActorExecute,
  pageActorPrepare,
  signInRequest,
  storedSession,
  streamRequest,
} = {}) {
  const stored = storedSession
    ? { "browsefriend.chat.session": structuredClone(storedSession) }
    : {};
  const settingsStored = {
    ...(modelPreference ? { "browsefriend.settings.model": modelPreference } : {}),
    ...(reasoningPreference
      ? { "browsefriend.settings.reasoningEffort": reasoningPreference }
      : {}),
  };
  const broadcasts = [];
  const companionCalls = [];
  const companionListeners = [];
  const dirtyListeners = [];
  const fileListeners = [];
  const fileCancellations = [];
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
      if (method === "model.compact") {
        if (compactRequest) return compactRequest({ params, explicitId });
        return {
          result: {
            contextHandle: "native-context-1",
            contextBytes: 240,
          },
        };
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
    async captureAfterNavigation() {
      return this.capture();
    },
    onDirty(listener) { dirtyListeners.push(listener); },
  };
  const pageActor = {
    async prepare(call, context) {
      if (pageActorPrepare) return pageActorPrepare(call, context);
      return { tool: call.name, kind: "click", target: "Fixture control", requiresConfirmation: false };
    },
    async execute(call, context) {
      if (pageActorExecute) return pageActorExecute(call, context);
      return { tool: call.name, kind: "click", target: "Fixture control", executed: true };
    },
    async cancelFile(context) {
      fileCancellations.push(structuredClone(context));
      if (pageActorCancelFile) return pageActorCancelFile(context);
      return { cancelled: true };
    },
    onFileSelection(listener) { fileListeners.push(listener); },
  };
  const controller = installAppController({
    runtime,
    storage,
    settingsStorage,
    companion,
    pageActor,
    pageReader,
    randomUUID: () => `generated-${nextId++}`,
  });
  return {
    broadcasts,
    companionCalls,
    companionListeners,
    controller,
    dirtyListeners,
    fileCancellations,
    fileListeners,
    get captureCount() { return captureCount; },
    onMessage,
    runtime,
    settingsStored,
    signedIn,
    storage,
  };
}

function largeStoredSession(exchangeCount = 10) {
  const messages = [];
  for (let index = 1; index <= exchangeCount; index += 1) {
    messages.push({
      id: `user-${index}`,
      role: "user",
      text: `Question ${index} ${"q".repeat(17_000)}`,
      createdAt: index * 2,
    });
    messages.push({
      id: `assistant-${index}`,
      role: "assistant",
      text: `Answer ${index} ${"a".repeat(17_000)}`,
      status: "complete",
      createdAt: index * 2 + 1,
      actions: [{
        id: `action-${index}`,
        kind: "click",
        target: `Control ${index}`,
        status: "complete",
      }],
    });
  }
  return {
    messages,
    model: { slug: "model-1", displayName: "Model One" },
    compaction: null,
    historyTruncated: false,
    submission: null,
    mode: "ask",
    authorization: null,
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

test("large transcripts compact older prose and keep actions only on the latest eight exchanges", async () => {
  const harness = createHarness({ storedSession: largeStoredSession() });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Next question");
  await settle();

  const compact = harness.companionCalls.find((call) => call.method === "model.compact");
  const stream = harness.companionCalls.find((call) => call.method === "model.stream");
  assert.equal(compact.explicitId, "submission-1");
  assert.equal(compact.params.history.length, 4);
  assert.match(compact.params.history[0].content, /Question 1/);
  assert.match(compact.params.history[3].content, /Answer 2/);
  assert.doesNotMatch(JSON.stringify(compact.params.history), /Control [12]/);

  assert.equal(stream.params.contextHandle, "native-context-1");
  assert.equal(Object.hasOwn(stream.params, "compactedContext"), false);
  assert.equal(stream.params.history.length, 16);
  const recent = JSON.stringify(stream.params.history);
  assert.doesNotMatch(recent, /Control [12](?:\D|$)/);
  assert.match(recent, /Control 3/);
  assert.match(recent, /Control 10/);
  assert.doesNotMatch(recent, /Page 1/);

  const saved = (await harness.storage.get("browsefriend.chat.session"))["browsefriend.chat.session"];
  assert.equal(saved.compaction.model, "model-1");
  assert.equal(saved.compaction.throughAssistantId, "assistant-2");

  await harness.controller.clear();
  const cleared = (await harness.storage.get("browsefriend.chat.session"))["browsefriend.chat.session"];
  assert.equal(cleared.compaction, null);
});

test("unsupported compaction falls back to bounded raw history", async () => {
  const harness = createHarness({
    storedSession: largeStoredSession(),
    compactRequest() {
      throw { code: "unsupported_method", message: "Not available.", status: 404 };
    },
  });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Next question");
  await settle();

  const stream = harness.companionCalls.find((call) => call.method === "model.stream");
  assert.equal(Object.hasOwn(stream.params, "compactedContext"), false);
  assert.equal(stream.params.history.length, 20);
  assert.match(stream.params.history[0].content, /Question 1/);
  assert.doesNotMatch(JSON.stringify(stream.params.history), /Control [12](?:\D|$)/);
});

test("short transcripts still respect the native history item limit", async () => {
  const storedSession = largeStoredSession(101);
  for (const message of storedSession.messages) {
    message.text = message.text.slice(0, 30);
    message.actions = [];
  }
  const harness = createHarness({ storedSession });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Next question");
  await settle();

  const stream = harness.companionCalls.find((call) => call.method === "model.stream");
  assert.equal(stream.params.history.length, 200);
  assert.match(stream.params.history[0].content, /Question 2/);
  assert.match(stream.params.history.at(-1).content, /Answer 101/);
});

test("Stop during transcript compaction cancels the request and prevents streaming", async () => {
  const compaction = deferred();
  const harness = createHarness({
    storedSession: largeStoredSession(),
    compactRequest() { return compaction.promise; },
  });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Next question");
  await settle();

  const stopped = await harness.controller.stop("submission-1");
  assert.equal(stopped.draft, "Next question");
  compaction.reject({ code: "cancelled", message: "Cancelled." });
  await settle();

  assert.equal(harness.companionCalls.some((call) => call.method === "model.cancel"), true);
  assert.equal(harness.companionCalls.some((call) => call.method === "model.stream"), false);
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

test("reasoning effort defaults to the model and resets unsupported explicit choices", async () => {
  const models = [{
    slug: "model-1",
    displayName: "Model One",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["minimal", "low", "high"],
  }];
  const harness = createHarness({ models });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Default");
  await settle();
  let streams = harness.companionCalls.filter((call) => call.method === "model.stream");
  assert.equal(Object.hasOwn(streams.at(-1).params, "reasoningEffort"), false);
  assert.equal(harness.settingsStored["browsefriend.settings.reasoningEffort"], "model_default");

  harness.settingsStored["browsefriend.settings.reasoningEffort"] = "high";
  await harness.controller.submit("submission-2", "Explicit");
  await settle();
  streams = harness.companionCalls.filter((call) => call.method === "model.stream");
  assert.equal(streams.at(-1).params.reasoningEffort, "high");

  harness.settingsStored["browsefriend.settings.reasoningEffort"] = "max";
  await harness.controller.submit("submission-3", "Unsupported");
  await settle();
  streams = harness.companionCalls.filter((call) => call.method === "model.stream");
  assert.equal(Object.hasOwn(streams.at(-1).params, "reasoningEffort"), false);
  assert.equal(harness.settingsStored["browsefriend.settings.reasoningEffort"], "model_default");
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

test("Act mode executes one tool at a time and continues with fresh page context", async () => {
  let streams = 0;
  const executed = [];
  const harness = createHarness({
    streamRequest({ onEvent, explicitId }) {
      streams += 1;
      if (streams === 1) {
        return { result: { toolCall: { callId: "call-1", name: "page_click", arguments: '{"ref":"e1"}' } } };
      }
      onEvent({ event: "model.delta", requestId: explicitId, delta: "Done" });
      return { result: { completed: true } };
    },
    pageActorExecute(call, context) {
      executed.push({ call, context });
      return { kind: "click", target: "Fixture control", executed: true };
    },
  });
  await harness.controller.ensureReady();
  await harness.controller.setMode("act");
  await harness.controller.submit("submission-1", "Open the control");
  await settle();
  await settle();

  const state = await harness.controller.getState();
  assert.equal(state.mode, "act");
  assert.equal(state.submission, null);
  assert.equal(state.messages[1].text, "Done");
  assert.equal(state.messages[1].actions[0].status, "complete");
  assert.equal(executed.length, 1);
  const modelCalls = harness.companionCalls.filter((call) => call.method === "model.stream");
  assert.equal(modelCalls.length, 2);
  assert.match(modelCalls[1].params.pageContext, /Page 3/);
  assert.equal(modelCalls[1].params.continuation.callId, "call-1");
});

test("an Act task owns cross-origin navigation until the model finishes", async () => {
  let streams = 0;
  let publishDirty;
  const executed = [];
  const harness = createHarness({
    pageCapture(count) {
      const destination = count >= 3;
      return {
        available: true,
        tabId: 4,
        snapshot: {
          version: 1,
          documentId: destination ? "doc-huggingface" : "doc-start",
          revision: count,
          title: destination ? "Models" : "Start",
          url: destination
            ? "https://huggingface.co/models?search=granite"
            : "https://example.test/",
          records: [],
        },
      };
    },
    streamRequest({ onEvent, explicitId }) {
      streams += 1;
      if (streams === 1) {
        return {
          result: {
            toolCall: {
              callId: "call-nav",
              name: "page_navigate",
              arguments: '{"url":"https://huggingface.co/models?search=granite"}',
            },
          },
        };
      }
      onEvent({
        event: "model.delta",
        requestId: explicitId,
        delta: "I found several matching downloads; choose one.",
      });
      return { result: { completed: true } };
    },
    pageActorPrepare(call) {
      return {
        tool: call.name,
        kind: "navigation",
        target: "huggingface.co/models",
        destination: "https://huggingface.co",
        requiresConfirmation: false,
      };
    },
    pageActorExecute(call) {
      executed.push(call);
      publishDirty({
        tabId: 4,
        documentId: null,
        revision: Number.MAX_SAFE_INTEGER,
        url: "https://huggingface.co/models?search=granite",
      });
      return {
        tool: call.name,
        kind: "navigation",
        target: "huggingface.co/models",
        destination: "https://huggingface.co",
        executed: true,
      };
    },
  });
  publishDirty = harness.dirtyListeners[0];
  await harness.controller.ensureReady();
  await harness.controller.setMode("act");
  await harness.controller.submit("submission-1", "Find the Granite download");
  await settle();
  await settle();

  const state = await harness.controller.getState();
  assert.equal(executed.length, 1);
  assert.equal(state.submission, null);
  assert.equal(state.mode, "ask");
  assert.equal(state.authorization, null);
  assert.equal(state.messages[1].status, "complete");
  assert.equal(state.messages[1].stale, false);
  assert.match(state.messages[1].text, /several matching downloads/);
  assert.equal(state.messages[1].actions[0].kind, "navigation");
  assert.equal(state.messages[1].actions[0].status, "complete");
});

test("manual navigation stops an active response with an explicit explanation", async () => {
  const response = deferred();
  const harness = createHarness({
    streamRequest() { return response.promise; },
  });
  await harness.controller.ensureReady();
  await harness.controller.submit("submission-1", "Summarize this page");
  await settle();

  harness.dirtyListeners[0]({
    tabId: 4,
    documentId: null,
    revision: Number.MAX_SAFE_INTEGER,
    url: "https://elsewhere.test/",
  });
  await settle();

  const state = await harness.controller.getState();
  assert.equal(state.submission, null);
  assert.equal(state.messages[1].status, "error");
  assert.equal(state.messages[1].error.code, "user_navigated");
  assert.equal(state.messages[1].error.message, "Stopped because you navigated away.");
  assert.equal(harness.companionCalls.some((call) => call.method === "model.cancel"), true);
  response.resolve({ result: { completed: true } });
});

test("consequential Act actions pause for confirmation", async () => {
  let streams = 0;
  let executions = 0;
  const harness = createHarness({
    streamRequest({ onEvent, explicitId }) {
      streams += 1;
      if (streams === 1) {
        return { result: { toolCall: { callId: "call-1", name: "page_submit", arguments: '{"ref":"e1"}' } } };
      }
      onEvent({ event: "model.delta", requestId: explicitId, delta: "Submitted" });
      return { result: { completed: true } };
    },
    pageActorPrepare(call) {
      return { tool: call.name, kind: "submit", target: "Send", requiresConfirmation: true };
    },
    pageActorExecute() {
      executions += 1;
      return { kind: "submit", target: "Send", executed: true };
    },
  });
  await harness.controller.ensureReady();
  await harness.controller.setMode("act");
  await harness.controller.submit("submission-1", "Submit it");
  await settle();

  let state = await harness.controller.getState();
  assert.equal(state.submission.phase, "waiting_confirmation");
  assert.equal(executions, 0);
  const actionId = state.submission.pendingAction.id;
  await harness.controller.resolveAction(actionId, true);
  await settle();
  await settle();

  state = await harness.controller.getState();
  assert.equal(executions, 1);
  assert.equal(state.submission, null);
  assert.equal(state.messages[1].text, "Submitted");
});

test("file selection pauses for the user and resumes without exposing file names", async () => {
  let streams = 0;
  const harness = createHarness({
    streamRequest({ onEvent, explicitId }) {
      streams += 1;
      if (streams === 1) {
        return { result: { toolCall: { callId: "call-file", name: "page_choose_file", arguments: '{"ref":"e2"}' } } };
      }
      onEvent({ event: "model.delta", requestId: explicitId, delta: "Attached" });
      return { result: { completed: true } };
    },
    pageActorPrepare(call) {
      return { tool: call.name, kind: "file", target: "Photo", requiresConfirmation: false, waitingForUser: true };
    },
    pageActorExecute() {
      return { kind: "file", target: "Photo", waitingForUser: true };
    },
  });
  await harness.controller.ensureReady();
  await harness.controller.setMode("act");
  await harness.controller.submit("submission-1", "Attach a photo");
  await settle();

  let state = await harness.controller.getState();
  assert.equal(state.submission.phase, "waiting_file");
  harness.fileListeners[0]({
    tabId: 4,
    documentId: state.submission.pendingAction.context.documentId,
    revision: state.submission.pendingAction.context.revision,
    ref: "e2",
    cancelled: false,
    count: 1,
  });
  await settle();
  await settle();

  state = await harness.controller.getState();
  assert.equal(state.submission, null);
  assert.equal(state.messages[1].text, "Attached");
  const continuation = harness.companionCalls.filter((call) => call.method === "model.stream").at(-1).params.continuation;
  assert.match(continuation.output, /1 file/);
  assert.doesNotMatch(continuation.output, /\.png|photo-name/);
});

test("cancelling a file handoff clears the page target and ends the task", async () => {
  const harness = createHarness({
    streamRequest() {
      return { result: { toolCall: { callId: "call-file", name: "page_choose_file", arguments: '{"ref":"e2"}' } } };
    },
    pageActorPrepare(call) {
      return { tool: call.name, kind: "file", target: "Photo", requiresConfirmation: false, waitingForUser: true };
    },
    pageActorExecute() {
      return { kind: "file", target: "Photo", waitingForUser: true };
    },
  });
  await harness.controller.ensureReady();
  await harness.controller.setMode("act");
  await harness.controller.submit("submission-1", "Attach a photo");
  await settle();

  let state = await harness.controller.getState();
  const actionId = state.submission.pendingAction.id;
  const documentId = state.submission.pendingAction.context.documentId;
  await harness.controller.resolveAction(actionId, false);
  await settle();

  state = await harness.controller.getState();
  assert.equal(state.submission, null);
  assert.equal(state.messages[1].status, "stopped");
  assert.equal(state.messages[1].actions[0].status, "cancelled");
  assert.equal(harness.fileCancellations.length, 1);
  assert.equal(harness.fileCancellations[0].documentId, documentId);
});

test("switching tabs clears the single global Act authorization permanently", async () => {
  const harness = createHarness();
  await harness.controller.ensureReady();
  let state = await harness.controller.setMode("act");
  assert.equal(state.mode, "act");

  harness.dirtyListeners[0]({
    tabId: 9,
    activated: true,
    documentId: null,
    revision: Number.MAX_SAFE_INTEGER,
  });
  await settle();
  state = await harness.controller.getState();
  assert.equal(state.mode, "ask");

  harness.dirtyListeners[0]({
    tabId: 4,
    activated: true,
    documentId: null,
    revision: Number.MAX_SAFE_INTEGER,
  });
  await settle();
  assert.equal((await harness.controller.getState()).mode, "ask");
});

test("a stale prepared target recaptures and lets the model replan without execution", async () => {
  let streams = 0;
  let preparations = 0;
  let executions = 0;
  const harness = createHarness({
    streamRequest({ onEvent, explicitId }) {
      streams += 1;
      if (streams === 1) {
        return { result: { toolCall: { callId: "call-stale", name: "page_click", arguments: '{"ref":"e1"}' } } };
      }
      onEvent({ event: "model.delta", requestId: explicitId, delta: "Replanned" });
      return { result: { completed: true } };
    },
    pageActorPrepare() {
      preparations += 1;
      throw { code: "stale_page", message: "Changed", retryable: true };
    },
    pageActorExecute() { executions += 1; },
  });
  await harness.controller.ensureReady();
  await harness.controller.setMode("act");
  await harness.controller.submit("submission-1", "Open the dynamic choice");
  await settle();
  await settle();

  const state = await harness.controller.getState();
  assert.equal(preparations, 1);
  assert.equal(executions, 0);
  assert.equal(state.messages[1].text, "Replanned");
  assert.match(
    harness.companionCalls.filter((call) => call.method === "model.stream").at(-1).params.continuation.output,
    /stale_page/,
  );
});

test("same-revision repeated actions stop without offering an unsafe retry", async () => {
  const fixedPage = {
    available: true,
    tabId: 4,
    snapshot: {
      version: 1,
      documentId: "fixed-doc",
      revision: 1,
      title: "Fixture page",
      url: "https://example.test/",
      records: [],
    },
  };
  let calls = 0;
  const harness = createHarness({
    pageCapture: () => fixedPage,
    streamRequest() {
      calls += 1;
      return {
        result: {
          toolCall: {
            callId: `call-${calls}`,
            name: "page_click",
            arguments: '{"ref":"e1"}',
          },
        },
      };
    },
  });
  await harness.controller.ensureReady();
  await harness.controller.setMode("act");
  await harness.controller.submit("submission-1", "Keep clicking");
  await settle();
  await settle();

  const state = await harness.controller.getState();
  assert.equal(state.submission, null);
  assert.equal(state.issue.error.code, "action_loop_detected");
  assert.equal(state.issue.retry, null);
  assert.equal(state.messages[1].actions.length, 1);
});

for (const ending of ["stop", "decline", "file-cancel", "navigation", "error", "complete"]) {
  test(`Act context cleanup on ${ending} and isolation from the next submission`, async () => {
    let calls = 0;
    const harness = createHarness({
      streamRequest() {
        calls += 1;
        if (calls > 1 || ending === "complete") return { result: { completed: true } };
        return { result: { toolCall: { callId: "private-call", name: "page_click", arguments: '{"ref":"e1"}' } } };
      },
      pageActorPrepare() {
        if (ending === "error") throw { code: "execution_failed", message: "Failed", retryable: false };
        return { kind: ending === "file-cancel" ? "file" : "submit", target: "Control", requiresConfirmation: ending !== "file-cancel" };
      },
      pageActorExecute() { return { kind: "file", waitingForUser: true }; },
    });
    await harness.controller.ensureReady();
    await harness.controller.setMode("act");
    await harness.controller.submit("first-task", "Do something");
    await settle();
    let state = await harness.controller.getState();
    if (ending === "stop") await harness.controller.stop("first-task");
    if (ending === "decline") await harness.controller.resolveAction(state.submission.pendingAction.id, false);
    if (ending === "file-cancel") {
      const pending = state.submission.pendingAction;
      harness.fileListeners[0]({ cancelled: true, tabId: pending.context.tabId, documentId: pending.context.documentId, ref: pending.call.args.ref });
    }
    if (ending === "navigation") harness.dirtyListeners[0]({ tabId: 4, url: "https://elsewhere.test/" });
    await settle();
    state = await harness.controller.getState();
    assert.equal(state.submission, null);
    assert.equal(harness.companionCalls.filter((call) => call.method === "model.cancel" && call.params.requestId === "first-task").length, 1);
    await harness.controller.submit("next-task", "Another question");
    await settle();
    const next = harness.companionCalls.find((call) => call.method === "model.stream" && call.explicitId === "next-task");
    assert.equal(next.params.continuation, undefined);
    assert.deepEqual(next.params.actionHistory, []);
  });
}

for (const code of ["act_context_lost", "act_context_limit"]) {
  test(`${code} uses the shared error surface and requires a fresh task`, async () => {
    const harness = createHarness({
      streamRequest() { throw { code, message: "Start another prompt.", retryable: false }; },
    });
    await harness.controller.ensureReady();
    await harness.controller.setMode("act");
    await harness.controller.submit("task", "Inspect the page");
    await settle();
    const state = await harness.controller.getState();
    assert.equal(state.submission, null);
    assert.equal(state.messages.at(-1).error.code, code);
    assert.equal(state.issue.scope, "generation");
    assert.equal(state.issue.retry, null);
    assert.equal(harness.companionCalls.some((call) => call.method === "model.cancel" && call.params.requestId === "task"), true);
  });
}

function compactedStoredSession() {
  const saved = largeStoredSession();
  saved.conversationId = "restored-conversation";
  saved.compaction = { model: "model-1", handle: "retained-handle", bytes: 64,
    throughAssistantId: "assistant-2", throughCreatedAt: 5 };
  return saved;
}

test("restored native context uses a handle and recovers an expired handle once from bounded prose", async () => {
  for (const repeatFailure of [false, true]) {
    let attempts = 0;
    const harness = createHarness({ storedSession: compactedStoredSession(),
      streamRequest({ params, onEvent }) {
        attempts += 1;
        if (attempts === 1 || repeatFailure) throw { code: "model_context_lost", message: "Expired", retryable: true };
        assert.equal(Object.hasOwn(params, "contextHandle"), false);
        assert.match(params.history[0].content, /Question 1/);
        onEvent({ delta: "Recovered" });
        return { result: { completed: true } };
      },
    });
    await harness.controller.ensureReady();
    await harness.controller.submit("task", "Next question");
    await settle();
    const streams = harness.companionCalls.filter((call) => call.method === "model.stream");
    assert.equal(streams.length, 2);
    assert.equal(streams[0].params.contextHandle, "retained-handle");
    assert.equal(streams[0].params.conversationId, "restored-conversation");
    const saved = (await harness.storage.get("browsefriend.chat.session"))["browsefriend.chat.session"];
    assert.equal(saved.compaction, null);
    assert.equal(saved.messages.at(-1).status, repeatFailure ? "error" : "complete");
  }
});

test("compaction failure retains the previous valid handle and byte accounting", async () => {
  const storedSession = compactedStoredSession();
  storedSession.compaction.throughAssistantId = "assistant-1";
  storedSession.compaction.throughCreatedAt = 3;
  const harness = createHarness({ storedSession,
    compactRequest() { throw { code: "unsupported_method", status: 404 }; },
  });
  await harness.controller.ensureReady();
  await harness.controller.submit("task", "Next");
  await settle();
  const compact = harness.companionCalls.find((call) => call.method === "model.compact");
  assert.equal(compact.params.contextHandle, "retained-handle");
  const stream = harness.companionCalls.find((call) => call.method === "model.stream");
  assert.equal(stream.params.contextHandle, "retained-handle");
  const saved = (await harness.storage.get("browsefriend.chat.session"))["browsefriend.chat.session"];
  assert.equal(saved.compaction.handle, "retained-handle");
  assert.equal(saved.compaction.bytes, 64);
  assert.equal(Object.hasOwn(saved.compaction, "context"), false);
});

test("native context bytes reserve history capacity without a browser payload", async () => {
  const storedSession = compactedStoredSession();
  storedSession.compaction.bytes = 320 * 1024;
  const harness = createHarness({ storedSession });
  await harness.controller.ensureReady();
  await harness.controller.submit("task", "Next");
  await settle();
  const stream = harness.companionCalls.find((call) => call.method === "model.stream");
  assert.ok(stream.params.history.length < 16);
  const total = stream.params.history.reduce((bytes, message) => bytes + new TextEncoder().encode(message.content).length, storedSession.compaction.bytes);
  assert.ok(total <= 480 * 1024);
  assert.doesNotMatch(JSON.stringify(stream.params), /compactedContext|encrypted_content/);
});

test("New chat clears only its previous native conversation and ignores late compaction", async () => {
  const compact = deferred();
  const harness = createHarness({ storedSession: largeStoredSession(), compactRequest: () => compact.promise });
  await harness.controller.ensureReady();
  await harness.controller.submit("old-task", "Old question");
  await settle();
  const oldId = harness.companionCalls.find((call) => call.method === "model.compact").params.conversationId;
  await harness.controller.clear();
  await harness.controller.submit("new-task", "New question");
  await settle();
  compact.resolve({ result: { contextHandle: "late-handle", contextBytes: 100 } });
  await settle();
  const saved = (await harness.storage.get("browsefriend.chat.session"))["browsefriend.chat.session"];
  assert.notEqual(saved.conversationId, oldId);
  assert.equal(saved.compaction, null);
  assert.equal(saved.messages[0].text, "New question");
  assert.ok(harness.companionCalls.some((call) => call.method === "model.context.clear" && call.params.conversationId === oldId));
});

test("effective model changes release native compaction without clearing the visible transcript", async () => {
  const harness = createHarness({ storedSession: compactedStoredSession(), models: [{ slug: "model-1" }, { slug: "model-2" }],
    compactRequest() { throw { code: "unsupported_method" }; },
  });
  await harness.controller.ensureReady();
  harness.settingsStored["browsefriend.settings.model"] = "model-2";
  await harness.controller.submit("task", "Next");
  await settle();
  const stream = harness.companionCalls.find((call) => call.method === "model.stream");
  assert.equal(stream.params.model, "model-2");
  assert.equal(Object.hasOwn(stream.params, "contextHandle"), false);
  assert.match(stream.params.history[0].content, /Question 1/);
  assert.ok(harness.companionCalls.some((call) => call.method === "model.context.clear" && call.params.conversationId === "restored-conversation"));
  assert.equal((await harness.controller.getState()).messages.length, 22);
});

test("authentication and companion loss discard browser context metadata", async () => {
  for (const event of [{ type: "auth.changed", state: { state: "signed_out" } },
    { type: "disconnected", error: { code: "companion_unavailable", message: "Gone" } }]) {
    const harness = createHarness({ storedSession: compactedStoredSession() });
    await harness.controller.ensureReady();
    harness.companionListeners.forEach((listener) => listener(event));
    await settle();
    const saved = (await harness.storage.get("browsefriend.chat.session"))["browsefriend.chat.session"];
    assert.equal(saved.compaction, null);
    assert.equal(saved.messages.length, 20);
  }
});

test("Act continuations send no transcript handle and never retry executed actions on context loss", async () => {
  let calls = 0;
  let executions = 0;
  const harness = createHarness({ storedSession: compactedStoredSession(),
    streamRequest({ params }) {
      calls += 1;
      if (calls === 1) {
        assert.equal(params.contextHandle, "retained-handle");
        return { result: { toolCall: { callId: "call-1", name: "page_click", arguments: '{"ref":"e1"}' } } };
      }
      assert.deepEqual(params.history, []);
      assert.equal(Object.hasOwn(params, "contextHandle"), false);
      throw { code: "model_context_lost", message: "Expired", retryable: true };
    },
    pageActorExecute() { executions += 1; return { kind: "click", target: "Control", executed: true }; },
  });
  await harness.controller.ensureReady();
  await harness.controller.setMode("act");
  await harness.controller.submit("task", "Click");
  await settle();
  await settle();
  assert.equal(calls, 2);
  assert.equal(executions, 1);
  assert.equal((await harness.controller.getState()).messages.at(-1).status, "error");
});

test("Stop during model preparation prevents a late compaction request", async () => {
  const gate = deferred();
  const harness = createHarness({ storedSession: largeStoredSession(), modelPreferenceGate: gate });
  await harness.controller.ensureReady();
  await harness.controller.submit("task", "Next");
  await settle();
  await harness.controller.stop("task");
  gate.resolve({});
  await settle();
  assert.equal(harness.companionCalls.some((call) => ["model.compact", "model.stream"].includes(call.method)), false);
});

test("an expired handle during incremental compaction falls back before the first stream", async () => {
  const storedSession = compactedStoredSession();
  storedSession.compaction.throughAssistantId = "assistant-1";
  storedSession.compaction.throughCreatedAt = 3;
  const harness = createHarness({ storedSession,
    compactRequest() { throw { code: "model_context_lost", message: "Expired" }; },
  });
  await harness.controller.ensureReady();
  await harness.controller.submit("task", "Next");
  await settle();
  const streams = harness.companionCalls.filter((call) => call.method === "model.stream");
  assert.equal(streams.length, 1);
  assert.equal(Object.hasOwn(streams[0].params, "contextHandle"), false);
  assert.match(streams[0].params.history[0].content, /Question 1/);
  assert.equal((await harness.storage.get("browsefriend.chat.session"))["browsefriend.chat.session"].compaction, null);
});
