import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createMessageDecoder, encodeMessage } from "../tests/helpers/native-protocol.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());

async function findExecutable(name) {
  const candidates = isAbsolute(name) || name.includes("/")
    ? [resolve(name)]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`Executable not found: ${name}. Set BROWSEFRIEND_WINE to your Wine executable.`);
}

async function run(command, args, env, { quiet = false, timeout = 180_000 } = {}) {
  try {
    const result = await execute(command, args, { cwd: root, env, timeout, maxBuffer: 32 * 1024 * 1024, signal: controller.signal });
    if (!quiet) { process.stdout.write(result.stdout); process.stderr.write(result.stderr); }
    return result.stdout;
  } catch (error) {
    process.stdout.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    throw error;
  }
}

async function checkInstalledStatus(wine, executable, env) {
  await new Promise((resolveStatus, reject) => {
    const child = spawn(wine, [executable], { cwd: root, env, signal: controller.signal, stdio: ["pipe", "pipe", "pipe"] });
    let result;
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Installed companion status timed out.")); }, 30_000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stderr.on("data", (data) => { stderr += data; });
    child.stdout.on("data", createMessageDecoder((message) => {
      if (message.id === "wine-installed-status") { result = message; child.stdin.end(); }
    }, reject));
    child.on("close", (code) => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 0, stderr);
        assert.equal(result?.ok, true);
        assert.equal(result.result.state, "signed_out");
        resolveStatus();
      } catch (error) { reject(error); }
    });
    child.stdin.on("error", reject);
    child.stdin.write(encodeMessage({ id: "wine-installed-status", method: "auth.status" }));
  });
}

async function main() {
  const wine = await findExecutable(process.env.BROWSEFRIEND_WINE || "wine");
  const wineDirectory = dirname(wine);
  const version = (await run(wine, ["--version"], process.env, { quiet: true })).trim();
  await mkdir(join(root, "build"), { recursive: true });
  const prefix = await mkdtemp(join(tmpdir(), "browsefriend-wine-"));
  const env = {
    ...process.env,
    WINEPREFIX: prefix,
    WINEARCH: "win64",
    WINEDEBUG: "-all",
    WINEDLLOVERRIDES: "mscoree,mshtml,winemenubuilder.exe=",
    MVK_CONFIG_LOG_LEVEL: "0",
    BROWSEFRIEND_TEST_WINE: wine,
  };
  const report = { wine: version, target: "windows/amd64", nativeWindows: "pending", arm64Runtime: "pending", chromeBrowser: "pending" };
  try {
    console.log(`Initializing isolated Wine prefix (${version}).`);
    const ready = await run(wine, ["cmd.exe", "/d", "/c", "echo BROWSEFRIEND_WINE_READY"], env, { quiet: true, timeout: 120_000 });
    assert.match(ready, /BROWSEFRIEND_WINE_READY/);
    console.log("Building Windows x64/ARM64 binaries and tests.");
    await run("go", ["run", "./native-host/cmd/build", "--check", "--windows-tests"], process.env, { timeout: 300_000 });
    const artifact = join(root, "build", "browsefriend-windows-amd64.exe");
    const windowsArtifact = (await run(join(wineDirectory, "winepath"), ["-w", artifact], env, { quiet: true })).trim();
    console.log("Running Windows Go tests under Wine (without the race detector).");
    for (const suite of ["companion", "command", "build"]) {
      await run(wine, [join(root, "build", `browsefriend-windows-amd64-${suite}.test.exe`), "-test.v", "-test.timeout=3m"], { ...env, BROWSEFRIEND_TEST_BINARY: windowsArtifact });
    }
    console.log("Running JavaScript native-host contracts against Windows executables.");
    await run(process.execPath, ["--test", "tests/native-host/go-contract.test.mjs", "tests/project-configuration.test.mjs"], env);
    console.log("Checking the installed Windows executable inside the Wine prefix.");
    await run(wine, [artifact, "install", "--dry-run"], env);
    const installed = await run(wine, [artifact, "install"], env);
    const installedPath = installed.match(/^Binary: (.+)$/m)?.[1].trim();
    assert.ok(installedPath, "Installer did not report its Windows executable path.");
    await checkInstalledStatus(wine, installedPath, env);
    await run(wine, [artifact, "uninstall", "--dry-run"], env);
    await run(wine, [artifact, "uninstall"], env);
    await run(wine, [artifact, "uninstall"], env);
    report.status = "passed";
    console.log("Wine x64 compatibility checks passed. Native Windows security, ARM64 execution, and Chrome browser verification remain pending.");
  } catch (error) {
    report.status = "failed";
    throw error;
  } finally {
    try {
      await execute(join(wineDirectory, "wineserver"), ["-k"], { env, timeout: 15_000 });
    } catch (error) {
      // Wine returns 1 without diagnostics when the prefix has no running server.
      if (error.code !== 1 || error.stdout || error.stderr) {
        report.status = "failed";
        report.cleanup = "failed";
        console.error(`Wine cleanup failed: ${error.message}`);
        process.exitCode = 1;
      }
    } finally {
      await rm(prefix, { recursive: true, force: true });
      await writeFile(join(root, "build", "windows-wine-results.json"), JSON.stringify(report, null, 2) + "\n");
    }
  }
}

try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
