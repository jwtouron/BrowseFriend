import assert from "node:assert/strict";
import test from "node:test";
import { composerShortcut, createPromptHistory } from "../../extension/chat/prompt-history.js";

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
