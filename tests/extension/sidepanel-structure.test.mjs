import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const htmlUrl = new URL("../../extension/sidepanel/index.html", import.meta.url);
const scriptUrl = new URL("../../extension/sidepanel/index.js", import.meta.url);
const stylesUrl = new URL("../../extension/sidepanel/styles.css", import.meta.url);
const backgroundUrl = new URL("../../extension/background/service-worker.js", import.meta.url);
const repositoryUrl = new URL("../../", htmlUrl);

async function assertImportsExist(moduleUrl) {
  const source = await readFile(moduleUrl, "utf8");
  const paths = [...source.matchAll(/^import .* from "([^"]+)";/gm)]
    .map((match) => match[1]);

  assert.ok(paths.length > 0, `Expected imports in ${moduleUrl.pathname}.`);
  await Promise.all(paths.map((path) => access(new URL(path, moduleUrl))));
}

function relativeLuminance(hex) {
  const channels = [0, 2, 4]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("side panel IDs are unique and every JavaScript lookup resolves", async () => {
  const [html, script] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(scriptUrl, "utf8"),
  ]);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const lookups = [...script.matchAll(/document\.querySelector\("#([^"]+)"\)/g)]
    .map((match) => match[1]);

  assert.equal(new Set(ids).size, ids.length, "Duplicate HTML IDs found.");
  for (const id of lookups) {
    assert.ok(ids.includes(id), `Missing #${id} referenced by the side-panel controller.`);
  }
});

test("side panel keeps scripts external and loads its controller as a module", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);

  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /\bsrc="index\.js"/);
  assert.match(scripts[0], /\btype="module"/);
});

test("all local side-panel assets exist", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const paths = [
    ...html.matchAll(/<(?:img|link|script)\b[^>]*(?:src|href)="([^"]+)"/g),
  ]
    .map((match) => match[1])
    .filter((path) => !path.startsWith("http"));

  await Promise.all(paths.map((path) => {
    const assetUrl = path.startsWith("/")
      ? new URL(path.slice(1), repositoryUrl)
      : new URL(path, htmlUrl);
    return access(assetUrl);
  }));
});

test("extension entrypoint imports resolve", async () => {
  await Promise.all([
    assertImportsExist(scriptUrl),
    assertImportsExist(backgroundUrl),
  ]);
});

test("new-tab links prevent opener access", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const links = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map((match) => match[0]);

  assert.ok(links.length > 0);
  for (const link of links) assert.match(link, /\brel="[^"]*noreferrer[^"]*"/);
});

test("composer exposes accessible history and clear controls", async () => {
  const html = await readFile(htmlUrl, "utf8");
  assert.match(html, /id="message-input"[^>]*aria-keyshortcuts="[^"]*Control\+P[^"]*"/s);
  assert.match(html, /id="clear-message"[^>]*aria-label="Clear message"/s);
});

test("chat exposes Ask and Act modes plus an accessible action confirmation", async () => {
  const [html, styles, script] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
    readFile(scriptUrl, "utf8"),
  ]);
  assert.match(html, /<fieldset class="mode-switch" id="mode-switch" aria-label="Page capability" disabled>/);
  assert.match(html, /name="page-mode" value="ask" checked/);
  assert.match(html, /name="page-mode" value="act"/);
  assert.match(styles, /\.mode-switch::before[\s\S]*transition: transform 180ms ease/);
  assert.match(styles, /\.mode-switch:has\(input\[value="act"\]:checked\)::before[\s\S]*translateX\(100%\)/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*\.mode-switch::before/);
  assert.match(html, /id="action-confirmation" hidden/);
  assert.match(html, /class="action-dialog" role="dialog" aria-modal="true"/);
  assert.match(html, /id="confirm-action"/);
  assert.match(html, /id="cancel-action"/);
  assert.match(script, /actionLabel\(action\)/);
});

