import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function hostCommand(kind) {
  const wine = process.env.BROWSEFRIEND_TEST_WINE;
  const name = wine
    ? `browsefriend-windows-amd64${kind === "test" ? "-test-host" : ""}.exe`
    : `browsefriend-${kind === "test" ? "test-host" : "native-host"}${process.platform === "win32" ? ".exe" : ""}`;
  const executable = fileURLToPath(new URL(`../../build/${name}`, import.meta.url));
  return wine ? { command: wine, args: [executable] } : { command: executable, args: [] };
}

export function spawnHost(kind, args = [], options = {}) {
  const host = hostCommand(kind);
  return spawn(host.command, [...host.args, ...args], options);
}

export function runHost(kind, args = [], options = {}) {
  const host = hostCommand(kind);
  return spawnSync(host.command, [...host.args, ...args], { timeout: 30_000, ...options });
}
