import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["extension", "native-host", "scripts", "shared", "tests"];
const supportedExtensions = new Set([".js", ".mjs"]);

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSourceFiles(path));
    if (entry.isFile() && supportedExtensions.has(extname(entry.name))) files.push(path);
  }

  return files;
}

const files = (await Promise.all(
  sourceRoots.map((directory) => collectSourceFiles(join(repositoryRoot, directory))),
)).flat().sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
