const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function appendText(nodes, value) {
  if (!value) return;
  const previous = nodes.at(-1);
  if (previous?.type === "text") previous.value += value;
  else nodes.push({ type: "text", value });
}

export function parseInline(markdown) {
  const source = String(markdown || "");
  const nodes = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length && /[\\`*_[\]~<>]/.test(source[index + 1])) {
      appendText(nodes, source[index + 1]);
      index += 2;
      continue;
    }

    const pairedMarker = ["**", "__", "~~"].find((marker) => source.startsWith(marker, index));
    if (pairedMarker) {
      const closing = source.indexOf(pairedMarker, index + pairedMarker.length);
      if (closing > index + pairedMarker.length) {
        nodes.push({
          type: pairedMarker === "~~" ? "delete" : "strong",
          children: parseInline(source.slice(index + pairedMarker.length, closing)),
        });
        index = closing + pairedMarker.length;
        continue;
      }
    }

    if (character === "`") {
      let markerLength = 1;
      while (source[index + markerLength] === "`") markerLength += 1;
      const marker = "`".repeat(markerLength);
      const closing = source.indexOf(marker, index + markerLength);
      if (closing >= index + markerLength) {
        nodes.push({
          type: "code",
          value: source.slice(index + markerLength, closing).replace(/\s*\n\s*/g, " "),
        });
        index = closing + markerLength;
        continue;
      }
    }

    if (character === "[") {
      const labelEnd = source.indexOf("](", index + 1);
      const linkEnd = labelEnd >= 0 ? source.indexOf(")", labelEnd + 2) : -1;
      if (labelEnd > index + 1 && linkEnd > labelEnd + 2) {
        nodes.push({
          type: "link",
          href: source.slice(labelEnd + 2, linkEnd).trim(),
          children: parseInline(source.slice(index + 1, labelEnd)),
        });
        index = linkEnd + 1;
        continue;
      }
    }

    if (character === "<") {
      const closing = source.indexOf(">", index + 1);
      const value = closing > index ? source.slice(index + 1, closing) : "";
      if (/^https?:\/\/\S+$/i.test(value)) {
        nodes.push({ type: "link", href: value, children: [{ type: "text", value }] });
        index = closing + 1;
        continue;
      }
    }

    if (character === "*" || character === "_") {
      const insideWord = character === "_" && /[\p{L}\p{N}]/u.test(source[index - 1] || "") &&
        /[\p{L}\p{N}]/u.test(source[index + 1] || "");
      const closing = insideWord ? -1 : source.indexOf(character, index + 1);
      if (closing > index + 1) {
        nodes.push({
          type: "emphasis",
          children: parseInline(source.slice(index + 1, closing)),
        });
        index = closing + 1;
        continue;
      }
    }

    if (character === "\n") {
      nodes.push({ type: "lineBreak" });
      index += 1;
      continue;
    }

    appendText(nodes, character);
    index += 1;
  }

  return nodes;
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isBlockStart(line) {
  return /^ {0,3}(?:#{1,6}\s+|>|[-+*]\s+|\d+[.)]\s+|`{3,}|~{3,})/.test(line) ||
    /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

export function parseMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s]*)\s*$/);
    if (fence) {
      const code = [];
      const fenceCharacter = fence[1][0];
      const fenceLength = fence[1].length;
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${fenceCharacter}{${fenceLength},}\\s*$`).test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "codeBlock", language: fence[2], value: code.join("\n") });
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      index += 1;
      continue;
    }

    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "thematicBreak" });
      index += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^ {0,3}> ?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", children: parseMarkdown(quoted.join("\n")) });
      continue;
    }

    const listItem = line.match(/^ {0,3}([-+*]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      const ordered = /^\d/.test(listItem[1]);
      const start = ordered ? Number.parseInt(listItem[1], 10) : 1;
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^ {0,3}([-+*]|\d+[.)])\s+(.+)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const itemLines = [item[2]];
        index += 1;
        while (index < lines.length && lines[index].trim() &&
               !/^ {0,3}([-+*]|\d+[.)])\s+/.test(lines[index]) &&
               !isBlockStart(lines[index])) {
          itemLines.push(lines[index].trim());
          index += 1;
        }
        items.push(parseInline(itemLines.join("\n")));
        if (!lines[index]?.trim()) break;
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line).map(parseInline);
      const alignments = splitTableRow(lines[index + 1]).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left");
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]).map(parseInline));
        index += 1;
      }
      blocks.push({ type: "table", headers, alignments, rows });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index]) &&
           !(lines[index].includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]))) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

function safeLink(href) {
  try {
    const url = new URL(href);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function appendInline(parent, nodes, documentObject) {
  for (const node of nodes) {
    if (node.type === "text") {
      parent.append(documentObject.createTextNode(node.value));
      continue;
    }
    if (node.type === "lineBreak") {
      parent.append(documentObject.createElement("br"));
      continue;
    }
    if (node.type === "code") {
      const code = documentObject.createElement("code");
      code.textContent = node.value;
      parent.append(code);
      continue;
    }

    const tagName = node.type === "strong" ? "strong"
      : node.type === "emphasis" ? "em"
        : node.type === "delete" ? "del"
          : node.type === "link" ? "a" : null;
    if (!tagName) continue;
    const element = documentObject.createElement(tagName);
    if (node.type === "link") {
      const href = safeLink(node.href);
      if (!href) {
        appendInline(parent, node.children, documentObject);
        continue;
      }
      element.href = href;
      element.target = "_blank";
      element.rel = "noreferrer";
    }
    appendInline(element, node.children, documentObject);
    parent.append(element);
  }
}

function appendBlocks(parent, blocks, documentObject) {
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") {
      const element = documentObject.createElement(block.type === "heading" ? `h${block.level}` : "p");
      appendInline(element, block.children, documentObject);
      parent.append(element);
      continue;
    }
    if (block.type === "thematicBreak") {
      parent.append(documentObject.createElement("hr"));
      continue;
    }
    if (block.type === "codeBlock") {
      const pre = documentObject.createElement("pre");
      const code = documentObject.createElement("code");
      if (/^[a-z0-9_+-]+$/i.test(block.language)) code.className = `language-${block.language}`;
      code.textContent = block.value;
      pre.append(code);
      parent.append(pre);
      continue;
    }
    if (block.type === "blockquote") {
      const quote = documentObject.createElement("blockquote");
      appendBlocks(quote, block.children, documentObject);
      parent.append(quote);
      continue;
    }
    if (block.type === "list") {
      const list = documentObject.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && block.start !== 1) list.start = block.start;
      for (const item of block.items) {
        const listItem = documentObject.createElement("li");
        appendInline(listItem, item, documentObject);
        list.append(listItem);
      }
      parent.append(list);
      continue;
    }
    if (block.type === "table") {
      const table = documentObject.createElement("table");
      const head = documentObject.createElement("thead");
      const headRow = documentObject.createElement("tr");
      block.headers.forEach((header, cellIndex) => {
        const cell = documentObject.createElement("th");
        cell.style.textAlign = block.alignments[cellIndex] || "left";
        appendInline(cell, header, documentObject);
        headRow.append(cell);
      });
      head.append(headRow);
      table.append(head);
      const body = documentObject.createElement("tbody");
      for (const row of block.rows) {
        const tableRow = documentObject.createElement("tr");
        row.forEach((value, cellIndex) => {
          const cell = documentObject.createElement("td");
          cell.style.textAlign = block.alignments[cellIndex] || "left";
          appendInline(cell, value, documentObject);
          tableRow.append(cell);
        });
        body.append(tableRow);
      }
      table.append(body);
      parent.append(table);
    }
  }
}

export function renderMarkdown(container, markdown) {
  const documentObject = container.ownerDocument;
  container.replaceChildren();
  appendBlocks(container, parseMarkdown(markdown), documentObject);
}
