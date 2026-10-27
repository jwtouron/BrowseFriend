const NATIVE_HOST = "com.browsefriend.native_host";
const ALLOWED_AUTH_METHODS = new Set([
  "auth.status",
  "auth.signIn",
  "auth.signOut",
  "auth.cancel",
]);

function companionError(message = "The BrowseFriend companion is unavailable.") {
  return {
    code: "companion_unavailable",
    message,
    retryable: true,
  };
}

export function installAuthBridge({
  runtime,
  randomUUID = () => globalThis.crypto.randomUUID(),
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  let nativePort = null;
  const pendingRequests = new Map();

  function rejectPending(error) {
    pendingRequests.forEach(({ reject, timeoutId }) => {
      clearTimer(timeoutId);
      reject(error);
    });
    pendingRequests.clear();
  }

  function connectCompanion() {
    if (nativePort) return nativePort;

    const port = runtime.connectNative(NATIVE_HOST);
    nativePort = port;

    port.onMessage.addListener((message) => {
      if (message?.event === "auth.changed") {
        runtime
          .sendMessage({ channel: "auth", event: "changed", state: message.payload })
          .catch(() => undefined);
        return;
      }

      const pending = pendingRequests.get(message?.id);
      if (!pending) return;

      clearTimer(pending.timeoutId);
      pendingRequests.delete(message.id);
      if (message.ok) pending.resolve(message);
      else pending.reject(message.error || companionError());
    });

    port.onDisconnect.addListener(() => {
      const detail = runtime.lastError?.message;
      nativePort = null;
      rejectPending(companionError(detail));
      runtime
        .sendMessage({ channel: "auth", event: "disconnected", error: companionError(detail) })
        .catch(() => undefined);
    });

    return port;
  }

  function requestCompanion(method) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = connectCompanion();
      } catch (error) {
        reject(companionError(error.message));
        return;
      }

      const id = randomUUID();
      const timeoutMs = method === "auth.signIn" ? 11 * 60 * 1000 : 30 * 1000;
      const timeoutId = setTimer(() => {
        pendingRequests.delete(id);
        reject({
          code: "companion_timeout",
          message: "The BrowseFriend companion did not respond in time.",
          retryable: true,
        });
      }, timeoutMs);

      pendingRequests.set(id, { resolve, reject, timeoutId });

      try {
        port.postMessage({ id, method });
      } catch (error) {
        clearTimer(timeoutId);
        pendingRequests.delete(id);
        reject(companionError(error.message));
      }
    });
  }

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== runtime.id || message?.channel !== "auth" ||
        !ALLOWED_AUTH_METHODS.has(message.method)) {
      return false;
    }

    requestCompanion(message.method)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error }));
    return true;
  });
}
