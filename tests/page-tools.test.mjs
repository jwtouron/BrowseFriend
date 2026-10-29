import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_TOOL_SCHEMAS, parsePageToolCall } from "../shared/page-tools.js";

test("page tools expose only the fixed allowlist with strict object schemas", () => {
  assert.deepEqual(PAGE_TOOL_SCHEMAS.map((tool) => tool.name), [
    "page_scroll",
    "page_click",
    "page_fill",
    "page_select",
    "page_check",
    "page_submit",
    "page_choose_file",
    "page_wait_for_change",
  ]);
  assert.equal(PAGE_TOOL_SCHEMAS.every((tool) =>
    tool.type === "function" && tool.strict === true && tool.parameters.additionalProperties === false), true);
});

test("page tool parser returns validated arguments and rejects selectors or extra fields", () => {
  assert.deepEqual(parsePageToolCall({
    callId: "call-1",
    name: "page_fill",
    arguments: '{"ref":"e12","value":"Chicago"}',
  }).args, { ref: "e12", value: "Chicago" });

  assert.throws(() => parsePageToolCall({
    callId: "call-2",
    name: "page_click",
    arguments: '{"ref":"e1","selector":"#pay"}',
  }), /Invalid target/);
  assert.throws(() => parsePageToolCall({
    callId: "call-3",
    name: "page_click",
    arguments: '{"ref":"#pay"}',
  }), /Invalid target/);
  assert.throws(() => parsePageToolCall({
    callId: "call-4",
    name: "page_eval",
    arguments: "{}",
  }), /Invalid page tool/);
});
