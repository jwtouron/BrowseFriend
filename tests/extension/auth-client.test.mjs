import assert from "node:assert/strict";
import test from "node:test";
import { createAuthClient } from "../../extension/auth/client.js";

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    emit(message) {
      listeners.forEach((listener) => listener(message));
    },
  };
}

test("auth client hides transport method names behind operation methods", async () => {
  const messages = [];
  const runtime = {
    onMessage: createEvent(),
    async sendMessage(message) {
      messages.push(message);
      return { ok: true, result: { state: "signed_out" } };
    },
  };
  const client = createAuthClient(runtime);

  await client.getStatus();
  await client.signIn();
  await client.cancelSignIn();
  await client.signOut();

  assert.deepEqual(messages, [
    { channel: "auth", method: "auth.status" },
    { channel: "auth", method: "auth.signIn" },
    { channel: "auth", method: "auth.cancel" },
    { channel: "auth", method: "auth.signOut" },
  ]);
});

test("auth client rejects bridge failures and missing responses safely", async () => {
  const expected = { code: "cancelled", message: "Cancelled.", retryable: true };
  const responses = [{ ok: false, error: expected }, undefined];
  const runtime = {
    onMessage: createEvent(),
    async sendMessage() {
      return responses.shift();
    },
  };
  const client = createAuthClient(runtime);

  await assert.rejects(() => client.signIn(), (error) => error === expected);
  await assert.rejects(
    () => client.getStatus(),
    (error) => error.code === "companion_unavailable" && error.retryable === true,
  );
});

test("auth client normalizes events and supports unsubscribe", () => {
  const onMessage = createEvent();
  const events = [];
  const client = createAuthClient({ onMessage });
  const unsubscribe = client.subscribe((event) => events.push(event));

  onMessage.emit({ channel: "other", event: "changed", state: { state: "ignored" } });
  onMessage.emit({ channel: "auth", event: "changed", state: { state: "signed_in" } });
  onMessage.emit({
    channel: "auth",
    event: "disconnected",
    error: { code: "companion_unavailable" },
  });
  unsubscribe();
  onMessage.emit({ channel: "auth", event: "changed", state: { state: "ignored" } });

  assert.deepEqual(events, [
    { type: "changed", state: { state: "signed_in" } },
    { type: "disconnected", error: { code: "companion_unavailable" } },
  ]);
});
