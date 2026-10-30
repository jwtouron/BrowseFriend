import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { HOST_CONTRACT } from "../shared/host-contract.js";

test("project Markdown uses the root exceptions and docs directory", async () => {
  const root = new URL("../", import.meta.url);
  const markdown = (await readdir(root)).filter((p) => p.endsWith(".md")).sort();
  assert.deepEqual(markdown, ["AGENTS.md", "NOTICE.md", "README.md"]);
  for (const name of ["ARCHITECTURE.md", "KNOWN_LIMITATIONS.md", "TODO.md", "NATIVE_HOST.md"]) {
    await access(new URL("../docs/" + name, import.meta.url));
  }
});
test("manifest exposes only required permissions and matches the native contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
  const id = [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    .replace(/[0-9a-f]/g, (d) => String.fromCharCode(97 + Number.parseInt(d, 16)));
  assert.equal(manifest.name, HOST_CONTRACT.appName);
  assert.equal(HOST_CONTRACT.extensionOrigin, "chrome-extension://" + id + "/");
  assert.deepEqual(manifest.permissions.sort(), ["nativeMessaging", "scripting", "sidePanel", "storage"]);
  assert.deepEqual(manifest.host_permissions.sort(), ["http://*/*", "https://*/*"]);
  await access(new URL("../" + manifest.background.service_worker, import.meta.url));
  await access(new URL("../" + manifest.side_panel.default_path, import.meta.url));
});
test("standalone companion supports non-mutating install and uninstall dry runs", () => {
  for (const command of ["install", "uninstall"]) {
    const result = spawnSync(new URL("../build/browsefriend-native-host", import.meta.url).pathname, [
      command, "--dry-run",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(HOST_CONTRACT.hostName.replaceAll(".", "\\.")));
    assert.doesNotMatch(result.stdout, /prototype|Node.js/);
  }
});
test("native companion notices include linked dependencies and license texts", async () => {
  const notices = await readFile(new URL("../build/THIRD-PARTY-NOTICES.txt", import.meta.url), "utf8");
  assert.match(notices, /github\.com\/coreos\/go-oidc\/v3 v3\.21\.0/);
  assert.match(notices, /github\.com\/go-jose\/go-jose\/v4 v4\.1\.4/);
  assert.match(notices, /golang\.org\/x\/oauth2 v0\.36\.0/);
  assert.match(notices, /Apache License/);
  assert.match(notices, /Redistribution and use in source and binary forms/);
});
