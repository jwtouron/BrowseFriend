import assert from "node:assert/strict";
import test from "node:test";
import { deriveViewState } from "../../extension/sidepanel/view-state.js";

function state(phase, authState = "signed_out", submission = null, issue = null) {
  return { connection: { phase, auth: { state: authState } }, issue, submission };
}

test("initial checking disables the composer while leaving Settings accessible", () => {
  assert.deepEqual(deriveViewState(state("checking", "loading")), {
    authRequired: false,
    busy: false,
    connectionLabel: "Connecting",
    connectionTone: "checking",
    focusTarget: "settings",
    inputDisabled: true,
    sendHidden: false,
    stopHidden: true,
  });
});

test("one derived state controls authentication, pending, and ready composer behavior", () => {
  const auth = deriveViewState(state("auth_required"));
  assert.equal(auth.connectionTone, "error");
  assert.equal(auth.inputDisabled, true);
  assert.equal(auth.focusTarget, "signIn");

  const signingIn = deriveViewState(state("checking", "signing_in"));
  assert.equal(signingIn.inputDisabled, true);
  assert.equal(signingIn.focusTarget, "cancelSignIn");

  const modelsLoading = deriveViewState(state("checking", "signed_in"));
  assert.equal(modelsLoading.inputDisabled, true);
  assert.equal(modelsLoading.focusTarget, "settings");

  const connectionError = deriveViewState(state("error", "signed_in", null, {
    kind: "error", scope: "connection",
  }));
  assert.equal(connectionError.inputDisabled, true);
  assert.equal(connectionError.focusTarget, "retry");

  const pending = deriveViewState(state("ready", "signed_in", { id: "one" }));
  assert.equal(pending.busy, true);
  assert.equal(pending.sendHidden, true);
  assert.equal(pending.stopHidden, false);
  assert.equal(pending.focusTarget, "stop");

  const pendingAuth = deriveViewState(state("auth_required", "signed_out", { id: "one" }));
  assert.equal(pendingAuth.focusTarget, "signIn");

  const pendingError = deriveViewState(state("error", "signed_in", { id: "one" }, {
    kind: "error",
  }));
  assert.equal(pendingError.focusTarget, "retry");

  const generationError = deriveViewState(state("ready", "signed_in", null, {
    kind: "error",
    scope: "generation",
  }));
  assert.equal(generationError.connectionTone, "error");
  assert.equal(generationError.connectionLabel, "Response failed");
  assert.equal(generationError.inputDisabled, false);

  const ready = deriveViewState(state("ready", "signed_in"));
  assert.equal(ready.connectionTone, "ready");
  assert.equal(ready.inputDisabled, false);
  assert.equal(ready.focusTarget, "composer");
});

test("an optimistic submission uses the same busy composer state", () => {
  const view = deriveViewState(state("ready", "signed_in"), { id: "optimistic" });
  assert.equal(view.busy, true);
  assert.equal(view.inputDisabled, true);
  assert.equal(view.sendHidden, true);
  assert.equal(view.stopHidden, false);
});
