import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { createApp, DEFAULT_WATERMARK_MARGIN, DEFAULT_WATERMARK_WIDTH, pipelineStats, placeWatermark } from "../src/app.ts";

// Stock watermark (public/watermark.svg): glyph outlines (no font dependency) on a canvas
// cropped to the painted pixels. Read its native size from the file so the tests track it.
const WM_SVG = readFileSync(new URL("../public/watermark.svg", import.meta.url), "utf8");
const WM_NATIVE_W = Number(/\bwidth="(\d+)"/.exec(WM_SVG)?.[1]);
const WM_NATIVE_H = Number(/\bheight="(\d+)"/.exec(WM_SVG)?.[1]);
const WM_ASPECT = WM_NATIVE_W / WM_NATIVE_H;
const IMG_W = 960;
const IMG_H = 640;

let baseUrl: string;
const server = createApp();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Node's runner can run `after` before `before` finishes when a --test-name-pattern matches
  // nothing in this file; unref so an unclosed server can never keep the process alive.
  server.unref();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  // With a non-matching --test-name-pattern this may run before the server is listening.
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

async function get(query: string) {
  const response = await fetch(`${baseUrl}/image${query}`);
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()), text: "" };
}

async function getText(query: string) {
  const response = await fetch(`${baseUrl}/image${query}`);
  return { status: response.status, text: await response.text() };
}

// sharp is used only to decode PNGs to raw pixels for comparison.
async function pixels(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Bounding box of pixels that differ between two same-sized images, or null if identical. */
function diffBox(a: Awaited<ReturnType<typeof pixels>>, b: Awaited<ReturnType<typeof pixels>>) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let minX = Infinity,
    minY = Infinity,
    maxX = -1,
    maxY = -1,
    count = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return count === 0 ? null : { minX, minY, maxX, maxY, count };
}

/** Assert the changed region sits exactly in the expected bottom-right box (allowing antialiased edges). */
function assertBottomRight(box: ReturnType<typeof diffBox>, imgW: number, imgH: number, wmW: number, wmH: number, margin: number, tx = 0, ty = 0) {
  assert.ok(box, "watermark should change some pixels");
  const left = imgW - margin - wmW + tx,
    top = imgH - margin - wmH + ty,
    right = left + wmW - 1,
    bottom = top + wmH - 1;
  assert.ok(
    box.minX >= left && box.minY >= top && box.maxX <= right && box.maxY <= bottom,
    `changed box ${JSON.stringify(box)} must lie within [${left},${top}]-[${right},${bottom}]`,
  );
  // The canvas is cropped to the painted glyphs, so only antialiasing at the edges (~1% + 2px) is tolerated.
  const slackW = Math.ceil(wmW / 100) + 2;
  const slackH = Math.ceil(wmH / 100) + 2;
  assert.ok(box.maxX - box.minX + 1 >= wmW - slackW, `changed width ${box.maxX - box.minX + 1} ~ ${wmW}`);
  assert.ok(box.maxY - box.minY + 1 >= wmH - slackH, `changed height ${box.maxY - box.minY + 1} ~ ${wmH}`);
}