test("New chat requires an accessible, cancel-first confirmation", async () => {
  const [html, script] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(scriptUrl, "utf8"),
  ]);
  const dialog = html.slice(
    html.indexOf('id="new-chat-confirmation"'),
    html.indexOf("</section>", html.indexOf('id="new-chat-confirmation"')),
  );

  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /Start a new chat\?/);
  assert.match(dialog, /This will clear the current conversation\. This cannot be undone\./);
  assert.ok(dialog.indexOf('id="cancel-new-chat"') < dialog.indexOf('id="confirm-new-chat"'));
  assert.match(script, /clearButton\.addEventListener\("click", showNewChatConfirmation\)/);
  assert.match(script, /requestAnimationFrame\(\(\) => cancelNewChatButton\.focus/);
  assert.match(script, /newChatModalOpen[\s\S]*event\.key === "Escape"/);
  assert.match(script, /newChatModalOpen[\s\S]*event\.key === "Tab"/);
});

test("initial chat uses one inline connection and recovery surface", async () => {
  const html = await readFile(htmlUrl, "utf8");

  assert.doesNotMatch(html, /id="auth-loading"|class="[^"]*spinner|id="plan-welcome"/);
  assert.match(html, /id="connection-status"[^>]*role="status"[^>]*aria-live="polite"/s);
  assert.equal((html.match(/id="connection-notice"/g) || []).length, 1);
  assert.match(html, /id="sign-in"/);
  assert.match(html, /id="retry-operation"/);
  assert.match(html, /id="cancel-sign-in"/);
  assert.match(html, /class="chat-content" id="chat-content">/);
});

test("the shared top bar exposes only page-appropriate actions", async () => {
  const [html, styles] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf("</header>"));
  const settings = html.slice(
    html.indexOf('class="settings-view"'),
    html.indexOf('class="settings-content"'),
  );

  assert.match(topbar, /<h1>BrowseFriend<\/h1>/);
  assert.match(topbar, /Page companion/);
  assert.match(topbar, /id="connection-status"/);
  assert.match(topbar, /class="icon-button topbar__chat-action" id="clear-chat"/);
  assert.match(topbar, /class="icon-button topbar__chat-action"[^>]*id="open-settings"/s);
  assert.match(topbar, /class="icon-button topbar__settings-action"[^>]*id="close-settings"/s);
  assert.ok(topbar.indexOf('id="close-settings"') < topbar.indexOf('id="close-panel"'));
  assert.doesNotMatch(settings, /id="close-settings"/);
  assert.match(settings, /<h2 id="settings-title">Settings<\/h2>/);
  assert.doesNotMatch(styles, /\.app:has\(\.view-stack--settings\) \.brand/);
  assert.match(styles, /\.app:has\(\.view-stack--settings\) \.topbar__chat-action/);
  assert.match(styles, /\.app:has\(\.view-stack--settings\) \.icon-button\.topbar__settings-action/);
});

test("composer keeps its trailing action anchored with symmetric padding", async () => {
  const styles = await readFile(stylesUrl, "utf8");
  assert.match(
    styles,
    /\.composer\s*\{[^}]*display:\s*flex;[^}]*margin:\s*10px 12px 0;[^}]*padding:\s*8px 14px;/s,
  );
  assert.match(styles, /\.composer-clear,\s*\.send-button\s*\{[^}]*flex:\s*0 0 34px;/s);
});

test("composer footer shows the effective model and an accessible context warning", async () => {
  const [html, styles, script] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
    readFile(scriptUrl, "utf8"),
  ]);

  assert.match(html, /class="model-summary"[\s\S]*id="model-summary"[\s\S]*hidden/);
  assert.match(html, /id="effective-model"/);
  assert.match(html, /id="effective-reasoning-effort"/);
  assert.match(html, /class="context-warning"[\s\S]*tabindex="0"[\s\S]*aria-describedby="context-warning-tooltip"/);
  assert.match(html, /id="context-warning-tooltip" role="tooltip"/);
  assert.match(styles, /\.model-summary__model\s*\{[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(styles, /\.model-summary__effort\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.context-warning:focus \.context-warning__tooltip/);
  assert.match(script, /automaticOption\.textContent = automaticModelLabel\(models\)/);
  assert.match(script, /modelSummaryButton\.addEventListener\("click", \(\) => showSettings\(\{ focusModel: true \}\)\)/);
});

test("Debug mode is an accessible switch in the final Settings section", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const finalSettingsSection = html.lastIndexOf('class="settings-section');
  const debugSection = html.indexOf('id="debug-settings"');

  assert.ok(finalSettingsSection >= 0);
  assert.ok(debugSection > finalSettingsSection);
  assert.ok(debugSection - finalSettingsSection < 200);
  assert.match(html, /id="debug-mode"[^>]*type="checkbox"[^>]*role="switch"/s);
  assert.match(html, /<label for="debug-mode">Debug mode<\/label>/);
});

