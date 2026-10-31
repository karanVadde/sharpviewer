/**
 * Watermark green tone (spec 4 `wmTone`, 4b): a linear light-to-dark green scale for the mark's
 * fill, with the outline flipping to light on dark tones. Omitted = the mark's original colours.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { autoTone, contrastRatio, createApp, parseImageOptions, recolourMark, TONE_HUE, toneColour, toneStroke } from "../src/app.ts";

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

const hexToRgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const lightness = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  return (Math.max(r!, g!, b!) + Math.min(r!, g!, b!)) / 2;
};

describe("tone scale", () => {
  test("linear lightness from 88% (0) to 18% (100), hue fixed at green, saturation fixed", () => {
    assert.equal(TONE_HUE, 152);
    assert.ok(Math.abs(lightness(toneColour(0)) - 0.88) < 0.01, toneColour(0));
    assert.ok(Math.abs(lightness(toneColour(50)) - 0.53) < 0.01, toneColour(50));
    assert.ok(Math.abs(lightness(toneColour(100)) - 0.18) < 0.01, toneColour(100));
    // Linear: equal steps in tone give equal steps in lightness.
    const steps = [0, 25, 50, 75, 100].map((t) => lightness(toneColour(t)));
    const deltas = steps.slice(1).map((l, i) => steps[i]! - l);
    for (const d of deltas) assert.ok(Math.abs(d - deltas[0]!) < 0.012, `linear: ${deltas.map((x) => x.toFixed(3)).join(",")}`);
    // Green: G is the strongest channel at every tone.
    for (const t of [0, 30, 60, 100]) {
      const [r, g, b] = hexToRgb(toneColour(t));
      assert.ok(g! >= r! && g! >= b!, `${t}: ${toneColour(t)}`);
    }
    assert.match(toneColour(0), /^#[0-9a-f]{6}$/);
  });

  test("outline: dark on light tones (<= 50), light on dark tones (> 50)", () => {
    assert.equal(toneStroke(0), "#1f2933");
    assert.equal(toneStroke(50), "#1f2933");
    assert.equal(toneStroke(51), "#f6f5f1");
    assert.equal(toneStroke(100), "#f6f5f1");
  });

  test("recolourMark rewrites exactly the generator's fill and stroke, nothing else; no tone -> untouched", () => {
    const svg = '<svg><path d="M0 0" fill="none" stroke="#1f2933" stroke-width="2"/><path d="M0 0" fill="#f6f5f1"/></svg>';
    assert.equal(recolourMark(svg, undefined), svg);
    const out = recolourMark(svg, 100);
    assert.equal(out, `<svg><path d="M0 0" fill="none" stroke="#f6f5f1" stroke-width="2"/><path d="M0 0" fill="${toneColour(100)}"/></svg>`);
    assert.ok(!out.includes("#1f2933"));
  });

  test("parsing: wmTone 0-100 only with the watermark on; out of range rejected", () => {
    assert.equal(parseImageOptions(new URLSearchParams("wm=1&wmTone=35")).watermark!.tone, 35);
    assert.equal(parseImageOptions(new URLSearchParams("wm=1")).watermark!.tone, undefined);
    assert.throws(() => parseImageOptions(new URLSearchParams("wm=1&wmTone=101")), /wmTone must be an integer between 0 and 100\./);
    assert.throws(() => parseImageOptions(new URLSearchParams("wm=1&wmTone=-1")), /wmTone must be/);
  });
});

describe("rendered colours", () => {
  const render = async (q: string) => {
    const r = await fetch(`${baseUrl}/image?${q}`);
    assert.equal(r.status, 200, q);
    return sharp(Buffer.from(await r.arrayBuffer()))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  };
  /** Average colour of the pixels that the mark changed vs the unmarked render, split into fill-ish (opaque) samples. */
  const markColour = async (q: string) => {
    const plain = await render(q.replace(/&wm=1[^&]*/, ""));
    const marked = await render(q);
    let n = 0,
      r = 0,
      g = 0,
      b = 0;
    for (let i = 0; i < marked.data.length; i += 4) {
      const diff =
        Math.abs(marked.data[i]! - plain.data[i]!) + Math.abs(marked.data[i + 1]! - plain.data[i + 1]!) + Math.abs(marked.data[i + 2]! - plain.data[i + 2]!);
      if (diff > 60) {
        n++;
        r += marked.data[i]!;
        g += marked.data[i + 1]!;
        b += marked.data[i + 2]!;
      }
    }
    return { n, r: r / n, g: g / n, b: b / n };
  };
  // A neutral grey canvas (contain-padded thumb in a big cell) so the mark's colour is measurable.
  const base = "layout=split-h&cells=thumb&cellFit=contain&preset=ig-square&bg=%23808080&wm=1&wmWidth=40%25&wmOpacity=100&wmMargin=200";

  test("tone 0 renders a light green mark, tone 100 a dark green mark; both differ from the original cream mark", async () => {
    const original = await markColour(base);
    const light = await markColour(`${base}&wmTone=0`);
    const dark = await markColour(`${base}&wmTone=100`);
    assert.ok(original.n > 500 && light.n > 500 && dark.n > 500, "mark pixels found");
    assert.ok(light.g > light.r && light.g > light.b && light.g > 180, `light green: ${[light.r, light.g, light.b].map(Math.round)}`);
    assert.ok(dark.g > dark.r && dark.g > dark.b && dark.g < 120, `dark green: ${[dark.r, dark.g, dark.b].map(Math.round)}`);
    assert.ok(Math.abs(original.r - original.g) < 25, `original is near-neutral cream: ${[original.r, original.g, original.b].map(Math.round)}`);
    // Monotonic: lightness (sum of channels) decreases with the tone.
    const mid = await markColour(`${base}&wmTone=50`);
    assert.ok(light.r + light.g + light.b > mid.r + mid.g + mid.b && mid.r + mid.g + mid.b > dark.r + dark.g + dark.b, "darker with a higher tone");
  });

  test("tone applies to custom (wmText) marks too; the size is unchanged; the render cache keys on the tone", async () => {
    const a = Buffer.from(await (await fetch(`${baseUrl}/image?wm=1&wmText=TONE&wmTone=20`)).arrayBuffer());
    const b = Buffer.from(await (await fetch(`${baseUrl}/image?wm=1&wmText=TONE&wmTone=80`)).arrayBuffer());
    const c = Buffer.from(await (await fetch(`${baseUrl}/image?wm=1&wmText=TONE`)).arrayBuffer());
    assert.ok(!a.equals(b) && !a.equals(c));
    const html = await (await fetch(`${baseUrl}/?wm=1&wmTone=20`)).text();
    assert.match(html, /200&times;18 px on this image/, "size unchanged by the tone");
  });
});

