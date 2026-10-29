import assert from "node:assert/strict";
import test from "node:test";
import { listModels } from "../../vendor/sign-in-with-chatgpt-devkit/packages/local/dist/models.js";
import { streamResponse } from "../../vendor/sign-in-with-chatgpt-devkit/packages/local/dist/responses.js";

const frame = (event) => `data: ${JSON.stringify(event)}\r\n\r\n`;

test("patched DevKit preserves supported reasoning efforts from the model catalog", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    models: [{
      slug: "model-1",
      display_name: "Model One",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Lighter" },
        { effort: "medium", description: "Balanced" },
        { effort: "unsupported", description: "Discard" },
      ],
    }],
  }));

  assert.deepEqual(await listModels("synthetic-oauth-token", new AbortController().signal), [{
    slug: "model-1",
    displayName: "Model One",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium"],
  }]);
});

test("patched DevKit sends strict tools and returns typed function calls", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    body = JSON.parse(init.body);
    const call = {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call-1",
        name: "page_click",
        arguments: '{"ref":"e1"}',
      },
    };
    const completed = { type: "response.completed", response: { status: "completed" } };
    return new Response(new TextEncoder().encode(frame(call) + frame(completed)), {
      headers: { "content-type": "text/event-stream" },
    });
  });

  const result = await streamResponse("synthetic-oauth-token", {
    model: "model-1",
    input: [
      { role: "user", content: "Open it" },
      { type: "function_call", callId: "old-call", name: "page_click", arguments: '{"ref":"e2"}' },
      { type: "function_call_output", callId: "old-call", output: '{"ok":true}' },
    ],
    tools: [{
      type: "function",
      name: "page_click",
      description: "Click",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    }],
    parallelToolCalls: false,
    reasoningEffort: "medium",
  }, new AbortController().signal);

  assert.deepEqual(result, {
    text: "",
    toolCalls: [{
      type: "function_call",
      callId: "call-1",
      name: "page_click",
      arguments: '{"ref":"e1"}',
    }],
  });
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.equal(body.tools[0].name, "page_click");
  assert.deepEqual(body.input[1], {
    type: "function_call",
    call_id: "old-call",
    name: "page_click",
    arguments: '{"ref":"e2"}',
  });
  assert.deepEqual(body.input[2], {
    type: "function_call_output",
    call_id: "old-call",
    output: '{"ok":true}',
  });
});
