(() => {
  const INSTALL_KEY = "__browseFriendActMode";
  const READ_KEY = "__browseFriendReadMode";
  if (globalThis[INSTALL_KEY]) return;

  const DOWNLOAD_PATH = /\.(?:7z|avi|csv|docx?|dmg|exe|gif|gz|jpe?g|mkv|mov|mp3|mp4|pdf|png|pptx?|rar|tar|tgz|webp|xlsx?|zip)(?:$|[?#])/i;
  const SENSITIVE_AUTOCOMPLETE = /(?:^|\s)(?:cc-|current-password|new-password|one-time-code)/i;
  const SENSITIVE_NAME = /(?:password|passcode|one.?time|otp|card.?number|credit.?card|security.?code|cvv|cvc)/i;
  const CONSEQUENTIAL_NAME = /(?:buy|checkout|delete|log\s*out|order|pay|post|publish|purchase|remove|reserve|send|sign\s*out|subscribe|unsubscribe)/i;
  const HIGHLIGHT_CLASS = "browsefriend-file-target";
  const ALLOWED_FILL_TYPES = new Set([
    "", "date", "datetime-local", "email", "month", "number", "search", "tel", "text", "time", "url", "week",
  ]);

  const state = { fileTarget: null };
  globalThis[INSTALL_KEY] = state;

  function publicError(code, message, retryable = false) {
    return { code, message, retryable };
  }

  function readState() {
    const reader = globalThis[READ_KEY];
    if (!reader?.documentId || !(reader.elementsByRef instanceof Map)) {
      throw publicError("page_context_missing", "BrowseFriend needs a fresh page snapshot.", true);
    }
    return reader;
  }

  function validateContext(message) {
    const reader = readState();
    if (message.documentId !== reader.documentId || message.revision !== reader.revision || reader.dirty) {
      throw publicError("stale_page", "The page changed before BrowseFriend could act.", true);
    }
    return reader;
  }

  function targetFor(reader, ref) {
    const element = reader.elementsByRef.get(ref);
    if (!element || !element.isConnected) {
      throw publicError("stale_target", "That page control is no longer available.", true);
    }
    if (element.hidden || element.inert || element.getAttribute?.("aria-hidden") === "true") {
      throw publicError("target_hidden", "That page control is not currently visible.", true);
    }
    try {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
        throw publicError("target_hidden", "That page control is not currently visible.", true);
      }
    } catch (error) {
      if (error?.code) throw error;
    }
    if (element.disabled === true || element.getAttribute?.("aria-disabled") === "true") {
      throw publicError("target_disabled", "That page control is disabled.");
    }
    return element;
  }

  function normalize(value, maximum = 300) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
  }

  function targetName(element) {
    return normalize(
      element.getAttribute?.("aria-label") || element.labels?.[0]?.textContent ||
      element.textContent || element.getAttribute?.("title") || element.getAttribute?.("name") ||
      element.tagName?.toLowerCase(),
    );
  }

  function summary(name, element, overrides = {}) {
    return {
      tool: name,
      target: targetName(element),
      tag: element.tagName.toLowerCase(),
      requiresConfirmation: false,
      kind: "action",
      ...overrides,
    };
  }

  function isSubmitControl(element) {
    const type = String(element.type || "").toLowerCase();
    return element.tagName === "FORM" ||
      ((element.tagName === "BUTTON" || element.tagName === "INPUT") && ["image", "submit"].includes(type));
  }

  function hrefFor(element) {
    if (element.tagName !== "A" || !element.href) return null;
    try {
      return new URL(element.href, location.href);
    } catch {
      return null;
    }
  }

  function fileInputFor(element) {
    if (element.tagName === "INPUT" && String(element.type).toLowerCase() === "file") return element;
    if (element.tagName === "LABEL" && element.control?.tagName === "INPUT" &&
        String(element.control.type).toLowerCase() === "file") return element.control;
    return null;
  }

  function sensitiveControl(element) {
    const type = String(element.type || "").toLowerCase();
    const autocomplete = String(element.autocomplete || element.getAttribute?.("autocomplete") || "");
    const identity = [targetName(element), element.name, element.id].join(" ");
    return type === "password" || type === "hidden" || SENSITIVE_AUTOCOMPLETE.test(autocomplete) ||
      SENSITIVE_NAME.test(identity);
  }

  function prepare(call, reader) {
    if (call.name === "page_scroll") {
      return { tool: call.name, target: "Page", kind: "scroll", requiresConfirmation: false };
    }
    if (call.name === "page_wait_for_change") {
      return { tool: call.name, target: "Page changes", kind: "wait", requiresConfirmation: false };
    }

    const element = targetFor(reader, call.args.ref);
    if (call.name === "page_fill") {
      const type = String(element.type || "").toLowerCase();
      if (!(element.tagName === "TEXTAREA" ||
          (element.tagName === "INPUT" && ALLOWED_FILL_TYPES.has(type))) || sensitiveControl(element) ||
          element.readOnly === true || element.getAttribute("aria-readonly") === "true") {
        throw publicError("sensitive_target", "BrowseFriend cannot fill that control automatically.");
      }
      return summary(call.name, element, { kind: "fill", value: call.args.value });
    }
    if (call.name === "page_select") {
      if (element.tagName !== "SELECT") throw publicError("unsupported_target", "That is not a select control.");
      const option = targetFor(reader, call.args.optionRef);
      const owner = option.parentElement?.tagName === "OPTGROUP"
        ? option.parentElement.parentElement
        : option.parentElement;
      if (option.tagName !== "OPTION" || owner !== element) {
        throw publicError("unsupported_target", "That option does not belong to the selected control.");
      }
      return summary(call.name, element, { kind: "select", value: targetName(option) });
    }
    if (call.name === "page_check") {
      const type = String(element.type || "").toLowerCase();
      if (element.tagName !== "INPUT" || !["checkbox", "radio"].includes(type)) {
        throw publicError("unsupported_target", "That is not a checkbox or radio control.");
      }
      if (type === "radio" && call.args.checked === false) {
        throw publicError("unsupported_target", "Select another radio option instead of clearing this one.");
      }
      return summary(call.name, element, { kind: "check", value: call.args.checked ? "Checked" : "Unchecked" });
    }
    if (call.name === "page_choose_file") {
      const input = fileInputFor(element);
      if (!input) throw publicError("unsupported_target", "That control does not select files.");
      return summary(call.name, element, { kind: "file", waitingForUser: true });
    }
    if (call.name === "page_submit") {
      if (!(element.tagName === "FORM" || element.form || typeof element.click === "function")) {
        throw publicError("unsupported_target", "That control cannot be submitted.");
      }
      return summary(call.name, element, { kind: "submit", requiresConfirmation: true });
    }
    if (call.name === "page_click") {
      if (fileInputFor(element)) {
        throw publicError("file_selection_required", "Use the file-selection tool for that control.");
      }
      if (isSubmitControl(element)) {
        return summary(call.name, element, { kind: "submit", requiresConfirmation: true });
      }
      const href = hrefFor(element);
      if (href) {
        if (!["http:", "https:"].includes(href.protocol)) {
          throw publicError("unsupported_navigation", "BrowseFriend only opens HTTP or HTTPS links.");
        }
        const download = element.hasAttribute("download") || DOWNLOAD_PATH.test(href.pathname);
        const consequential = CONSEQUENTIAL_NAME.test(`${targetName(element)} ${href.pathname}`);
        return summary(call.name, element, {
          kind: download ? "download" : consequential ? "click" : "navigation",
          destination: href.origin,
          requiresConfirmation: download || consequential,
        });
      }
      const reversible = element.tagName === "SUMMARY" || element.getAttribute("aria-expanded") !== null ||
        element.getAttribute("role") === "tab";
      const inputButton = element.tagName === "INPUT" && ["button", "image", "reset"].includes(
        String(element.type || "").toLowerCase(),
      );
      const ambiguous = element.tagName === "BUTTON" || element.getAttribute("role") === "button" || inputButton;
      return summary(call.name, element, {
        kind: reversible ? "disclosure" : "click",
        requiresConfirmation: ambiguous && !reversible,
      });
    }
    throw publicError("unsupported_tool", "BrowseFriend does not support that page action.");
  }

  function dispatchChange(element) {
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function setNativeValue(element, value) {
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    dispatchChange(element);
  }

  function clearFileTarget() {
    state.fileTarget?.cleanup?.();
    state.fileTarget?.element?.classList?.remove(HIGHLIGHT_CLASS);
    state.fileTarget = null;
  }

  function watchFile(element, input, reader, ref) {
    clearFileTarget();
    element.classList?.add(HIGHLIGHT_CLASS);
    element.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
    element.focus?.({ preventScroll: true });

    const report = (cancelled) => {
      const count = input.files?.length || 0;
      clearFileTarget();
      chrome.runtime.sendMessage({
        channel: "pageAct",
        event: "fileSelection",
        documentId: reader.documentId,
        revision: reader.revision,
        ref,
        cancelled,
        count,
      }).catch(() => undefined);
    };
    const changed = () => report(false);
    const cancelledSelection = () => report(true);
    const cleanup = () => {
      input.removeEventListener("change", changed);
      input.removeEventListener("cancel", cancelledSelection);
    };
    state.fileTarget = { element, input, ref, cleanup };
    input.addEventListener("change", changed, { once: true });
    input.addEventListener("cancel", cancelledSelection, { once: true });
  }

  async function waitForChange(reader, startingRevision) {
    const startedAt = performance.now();
    while (reader.revision === startingRevision && performance.now() - startedAt < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (reader.dirty) await reader.waitForQuiet();
    return { changed: reader.revision !== startingRevision, revision: reader.revision };
  }

  async function execute(call, reader) {
    const prepared = prepare(call, reader);
    if (call.name === "page_scroll") {
      const distance = call.args.amount === "half" ? innerHeight / 2 : innerHeight;
      if (call.args.direction === "top") scrollTo({ top: 0, behavior: "smooth" });
      else if (call.args.direction === "bottom") scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      else scrollBy({ top: call.args.direction === "up" ? -distance : distance, behavior: "smooth" });
    } else if (call.name === "page_wait_for_change") {
      return { ...prepared, ...(await waitForChange(reader, reader.revision)) };
    } else {
      const element = targetFor(reader, call.args.ref);
      if (call.name === "page_fill") setNativeValue(element, call.args.value);
      if (call.name === "page_select") {
        const option = targetFor(reader, call.args.optionRef);
        element.value = option.value;
        dispatchChange(element);
      }
      if (call.name === "page_check" && element.checked !== call.args.checked) element.click();
      if (call.name === "page_click") element.click();
      if (call.name === "page_submit") {
        const form = element.tagName === "FORM" ? element : element.form;
        if (element.tagName === "FORM" && form?.requestSubmit) form.requestSubmit();
        else if (form?.requestSubmit && isSubmitControl(element)) form.requestSubmit(element);
        else element.click();
      }
      if (call.name === "page_choose_file") {
        watchFile(element, fileInputFor(element), reader, call.args.ref);
        return { ...prepared, waitingForUser: true };
      }
    }
    return { ...prepared, executed: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.channel !== "pageAct" ||
        !["page.action.prepare", "page.action.execute", "page.action.cancelFile"].includes(message.method)) {
      return false;
    }
    void (async () => {
      if (message.method === "page.action.cancelFile") {
        clearFileTarget();
        sendResponse({ ok: true, result: { cancelled: true } });
        return;
      }
      const reader = validateContext(message);
      const result = message.method === "page.action.prepare"
        ? prepare(message.call, reader)
        : await execute(message.call, reader);
      sendResponse({ ok: true, result });
    })().catch((error) => sendResponse({
      ok: false,
      error: error?.code ? error : publicError("action_failed", "BrowseFriend could not perform that page action."),
    }));
    return true;
  });
})();
