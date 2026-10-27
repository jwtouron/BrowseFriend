import assert from "node:assert/strict";
import test from "node:test";
import { createAuthView } from "../../extension/auth/view-model.js";

test("signed-in view enables chat and account controls", () => {
  const view = createAuthView({
    state: "signed_in",
    profile: { name: "Person", email: "person@example.com" },
    planUsageEnabled: true,
  });

  assert.equal(view.ready, true);
  assert.equal(view.connected, true);
  assert.equal(view.signedIn, true);
  assert.equal(view.profileName, "Person");
  assert.equal(view.accountStatus, "ChatGPT plan usage enabled");
});

test("plan-disabled view asks for consent while preserving account identity", () => {
  const view = createAuthView({
    state: "plan_disabled",
    profile: { email: "person@example.com" },
    planUsageEnabled: false,
  });

  assert.equal(view.connected, true);
  assert.equal(view.signedIn, false);
  assert.equal(view.planDisabled, true);
  assert.equal(view.signInLabel, "Enable ChatGPT plan");
  assert.equal(view.profileEmail, "person@example.com");
});

test("companion failures show setup help instead of duplicate error text", () => {
  const error = {
    code: "companion_unavailable",
    message: "Native host not found.",
    retryable: true,
  };
  const view = createAuthView({ state: "signed_out", profile: null }, error);

  assert.equal(view.companionUnavailable, true);
  assert.equal(view.error, error);
});

test("loading and signing-in remain distinct states", () => {
  assert.equal(createAuthView({ state: "loading", profile: null }).ready, false);
  assert.equal(createAuthView({ state: "signing_in", profile: null }).signingIn, true);
  assert.equal(
    createAuthView({ state: "signing_in", profile: null }).accountStatus,
    "Waiting for sign-in",
  );
});