describe("watermark: placement and size", () => {
  let plain: Awaited<ReturnType<typeof pixels>>;
  before(async () => {
    plain = await pixels((await get("")).body);
  });

  test("stock watermark is font-independent (paths only) and its canvas is tight", async () => {
    assert.ok(Number.isInteger(WM_NATIVE_W) && Number.isInteger(WM_NATIVE_H), "integer canvas size");
    assert.doesNotMatch(WM_SVG, /<text/, "must not depend on server fonts");
    assert.match(WM_SVG, /<path /);
    const { data, info } = await sharp(Buffer.from(WM_SVG)).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [WM_NATIVE_W, WM_NATIVE_H]);
    const painted = { minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 };
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3]! > 0) {
          painted.minX = Math.min(painted.minX, x);
          painted.maxX = Math.max(painted.maxX, x);
          painted.minY = Math.min(painted.minY, y);
          painted.maxY = Math.max(painted.maxY, y);
        }
      }
    assert.ok(painted.minX <= 1 && painted.minY <= 1, "painted pixels start at the canvas edge");
    assert.ok(painted.maxX >= info.width - 2 && painted.maxY >= info.height - 2, "painted pixels reach the far edges");
  });

  test("wm=1 keeps the image size and draws only in the bottom-right box (default size)", async () => {
    const { status, body } = await get("?wm=1");
    assert.equal(status, 200);
    const marked = await pixels(body);
    assert.deepEqual([marked.width, marked.height], [IMG_W, IMG_H]);
    const wmH = Math.round(DEFAULT_WATERMARK_WIDTH / WM_ASPECT);
    assertBottomRight(diffBox(plain, marked), IMG_W, IMG_H, DEFAULT_WATERMARK_WIDTH, wmH, DEFAULT_WATERMARK_MARGIN);
  });

  for (const w of [100, 300, 600]) {
    test(`wmWidth=${w} keeps the watermark aspect ratio`, async () => {
      const marked = await pixels((await get(`?wm=1&wmWidth=${w}`)).body);
      assertBottomRight(diffBox(plain, marked), IMG_W, IMG_H, w, Math.round(w / WM_ASPECT), DEFAULT_WATERMARK_MARGIN);
    });
  }

  for (const h of [20, WM_NATIVE_H, 60]) {
    test(`wmHeight=${h} keeps the watermark aspect ratio`, async () => {
      const marked = await pixels((await get(`?wm=1&wmHeight=${h}`)).body);
      assertBottomRight(diffBox(plain, marked), IMG_W, IMG_H, Math.round(h * WM_ASPECT), h, DEFAULT_WATERMARK_MARGIN);
    });
  }

  test("wmWidth + wmHeight gives the exact box requested", async () => {
    const marked = await pixels((await get("?wm=1&wmWidth=250&wmHeight=120")).body);
    assertBottomRight(diffBox(plain, marked), IMG_W, IMG_H, 250, 120, DEFAULT_WATERMARK_MARGIN);
  });

  test("wmMargin moves the box; margin 0 touches the corner", async () => {
    const m50 = await pixels((await get("?wm=1&wmWidth=200&wmMargin=50")).body);
    assertBottomRight(diffBox(plain, m50), IMG_W, IMG_H, 200, Math.round(200 / WM_ASPECT), 50);
    const m0 = await pixels((await get("?wm=1&wmWidth=200&wmMargin=0")).body);
    const box = diffBox(plain, m0);
    assertBottomRight(box, IMG_W, IMG_H, 200, Math.round(200 / WM_ASPECT), 0);
    assert.ok(box!.maxX >= IMG_W - 2, `reaches right edge: ${box!.maxX}`);
    assert.ok(box!.maxY >= IMG_H - 2, `reaches bottom edge: ${box!.maxY}`);
  });

  test("watermark is applied after rotate/resize, bottom-right of the final image", async () => {
    const base = await pixels((await get("?rotate=90&width=320")).body);
    const marked = await pixels((await get("?rotate=90&width=320&wm=1&wmWidth=100&wmMargin=8")).body);
    assert.deepEqual([marked.width, marked.height], [320, 480]);
    assertBottomRight(diffBox(base, marked), 320, 480, 100, Math.round(100 / WM_ASPECT), 8);
  });

  test("wm=0 / wm=off / omitted are identical to no watermark", async () => {
    for (const q of ["?wm=0", "?wm=off", "?wm="]) {
      assert.equal(diffBox(plain, await pixels((await get(q)).body)), null, q);
    }
  });
});

