import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { renderInline, renderMarkdown } from "../src/markdown.ts";

describe("renderInline", () => {
  test("code spans, bold, italic, links", () => {
    assert.equal(renderInline("a `b` c"), "a <code>b</code> c");
    assert.equal(renderInline("**bold** and *em*"), "<strong>bold</strong> and <em>em</em>");
    assert.equal(renderInline("[site](https://example.com)"), '<a href="https://example.com">site</a>');
    assert.equal(renderInline("[local](/spec)"), '<a href="/spec">local</a>');
  });

  test("escapes HTML, including inside code spans", () => {
    assert.equal(renderInline("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
    assert.equal(renderInline("`<b>`"), "<code>&lt;b&gt;</code>");
  });

  test("markup inside code spans is left literal", () => {
    assert.equal(renderInline("`**not bold**`"), "<code>**not bold**</code>");
  });

  test("javascript: links are not turned into anchors", () => {
    assert.equal(renderInline("[x](javascript:alert(1))"), "x");
  });
});

describe("renderMarkdown", () => {
  test("horizontal rules: ---, ***, ___, spaced; not a list or a dash in prose", () => {
    assert.equal(renderMarkdown("a\n\n---\n\nb"), "<p>a</p>\n<hr>\n<p>b</p>");
    assert.equal(renderMarkdown("***"), "<hr>");
    assert.equal(renderMarkdown("_ _ _"), "<hr>");
    assert.equal(renderMarkdown("a\n---\nb"), "<p>a</p>\n<hr>\n<p>b</p>", "a rule ends a paragraph");
    assert.equal(renderMarkdown("--"), "<p>--</p>");
    assert.equal(renderMarkdown("a - b - c"), "<p>a - b - c</p>");
    assert.equal(renderMarkdown("- item"), "<ul>\n<li>item</li>\n</ul>");
  });

  test("blockquotes: one level, consecutive lines joined, inline markup, escaped", () => {
    assert.equal(renderMarkdown("> **Tip:** one\n> two"), "<blockquote><p><strong>Tip:</strong> one two</p></blockquote>");
    assert.equal(renderMarkdown(">no space"), "<blockquote><p>no space</p></blockquote>");
    assert.equal(renderMarkdown("para\n> quote\n\nafter"), "<p>para</p>\n<blockquote><p>quote</p></blockquote>\n<p>after</p>");
    assert.equal(renderMarkdown("> <b>x</b>"), "<blockquote><p>&lt;b&gt;x&lt;/b&gt;</p></blockquote>");
  });

  test("headings", () => {
    assert.equal(renderMarkdown("# Title\n\n## Sub"), "<h1>Title</h1>\n<h2>Sub</h2>");
  });

  test("pipe table with header, separator and body", () => {
    const html = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | `x` |\n| 2 | y |");
    assert.match(html, /^<table>/);
    assert.match(html, /<thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead>/);
    assert.match(html, /<tr><td>1<\/td><td><code>x<\/code><\/td><\/tr>/);
    assert.match(html, /<tr><td>2<\/td><td>y<\/td><\/tr>/);
    assert.equal((html.match(/<tr>/g) ?? []).length, 3);
  });

  test("aligned (padded) tables are parsed identically", () => {
    const compact = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const padded = renderMarkdown("| A   | B   |\n| --- | --- |\n| 1   | 2   |");
    assert.equal(padded, compact);
  });

  test("a line starting with | but no separator is a paragraph, not a table", () => {
    assert.equal(renderMarkdown("| just text"), "<p>| just text</p>");
  });

  test("fenced code block is escaped verbatim", () => {
    const html = renderMarkdown("```js\nconst a = '<b>';\n```");
    assert.equal(html, '<pre><code class="language-js">const a = &#39;&lt;b&gt;&#39;;</code></pre>'.replace(/&#39;/g, "'"));
  });

  test("bullet and numbered lists", () => {
    assert.equal(renderMarkdown("- a\n- b"), "<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
    assert.equal(renderMarkdown("1. a\n2. b"), "<ol>\n<li>a</li>\n<li>b</li>\n</ol>");
  });

  test("paragraphs join soft-wrapped lines and split on blank lines", () => {
    assert.equal(renderMarkdown("one\ntwo\n\nthree"), "<p>one two</p>\n<p>three</p>");
  });

  for (const file of ["SPEC.md", "USER_GUIDE.md", "TESTING.md"]) {
    test(`renders every table in the real ${file}`, async () => {
      const doc = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      const expectedTables = doc.split("\n").filter((line) => /^\|\s*-{3,}/.test(line)).length;
      const html = renderMarkdown(doc);
      assert.ok(expectedTables > 0, `${file} should contain tables`);
      assert.equal((html.match(/<table>/g) ?? []).length, expectedTables);
      assert.doesNotMatch(html, /(^|\n)<p>\|/, "no table row leaked into a paragraph");
      assert.doesNotMatch(html, /<p>(---|&gt;)/, "no rule / quote marker leaked into a paragraph");
    });
  }
});
