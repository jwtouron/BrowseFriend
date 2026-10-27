import assert from "node:assert/strict";
import test from "node:test";
import { composerShortcut, createPromptHistory } from "../../extension/chat/prompt-history.js";
import { chatFocusTarget, shouldRestoreComposerFocus } from "../../extension/sidepanel/focus.js";

test("prompt history traverses duplicate entries by index and returns to blank", () => {
  const history = createPromptHistory();
  history.sync(["same", "middle", "same"]);

  assert.equal(history.previous("  \n"), "same");
  assert.equal(history.previous("same"), "middle");
  assert.equal(history.previous("middle"), "same");
  assert.equal(history.previous("same"), "same");
  assert.equal(history.next(), "middle");
  assert.equal(history.next(), "same");
  assert.equal(history.next(), "");
  assert.equal(history.isNavigating(), false);
});

test("prompt history starts only from whitespace and typing resets navigation", () => {
  const history = createPromptHistory();
  history.sync(["first", "second"]);

  assert.equal(history.previous("draft"), null);
  assert.equal(history.next(), null);
  assert.equal(history.previous(""), "second");
  history.reset();
  assert.equal(history.next(), null);
  assert.equal(history.previous("edited prompt"), null);
});

test("prompt history preserves its cursor when synchronized prompts are unchanged", () => {
  const history = createPromptHistory();
  history.sync(["first", "second"]);
  assert.equal(history.previous(""), "second");

  assert.equal(history.sync(["first", "second"]), false);
  assert.equal(history.previous("second"), "first");

  assert.equal(history.sync(["new"]), true);
  assert.equal(history.next(), null);
  assert.equal(history.previous(""), "new");
});

test("composer shortcuts accept only the intended unmodified and Control keys", () => {
  assert.equal(composerShortcut({ key: "ArrowUp" }), "previous");
  assert.equal(composerShortcut({ key: "ArrowDown" }), "next");
  assert.equal(composerShortcut({ key: "p", ctrlKey: true }), "previous");
  assert.equal(composerShortcut({ key: "N", ctrlKey: true }), "next");
  assert.equal(composerShortcut({ key: "u", ctrlKey: true }), "clear");
  assert.equal(composerShortcut({ key: "Backspace", ctrlKey: true }), null);
  assert.equal(composerShortcut({ key: "ArrowUp", shiftKey: true }), null);
  assert.equal(composerShortcut({ key: "p", metaKey: true }), null);
  assert.equal(composerShortcut({ key: "p", ctrlKey: true, isComposing: true }), null);
});

test("chat focus targets reflect authentication and generation state", () => {
  assert.equal(chatFocusTarget({ authState: "signed_in", generating: false }), "composer");
  assert.equal(chatFocusTarget({ authState: "signed_in", generating: true }), "stop");
  assert.equal(chatFocusTarget({ authState: "signed_out", generating: false }), "signIn");
  assert.equal(chatFocusTarget({ authState: "signing_in", generating: false }), "cancelSignIn");
  assert.equal(chatFocusTarget({ authState: "loading", generating: false }), "settings");
});

test("completion focus is restored only on an unobstructed focused chat", () => {
  const ready = {
    wasGenerating: true,
    generating: false,
    documentHasFocus: true,
    authState: "signed_in",
    settingsOpen: false,
    contextViewerOpen: false,
    planWelcomeOpen: false,
    chatVisible: true,
  };
  assert.equal(shouldRestoreComposerFocus(ready), true);
  for (const change of [
    { wasGenerating: false },
    { generating: true },
    { documentHasFocus: false },
    { authState: "signed_out" },
    { settingsOpen: true },
    { contextViewerOpen: true },
    { planWelcomeOpen: true },
    { chatVisible: false },
  ]) {
    assert.equal(shouldRestoreComposerFocus({ ...ready, ...change }), false);
  }
});