describe("watermark: traverse (px, +X right, +Y down)", () => {
  const W = 200;
  const H = Math.round(W / WM_ASPECT);
  let plain: Awaited<ReturnType<typeof pixels>>;
  before(async () => {
    plain = await pixels((await get("")).body);
  });

  test("traverseX=0&traverseY=0 is identical to no traverse", async () => {
    const a = (await get("?wm=1&wmWidth=200")).body;
    const b = (await get("?wm=1&wmWidth=200&traverseX=0&traverseY=0")).body;
    assert.ok(a.equals(b));
  });

  const moves: Array<[number, number, string]> = [
    [-100, 0, "left"],
    [0, -50, "up"],
    [-100, -50, "up-left"],
    [-300, -200, "further up-left"],
    [10, 0, "right (into the margin)"],
    [0, 10, "down (into the margin)"],
    [16, 16, "right+down to the exact corner (margin consumed)"],
  ];
  for (const [tx, ty, label] of moves) {
    test(`traverseX=${tx}&traverseY=${ty} moves the mark ${label}`, async () => {
      const marked = await pixels((await get(`?wm=1&wmWidth=${W}&traverseX=${tx}&traverseY=${ty}`)).body);
      assertBottomRight(diffBox(plain, marked), IMG_W, IMG_H, W, H, DEFAULT_WATERMARK_MARGIN, tx, ty);
    });
  }

  test("can reach the top-left corner exactly", async () => {
    const tx = -(IMG_W - W - DEFAULT_WATERMARK_MARGIN);
    const ty = -(IMG_H - H - DEFAULT_WATERMARK_MARGIN);
    const marked = await pixels((await get(`?wm=1&wmWidth=${W}&traverseX=${tx}&traverseY=${ty}`)).body);
    const box = diffBox(plain, marked);
    assertBottomRight(box, IMG_W, IMG_H, W, H, DEFAULT_WATERMARK_MARGIN, tx, ty);
    assert.ok(box!.minX <= 1 && box!.minY <= 1, `touches top-left: ${JSON.stringify(box)}`);
  });

  test("traverse stacks with wmMargin", async () => {
    const marked = await pixels((await get(`?wm=1&wmWidth=${W}&wmMargin=40&traverseX=-60&traverseY=-30`)).body);
    assertBottomRight(diffBox(plain, marked), IMG_W, IMG_H, W, H, 40, -60, -30);
  });

  test("traverse applies to the final (rotated + resized) output", async () => {
    const base = await pixels((await get("?rotate=90&width=320")).body);
    const marked = await pixels((await get("?rotate=90&width=320&wm=1&wmWidth=100&traverseX=-50&traverseY=-400")).body);
    assertBottomRight(diffBox(base, marked), 320, 480, 100, Math.round(100 / WM_ASPECT), DEFAULT_WATERMARK_MARGIN, -50, -400);
  });

  const rejects: Array<[string, RegExp]> = [
    [`?wm=1&wmWidth=200&traverseX=${-(IMG_W - W - DEFAULT_WATERMARK_MARGIN) - 1}`, /1 px past the left edge/],
    ["?wm=1&wmWidth=200&traverseX=17", /1 px past the right edge/],
    [`?wm=1&wmWidth=200&traverseY=${-(IMG_H - H - DEFAULT_WATERMARK_MARGIN) - 1}`, /1 px past the top edge/],
    ["?wm=1&wmWidth=200&traverseY=17", /1 px past the bottom edge/],
    ["?wm=1&wmWidth=200&traverseX=-800&traverseY=20", /56 px past the left edge and 4 px past the bottom edge/],
    ["?wm=1&traverseX=1.5", /traverseX must be an integer between -4096 and 4096/],
    ["?wm=1&traverseY=abc", /traverseY must be an integer between -4096 and 4096/],
    ["?wm=1&traverseX=-4097", /traverseX must be an integer between -4096 and 4096/],
    ["?wm=1&traverseY=4097", /traverseY must be an integer between -4096 and 4096/],
  ];
  for (const [q, re] of rejects) {
    test(`${q} -> 400`, async () => {
      const { status, text } = await getText(q);
      assert.equal(status, 400, text);
      assert.match(text, re);
    });
  }

  test("traverse params are ignored when the watermark is off", async () => {
    const { status, body } = await get("?traverseX=-9999&traverseY=abc");
    assert.equal(status, 200);
    assert.equal(diffBox(plain, await pixels(body)), null);
  });
});