test("Appearance offers System, Light, and Dark before the final Debug section", async () => {
  const [html, styles] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);
  const appearance = html.indexOf('id="appearance-settings"');
  const model = html.indexOf('id="model-settings"');
  const debug = html.indexOf('id="debug-settings"');

  assert.ok(appearance >= 0 && appearance < model && model < debug);
  assert.match(html, /<label for="theme-select">Theme<\/label>/);
  assert.match(html, /<option value="system">System<\/option>/);
  assert.match(html, /<option value="light">Light<\/option>/);
  assert.match(html, /<option value="dark">Dark<\/option>/);
  assert.match(styles, /:root\[data-theme="dark"\][^{]*\{[^}]*color-scheme:\s*dark;/s);
  assert.match(styles, /:root:not\(\[data-theme="light"\]\)/);
});

test("Appearance offers seven accent swatches with Blue selected by default", async () => {
  const [html, styles] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);
  const accentValues = [...html.matchAll(
    /<input type="radio" name="accent-color" value="([^"]+)"(?: checked)? \/>/g,
  )].map((match) => match[1]);

  assert.deepEqual(accentValues, [
    "red",
    "orange",
    "yellow",
    "green",
    "cyan",
    "blue",
    "purple",
  ]);
  assert.match(html, /<html lang="en" data-accent="blue">/);
  assert.match(html, /name="accent-color" value="blue" checked/);
  for (const accent of accentValues) {
    assert.match(styles, new RegExp(`:root\\[data-accent="${accent}"\\]`));
  }
});

test("accent fills retain readable foreground contrast in both themes", async () => {
  const styles = await readFile(stylesUrl, "utf8");
  const palettes = [...styles.matchAll(
    /:root\[data-accent="([^"]+)"\]\s*\{[^}]*--accent:\s*light-dark\(#([0-9a-f]{6}), #([0-9a-f]{6})\)/g,
  )];

  assert.equal(palettes.length, 7);
  for (const [, name, light, dark] of palettes) {
    assert.ok(contrastRatio(light, "ffffff") >= 4.5, `${name} lacks light-theme contrast.`);
    assert.ok(contrastRatio(dark, "171817") >= 4.5, `${name} lacks dark-theme contrast.`);
  }
});

test("transcript messages have hidden authors instead of visible avatars", async () => {
  const html = await readFile(htmlUrl, "utf8");

  assert.doesNotMatch(html, /message__avatar/);
  assert.match(html, /class="message__author sr-only"/);
});

test("Model settings expose model and reasoning preferences while keeping Debug last", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const styles = await readFile(stylesUrl, "utf8");
  const model = html.indexOf('id="model-settings"');
  const debug = html.indexOf('id="debug-settings"');

  assert.ok(model >= 0 && model < debug);
  assert.match(html, /<label for="model-select">Model<\/label>/);
  assert.match(html, /<option value="automatic">Automatic<\/option>/);
  assert.match(html, /<label for="reasoning-select">Reasoning effort<\/label>/);
  assert.match(html, /<option value="model_default">Model default<\/option>/);
  assert.doesNotMatch(html, /<select id="reasoning-select"[^>]*>[\s\S]*value="automatic"/);
  assert.match(styles, /appearance:\s*none/);
  assert.match(styles, /calc\(100% - 15px\)/);
  assert.match(styles, /padding:\s*8px 34px 8px 10px/);
});
