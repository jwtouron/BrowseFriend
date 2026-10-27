const NATIVE_HOST = "com.browsefriend.native_host";
const ALLOWED_AUTH_METHODS = new Set([
  "auth.status",
  "auth.signIn",
  "auth.signOut",
  "auth.cancel",
]);

let nativePort = null;
const pendingRequests = new Map();

function companionError(message = "The BrowseFriend companion is unavailable.") {
  return {
    code: "companion_unavailable",
    message,
    retryable: true,
  };
}

function rejectPending(error) {
  pendingRequests.forEach(({ reject, timeoutId }) => {
    clearTimeout(timeoutId);
    reject(error);
  });
  pendingRequests.clear();
}

function connectCompanion() {
  if (nativePort) return nativePort;

  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;

  port.onMessage.addListener((message) => {
    if (message?.event === "auth.changed") {
      chrome.runtime
        .sendMessage({ channel: "auth", event: "changed", state: message.payload })
        .catch(() => undefined);
      return;
    }

    const pending = pendingRequests.get(message?.id);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    pendingRequests.delete(message.id);
    if (message.ok) pending.resolve(message);
    else pending.reject(message.error || companionError());
  });

  port.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message;
    nativePort = null;
    rejectPending(companionError(detail));
    chrome.runtime
      .sendMessage({ channel: "auth", event: "disconnected", error: companionError(detail) })
      .catch(() => undefined);
  });

  return port;
}

function requestCompanion(method) {
  return new Promise((resolve, reject) => {
    const port = connectCompanion();
    const id = crypto.randomUUID();
    const timeoutMs = method === "auth.signIn" ? 11 * 60 * 1000 : 30 * 1000;
    const timeoutId = setTimeout(() => {
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
      clearTimeout(timeoutId);
      pendingRequests.delete(id);
      reject(companionError(error.message));
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== "auth" ||
      !ALLOWED_AUTH_METHODS.has(message.method)) {
    return false;
  }

  requestCompanion(message.method)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error }));
  return true;
});

// Make the extension's toolbar icon Chrome's native side-panel toggle.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Unable to configure the toolbar action.", error));
