import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCENT_KEY,
  DEBUG_MODE_KEY,
  MODEL_KEY,
  REASONING_KEY,
  THEME_KEY,
  applyAccent,
  applyTheme,
  createPreferences,
  normalizeAccent,
  normalizeModel,
  normalizeReasoningPreference,
  normalizeTheme,
  shouldShowPageContext,
} from "../../extension/settings/preferences.js";
import {
  reasoningEffortOptions,
  selectReasoningEffort,
} from "../../shared/reasoning.js";

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
    accent: "blue",
    model: "automatic",
    reasoningEffort: "model_default",
  });
  assert.deepEqual(await createHarness({
    [DEBUG_MODE_KEY]: "true",
    [THEME_KEY]: "sepia",
    [ACCENT_KEY]: "pink",
    [MODEL_KEY]: " ",
    [REASONING_KEY]: "extreme",
  }).preferences.load(), {
    debugMode: false,
    theme: "system",
    accent: "blue",
    model: "automatic",
    reasoningEffort: "model_default",
  });
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme("dark"), "dark");
  assert.equal(normalizeAccent("cyan"), "cyan");
  assert.equal(normalizeAccent("pink"), "blue");
  assert.equal(normalizeModel("model-1"), "model-1");
  assert.equal(normalizeModel("x".repeat(201)), "automatic");
  assert.equal(normalizeReasoningPreference("minimal"), "minimal");
  assert.equal(normalizeReasoningPreference("xlow"), "model_default");
  assert.equal(normalizeReasoningPreference("automatic"), "model_default");
});

test("settings persist normalized local preferences", async () => {
  const harness = createHarness();

  assert.equal(await harness.preferences.saveDebugMode(true), true);
  assert.equal(await harness.preferences.saveTheme("dark"), "dark");
  assert.equal(await harness.preferences.saveTheme("unknown"), "system");
  assert.equal(await harness.preferences.saveAccent("purple"), "purple");
  assert.equal(await harness.preferences.saveAccent("pink"), "blue");
  assert.equal(await harness.preferences.saveModel("model-2"), "model-2");
  assert.equal(await harness.preferences.saveReasoningEffort("xhigh"), "xhigh");
  assert.equal(await harness.preferences.saveReasoningEffort("automatic"), "model_default");
  assert.deepEqual(harness.writes, [
    { [DEBUG_MODE_KEY]: true },
    { [THEME_KEY]: "dark" },
    { [THEME_KEY]: "system" },
    { [ACCENT_KEY]: "purple" },
    { [ACCENT_KEY]: "blue" },
    { [MODEL_KEY]: "model-2" },
    { [REASONING_KEY]: "xhigh" },
    { [REASONING_KEY]: "model_default" },
  ]);
});

test("legacy Automatic reasoning migrates to Model default", async () => {
  const harness = createHarness({ [REASONING_KEY]: "automatic" });

  assert.equal((await harness.preferences.load()).reasoningEffort, "model_default");
  assert.deepEqual(harness.writes, [{ [REASONING_KEY]: "model_default" }]);
});

test("reasoning options follow the model from highest to lowest", () => {
  const model = {
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  };

  assert.deepEqual(reasoningEffortOptions(model), [
    { value: "model_default", label: "Model default (medium)" },
    { value: "max", label: "Maximum" },
    { value: "xhigh", label: "Extra high" },
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
  ]);
  assert.deepEqual(reasoningEffortOptions({}), [
    { value: "model_default", label: "Model default" },
  ]);
  assert.equal(selectReasoningEffort(model, "model_default"), undefined);
  assert.equal(selectReasoningEffort(model, "high"), "high");
  assert.equal(selectReasoningEffort(model, "minimal"), undefined);
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
    [ACCENT_KEY]: { newValue: "cyan" },
    [MODEL_KEY]: { newValue: "model-2" },
    [REASONING_KEY]: { newValue: "low" },
  }, "local");
  harness.storageChanged.emit({
    [THEME_KEY]: { newValue: "sepia" },
    [ACCENT_KEY]: { newValue: "pink" },
  }, "local");
  assert.deepEqual(received, [
    {
      debugMode: true,
      theme: "light",
      accent: "cyan",
      model: "model-2",
      reasoningEffort: "low",
    },
    { theme: "system", accent: "blue" },
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

test("accent application always exposes a normalized root attribute", () => {
  const root = { dataset: {} };
  assert.equal(applyAccent(root, "purple"), "purple");
  assert.equal(root.dataset.accent, "purple");
  assert.equal(applyAccent(root, "unknown"), "blue");
  assert.equal(root.dataset.accent, "blue");
});

test("page context visibility requires Debug mode and a user context attachment", () => {
  const userMessage = { role: "user", context: { snapshot: { title: "Page" } } };
  assert.equal(shouldShowPageContext(false, userMessage), false);
  assert.equal(shouldShowPageContext(true, userMessage), true);
  assert.equal(shouldShowPageContext(true, { role: "assistant", context: {} }), false);
  assert.equal(shouldShowPageContext(true, { role: "user" }), false);
});
