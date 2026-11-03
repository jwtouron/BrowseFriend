import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HOST_CONTRACT } from "../../shared/host-contract.js";
import { createMessageDecoder, encodeMessage } from "../helpers/native-protocol.mjs";
import { PAGE_TOOL_SCHEMAS } from "../../shared/page-tools.js";
import { spawnHost } from "../helpers/host-process.mjs";

const valid = { model: "model-1", history: [], prompt: "Question", pageContext: "{}" };

function goDriver(t, mode = "") {
  const child = spawnHost("test", [mode], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  child.stdout.on("data", createMessageDecoder((event) => events.push(event), (e) => assert.fail(e)));
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  child.on("error", (e) => assert.fail(e));
  t.after(() => { child.stdin.end(); child.kill(); assert.equal(stderr, ""); });
  return { events, send(request) { child.stdin.write(encodeMessage(request)); }, close() { child.stdin.end(); } };
}

async function waitFor(predicate, label) {
  const end = Date.now() + (process.env.BROWSEFRIEND_TEST_WINE ? 30_000 : 5000);
  while (Date.now() < end) {
    const found = predicate();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("No native reply to " + label);
}
const response = (driver, id) => waitFor(() => driver.events.find((event) => event.id === id), id);

for (const runtime of ["native host"]) {
  test(runtime + ": native auth and model contracts", async (t) => {
    const driver = goDriver(t);
    const requests = [
      { id: "status", method: "auth.status" },
      { id: "login", method: "auth.signIn" },
      { id: "cancel-auth", method: "auth.cancel" },
      { id: "logout", method: "auth.signOut" },
      { id: "models", method: "model.list" },
      { id: "bad", method: "model.stream", params: { ...valid, reasoningEffort: "extreme" } },
      { id: "stream", method: "model.stream", params: { ...valid, reasoningEffort: "medium" } },
      { id: "tool", method: "model.stream", params: { ...valid, model: "tool", mode: "act" } },
      { id: "compact", method: "model.compact", params: { model: "model-1", history: [] } },
    ];
    const results = {};
    for (const request of requests) { driver.send(request); results[request.id] = await response(driver, request.id); }
    assert.deepEqual(results.status.result, { state: "signed_out", profile: null, planUsageEnabled: false });
    assert.equal(results.login.result.state, "signed_in");
    assert.equal(results.logout.result.state, "signed_out");
    assert.equal(results.models.result.models[0].defaultReasoningEffort, "medium");
    assert.equal(results.bad.error.code, "invalid_request");
    assert.deepEqual(results.stream.result, { completed: true });
    assert.equal(results.tool.result.toolCall.name, "page_click");
    assert.deepEqual(JSON.parse(results.compact.result.compactedContext), [{ type: "compaction", encrypted_content: "opaque" }]);
    const options = driver.events.filter((e) => e.event === "test.options").map((e) => e.options);
    assert.equal(options[0].reasoningEffort, "medium");
    assert.match(options[0].instructions, /untrusted data/);
    assert.equal(options[0].input.at(-1).content, valid.prompt);
    assert.deepEqual(options[1].tools, PAGE_TOOL_SCHEMAS);
    assert.equal(driver.events.filter((e) => e.event === "model.delta" && e.requestId === "stream").map((e) => e.delta).join(""), "Hello world");

    driver.send({ id: "waiting", method: "model.stream", params: { ...valid, model: "wait" } });
    await waitFor(() => driver.events.some((e) => e.event === "test.options" && e.options.model === "wait"), "stream start");
    driver.send({ id: "busy", method: "model.stream", params: valid });
    assert.equal((await response(driver, "busy")).error.code, "model_busy");
    driver.send({ id: "stop", method: "model.cancel", params: { requestId: "waiting" } });
    assert.equal((await response(driver, "stop")).result.cancelled, true);
    assert.equal((await response(driver, "waiting")).error.code, "cancelled");
    driver.close();
  });

  test(runtime + ": validation, compacted context, and typed continuations", async (t) => {
    const driver = goDriver(t);
    const compactedContext = '[{"type":"compaction","encrypted_content":"opaque"}]';
    const params = {
      ...valid, compactedContext, history: [{ role: "assistant", content: "Earlier" }],
      actionHistory: ["Clicked a link"],
      continuation: { callId: "previous", name: "page_click", arguments: '{"ref":"e1"}', output: '{"ok":true}' },
    };
    driver.send({ id: "continuation", method: "model.stream", params });
    assert.equal((await response(driver, "continuation")).ok, true);
    const options = driver.events.find((e) => e.event === "test.options").options;
    assert.equal(options.input[0].type, "compaction");
    assert.equal(options.input[1].content, "Earlier");
    assert.equal(options.input.at(-2).type, "function_call");
    assert.equal(options.input.at(-1).type, "function_call_output");
    assert.equal(options.input.at(-1).callId, "previous");
    assert.equal(Object.hasOwn(options, "conversation"), false);
    assert.equal(Object.hasOwn(options, "previous_response_id"), false);
    for (const [index, changed] of [
      { prompt: "x".repeat(4001) },
      { pageContext: "x".repeat(128 * 1024 + 1) },
      { history: [{ role: "developer", content: "Wrong role" }] },
      { compactedContext: "invalid" },
      { actionHistory: Array(33).fill("Clicked") },
    ].entries()) {
      const id = "invalid-" + index;
      driver.send({ id, method: "model.stream", params: { ...valid, ...changed } });
      assert.equal((await response(driver, id)).error.code, "invalid_request");
    }
    for (const [model, code] of [["multi", "multiple_tool_calls"], ["invalid", "invalid_tool_call"]]) {
      driver.send({ id: model, method: "model.stream", params: { ...valid, model, mode: "act" } });
      assert.equal((await response(driver, model)).error.code, code);
    }
    driver.close();
  });

  for (const mode of ["plan-disabled", "revocation-failure"]) {
    test(runtime + ": " + mode, async (t) => {
      const driver = goDriver(t, mode);
      if (mode === "plan-disabled") {
        driver.send({ id: "login", method: "auth.signIn" });
        assert.equal((await response(driver, "login")).result.state, "signed_in");
        assert.equal(driver.events.find((e) => e.event === "test.signIn").reconsent, true);
      } else {
        driver.send({ id: "logout", method: "auth.signOut" });
        const result = await response(driver, "logout");
        assert.equal(result.ok, true);
        assert.equal(result.result.state, "signed_out");
        assert.equal(result.warning.code, "revocation_failed");
      }
      driver.close();
    });
  }
}

test("native companion and extension share tools, instructions, and limits", async () => {
  const contract = JSON.parse(await readFile(new URL("../../shared/host-contract.json", import.meta.url), "utf8"));
  assert.deepEqual(contract.tools, PAGE_TOOL_SCHEMAS);
  assert.deepEqual(contract.limits, HOST_CONTRACT.limits);
  assert.equal(contract.baseInstructions, HOST_CONTRACT.baseInstructions);
});

test("production Go binary handles fragmented frames and recovers from malformed JSON", async (t) => {
  const child = spawnHost("native", [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  child.stdout.on("data", createMessageDecoder((event) => events.push(event), (e) => assert.fail(e)));
  child.on("error", (e) => assert.fail(e));
  t.after(() => { child.stdin.end(); child.kill(); });
  const malformed = Buffer.from("not-json");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(malformed.length);
  child.stdin.write(Buffer.concat([header, malformed]));
  const request = encodeMessage({ id: "unknown", method: "auth.readTokens" });
  child.stdin.write(request.subarray(0, 2));
  child.stdin.write(request.subarray(2, 10));
  child.stdin.write(request.subarray(10));
  const result = await response({ events }, "unknown");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_request");
  assert.equal(events.some((e) => e.event?.startsWith("test.")), false);
});

test("native Act context survives framed continuations and never crosses tasks", async (t) => {
  const driver = goDriver(t);
  async function step(params) {
    driver.events.splice(0);
    driver.send({ id: "task", method: "model.stream", params });
    const reply = await response(driver, "task");
    assert.equal(reply.ok, true);
    return { reply, options: driver.events.find((entry) => entry.event === "test.options").options };
  }
  const params = { ...valid, model: "context", mode: "act", pageContext: '{"text":"original-page"}' };
  let current = await step(params);
  for (let index = 1; index <= 2; index += 1) {
    const call = current.reply.result.toolCall;
    current = await step({ ...params, pageContext: JSON.stringify({ text: "page-" + index }),
      continuation: { ...call, output: '{"ok":true}' } });
  }
  assert.equal(current.reply.result.completed, true);
  const input = JSON.stringify(current.options.input);
  assert.match(input, /original-page/);
  assert.match(input, /page-1/);
  assert.match(input, /page-2/);
  assert.match(input, /synthetic-opaque/);
  assert.equal(current.options.input.filter((item) => item.type === "function_call_output").length, 2);
  current = await step(params);
  assert.doesNotMatch(JSON.stringify(current.options.input), /synthetic-opaque|page-1|page-2/);
  driver.events.splice(0);
  driver.send({ id: "stop", method: "model.cancel", params: { requestId: "task" } });
  assert.equal((await response(driver, "stop")).result.cancelled, true);
  driver.send({ id: "task", method: "model.stream", params: { ...params,
    continuation: { ...current.reply.result.toolCall, output: '{"ok":true}' } } });
  assert.equal((await response(driver, "task")).error.code, "act_context_lost");
});
