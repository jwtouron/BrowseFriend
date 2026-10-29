import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  HOST_NAME,
  appDataDirectory,
  nativeHostManifestDirectory,
} from "../native-host/constants.mjs";

test("project Markdown uses the root exceptions and docs directory", async () => {
  const repositoryRoot = new URL("../", import.meta.url);
  const rootMarkdown = (await readdir(repositoryRoot))
    .filter((name) => name.endsWith(".md"))
    .sort();

  assert.deepEqual(rootMarkdown, ["AGENTS.md", "NOTICE.md", "README.md"]);
  await Promise.all([
    "ARCHITECTURE.md",
    "KNOWN_LIMITATIONS.md",
    "TODO.md",
  ].map((name) => access(new URL(`../docs/${name}`, import.meta.url))));
});

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

test("pinned DevKit response requests disable server-side conversation state", async () => {
  const source = await readFile(new URL(
    "../vendor/sign-in-with-chatgpt-devkit/packages/local/dist/responses.js",
    import.meta.url,
  ), "utf8");

  assert.match(source, /store:\s*false/);
  assert.match(source, /stream:\s*true/);
  assert.doesNotMatch(source, /previous_response_id|conversation:/);
});

test("DevKit tool, reasoning, and compaction support remain reproducible downstream patches", async () => {
  const setup = await readFile(new URL("../scripts/setup-devkit.mjs", import.meta.url), "utf8");
  const [toolsPatch, compactionPatch] = await Promise.all([
    readFile(new URL("../patches/devkit-function-tools.patch", import.meta.url), "utf8"),
    readFile(new URL("../patches/devkit-compaction.patch", import.meta.url), "utf8"),
  ]);

  assert.match(setup, /devkit-function-tools\.patch/);
  assert.match(setup, /devkit-compaction\.patch/);
  assert.match(setup, /apply.*--reverse/s);
  assert.match(toolsPatch, /response\.output_item\.done/);
  assert.match(toolsPatch, /parallel_tool_calls/);
  assert.match(toolsPatch, /supported_reasoning_levels/);
  assert.match(toolsPatch, /reasoningEffort/);
  assert.match(compactionPatch, /responses\.compact/);
  assert.match(compactionPatch, /compactedContext/);
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
