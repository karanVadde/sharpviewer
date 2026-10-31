import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createApp, getNativeSizes, outputSize, parseImageOptions, renderImage, traverseRange, watermarkSize } from "../src/app.ts";

let baseUrl: string;
const server = createApp();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

async function page(query: string) {
  const response = await fetch(`${baseUrl}/${query}`);
  const html = await response.text();
  const imgSrc = /<img src="([^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") ?? "";
  const toasts = [...html.matchAll(/<div class="toast"><span>([^<]*)<\/span>/g)].map((m) => m[1]!);
  const error = /<p class="error" role="alert">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
  const field = (name: string) => new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? "";
  return { status: response.status, html, imgSrc, toasts, error, field };
}

function pngSize(png: Buffer) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("size calculator matches what sharp actually produces", () => {
  // The page validates traverse bounds *before* rendering, using outputSize()/watermarkSize().
  // These must agree with sharp's real rounding or the page could still emit a 400 URL.
  const queries = [
    "",
    "width=480",
    "width=333",
    "height=320",
    "height=101",
    "width=300&height=300",
    "rotate=90",
    "rotate=270&width=123",
    "rotate=180&height=77",
    "width=1&rotate=90",
    "height=1",
  ];
  for (const q of queries) {
    test(`output size for ?${q}`, async () => {
      const options = parseImageOptions(new URLSearchParams(q));
      const expected = outputSize((await getNativeSizes()).image, options);
      assert.deepEqual(pngSize(await renderImage(options)), expected);
    });
  }

  const marks = ["", "wmWidth=100", "wmWidth=333", "wmHeight=20", "wmHeight=7", "wmHeight=60", "wmWidth=250&wmHeight=120", "wmWidth=1"];
  for (const q of marks) {
    test(`watermark size for ?wm=1&${q}`, async () => {
      const options = parseImageOptions(new URLSearchParams(`wm=1&${q}`));
      const { mark, image } = await getNativeSizes();
      const expected = watermarkSize(mark, options.watermark!, image);
      const params = new URLSearchParams(q);
      // fileURLToPath, not .pathname: a project folder with a space would otherwise become "%20".
      const rendered = await sharp(fileURLToPath(new URL("../public/watermark.svg", import.meta.url)))
        .resize(
          params.get("wmWidth") ? Number(params.get("wmWidth")) : params.get("wmHeight") ? undefined : 200,
          params.get("wmHeight") ? Number(params.get("wmHeight")) : undefined,
          params.get("wmWidth") && params.get("wmHeight") ? { fit: "fill" } : {},
        )
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.deepEqual({ width: rendered.info.width, height: rendered.info.height }, expected);
    });
  }

  test("traverseRange: the extremes render (200) and one px beyond is rejected (400)", async () => {
    const native = await getNativeSizes();
    const options = parseImageOptions(new URLSearchParams("wm=1&wmWidth=200&rotate=90&width=320"));
    const output = outputSize(native.image, options);
    const range = traverseRange(output, watermarkSize(native.mark, options.watermark!, output), 16);
    for (const [tx, ty, ok] of [
      [range.x[0], range.y[0], true],
      [range.x[1], range.y[1], true],
      [range.x[0] - 1, 0, false],
      [range.x[1] + 1, 0, false],
      [0, range.y[0] - 1, false],
      [0, range.y[1] + 1, false],
    ] as Array<[number, number, boolean]>) {
      const r = await fetch(`${baseUrl}/image?wm=1&wmWidth=200&rotate=90&width=320&traverseX=${tx}&traverseY=${ty}`);
      assert.equal(r.status, ok ? 200 : 400, `traverse ${tx},${ty}`);
    }
  });
});

