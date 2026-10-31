import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { boxClippedByCorners, cornerRadius, createApp, parseImageOptions } from "../src/app.ts";

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

async function image(query: string) {
  const r = await fetch(`${baseUrl}/image?${query}`);
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
}
async function pixels(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as const;
  };
  return { data, width: info.width, height: info.height, at };
}
/** Mean absolute difference between neighbouring pixels (a simple edge-contrast measure). */
function edgeContrast(p: Awaited<ReturnType<typeof pixels>>): number {
  let sum = 0,
    n = 0;
  for (let y = 0; y < p.height; y += 3)
    for (let x = 1; x < p.width; x += 3) {
      const a = p.at(x, y),
        b = p.at(x - 1, y);
      sum += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      n++;
    }
  return sum / n;
}

const IMAGES: Array<[string, number, number]> = [
  ["sample", 960, 640],
  ["thumb", 320, 240],
  ["portrait", 1080, 1920],
  ["panorama", 4000, 1000],
];

describe("parsing", () => {
  test("defaults and flags", () => {
    const o = parseImageOptions(new URLSearchParams(""));
    assert.deepEqual([o.sharpen, o.grayscale, o.corners], [false, false, 0]);
    const on = parseImageOptions(new URLSearchParams("sharpen=on&grayscale=true&corners=100"));
    assert.deepEqual([on.sharpen, on.grayscale, on.corners], [true, true, 100]);
    for (const q of ["sharpen=maybe", "grayscale=2", "corners=101", "corners=-1", "corners=1.5", "corners=abc"]) {
      assert.throws(() => parseImageOptions(new URLSearchParams(q)), q);
    }
  });

  test("B7: flag values are exactly the documented ones (1/true/on, 0/false/off/empty); yes/no are rejected", () => {
    for (const on of ["1", "true", "on", "TRUE", " On "]) assert.equal(parseImageOptions(new URLSearchParams(`sharpen=${on}`)).sharpen, true, on);
    for (const off of ["0", "false", "off", ""]) assert.equal(parseImageOptions(new URLSearchParams(`sharpen=${off}`)).sharpen, false, off);
    for (const bad of ["yes", "no", "y", "n"]) {
      assert.throws(
        () => parseImageOptions(new URLSearchParams(`grayscale=${bad}`)),
        /grayscale must be one of 1, true, on \(or 0, false, off, omitted\)\./,
        bad,
      );
      assert.throws(() => parseImageOptions(new URLSearchParams(`wm=${bad}`)), /wm must be one of 1, true, on \(or 0, false, off, omitted\)\./, bad);
    }
  });

  test("cornerRadius is linear: 0 -> 0, 100 -> min(W,H)/2, 25 on 960x640 -> 80", () => {
    assert.equal(cornerRadius({ width: 960, height: 640 }, 0), 0);
    assert.equal(cornerRadius({ width: 960, height: 640 }, 100), 320);
    assert.equal(cornerRadius({ width: 960, height: 640 }, 25), 80);
    assert.equal(cornerRadius({ width: 640, height: 960 }, 100), 320);
    assert.equal(cornerRadius({ width: 400, height: 400 }, 50), 100);
    assert.equal(cornerRadius({ width: 4000, height: 1000 }, 10), 50);
  });

  test("boxClippedByCorners", () => {
    const out = { width: 960, height: 640 };
    assert.equal(boxClippedByCorners(out, 0, { left: 900, top: 600, width: 60, height: 40 }), false);
    assert.equal(boxClippedByCorners(out, 100, { left: 400, top: 300, width: 100, height: 50 }), false, "centre box untouched");
    assert.equal(boxClippedByCorners(out, 100, { left: 744, top: 606, width: 200, height: 18 }), true, "default mark position at radius 100");
    assert.equal(boxClippedByCorners(out, 100, { left: 0, top: 0, width: 50, height: 50 }), true, "top-left corner");
    assert.equal(boxClippedByCorners(out, 100, { left: 100, top: 0, width: 760, height: 640 }), false, "spans between the corner arcs");
  });
});

