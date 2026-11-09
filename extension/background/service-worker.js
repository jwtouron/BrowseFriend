import { installAppController } from "../app/background.js";
import { installCompanionBridge } from "../companion/background-bridge.js";
import { installPageActor } from "../page/act/background.js";
import { installPageReader } from "../page/read/background.js";

const companion = installCompanionBridge({ runtime: chrome.runtime });
const pageReader = installPageReader({
  runtime: chrome.runtime,
  tabs: chrome.tabs,
  scripting: chrome.scripting,
});
const pageActor = installPageActor({
  runtime: chrome.runtime,
  tabs: chrome.tabs,
  scripting: chrome.scripting,
  pageReader,
});
installAppController({
  runtime: chrome.runtime,
  storage: chrome.storage.session,
  settingsStorage: chrome.storage.local,
  settingsChanged: chrome.storage.onChanged,
  companion,
  pageReader,
  pageActor,
  randomUUID: () => crypto.randomUUID(),
});

// Make the extension's toolbar icon Chrome's native side-panel toggle.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Unable to configure the toolbar action.", error));
