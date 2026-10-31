import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

// Isolate the custom-watermark file from the real project (other suites run in parallel).
const dir = mkdtempSync(join(tmpdir(), "wm-ui-"));
const customPath = join(dir, "watermark.custom.svg");
process.env.SHARP_VIEWER_CUSTOM_WATERMARK = customPath;
const app = await import("../src/app.ts");

let baseUrl: string;
let server: Server;

before(async () => {
  server = app.createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

async function post(fields: Record<string, string>) {
  const body = new URLSearchParams(fields).toString();
  const response = await fetch(`${baseUrl}/watermark`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  return { status: response.status, location: response.headers.get("location"), html: await response.text() };
}

async function page(query = "") {
  const html = await (await fetch(`${baseUrl}/${query}`)).text();
  return {
    html,
    status:
      /<p class="context wm-status">([^<]*)<\/p>/
        .exec(html)?.[1]
        ?.replace(/&quot;/g, '"')
        .replace(/&middot;/g, "·")
        .replace(/&times;/g, "×") ?? "",
    textField:
      /name="text"[^>]*value="([^"]*)"/
        .exec(html)?.[1]
        ?.replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&") ?? "",
    restoreButton: /name="action" value="restore"/.test(html),
    error: /<p class="error" role="alert">([^<]*)<\/p>/.exec(html)?.[1] ?? "",
    imgSrc: /<img src="([^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") ?? "",
    hidden: [...html.matchAll(/<form method="post"[\s\S]*?<\/form>/g)][0]?.[0].match(/<input type="hidden" name="[^"]*" value="[^"]*">/g) ?? [],
  };
}

const image = async (q: string) => Buffer.from(await (await fetch(`${baseUrl}/image${q}`)).arrayBuffer());

