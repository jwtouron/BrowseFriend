import { HOST_CONTRACT } from "./host-contract.js";

export const PAGE_TOOL_SCHEMAS = Object.freeze(HOST_CONTRACT.tools);

export const PAGE_TOOL_NAMES = new Set(PAGE_TOOL_SCHEMAS.map((tool) => tool.name));

function exactKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validRef(value) {
  return typeof value === "string" && /^e\d+$/.test(value) && value.length <= 40;
}

export function normalizePageNavigationUrl(value) {
  if (typeof value !== "string" || !value || value.length > 4_000) {
    throw new Error("Invalid navigation URL.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid navigation URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Navigation requires an HTTP(S) URL without embedded credentials.");
  }
  return url.href;
}

export function parsePageToolCall(call) {
  if (!call || typeof call !== "object" || typeof call.callId !== "string" ||
      !call.callId || !PAGE_TOOL_NAMES.has(call.name) || typeof call.arguments !== "string") {
    throw new Error("Invalid page tool call.");
  }

  let args;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    throw new Error("Page tool arguments were not valid JSON.");
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Page tool arguments must be an object.");
  }

  if (call.name === "page_navigate") {
    if (!exactKeys(args, ["url"])) throw new Error("Invalid navigation arguments.");
    args.url = normalizePageNavigationUrl(args.url);
  } else if (call.name === "page_scroll") {
    if (!exactKeys(args, ["direction", "amount"]) ||
        !["up", "down", "top", "bottom"].includes(args.direction) ||
        !["half", "viewport"].includes(args.amount)) throw new Error("Invalid scroll arguments.");
  } else if (call.name === "page_wait_for_change") {
    if (Object.keys(args).length) throw new Error("The wait tool does not accept arguments.");
  } else if (call.name === "page_fill") {
    if (!exactKeys(args, ["ref", "value"]) || !validRef(args.ref) ||
        typeof args.value !== "string" || args.value.length > 4_000) throw new Error("Invalid fill arguments.");
  } else if (call.name === "page_select") {
    if (!exactKeys(args, ["ref", "optionRef"]) || !validRef(args.ref) ||
        !validRef(args.optionRef)) throw new Error("Invalid select arguments.");
  } else if (call.name === "page_check") {
    if (!exactKeys(args, ["ref", "checked"]) || !validRef(args.ref) ||
        typeof args.checked !== "boolean") throw new Error("Invalid check arguments.");
  } else if (!exactKeys(args, ["ref"]) || !validRef(args.ref)) {
    throw new Error("Invalid target arguments.");
  }

  return { callId: call.callId, name: call.name, arguments: call.arguments, args };
}
