/**
 * The whole pipeline across images of very different sizes, aspects and formats:
 * the sample plus the five stock images. Everything is derived from each image's
 * real dimensions, nothing is hard-coded to 960x640.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import {
  createApp,
  DEFAULT_WATERMARK_MARGIN,
  DEFAULT_WATERMARK_WIDTH,
  getNativeSizes,
  outputSize,
  parseImageOptions,
  traverseRange,
  watermarkSize,
} from "../src/app.ts";
import { listImages, SAMPLE_IMAGE, STOCK_IMAGES } from "../src/images.ts";

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

const EXPECTED: Record<string, { width: number; height: number; format: string }> = {
  sample: { width: 960, height: 640, format: "png" },
  thumb: { width: 320, height: 240, format: "png" },
  photo: { width: 1600, height: 1200, format: "jpeg" },
  fhd: { width: 1920, height: 1080, format: "jpeg" },
  portrait: { width: 1080, height: 1920, format: "webp" },
  panorama: { width: 4000, height: 1000, format: "png" },
};

async function fetchImage(query: string) {
  const r = await fetch(`${baseUrl}/image?${query}`);
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") };
}
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

async function pixels(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
function diffBox(a: Awaited<ReturnType<typeof pixels>>, b: Awaited<ReturnType<typeof pixels>>) {
  assert.deepEqual([a.width, a.height], [b.width, b.height]);
  let minX = Infinity,
    minY = Infinity,
    maxX = -1,
    maxY = -1;
  const w = a.width;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
      const p = i >> 2,
        x = p % w,
        y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

describe("stock image set", () => {
  test("sample + five stock images, varied sizes/aspects/formats, all decodable", async () => {
    const images = await listImages();
    assert.deepEqual(
      images.filter((i) => i.kind !== "upload").map((i) => i.id),
      ["sample", "thumb", "photo", "fhd", "portrait", "panorama"],
    );
    const aspects = new Set<string>();
    for (const source of [SAMPLE_IMAGE, ...STOCK_IMAGES]) {
      const m = await sharp(source.path).metadata();
      const e = EXPECTED[source.id]!;
      assert.deepEqual({ width: m.width, height: m.height, format: m.format }, e, source.id);
      aspects.add((e.width / e.height).toFixed(2));
    }
    assert.ok(aspects.size >= 5, `aspect ratios should vary: ${[...aspects].join(", ")}`);
    const widths = Object.values(EXPECTED).map((e) => e.width);
    assert.ok(Math.max(...widths) / Math.min(...widths) >= 10, "sizes span at least 10x");
    assert.equal(new Set(Object.values(EXPECTED).map((e) => e.format)).size, 3, "three formats");
  });
});

for (const source of [SAMPLE_IMAGE, ...STOCK_IMAGES]) {
  const { width: W, height: H } = EXPECTED[source.id]!;
  const id = source.id;

  describe(`image "${id}" (${W}x${H})`, () => {
    let plain: Awaited<ReturnType<typeof pixels>>;
    before(async () => {
      plain = await pixels((await fetchImage(`image=${id}`)).body);
    });

    test("native render: PNG at the image's own size", async () => {
      const r = await fetchImage(`image=${id}`);
      assert.equal(r.status, 200);
      assert.equal(r.type, "image/png");
      assert.deepEqual(pngSize(r.body), { width: W, height: H });
      assert.deepEqual((await getNativeSizes(id)).image, { width: W, height: H });
    });

    test("resize and rotate sizes follow the image's aspect", async () => {
      const cases = [`width=300`, `height=200`, `rotate=90`, `rotate=270&width=250`, `width=123&height=77`];
      for (const q of cases) {
        const options = parseImageOptions(new URLSearchParams(`image=${id}&${q}`));
        const expected = outputSize({ width: W, height: H }, options);
        const r = await fetchImage(`image=${id}&${q}`);
        assert.equal(r.status, 200, q);
        assert.deepEqual(pngSize(r.body), expected, q);
      }
    });

    test("watermark: default px size sits in the bottom-right corner", async () => {
      const marked = await pixels((await fetchImage(`image=${id}&wm=1`)).body);
      const native = await getNativeSizes(id);
      const mark = watermarkSize(native.mark, {}, { width: W, height: H });
      assert.equal(mark.width, DEFAULT_WATERMARK_WIDTH);
      const box = diffBox(plain, marked);
      assert.ok(box, "mark drew something");
      const left = W - DEFAULT_WATERMARK_MARGIN - mark.width,
        top = H - DEFAULT_WATERMARK_MARGIN - mark.height;
      assert.ok(
        box.minX >= left && box.minY >= top && box.maxX <= W - DEFAULT_WATERMARK_MARGIN - 1 && box.maxY <= H - DEFAULT_WATERMARK_MARGIN - 1,
        JSON.stringify(box),
      );
      assert.ok(box.maxX - box.minX + 1 >= mark.width - 4 && box.maxY - box.minY + 1 >= mark.height - 4, "fills the mark's box");
    });

    test("watermark: wmWidth=20% scales with this image", async () => {
      const marked = await pixels((await fetchImage(`image=${id}&wm=1&wmWidth=20%`)).body);
      const native = await getNativeSizes(id);
      const mark = watermarkSize(native.mark, { width: { percent: 20 } }, { width: W, height: H });
      assert.equal(mark.width, Math.round(W * 0.2));
      const box = diffBox(plain, marked)!;
      assert.ok(box, "mark drew something");
      const left = W - DEFAULT_WATERMARK_MARGIN - mark.width;
      assert.ok(box.minX >= left - 1 && box.maxX <= W - DEFAULT_WATERMARK_MARGIN - 1, `x range ${box.minX}..${box.maxX} vs ${left}..`);
      assert.ok(box.maxX - box.minX + 1 >= mark.width - Math.ceil(mark.width / 100) - 2, `width ~${mark.width}, got ${box.maxX - box.minX + 1}`);
    });

    test("watermark: % of the OUTPUT after rotate+resize", async () => {
      const q = `image=${id}&rotate=90&width=300&wm=1&wmWidth=50%&wmMargin=0`;
      const base = await pixels((await fetchImage(`image=${id}&rotate=90&width=300`)).body);
      const marked = await pixels((await fetchImage(q)).body);
      assert.deepEqual([marked.width, marked.height], [300, Math.max(1, Math.round((300 * W) / H))]);
      const box = diffBox(base, marked)!;
      assert.ok(box && box.maxX === 299 && box.minX >= 150 - 2, `50% of 300 -> starts near 150: ${JSON.stringify(box)}`);
    });

    test("traverse bounds and fit errors use this image's dimensions", async () => {
      const native = await getNativeSizes(id);
      const output = { width: W, height: H };
      const mark = watermarkSize(native.mark, { width: { percent: 10 } }, output);
      const range = traverseRange(output, mark, DEFAULT_WATERMARK_MARGIN);
      const ok = await fetchImage(`image=${id}&wm=1&wmWidth=10%&traverseX=${range.x[0]}&traverseY=${range.y[0]}`);
      assert.equal(ok.status, 200, "top-left corner reachable");
      const over = await fetchImage(`image=${id}&wm=1&wmWidth=10%&traverseX=${range.x[0] - 1}`);
      assert.equal(over.status, 400);
      assert.match(over.body.toString(), new RegExp(`1 px past the left edge of the ${W}x${H} image`));
      const tooBig = await fetchImage(`image=${id}&wm=1&wmWidth=100%`);
      assert.equal(tooBig.status, 400);
      assert.match(tooBig.body.toString(), new RegExp(`plus margin 16 does not fit inside the ${W}x${H} image`));
    });

    test("page: image selected, toast bounds, mobile preview frame, every emitted URL loads", async () => {
      const html = await (await fetch(`${baseUrl}/?image=${id}&wm=1&wmWidth=20%&traverseX=-4096&view=mobile&device=pixel-7`)).text();
      assert.match(html, new RegExp(`<option value="${id}"[^>]*selected`), "picker shows the image");
      const native = await getNativeSizes(id);
      const mark = watermarkSize(native.mark, { width: { percent: 20 } }, { width: W, height: H });
      const range = traverseRange({ width: W, height: H }, mark, DEFAULT_WATERMARK_MARGIN);
      assert.match(html, new RegExp(`allowed ${range.x[0]} to ${range.x[1]}`), "toast bounds from this image");
      const iframe = /<iframe[^>]*src="([^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
      assert.ok(iframe?.includes(`image=${id}`), "frame shows this image");
      const inner = await (await fetch(`${baseUrl}${iframe}`)).text();
      const img = /<img src="([^"]*)"/.exec(inner)?.[1]?.replace(/&amp;/g, "&") ?? "";
      const r = await fetch(`${baseUrl}${img}`);
      assert.equal(r.status, 200, img);
      assert.equal(r.headers.get("content-type"), "image/png");
    });
  });
}
