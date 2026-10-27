import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const htmlUrl = new URL("../sidepanel.html", import.meta.url);
const scriptUrl = new URL("../sidepanel.js", import.meta.url);

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
    assert.ok(ids.includes(id), `Missing #${id} referenced by sidepanel.js.`);
  }
});

test("side panel keeps scripts external and loads its controller as a module", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);

  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /\bsrc="sidepanel\.js"/);
  assert.match(scripts[0], /\btype="module"/);
});

test("all local side-panel assets exist", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const paths = [
    ...html.matchAll(/<(?:img|link|script)\b[^>]*(?:src|href)="([^"]+)"/g),
  ]
    .map((match) => match[1])
    .filter((path) => !path.startsWith("http"));

  await Promise.all(paths.map((path) => access(new URL(`../${path}`, import.meta.url))));
});

test("new-tab links prevent opener access", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const links = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map((match) => match[0]);

  assert.ok(links.length > 0);
  for (const link of links) assert.match(link, /\brel="[^"]*noreferrer[^"]*"/);
});
