import { randomUUID } from "node:crypto";
import { installAppController } from "../../extension/app/background.js";
import { installPageReader } from "../../extension/page/read/background.js";
import { installPageActor } from "../../extension/page/act/background.js";
import { createSite, FILES } from "./site.mjs";

export async function runCase({ scenario, companion, model, effort = "medium", timeout = 300_000 }) {
  const site = await createSite(scenario);
  const storageData = {};
  const storage = { async get(key) { return { [key]: structuredClone(storageData[key]) }; }, async set(values) { Object.assign(storageData, structuredClone(values)); } };
  const settings = { "browsefriend.settings.model": model, "browsefriend.settings.reasoningEffort": effort };
  const pageReader = installPageReader(site);
  const pageActor = installPageActor({ ...site, pageReader });
  let calls = 0, budgetExceeded = false, haltReason = null;
  const controller = installAppController({ runtime: site.runtime, storage,
    settingsStorage: { async get(key) { return { [key]: settings[key] }; } },
    companion: {
      subscribe: (fn) => companion.subscribe(fn),
      async request(method, params, onEvent, id) {
        if (method === "model.stream") {
          if (params.model !== model || params.reasoningEffort !== effort) {
            throw { code: "eval_settings_changed", message: "Model or effort was not applied as requested.", retryable: false };
          }
          site.trace.push({ kind: "modelInput", params: structuredClone(params) });
          site.advance();
        }
        const result = await companion.request(method, params, onEvent, id);
        if (method === "model.stream") {
          site.trace.push({ kind: "modelResult", result: structuredClone(result) });
          if (result.result?.toolCall && ++calls > 8) {
            budgetExceeded = true;
            throw { code: "eval_budget_exceeded", message: "Evaluation tool budget exceeded.", retryable: false };
          }
        }
        return result;
      },
    }, pageReader, pageActor, randomUUID,
  });
  try {
    await controller.ensureReady();
    let current = await controller.getState();
    if (current.connection.phase !== "ready") throw current.issue?.error || new Error("Saved ChatGPT connection is not ready");
    await controller.setMode("act");
    await controller.submit(randomUUID(), "Find all functions named main in this repository. Report their file paths and function names.");
    const end = Date.now() + timeout;
    for (;;) {
      current = await controller.getState();
      if (!current.submission) break;
      if (["waiting_confirmation", "waiting_file"].includes(current.submission.phase)) {
        await controller.stop(current.submission.id);
        haltReason = "unexpected_user_interaction";
        current = await controller.getState();
        break;
      }
      if (Date.now() >= end) {
        await controller.stop(current.submission.id);
        haltReason = "deadline_exceeded";
        current = await controller.getState();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const answer = current.messages.at(-1);
    const sourcePaths = FILES.map((file) => `/repo/blob/master/${file}`);
    const sourceChecked = sourcePaths.every((path) => site.state.visited.includes(path));
    const outcome = scenario === "blocked"
      ? site.state.visited.some((path) => ["/repo/search", "/repo/tree/master"].includes(path))
      : sourceChecked && FILES.every((file) => answer.text.includes(file));
    return { scenario, answer: answer.text, status: answer.status, error: answer.error || null,
      toolCalls: calls, budgetExceeded, haltReason, passedChecks: answer.status === "complete" && !budgetExceeded && !haltReason && outcome,
      groundTruth: scenario === "blocked" ? "Indexing prevents both search and source browsing; no function findings are justified." : { files: FILES, sourceChecked },
      transitions: [...site.state.transitions], trace: structuredClone(site.trace) };
  } finally { site.close(); }
}
