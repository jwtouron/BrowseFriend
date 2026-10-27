import assert from "node:assert/strict";
import test from "node:test";
import { installAuthBridge } from "../../extension/auth/background-bridge.js";

const plain = (value) => JSON.parse(JSON.stringify(value));

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      return listeners.map((listener) => listener(...args));
    },
    listeners,
  };
}

function createHarness({ postMessageError = null } = {}) {
  const posted = [];
  const broadcasts = [];
  const nativeMessages = createEvent();
  const nativeDisconnect = createEvent();
  const extensionMessages = createEvent();
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
    id: "browsefriend-test",
    lastError: undefined,
    onMessage: extensionMessages,
    connectNative(name) {
      assert.equal(name, "com.browsefriend.native_host");
      return port;
    },
    async sendMessage(message) {
      broadcasts.push(message);
    },
  };
  installAuthBridge({
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
    clearTimer(id) {
      timers.delete(id);
    },
  });

  return {
    broadcasts,
    extensionMessages,
    nativeDisconnect,
    nativeMessages,
    posted,
    runtime,
    timers,
  };
}

function dispatch(harness, message, senderId = "browsefriend-test") {
  let respond;
  const response = new Promise((resolve) => {
    respond = resolve;
  });
  const [keepChannelOpen] = harness.extensionMessages.emit(message, { id: senderId }, respond);
  return { keepChannelOpen, response };
}

test("auth bridge forwards allowed extension requests and correlates responses", async () => {
  const harness = await createHarness();
  const pending = dispatch(harness, { channel: "auth", method: "auth.status" });

  assert.equal(pending.keepChannelOpen, true);
  assert.deepEqual(plain(harness.posted), [{ id: "request-1", method: "auth.status" }]);

  harness.nativeMessages.emit({
    id: "request-1",
    ok: true,
    result: { state: "signed_out", profile: null, planUsageEnabled: false },
  });

  assert.deepEqual(plain(await pending.response), {
    id: "request-1",
    ok: true,
    result: { state: "signed_out", profile: null, planUsageEnabled: false },
  });
});

test("auth bridge rejects foreign senders and unknown methods", async () => {
  const harness = await createHarness();

  const foreign = dispatch(
    harness,
    { channel: "auth", method: "auth.status" },
    "another-extension",
  );
  const unknown = dispatch(harness, { channel: "auth", method: "auth.readTokens" });

  assert.equal(foreign.keepChannelOpen, false);
  assert.equal(unknown.keepChannelOpen, false);
  assert.deepEqual(harness.posted, []);
});

test("auth bridge broadcasts safe authentication state events", async () => {
  const harness = await createHarness();
  const pending = dispatch(harness, { channel: "auth", method: "auth.status" });
  const state = { state: "signed_in", profile: { name: "Person" }, planUsageEnabled: true };

  harness.nativeMessages.emit({ event: "auth.changed", payload: state });
  harness.nativeMessages.emit({
    id: "request-1",
    ok: true,
    result: { state: "signed_out", profile: null, planUsageEnabled: false },
  });
  await pending.response;
  await Promise.resolve();

  assert.deepEqual(plain(harness.broadcasts), [{
    channel: "auth",
    event: "changed",
    state,
  }]);
});

test("native disconnect rejects pending extension requests", async () => {
  const harness = await createHarness();
  const pending = dispatch(harness, { channel: "auth", method: "auth.status" });
  harness.runtime.lastError = { message: "Specified native messaging host not found." };

  harness.nativeDisconnect.emit();

  assert.deepEqual(plain(await pending.response), {
    ok: false,
    error: {
      code: "companion_unavailable",
      message: "Specified native messaging host not found.",
      retryable: true,
    },
  });
});

test("auth bridge returns a retryable timeout and forgets the request", async () => {
  const harness = await createHarness();
  const pending = dispatch(harness, { channel: "auth", method: "auth.status" });
  const [timer] = harness.timers.values();

  assert.equal(timer.delay, 30_000);
  timer.callback();

  assert.deepEqual(plain(await pending.response), {
    ok: false,
    error: {
      code: "companion_timeout",
      message: "The BrowseFriend companion did not respond in time.",
      retryable: true,
    },
  });

  harness.nativeMessages.emit({ id: "request-1", ok: true, result: { state: "signed_in" } });
  assert.equal(harness.timers.size, 0);
});

test("interactive sign-in receives a longer companion timeout", async () => {
  const harness = await createHarness();
  const pending = dispatch(harness, { channel: "auth", method: "auth.signIn" });
  const [timer] = harness.timers.values();

  assert.equal(timer.delay, 11 * 60 * 1000);

  harness.nativeDisconnect.emit();
  await pending.response;
  assert.equal(harness.timers.size, 0);
});

test("synchronous native-port failures return a safe companion error", async () => {
  const harness = await createHarness({ postMessageError: new Error("Port closed.") });
  const pending = dispatch(harness, { channel: "auth", method: "auth.status" });

  assert.deepEqual(plain(await pending.response), {
    ok: false,
    error: {
      code: "companion_unavailable",
      message: "Port closed.",
      retryable: true,
    },
  });
  assert.equal(harness.timers.size, 0);
});
