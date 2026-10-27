import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdown, renderMarkdown } from "../../extension/chat/markdown.js";

class FakeNode {
  constructor(tagName = null, text = "") {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.value = text;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  set textContent(value) {
    this.value = value;
    this.children = [];
  }

  get textContent() {
    return this.value + this.children.map((child) => child.textContent).join("");
  }
}

function fakeDocument() {
  return {
    createElement: (tagName) => new FakeNode(tagName),
    createTextNode: (text) => new FakeNode(null, text),
  };
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

test("Markdown parser recognizes common model response structures", () => {
  const blocks = parseMarkdown(`## Summary

This is **important** and \`literal\`.

- First
- Second

| Name | Value |
| --- | ---: |
| One | 1 |

\`\`\`js
const safe = true;
\`\`\``);

  assert.deepEqual(blocks.map((block) => block.type), [
    "heading",
    "paragraph",
    "list",
    "table",
    "codeBlock",
  ]);
  assert.equal(blocks[1].children.some((node) => node.type === "strong"), true);
  assert.equal(blocks[1].children.some((node) => node.type === "code"), true);
  assert.equal(blocks[2].items.length, 2);
});

test("Markdown renderer creates safe DOM links without parsing raw HTML", () => {
  const documentObject = fakeDocument();
  const container = new FakeNode("div");
  container.ownerDocument = documentObject;

  renderMarkdown(
    container,
    "[Unsafe](javascript:alert(1)) [Safe](https://example.com/) <img src=x onerror=alert(1)>",
  );

  const nodes = descendants(container);
  const links = nodes.filter((node) => node.tagName === "a");
  assert.equal(links.length, 1);
  assert.equal(links[0].href, "https://example.com/");
  assert.equal(links[0].target, "_blank");
  assert.equal(links[0].rel, "noreferrer");
  assert.match(container.textContent, /Unsafe/);
  assert.match(container.textContent, /<img src=x onerror=alert\(1\)>/);
});