describe("placeWatermark (unit)", () => {
  const out = { width: 960, height: 640 };
  const mark = { width: 200, height: 18 };
  test("anchor is bottom-right inset by margin", () => {
    assert.deepEqual(placeWatermark(out, mark, { margin: 16, traverseX: 0, traverseY: 0 }), { left: 744, top: 606 });
  });
  test("screen convention: +X right, +Y down", () => {
    assert.deepEqual(placeWatermark(out, mark, { margin: 16, traverseX: -100, traverseY: -50 }), { left: 644, top: 556 });
    assert.deepEqual(placeWatermark(out, mark, { margin: 16, traverseX: 16, traverseY: 16 }), { left: 760, top: 622 });
  });
  test("throws with the overshoot amount", () => {
    assert.throws(() => placeWatermark(out, mark, { margin: 16, traverseX: -745, traverseY: 0 }), /1 px past the left edge/);
    assert.throws(() => placeWatermark(out, mark, { margin: 16, traverseX: 0, traverseY: 17 }), /1 px past the bottom edge/);
  });
});

describe("watermark: opacity", () => {
  test("wmOpacity=0 leaves the image pixel-identical", async () => {
    const plain = await pixels((await get("")).body);
    const zero = await pixels((await get("?wm=1&wmOpacity=0")).body);
    assert.equal(diffBox(plain, zero), null);
  });

  test("higher opacity changes the pixels more", async () => {
    const plain = await pixels((await get("")).body);
    const strength = async (opacity: number) => {
      const marked = await pixels((await get(`?wm=1&wmWidth=200&wmOpacity=${opacity}`)).body);
      let sum = 0;
      for (let i = 0; i < plain.data.length; i += 4) {
        sum +=
          Math.abs(plain.data[i]! - marked.data[i]!) + Math.abs(plain.data[i + 1]! - marked.data[i + 1]!) + Math.abs(plain.data[i + 2]! - marked.data[i + 2]!);
      }
      return sum;
    };
    const [s25, s50, s100] = await Promise.all([strength(25), strength(50), strength(100)]);
    assert.ok(s25 > 0 && s25 < s50 && s50 < s100, `expected 0 < ${s25} < ${s50} < ${s100}`);
  });
});

describe("watermark: validation (400)", () => {
  const cases: Array<[string, RegExp]> = [
    ["?wm=1&wmWidth=960", /does not fit/],
    ["?wm=1&wmHeight=100", /does not fit/], // 100 high -> ~1100 wide
    ["?wm=1&wmWidth=100&wmMargin=900", /does not fit/],
    ["?wm=1&wmWidth=0", /wmWidth must be an integer between 1 and 4096 \(px\), or a percentage/],
    ["?wm=1&wmHeight=abc", /wmHeight must be an integer/],
    ["?wm=1&wmMargin=-1", /wmMargin must be an integer between 0 and 4096/],
    ["?wm=1&wmOpacity=101", /wmOpacity must be an integer between 0 and 100/],
    ["?wm=1&wmOpacity=1.5", /wmOpacity must be an integer/],
    ["?wm=maybe", /wm must be one of/],
  ];
  for (const [q, re] of cases) {
    test(`${q} -> 400`, async () => {
      const { status, text } = await getText(q);
      assert.equal(status, 400, text);
      assert.match(text, re);
    });
  }

  test("exact fit is accepted: 944 wide + 16 margin = 960", async () => {
    const { status } = await get("?wm=1&wmWidth=944&wmHeight=100");
    assert.equal(status, 200);
  });

  test("one pixel over is rejected: 945 wide + 16 margin", async () => {
    const { status, text } = await getText("?wm=1&wmWidth=945&wmHeight=100");
    assert.equal(status, 400);
    assert.match(text, /Watermark 945x100 plus margin 16 does not fit inside the 960x640 image/);
  });
});

