function createError(response) {
  return response?.error || {
    code: "chat_unavailable",
    message: "BrowseFriend chat is unavailable.",
    retryable: true,
  };
}

export function createChatClient(runtime) {
  async function request(method, extra = {}) {
    const response = await runtime.sendMessage({ channel: "chat", method, ...extra });
    if (!response?.ok) throw createError(response);
    return response.result;
  }

  function subscribe(listener) {
    const handleMessage = (message) => {
      if (message?.channel === "chat" && typeof message.event === "string") listener(message);
    };
    runtime.onMessage.addListener(handleMessage);
    return () => runtime.onMessage.removeListener(handleMessage);
  }

  return {
    getState: () => request("chat.state"),
    send: (text) => request("chat.send", { text }),
    cancel: () => request("chat.cancel"),
    clear: () => request("chat.clear"),
    subscribe,
  };
}
