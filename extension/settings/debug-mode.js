export const DEBUG_MODE_KEY = "browsefriend.settings.debugMode";

export function createDebugModePreference({ storageArea, storageChanged }) {
  async function load() {
    const stored = await storageArea.get(DEBUG_MODE_KEY);
    return stored?.[DEBUG_MODE_KEY] === true;
  }

  async function save(enabled) {
    const value = enabled === true;
    await storageArea.set({ [DEBUG_MODE_KEY]: value });
    return value;
  }

  function subscribe(listener) {
    const handleChange = (changes, areaName) => {
      if (areaName !== "local" || !changes?.[DEBUG_MODE_KEY]) return;
      listener(changes[DEBUG_MODE_KEY].newValue === true);
    };
    storageChanged.addListener(handleChange);
    return () => storageChanged.removeListener(handleChange);
  }

  return { load, save, subscribe };
}

export function shouldShowPageContext(debugMode, message) {
  return debugMode === true && message?.role === "user" && Boolean(message.context);
}