for (const [id, W, H] of IMAGES) {
  describe(`enhance on "${id}" (${W}x${H})`, () => {
    let plain: Awaited<ReturnType<typeof pixels>>;
    before(async () => {
      plain = await pixels((await image(`image=${id}`)).body);
    });

    test("grayscale: every pixel has R = G = B, size and opacity unchanged", async () => {
      const g = await pixels((await image(`image=${id}&grayscale=1`)).body);
      assert.deepEqual([g.width, g.height], [W, H]);
      for (let i = 0; i < g.data.length; i += 4 * 7) {
        assert.equal(g.data[i], g.data[i + 1]);
        assert.equal(g.data[i + 1], g.data[i + 2]);
        assert.equal(g.data[i + 3], 255);
      }
      // It is a real luminance conversion, not a flat fill: the image still has some contrast.
      assert.ok(edgeContrast(g) > 0, "not flat");
      const samples = Array.from({ length: 400 }, (_, i) => g.data[Math.floor((i * g.data.length) / 400 / 4) * 4]);
      assert.ok(new Set(samples).size > 5, "several grey levels");
    });

    test("sharpen: edge contrast increases, size unchanged, image differs from the original", async () => {
      const s = await pixels((await image(`image=${id}&sharpen=1`)).body);
      assert.deepEqual([s.width, s.height], [W, H]);
      const before = edgeContrast(plain),
        after = edgeContrast(s);
      assert.ok(after > before, `edge contrast ${before.toFixed(2)} -> ${after.toFixed(2)}`);
      assert.notDeepEqual(s.data, plain.data);
    });

    for (const corners of [1, 25, 100]) {
      test(`corners=${corners}: corner pixels transparent, centre opaque, alpha boundary at the computed radius`, async () => {
        const c = await pixels((await image(`image=${id}&corners=${corners}`)).body);
        assert.deepEqual([c.width, c.height], [W, H]);
        const r = cornerRadius({ width: W, height: H }, corners);
        for (const [x, y] of [
          [0, 0],
          [W - 1, 0],
          [0, H - 1],
          [W - 1, H - 1],
        ] as const) {
          // Tiny radii leave an anti-aliased sliver in the very corner pixel; larger ones are fully clear.
          if (r >= 8) assert.equal(c.at(x, y)[3], 0, `corner (${x},${y}) transparent`);
          else if (r >= 3) assert.ok(c.at(x, y)[3] < 128, `corner (${x},${y}) mostly transparent (alpha ${c.at(x, y)[3]})`);
          else assert.ok(c.at(x, y)[3] < 255, `corner (${x},${y}) at least partly clipped (alpha ${c.at(x, y)[3]})`);
        }
        assert.equal(c.at(Math.floor(W / 2), Math.floor(H / 2))[3], 255, "centre opaque");
        // Along the diagonal from the top-left corner, the clipped length is r*(1-1/sqrt2).
        const cut = r * (1 - Math.SQRT1_2);
        const t = Math.max(0, Math.floor(cut) - 2),
          o = Math.ceil(cut) + 2;
        if (t >= 1) assert.ok(c.at(t, t)[3] < 128, `(${t},${t}) still clipped`);
        assert.ok(c.at(o, o)[3] > 128, `(${o},${o}) opaque`);
        // Edges midway stay opaque (only corners are rounded) - unless the radius reaches the
        // middle of that edge, where the midpoint is the arcs' tangent point.
        if (r < Math.floor(W / 2) - 1) assert.equal(c.at(Math.floor(W / 2), 0)[3], 255, "top edge midpoint opaque");
        if (r < Math.floor(H / 2) - 1) assert.equal(c.at(0, Math.floor(H / 2))[3], 255, "left edge midpoint opaque");
      });
    }

    test("corners=0 is byte-identical to no corners; corners apply after rotate+resize", async () => {
      assert.ok((await image(`image=${id}&corners=0`)).body.equals((await image(`image=${id}`)).body));
      const c = await pixels((await image(`image=${id}&rotate=90&width=200&corners=100`)).body);
      const h = Math.max(1, Math.round((200 * W) / H));
      assert.deepEqual([c.width, c.height], [200, h]);
      assert.equal(c.at(0, 0)[3], 0);
      assert.equal(c.at(100, Math.floor(h / 2))[3], 255);
    });
  });
}

