import assert from "node:assert/strict";
import test from "node:test";
import { createAuthHandler } from "../native-host/auth-handler.mjs";

const disconnected = { status: "disconnected", sharing: false };

function createHarness(overrides = {}) {
  const sent = [];
  const calls = [];
  const chatgpt = {
    async getSession() {
      calls.push(["getSession"]);
      return disconnected;
    },
    async signIn(options) {
      calls.push(["signIn", options]);
      return { status: "connected", sharing: true };
    },
    cancelSignIn() {
      calls.push(["cancelSignIn"]);
    },
    async disconnect() {
      calls.push(["disconnect"]);
    },
    ...overrides,
  };
  const handle = createAuthHandler({
    chatgpt,
    send: (message) => sent.push(message),
    serializeError: (error) => ({
      code: error.code || "test_error",
      message: error.message || "Test failure",
      retryable: false,
    }),
    isRevocationFailure: (error) => error.code === "revocation_failed",
  });

  return { calls, chatgpt, handle, sent };
}

test("auth handler rejects unknown requests before calling the client", async () => {
  const harness = createHarness();

  await harness.handle({ id: "bad", method: "auth.readTokens" });

  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.sent, [{
    id: "bad",
    ok: false,
    error: {
      code: "invalid_request",
      message: "Unsupported native request.",
      retryable: false,
    },
  }]);
});

test("auth handler requests reconsent only for a connected account without plan usage", async () => {
  const harness = createHarness({
    async getSession() {
      harness.calls.push(["getSession"]);
      return { status: "connected", sharing: false, identity: { email: "person@example.com" } };
    },
  });

  await harness.handle({ id: "sign-in", method: "auth.signIn" });

  assert.deepEqual(harness.calls, [
    ["getSession"],
    ["signIn", { reconsent: true }],
  ]);
  assert.equal(harness.sent[0].result.state, "signed_in");
});

test("auth cancellation bypass operation calls cancel before returning current state", async () => {
  const harness = createHarness();

  await harness.handle({ id: "cancel", method: "auth.cancel" });

  assert.deepEqual(harness.calls, [["cancelSignIn"], ["getSession"]]);
  assert.equal(harness.sent[0].ok, true);
});

test("sign-out reports revocation failure as a warning after local state is cleared", async () => {
  const failure = Object.assign(new Error("Remote revocation failed."), {
    code: "revocation_failed",
  });
  const harness = createHarness({
    async disconnect() {
      harness.calls.push(["disconnect"]);
      throw failure;
    },
  });

  await harness.handle({ id: "sign-out", method: "auth.signOut" });

  assert.deepEqual(harness.calls, [["disconnect"], ["getSession"]]);
  assert.equal(harness.sent[0].ok, true);
  assert.equal(harness.sent[0].warning.code, "revocation_failed");
  assert.equal(harness.sent[0].result.state, "signed_out");
});

test("unexpected client failures become error responses", async () => {
  const harness = createHarness({
    async getSession() {
      throw Object.assign(new Error("Storage unavailable."), { code: "storage_failed" });
    },
  });

  await harness.handle({ id: "status", method: "auth.status" });

  assert.deepEqual(harness.sent, [{
    id: "status",
    ok: false,
    error: { code: "storage_failed", message: "Storage unavailable.", retryable: false },
  }]);
});
