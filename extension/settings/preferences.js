import { normalizeReasoningPreference } from "../../shared/reasoning.js";

export { normalizeReasoningPreference };

export const DEBUG_MODE_KEY = "browsefriend.settings.debugMode";
export const THEME_KEY = "browsefriend.settings.theme";
export const ACCENT_KEY = "browsefriend.settings.accent";
export const MODEL_KEY = "browsefriend.settings.model";
export const REASONING_KEY = "browsefriend.settings.reasoningEffort";
export const THEMES = new Set(["system", "light", "dark"]);
export const ACCENTS = new Set([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "cyan",
]);

export function normalizeTheme(value) {
  return THEMES.has(value) ? value : "system";
}

export function normalizeAccent(value) {
  return ACCENTS.has(value) ? value : "blue";
}

export function normalizeModel(value) {
  if (value === "automatic") return value;
  if (typeof value !== "string") return "automatic";
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : "automatic";
}

export function createPreferences({ storageArea, storageChanged }) {
  async function load() {
    const stored = await storageArea.get([
      DEBUG_MODE_KEY,
      THEME_KEY,
      ACCENT_KEY,
      MODEL_KEY,
      REASONING_KEY,
    ]);
    const reasoningEffort = normalizeReasoningPreference(stored?.[REASONING_KEY]);
    if (stored?.[REASONING_KEY] !== reasoningEffort) {
      await storageArea.set({ [REASONING_KEY]: reasoningEffort });
    }
    return {
      debugMode: stored?.[DEBUG_MODE_KEY] === true,
      theme: normalizeTheme(stored?.[THEME_KEY]),
      accent: normalizeAccent(stored?.[ACCENT_KEY]),
      model: normalizeModel(stored?.[MODEL_KEY]),
      reasoningEffort,
    };
  }

  async function saveDebugMode(enabled) {
    const value = enabled === true;
    await storageArea.set({ [DEBUG_MODE_KEY]: value });
    return value;
  }

  async function saveTheme(theme) {
    const value = normalizeTheme(theme);
    await storageArea.set({ [THEME_KEY]: value });
    return value;
  }

  async function saveAccent(accent) {
    const value = normalizeAccent(accent);
    await storageArea.set({ [ACCENT_KEY]: value });
    return value;
  }

  async function saveModel(model) {
    const value = normalizeModel(model);
    await storageArea.set({ [MODEL_KEY]: value });
    return value;
  }

  async function saveReasoningEffort(reasoningEffort) {
    const value = normalizeReasoningPreference(reasoningEffort);
    await storageArea.set({ [REASONING_KEY]: value });
    return value;
  }

  function subscribe(listener) {
    const handleChange = (changes, areaName) => {
      if (areaName !== "local") return;
      const update = {};
      if (changes?.[DEBUG_MODE_KEY]) {
        update.debugMode = changes[DEBUG_MODE_KEY].newValue === true;
      }
      if (changes?.[THEME_KEY]) {
        update.theme = normalizeTheme(changes[THEME_KEY].newValue);
      }
      if (changes?.[ACCENT_KEY]) {
        update.accent = normalizeAccent(changes[ACCENT_KEY].newValue);
      }
      if (changes?.[MODEL_KEY]) {
        update.model = normalizeModel(changes[MODEL_KEY].newValue);
      }
      if (changes?.[REASONING_KEY]) {
        update.reasoningEffort = normalizeReasoningPreference(changes[REASONING_KEY].newValue);
      }
      if (Object.keys(update).length) listener(update);
    };
    storageChanged.addListener(handleChange);
    return () => storageChanged.removeListener(handleChange);
  }

  return {
    load,
    saveAccent,
    saveDebugMode,
    saveTheme,
    saveModel,
    saveReasoningEffort,
    subscribe,
  };
}

export function applyTheme(root, theme) {
  const normalized = normalizeTheme(theme);
  if (normalized === "system") delete root.dataset.theme;
  else root.dataset.theme = normalized;
  return normalized;
}

export function applyAccent(root, accent) {
  const normalized = normalizeAccent(accent);
  root.dataset.accent = normalized;
  return normalized;
}

export function shouldShowPageContext(debugMode, message) {
  return debugMode === true && message?.role === "user" && Boolean(message.context);
}
