import assert from "node:assert/strict";
import test from "node:test";
import { createSite, FILES } from "./act-evaluation/site.mjs";
import { runCase } from "./act-evaluation/harness.mjs";
import { parseGrade, passedGrade } from "./act-evaluation/host.mjs";
import { installPageReader } from "../extension/page/read/background.js";
import { installPageActor } from "../extension/page/act/background.js";

function scripted(steps) {
  let index = 0;
  return {
    subscribe() { return () => {}; },
    async request(method, params, delta) {
      if (method === "auth.status") return { result: { state: "signed_in", planUsageEnabled: true } };
      if (method === "model.list") return { result: { models: [{ slug: "fixture-model", supportedReasoningEfforts: ["medium"] }] } };
      if (method === "model.stream") {
        const step = steps(index++, params);
        if (typeof step === "string") { delta({ delta: step }); return { result: { completed: true } }; }
        return { result: { toolCall: { callId: `call-${index}`, name: "page_navigate", arguments: JSON.stringify({ url: step.url }) } } };
      }
      if (method === "model.compact") return { result: {
        compactedContext: '[{"type":"compaction","encrypted_content":"fixture-opaque"}]',
        contextHandle: "fixture-handle", contextBytes: 69,
      } };
      return { result: {} };
    },
  };
}

test("HTML fixtures run through real extraction, refs, click navigation and revisions", async () => {
  const site = await createSite("alternative");
  try {
    const reader = installPageReader(site);
    const actor = installPageActor({ ...site, pageReader: reader });
    const first = await reader.capture();
    const control = first.snapshot.records.find((entry) => entry.name === "Browse files");
    assert.ok(control.ref);
    const context = { available: true, tabId: 1, ...first.snapshot };
    const call = { name: "page_click", args: { ref: control.ref } };
    assert.equal((await actor.prepare(call, context)).requiresConfirmation, false);
    await actor.execute(call, context);
    const second = await reader.captureAfterNavigation(context);
    assert.notEqual(first.snapshot.documentId, second.snapshot.documentId);
    assert.match(JSON.stringify(second.snapshot), /cmd\/client\/main.go/);
    await assert.rejects(actor.prepare({ name: "page_navigate", args: { url: "https://fixture.test/repo" } }, context), (e) => e.code === "stale_page");
  } finally { site.close(); }
});

test("fixture mutation changes the snapshot without navigation and resets per run", async () => {
  const site = await createSite("changed");
  try {
    const reader = installPageReader(site);
    await site.tabs.update(1, { url: "https://fixture.test/repo/search" });
    const before = await reader.capture(); site.advance();
    const after = await reader.capture();
    assert.equal(after.snapshot.documentId, before.snapshot.documentId);
    assert.ok(after.snapshot.revision > before.snapshot.revision);
    assert.match(JSON.stringify(after.snapshot), /cmd\/client\/main.go/);
  } finally { site.close(); }
  const fresh = await createSite("changed");
  assert.equal(fresh.state.ready, false); fresh.close();
});

test("controller reaches known source files through actual navigation and recapture", async () => {
  const companion = scripted((index) => index < 2 ? { url: `https://fixture.test/repo/blob/master/${FILES[index]}` } : `Found main in ${FILES.join(" and ")}`);
  const result = await runCase({ scenario: "alternative", companion, model: "fixture-model" });
  assert.equal(result.passedChecks, true);
  assert.equal(result.toolCalls, 2);
});

test("voluntary blocked completion differs from harness budget exhaustion", async () => {
  const result = await runCase({ scenario: "blocked", model: "fixture-model", companion: scripted((index) => index === 0 ? { url: "https://fixture.test/repo/search" } : "Indexing blocks the search; I cannot identify the functions yet.") });
  assert.equal(result.passedChecks, true);
  const loop = await runCase({ scenario: "blocked", model: "fixture-model", companion: scripted((index) => ({ url: `https://fixture.test/repo/search?q=${index}` })) });
  assert.equal(loop.passedChecks, false); assert.equal(loop.budgetExceeded, true);
});

