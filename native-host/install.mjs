import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_NAME,
  EXTENSION_ORIGIN,
  HOST_NAME,
  appDataDirectory,
  nativeHostManifestDirectory,
} from "./constants.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const hostEntry = join(scriptDirectory, "host.mjs");
const devkitEntry = join(
  scriptDirectory,
  "..",
  "vendor",
  "sign-in-with-chatgpt-devkit",
  "packages",
  "local",
  "dist",
  "index.js",
);
const dataDirectory = appDataDirectory();
const launcherPath = join(dataDirectory, "browsefriend-native-host");
const manifestDirectory = nativeHostManifestDirectory();
const manifestPath = join(manifestDirectory, `${HOST_NAME}.json`);
const uninstall = process.argv.includes("--uninstall");
const dryRun = process.argv.includes("--dry-run");

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function printPlan(action) {
  console.log(`${action} BrowseFriend native messaging host`);
  console.log(`Extension origin: ${EXTENSION_ORIGIN}`);
  console.log(`Host manifest: ${manifestPath}`);
  console.log(`Launcher: ${launcherPath}`);
}

async function install() {
  printPlan("Installing");
  if (dryRun) return;

  try {
    await access(devkitEntry);
  } catch {
    throw new Error("The OpenAI DevKit is not built. Run `npm run setup:devkit` first.");
  }

  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });

  const launcher = [
    "#!/bin/sh",
    `exec ${shellQuote(process.execPath)} ${shellQuote(hostEntry)} "$@"`,
    "",
  ].join("\n");
  await writeFile(launcherPath, launcher, { mode: 0o700 });
  await chmod(launcherPath, 0o700);

  const manifest = {
    name: HOST_NAME,
    description: `${APP_NAME} secure ChatGPT sign-in companion`,
    path: launcherPath,
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log("Installed. Reload BrowseFriend from chrome://extensions.");
}

async function remove() {
  printPlan("Removing");
  if (dryRun) return;
  await rm(manifestPath, { force: true });
  await rm(launcherPath, { force: true });
  console.log("Removed the host registration. Saved account data was preserved.");
}

await (uninstall ? remove() : install());
