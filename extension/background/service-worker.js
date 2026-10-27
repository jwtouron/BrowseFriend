import { installCompanionBridge } from "../companion/background-bridge.js";
import { installChatController } from "../chat/background.js";
import { installPageReader } from "../page/read/background.js";

const companion = installCompanionBridge({ runtime: chrome.runtime });
const pageReader = installPageReader({
  runtime: chrome.runtime,
  tabs: chrome.tabs,
  scripting: chrome.scripting,
});
installChatController({
  runtime: chrome.runtime,
  storage: chrome.storage.session,
  companion,
  pageReader,
  randomUUID: () => crypto.randomUUID(),
});

// Make the extension's toolbar icon Chrome's native side-panel toggle.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Unable to configure the toolbar action.", error));
