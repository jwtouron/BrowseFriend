import { renderMarkdown } from "../chat/markdown.js";
import {
  applyTypographyField,
  defaultTypography,
  fontOptions,
  FONT_SIZES,
  normalizeFontList,
  normalizeTypography,
  TYPOGRAPHY_FIELDS,
} from "../settings/typography.js";

export function installTypographySettings({ document, preferences, fontSettings }) {
  const root = document.documentElement;
  const values = normalizeTypography();
  const controls = Object.fromEntries(Object.keys(TYPOGRAPHY_FIELDS)
    .map((name) => [name, document.querySelector(`[data-typography-setting="${name}"]`)]));
  const revisions = Object.fromEntries(Object.keys(controls).map((name) => [name, 0]));
  const saving = new Set();
  const errors = {
    prompt: document.querySelector("#prompt-typography-error"),
    response: document.querySelector("#response-typography-error"),
  };
  const fontError = document.querySelector("#font-list-error");
  const retryFonts = document.querySelector("#retry-fonts");
  let initialized = false;
  let fonts = [];
  let fontPhase = "idle";
  let fontRequest = null;

  const defaults = defaultTypography(document);
  root.style.setProperty("--transcript-default-font-family", defaults.fontFamily);
  for (const name of ["promptFontSize", "responseFontSize"]) {
    for (const value of ["default", ...FONT_SIZES]) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = value === "default" ? `Default (${defaults.fontSize} px)` : `${value} px`;
      controls[name].append(option);
    }
  }
  renderMarkdown(document.querySelector("#response-font-preview"),
    "A helpful answer with **emphasis**, *detail*, and `code`.");

  function render(name) {
    const control = controls[name];
    const value = values[name];
    if (name.endsWith("Font")) {
      const options = fontOptions(fonts, value, defaults.fontLabel).map((font) => {
        const option = document.createElement("option");
        option.value = font.fontId;
        option.textContent = font.displayName;
        option.disabled = font.disabled === true;
        return option;
      });
      control.replaceChildren(...options);
      const note = document.querySelector(`#${name === "promptFont" ? "prompt" : "response"}-font-note`);
      note.hidden = fontPhase !== "ready" || value === "default" || fonts.some((font) => font.fontId === value);
    }
    if (control.type === "checkbox") control.checked = value;
    else control.value = String(value);
    control.disabled = !initialized || saving.has(name) || (name.endsWith("Font") && fontPhase === "loading");
    applyTypographyField(root, name, value);
  }

  function apply(update) {
    for (const [name, field] of Object.entries(TYPOGRAPHY_FIELDS)) {
      if (!Object.hasOwn(update, name)) continue;
      revisions[name]++;
      values[name] = field.normalize(update[name]);
      render(name);
    }
  }

  function initialize(stored, error = null) {
    initialized = true;
    for (const [name, field] of Object.entries(TYPOGRAPHY_FIELDS)) {
      // A storage notification may have arrived while the initial read was pending.
      if (revisions[name] === 0) values[name] = field.normalize(stored[name]);
      render(name);
    }
    if (error) {
      for (const element of Object.values(errors)) {
        element.textContent = "BrowseFriend could not load saved font settings.";
        element.hidden = false;
      }
    }
  }

  async function save(name) {
    if (!initialized || saving.has(name)) return;
    const control = controls[name];
    const previous = values[name];
    const requested = control.type === "checkbox" ? control.checked
      : name.endsWith("FontSize") && control.value !== "default" ? Number(control.value) : control.value;
    const revision = ++revisions[name];
    values[name] = TYPOGRAPHY_FIELDS[name].normalize(requested);
    saving.add(name);
    const error = errors[name.startsWith("prompt") ? "prompt" : "response"];
    error.hidden = true;
    render(name);
    try {
      const saved = await preferences.saveTypography(name, values[name]);
      if (revisions[name] === revision) values[name] = saved;
    } catch {
      if (revisions[name] === revision) {
        values[name] = previous;
        error.textContent = "BrowseFriend could not save this font setting. Please try again.";
        error.hidden = false;
      }
    } finally {
      saving.delete(name);
      render(name);
    }
  }

  function refreshFonts() {
    if (fontRequest) return fontRequest;
    fontPhase = "loading";
    fontError.hidden = true;
    retryFonts.hidden = true;
    render("promptFont");
    render("responseFont");
    const request = Promise.resolve().then(() => {
      if (!fontSettings?.getFontList) throw new Error("Font discovery is unavailable.");
      return fontSettings.getFontList();
    }).then((entries) => {
      fonts = normalizeFontList(entries);
      fontPhase = "ready";
    }).catch(() => {
      fontPhase = "error";
      fontError.textContent = "Installed fonts could not be listed. Default is still available.";
      fontError.hidden = false;
      retryFonts.hidden = false;
    }).finally(() => {
      if (fontRequest === request) fontRequest = null;
      render("promptFont");
      render("responseFont");
    });
    fontRequest = request;
    return request;
  }

  for (const [name, control] of Object.entries(controls)) {
    control.addEventListener("change", () => void save(name));
    render(name);
  }
  preferences.subscribe(apply);
  retryFonts.addEventListener("click", () => void refreshFonts());
  return { initialize, refreshFonts };
}
