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

async function createPanel(t, { connection, initialRequest, resetError, submitError, initialPreferences = {} } = {}) {
  const html = await readFile(new URL("../../extension/sidepanel/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html);
  const { document } = dom.window;
  document.hasFocus = () => true;
  const frames = [];
  const requests = [];
  const writes = [];
  const listeners = [];
  const refresh = deferred();
  const models = [{ slug: "model-1", displayName: "First Model" }];
  let state = {
    connection: connection || { phase: "ready", auth: { state: "signed_in" } },
    modelPreference: "automatic", reasoningPreference: "model_default",
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
          if (method === "app.submit" && submitError) return { ok: false, error: submitError };
          if (method === "app.state" && initialRequest) await initialRequest.promise;
          if (method === "app.resetLogin") {
            if (resetError) return { ok: false, error: resetError };
            state = { ...state, connection: { phase: "auth_required", auth: { state: "signed_out" }, error: null }, messages: [], models: [] };
            return { ok: true, result: { state, warning: null } };
          }
          return method === "app.models" ? refresh.promise : { ok: true, result: state };
        },
      },
      storage: {
        local: { async get() { return initialPreferences; }, async set(values) { writes.push(values); } },
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
    document, content, requests, writes,
    click(id) { document.querySelector(`#${id}`).click(); },
    frame() { frames.splice(0).forEach((callback) => callback(0)); },
    async updateState(update) {
      state = { ...state, ...update };
      listeners.forEach((listener) => listener({ channel: "app", event: "state", state }));
      await settle();
    },
    async finishRefresh(error = null) {
      refresh.resolve(error ? { ok: false, error } : { ok: true, result: state });
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


test("damaged saved login exposes a cancel-first reset and returns to explicit sign-in", async (t) => {
  const panel = await createPanel(t, { connection: {
    phase: "error", auth: { state: "signed_out" },
    error: { code: "credentials_invalid", message: "The saved login is damaged." },
  } });
  panel.click("open-settings");
  const reset = panel.document.querySelector("#reset-login");
  const modal = panel.document.querySelector("#reset-login-confirmation");
  assert.equal(reset.hidden, false);
  assert.equal(panel.document.querySelector("#settings-sign-in").disabled, true);
  panel.click("reset-login"); panel.frame();
  assert.equal(modal.hidden, false);
  assert.equal(panel.document.activeElement.id, "cancel-reset-login");
  assert.equal(panel.document.querySelector("#view-stack").inert, true);
  panel.document.dispatchEvent(new panel.document.defaultView.KeyboardEvent("keydown", { key: "Tab" }));
  assert.equal(panel.document.activeElement.id, "confirm-reset-login");
  panel.document.dispatchEvent(new panel.document.defaultView.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(modal.hidden, true);
  assert.equal(panel.requests.some(({ method }) => method === "app.resetLogin"), false);
  panel.click("reset-login"); panel.frame(); panel.click("confirm-reset-login");
  await settle();
  assert.equal(modal.hidden, true);
  assert.equal(reset.hidden, true);
  assert.equal(panel.document.querySelector("#settings-sign-in").disabled, false);
  assert.equal(panel.document.activeElement.id, "settings-sign-in");
  assert.equal(panel.requests.filter(({ method }) => method === "app.resetLogin").length, 1);
  assert.equal(panel.requests.some(({ method }) => method === "app.signIn"), false);
});

test("storage and network errors never expose destructive reset", async (t) => {
  const panel = await createPanel(t);
  for (const code of ["storage_unavailable", "storage_unsafe", "registration_invalid", "companion_unavailable"]) {
    await panel.updateState({ connection: { phase: "error", auth: { state: "signed_out" }, error: { code, message: "Retry after fixing the problem." } } });
    assert.equal(panel.document.querySelector("#reset-login").hidden, true);
    assert.equal(panel.document.querySelector("#settings-sign-in").disabled, code !== "companion_unavailable");
  }
});

test("failed reset displays storage failure without claiming the saved login was cleared", async (t) => {
  const panel = await createPanel(t, {
    connection: { phase: "error", auth: { state: "signed_out" }, error: { code: "credentials_version_unsupported", message: "Unsupported saved login." } },
    resetError: { code: "storage_unavailable", message: "Check permissions and available disk space." },
  });
  panel.click("open-settings"); panel.click("reset-login"); panel.frame(); panel.click("confirm-reset-login");
  await settle();
  assert.equal(panel.document.querySelector("#reset-login-confirmation").hidden, true);
  assert.equal(panel.document.querySelector("#reset-login").hidden, false);
  assert.match(panel.document.querySelector("#settings-auth-error").textContent, /Check permissions/);
});


test("an uncertain submit reconciles state without replaying the prompt", async (t) => {
  const panel = await createPanel(t, { submitError: { code: "app_unavailable", message: "Reply was lost.", retryable: true } });
  const input = panel.document.querySelector("#message-input");
  input.value = "Do this once";
  panel.document.querySelector("#composer").dispatchEvent(new panel.document.defaultView.Event("submit"));
  await settle();
  assert.equal(input.value, "Do this once");
  panel.frame();
  assert.equal(panel.document.activeElement.id, "retry-operation");
  assert.equal(input.disabled, true);
  assert.equal(panel.document.querySelector("#retry-operation").hidden, false);
  const statesBefore = panel.requests.filter(({ method }) => method === "app.state").length;
  panel.click("retry-operation");
  await settle();
  assert.equal(panel.requests.filter(({ method }) => method === "app.submit").length, 1);
  assert.equal(panel.requests.filter(({ method }) => method === "app.state").length, statesBefore + 1);
  assert.equal(input.disabled, false);
  assert.equal(input.value, "Do this once");
});

test("rendering a model with an unsupported saved effort never writes preferences", async (t) => {
  const panel = await createPanel(t, { initialPreferences: { "browsefriend.settings.reasoningEffort": "high" } });
  await panel.updateState({ reasoningPreference: "high" });
  assert.equal(panel.requests.some(({ method }) => ["app.setModel", "app.setReasoningEffort"].includes(method)), false);
  assert.equal(panel.writes.some((values) => Object.keys(values).some((key) =>
    ["browsefriend.settings.model", "browsefriend.settings.reasoningEffort"].includes(key))), false);
});
