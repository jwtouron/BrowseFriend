const NATIVE_HOST = "com.browsefriend.native_host";

function companionError(message = "The BrowseFriend companion is unavailable.") {
  return {
    code: "companion_unavailable",
    message,
    retryable: true,
  };
}

export function installCompanionBridge({
  runtime,
  randomUUID = () => globalThis.crypto.randomUUID(),
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  let nativePort = null;
  const pendingRequests = new Map();
  const listeners = new Set();

  function emit(event) {
    listeners.forEach((listener) => listener(event));
  }

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
        emit({ type: "auth.changed", state: message.payload });
        return;
      }

      if (message?.event === "model.delta") {
        const pending = pendingRequests.get(message.requestId);
        pending?.onEvent?.(message);
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
      const error = companionError(detail);
      rejectPending(error);
      emit({ type: "disconnected", error });
    });

    return port;
  }

  function requestCompanion(method, params, onEvent, explicitId) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = connectCompanion();
      } catch (error) {
        reject(companionError(error.message));
        return;
      }

      const id = explicitId || randomUUID();
      const timeoutMs = method === "auth.signIn"
        ? 11 * 60 * 1000
        : method === "model.stream"
          ? 190 * 1000
          : 30 * 1000;
      const timeoutId = setTimer(() => {
        pendingRequests.delete(id);
        if (method === "model.stream") {
          try {
            port.postMessage({
              id: randomUUID(),
              method: "model.cancel",
              params: { requestId: id },
            });
          } catch {
            // The timeout below already reports the unavailable companion path.
          }
        }
        reject({
          code: "companion_timeout",
          message: "The BrowseFriend companion did not respond in time.",
          retryable: true,
        });
      }, timeoutMs);

      pendingRequests.set(id, { resolve, reject, timeoutId, onEvent });

      try {
        port.postMessage({ id, method, ...(params ? { params } : {}) });
      } catch (error) {
        clearTimer(timeoutId);
        pendingRequests.delete(id);
        reject(companionError(error.message));
      }
    });
  }

  return {
    request: requestCompanion,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
