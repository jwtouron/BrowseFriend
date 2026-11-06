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

async function createPanel(t, { connection, initialRequest } = {}) {
  const html = await readFile(new URL("../../extension/sidepanel/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html);
  const { document } = dom.window;
  document.hasFocus = () => true;
  const frames = [];
  const requests = [];
  const listeners = [];
  const refresh = deferred();
  const models = [{ slug: "model-1", displayName: "First Model" }];
  const modelResult = { models, preference: "automatic" };
  let state = {
    connection: connection || { phase: "ready", auth: { state: "signed_in" } },
    messages: [], models, mode: "ask", submission: null, issue: null,
  };
  const globals = {
    document,
    requestAnimationFrame(callback) { return frames.push(callback); },
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { listeners.push(listener); } },
        async sendMessage(message) {
          const { method } = message;
          requests.push(message);
          if (method === "app.state" && initialRequest) await initialRequest.promise;
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
    document, content, requests,
    click(id) { document.querySelector(`#${id}`).click(); },
    frame() { frames.splice(0).forEach((callback) => callback(0)); },
    async updateState(update) {
      state = { ...state, ...update };
      listeners.forEach((listener) => listener({ channel: "app", event: "state", state }));
      await settle();
    },
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

test("startup keeps chat visible and Settings accessible without accepting prompts before readiness", async (t) => {
  const initialRequest = deferred();
  const panel = await createPanel(t, {
    connection: { phase: "checking", auth: { state: "loading" } },
    initialRequest,
  });
  const input = panel.document.querySelector("#message-input");
  function assertComposerDisabled(disabled) {
    for (const selector of ["#message-input", "#send-message", "#mode-switch", ".suggestion"]) {
      assert.equal(panel.document.querySelector(selector).disabled, disabled, selector);
    }
  }
  assertComposerDisabled(true);
  assert.equal(panel.document.querySelector("#chat-content").hidden, false);
  assert.equal(panel.document.querySelector("#open-settings").disabled, false);
  panel.click("open-settings");
  assert.equal(panel.document.querySelector("#settings-view").getAttribute("aria-hidden"), "false");
  assert.equal(panel.requests.some(({ method }) => method === "app.models"), false);
  panel.click("close-settings");
  panel.frame();
  assert.equal(panel.document.activeElement.id, "open-settings");

  initialRequest.resolve();
  await settle();
  input.value = "A draft must not become a pending request";
  panel.document.querySelector("#composer").dispatchEvent(new panel.document.defaultView.Event("submit"));
  assert.equal(panel.requests.some(({ method }) => method === "app.submit"), false);

  await panel.updateState({
    connection: { phase: "auth_required", auth: { state: "signed_out" } },
    issue: { kind: "action", action: "sign_in", title: "Sign in", message: "Connect your account." },
  });
  panel.frame();
  assertComposerDisabled(true);
  assert.equal(panel.document.activeElement.id, "sign-in");

  await panel.updateState({
    connection: { phase: "checking", auth: { state: "signing_in" } },
    issue: { kind: "action", action: "cancel_sign_in", title: "Signing in", message: "Finish in the browser." },
  });
  panel.frame();
  assertComposerDisabled(true);
  assert.equal(panel.document.activeElement.id, "cancel-sign-in");

  await panel.updateState({ connection: { phase: "checking", auth: { state: "signed_in" } }, issue: null });
  panel.frame();
  assertComposerDisabled(true);

  await panel.updateState({ connection: { phase: "ready", auth: { state: "signed_in" } } });
  panel.frame();
  assertComposerDisabled(false);
  assert.equal(panel.document.activeElement.id, "message-input");
  assert.equal(input.value, "A draft must not become a pending request");
  assert.equal(panel.requests.some(({ method }) => method === "app.submit"), false);
});

test("connection loss disables submission, preserves the draft, and recovery never sends it", async (t) => {
  const panel = await createPanel(t);
  const input = panel.document.querySelector("#message-input");
  input.value = "Keep this draft";
  await panel.updateState({
    connection: { phase: "error", auth: { state: "signed_in" } },
    issue: { kind: "error", scope: "connection", error: { message: "Companion unavailable." }, retry: "connection" },
  });
  panel.frame();
  assert.equal(input.disabled, true);
  assert.equal(input.value, "Keep this draft");
  assert.equal(panel.document.querySelector("#mode-switch").disabled, true);
  assert.equal(panel.document.activeElement.id, "retry-operation");

  await panel.updateState({ connection: { phase: "ready", auth: { state: "signed_in" } }, issue: null });
  panel.frame();
  assert.equal(input.disabled, false);
  assert.equal(input.value, "Keep this draft");
  assert.equal(panel.document.activeElement.id, "message-input");
  assert.equal(panel.requests.some(({ method }) => method === "app.submit"), false);
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
