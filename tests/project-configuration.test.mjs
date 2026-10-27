import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  HOST_NAME,
  appDataDirectory,
  nativeHostManifestDirectory,
} from "../native-host/constants.mjs";

test("manifest exposes only the required extension and page permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
  const derivedId = [...digest.subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));

  assert.equal(manifest.name, "BrowseFriend");
  assert.deepEqual(manifest.permissions.sort(), ["nativeMessaging", "scripting", "sidePanel", "storage"]);
  assert.deepEqual(manifest.host_permissions.sort(), ["http://*/*", "https://*/*"]);
  assert.equal(manifest.background.type, "module");
  assert.equal(derivedId, EXTENSION_ID);
  assert.equal(EXTENSION_ORIGIN, `chrome-extension://${EXTENSION_ID}/`);
  await access(new URL(`../${manifest.background.service_worker}`, import.meta.url));
  await access(new URL(`../${manifest.side_panel.default_path}`, import.meta.url));
});

test("native host installer supports a non-mutating dry run", () => {
  const result = spawnSync(process.execPath, [
    new URL("../native-host/install.mjs", import.meta.url).pathname,
    "--dry-run",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(HOST_NAME.replaceAll(".", "\\.")));
  assert.match(result.stdout, new RegExp(EXTENSION_ID));
});

test("stable native host entrypoint imports resolve", async () => {
  const hostUrl = new URL("../native-host/host.mjs", import.meta.url);
  const source = await readFile(hostUrl, "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";/gm)]
    .map((match) => match[1]);

  assert.ok(imports.length > 0);
  await Promise.all(imports.map((path) => access(new URL(path, hostUrl))));
});

test("native host paths follow Chrome's user-specific platform conventions", () => {
  assert.equal(
    appDataDirectory("darwin", {}, "/Users/tester"),
    "/Users/tester/Library/Application Support/BrowseFriend",
  );
  assert.equal(
    nativeHostManifestDirectory("darwin", {}, "/Users/tester"),
    "/Users/tester/Library/Application Support/Google/Chrome/NativeMessagingHosts",
  );
  assert.equal(
    appDataDirectory("linux", {}, "/home/tester"),
    "/home/tester/.config/browsefriend",
  );
  assert.equal(
    nativeHostManifestDirectory("linux", { XDG_CONFIG_HOME: "/config" }, "/home/tester"),
    "/config/google-chrome/NativeMessagingHosts",
  );
  assert.throws(() => appDataDirectory("win32", {}, "C:\\Users\\tester"), /macOS and Linux/);
});
