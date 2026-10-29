import assert from "node:assert/strict";
import test from "node:test";
import { installPageActor } from "../../extension/page/act/background.js";

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { listeners.forEach((listener) => listener(...args)); },
  };
}

test("page actor installs once, binds messages to snapshot identity, and sanitizes file events", async () => {
  const onMessage = createEvent();
  const dirty = [];
  const executions = [];
  const styles = [];
  const sends = [];
  const runtime = { id: "extension", onMessage };
  const pageReader = { onDirty(listener) { dirty.push(listener); } };
  const actor = installPageActor({
    runtime,
    pageReader,
    tabs: {
      async sendMessage(tabId, message) {
        sends.push({ tabId, message });
        return { ok: true, result: { kind: "click", target: "Go" } };
      },
    },
    scripting: {
      async executeScript(options) { executions.push(options); },
      async insertCSS(options) { styles.push(options); },
    },
  });
  const context = { available: true, tabId: 7, documentId: "doc-1", revision: 4 };

  await actor.prepare({ name: "page_click", args: { ref: "e1" } }, context);
  await actor.execute({ name: "page_click", args: { ref: "e1" } }, context);
  assert.equal(executions.length, 1);
  assert.equal(styles.length, 1);
  assert.equal(sends[0].message.documentId, "doc-1");
  assert.equal(sends[0].message.revision, 4);

  const files = [];
  actor.onFileSelection((event) => files.push(event));
  onMessage.emit({
    channel: "pageAct",
    event: "fileSelection",
    documentId: "doc-1",
    revision: 5,
    ref: "e2",
    count: 2,
    fileName: "private.png",
  }, { id: "extension", frameId: 0, tab: { id: 7 } });
  assert.deepEqual(files, [{
    tabId: 7,
    documentId: "doc-1",
    revision: 5,
    ref: "e2",
    cancelled: false,
    count: 2,
  }]);
});
