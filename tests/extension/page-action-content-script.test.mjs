import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.type = attributes.type || "";
    this.autocomplete = attributes.autocomplete || "";
    this.name = attributes.name || "";
    this.id = attributes.id || "";
    this.href = attributes.href || "";
    this.textContent = attributes.text || "";
    this.disabled = false;
    this.isConnected = true;
    this.labels = [];
    this.parentElement = null;
    this.form = null;
    this.files = [];
    this.listeners = new Map();
    this.classNames = new Set();
    this.classList = {
      add: (name) => this.classNames.add(name),
      contains: (name) => this.classNames.has(name),
      remove: (name) => this.classNames.delete(name),
    };
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  focus() {}

  scrollIntoView() {}
}

function createHarness(elements) {
  const listeners = [];
  const reader = {
    documentId: "doc-1",
    revision: 3,
    dirty: false,
    elementsByRef: new Map(elements),
    async waitForQuiet() {},
  };
  const context = vm.createContext({
    __browseFriendReadMode: reader,
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { listeners.push(listener); } },
        async sendMessage() {},
      },
    },
    document: { documentElement: { scrollHeight: 2_000 } },
    location: { href: "https://example.test/form" },
    URL,
    Map,
    WeakMap,
    Event,
    HTMLInputElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    performance,
    setTimeout,
    innerHeight: 800,
    scrollBy() {},
    scrollTo() {},
    console,
  });
  return { context, listeners, reader };
}

async function prepare(listener, call, overrides = {}) {
  return new Promise((resolve) => {
    listener({
      channel: "pageAct",
      method: "page.action.prepare",
      documentId: "doc-1",
      revision: 3,
      call,
      ...overrides,
    }, {}, resolve);
  });
}

async function request(listener, method, call = null) {
  return new Promise((resolve) => {
    listener({
      channel: "pageAct",
      method,
      documentId: "doc-1",
      revision: 3,
      call,
    }, {}, resolve);
  });
}

async function install(harness) {
  const source = await readFile(
    new URL("../../extension/page/act/content-script.js", import.meta.url),
    "utf8",
  );
  vm.runInContext(source, harness.context, { filename: "act-content-script.js" });
  return harness.listeners[0];
}

test("page action preparation confirms ambiguous buttons and detected downloads", async () => {
  const button = new FakeElement("button", { text: "Delete account" });
  const download = new FakeElement("a", {
    text: "Download report",
    href: "https://example.test/files/report",
  });
  const harness = createHarness([["e1", button], ["e2", download]]);
  const listener = await install(harness);

  const buttonResult = await prepare(listener, { name: "page_click", args: { ref: "e1" } });
  assert.equal(buttonResult.result.requiresConfirmation, true);
  assert.equal(buttonResult.result.kind, "click");

  const downloadResult = await prepare(listener, { name: "page_click", args: { ref: "e2" } });
  assert.equal(downloadResult.result.requiresConfirmation, true);
  assert.equal(downloadResult.result.kind, "download");
});

test("page action preparation blocks sensitive fields and stale revisions", async () => {
  const password = new FakeElement("input", {
    type: "password",
    "aria-label": "Password",
  });
  const harness = createHarness([["e1", password]]);
  const listener = await install(harness);

  const sensitive = await prepare(listener, {
    name: "page_fill",
    args: { ref: "e1", value: "must-not-enter" },
  });
  assert.equal(sensitive.ok, false);
  assert.equal(sensitive.error.code, "sensitive_target");

  const stale = await prepare(listener, { name: "page_click", args: { ref: "e1" } }, { revision: 2 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "stale_page");
});

test("cancelling file selection removes its highlight and DOM listeners", async () => {
  const input = new FakeElement("input", { type: "file", "aria-label": "Photo" });
  const harness = createHarness([["e1", input]]);
  const listener = await install(harness);

  const started = await request(listener, "page.action.execute", {
    name: "page_choose_file",
    args: { ref: "e1" },
  });
  assert.equal(started.result.waitingForUser, true);
  assert.equal(input.classList.contains("browsefriend-file-target"), true);
  assert.equal(input.listeners.get("change").size, 1);
  assert.equal(input.listeners.get("cancel").size, 1);

  const cancelled = await request(listener, "page.action.cancelFile");
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(input.classList.contains("browsefriend-file-target"), false);
  assert.equal(input.listeners.get("change").size, 0);
  assert.equal(input.listeners.get("cancel").size, 0);
});
