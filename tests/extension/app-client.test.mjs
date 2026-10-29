import assert from "node:assert/strict";
import test from "node:test";
import { createAppClient } from "../../extension/app/client.js";

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(message) { listeners.forEach((listener) => listener(message)); },
  };
}

test("app client exposes intents and normalized failures", async () => {
  const sent = [];
  const runtime = {
    onMessage: createEvent(),
    async sendMessage(message) {
      sent.push(message);
      if (message.method === "app.retry") {
        return { ok: false, error: { code: "failed", message: "No.", retryable: true } };
      }
      return { ok: true, result: { accepted: true } };
    },
  };
  const client = createAppClient(runtime);

  assert.deepEqual(await client.submit("id-1", "Question"), { accepted: true });
  assert.deepEqual(await client.stop("id-1"), { accepted: true });
  assert.deepEqual(await client.setMode("act"), { accepted: true });
  assert.deepEqual(await client.resolveAction("action-1", true), { accepted: true });
  await assert.rejects(client.retry(), { code: "failed", message: "No." });
  assert.deepEqual(sent, [
    { channel: "app", method: "app.submit", id: "id-1", text: "Question" },
    { channel: "app", method: "app.stop", id: "id-1" },
    { channel: "app", method: "app.setMode", mode: "act" },
    { channel: "app", method: "app.resolveAction", id: "action-1", approved: true },
    { channel: "app", method: "app.retry" },
  ]);
});

test("app client subscriptions accept only app events and unsubscribe", () => {
  const onMessage = createEvent();
  const client = createAppClient({ onMessage });
  const received = [];
  const unsubscribe = client.subscribe((event) => received.push(event.event));

  onMessage.emit({ channel: "other", event: "state" });
  onMessage.emit({ channel: "app", event: "state" });
  unsubscribe();
  onMessage.emit({ channel: "app", event: "delta" });
  assert.deepEqual(received, ["state"]);
});
