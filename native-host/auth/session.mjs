const SAFE_ERROR_FIELDS = ["status", "requestId", "param", "responseShape"];

export function toPublicError(error, fallback = {}) {
  const source = error && typeof error === "object" ? error : fallback;
  const result = {
    code: typeof source.code === "string" ? source.code : "native_host_error",
    message: typeof source.message === "string"
      ? source.message
      : "The BrowseFriend companion failed.",
    retryable: source.retryable === true,
  };

  for (const field of SAFE_ERROR_FIELDS) {
    if (["string", "number"].includes(typeof source[field])) result[field] = source[field];
  }

  return result;
}

export function toPublicSession(session) {
  let state = "signed_out";
  if (session.status === "connecting") state = "signing_in";
  if (session.status === "connected") state = session.sharing ? "signed_in" : "plan_disabled";

  return {
    state,
    profile: session.identity ? {
      ...(typeof session.identity.name === "string" && session.identity.name
        ? { name: session.identity.name }
        : {}),
      ...(typeof session.identity.email === "string" && session.identity.email
        ? { email: session.identity.email }
        : {}),
    } : null,
    planUsageEnabled: session.sharing === true,
    ...(session.error ? { error: toPublicError(session.error) } : {}),
  };
}
