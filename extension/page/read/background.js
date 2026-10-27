const CONTENT_SCRIPT = "extension/page/read/content-script.js";
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

function pageUnavailable(message) {
  return {
    available: false,
    error: { code: "page_unavailable", message },
  };
}

export function installPageReader({ runtime, tabs, scripting }) {
  const dirtyListeners = new Set();

  function publishDirty(event) {
    dirtyListeners.forEach((listener) => listener(event));
    runtime.sendMessage({ channel: "page", event: "dirty", ...event }).catch(() => undefined);
  }

  async function activeTab() {
    const [tab] = await tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function capture() {
    const tab = await activeTab();
    if (typeof tab?.id !== "number" || !tab.url) {
      return pageUnavailable("The active tab is unavailable.");
    }

    let url;
    try {
      url = new URL(tab.url);
    } catch {
      return pageUnavailable("This page does not expose a readable URL.");
    }
    if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
      return pageUnavailable("Chrome does not allow BrowseFriend to read this type of page.");
    }

    let response;
    try {
      response = await tabs.sendMessage(tab.id, { channel: "page", method: "page.snapshot" });
    } catch {
      try {
        await scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT] });
        response = await tabs.sendMessage(tab.id, { channel: "page", method: "page.snapshot" });
      } catch {
        return pageUnavailable("Chrome did not allow BrowseFriend to read this page.");
      }
    }

    if (!response?.ok || !response.snapshot) {
      return pageUnavailable(response?.error?.message || "BrowseFriend could not read this page.");
    }
    return { available: true, tabId: tab.id, snapshot: response.snapshot };
  }

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.channel === "page" && message.event === "dirty" &&
        sender.id === runtime.id && sender.frameId === 0 && typeof sender.tab?.id === "number") {
      const event = {
        tabId: sender.tab.id,
        documentId: message.documentId,
        revision: message.revision,
      };
      publishDirty(event);
      return false;
    }

    if (message?.channel !== "page" || message.method !== "page.capture" ||
        sender.id !== runtime.id) return false;
    capture()
      .then((result) => sendResponse({ ok: true, result }))
      .catch(() => sendResponse({ ok: true, result: pageUnavailable("BrowseFriend could not read this page.") }));
    return true;
  });

  tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "loading" && typeof changeInfo.url !== "string") return;
    publishDirty({ tabId, documentId: null, revision: Number.MAX_SAFE_INTEGER });
  });

  return {
    capture,
    onDirty(listener) {
      dirtyListeners.add(listener);
      return () => dirtyListeners.delete(listener);
    },
  };
}