describe("page", () => {
  test("checkbox + slider: forwarded only when the checkbox is on; echoed; gradient preview present; Download/ZIP links carry it", async () => {
    const off = await (await fetch(`${baseUrl}/?wm=1&wmTone=40`)).text();
    assert.match(off, /<img src="\/image\?wm=1"/, "slider value alone (checkbox off) is not forwarded");
    assert.match(off, /name="wmToneOn" value="1" form="settings"(?! checked)/);
    const on = await (await fetch(`${baseUrl}/?wm=1&wmTone=40&wmToneOn=1`)).text();
    assert.match(on, /<img src="\/image\?wm=1&amp;wmTone=40"/);
    assert.match(on, /name="wmToneOn" value="1" form="settings" checked/);
    assert.match(on, /name="wmTone" form="settings" min="0" max="100" step="1" value="40"/);
    assert.match(on, /class="tone-scale"/, "gradient preview of the scale");
    assert.match(on, /href="\/export\?wm=1&amp;wmTone=40[^"]*"/);
    assert.match(on, /Green tone 40/, "context line");
    const bad = await (await fetch(`${baseUrl}/?wm=1&wmTone=101&wmToneOn=1`)).text();
    assert.match(bad, /wmTone must be an integer between 0 and 100/);
  });
});

// ---------------------------------------------------------------------------
// I-8: the default mark must be visible where the collage places it (on the background)

