import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PAGE_TOOL_SCHEMAS } from "../shared/page-tools.js";
import { REASONING_EFFORTS } from "../shared/reasoning.js";
import {
  BASE_MODEL_INSTRUCTIONS, ASK_INSTRUCTIONS, ACT_INSTRUCTIONS, MODEL_LIMITS,
} from "../native-host/model/handler.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = fileURLToPath(new URL("../native-host/go/", import.meta.url));
const output = fileURLToPath(new URL("../build/", import.meta.url));
await mkdir(output, { recursive: true });
await writeFile(new URL("../native-host/go/internal/companion/contract.json", import.meta.url), JSON.stringify({
  tools: PAGE_TOOL_SCHEMAS,
  efforts: [...REASONING_EFFORTS],
  baseInstructions: BASE_MODEL_INSTRUCTIONS,
  askInstructions: ASK_INSTRUCTIONS,
  actInstructions: ACT_INSTRUCTIONS,
  limits: MODEL_LIMITS,
}));

function run(args, environment = {}) {
  const result = spawnSync("go", args, {
    cwd: source, stdio: "inherit", env: { ...process.env, ...environment },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(["build", "-trimpath", "-o", output + "browsefriend-native-host-go", "./cmd/host"], { CGO_ENABLED: "0" });
function goOutput(args) {
  const result = spawnSync("go", args, { cwd: source, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const notices = ["BrowseFriend Go prototype: third-party licenses\n"];
const modules = [...new Set(goOutput([
  "list", "-deps", "-f", "{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}", "./cmd/host",
]).split("\n").filter(Boolean))]
  .map((line) => line.split("|")).filter(([name]) => name !== "browsefriend/nativehost");
modules.push(["Go standard library", goOutput(["env", "GOVERSION"]), goOutput(["env", "GOROOT"])]);
for (const [name, version, directory] of modules) {
  notices.push("\n" + name + " " + version + "\n");
  for (const filename of ["LICENSE", "NOTICE"]) {
    try {
      notices.push(await readFile(directory + "/" + filename, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" || filename === "LICENSE") throw error;
    }
  }
}
await writeFile(output + "GO-THIRD-PARTY-NOTICES.txt", notices.join("\n"));
if (process.argv.includes("--test")) {
  run(["test", "-race", "./..."]);
  run(["vet", "./..."]);
  run(["build", "-o", output + "browsefriend-go-test-host", "./cmd/test-host"]);
}
if (process.argv.includes("--cross")) {
  for (const GOOS of ["darwin", "linux"]) {
    for (const GOARCH of ["amd64", "arm64"]) {
      run(["build", "-trimpath", "-o", output + "browsefriend-" + GOOS + "-" + GOARCH, "./cmd/host"], {
        GOOS, GOARCH, CGO_ENABLED: "0",
      });
    }
  }
}
console.log("Go host built in " + root + "build/");
