const METHODS = {
  getStatus: "auth.status",
  signIn: "auth.signIn",
  signOut: "auth.signOut",
  cancelSignIn: "auth.cancel",
};

export function createAuthClient(runtime) {
  async function request(method) {
    const response = await runtime.sendMessage({ channel: "auth", method });
    if (!response?.ok) throw response?.error || {
      code: "companion_unavailable",
      message: "The BrowseFriend companion is unavailable.",
      retryable: true,
    };
    return response;
  }

  function subscribe(listener) {
    const handleMessage = (message) => {
      if (message?.channel !== "auth") return;
      if (message.event === "changed") {
        listener({ type: "changed", state: message.state });
      }
      if (message.event === "disconnected") {
        listener({ type: "disconnected", error: message.error });
      }
    };

    runtime.onMessage.addListener(handleMessage);
    return () => runtime.onMessage.removeListener(handleMessage);
  }

  return {
    getStatus: () => request(METHODS.getStatus),
    signIn: () => request(METHODS.signIn),
    signOut: () => request(METHODS.signOut),
    cancelSignIn: () => request(METHODS.cancelSignIn),
    subscribe,
  };
}
