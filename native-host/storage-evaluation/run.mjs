import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const output = join(root, "build/storage-evaluation");
await mkdir(output, { recursive: true });
const mode = process.argv[2] ?? "check";
let log = "";

async function run(command, args, env = process.env, expectedFailure = false) {
  log += `\n$ ${command} ${args.join(" ")}\n`;
  try {
    const result = await execute(command, args, { cwd: directory, env, timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
    log += result.stdout + result.stderr;
    if (expectedFailure) throw new Error("Pinned Chestnut unexpectedly built; review and extend its runtime evaluation.");
    return result.stdout;
  } catch (error) {
    log += (error.stdout ?? "") + (error.stderr ?? "");
    if (expectedFailure && error.code === 1 && /ReadRawString undefined/.test(error.stderr ?? "")) {
      console.log("Chestnut: published dependency graph fails to build (ReadRawString); recorded.");
      return "";
    }
    throw error;
  }
}

async function buildTarget(os, arch, keeper = true) {
  const env = { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: arch };
  const suffix = os === "windows" ? ".exe" : "";
  const path = join(output, `evaluation-${os}-${arch}${keeper ? "-keeper" : ""}${suffix}`);
  const tags = keeper ? ["-tags=candidate_keeper"] : [];
  await run("go", ["build", "-trimpath", ...tags, "-o", path, "."], env);
  return { path, env, tags, suffix };
}

async function check() {
  const arch = (await run("go", ["env", "GOARCH"])).trim();
  const race = process.platform === "win32" && arch === "arm64" ? [] : ["-race"];
  console.log("Running storage, keyring-adapter, process, and policy contracts.");
  await run("go", ["test", ...race, "-tags=candidate_keeper", "-v", "-timeout=3m", "./..."]);
  await run("go", ["vet", "-tags=candidate_keeper", "./..."]);
  await run("go", ["build", "-tags=candidate_chestnut", "-o", join(output, "chestnut-build-probe"), "."], process.env, true);
  console.log("Evaluation checks passed; documented capability restrictions are in the log.");
}

async function cross() {
  for (const os of ["darwin", "linux", "windows"]) {
    for (const arch of ["amd64", "arm64"]) {
      const target = await buildTarget(os, arch);
      await run("go", ["test", "-c", ...target.tags, "-o", `${target.path}.test${target.suffix}`, "."], target.env);
      console.log(`Built evaluation executable and tests: ${os}/${arch}`);
    }
  }
}

async function measure() {
  const os = (await run("go", ["env", "GOOS"])).trim();
  const arch = (await run("go", ["env", "GOARCH"])).trim();
  const results = [];
  for (const keeper of [false, true]) {
    const target = await buildTarget(os, arch, keeper);
    const binaryBytes = (await stat(target.path)).size;
    const packages = (await run("go", ["list", ...target.tags, "-deps", "-f", "{{if not .Standard}}{{.ImportPath}}{{end}}", "."])).trim().split(/\s+/).length;
    for (const backend of keeper ? ["keeper"] : ["file", "bolt"]) {
      for (const size of [4096, 131072]) {
        const result = JSON.parse(await run(target.path, [`-backend=${backend}`, `-size=${size}`]));
        results.push({ ...result, driver_bytes: binaryBytes, imported_nonstandard_packages: packages });
        console.log(`${backend}: ${size} bytes, ${result.cycle_ms.toFixed(2)} ms/cycle`);
      }
    }
  }
  await writeFile(join(output, `measurements-${os}-${arch}.json`), JSON.stringify(results, null, 2) + "\n");
}

async function wine() {
  const binary = process.env.BROWSEFRIEND_WINE ?? "wine";
  const target = await buildTarget("windows", "amd64");
  const tests = `${target.path}.test.exe`;
  await run("go", ["test", "-c", ...target.tags, "-o", tests, "."], target.env);
  const prefix = await mkdtemp(join(tmpdir(), "browsefriend-storage-evaluation-wine-"));
  const env = { ...process.env, WINEPREFIX: prefix, WINEARCH: "win64", WINEDEBUG: "-all", WINEDLLOVERRIDES: "mscoree,mshtml,winemenubuilder.exe=", MVK_CONFIG_LOG_LEVEL: "0", BROWSEFRIEND_TEST_WINE: binary, BF_STORAGE_EVALUATION_KEYRING: "1" };
  try {
    await run(binary, ["cmd.exe", "/d", "/c", "echo evaluation-ready"], env);
    await run(binary, [tests, "-test.v", "-test.timeout=3m"], env);
    console.log("Wine compatibility passed; native Windows ACL/reparse enforcement remains pending.");
  } finally {
    let server = "wineserver";
    if (binary.includes("/")) server = join(dirname(binary), "wineserver");
    try { await execute(server, ["-k"], { env, timeout: 15_000 }); }
    catch (error) { if (error.code !== 1 || error.stdout || error.stderr) throw error; }
    finally { await rm(prefix, { recursive: true, force: true }); }
  }
}

try {
  if (mode === "check") await check();
  else if (mode === "cross") await cross();
  else if (mode === "measure") await measure();
  else if (mode === "wine") await wine();
  else throw new Error("Use check, cross, measure, or wine.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, `${mode}-${process.platform}-${process.arch}.log`), log);
}
