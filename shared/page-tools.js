export const PAGE_TOOL_SCHEMAS = Object.freeze([
  {
    type: "function",
    name: "page_navigate",
    description: "Navigate the current tab to an absolute HTTP(S) page URL. Use this for a user-requested destination that is not represented by a current page link. Prefer an authoritative site or search/listing page when the exact deep link is uncertain; use page_click for links and download controls.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: 4_000 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "page_scroll",
    description: "Scroll the current page without activating a control.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
        amount: { type: "string", enum: ["half", "viewport"] },
      },
      required: ["direction", "amount"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "page_click",
    description: "Activate a visible page control or ordinary HTTP(S) link by its current element ref.",
    strict: true,
    parameters: refParameters(),
  },
  {
    type: "function",
    name: "page_fill",
    description: "Replace the value of one visible, non-sensitive text control.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        ref: refSchema(),
        value: { type: "string", maxLength: 4_000 },
      },
      required: ["ref", "value"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "page_select",
    description: "Select one option in a visible select control using current element refs.",
    strict: true,
    parameters: {
      type: "object",
      properties: { ref: refSchema(), optionRef: refSchema() },
      required: ["ref", "optionRef"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "page_check",
    description: "Set a visible checkbox or radio control to the requested state.",
    strict: true,
    parameters: {
      type: "object",
      properties: { ref: refSchema(), checked: { type: "boolean" } },
      required: ["ref", "checked"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "page_submit",
    description: "Submit a form or activate a consequential control. BrowseFriend always confirms first.",
    strict: true,
    parameters: refParameters(),
  },
  {
    type: "function",
    name: "page_choose_file",
    description: "Locate a file-selection control and pause so the user can choose files directly on the page.",
    strict: true,
    parameters: refParameters(),
  },
  {
    type: "function",
    name: "page_wait_for_change",
    description: "Wait briefly for delayed same-page content to appear, then return a fresh page snapshot.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
]);

export const PAGE_TOOL_NAMES = new Set(PAGE_TOOL_SCHEMAS.map((tool) => tool.name));

function refSchema() {
  return { type: "string", pattern: "^e[0-9]+$", maxLength: 40 };
}

function refParameters() {
  return {
    type: "object",
    properties: { ref: refSchema() },
    required: ["ref"],
    additionalProperties: false,
  };
}

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