test("task deadline cancels the active request", async () => {
  const companion = scripted(() => "unused"); let cancel;
  const original = companion.request;
  companion.request = (method, ...args) => method === "model.stream" ? new Promise((_, reject) => { cancel = () => reject({ code: "cancelled" }); }) : method === "model.cancel" ? (cancel?.(), Promise.resolve({ result: {} })) : original(method, ...args);
  const result = await runCase({ scenario: "blocked", model: "fixture-model", companion, timeout: 30 });
  assert.equal(result.passedChecks, false);
  assert.equal(result.haltReason, "deadline_exceeded");
});

test("grader schema is strict and cannot override deterministic failures", () => {
  const grade = parseGrade('{"accurateOutcome":true,"unsupportedClaims":false,"unproductiveRepetition":false,"rationale":"Evidence supports completion."}');
  assert.equal(passedGrade(grade), true);
  assert.equal(passedGrade({ ...grade, unsupportedClaims: true }), false);
  for (const raw of ["bad", "null", "[]", "{}", JSON.stringify({ ...grade, extra: true }), JSON.stringify({ ...grade, accurateOutcome: "yes" })]) assert.throws(() => parseGrade(raw));
});

test("changed conditions permit a controller continuation with a fresh snapshot", async () => {
  const inspected = new Set();
  const companion = scripted((_index, params) => {
    const page = JSON.parse(params.pageContext);
    const file = FILES.find((name) => page.url.endsWith(name));
    if (file) inspected.add(file);
    if (page.url.endsWith("/repo")) return { url: "https://fixture.test/repo/search" };
    if (!page.records.some((record) => record.href?.includes("/blob/")) && !file) return { url: "https://fixture.test/repo/search" };
    const next = FILES.find((name) => !inspected.has(name));
    return next ? { url: `https://fixture.test/repo/blob/master/${next}` } : `Found main in ${FILES.join(" and ")}`;
  });
  const result = await runCase({ scenario: "changed", model: "fixture-model", companion });
  assert.equal(result.passedChecks, true);
  assert.deepEqual(result.transitions, ["indexing completed"]);
});

test("recoverable search failure accurately advertises the alternative route", async () => {
  const site = await createSite("alternative");
  try {
    await site.tabs.update(1, { url: "https://fixture.test/repo/search" });
    const page = await installPageReader(site).capture();
    assert.match(JSON.stringify(page.snapshot), /File browsing remains available/);
  } finally { site.close(); }
});

test("compaction fixture preserves an older requirement while Act inspects both files", async () => {
  let compactInput;
  const companion = scripted((index, params) => {
    if (!params.continuation) assert.ok(params.contextHandle || params.compactedContext);
    assert.doesNotMatch(JSON.stringify(params.history), /cobalt/);
    return index < 2 ? { url: `https://fixture.test/repo/blob/master/${FILES[index]}` } :
      `Found main in ${FILES.join(" and ")}. Project codeword: cobalt.`;
  });
  const request = companion.request;
  companion.request = (method, params, ...args) => {
    if (method === "model.compact") compactInput = structuredClone(params);
    return request(method, params, ...args);
  };
  const result = await runCase({ scenario: "compaction", companion, model: "fixture-model" });
  assert.equal(result.passedChecks, true);
  assert.equal(result.compactionUsed, true);
  assert.ok(JSON.stringify(result.trace).length < 100_000);
  assert.doesNotMatch(JSON.stringify(result.trace), /encrypted_content|fixture-opaque/);
  assert.match(JSON.stringify(compactInput.history), /cobalt/);
  assert.equal(compactInput.history.length, 4);
});

test("unavailable compaction cannot pass the context comparison through raw-history fallback", async () => {
  const companion = scripted((index) => index < 2 ? { url: `https://fixture.test/repo/blob/master/${FILES[index]}` } :
    `Found main in ${FILES.join(" and ")}. Codeword: cobalt.`);
  const request = companion.request;
  companion.request = (method, ...args) => {
    if (method === "model.compact") throw { code: "hardened_oauth_rule_missing", status: 401 };
    return request(method, ...args);
  };
  const result = await runCase({ scenario: "compaction", companion, model: "fixture-model" });
  assert.equal(result.compactionUsed, false);
  assert.equal(result.passedChecks, false);
  assert.deepEqual(result.trace.find((entry) => entry.kind === "compaction").error,
    { code: "hardened_oauth_rule_missing", status: 401 });
  assert.ok(JSON.stringify(result.trace).length < 100_000);
});
