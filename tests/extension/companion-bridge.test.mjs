import assert from "node:assert/strict";
import test from "node:test";
import { installCompanionBridge } from "../../extension/companion/background-bridge.js";

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map((listener) => listener(...args)); },
  };
}

function createHarness({ postMessageError = null } = {}) {
  const posted = [];
  const nativeMessages = createEvent();
  const nativeDisconnect = createEvent();
  const timers = new Map();
  let nextTimerId = 1;
  const port = {
    onMessage: nativeMessages,
    onDisconnect: nativeDisconnect,
    postMessage(message) {
      if (postMessageError) throw postMessageError;
      posted.push(message);
    },
  };
  const runtime = {
    lastError: undefined,
    connectNative(name) {
      assert.equal(name, "com.browsefriend.native_host");
      return port;
    },
  };
  const companion = installCompanionBridge({
    runtime,
    randomUUID: () => `request-${posted.length + 1}`,
    setTimer(callback, delay) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, {
        callback() {
          timers.delete(id);
          callback();
        },
        delay,
      });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
  });
  return { companion, nativeDisconnect, nativeMessages, posted, runtime, timers };
}

test("companion requests correlate native responses", async () => {
  const harness = createHarness();
  const pending = harness.companion.request("auth.status");
  assert.deepEqual(harness.posted, [{ id: "request-1", method: "auth.status" }]);

  harness.nativeMessages.emit({
    id: "request-1",
    ok: true,
    result: { state: "signed_out", profile: null, planUsageEnabled: false },
  });
  assert.equal((await pending).ok, true);
});

test("companion subscriptions receive authentication and disconnect events", async () => {
  const harness = createHarness();
  const events = [];
  harness.companion.subscribe((event) => events.push(event));
  const pending = harness.companion.request("auth.status");
  const state = { state: "signed_in", profile: { name: "Person" }, planUsageEnabled: true };

  harness.nativeMessages.emit({ event: "auth.changed", payload: state });
  harness.runtime.lastError = { message: "Host stopped." };
  harness.nativeDisconnect.emit();

  await assert.rejects(pending, { code: "companion_unavailable" });
  assert.deepEqual(events, [
    { type: "auth.changed", state },
    {
      type: "disconnected",
      error: {
        code: "companion_unavailable",
        message: "Host stopped.",
        retryable: true,
      },
    },
  ]);
});

test("companion bridge returns a retryable timeout and forgets the request", async () => {
  const harness = createHarness();
  const pending = harness.companion.request("auth.status");
  const [timer] = harness.timers.values();
  assert.equal(timer.delay, 30_000);
  timer.callback();

  await assert.rejects(pending, { code: "companion_timeout" });
  harness.nativeMessages.emit({ id: "request-1", ok: true, result: { state: "signed_in" } });
  assert.equal(harness.timers.size, 0);
});

test("interactive sign-in receives a longer companion timeout", async () => {
  const harness = createHarness();
  const pending = harness.companion.request("auth.signIn");
  const [timer] = harness.timers.values();
  assert.equal(timer.delay, 11 * 60 * 1000);

  harness.nativeDisconnect.emit();
  await assert.rejects(pending);
  assert.equal(harness.timers.size, 0);
});

test("synchronous native-port failures return a safe companion error", async () => {
  const harness = createHarness({ postMessageError: new Error("Port closed.") });
  await assert.rejects(harness.companion.request("auth.status"), {
    code: "companion_unavailable",
    message: "Port closed.",
  });
  assert.equal(harness.timers.size, 0);
});

test("companion bridge routes model deltas to the matching request", async () => {
  const harness = createHarness();
  const deltas = [];
  const pending = harness.companion.request(
    "model.stream",
    { prompt: "Question" },
    (event) => deltas.push(event.delta),
    "generation-1",
  );
  const [timer] = harness.timers.values();
  assert.equal(timer.delay, 190_000);

  harness.nativeMessages.emit({
    event: "model.delta",
    requestId: "generation-1",
    delta: "Partial",
  });
  harness.nativeMessages.emit({
    id: "generation-1",
    ok: true,
    result: { completed: true },
  });

  assert.deepEqual(deltas, ["Partial"]);
  assert.equal((await pending).ok, true);
});

test("a timed-out model stream asks the companion to cancel its generation", async () => {
  const harness = createHarness();
  const pending = harness.companion.request(
    "model.stream",
    { prompt: "Question" },
    undefined,
    "generation-1",
  );
  const [timer] = harness.timers.values();
  timer.callback();

  await assert.rejects(pending, { code: "companion_timeout" });
  assert.deepEqual(harness.posted[1], {
    id: "request-2",
    method: "model.cancel",
    params: { requestId: "generation-1" },
  });
});

test("transcript compaction uses the generation deadline and cancels on timeout", async () => {
  const harness = createHarness();
  const pending = harness.companion.request(
    "model.compact",
    { history: [] },
    undefined,
    "generation-1",
  );
  const [timer] = harness.timers.values();
  assert.equal(timer.delay, 190_000);
  timer.callback();

  await assert.rejects(pending, { code: "companion_timeout" });
  assert.deepEqual(harness.posted[1], {
    id: "request-2",
    method: "model.cancel",
    params: { requestId: "generation-1" },
  });
});