describe("A7: placement is validated before any pixels are rendered", () => {
  test("a mark that cannot fit or would leave the image is rejected with zero stage-1 renders", async () => {
    const before = pipelineStats.stage1Renders;
    for (const q of ["wm=1&wmWidth=960", "wm=1&wmWidth=200&traverseX=-745", "image=thumb&wm=1&wmWidth=100%", "wm=1&wmWidth=200&traverseY=17"]) {
      const r = await fetch(`${baseUrl}/image?${q}`);
      assert.equal(r.status, 400, q);
    }
    assert.equal(pipelineStats.stage1Renders, before, "no pipeline ran for rejected placements");
    const ok = await fetch(`${baseUrl}/image?wm=1&wmWidth=199&wmOpacity=71`); // unique query: not served from the render cache
    assert.equal(ok.status, 200);
    assert.equal(pipelineStats.stage1Renders, before + 1, "a valid watermark render runs stage 1 once");
  });
});

describe("viewer page form", () => {
  test("GET / contains the watermark preview form with all fields", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.match(html, /<form id="settings" method="get" action="\/"/);
    for (const name of ["wm", "wmWidth", "wmHeight", "wmMargin", "wmOpacity", "traverseX", "traverseY", "width", "height", "rotate"]) {
      assert.match(html, new RegExp(`name="${name}"`), name);
    }
    assert.match(html, /<img src="\/image"/);
    assert.doesNotMatch(html, /\{\{\w+\}\}/, "no unreplaced template placeholders");
  });

  test("form values are forwarded to the image and echoed back", async () => {
    const html = await (await fetch(`${baseUrl}/?wm=1&wmWidth=300&wmOpacity=90&rotate=180&width=`)).text();
    assert.match(html, /<img src="\/image\?rotate=180&amp;wm=1&amp;wmWidth=300&amp;wmOpacity=90"/);
    assert.match(html, /name="wm" value="1" form="settings" checked/);
    assert.match(html, /name="wmWidth"[^>]*value="300"/);
    assert.match(html, /name="wmOpacity"[^>]*value="90"/);
    assert.match(html, /<option value="180" selected>/);
  });

  test("negative traverse values are forwarded and echoed", async () => {
    const html = await (await fetch(`${baseUrl}/?wm=1&traverseX=-100&traverseY=-50`)).text();
    assert.match(html, /<img src="\/image\?wm=1&amp;traverseX=-100&amp;traverseY=-50"/);
    assert.match(html, /name="traverseX"[^>]*value="-100"/);
    assert.match(html, /name="traverseY"[^>]*value="-50"/);
  });

  test("invalid values show an error and fall back to the plain image", async () => {
    const html = await (await fetch(`${baseUrl}/?wm=1&wmWidth=5000`)).text();
    assert.match(
      html,
      /<p class="error" role="alert">wmWidth must be an integer between 1 and 4096 \(px\), or a percentage between 1 and 100 \(e\.g\. 20%\)\.<\/p>/,
    );
    assert.match(html, /<img src="\/image"/);
  });

  test("values are HTML-escaped in the page", async () => {
    const html = await (await fetch(`${baseUrl}/?wmWidth=%22%3E%3Cscript%3Ealert(1)%3C/script%3E`)).text();
    assert.doesNotMatch(html, /"><script>/, "injected value must not break out of the attribute");
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /value="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
    assert.match(html, /<img src="\/image"/, "watermark is off, so its params are not forwarded to the image");
    // The only script on the page is the toast dismisser.
    assert.equal((html.match(/<script\b/g) ?? []).length, 1, "exactly one (nonced) script on the page");
  });
});