describe("B9: page never interpolates user text unescaped", () => {
  test("watermark text with markup is escaped in the status line, the field and the image alt", async () => {
    const text = '<b onmouseover=alert(1)>HI</b> & "q"';
    const r = await post({ text, action: "set" });
    assert.equal(r.status, 303);
    try {
      const { html } = await page();
      assert.doesNotMatch(html, /<b onmouseover/, "raw markup must not appear anywhere in the page");
      assert.match(html, /wm-status">"&lt;b onmouseover=alert\(1\)&gt;HI&lt;\/b&gt; &amp; &quot;q&quot;" \(custom\)/);
      assert.match(html, /name="text"[^>]*value="&lt;b onmouseover=alert\(1\)&gt;HI&lt;\/b&gt; &amp; &quot;q&quot;"/);
    } finally {
      await post({ action: "restore" });
    }
  });
});

describe("B3: the default watermark size always fits the image", () => {
  test("a one-character mark (tall aspect) is clamped to fit instead of failing; explicit sizes are not clamped", async () => {
    const r = await post({ text: "I", action: "set" });
    assert.equal(r.status, 303);
    try {
      const p = await page("?wm=1");
      assert.equal(p.error, "", "no banner: the default size adapts");
      assert.equal(p.imgSrc, "/image?wm=1");
      const m = /(\d+)×(\d+) px on this image/.exec(p.status);
      assert.ok(m, p.status);
      const [w, h] = [Number(m![1]), Number(m![2])];
      assert.ok(w >= 1 && w <= 200, `width ${w}`);
      assert.ok(h + 16 <= 640, `height ${h} + margin fits 640`);
      assert.ok(h + 16 > 600, `clamped to (nearly) the full height, got ${h}`);
      assert.equal((await fetch(`${baseUrl}/image?wm=1`)).status, 200);
      // Explicit px sizes keep the strict rule (400), as does a margin larger than the image.
      const explicit = await fetch(`${baseUrl}/image?wm=1&wmWidth=200`);
      assert.equal(explicit.status, 400);
      assert.match(await explicit.text(), /Watermark 200x\d+ plus margin 16 does not fit/);
      const huge = await page("?wm=1&wmMargin=640");
      assert.match(huge.error, /does not fit/);
      // The stock mark is unaffected: 200 px wide as before.
      await post({ action: "restore" });
      assert.match((await page("?wm=1")).status, /200×18 px on this image/);
    } finally {
      await post({ action: "restore" });
    }
  });
});

describe("A5: per-request watermark text (wmText=) needs no shared state", () => {
  test("wmText renders exactly what the persisted custom text would, without touching the file", async () => {
    const perRequest = await image("?wm=1&wmWidth=30%25&wmText=HELLO");
    const stock = await image("?wm=1&wmWidth=30%25");
    assert.ok(!perRequest.equals(stock), "different mark");
    assert.equal((await page("?wm=1")).restoreButton, false, "no custom file was written");
    await post({ text: "HELLO", action: "set" });
    try {
      const persisted = await image("?wm=1&wmWidth=30%25");
      assert.ok(perRequest.equals(persisted), "same generator, same bytes");
      // While a custom file is active, wmText still wins for its own request.
      const other = await image("?wm=1&wmWidth=30%25&wmText=OTHER");
      assert.ok(!other.equals(persisted));
    } finally {
      await post({ action: "restore" });
    }
    // Two different texts at the same time: each request gets its own mark.
    const [a, b, a2] = await Promise.all([image("?wm=1&wmText=AAA"), image("?wm=1&wmText=BBB"), image("?wm=1&wmText=AAA")]);
    assert.ok(!a.equals(b) && a.equals(a2));
  });

  test("wmText is validated like the UI text; ignored when the watermark is off; exports and ZIPs honour it", async () => {
    for (const [t, re] of [
      ["日本語", /no glyph/],
      ["", /empty/],
      ["x".repeat(81), /at most 80/],
      ["a\u0007b", /control/],
    ] as const) {
      const r = await fetch(`${baseUrl}/image?wm=1&wmText=${encodeURIComponent(t)}`);
      assert.equal(r.status, 400, t);
      assert.match(await r.text(), /^wmText: /, t);
      assert.match(await (await fetch(`${baseUrl}/image?wm=1&wmText=${encodeURIComponent(t)}`)).text(), re, t);
    }
    const off = await fetch(`${baseUrl}/?wmText=日本語`);
    assert.equal(off.status, 200);
    assert.match(await off.text(), /<img src="\/image"/, "watermark off: wmText is dropped, not validated");
    const exp = await fetch(`${baseUrl}/export?wm=1&wmText=HELLO&format=png`);
    assert.equal(exp.status, 200);
    const zip = await fetch(`${baseUrl}/android.zip?image=thumb&wm=1&wmText=HELLO&wmWidth=20%25&buckets=mdpi`);
    assert.equal(zip.status, 200);
  });

  test("page: wmText is echoed in the field, shown in the status line as per-request, forwarded to the image", async () => {
    const p = await page("?wm=1&wmText=MINE");
    assert.equal(p.imgSrc, "/image?wm=1&wmText=MINE");
    assert.equal(p.textField, "MINE");
    assert.match(p.status, /^"MINE" \(this request\) · \d+×\d+ px on this image$/);
    assert.equal(p.error, "");
    assert.ok(
      p.hidden.some((h) => h.includes('name="wmText" value="MINE"')),
      "POST forms carry it back",
    );
    const bad = await page("?wm=1&wmText=%E6%97%A5");
    assert.match(bad.error, /wmText: .*no glyph/);
    assert.equal(bad.imgSrc, "/image");
  });
});

describe("B10: concurrent watermark writes are serialised and never poison readers", () => {
  test("40 rounds of 5 writes vs 20 size reads: no failed read, no failed write, last write wins, file always complete", async () => {
    const { getNativeSizes, setCustomWatermarkText } = await import("../src/app.ts");
    const { readFileSync } = await import("node:fs");
    let failedReads = 0;
    for (let round = 0; round < 40; round++) {
      const writes = Array.from({ length: 5 }, (_, i) => setCustomWatermarkText(`MARK ${round}-${i}`));
      const reads = Array.from({ length: 20 }, () =>
        getNativeSizes("sample").then(
          () => 0,
          () => 1,
        ),
      );
      const [r] = await Promise.all([Promise.all(reads), Promise.all(writes)]);
      failedReads += r.reduce((a, b) => a + b, 0);
      const svg = readFileSync(customPath, "utf8");
      assert.ok(svg.trimEnd().endsWith("</svg>"), `round ${round}: file on disk is complete`);
      assert.match(svg, new RegExp(`Watermark: "MARK ${round}-4"`), `round ${round}: the last write wins`);
    }
    assert.equal(failedReads, 0);
    await post({ action: "restore" });
  });

  test("a corrupt custom file (e.g. disk full) falls back to the stock mark with a warning instead of a 500, and recovers", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(customPath, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect wid', "utf8");
    try {
      const r = await fetch(`${baseUrl}/image?wm=1&wmWidth=200`);
      assert.equal(r.status, 200);
      const p = await page("?wm=1");
      assert.match(p.status, /^"SHARP VIEWER" \(stock\)/, "stock mark used while the custom file is unreadable");
      assert.equal(p.error, "");
      await post({ text: "FIXED", action: "set" });
      assert.match((await page("?wm=1")).status, /^"FIXED" \(custom\)/);
    } finally {
      await post({ action: "restore" });
    }
  });
});

describe("custom watermark text via the UI (POST /watermark)", () => {
  test("config: the custom path override is in effect", () => {
    assert.equal(app.customWatermarkPath, customPath);
  });

  test("stock state: status, field pre-filled with the stock text, no Restore button, passthrough fields", async () => {
    const p = await page("?wm=1&wmWidth=300&traverseX=-100&view=mobile&device=pixel-7");
    assert.equal(p.status, '"SHARP VIEWER" (stock) · 300×27 px on this image');
    assert.equal(p.textField, "SHARP VIEWER");
    assert.equal(p.restoreButton, false);
    assert.deepEqual(p.hidden, [
      '<input type="hidden" name="wm" value="1">',
      '<input type="hidden" name="wmWidth" value="300">',
      '<input type="hidden" name="traverseX" value="-100">',
      '<input type="hidden" name="view" value="mobile">',
      '<input type="hidden" name="device" value="pixel-7">',
      '<input type="hidden" name="orientation" value="portrait">',
      '<input type="hidden" name="appliedTraverseX" value="-100">',
    ]);
  });

  test("Set text: writes the custom mark, redirects back with the settings, image and bounds change", async () => {
    const stockImage = await image("?wm=1&wmWidth=300");
    const r = await post({ text: "DARTH VADER", action: "set", wm: "1", wmWidth: "300", traverseX: "-100" });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/?wm=1&wmWidth=300&traverseX=-100");
    assert.ok(existsSync(customPath));
    assert.match(readFileSync(customPath, "utf8"), /Watermark: "DARTH VADER"/);
    const p = await page("?wm=1&wmWidth=300&traverseX=-100");
    assert.equal(p.status, '"DARTH VADER" (custom) · 300×28 px on this image');
    assert.equal(p.textField, "DARTH VADER");
    assert.ok(p.restoreButton);
    assert.notDeepEqual(await image("?wm=1&wmWidth=300"), stockImage, "image now carries the new text");
    // DARTH VADER is 373x35 natively -> 300x28; stock is 300x27: the traverse bounds follow the active mark.
    const bounds = await page("?wm=1&wmWidth=300&traverseY=30");
    assert.match(bounds.html, /allowed -596 to 16/);
  });

  test("the custom mark is rendered through the same pipeline (dimensions, PNG)", async () => {
    const png = await image("?wm=1&wmWidth=300&rotate=90&width=320");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [320, 480]);
  });

  test("Set text again replaces the previous custom mark", async () => {
    const r = await post({ text: "ACME", wm: "1" });
    assert.equal(r.status, 303);
    assert.match(readFileSync(customPath, "utf8"), /Watermark: "ACME"/);
    assert.equal((await page()).textField, "ACME");
  });

  for (const [text, re] of [
    ["", /text must not be empty/],
    ["   ", /text must not be empty/],
    ["日本語", /no glyph for: '日' '本' '語'/],
    ["A".repeat(81), /at most 80 characters/],
  ] as Array<[string, RegExp]>) {
    test(`invalid ${JSON.stringify(text.slice(0, 12))}: 400, page re-rendered with banner, typed text kept, image still shown, custom mark untouched`, async () => {
      const r = await post({ text, wm: "1", wmWidth: "300", traverseX: "-100" });
      assert.equal(r.status, 400);
      assert.match(r.html, /<p class="error" role="alert">Watermark text: /);
      assert.match(r.html, re);
      const field = /name="text"[^>]*value="([^"]*)"/.exec(r.html)?.[1] ?? "";
      assert.equal(field, text);
      assert.match(r.html, /<img src="\/image\?wm=1&amp;wmWidth=300&amp;traverseX=-100"/, "image keeps its valid settings");
      assert.match(readFileSync(customPath, "utf8"), /Watermark: "ACME"/, "previous custom mark still active");
    });
  }

  test("Restore stock: removes the custom mark, redirects, stock is active again", async () => {
    const r = await post({ action: "restore", wm: "1", view: "mobile", device: "galaxy-s24", orientation: "landscape" });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/?wm=1&view=mobile&device=galaxy-s24&orientation=landscape");
    assert.equal(existsSync(customPath), false);
    const p = await page();
    assert.equal(p.status, '"SHARP VIEWER" (stock) · hidden');
    assert.equal(p.restoreButton, false);
    assert.match((await page("?wm=1&wmWidth=300&traverseY=30")).html, /allowed -597 to 16/);
  });

  test("Restore when already stock is a harmless no-op", async () => {
    const r = await post({ action: "restore" });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/");
  });

  test("GET/HEAD /watermark -> 405 Allow: POST; oversized body -> 400", async () => {
    const g = await fetch(`${baseUrl}/watermark`);
    assert.equal(g.status, 405);
    assert.equal(g.headers.get("allow"), "POST");
    const big = await fetch(`${baseUrl}/watermark`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `text=${"A".repeat(20000)}`,
    }).catch(() => null);
    if (big) assert.equal(big.status, 400);
  });

  test("image-only page (embed=image) has no text form; Desktop and Mobile pages do", async () => {
    assert.doesNotMatch((await page("?embed=image")).html, /<form method="post"/);
    assert.match((await page("")).html, /<form method="post" action="\/watermark"/);
    assert.match((await page("?view=mobile")).html, /<form method="post" action="\/watermark"/);
  });

  test("concurrent reads during writes never see a broken mark", async () => {
    const writes = Array.from({ length: 5 }, (_, i) => post({ text: `MARK ${i}`, wm: "1" }));
    const reads = Array.from({ length: 20 }, () => fetch(`${baseUrl}/image?wm=1&wmWidth=200`).then((r) => r.status));
    const [statuses] = await Promise.all([Promise.all(reads), Promise.all(writes)]);
    assert.ok(
      statuses.every((s) => s === 200),
      statuses.join(","),
    );
    await post({ action: "restore" });
  });
});
