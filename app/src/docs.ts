/** The two Markdown documents served as pages (SPEC.md, USER_GUIDE.md) and their HTML wrapper. */
import { escapeHtml, renderMarkdown } from "./markdown.ts";

const specPath = new URL("../SPEC.md", import.meta.url);

const guidePath = new URL("../USER_GUIDE.md", import.meta.url);

/** The two Markdown documents served as pages: the technical spec and the non-technical user guide. */
export const DOCS = {
  spec: { page: "/spec", raw: "/SPEC.md", path: specPath, other: { page: "/guide", label: "User guide" } },
  guide: { page: "/guide", raw: "/USER_GUIDE.md", path: guidePath, other: { page: "/spec", label: "Spec" } },
} as const;

type Doc = (typeof DOCS)[keyof typeof DOCS];

/** Wrap a rendered Markdown document (SPEC.md, USER_GUIDE.md) in a small self-contained HTML page. */
export function renderDocPage(markdown: string, doc: Doc = DOCS.spec): string {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? "Spec";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; padding: 32px 20px; background: #f6f5f1; color: #1f2933; font: 15px/1.5 system-ui, sans-serif; }
      main { max-width: 1100px; margin: 0 auto; }
      nav { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 16px; font-size: 14px; }
      nav span { display: flex; gap: 16px; }
      nav a { color: #1f2933; }
      h1 { font-size: 28px; margin: 0 0 16px; }
      h2 { font-size: 20px; margin: 32px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #d6d3cc; }
      table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; background: #fff; }
      th, td { border: 1px solid #d6d3cc; padding: 6px 10px; text-align: left; vertical-align: top; }
      th { background: #ece9e1; }
      tr:nth-child(even) td { background: #faf9f6; }
      code { background: #ece9e1; padding: 1px 5px; border-radius: 4px; font-size: 90%; }
      pre { background: #ece9e1; padding: 12px; border-radius: 8px; overflow: auto; }
      pre code { background: none; padding: 0; }
      hr { border: 0; border-top: 1px solid #d6d3cc; margin: 24px 0; }
      blockquote { margin: 12px 0; padding: 8px 14px; border-left: 4px solid #0f766e; background: #fff; border-radius: 0 8px 8px 0; }
      blockquote p { margin: 0; }
    </style>
  </head>
  <body>
    <main>
      <nav><a href="/">&larr; Back to viewer</a><span><a href="${doc.other.page}">${escapeHtml(doc.other.label)}</a><a href="${doc.raw}">Raw Markdown</a></span></nav>
${renderMarkdown(markdown)}
    </main>
  </body>
</html>
`;
}

/** @deprecated Use renderDocPage(markdown, DOCS.spec). Kept for callers of the original name. */
export const renderSpecPage = (markdown: string): string => renderDocPage(markdown, DOCS.spec);
