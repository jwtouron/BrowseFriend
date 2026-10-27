(() => {
  const INSTALL_KEY = "__browseFriendReadMode";
  if (globalThis[INSTALL_KEY]) return;

  const MAX_TEXT_CHARS = 56 * 1024;
  const QUIET_MS = 250;
  const MAX_QUIET_WAIT_MS = 1_000;
  const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const SENSITIVE_AUTOCOMPLETE = /(?:^|\s)(?:cc-|current-password|new-password|one-time-code)/i;
  const NATIVE_ROLES = new Map([
    ["A", "link"], ["ARTICLE", "article"], ["ASIDE", "complementary"],
    ["BUTTON", "button"], ["DIALOG", "dialog"], ["FOOTER", "contentinfo"],
    ["FORM", "form"], ["HEADER", "banner"], ["IMG", "img"], ["MAIN", "main"],
    ["NAV", "navigation"], ["OL", "list"], ["OPTION", "option"],
    ["PROGRESS", "progressbar"], ["SELECT", "combobox"], ["TABLE", "table"],
    ["TEXTAREA", "textbox"], ["UL", "list"],
  ]);
  const OBSERVER_OPTIONS = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "alt", "aria-checked", "aria-disabled", "aria-expanded", "aria-hidden", "aria-label",
      "aria-labelledby", "aria-pressed", "aria-selected", "disabled", "hidden", "href",
      "inert", "open", "role", "selected", "title", "value",
    ],
  };

  const state = {
    documentId: crypto.randomUUID(),
    revision: 0,
    dirty: true,
    dirtyNotified: false,
    lastMutationAt: performance.now(),
    lastUrl: location.href,
    cachedSnapshot: null,
  };
  globalThis[INSTALL_KEY] = state;
  const observedRoots = new WeakSet();

  function normalizeText(value, maximum = 4_000) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
  }

  function markDirty({ notify = true } = {}) {
    state.revision += 1;
    state.dirty = true;
    state.lastMutationAt = performance.now();
    if (!notify || state.dirtyNotified) return;
    state.dirtyNotified = true;
    chrome.runtime.sendMessage({
      channel: "page",
      event: "dirty",
      documentId: state.documentId,
      revision: state.revision,
    }).catch(() => undefined);
  }

  function isElementVisible(element) {
    if (element.hidden || element.inert || element.getAttribute("aria-hidden") === "true") return false;
    try {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
    } catch {
      return true;
    }
  }

  function inferRole(element) {
    const explicit = normalizeText(element.getAttribute("role"), 80).split(" ")[0];
    if (explicit) return explicit;
    if (/^H[1-6]$/.test(element.tagName)) return "heading";
    if (element.tagName === "INPUT") {
      const type = String(element.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      return "textbox";
    }
    return NATIVE_ROLES.get(element.tagName) || "";
  }

  function accessibleName(element) {
    const labelledBy = normalizeText(element.getAttribute("aria-labelledby"), 500);
    if (labelledBy) {
      const text = labelledBy.split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .map((value) => normalizeText(value, 500))
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    const ariaLabel = normalizeText(element.getAttribute("aria-label"), 500);
    if (ariaLabel) return ariaLabel;
    const labels = element.labels ? [...element.labels].map((label) => label.textContent).join(" ") : "";
    const labelText = normalizeText(labels, 500);
    if (labelText) return labelText;
    const alternate = normalizeText(element.getAttribute("alt"), 500);
    if (alternate) return alternate;
    const title = normalizeText(element.getAttribute("title"), 500);
    if (title) return title;
    if (["BUTTON", "A", "SUMMARY", "OPTION"].includes(element.tagName)) {
      return normalizeText(element.textContent, 500);
    }
    return "";
  }

  function safeControlValue(element) {
    if (!(["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName))) return undefined;
    const type = String(element.type || "").toLowerCase();
    const autocomplete = String(element.autocomplete || "");
    if (["password", "hidden", "file"].includes(type) ||
        SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return undefined;
    if (type === "checkbox" || type === "radio") return element.checked ? "checked" : "not checked";
    return normalizeText(element.value, 1_000) || undefined;
  }

  function elementBounds(element) {
    try {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        inViewport: rect.bottom > 0 && rect.right > 0 &&
          rect.top < innerHeight && rect.left < innerWidth,
      };
    } catch {
      return undefined;
    }
  }

  function captureSnapshot() {
    const records = [];
    const limitations = new Set();
    let usedCharacters = 0;
    let truncated = false;
    let nextId = 1;

    function addRecord(record) {
      const cost = JSON.stringify(record).length;
      if (usedCharacters + cost > MAX_TEXT_CHARS) {
        truncated = true;
        return null;
      }
      usedCharacters += cost;
      records.push(record);
      return record.ref;
    }

    function visit(node, parentRef = null, inheritedVisible = true) {
      if (truncated || !node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (!inheritedVisible) return;
        const text = normalizeText(node.nodeValue, 2_000);
        if (text) addRecord({ ref: `n${nextId++}`, parentRef, type: "text", text });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || EXCLUDED_TAGS.has(node.tagName)) return;

      const visible = inheritedVisible && isElementVisible(node);
      if (!visible) return;
      const role = inferRole(node);
      const name = accessibleName(node);
      const value = safeControlValue(node);
      const meaningful = Boolean(role || name || value || /^H[1-6]$/.test(node.tagName));
      let nextParent = parentRef;

      if (node.tagName === "CANVAS") limitations.add("Canvas content is not available as text.");
      if (node.tagName === "SVG" && !normalizeText(node.textContent, 100)) {
        limitations.add("Some SVG content may require visual interpretation.");
      }

      if (meaningful) {
        const states = {};
        for (const attribute of ["checked", "disabled", "expanded", "pressed", "readonly", "required", "selected"]) {
          const ariaValue = node.getAttribute(`aria-${attribute}`);
          if (ariaValue !== null) states[attribute] = ariaValue;
        }
        if (node.disabled === true) states.disabled = true;
        if (node.checked === true) states.checked = true;
        const record = {
          ref: `n${nextId++}`,
          parentRef,
          type: "element",
          tag: node.tagName.toLowerCase(),
          ...(role ? { role } : {}),
          ...(name ? { name } : {}),
          ...(value ? { value } : {}),
          ...(node.href ? { href: String(node.href).slice(0, 2_000) } : {}),
          ...(Object.keys(states).length ? { states } : {}),
          ...(elementBounds(node) ? { bounds: elementBounds(node) } : {}),
        };
        nextParent = addRecord(record) || parentRef;
      }

      for (const child of node.childNodes) visit(child, nextParent, visible);
      if (node.shadowRoot?.mode === "open") {
        observeRoot(node.shadowRoot);
        for (const child of node.shadowRoot.childNodes) visit(child, nextParent, visible);
      }
    }

    visit(document.documentElement);
    const selection = normalizeText(globalThis.getSelection?.()?.toString(), 4_000);
    const snapshot = {
      version: 1,
      documentId: state.documentId,
      revision: state.revision,
      capturedAt: new Date().toISOString(),
      url: String(location.href).slice(0, 4_000),
      title: normalizeText(document.title, 1_000),
      language: normalizeText(document.documentElement.lang, 80),
      ...(selection ? { selection } : {}),
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      records,
      limitations: [...limitations],
      truncated,
      stats: { records: records.length, characters: usedCharacters },
    };
    state.cachedSnapshot = snapshot;
    state.dirty = false;
    state.dirtyNotified = false;
    state.lastUrl = location.href;
    return snapshot;
  }

  async function waitForQuiet() {
    const startedAt = performance.now();
    while (performance.now() - state.lastMutationAt < QUIET_MS &&
           performance.now() - startedAt < MAX_QUIET_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const observer = new MutationObserver(markDirty);
  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, OBSERVER_OPTIONS);
  }
  observeRoot(document);
  for (const eventName of ["input", "change", "hashchange", "popstate"]) {
    globalThis.addEventListener(eventName, markDirty, { capture: true, passive: true });
  }
  for (const eventName of ["resize", "scroll"]) {
    globalThis.addEventListener(eventName, () => markDirty({ notify: false }), {
      capture: true,
      passive: true,
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.channel !== "page" || message.method !== "page.snapshot") return false;
    void (async () => {
      if (location.href !== state.lastUrl) markDirty();
      if (state.dirty) await waitForQuiet();
      sendResponse({ ok: true, snapshot: state.dirty || !state.cachedSnapshot
        ? captureSnapshot()
        : state.cachedSnapshot });
    })().catch(() => sendResponse({
      ok: false,
      error: { code: "page_capture_failed", message: "BrowseFriend could not read this page." },
    }));
    return true;
  });
})();
