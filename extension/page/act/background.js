import { normalizePageNavigationUrl } from "../../../shared/page-tools.js";

const CONTENT_SCRIPT = "extension/page/act/content-script.js";
const HIGHLIGHT_CSS = "extension/page/act/highlight.css";

function pageError(error, fallback = "BrowseFriend could not perform that page action.") {
  return error?.code ? error : {
    code: "action_failed",
    message: fallback,
    retryable: false,
  };
}

export function installPageActor({ runtime, tabs, scripting, pageReader }) {
  const fileListeners = new Set();
  const installedTabs = new Set();

  async function ensureInstalled(tabId) {
    if (installedTabs.has(tabId)) return;
    await scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
    await scripting.insertCSS({ target: { tabId }, files: [HIGHLIGHT_CSS] });
    installedTabs.add(tabId);
  }

  async function validateContext(context) {
    if (!context?.available || typeof context.tabId !== "number" ||
        typeof context.documentId !== "string" || typeof context.revision !== "number") {
      throw {
        code: "page_context_missing",
        message: "BrowseFriend needs a fresh page snapshot before acting.",
        retryable: true,
      };
    }
    const page = await pageReader.capture();
    if (!page.available || page.tabId !== context.tabId ||
        page.snapshot.documentId !== context.documentId || page.snapshot.revision !== context.revision) {
      throw {
        code: "stale_page",
        message: "The page changed before BrowseFriend could navigate.",
        retryable: true,
      };
    }
  }

  function navigationResult(call, overrides = {}) {
    const url = new URL(normalizePageNavigationUrl(call.args.url));
    const target = `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 300);
    return {
      tool: call.name,
      kind: "navigation",
      target: target || url.origin,
      destination: url.origin,
      requiresConfirmation: false,
      ...overrides,
    };
  }

  async function prepareNavigation(call, context) {
    await validateContext(context);
    return navigationResult(call);
  }

  async function executeNavigation(call, context) {
    await validateContext(context);
    const url = normalizePageNavigationUrl(call.args.url);
    await tabs.update(context.tabId, { url });
    return navigationResult(call, { executed: true });
  }

  async function send(method, call, context) {
    if (!context?.available || typeof context.tabId !== "number" ||
        typeof context.documentId !== "string" || typeof context.revision !== "number") {
      throw {
        code: "page_context_missing",
        message: "BrowseFriend needs a fresh page snapshot before acting.",
        retryable: true,
      };
    }

    try {
      await ensureInstalled(context.tabId);
      const response = await tabs.sendMessage(context.tabId, {
        channel: "pageAct",
        method,
        call,
        documentId: context.documentId,
        revision: context.revision,
      });
      if (!response?.ok) throw response?.error;
      return response.result;
    } catch (error) {
      if (["stale_page", "stale_target"].includes(error?.code)) throw error;
      installedTabs.delete(context.tabId);
      if (method === "page.action.execute" && ["page_click", "page_submit"].includes(call?.name)) {
        const page = await (pageReader.captureAfterNavigation?.(context) || pageReader.capture())
          .catch(() => null);
        if (page?.available && page.tabId === context.tabId &&
            page.snapshot?.documentId !== context.documentId) {
          return {
            tool: call.name,
            kind: call.name === "page_submit" ? "submit" : "navigation",
            target: "New page",
            executed: true,
          };
        }
      }
      throw pageError(error);
    }
  }

  runtime.onMessage.addListener((message, sender) => {
    if (message?.channel !== "pageAct" || message.event !== "fileSelection" ||
        sender.id !== runtime.id || sender.frameId !== 0 || typeof sender.tab?.id !== "number") {
      return false;
    }
    const event = {
      tabId: sender.tab.id,
      documentId: message.documentId,
      revision: message.revision,
      ref: message.ref,
      cancelled: message.cancelled === true,
      count: Number.isInteger(message.count) && message.count >= 0 ? message.count : 0,
    };
    fileListeners.forEach((listener) => listener(event));
    return false;
  });

  pageReader.onDirty((event) => {
    if (!event.documentId) installedTabs.delete(event.tabId);
  });

  return {
    prepare(call, context) {
      if (call.name === "page_navigate") return prepareNavigation(call, context);
      return send("page.action.prepare", call, context);
    },
    execute(call, context) {
      if (call.name === "page_navigate") return executeNavigation(call, context);
      return send("page.action.execute", call, context);
    },
    cancelFile(context) {
      return send("page.action.cancelFile", null, context);
    },
    onFileSelection(listener) {
      fileListeners.add(listener);
      return () => fileListeners.delete(listener);
    },
  };
}
