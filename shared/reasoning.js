export const REASONING_EFFORT_ORDER = Object.freeze([
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
]);

export const REASONING_EFFORTS = new Set(REASONING_EFFORT_ORDER);
export const REASONING_EFFORT_LABELS = Object.freeze({
  max: "Maximum",
  xhigh: "Extra high",
  high: "High",
  medium: "Medium",
  low: "Low",
  minimal: "Minimal",
  none: "None",
});
export const REASONING_PREFERENCES = new Set([
  "model_default",
  ...REASONING_EFFORT_ORDER,
]);

export function normalizeReasoningPreference(value) {
  return REASONING_PREFERENCES.has(value) ? value : "model_default";
}

export function supportedReasoningEfforts(model) {
  if (!Array.isArray(model?.supportedReasoningEfforts)) return [];
  return [...new Set(model.supportedReasoningEfforts.filter((effort) => REASONING_EFFORTS.has(effort)))];
}

export function reasoningEffortOptions(model) {
  const defaultEffort = REASONING_EFFORTS.has(model?.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : null;
  const options = [{
    value: "model_default",
    label: defaultEffort ? `Model default (${defaultEffort})` : "Model default",
  }];
  const supported = supportedReasoningEfforts(model);
  for (const effort of REASONING_EFFORT_ORDER) {
    if (supported.includes(effort)) {
      options.push({ value: effort, label: REASONING_EFFORT_LABELS[effort] });
    }
  }
  return options;
}

export function selectReasoningEffort(model, preference) {
  const normalized = normalizeReasoningPreference(preference);
  if (normalized === "model_default") return undefined;

  const supported = supportedReasoningEfforts(model);
  return supported.includes(normalized) ? normalized : undefined;
}

export function effectiveReasoningEffort(model, preference) {
  const normalized = normalizeReasoningPreference(preference);
  if (normalized !== "model_default" && supportedReasoningEfforts(model).includes(normalized)) {
    return normalized;
  }
  return REASONING_EFFORTS.has(model?.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : undefined;
}

export function reasoningEffortLabel(effort) {
  return REASONING_EFFORT_LABELS[effort] || "";
}
