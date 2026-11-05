import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

let fixtureId = 0;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function createPanel(t) {
  const html = await readFile(new URL("../../extension/sidepanel/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const frames = [];
  const refresh = deferred();
  const models = [{ slug: "model-1", displayName: "First Model" }];
  const modelResult = { models, preference: "automatic" };
  const state = {
    connection: { phase: "ready", auth: { state: "signed_in" } },
    messages: [], models, mode: "ask", submission: null, issue: null,
  };
  const globals = {
    document,
    requestAnimationFrame(callback) { return frames.push(callback); },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage({ method }) {
          return method === "app.models" ? refresh.promise : { ok: true, result: state };
        },
      },
      storage: {
        local: { async get() { return {}; }, async set() {} },
        onChanged: { addListener() {} },
      },
    },
  };
  const previous = Object.fromEntries(Object.keys(globals)
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  });
  await import(`../../extension/sidepanel/index.js?fixture=${++fixtureId}`);
  await settle();

  const content = document.querySelector(".settings-content");
  const section = document.querySelector("#model-settings");
  // jsdom has no layout: simulate a Model section below the Settings viewport.
  content.getBoundingClientRect = () => ({ top: 50 });
  section.getBoundingClientRect = () => ({ top: 650 - content.scrollTop });
  content.scrollTop = 250;
  return {
    document, content,
    click(id) { document.querySelector(`#${id}`).click(); },
    frame() { frames.splice(0).forEach((callback) => callback(0)); },
    async finishRefresh(error = null) {
      refresh.resolve(error ? { ok: false, error } : { ok: true, result: modelResult });
      await settle();
    },
  };
}

test("model shortcut scrolls while refreshing, then focuses the model selector", async (t) => {
  const panel = await createPanel(t);
  panel.click("model-summary");
  assert.equal(panel.document.querySelector("#settings-view").getAttribute("aria-hidden"), "false");
  assert.equal(panel.document.querySelector("#chat-view").inert, true);
  assert.equal(panel.document.querySelector("#model-select").disabled, true);
  panel.frame();
  assert.equal(panel.content.scrollTop, 600);
  assert.equal(panel.document.querySelector("#view-stack").scrollLeft, 0);
  await panel.finishRefresh();
  assert.equal(panel.document.activeElement.id, "model-select");
  assert.equal(panel.content.scrollTop, 600);
});

test("model shortcut still reveals Model settings when model refresh fails", async (t) => {
  const panel = await createPanel(t);
  panel.click("model-summary");
  await panel.finishRefresh({ message: "Models unavailable." });
  panel.frame();
  assert.equal(panel.content.scrollTop, 600);
  assert.equal(panel.document.querySelector("#model-settings-error").hidden, false);
  assert.equal(panel.document.activeElement.id, "close-settings");
});

test("ordinary Settings navigation preserves scroll position and focuses Back", async (t) => {
  const panel = await createPanel(t);
  panel.click("open-settings");
  panel.frame();
  await panel.finishRefresh();
  assert.equal(panel.content.scrollTop, 250);
  assert.equal(panel.document.activeElement.id, "close-settings");
});

test("leaving and reopening Settings cancels a pending model shortcut", async (t) => {
  const panel = await createPanel(t);
  panel.click("model-summary");
  panel.click("close-settings");
  panel.frame();
  assert.equal(panel.content.scrollTop, 250);
  assert.equal(panel.document.querySelector("#settings-view").getAttribute("aria-hidden"), "true");
  panel.click("open-settings");
  await panel.finishRefresh();
  assert.equal(panel.content.scrollTop, 250);
  assert.equal(panel.document.activeElement.id, "close-settings");
});
