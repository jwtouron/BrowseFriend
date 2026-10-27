import { installAuthBridge } from "../auth/background-bridge.js";

installAuthBridge({ runtime: chrome.runtime });

// Make the extension's toolbar icon Chrome's native side-panel toggle.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Unable to configure the toolbar action.", error));
