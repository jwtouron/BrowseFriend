import { homedir } from "node:os";
import { join } from "node:path";

export const APP_ID = "browsefriend";
export const APP_NAME = "BrowseFriend";
export const EXTENSION_ID = "klalohmlcckgbhfdbbjkokmlnfmlljod";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const HOST_NAME = "com.browsefriend.native_host";

export function appDataDirectory(platform = process.platform, environment = process.env) {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME);
  }

  if (platform === "linux") {
    return join(environment.XDG_CONFIG_HOME || join(homedir(), ".config"), APP_ID);
  }

  throw new Error("BrowseFriend currently supports macOS and Linux.");
}

export function nativeHostManifestDirectory(
  platform = process.platform,
  environment = process.env,
) {
  if (platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
    );
  }

  if (platform === "linux") {
    return join(
      environment.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "google-chrome",
      "NativeMessagingHosts",
    );
  }

  throw new Error("BrowseFriend currently supports macOS and Linux.");
}
