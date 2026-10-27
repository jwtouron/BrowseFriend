export function createAuthView(auth, explicitError = null) {
  const connected = ["signed_in", "plan_disabled"].includes(auth.state);
  const ready = auth.state !== "loading";
  const signedIn = auth.state === "signed_in";
  const signingIn = auth.state === "signing_in";
  const planDisabled = auth.state === "plan_disabled";
  const error = explicitError || auth.error || null;
  const companionUnavailable = ["companion_unavailable", "companion_timeout"]
    .includes(error?.code);

  return {
    connected,
    ready,
    signedIn,
    signingIn,
    planDisabled,
    error,
    companionUnavailable,
    authTitle: planDisabled ? "Enable your ChatGPT plan" : "Connect BrowseFriend",
    authDescription: planDisabled
      ? "Your account is connected, but BrowseFriend needs permission to use your ChatGPT plan."
      : "Sign in to use your ChatGPT plan with this local browser companion.",
    signInLabel: planDisabled ? "Enable ChatGPT plan" : "Continue with ChatGPT",
    profileName: auth.profile?.name || (connected ? "ChatGPT account" : "Not connected"),
    profileEmail: auth.profile?.email ||
      (connected ? "Connected through OpenAI" : "Connect a ChatGPT account to continue."),
    accountStatus: signedIn
      ? "ChatGPT plan usage enabled"
      : planDisabled
        ? "Signed in — plan usage not enabled"
        : signingIn
          ? "Waiting for sign-in"
          : "Signed out",
  };
}
