import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
  }
}

class FakeElement {
  constructor(tagName, attributes = {}, children = []) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.childNodes = children;
    this.hidden = attributes.hidden === "";
    this.inert = false;
    this.type = attributes.type || "";
    this.value = attributes.value || "";
    this.autocomplete = attributes.autocomplete || "";
    this.checked = attributes.checked === "";
    this.disabled = attributes.disabled === "";
    this.href = attributes.href || "";
    this.labels = [];
    this.shadowRoot = null;
    this.lang = attributes.lang || "";
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent ?? child.nodeValue ?? "").join("");
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
  }
}

function createHarness({ largeText = false } = {}) {
  const password = new FakeElement("input", {
    type: "password",
    value: "must-not-leak",
    "aria-label": "Password",
  });
  const textInput = new FakeElement("input", { value: "search terms", "aria-label": "Search" });
  const hidden = new FakeElement("div", { hidden: "" }, [new FakeText("hidden words")]);
  const shadowHost = new FakeElement("div");
  shadowHost.shadowRoot = {
    mode: "open",
    childNodes: [new FakeElement("button", { "aria-label": "Shadow action" })],
  };
  const body = new FakeElement("body", {}, [
    new FakeElement("h1", {}, [new FakeText("Fixture title")]),
    new FakeElement("button", { "aria-label": "Save draft" }),
    textInput,
    password,
    hidden,
    shadowHost,
    new FakeElement("canvas"),
    ...(largeText ? Array.from({ length: 80 }, (_, index) =>
      new FakeText(`large block ${index} ${"x".repeat(1_000)}`)) : []),
  ]);
  const root = new FakeElement("html", { lang: "en" }, [body]);
  const messageListeners = [];
  const sentMessages = [];
  const windowListeners = new Map();
  let observerCallback;
  let clock = 0;
  const document = {
    documentElement: root,
    title: "Fixture page",
    getElementById() { return null; },
  };
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { messageListeners.push(listener); } },
        async sendMessage(message) { sentMessages.push(message); },
      },
    },
    crypto: { randomUUID: () => "document-1" },
    document,
    location: { href: "https://example.test/page" },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    getSelection: () => ({ toString: () => "selected text" }),
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    innerWidth: 1280,
    innerHeight: 720,
    scrollX: 0,
    scrollY: 0,
    performance: { now: () => clock },
    setTimeout(callback, delay) {
      clock += delay;
      callback();
    },
    Date,
    console,
  });
  return { context, messageListeners, observer: () => observerCallback(), sentMessages, windowListeners };
}

async function capture(listener) {
  return new Promise((resolve) => {
    const keepOpen = listener({ channel: "page", method: "page.snapshot" }, {}, resolve);
    assert.equal(keepOpen, true);
  });
}

test("page reader produces semantic context without sensitive or hidden values", async () => {
  const harness = createHarness();
  const source = await readFile(
    new URL("../../extension/page/read/content-script.js", import.meta.url),
    "utf8",
  );
  vm.runInContext(source, harness.context, { filename: "content-script.js" });

  const response = JSON.parse(JSON.stringify(await capture(harness.messageListeners[0])));
  const serialized = JSON.stringify(response.snapshot);

  assert.equal(response.ok, true);
  assert.equal(response.snapshot.documentId, "document-1");
  assert.equal(response.snapshot.selection, "selected text");
  assert.match(serialized, /Fixture title/);
  assert.match(serialized, /Save draft/);
  assert.match(serialized, /Shadow action/);
  assert.match(serialized, /search terms/);
  assert.doesNotMatch(serialized, /must-not-leak|hidden words/);
  assert.deepEqual(response.snapshot.limitations, ["Canvas content is not available as text."]);
});

test("page reader marks cached snapshots dirty and advances their revision", async () => {
  const harness = createHarness();
  const source = await readFile(
    new URL("../../extension/page/read/content-script.js", import.meta.url),
    "utf8",
  );
  vm.runInContext(source, harness.context, { filename: "content-script.js" });
  const first = await capture(harness.messageListeners[0]);

  harness.observer();
  const second = await capture(harness.messageListeners[0]);

  assert.ok(second.snapshot.revision > first.snapshot.revision);
  const firstElements = first.snapshot.records.filter((record) => record.type === "element").map((record) => record.ref);
  const secondElements = second.snapshot.records.filter((record) => record.type === "element").map((record) => record.ref);
  assert.deepEqual(secondElements, firstElements);
  assert.equal(harness.sentMessages[0].event, "dirty");
});

test("page reader bounds oversized documents and reports truncation", async () => {
  const harness = createHarness({ largeText: true });
  const source = await readFile(
    new URL("../../extension/page/read/content-script.js", import.meta.url),
    "utf8",
  );
  vm.runInContext(source, harness.context, { filename: "content-script.js" });

  const response = await capture(harness.messageListeners[0]);

  assert.equal(response.snapshot.truncated, true);
  assert.ok(JSON.stringify(response.snapshot).length < 128 * 1024);
});

test("scrolling refreshes cached geometry without marking page content stale", async () => {
  const harness = createHarness();
  const source = await readFile(
    new URL("../../extension/page/read/content-script.js", import.meta.url),
    "utf8",
  );
  vm.runInContext(source, harness.context, { filename: "content-script.js" });
  const first = await capture(harness.messageListeners[0]);

  harness.windowListeners.get("scroll")();
  const second = await capture(harness.messageListeners[0]);

  assert.ok(second.snapshot.revision > first.snapshot.revision);
  assert.deepEqual(harness.sentMessages, []);
});
