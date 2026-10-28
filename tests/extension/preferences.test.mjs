import assert from "node:assert/strict";
import test from "node:test";
import {
  DEBUG_MODE_KEY,
  MODEL_KEY,
  THEME_KEY,
  applyTheme,
  createPreferences,
  normalizeModel,
  normalizeTheme,
  shouldShowPageContext,
} from "../../extension/settings/preferences.js";

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(...args) { listeners.forEach((listener) => listener(...args)); },
    count: () => listeners.length,
  };
}

function createHarness(initial = {}) {
  const stored = { ...initial };
  const storageChanged = createEvent();
  const writes = [];
  const storageArea = {
    async get(keys) {
      return Object.fromEntries(keys.map((key) => [key, stored[key]]));
    },
    async set(values) {
      writes.push(values);
      Object.assign(stored, values);
    },
  };
  const preferences = createPreferences({ storageArea, storageChanged });
  return { preferences, storageChanged, writes };
}

test("settings default safely and normalize stored values", async () => {
  assert.deepEqual(await createHarness().preferences.load(), {
    debugMode: false,
    theme: "system",
    model: "automatic",
  });
  assert.deepEqual(await createHarness({
    [DEBUG_MODE_KEY]: "true",
    [THEME_KEY]: "sepia",
    [MODEL_KEY]: " ",
  }).preferences.load(), {
    debugMode: false,
    theme: "system",
    model: "automatic",
  });
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme("dark"), "dark");
  assert.equal(normalizeModel("model-1"), "model-1");
  assert.equal(normalizeModel("x".repeat(201)), "automatic");
});

test("settings persist normalized local preferences", async () => {
  const harness = createHarness();

  assert.equal(await harness.preferences.saveDebugMode(true), true);
  assert.equal(await harness.preferences.saveTheme("dark"), "dark");
  assert.equal(await harness.preferences.saveTheme("unknown"), "system");
  assert.equal(await harness.preferences.saveModel("model-2"), "model-2");
  assert.deepEqual(harness.writes, [
    { [DEBUG_MODE_KEY]: true },
    { [THEME_KEY]: "dark" },
    { [THEME_KEY]: "system" },
    { [MODEL_KEY]: "model-2" },
  ]);
});

test("settings subscriptions normalize local changes and can unsubscribe", () => {
  const harness = createHarness();
  const received = [];
  const unsubscribe = harness.preferences.subscribe((update) => received.push(update));

  harness.storageChanged.emit({ [THEME_KEY]: { newValue: "dark" } }, "sync");
  harness.storageChanged.emit({ unrelated: { newValue: true } }, "local");
  harness.storageChanged.emit({
    [DEBUG_MODE_KEY]: { newValue: true },
    [THEME_KEY]: { newValue: "light" },
    [MODEL_KEY]: { newValue: "model-2" },
  }, "local");
  harness.storageChanged.emit({ [THEME_KEY]: { newValue: "sepia" } }, "local");
  assert.deepEqual(received, [
    { debugMode: true, theme: "light", model: "model-2" },
    { theme: "system" },
  ]);

  unsubscribe();
  assert.equal(harness.storageChanged.count(), 0);
});

test("theme application uses no override for System and attributes for explicit themes", () => {
  const root = { dataset: {} };
  assert.equal(applyTheme(root, "dark"), "dark");
  assert.equal(root.dataset.theme, "dark");
  assert.equal(applyTheme(root, "light"), "light");
  assert.equal(root.dataset.theme, "light");
  assert.equal(applyTheme(root, "system"), "system");
  assert.equal("theme" in root.dataset, false);
});

test("page context visibility requires Debug mode and a user context attachment", () => {
  const userMessage = { role: "user", context: { snapshot: { title: "Page" } } };
  assert.equal(shouldShowPageContext(false, userMessage), false);
  assert.equal(shouldShowPageContext(true, userMessage), true);
  assert.equal(shouldShowPageContext(true, { role: "assistant", context: {} }), false);
  assert.equal(shouldShowPageContext(true, { role: "user" }), false);
});
