import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createMessageDecoder, encodeMessage } from "../helpers/native-protocol.mjs";
import { installCompanionBridge } from "../../extension/companion/background-bridge.js";
import { event } from "./site.mjs";

export function startHost(executable, args = []) {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  const port = { onMessage: event(), onDisconnect: event(), postMessage(message) { child.stdin.write(encodeMessage(message)); } };
  const bridge = installCompanionBridge({ runtime: { connectNative: () => port }, randomUUID });
  const disconnected = () => port.onDisconnect.emit();
  child.stdout.on("data", createMessageDecoder((message) => port.onMessage.emit(message), disconnected));
  child.on("error", disconnected);
  child.stdin.on("error", disconnected);
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once("close", resolve));
  child.on("close", disconnected);
  return {
    ...bridge,
    async close() {
      if (child.exitCode !== null) return;
      // Let production cancellation and process-local refresh work finish.
      try { await bridge.request("model.cancel", {}); } catch { /* Already disconnected. */ }
      child.stdin.end();
      await exited;
    },
  };
}

export function parseGrade(text) {
  const result = JSON.parse(text);
  const keys = ["accurateOutcome", "unsupportedClaims", "unproductiveRepetition", "rationale"];
  if (!result || Array.isArray(result) || Object.keys(result).length !== keys.length ||
      keys.slice(0, 3).some((key) => typeof result[key] !== "boolean") ||
      typeof result.rationale !== "string" || result.rationale.length > 4000) throw new Error("Invalid grader result");
  return result;
}
export const passedGrade = (grade) => grade.accurateOutcome && !grade.unsupportedClaims && !grade.unproductiveRepetition;
