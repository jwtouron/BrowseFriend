import assert from "node:assert/strict";
import test from "node:test";
import { toPublicError, toPublicSession } from "../../native-host/auth/session.mjs";

test("public session exposes only display-safe account fields", () => {
  const session = toPublicSession({
    status: "connected",
    sharing: true,
    profileId: "private-profile-id",
    identity: {
      name: "Person",
      email: "person@example.com",
      subject: "private-subject",
    },
    credentials: { accessToken: "private-token" },
  });

  assert.deepEqual(session, {
    state: "signed_in",
    profile: { name: "Person", email: "person@example.com" },
    planUsageEnabled: true,
  });
  assert.equal(JSON.stringify(session).includes("private"), false);
});

test("public session maps every SDK connection state", () => {
  assert.equal(toPublicSession({ status: "disconnected", sharing: false }).state, "signed_out");
  assert.equal(toPublicSession({ status: "reauth_required", sharing: false }).state, "signed_out");
  assert.equal(toPublicSession({ status: "connecting", sharing: false }).state, "signing_in");
  assert.equal(toPublicSession({ status: "connected", sharing: false }).state, "plan_disabled");
  assert.equal(toPublicSession({ status: "connected", sharing: true }).state, "signed_in");
});

test("public errors discard unknown and potentially sensitive fields", () => {
  const error = toPublicError({
    code: "invalid_grant",
    message: "Sign in again.",
    retryable: true,
    status: 401,
    requestId: "request-1",
    responseBody: "private-token",
  });

  assert.deepEqual(error, {
    code: "invalid_grant",
    message: "Sign in again.",
    retryable: true,
    status: 401,
    requestId: "request-1",
  });
});
