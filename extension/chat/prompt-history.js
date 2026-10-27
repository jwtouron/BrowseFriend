function samePrompts(left, right) {
  return left.length === right.length && left.every((prompt, index) => prompt === right[index]);
}

export function createPromptHistory() {
  let prompts = [];
  let cursor = 0;
  let navigating = false;

  function reset() {
    cursor = prompts.length;
    navigating = false;
  }

  function sync(nextPrompts) {
    const normalized = nextPrompts.map((prompt) => String(prompt));
    if (samePrompts(prompts, normalized)) return false;
    prompts = normalized;
    reset();
    return true;
  }

  function previous(currentValue) {
    if (!navigating) {
      if (!prompts.length || String(currentValue).trim()) return null;
      navigating = true;
      cursor = prompts.length;
    }
    if (cursor > 0) cursor -= 1;
    return prompts[cursor];
  }

  function next() {
    if (!navigating) return null;
    if (cursor < prompts.length - 1) {
      cursor += 1;
      return prompts[cursor];
    }
    reset();
    return "";
  }

  return {
    sync,
    previous,
    next,
    reset,
    isNavigating: () => navigating,
  };
}

export function composerShortcut(event) {
  if (event.isComposing) return null;
  const key = String(event.key || "").toLowerCase();
  const controlOnly = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (controlOnly && key === "u") return "clear";
  if (controlOnly && key === "p") return "previous";
  if (controlOnly && key === "n") return "next";

  const unmodified = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (unmodified && event.key === "ArrowUp") return "previous";
  if (unmodified && event.key === "ArrowDown") return "next";
  return null;
}
