export function chatFocusTarget({ authState, generating }) {
  if (authState === "signed_in") return generating ? "stop" : "composer";
  if (authState === "signing_in") return "cancelSignIn";
  if (authState === "loading") return "settings";
  return "signIn";
}

export function shouldRestoreComposerFocus({
  wasGenerating,
  generating,
  documentHasFocus,
  authState,
  settingsOpen,
  contextViewerOpen,
  planWelcomeOpen,
  chatVisible,
}) {
  return wasGenerating && !generating && documentHasFocus && authState === "signed_in" &&
    !settingsOpen && !contextViewerOpen && !planWelcomeOpen && chatVisible;
}
