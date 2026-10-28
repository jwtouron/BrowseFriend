export function deriveViewState(state, optimisticSubmission = null) {
  const busy = Boolean(optimisticSubmission || state.submission);
  const signingIn = state.connection.auth?.state === "signing_in";
  const authRequired = ["auth_required", "plan_required"].includes(state.connection.phase);
  const inputDisabled = busy || signingIn || authRequired;
  const hasError = state.issue?.kind === "error";
  const connectionTone = hasError
    ? "error"
    : state.connection.phase === "ready"
      ? "ready"
      : state.connection.phase === "checking"
        ? "checking"
        : "error";
  let connectionLabel = "Connection error";
  if (state.connection.phase === "ready") connectionLabel = "Ready";
  if (state.connection.phase === "checking") connectionLabel = "Connecting";
  if (state.connection.phase === "auth_required") connectionLabel = "Sign-in required";
  if (state.connection.phase === "plan_required") connectionLabel = "Plan permission required";
  if (hasError && state.issue.scope === "generation") connectionLabel = "Response failed";
  else if (hasError) connectionLabel = "Connection error";

  let focusTarget = "composer";
  if (busy) focusTarget = "stop";
  if (state.issue?.kind === "error") focusTarget = "retry";
  if (authRequired) focusTarget = "signIn";
  if (signingIn) focusTarget = "cancelSignIn";

  return {
    authRequired,
    busy,
    connectionLabel,
    connectionTone,
    focusTarget,
    inputDisabled,
    sendHidden: busy,
    stopHidden: !busy,
  };
}
