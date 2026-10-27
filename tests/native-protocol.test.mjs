import assert from "node:assert/strict";
import test from "node:test";
import { createMessageDecoder, encodeMessage } from "../native-host/protocol.mjs";

test("native protocol decodes messages split across chunks", () => {
  const messages = [];
  const errors = [];
  const decode = createMessageDecoder(
    (message) => messages.push(message),
    (error) => errors.push(error),
  );
  const first = encodeMessage({ id: "one", method: "auth.status" });
  const second = encodeMessage({ id: "two", method: "auth.signOut" });
  const combined = Buffer.concat([first, second]);

  decode(combined.subarray(0, 3));
  decode(combined.subarray(3, 11));
  decode(combined.subarray(11));

  assert.deepEqual(messages, [
    { id: "one", method: "auth.status" },
    { id: "two", method: "auth.signOut" },
  ]);
  assert.deepEqual(errors, []);
});

test("native protocol rejects malformed JSON without emitting a message", () => {
  const messages = [];
  const errors = [];
  const decode = createMessageDecoder(
    (message) => messages.push(message),
    (error) => errors.push(error),
  );
  const payload = Buffer.from("{not json", "utf8");
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);

  decode(frame);

  assert.equal(messages.length, 0);
  assert.equal(errors[0]?.message, "Native message is not valid JSON.");
});