describe("I-8: auto-contrast tone on collages", () => {
  test("autoTone picks the tone end with the higher WCAG contrast against bg; contrastRatio is symmetric and 21:1 for black/white", () => {
    assert.equal(autoTone("#ffffff"), 100, "dark green on white");
    assert.equal(autoTone("#000000"), 0, "light green on black");
    assert.equal(autoTone("#f7f7f5"), 100);
    assert.equal(autoTone("#1f2933"), 0);
    assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 0.01);
    assert.equal(contrastRatio("#123456", "#abcdef"), contrastRatio("#abcdef", "#123456"));
    assert.ok(contrastRatio(toneColour(100), "#ffffff") > 7, `dark green on white: ${contrastRatio(toneColour(100), "#ffffff").toFixed(1)}`);
    assert.ok(contrastRatio("#f6f5f1", "#ffffff") < 1.2, "the cream fill on white is invisible - the bug");
  });

  test("default collage (white bg, mark in the band) renders a clearly visible dark green mark; single images keep the cream mark", async () => {
    const render = async (q: string) =>
      sharp(Buffer.from(await (await fetch(`${baseUrl}/image?${q}`)).arrayBuffer()))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const base = "layout=grid-2x2&cells=sample,sample";
    const plain = await render(base);
    const marked = await render(`${base}&wm=1`);
    let n = 0,
      r = 0,
      g = 0,
      b = 0,
      strong = 0;
    for (let y = 1058; y < 1080; y++)
      for (let x = 700; x < 1080; x++) {
        const i = (y * 1080 + x) * 4;
        const diff =
          Math.abs(marked.data[i]! - plain.data[i]!) + Math.abs(marked.data[i + 1]! - plain.data[i + 1]!) + Math.abs(marked.data[i + 2]! - plain.data[i + 2]!);
        if (diff > 0) {
          n++;
          r += marked.data[i]!;
          g += marked.data[i + 1]!;
          b += marked.data[i + 2]!;
        }
        if (diff > 150) strong++;
      }
    assert.ok(n > 500, `mark pixels in the band: ${n}`);
    assert.ok(strong > 300, `pixels that differ strongly from white (a human can see them): ${strong}`);
    assert.ok(g / n > r / n && g / n > b / n && (r + g + b) / n < 500, `average mark colour is dark green: ${[r / n, g / n, b / n].map(Math.round)}`);
    // Same request with the user's own tone wins; a single image is untouched (cream mark, no auto tone).
    const light = await render(`${base}&wm=1&wmTone=0`);
    assert.ok(!Buffer.from(light.data).equals(Buffer.from(marked.data)), "explicit tone 0 differs from the automatic 100");
    const singleStock = Buffer.from(await (await fetch(`${baseUrl}/image?wm=1`)).arrayBuffer());
    const singleOld = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./fixtures/golden/bin-07.json", import.meta.url), "utf8"));
    assert.equal(singleOld.url, "/image?wm=1");
    assert.equal(
      (await import("node:crypto")).createHash("sha256").update(singleStock).digest("hex"),
      singleOld.sha256,
      "single-image default render is byte-identical to the golden (no auto tone)",
    );
  });

  test("page: status says the tone is automatic; no auto tone when the mark sits over a picture; low-contrast toast for a poor manual choice", async () => {
    const page = async (q: string) => (await fetch(`${baseUrl}/${q}`)).text();
    const auto = await page("?layout=grid-2x2&cells=sample,sample&wm=1");
    assert.match(auto, /wm-status">[^<]*Green tone 100 \(automatic: dark green on the light background\)/);
    assert.match(
      auto,
      /<img src="\/image\?wm=1&amp;layout=grid-2x2&amp;cells=sample%2Csample%2C%2C"/,
      "automatic tone is a render default, not a URL parameter",
    );
    assert.doesNotMatch(auto, /low contrast/);
    const dark = await page("?layout=grid-2x2&cells=sample,sample&wm=1&bg=%23000000");
    assert.match(dark, /Green tone 0 \(automatic: light green on the dark background\)/);
    const overCell = await page("?layout=grid-2x2&cells=sample,sample,sample,sample&wm=1&gutter=8");
    assert.doesNotMatch(/wm-status">[^<]*/.exec(overCell)![0], /Green tone/, "gutter 8 < mark height: the mark is over cell 4, cream as before");
    assert.match(overCell, /overlaps cell 4/);
    const poor = await page("?layout=grid-2x2&cells=sample,sample&wm=1&wmToneOn=1&wmTone=0");
    assert.match(poor, /<div class="toast"><span>The watermark has low contrast on the background \(1\.\d:1\): try Green tone 100\./);
    const good = await page("?layout=grid-2x2&cells=sample,sample&wm=1&wmToneOn=1&wmTone=100");
    assert.doesNotMatch(good, /low contrast/);
  });
});
