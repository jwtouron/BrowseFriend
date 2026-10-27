import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PATCHED_UNDICI_VERSION = "7.30.1";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devkitRoot = join(repositoryRoot, "vendor", "sign-in-with-chatgpt-devkit");
const targetUndici = join(devkitRoot, "node_modules", "undici");

function requireSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error("BrowseFriend requires Node.js 22.12 or newer.");
  }
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd: repositoryRoot, stdio: "inherit" });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed with status ${result.status}.`);
}

async function installPatchedUndici() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "browsefriend-undici-"));

  try {
    await writeFile(join(temporaryRoot, "package.json"), "{\"private\":true}\n");
    runNpm([
      "install",
      "--prefix",
      temporaryRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      `undici@${PATCHED_UNDICI_VERSION}`,
    ]);

    const sourceUndici = join(temporaryRoot, "node_modules", "undici");
    const manifest = JSON.parse(await readFile(join(sourceUndici, "package.json"), "utf8"));
    if (manifest.version !== PATCHED_UNDICI_VERSION) {
      throw new Error(`Expected undici ${PATCHED_UNDICI_VERSION}, received ${manifest.version}.`);
    }

    // Patch only the vulnerable transitive package; leave the DevKit lockfile
    // and every other pinned dependency exactly as published upstream.
    await rm(targetUndici, { recursive: true, force: true });
    await cp(sourceUndici, targetUndici, { recursive: true });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

requireSupportedNode();
runNpm(["ci", "--prefix", devkitRoot, "--no-audit"]);
await installPatchedUndici();
runNpm(["run", "build", "-w", "@siwc/local", "--prefix", devkitRoot]);

console.log(`OpenAI DevKit ready with undici ${PATCHED_UNDICI_VERSION}.`);
