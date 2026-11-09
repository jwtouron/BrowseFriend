const PREFIX = "browsefriend.settings.";
export const DEFAULT_FONT_LABEL = "Default (Inter / system)";
export const DEFAULT_CODE_FONT_LABEL = "Default (system monospace)";
export const FONT_SIZES = Object.freeze([
  8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 28, 32, 36,
]);

export function normalizeFont(value) {
  if (typeof value !== "string") return "default";
  const font = value.trim();
  return font && font.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(font)
    ? font : "default";
}

export function normalizeFontSize(value) {
  return FONT_SIZES.includes(value) ? value : "default";
}

const boolean = (value) => value === true;
export const TYPOGRAPHY_FIELDS = Object.freeze({
  promptFont: { key: PREFIX + "promptFont", normalize: normalizeFont, css: "--prompt-font-family" },
  promptFontSize: { key: PREFIX + "promptFontSize", normalize: normalizeFontSize, css: "--prompt-font-size" },
  promptBold: { key: PREFIX + "promptBold", normalize: boolean, css: "--prompt-font-weight" },
  promptItalic: { key: PREFIX + "promptItalic", normalize: boolean, css: "--prompt-font-style" },
  responseFont: { key: PREFIX + "responseFont", normalize: normalizeFont, css: "--response-font-family" },
  responseCodeFont: { key: PREFIX + "responseCodeFont", normalize: normalizeFont, css: "--response-code-font-family" },
  responseFontSize: { key: PREFIX + "responseFontSize", normalize: normalizeFontSize, css: "--response-font-size" },
});

export function normalizeTypography(values = {}) {
  return Object.fromEntries(Object.entries(TYPOGRAPHY_FIELDS)
    .map(([name, field]) => [name, field.normalize(values[name])]));
}

export function normalizeFontList(entries) {
  const fonts = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const fontId = normalizeFont(entry?.fontId);
    if (fontId === "default" || fonts.has(fontId)) continue;
    const displayName = normalizeFont(entry.displayName);
    fonts.set(fontId, { fontId, displayName: displayName === "default" ? fontId : displayName });
  }
  return sortFonts([...fonts.values()]);
}

function sortFonts(fonts) {
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  return fonts.sort((a, b) => collator.compare(a.displayName, b.displayName) ||
    a.fontId.localeCompare(b.fontId));
}

export function fontOptions(fonts, selected = "default", defaultLabel = DEFAULT_FONT_LABEL) {
  const options = [...fonts];
  if (selected !== "default" && !options.some((font) => font.fontId === selected)) {
    options.push({ fontId: selected, displayName: `${selected} (unavailable)`, disabled: true });
  }
  return [{ fontId: "default", displayName: defaultLabel }, ...sortFonts(options)];
}

export function defaultTypography(document) {
  const view = document.defaultView;
  const body = view.getComputedStyle(document.body);
  const root = view.getComputedStyle(document.documentElement);
  const fontFamily = body.fontFamily || root.fontFamily;
  const firstFamily = fontFamily.match(/^(?:"([^"]+)"|'([^']+)'|([^,]+))/);
  const name = firstFamily?.slice(1).find(Boolean)?.trim();
  return {
    fontFamily,
    fontSize: Number.parseFloat(body.fontSize) || Number.parseFloat(root.fontSize) || 16,
    fontLabel: name && name !== "Inter" ? `Default (${name})` : DEFAULT_FONT_LABEL,
  };
}

export function applyTypographyField(root, name, rawValue) {
  const field = TYPOGRAPHY_FIELDS[name];
  const value = field.normalize(rawValue);
  let cssValue = null;
  if (name.endsWith("Font") && value !== "default") {
    // A font name is one CSS string, even if it contains quotes, commas, or semicolons.
    const fallback = name === "responseCodeFont" ? "--transcript-default-code-font-family" : "--transcript-default-font-family";
    cssValue = `"${value.replace(/[\\"]/g, "\\$&")}", var(${fallback})`;
  } else if (name.endsWith("FontSize") && value !== "default") cssValue = `${value}px`;
  else if (name === "promptBold" && value) cssValue = "700";
  else if (name === "promptItalic" && value) cssValue = "italic";
  if (cssValue === null) root.style.removeProperty(field.css);
  else root.style.setProperty(field.css, cssValue);
  if (name === "responseFontSize") {
    if (value === "default") root.style.removeProperty("--response-font-scale");
    else root.style.setProperty("--response-font-scale", String(value / defaultTypography(root.ownerDocument).fontSize));
  }
  return value;
}