describe("viewer page: traverse out of bounds -> toast, mark stays where it was (never a broken image)", () => {
  test("in bounds: no toast, values forwarded untouched, applied fields echo them", async () => {
    const p = await page("?wm=1&traverseX=-100&traverseY=-50");
    assert.deepEqual(p.toasts, []);
    assert.equal(p.error, "");
    assert.equal(p.imgSrc, "/image?wm=1&traverseX=-100&traverseY=-50");
    assert.equal(p.field("appliedTraverseX"), "-100");
    assert.equal(p.field("appliedTraverseY"), "-50");
  });

  const cases: Array<[string, string[], string, [string, string]]> = [
    // No previous position known -> keep the anchor (0): the traverse param is dropped from the image URL.
    ["?wm=1&traverseX=-800", ["traverseX -800 is out of bounds for this size: allowed -744 to 16. Keeping 0."], "/image?wm=1", ["0", "0"]],
    ["?wm=1&traverseX=17", ["traverseX 17 is out of bounds for this size: allowed -744 to 16. Keeping 0."], "/image?wm=1", ["0", "0"]],
    ["?wm=1&traverseY=-4096", ["traverseY -4096 is out of bounds for this size: allowed -606 to 16. Keeping 0."], "/image?wm=1", ["0", "0"]],
    ["?wm=1&traverseY=30", ["traverseY 30 is out of bounds for this size: allowed -606 to 16. Keeping 0."], "/image?wm=1", ["0", "0"]],
    // Previous position known (hidden fields) -> the mark stays exactly there.
    [
      "?wm=1&traverseX=-800&appliedTraverseX=-100",
      ["traverseX -800 is out of bounds for this size: allowed -744 to 16. Keeping -100."],
      "/image?wm=1&traverseX=-100",
      ["-100", "0"],
    ],
    [
      "?wm=1&traverseX=-800&traverseY=30&appliedTraverseX=-100&appliedTraverseY=-50",
      [
        "traverseX -800 is out of bounds for this size: allowed -744 to 16. Keeping -100.",
        "traverseY 30 is out of bounds for this size: allowed -606 to 16. Keeping -50.",
      ],
      "/image?wm=1&traverseX=-100&traverseY=-50",
      ["-100", "-50"],
    ],
    // Only the offending axis is replaced; the valid one is applied as typed.
    [
      "?wm=1&traverseX=-800&traverseY=-20&appliedTraverseX=-100&appliedTraverseY=-50",
      ["traverseX -800 is out of bounds for this size: allowed -744 to 16. Keeping -100."],
      "/image?wm=1&traverseX=-100&traverseY=-20",
      ["-100", "-20"],
    ],
    // Previous position no longer fits (size changed at the same time) -> anchor.
    [
      "?wm=1&wmWidth=900&traverseX=-800&appliedTraverseX=-100",
      ["traverseX -800 is out of bounds for this size: allowed -44 to 16. Keeping 0."],
      "/image?wm=1&wmWidth=900",
      ["0", "0"],
    ],
    // Garbage in the hidden field is ignored -> anchor.
    ["?wm=1&traverseX=-800&appliedTraverseX=abc", ["traverseX -800 is out of bounds for this size: allowed -744 to 16. Keeping 0."], "/image?wm=1", ["0", "0"]],
    [
      "?rotate=90&width=320&wm=1&wmWidth=100&traverseY=-999&appliedTraverseY=-200",
      ["traverseY -999 is out of bounds for this size: allowed -455 to 16. Keeping -200."],
      "/image?width=320&rotate=90&wm=1&wmWidth=100&traverseY=-200",
      ["0", "-200"],
    ],
    [
      "?wm=1&wmMargin=40&traverseX=41&appliedTraverseX=40",
      ["traverseX 41 is out of bounds for this size: allowed -720 to 40. Keeping 40."],
      "/image?wm=1&wmMargin=40&traverseX=40",
      ["40", "0"],
    ],
  ];
  for (const [q, toasts, src, applied] of cases) {
    test(`${q}`, async () => {
      const p = await page(q);
      assert.equal(p.status, 200);
      assert.deepEqual(p.toasts, toasts);
      assert.equal(p.imgSrc, src);
      assert.deepEqual([p.field("appliedTraverseX"), p.field("appliedTraverseY")], applied, "hidden applied fields");
      assert.equal(p.error, "", "no error banner for a traverse warning");
      assert.match(p.html, /name="wm" value="1" form="settings" checked/, "watermark stays on");
    });
  }

  test("the image really is at the kept position (pixel check)", async () => {
    const kept = await (await fetch(`${baseUrl}/image?wm=1&traverseX=-100&traverseY=-50`)).arrayBuffer();
    const p = await page("?wm=1&traverseX=-800&traverseY=30&appliedTraverseX=-100&appliedTraverseY=-50");
    const shown = await (await fetch(`${baseUrl}${p.imgSrc}`)).arrayBuffer();
    assert.ok(Buffer.from(shown).equals(Buffer.from(kept)));
  });

  test("form fields echo what was typed, not the kept value", async () => {
    const p = await page("?wm=1&traverseX=-800&traverseY=30&appliedTraverseX=-100&appliedTraverseY=-50");
    assert.equal(p.field("traverseX"), "-800");
    assert.equal(p.field("traverseY"), "30");
  });

  test("toast markup has a dismiss button and the page has the dismiss script", async () => {
    const p = await page("?wm=1&traverseX=-800");
    assert.match(p.html, /<div class="toasts" role="status" aria-live="polite">/);
    assert.match(p.html, /<button type="button" class="toast-close" aria-label="Dismiss">/);
    const script = /<script nonce="[A-Za-z0-9_-]+">([\s\S]*)<\/script>/.exec(p.html)?.[1] ?? "";
    assert.ok(script.includes("toast-close") && script.includes("6000"), "dismiss button handler and 6 s auto-dismiss");
  });

  test("no toast container or script-visible toast when nothing is wrong", async () => {
    const p = await page("");
    assert.doesNotMatch(p.html, /class="toasts"/);
  });

  test("render-impossible input (mark too big) shows the banner and the plain image, not a broken image", async () => {
    const p = await page("?wm=1&wmWidth=960");
    assert.equal(p.error, "Watermark 960x87 plus margin 16 does not fit inside the 960x640 image.");
    assert.equal(p.imgSrc, "/image");
    assert.deepEqual(p.toasts, []);
  });

  test("toast text is HTML-escaped", async () => {
    // traverseX must be an integer, so an injection attempt hits the banner path; ensure escaping there too.
    const p = await page("?wm=1&traverseX=%3Cb%3E");
    assert.doesNotMatch(p.html, /<b>/);
  });
});

