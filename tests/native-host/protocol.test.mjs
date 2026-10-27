import assert from "node:assert/strict";
import test from "node:test";
import { createMessageDecoder, encodeMessage } from "../../native-host/messaging/protocol.mjs";

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

test("native protocol rejects oversized outgoing and incoming messages", () => {
  assert.throws(
    () => encodeMessage({ body: "x".repeat(1024 * 1024) }),
    /exceeds the 1 MiB/,
  );

  const messages = [];
  const errors = [];
  const decode = createMessageDecoder(
    (message) => messages.push(message),
    (error) => errors.push(error),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32LE(1024 * 1024 + 1, 0);
  decode(header);

  assert.deepEqual(messages, []);
  assert.equal(errors[0]?.message, "Native message exceeds the 1 MiB BrowseFriend limit.");
});

test("decoder does not misreport consumer exceptions as malformed JSON", () => {
  const expected = new Error("Consumer failed.");
  const decode = createMessageDecoder(
    () => { throw expected; },
    () => assert.fail("Valid JSON must not produce a decoding error."),
  );

  assert.throws(() => decode(encodeMessage({ ok: true })), expected);
});

test("decoder recovers when a malformed frame is followed by a valid frame", () => {
  const messages = [];
  const errors = [];
  const malformedPayload = Buffer.from("not-json");
  const malformed = Buffer.alloc(malformedPayload.length + 4);
  malformed.writeUInt32LE(malformedPayload.length, 0);
  malformedPayload.copy(malformed, 4);
  const decode = createMessageDecoder(
    (message) => messages.push(message),
    (error) => errors.push(error),
  );

  decode(Buffer.concat([malformed, encodeMessage({ recovered: true })]));

  assert.equal(errors.length, 1);
  assert.deepEqual(messages, [{ recovered: true }]);
});
