import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { createApp, exportFilename, fitToLimit, parseExportOptions } from "../src/app.ts";
import { SAMPLE_IMAGE, STOCK_IMAGES } from "../src/images.ts";
import { PRESETS } from "../src/presets.ts";

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

async function exp(query: string) {
  const r = await fetch(`${baseUrl}/export?${query}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  return {
    status: r.status,
    bytes,
    type: r.headers.get("content-type"),
    disposition: r.headers.get("content-disposition"),
    quality: r.headers.get("x-export-quality"),
    warning: r.headers.get("x-export-warning"),
    text: bytes.toString("utf8"),
  };
}
const magic = (b: Buffer) =>
  b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ? "png"
    : b[0] === 0xff && b[1] === 0xd8
      ? "jpeg"
      : b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP"
        ? "webp"
        : "?";

describe("encoding", () => {
  test("PNG / JPEG / WebP: magic bytes, content type, attachment filename, quality header", async () => {
    for (const [format, ext] of [
      ["png", "png"],
      ["jpeg", "jpg"],
      ["webp", "webp"],
    ] as const) {
      const r = await exp(`image=photo&format=${format}`);
      assert.equal(r.status, 200, format);
      assert.equal(magic(r.bytes), format);
      assert.equal(r.type, `image/${format}`);
      assert.equal(r.disposition, `attachment; filename="photo-1600x1200.${ext}"`);
      assert.equal(r.quality, format === "png" ? null : "82");
      const m = await sharp(r.bytes).metadata();
      assert.deepEqual([m.width, m.height], [1600, 1200]);
    }
  });

  test("default format is PNG and equals the preview pixels", async () => {
    const e = await exp("image=thumb&wm=1");
    const preview = Buffer.from(await (await fetch(`${baseUrl}/image?image=thumb&wm=1`)).arrayBuffer());
    assert.equal(magic(e.bytes), "png");
    assert.ok(e.bytes.equals(preview));
  });

  test("quality is monotonic for JPEG and WebP; PNG ignores it", async () => {
    for (const format of ["jpeg", "webp"] as const) {
      const sizes = [];
      for (const q of [50, 82, 95]) sizes.push((await exp(`image=photo&format=${format}&quality=${q}`)).bytes.length);
      assert.ok(sizes[0]! < sizes[1]! && sizes[1]! < sizes[2]!, `${format}: ${sizes.join(" < ")}`);
    }
    const a = await exp("image=thumb&format=png&quality=10"),
      b = await exp("image=thumb&format=png&quality=100");
    assert.ok(a.bytes.equals(b.bytes));
  });

  test("metadata is stripped from the download (no EXIF)", async () => {
    const r = await exp("image=photo&format=jpeg");
    const m = await sharp(r.bytes).metadata();
    assert.equal(m.exif, undefined);
    assert.equal(m.icc, undefined);
  });

  test("JPEG flattens transparent corners onto bg; PNG and WebP keep the alpha", async () => {
    const jpg = await sharp((await exp("image=thumb&format=jpeg&corners=50&bg=%23ff0000")).bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(jpg.info.channels, 3);
    const [r, g, b] = [jpg.data[0]!, jpg.data[1]!, jpg.data[2]!];
    assert.ok(r > 200 && g < 60 && b < 60, `corner is red: ${r},${g},${b}`);
    for (const format of ["png", "webp"] as const) {
      const px = await sharp((await exp(`image=thumb&format=${format}&corners=50`)).bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.equal(px.data[3], 0, `${format} corner transparent`);
    }
  });

  test("HEAD /export returns headers only", async () => {
    const r = await fetch(`${baseUrl}/export?image=thumb&format=webp`, { method: "HEAD" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/webp");
    assert.match(r.headers.get("content-disposition") ?? "", /thumb-320x240\.webp/);
    assert.equal((await r.arrayBuffer()).byteLength, 0);
  });
});

describe("presets", () => {
  test("10 presets, 6 platforms, plausible sizes", () => {
    assert.equal(PRESETS.length, 10);
    assert.equal(new Set(PRESETS.map((p) => p.platform)).size, 6);
    assert.equal(new Set(PRESETS.map((p) => p.id)).size, 10);
    for (const p of PRESETS) assert.ok(p.width >= 500 && p.height >= 500 && p.width <= 2000 && p.height <= 2000, p.id);
  });

  // Fast tier: every preset once and every image at least once (10 renders). Full tier
  // (SHARP_VIEWER_TEST_FULL=1, `npm run test:full`): the whole 6 x 10 matrix (60 renders).
  const images = [SAMPLE_IMAGE, ...STOCK_IMAGES];
  const full = process.env.SHARP_VIEWER_TEST_FULL === "1";
  const pairs = full ? images.flatMap((source) => PRESETS.map((p) => [source, p] as const)) : PRESETS.map((p, i) => [images[i % images.length]!, p] as const);
  test(`${full ? "every image x every preset" : "each preset once across the images"} renders exactly the preset size, and the % watermark tracks it (${pairs.length} renders)`, async () => {
    for (const [source, p] of pairs) {
      const r = await exp(`image=${source.id}&preset=${p.id}&format=jpeg&quality=40&wm=1&wmWidth=25%`);
      assert.equal(r.status, 200, `${source.id} ${p.id}`);
      const m = await sharp(r.bytes).metadata();
      assert.deepEqual([m.width, m.height], [p.width, p.height], `${source.id} ${p.id}`);
      assert.equal(r.disposition, `attachment; filename="${source.label.replace(/\.[a-z]+$/, "")}-${p.id}-${p.width}x${p.height}-wm.jpg"`);
    }
  });

  test("cover fills the frame (no padding), contain pads with bg and keeps the whole image", async () => {
    // panorama 4000x1000 -> square 1080x1080
    const cover = await sharp((await exp("image=panorama&preset=ig-square&fit=cover&format=png")).bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const contain = await sharp((await exp("image=panorama&preset=ig-square&fit=contain&bg=%2300ff00&format=png")).bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = (d: typeof cover, x: number, y: number) => [
      d.data[(y * 1080 + x) * d.info.channels]!,
      d.data[(y * 1080 + x) * d.info.channels + 1]!,
      d.data[(y * 1080 + x) * d.info.channels + 2]!,
    ];
    // cover: top-left pixel is image content (sky gradient: blue-ish), not a pad colour
    const c = px(cover, 0, 0);
    assert.ok(!(c[0] === 0 && c[1] === 255 && c[2] === 0));
    // contain: top-left is the green pad, centre row has image content; the image spans full width
    assert.deepEqual(px(contain, 0, 0), [0, 255, 0]);
    assert.deepEqual(px(contain, 540, 100), [0, 255, 0]);
    const mid = px(contain, 540, 540);
    assert.ok(!(mid[0] === 0 && mid[1] === 255 && mid[2] === 0), "centre is image");
    // the padded band height = (1080 - 1080/4) / 2 = 405: row 404 pad, row 406 image
    assert.deepEqual(px(contain, 540, 404), [0, 255, 0]);
    assert.ok(!(px(contain, 540, 406)[1] === 255 && px(contain, 540, 406)[0] === 0));
  });

  test("cover uses the attention strategy: the umbrella (subject) survives the story crop of the beach photo", async () => {
    const r = await exp("image=photo&preset=ig-story&fit=cover&format=png");
    const { data, info } = await sharp(r.bytes).raw().toBuffer({ resolveWithObject: true });
    let red = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i]! > 200 && data[i + 1]! < 90 && data[i + 2]! < 90) red++;
    assert.ok(red > 2000, `red umbrella pixels present: ${red}`);
  });

  test("preset overrides width/height and rotate is applied before the fit", async () => {
    const r = await exp("image=portrait&preset=x-header&width=50&height=50&rotate=90&format=png");
    const m = await sharp(r.bytes).metadata();
    assert.deepEqual([m.width, m.height], [1500, 500]);
  });
});

describe("file-size target", () => {
  test("maxKB: result fits and uses the highest quality that fits", async () => {
    const r = await exp("image=photo&preset=ig-square&format=jpeg&maxKB=60");
    assert.equal(r.status, 200);
    assert.ok(r.bytes.length <= 60 * 1024, `${r.bytes.length} bytes`);
    const q = Number(r.quality);
    assert.ok(q >= 30 && q < 82, `quality ${q}`);
    assert.equal(r.warning, null);
    // one step higher would not fit
    const next = await exp(`image=photo&preset=ig-square&format=jpeg&quality=${q + 1}`);
    assert.ok(next.bytes.length > 60 * 1024, "q+1 exceeds the limit");
  });

  test("maxKB already satisfied: requested quality kept unchanged", async () => {
    const r = await exp("image=thumb&format=webp&quality=60&maxKB=500");
    assert.equal(r.quality, "60");
    assert.equal(r.warning, null);
  });

  test("unreachable maxKB: delivered at quality 30 with a warning header", async () => {
    const r = await exp("image=photo&preset=ig-square&format=jpeg&maxKB=5");
    assert.equal(r.status, 200);
    assert.equal(r.quality, "30");
    assert.match(r.warning ?? "", /Could not get under 5 KB: even quality 30 is \d+ KB/);
  });

  test("B2: requested quality below the search floor -> the requested encode is delivered, never a bigger one", async () => {
    const plain = await exp("image=photo&preset=ig-square&format=jpeg&quality=10");
    const r = await exp("image=photo&preset=ig-square&format=jpeg&quality=10&maxKB=10");
    assert.equal(r.status, 200);
    assert.equal(r.quality, "10");
    assert.equal(r.bytes.length, plain.bytes.length, "same file as quality=10 without maxKB");
    assert.match(r.warning ?? "", /Could not get under 10 KB: even quality 10 is \d+ KB/);
  });

  test("B2/B8 fitToLimit: highest fitting quality, no duplicate encodes, floor = min(30, requested)", async () => {
    const calls: number[] = [];
    const enc = async (q: number) => {
      calls.push(q);
      return Buffer.alloc(q * 1000);
    };
    const fit = await fitToLimit(enc, 82, 61_440);
    assert.equal(fit.quality, 61);
    assert.equal(fit.bytes.length, 61_000);
    assert.equal(fit.reached, true);
    assert.ok(calls.length <= 8, `${calls.length} encodes`);
    assert.equal(new Set(calls).size, calls.length, "each quality encoded at most once");

    calls.length = 0;
    const miss = await fitToLimit(enc, 82, 1000);
    assert.equal(miss.quality, 30);
    assert.equal(miss.reached, false);
    assert.equal(new Set(calls).size, calls.length, "B8: the floor is not encoded twice");

    calls.length = 0;
    const low = await fitToLimit(enc, 10, 5000);
    assert.deepEqual(calls, [10], "nothing below the requested quality is tried");
    assert.equal(low.quality, 10);
    assert.equal(low.reached, false);

    calls.length = 0;
    const none = await fitToLimit(enc, 50, undefined);
    assert.deepEqual([none.quality, none.reached, calls], [50, true, [50]]);
  });

  test("maxKB with PNG -> 400", async () => {
    const r = await exp("image=thumb&format=png&maxKB=100");
    assert.equal(r.status, 400);
    assert.match(r.text, /maxKB applies to JPEG and WebP only/);
  });
});

describe("validation and filenames", () => {
  for (const [q, re] of [
    ["preset=nope", /Unknown preset "nope"\. Known presets: ig-square, ig-portrait/],
    ["fit=stretch", /fit must be one of cover, contain/],
    ["bg=red", /bg must be a hex colour like #ffffff/],
    ["format=gif", /format must be one of png, jpeg, webp/],
    ["quality=0", /quality must be an integer between 1 and 100/],
    ["format=jpeg&maxKB=0", /maxKB must be an integer between 1 and 50000/],
    ["image=nope", /Unknown image/],
  ] as Array<[string, RegExp]>) {
    test(`${q} -> 400`, async () => {
      const r = await exp(q);
      assert.equal(r.status, 400);
      assert.match(r.text, re);
    });
  }

  test("exportFilename", () => {
    const o = parseExportOptions(new URLSearchParams("image=photo&preset=ig-square&format=jpeg&grayscale=1&wm=1"));
    assert.equal(exportFilename(o, { width: 1080, height: 1080 }, "My Holiday Photo.JPG"), "my-holiday-photo-ig-square-1080x1080-grey-wm.jpg");
    const p = parseExportOptions(new URLSearchParams("format=webp"));
    assert.equal(exportFilename(p, { width: 960, height: 640 }, "sample.png"), "sample-960x640.webp");
    assert.equal(exportFilename(p, { width: 1, height: 1 }, "!!!"), "image-1x1.webp");
  });
});

describe("page: Export card", () => {
  test("values echoed, preset applied to the preview, Download link carries everything, context line", async () => {
    const html = await (
      await fetch(`${baseUrl}/?image=thumb&preset=ig-square&fit=contain&bg=%23ff0000&format=jpeg&quality=70&maxKB=200&wm=1&wmWidth=20%`)
    ).text();
    assert.match(html, /<h2 id="h-exp">Export<\/h2>/);
    assert.match(html, /<option value="ig-square" selected>/);
    assert.match(html, /<option value="contain" selected>/);
    assert.match(html, /name="bg" form="settings" value="#ff0000"/);
    assert.match(html, /<option value="jpeg" selected>/);
    assert.match(html, /name="quality"[^>]*value="70"/);
    assert.match(html, /name="maxKB"[^>]*value="200"/);
    assert.match(
      html,
      /<img src="\/image\?image=thumb&amp;preset=ig-square&amp;fit=contain&amp;bg=%23ff0000&amp;wm=1&amp;wmWidth=20%25"/,
      "preview uses the preset, not the export params",
    );
    assert.match(
      html,
      /href="\/export\?image=thumb&amp;preset=ig-square&amp;fit=contain&amp;bg=%23ff0000&amp;wm=1&amp;wmWidth=20%25&amp;format=jpeg&amp;quality=70&amp;maxKB=200"\s+download/,
    );
    assert.match(html, /ig-square &middot; 1080&times;1080 &middot; contain &middot; JPEG q70 &middot; &le; 200 KB &middot; upscaled from 320&times;240/);
    const href = /href="(\/export[^"]*)"/.exec(html)![1]!.replace(/&amp;/g, "&");
    const dl = await fetch(`${baseUrl}${href}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), "image/jpeg");
  });

  test("no preset: context shows the output size and PNG; width/height from the Output card apply", async () => {
    const html = await (await fetch(`${baseUrl}/?width=480`)).text();
    assert.match(html, /<option value="none" selected>/);
    assert.match(html, /class="context">480&times;320 &middot; PNG</);
    assert.match(html, /href="\/export\?width=480&amp;format=png"|href="\/export\?width=480"/);
  });

  test("preset set: width/height are dropped from the image URL (preset wins)", async () => {
    const html = await (await fetch(`${baseUrl}/?image=photo&preset=fb-post&width=50&height=50`)).text();
    assert.match(html, /<img src="\/image\?image=photo&amp;preset=fb-post"/);
  });

  test("invalid export params -> error shown, image still loads, Download disabled", async () => {
    for (const q of ["format=png&maxKB=100", "preset=nope", "quality=101", "bg=blue"]) {
      const html = await (await fetch(`${baseUrl}/?image=thumb&${q}`)).text();
      assert.match(html, /<p class="error" role="alert">/, q);
      assert.match(html, /class="button-link" href="" aria-disabled="true"/, q);
      const src = /<img src="([^"]*)"/.exec(html)![1]!.replace(/&amp;/g, "&");
      assert.equal((await fetch(`${baseUrl}${src}`)).status, 200, q);
    }
  });

  test("B4: an export-only error (format/quality/maxKB) stays in the Export card; the preview keeps its settings", async () => {
    for (const q of ["format=png&maxKB=50", "quality=101", "format=bmp"]) {
      const html = await (await fetch(`${baseUrl}/?image=photo&wm=1&wmWidth=20%25&dp=360&${q}`)).text();
      const header = html.slice(0, html.indexOf('<div class="preview">'));
      assert.doesNotMatch(header, /<p class="error"/, `${q}: no banner under the header`);
      const exportCard = html.slice(html.indexOf('<h2 id="h-exp">'), html.indexOf('<h2 id="h-and">'));
      assert.match(exportCard, /<p class="error" role="alert">[^<]+<\/p>/, `${q}: error inside the Export card`);
      assert.match(exportCard, /Fix the export settings to enable the download/, q);
      assert.match(exportCard, /class="button-link" href="" aria-disabled="true" download>Download</, q);
      assert.match(html, /<img src="\/image\?image=photo&amp;wm=1&amp;wmWidth=20%25"/, `${q}: preview unaffected`);
      assert.match(html, /href="\/android\.zip\?image=photo&amp;wm=1&amp;wmWidth=20%25&amp;dp=360"\s+download>Download ZIP/, `${q}: Android card unaffected`);
    }
    // Image-level errors (preset, bg, fit) still use the banner and the plain fallback image.
    const banner = await (await fetch(`${baseUrl}/?image=photo&preset=nope`)).text();
    assert.match(banner.slice(0, banner.indexOf('<div class="preview">')), /<p class="error" role="alert">Unknown preset/);
    assert.match(banner, /<img src="\/image"/);
  });

  test("every preset page renders and its preview + download URLs load", async () => {
    for (const p of PRESETS) {
      const html = await (await fetch(`${baseUrl}/?image=fhd&preset=${p.id}&wm=1&format=webp&quality=40`)).text();
      const src = /<img src="([^"]*)"/.exec(html)![1]!.replace(/&amp;/g, "&");
      const href = /href="(\/export[^"]*)"/.exec(html)![1]!.replace(/&amp;/g, "&");
      const [img, dl] = await Promise.all([fetch(`${baseUrl}${src}`), fetch(`${baseUrl}${href}`)]);
      assert.equal(img.status, 200, p.id);
      assert.equal(dl.status, 200, p.id);
      const m = await sharp(Buffer.from(await dl.arrayBuffer())).metadata();
      assert.deepEqual([m.width, m.height, m.format], [p.width, p.height, "webp"], p.id);
    }
  });
});
