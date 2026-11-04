import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { runCase } from "./harness.mjs";
import { startHost, parseGrade, passedGrade } from "./host.mjs";
import { SCENARIOS } from "./site.mjs";

async function main() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const { values } = parseArgs({ options: { "baseline-host": { type: "string" }, "baseline-harness": { type: "string" }, "auth-timeout": { type: "string", default: "120" }, model: { type: "string" }, effort: { type: "string", default: "medium" }, repeat: { type: "string", default: "1" } } });
  if (!values.model || !/^[1-9]\d*$/.test(values.repeat)) throw new Error("Usage: npm run eval:act -- --model <slug> [--effort medium] [--repeat N] [--baseline-host <pre-change-evaluator>]");
  const baselineCase = values["baseline-harness"]
    ? (await import(pathToFileURL(resolve(values["baseline-harness"])))).runCase : runCase;
  if (values["baseline-host"] && !values["baseline-harness"]) throw new Error("Context comparisons require --baseline-harness with the preserved matching controller/harness.");
  const authTimeout = Number(values["auth-timeout"]);
  if (!Number.isSafeInteger(authTimeout) || authTimeout < 1 || authTimeout > 600) throw new Error("Invalid authentication timeout");
  const repeats = Number(values.repeat);
  if (!Number.isSafeInteger(repeats)) throw new Error("Invalid repeat count");
  const directory = join(root, "build", "act-evaluation", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(directory, { recursive: true });
  const executable = join(directory, `eval-act${process.platform === "win32" ? ".exe" : ""}`);
  execFileSync("go", ["build", "-o", executable, "./native-host/cmd/eval-act"], { cwd: root, stdio: "inherit" });
  const baseline = values["baseline-host"] ? join(directory, "instructions.txt") : join(root, "tests", "act-evaluation", "baseline.txt");
  const contract = JSON.parse(await readFile(join(root, "shared", "host-contract.json"), "utf8"));
  if (values["baseline-host"]) await writeFile(baseline, contract.actInstructions);
  if (!contract.efforts.includes(values.effort)) throw new Error("Unsupported effort");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const report = { comparison: values["baseline-host"] ? "context" : "instructions", model: values.model, effort: values.effort, repeats, instructions: {
    baseline: hash(await readFile(baseline)), candidate: hash(contract.actInstructions),
  }, fixtureHash: hash(await readFile(new URL("./site.mjs", import.meta.url))), executables: { baseline: hash(await readFile(values["baseline-host"] ? resolve(values["baseline-host"]) : executable)), candidate: hash(await readFile(executable)) }, runs: [] };
  const currentSite = await readFile(new URL("./site.mjs", import.meta.url));
  if (values["baseline-harness"] && hash(await readFile(join(dirname(resolve(values["baseline-harness"])), "site.mjs"))) !== hash(currentSite)) {
    throw new Error("Baseline and candidate must use identical site fixtures.");
  }
  report.harnesses = {
    baseline: hash(await readFile(values["baseline-harness"] ? resolve(values["baseline-harness"]) : new URL("./harness.mjs", import.meta.url))),
    candidate: hash(await readFile(new URL("./harness.mjs", import.meta.url))),
  };
  let active;
  report.controllers = {
    baseline: hash(await readFile(values["baseline-harness"] ? join(dirname(resolve(values["baseline-harness"])), "../../extension/app/background.js") : new URL("../../extension/app/background.js", import.meta.url))),
    candidate: hash(await readFile(new URL("../../extension/app/background.js", import.meta.url))),
  };
  const hosts = new Map();
  async function getHost(key, path, args = []) {
    if (!hosts.has(key)) {
      const host = startHost(path, args);
      hosts.set(key, host);
      const auth = await host.request("auth.status");
      if (auth.result.state !== "signed_in") {
        console.log(`Complete ChatGPT sign-in in the browser for the ${key} evaluator. Credentials stay in that Go process.`);
        const timer = setTimeout(() => { void host.request("auth.cancel").catch(() => {}); }, authTimeout * 1000);
        let signedIn;
        try { signedIn = await host.request("auth.signIn"); } finally { clearTimeout(timer); }
        if (signedIn.result?.state !== "signed_in") throw new Error("Evaluation needs ChatGPT plan permission.");
      }
    }
    return hosts.get(key);
  }
  let interrupted = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    interrupted = true;
    for (const host of hosts.values()) void host.close().catch(() => {});
  });
  async function save() {
    await writeFile(join(directory, "results.json"), JSON.stringify(report, null, 2));
    await writeFile(join(directory, "report.txt"), [`Model: ${report.model}; effort: ${report.effort}`, ...(report.error ? [report.error.message] : []), ...report.runs.map((run) => `${run.repeat} ${run.scenario} ${run.variant}: ${run.error ? "INCONCLUSIVE" : run.passed ? "PASS" : "FAIL"}\nChecks: ${run.task?.passedChecks ?? "incomplete"}; requested tools: ${run.task?.toolCalls ?? 0}\n${run.grade?.rationale || run.error?.message || ""}\nAnswer: ${run.task?.answer || "(none)"}`)].join("\n"));
  }
  try {
    const preflight = await getHost("candidate", executable, ["-baseline", baseline]);
    {
      const catalog = (await preflight.request("model.list")).result.models;
      const model = catalog.find((entry) => entry.slug === values.model);
      if (!model) throw new Error(`Requested model unavailable. Available: ${catalog.map((entry) => entry.slug).join(", ")}`);
      if (model.supportedReasoningEfforts?.length && !model.supportedReasoningEfforts.includes(values.effort)) throw new Error("Requested effort unsupported by selected model");
    }
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const scenario of SCENARIOS) {
        for (const variant of repeat % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
          if (interrupted) throw new Error("Evaluation interrupted");
          console.log(`${repeat + 1}/${repeats}: ${scenario}, ${variant}`);
          const entry = { repeat: repeat + 1, scenario, variant };
          report.runs.push(entry);
          active = variant === "baseline" && values["baseline-host"]
            ? await getHost("baseline", resolve(values["baseline-host"]), ["-baseline", baseline])
            : preflight;
          if (active === preflight) await active.request("eval.configure", { variant });
          entry.task = await (variant === "baseline" ? baselineCase : runCase)({ scenario, companion: active, model: values.model, effort: values.effort });
          if (interrupted) throw new Error("Evaluation interrupted");
          if (scenario === "compaction" && !entry.task.compactionUsed) {
            const error = entry.task.trace.find((item) => item.kind === "compaction" && item.error)?.error;
            throw new Error(`Compaction was unavailable (${error?.code || "no context returned"}); raw-history fallback cannot verify this comparison.`);
          }
          if (entry.task.error) {
            const code = entry.task.error.code || "";
            if (!["eval_budget_exceeded", "action_loop_detected", "action_limit_reached", "act_context_limit"].includes(code)) throw new Error(`Model request failed: ${code}`);
          }
          active = preflight;
          await active.request("eval.configure", { variant: "judge" });
          let text = "";
          try {
            await active.request("model.stream", { model: values.model, reasoningEffort: values.effort,
              history: [{ role: "user", content: JSON.stringify({ scenario: entry.task.scenario, groundTruth: entry.task.groundTruth, trace: entry.task.trace, answer: entry.task.answer, transitions: entry.task.transitions }) }],
              conversationId: "evaluation-judge", prompt: "Grade this synthetic website task using your rubric.", pageContext: "", mode: "ask" }, (event) => { text += event.delta || ""; });
            entry.grade = parseGrade(text);
            entry.passed = entry.task.passedChecks && passedGrade(entry.grade);
          } finally { active = null; }
          await save();
        }
      }
    }
  } catch (error) {
    const last = report.runs.at(-1);
    if (last) last.error = { message: error.message || error.code || "Evaluation failed" };
    else report.error = { message: error.message || error.code };
    process.exitCode = 2;
  } finally {
    for (const host of hosts.values()) await host.close();
    await save();
  }
  if (!process.exitCode && report.runs.some((run) => run.variant === "candidate" && !run.passed)) process.exitCode = 1;
  console.log(`Results: ${directory}`);
}

main().catch((error) => {
  console.error(`Evaluation could not start: ${error.message}`);
  process.exitCode = 2;
});
