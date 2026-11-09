function createError(response) {
  return response?.error || {
    code: "app_unavailable",
    message: "BrowseFriend is unavailable.",
    retryable: true,
  };
}

export function createAppClient(runtime) {
  async function request(method, extra = {}) {
    const response = await runtime.sendMessage({ channel: "app", method, ...extra });
    if (!response?.ok) throw createError(response);
    return response.result;
  }

  function subscribe(listener) {
    const handleMessage = (message) => {
      if (message?.channel === "app" && typeof message.event === "string") listener(message);
    };
    runtime.onMessage.addListener(handleMessage);
    return () => runtime.onMessage.removeListener(handleMessage);
  }

  return {
    getState: () => request("app.state"),
    start: () => request("app.start"),
    submit: (id, text) => request("app.submit", { id, text }),
    stop: (id) => request("app.stop", { id }),
    setMode: (mode) => request("app.setMode", { mode }),
    resolveAction: (id, approved) => request("app.resolveAction", { id, approved }),
    retry: () => request("app.retry"),
    clear: () => request("app.clear"),
    signIn: () => request("app.signIn"),
    cancelSignIn: () => request("app.cancelSignIn"),
    signOut: () => request("app.signOut"),
    resetLogin: () => request("app.resetLogin"),
    setModel: (model) => request("app.setModel", { model }),
    setReasoningEffort: (effort) => request("app.setReasoningEffort", { effort }),
    getModels: (refresh = false) => request("app.models", { refresh }),
    subscribe,
  };
}