describe("viewer page: every <img src> the page emits must load (200)", () => {
  const queries = [
    "",
    "?wm=1",
    "?wm=1&traverseX=-800",
    "?wm=1&traverseX=17&traverseY=17",
    "?wm=1&traverseY=-9999",
    "?wm=1&traverseX=-800&appliedTraverseX=-100",
    "?wm=1&traverseX=-800&appliedTraverseX=-9999",
    "?wm=1&traverseX=-800&appliedTraverseX=1.5",
    "?rotate=90&width=320&wm=1&wmWidth=100&traverseX=-4096&traverseY=4096",
    "?wm=1&wmWidth=960",
    "?wm=1&wmWidth=abc",
    "?width=0",
    "?wm=1&wmHeight=60&wmMargin=100&traverseX=-4096",
    "?wm=1&wmWidth=944&wmHeight=100&traverseX=1",
  ];
  for (const q of queries) {
    test(`page ${q || "/"} -> its image loads`, async () => {
      const p = await page(q);
      assert.equal(p.status, 200);
      const img = await fetch(`${baseUrl}${p.imgSrc}`);
      assert.equal(img.status, 200, `${p.imgSrc} -> ${img.status}: ${await img.text()}`);
      assert.equal(img.headers.get("content-type"), "image/png");
    });
  }
});

describe("4l: live updates markup (the behaviour itself is covered by the browser test)", () => {
  test("sticky action bar with Apply, Reset, Open image only, the live toggle and the pending hint; script wires change -> submit with scroll/focus restore", async () => {
    const html = await (await fetch(`${baseUrl}/?wm=1`)).text();
    const bar = /<form id="settings"[^>]*class="actions"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    assert.match(bar, /<button type="submit" class="primary">Apply<\/button>/);
    assert.match(bar, /class="link" href="\/">Reset</);
    assert.match(bar, /Open image only/);
    assert.match(bar, /<label class="check live-toggle"><input type="checkbox" id="live-toggle" checked> Update as I change settings<\/label>/);
    assert.match(bar, /<span class="pending" hidden>Unapplied changes<\/span>/);
    assert.doesNotMatch(bar, /name="live"/, "the toggle is page-local (localStorage), never a URL parameter");
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    assert.match(bar, /<span class="busy" hidden>Updating&hellip;<\/span>/);
    for (const needle of [
      'addEventListener("change"',
      "sessionStorage",
      "sharp-viewer:live",
      "sharp-viewer:scroll",
      "scrollTo(",
      "requestSubmit",
      "250",
      "fetch(",
      "pushState",
      "popstate",
      "DOMParser",
      "new Image()",
      "aria-busy",
    ]) {
      assert.ok(script.includes(needle), `script has ${needle}`);
    }
    assert.match(html, /\.actions\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/, "bar pinned to the bottom of the viewport");
    const embed = await (await fetch(`${baseUrl}/?embed=image`)).text();
    assert.doesNotMatch(embed, /id="live-toggle"|<script/, "image-only page has no controls and no script");
  });
});
