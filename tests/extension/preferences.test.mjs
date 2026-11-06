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
  effectiveReasoningEffort,
  reasoningEffortLabel,
  reasoningEffortOptions,
  selectReasoningEffort,
} from "../../shared/reasoning.js";
import {
  automaticModelLabel,
  selectModel,
} from "../../shared/model-selection.js";
import { normalizeTypography, TYPOGRAPHY_FIELDS } from "../../extension/settings/typography.js";

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
    ...normalizeTypography(),
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
    ...normalizeTypography(),
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

test("typography fields save independently and storage changes normalize without rewriting other fields", async () => {
  const harness = createHarness({
    [TYPOGRAPHY_FIELDS.promptFont.key]: "Some Font",
    [TYPOGRAPHY_FIELDS.promptBold.key]: true,
    [TYPOGRAPHY_FIELDS.responseFontSize.key]: 36,
  });
  const loaded = await harness.preferences.load();
  assert.equal(loaded.promptFont, "Some Font");
  assert.equal(loaded.promptBold, true);
  assert.equal(loaded.responseFontSize, 36);
  harness.writes.length = 0;
  await harness.preferences.saveTypography("promptFontSize", 18);
  await harness.preferences.saveTypography("responseFontSize", 25);
  assert.deepEqual(harness.writes, [
    { [TYPOGRAPHY_FIELDS.promptFontSize.key]: 18 },
    { [TYPOGRAPHY_FIELDS.responseFontSize.key]: "default" },
  ]);
  await assert.rejects(harness.preferences.saveTypography("responseBold", true), TypeError);
  const changes = [];
  harness.preferences.subscribe((update) => changes.push(update));
  harness.storageChanged.emit({
    [TYPOGRAPHY_FIELDS.promptItalic.key]: { newValue: true },
    [TYPOGRAPHY_FIELDS.responseFont.key]: { newValue: undefined },
    [TYPOGRAPHY_FIELDS.responseFontSize.key]: { newValue: "large" },
  }, "local");
  assert.deepEqual(changes, [{ promptItalic: true, responseFont: "default", responseFontSize: "default" }]);
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

test("effective model and effort describe the next request without preference labels", () => {
  const models = [
    {
      slug: "model-1",
      displayName: "First Model",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"],
    },
    {
      slug: "model-2",
      displayName: "Second Model",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "high"],
    },
  ];

  assert.equal(selectModel(models, "automatic"), models[0]);
  assert.equal(selectModel(models, "model-2"), models[1]);
  assert.equal(selectModel(models, "missing"), models[0]);
  assert.equal(selectModel([], "automatic"), null);
  assert.equal(automaticModelLabel(models), "Automatic (First Model)");
  assert.equal(automaticModelLabel([]), "Automatic");
  assert.equal(effectiveReasoningEffort(models[0], "model_default"), "medium");
  assert.equal(effectiveReasoningEffort(models[1], "high"), "high");
  assert.equal(effectiveReasoningEffort(models[1], "medium"), "low");
  assert.equal(effectiveReasoningEffort({}, "model_default"), undefined);
  assert.equal(reasoningEffortLabel("medium"), "Medium");
  assert.equal(reasoningEffortLabel(undefined), "");
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