describe("combinations and the page", () => {
  test("corners=100 on a square output is a circle", async () => {
    const c = await pixels((await image("image=photo&width=300&height=300&corners=100")).body);
    const r = 150;
    for (let deg = 0; deg < 360; deg += 30) {
      const a = (deg * Math.PI) / 180;
      const inX = Math.round(150 + (r - 4) * Math.cos(a)),
        inY = Math.round(150 + (r - 4) * Math.sin(a));
      const outX = Math.min(299, Math.max(0, Math.round(150 + (r + 3) * Math.cos(a)))),
        outY = Math.min(299, Math.max(0, Math.round(150 + (r + 3) * Math.sin(a))));
      assert.ok(c.at(inX, inY)[3] > 200, `inside at ${deg}deg`);
      if (deg % 90 !== 0) assert.ok(c.at(outX, outY)[3] < 60, `outside at ${deg}deg`);
    }
  });

  test("all three together with a watermark: grey pixels, corners clipped, mark present", async () => {
    const plain = await pixels((await image("grayscale=1&sharpen=1&corners=40")).body);
    const marked = await pixels((await image("grayscale=1&sharpen=1&corners=40&wm=1&wmWidth=25%")).body);
    assert.equal(marked.at(0, 0)[3], 0);
    assert.notDeepEqual(marked.data, plain.data, "watermark drawn");
    const p = marked.at(480, 320);
    assert.ok(p[0] === p[1] && p[1] === p[2], "still grey");
    // The corner mask is applied after the watermark: pixels inside the clipped corner region are transparent even where the mark would be.
    const r = cornerRadius({ width: 960, height: 640 }, 40);
    assert.ok(r === 128 && marked.at(959, 639)[3] === 0);
  });

  test("the mark keeps its colour on a grayscale image (composite runs after grayscale)", async () => {
    // The stock mark is near-white (#f6f5f1): on a grey base its pixels are not perfectly neutral.
    const m = await pixels((await image("grayscale=1&wm=1&wmWidth=400&wmOpacity=100&wmMargin=0")).body);
    let tinted = 0;
    for (let y = 640 - 36; y < 640; y++)
      for (let x = 960 - 400; x < 960; x++) {
        const p = m.at(x, y);
        if (p[0] !== p[1] || p[1] !== p[2]) tinted++;
      }
    assert.ok(tinted > 100, `${tinted} non-neutral pixels in the mark area`);
  });

  test("page: Enhance card, values echoed, only active params forwarded, context shows the radius", async () => {
    const html = await (await fetch(`${baseUrl}/?sharpen=1&grayscale=0&corners=25`)).text();
    assert.match(html, /<h2 id="h-enh">Enhance<\/h2>/);
    assert.match(html, /name="sharpen" value="1" form="settings" checked/);
    assert.doesNotMatch(html, /name="grayscale" value="1" form="settings" checked/);
    assert.match(html, /name="corners" form="settings" min="0" max="100" step="1" value="25"/);
    assert.match(html, /<img src="\/image\?sharpen=1&amp;corners=25"/, "grayscale=0 is not forwarded");
    assert.match(html, /Sharpen on &middot; Grayscale off &middot; Rounded corners 25 &rarr; 80 px radius/);
    const off = await (await fetch(`${baseUrl}/?corners=0`)).text();
    assert.match(off, /<img src="\/image"/);
    assert.match(off, /Square corners/);
  });

  test("page: toast when the rounded corners clip the watermark; none when the mark is clear of them", async () => {
    const clipped = await (await fetch(`${baseUrl}/?corners=60&wm=1&wmWidth=30%&wmMargin=4`)).text();
    assert.match(clipped, /<div class="toast"><span>The rounded corners \(radius 192 px\) clip part of the watermark\./);
    assert.match(clipped, /<img src="\/image\?corners=60&amp;wm=1&amp;wmWidth=30%25&amp;wmMargin=4"/, "image still rendered as requested");
    const clear = await (await fetch(`${baseUrl}/?corners=60&wm=1&wmWidth=30%&wmMargin=4&traverseX=-300&traverseY=-300`)).text();
    assert.doesNotMatch(clear, /clip part of the watermark/);
  });

  test("invalid enhance values -> 400 on /image, banner on the page, image still loads", async () => {
    for (const q of ["corners=101", "sharpen=yesplease", "grayscale=-1"]) {
      assert.equal((await image(q)).status, 400, q);
      const html = await (await fetch(`${baseUrl}/?${q}`)).text();
      assert.match(html, /<p class="error" role="alert">/);
      const src = /<img src="([^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") ?? "";
      assert.equal((await fetch(`${baseUrl}${src}`)).status, 200);
    }
  });
});
