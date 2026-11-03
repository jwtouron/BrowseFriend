import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";

export const SCENARIOS = ["blocked", "alternative", "changed"];
export const FILES = ["cmd/client/main.go", "cmd/server/main.go"];
const event = () => {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), emit: (...args) => listeners.map((fn) => fn(...args)) };
};
export { event };

export async function createSite(scenario) {
  if (!SCENARIOS.includes(scenario)) throw new Error("Unknown fixture scenario");
  const scripts = new Map(await Promise.all(["read", "act"].map(async (kind) => [
    `extension/page/${kind}/content-script.js`,
    await readFile(new URL(`../../extension/page/${kind}/content-script.js`, import.meta.url), "utf8"),
  ])));
  const runtime = { id: "evaluation", onMessage: event(), async sendMessage(message) {
    runtime.onMessage.emit(message, { id: runtime.id });
  } };
  const updated = event();
  const trace = [];
  let dom, pageListeners, url, revisionReady = false, pendingNavigation = null;
  const state = { ready: false, visited: [], transitions: [] };
  function html(path) {
    const source = FILES.find((file) => path === `/repo/blob/master/${file}`);
    if (source && scenario !== "blocked") return `<h1>${source}</h1><pre>package main\nfunc main() { println("synthetic fixture") }</pre><a href="/repo/tree/master">Files</a>`;
    if (path === "/repo") return `<h1>Maple repository</h1><p>Default branch: master</p><a href="/repo/search?q=main">Search code for main functions</a><a href="/repo/tree/master">Browse files</a>`;
    if (path === "/repo/tree/master" && scenario === "alternative" || state.ready && ["/repo/tree/master", "/repo/search"].includes(path)) {
      return `<h1>Repository files</h1>${FILES.map((file) => `<a href="/repo/blob/master/${file}">${file}</a>`).join(" ")}<p>README contains the word main, but is not source code.</p>`;
    }
    if (["/repo/search", "/repo/tree/master"].includes(path)) return `<h1>Repository indexing</h1><p id="status">${scenario === "changed" ? "Indexing has started and will finish shortly. This page updates automatically." : scenario === "alternative" ? "Code search is unavailable while indexing is incomplete. File browsing remains available through Browse files." : "Repository indexing is incomplete. Code search and file browsing are unavailable. No results can be retrieved yet."}</p><a href="/repo">Repository home</a><a href="/repo/search?q=main">Search</a><a href="/repo/tree/master">Browse files</a>`;
    return "<h1>Unavailable destination</h1><p>This destination does not exist in the repository.</p><a href='/repo'>Repository home</a>";
  }
  async function navigate(destination) {
    dom?.window.close();
    url = new URL(destination, url || "https://fixture.test/repo").href;
    const parsed = new URL(url);
    state.visited.push(parsed.origin === "https://fixture.test" ? parsed.pathname : url);
    trace.push({ kind: "navigation", url });
    pageListeners = event();
    dom = new JSDOM(parsed.origin === "https://fixture.test" ? html(parsed.pathname) : "<h1>Unavailable destination</h1><p>Outside this simulated website.</p>", { url, runScripts: "outside-only", pretendToBeVisual: true });
    const window = dom.window;
    window.chrome = { runtime: { onMessage: pageListeners, async sendMessage(message) { runtime.onMessage.emit(message, { id: runtime.id, frameId: 0, tab: { id: 1 } }); } } };
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 });
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.scrollBy = window.scrollTo = () => window.dispatchEvent(new window.Event("scroll"));
    window.document.addEventListener("click", (e) => {
      const link = e.target.closest("a[href]");
      if (link) { e.preventDefault(); pendingNavigation = link.href; }
    });
    window.document.addEventListener("submit", (e) => {
      e.preventDefault(); const form = e.target;
      const destination = new URL(form.action || url);
      new window.FormData(form).forEach((value, key) => destination.searchParams.set(key, String(value)));
      pendingNavigation = destination.href;
    });
    updated.emit(1, { status: "loading", url });
    revisionReady = false;
  }
  const tabs = {
    onUpdated: updated, onActivated: event(),
    async query() { return [{ id: 1, url }]; },
    async update(_id, { url: destination }) { await navigate(destination); return { id: 1, url }; },
    async sendMessage(_id, message) {
      if (!revisionReady && message.channel === "page") throw new Error("Not installed");
      const reply = await new Promise((resolve, reject) => {
        const results = pageListeners.emit(message, {}, resolve);
        if (!results.includes(true)) reject(new Error("No content-script receiver"));
      });
      if (pendingNavigation) { const target = pendingNavigation; pendingNavigation = null; await navigate(target); }
      return reply;
    },
  };
  const scripting = {
    async executeScript({ files }) { for (const file of files) {
      if (!scripts.has(file)) throw new Error("Unexpected script");
      vm.runInContext(scripts.get(file), dom.getInternalVMContext());
      if (file.includes("/read/")) revisionReady = true;
    } },
    async insertCSS() {},
  };
  function advance() {
    if (scenario !== "changed" || state.ready || new URL(url).pathname !== "/repo/search") return;
    state.ready = true;
    const main = dom.window.document.body;
    main.innerHTML = html("/repo/search");
    state.transitions.push("indexing completed");
    trace.push({ kind: "mutation", url, state: "indexing completed" });
  }
  await navigate("https://fixture.test/repo");
  return { runtime, tabs, scripting, state, trace, advance, close: () => dom.window.close() };
}
