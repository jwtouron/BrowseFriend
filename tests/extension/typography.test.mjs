import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  applyTypographyField,
  DEFAULT_CODE_FONT_LABEL,
  DEFAULT_FONT_LABEL,
  defaultTypography,
  FONT_SIZES,
  fontOptions,
  normalizeFont,
  normalizeFontList,
  normalizeFontSize,
  normalizeTypography,
  TYPOGRAPHY_FIELDS,
} from "../../extension/settings/typography.js";
import { installTypographySettings } from "../../extension/sidepanel/typography.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, { stored = {}, save, discover } = {}) {
  const html = await readFile(new URL("../../extension/sidepanel/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html);
  const { document } = dom.window;
  document.documentElement.style.fontSize = "20px";
  document.body.style.fontFamily = "Inter";
  t.after(() => dom.window.close());
  const writes = [];
  let subscriber;
  const view = installTypographySettings({
    document,
    fontSettings: { getFontList: discover || (async () => [
      { fontId: "Zulu", displayName: "Zulu" }, { fontId: "Alpha", displayName: "Alpha" },
    ]) },
    preferences: {
      subscribe(listener) { subscriber = listener; },
      async saveTypography(name, value) {
        writes.push({ name, value });
        return save ? save(name, value) : value;
      },
    },
  });
  return {
    document, view, writes,
    initialize(error = null) { view.initialize(stored, error); },
    notify(update) { subscriber(update); },
    control(name) { return document.querySelector(`[data-typography-setting="${name}"]`); },
    async change(name, value) {
      const control = this.control(name);
      if (control.type === "checkbox") control.checked = value;
      else control.value = String(value);
      control.dispatchEvent(new dom.window.Event("change"));
      await settle();
    },
    css(name) { return document.documentElement.style.getPropertyValue(TYPOGRAPHY_FIELDS[name].css); },
  };
}

test("typography defaults preserve inherited fonts and only allow the selected size range", () => {
  assert.deepEqual(normalizeTypography(), {
    promptFont: "default", promptFontSize: "default", promptBold: false, promptItalic: false,
    responseFont: "default", responseCodeFont: "default", responseFontSize: "default",
  });
  assert.deepEqual(FONT_SIZES, [...Array.from({ length: 17 }, (_, index) => index + 8), 28, 32, 36]);
  for (const value of [7, 25, 37, Infinity, "16", null]) assert.equal(normalizeFontSize(value), "default");
  assert.equal(normalizeFontSize(36), 36);
  assert.equal(normalizeFont("  Font Name  "), "Font Name");
  assert.equal(normalizeFont("Bad\nFont"), "default");
  assert.equal(normalizeFont("x".repeat(513)), "default");
});

test("installed font names are deduplicated and alphabetized after Default", () => {
  const fonts = normalizeFontList([
    { fontId: "z", displayName: "Zulu" }, { fontId: "b", displayName: "beta" },
    { fontId: "a", displayName: "Alpha" }, { fontId: "a", displayName: "duplicate" },
    { fontId: "bad\nfont", displayName: "Invalid" }, null,
  ]);
  assert.deepEqual(fonts.map((font) => font.displayName), ["Alpha", "beta", "Zulu"]);
  const options = fontOptions(fonts, "Missing Font");
  assert.equal(options[0].displayName, DEFAULT_FONT_LABEL);
  assert.deepEqual(options.slice(1).map((font) => font.displayName), ["Alpha", "beta", "Missing Font (unavailable)", "Zulu"]);
  assert.equal(options[3].disabled, true);
});

test("font CSS is quoted safely and defaults remove overrides", () => {
  const dom = new JSDOM("");
  const root = dom.window.document.documentElement;
  applyTypographyField(root, "promptFont", 'Font "Name", Example; color: red');
  assert.match(root.style.getPropertyValue("--prompt-font-family"), /^"Font \\"Name\\", Example; color: red", var\(--transcript-default-font-family\)$/);
  assert.equal(root.style.color, "");
  applyTypographyField(root, "responseCodeFont", 'Code "Name", Example; color: red');
  assert.match(root.style.getPropertyValue("--response-code-font-family"), /^"Code \\"Name\\", Example; color: red", var\(--transcript-default-code-font-family\)$/);
  assert.equal(root.style.color, "");
  applyTypographyField(root, "promptFontSize", 24);
  applyTypographyField(root, "promptBold", true);
  applyTypographyField(root, "promptItalic", true);
  assert.equal(root.style.getPropertyValue("--prompt-font-size"), "24px");
  assert.equal(root.style.getPropertyValue("--prompt-font-weight"), "700");
  assert.equal(root.style.getPropertyValue("--prompt-font-style"), "italic");
  for (const [name, value] of Object.entries(normalizeTypography())) applyTypographyField(root, name, value);
  assert.equal(root.style.length, 0);
  dom.window.close();
});

test("Default reflects extension-page body typography rather than forcing the root font and size", () => {
  const dom = new JSDOM('<html style="font-size:16px;font-family:Inter"><body style="font-size:12px;font-family:Noto Sans"></body></html>');
  assert.deepEqual(defaultTypography(dom.window.document), {
    fontFamily: '"Noto Sans"', fontSize: 12, fontLabel: "Default (Noto Sans)",
  });
  applyTypographyField(dom.window.document.documentElement, "responseFontSize", 36);
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--response-font-scale"), "3");
  applyTypographyField(dom.window.document.documentElement, "responseFontSize", "default");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--response-font-scale"), "");
  dom.window.close();
});

test("signed-out font controls initialize independently and previews retain Markdown", async (t) => {
  const panel = await fixture(t);
  assert.equal(panel.control("promptFontSize").disabled, true);
  panel.initialize();
  await panel.view.refreshFonts();
  assert.equal(panel.control("promptFontSize").options[0].textContent, "Default (20 px)");
  assert.deepEqual([...panel.control("promptFont").options].map((option) => option.textContent), [DEFAULT_FONT_LABEL, "Alpha", "Zulu"]);
  assert.equal(panel.document.querySelector("#response-font-preview strong").textContent, "emphasis");
  assert.equal(panel.document.querySelector("#response-font-preview em").textContent, "detail");
  assert.equal(panel.document.querySelector("#response-font-preview code").textContent, "code");
  assert.equal(panel.document.querySelector("#response-font-preview pre code").textContent.trim(), "const answer = 42;");
  assert.deepEqual([...panel.control("responseCodeFont").options].map((option) => option.textContent), [DEFAULT_CODE_FONT_LABEL, "Alpha", "Zulu"]);
  assert.equal(panel.document.querySelector('[data-typography-setting="responseBold"]'), null);
  await panel.change("promptFont", "Alpha");
  await panel.change("promptFontSize", 24);
  await panel.change("promptBold", true);
  await panel.change("promptItalic", true);
  await panel.change("responseFontSize", 36);
  assert.equal(panel.css("promptFontSize"), "24px");
  assert.equal(panel.css("responseFontSize"), "36px");
  assert.equal(panel.css("responseFont"), "");
  assert.equal(panel.document.querySelector("#message-input").style.fontSize, "");
  assert.equal(panel.writes.length, 5);
});

test("code font changes remain independent of response text and size, with cross-panel reset", async (t) => {
  const panel = await fixture(t, { stored: { responseFont: "Alpha", responseFontSize: 18 } });
  panel.initialize();
  await panel.view.refreshFonts();
  await panel.change("responseCodeFont", "Zulu");
  assert.match(panel.css("responseCodeFont"), /^"Zulu", var\(--transcript-default-code-font-family\)$/);
  assert.match(panel.css("responseFont"), /Alpha/);
  assert.equal(panel.css("responseFontSize"), "18px");
  assert.deepEqual(panel.writes, [{ name: "responseCodeFont", value: "Zulu" }]);
  panel.notify({ responseCodeFont: "default" });
  assert.equal(panel.css("responseCodeFont"), "");
  assert.equal(panel.control("responseCodeFont").value, "default");
  assert.match(panel.css("responseFont"), /Alpha/);
});

test("code font retains missing selections and rolls back a failed save to monospace Default", async (t) => {
  const panel = await fixture(t, { stored: { responseCodeFont: "Removed Code Font" } });
  panel.initialize();
  await panel.view.refreshFonts();
  assert.equal(panel.control("responseCodeFont").value, "Removed Code Font");
  assert.equal(panel.control("responseCodeFont").selectedOptions[0].disabled, true);
  assert.equal(panel.document.querySelector("#response-code-font-note").hidden, false);
  assert.match(panel.css("responseCodeFont"), /var\(--transcript-default-code-font-family\)/);

  const other = await fixture(t, { save: async () => { throw new Error("Storage unavailable"); } });
  other.initialize();
  await other.view.refreshFonts();
  await other.change("responseCodeFont", "Alpha");
  assert.equal(other.css("responseCodeFont"), "");
  assert.equal(other.control("responseCodeFont").value, "default");
  assert.equal(other.document.querySelector("#response-typography-error").hidden, false);
});

test("font discovery deduplicates pending work, recovers from failure, and preserves unavailable selections", async (t) => {
  const discovery = deferred();
  let attempts = 0;
  const panel = await fixture(t, { stored: { promptFont: "Removed Font" }, discover() {
    if (++attempts === 1) return discovery.promise;
    return [{ fontId: "Available", displayName: "Available" }];
  } });
  panel.initialize();
  const first = panel.view.refreshFonts();
  assert.equal(first, panel.view.refreshFonts());
  assert.equal(panel.control("promptFont").disabled, true);
  assert.equal(panel.control("responseCodeFont").disabled, true);
  assert.equal(panel.control("responseFontSize").disabled, false);
  discovery.reject(new Error("Unavailable"));
  await first;
  assert.equal(attempts, 1);
  assert.equal(panel.document.querySelector("#font-list-error").hidden, false);
  assert.equal(panel.control("responseFont").disabled, false);
  assert.equal(panel.control("responseCodeFont").disabled, false);
  assert.equal(panel.control("promptFont").value, "Removed Font");
  assert.equal(panel.writes.length, 0);
  panel.document.querySelector("#retry-fonts").click();
  await settle();
  assert.equal(panel.document.querySelector("#font-list-error").hidden, true);
  assert.equal(panel.document.querySelector("#prompt-font-note").hidden, false);
  assert.equal(panel.control("promptFont").selectedOptions[0].disabled, true);
  await panel.change("promptFont", "default");
  assert.equal(panel.css("promptFont"), "");
});

test("save failures roll back only the changed field and do not discard newer cross-panel changes", async (t) => {
  const pending = deferred();
  const panel = await fixture(t, { save: () => pending.promise });
  panel.initialize();
  await panel.change("promptFontSize", 24);
  assert.equal(panel.css("promptFontSize"), "24px");
  assert.equal(panel.control("promptFontSize").disabled, true);
  assert.equal(panel.control("responseFontSize").disabled, false);
  panel.notify({ responseFontSize: 18 });
  pending.reject(new Error("Storage full"));
  await settle();
  assert.equal(panel.css("promptFontSize"), "");
  assert.equal(panel.css("responseFontSize"), "18px");
  assert.equal(panel.document.querySelector("#prompt-typography-error").hidden, false);

  const newer = deferred();
  const other = await fixture(t, { save: () => newer.promise });
  other.initialize();
  await other.change("promptFontSize", 24);
  other.notify({ promptFontSize: 32 });
  newer.reject(new Error("Stale failure"));
  await settle();
  assert.equal(other.css("promptFontSize"), "32px");
  assert.equal(other.document.querySelector("#prompt-typography-error").hidden, true);
});

test("storage notifications arriving before initial load remain authoritative", async (t) => {
  const panel = await fixture(t, { stored: { promptFontSize: 12 } });
  panel.notify({ promptFontSize: 28, responseFont: "Alpha" });
  panel.initialize();
  assert.equal(panel.css("promptFontSize"), "28px");
  assert.match(panel.css("responseFont"), /Alpha/);
  await panel.view.refreshFonts();
  assert.equal(panel.control("responseFont").value, "Alpha");
});

test("failed preference loading leaves default typography and independent controls usable", async (t) => {
  const panel = await fixture(t);
  panel.initialize(new Error("Storage unavailable"));
  assert.equal(panel.control("promptFontSize").disabled, false);
  assert.equal(panel.control("promptBold").disabled, false);
  assert.equal(panel.css("responseFontSize"), "");
  assert.equal(panel.document.querySelector("#prompt-typography-error").hidden, false);
  assert.equal(panel.document.querySelector("#response-typography-error").hidden, false);
  await panel.change("promptBold", true);
  assert.equal(panel.css("promptBold"), "700");
  assert.equal(panel.document.querySelector("#prompt-typography-error").hidden, true);
  assert.equal(panel.document.querySelector("#response-typography-error").hidden, false);
});
