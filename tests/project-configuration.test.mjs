import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { EXTENSION_ID, EXTENSION_ORIGIN, HOST_NAME } from "../native-host/constants.mjs";

test("manifest exposes only the required authentication permission", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
  const derivedId = [...digest.subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));

  assert.equal(manifest.name, "BrowseFriend");
  assert.deepEqual(manifest.permissions.sort(), ["nativeMessaging", "sidePanel"]);
  assert.equal(derivedId, EXTENSION_ID);
  assert.equal(EXTENSION_ORIGIN, `chrome-extension://${EXTENSION_ID}/`);
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
