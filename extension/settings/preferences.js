export const DEBUG_MODE_KEY = "browsefriend.settings.debugMode";
export const THEME_KEY = "browsefriend.settings.theme";
export const MODEL_KEY = "browsefriend.settings.model";
export const THEMES = new Set(["system", "light", "dark"]);

export function normalizeTheme(value) {
  return THEMES.has(value) ? value : "system";
}

export function normalizeModel(value) {
  if (value === "automatic") return value;
  if (typeof value !== "string") return "automatic";
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : "automatic";
}

export function createPreferences({ storageArea, storageChanged }) {
  async function load() {
    const stored = await storageArea.get([DEBUG_MODE_KEY, THEME_KEY, MODEL_KEY]);
    return {
      debugMode: stored?.[DEBUG_MODE_KEY] === true,
      theme: normalizeTheme(stored?.[THEME_KEY]),
      model: normalizeModel(stored?.[MODEL_KEY]),
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

  async function saveModel(model) {
    const value = normalizeModel(model);
    await storageArea.set({ [MODEL_KEY]: value });
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
      if (changes?.[MODEL_KEY]) {
        update.model = normalizeModel(changes[MODEL_KEY].newValue);
      }
      if (Object.keys(update).length) listener(update);
    };
    storageChanged.addListener(handleChange);
    return () => storageChanged.removeListener(handleChange);
  }

  return { load, saveDebugMode, saveTheme, saveModel, subscribe };
}

export function applyTheme(root, theme) {
  const normalized = normalizeTheme(theme);
  if (normalized === "system") delete root.dataset.theme;
  else root.dataset.theme = normalized;
  return normalized;
}

export function shouldShowPageContext(debugMode, message) {
  return debugMode === true && message?.role === "user" && Boolean(message.context);
}
