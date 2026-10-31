/**
 * Minimal Markdown -> HTML renderer for SPEC.md and USER_GUIDE.md.
 *
 * Deliberately small (no dependency) and covers the GFM subset used in this
 * project's docs: ATX headings, pipe tables, fenced code blocks, bullet and
 * numbered lists, horizontal rules, single-level blockquotes, paragraphs, and
 * inline code / bold / italic / links.
 * All text is HTML-escaped; raw HTML in the source is NOT passed through.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render inline markup: `code`, **bold**, *italic*, [text](url). */
export function renderInline(text: string): string {
  // Code spans are rendered first and protected from further processing.
  const codeSpans: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_match, label: string, href: string) =>
    /^(https?:\/\/|\/|#|mailto:)/.test(href) ? `<a href="${href}">${label}</a>` : `${label}`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");

  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "");
}

const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
/** `---`, `***`, `___` (3+ of one character, optional spaces between). */
const HORIZONTAL_RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(lines: string[]): string {
  const [header, , ...body] = lines;
  const headCells = splitRow(header ?? "")
    .map((cell) => `<th>${renderInline(cell)}</th>`)
    .join("");
  const rows = body
    .map(
      (line) =>
        `<tr>${splitRow(line)
          .map((cell) => `<td>${renderInline(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("\n");
  return `<table>\n<thead><tr>${headCells}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
}

/** Render a Markdown document to an HTML fragment (no <html>/<body> wrapper). */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      html.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      i += 1;
      continue;
    }

    if (HORIZONTAL_RULE.test(line)) {
      html.push("<hr>");
      i += 1;
      continue;
    }

    // Blockquote (one level): consecutive `> ...` lines form one paragraph.
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(/^\s*>\s?/, "").trim());
        i += 1;
      }
      html.push(`<blockquote><p>${renderInline(quoted.filter(Boolean).join(" "))}</p></blockquote>`);
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // closing fence
      const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      html.push(`<pre><code${lang}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.trim().startsWith("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
      const table: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        table.push(lines[i]!);
        i += 1;
      }
      html.push(renderTable(table));
      continue;
    }

    const listItem = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (listItem) {
      const ordered = /\d/.test(listItem[1]!);
      const tag = ordered ? "ol" : "ul";
      const items: string[] = [];
      while (i < lines.length) {
        const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i] ?? "");
        if (!item || /\d/.test(item[1]!) !== ordered) break;
        items.push(`<li>${renderInline(item[2]!)}</li>`);
        i += 1;
      }
      html.push(`<${tag}>\n${items.join("\n")}\n</${tag}>`);
      continue;
    }

    // Paragraph: consecutive non-blank lines that do not start another block.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (
        current.trim() === "" ||
        /^#{1,6}\s/.test(current) ||
        /^```/.test(current) ||
        HORIZONTAL_RULE.test(current) ||
        /^\s*>/.test(current) ||
        (current.trim().startsWith("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) ||
        /^\s*([-*]|\d+\.)\s+/.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      i += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return html.join("\n");
}
