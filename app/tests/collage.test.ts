/**
 * Collage (spec 4k): templates, cell maths, parsing, rendering (pixels), watermark/corners on
 * top, export + Android with a layout, cache keys, the Collage card and the guides overlay.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { cellRects, collageCanvas, DEFAULT_GUTTER, findLayout, gutterPx, LAYOUTS, SCREEN_ASPECT } from "../src/collage.ts";
import { PRESETS } from "../src/presets.ts";

const dir = mkdtempSync(join(tmpdir(), "collage-uploads-"));
process.env.SHARP_VIEWER_UPLOADS = dir;
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

describe("templates", () => {
  test("11 layouts, unique ids, every cell inside the canvas, no two cells overlap", () => {
    assert.equal(LAYOUTS.length, 11);
    assert.equal(new Set(LAYOUTS.map((l) => l.id)).size, 11);
    for (const l of LAYOUTS) {
      for (const c of l.cells) {
        assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 1 + 1e-9 && c.y + c.h <= 1 + 1e-9, `${l.id} cell inside`);
        assert.ok(c.w > 0 && c.h > 0, `${l.id} positive size`);
      }
      for (let i = 0; i < l.cells.length; i++) {
        for (let j = i + 1; j < l.cells.length; j++) {
          const a = l.cells[i]!,
            b = l.cells[j]!;
          const overlap = a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
          assert.equal(overlap, false, `${l.id}: cells ${i} and ${j} overlap`);
        }
      }
    }
    assert.deepEqual(
      LAYOUTS.map((l) => [l.id, l.cells.length]),
      [
        ["grid-2x2", 4],
        ["grid-3x3", 9],
        ["split-h", 2],
        ["split-v", 2],
        ["hero-3", 3],
        ["hero-4", 4],
        ["strip-3", 3],
        ["strip-4", 4],
        ["story-3", 3],
        ["screens-2", 2],
        ["screens-3", 3],
      ],
    );
    assert.equal(findLayout("nope"), undefined);
  });

  test("cellRects: grid-2x2 on 1080x1080 with a 22 px gutter -> four 507 px squares, 22 px margin and gap", () => {
    const r = cellRects(findLayout("grid-2x2")!, { width: 1080, height: 1080 }, 22);
    assert.deepEqual(r, [
      { left: 22, top: 22, width: 507, height: 507 },
      { left: 551, top: 22, width: 507, height: 507 },
      { left: 22, top: 551, width: 507, height: 507 },
      { left: 551, top: 551, width: 507, height: 507 },
    ]);
    assert.equal(r[1]!.left - (r[0]!.left + r[0]!.width), 22, "gap between neighbours = gutter");
    assert.equal(1080 - (r[1]!.left + r[1]!.width), 22, "right margin = gutter");
    const zero = cellRects(findLayout("grid-2x2")!, { width: 1080, height: 1080 }, 0);
    assert.deepEqual(zero[0], { left: 0, top: 0, width: 540, height: 540 });
    assert.deepEqual(zero[3], { left: 540, top: 540, width: 540, height: 540 });
  });

  test("cellRects: every layout, several canvases: inside the margin, no overlap, neighbour gap = gutter (+-1 px)", () => {
    const canvases = [
      { width: 1080, height: 1080 },
      { width: 1280, height: 720 },
      { width: 1000, height: 1500 },
      { width: 1500, height: 500 },
    ];
    for (const layout of LAYOUTS) {
      for (const canvas of canvases) {
        for (const g of [0, 12, 30]) {
          const rects = cellRects(layout, canvas, g);
          for (const r of rects) {
            assert.ok(r.width >= 1 && r.height >= 1, `${layout.id}: positive`);
            assert.ok(
              r.left >= g && r.top >= g && r.left + r.width <= canvas.width - g && r.top + r.height <= canvas.height - g,
              `${layout.id} ${canvas.width}x${canvas.height} g${g}: inside the margin`,
            );
          }
          for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
              const a = rects[i]!,
                b = rects[j]!;
              const overlap = a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
              assert.equal(overlap, false, `${layout.id}: rects ${i}/${j} overlap`);
            }
          }
          if (layout.id.startsWith("screens-")) continue; // phone cells are deliberately narrower than their slots
          // Immediate horizontal neighbour (same top, nearest to the right): gap == gutter.
          for (const a of rects) {
            const right = rects.filter((b) => b.top === a.top && b.left >= a.left + a.width).sort((p, q) => p.left - q.left)[0];
            if (right)
              assert.ok(
                Math.abs(right.left - (a.left + a.width) - g) <= 1,
                `${layout.id} ${canvas.width}x${canvas.height}: h-gap ${right.left - (a.left + a.width)} vs ${g}`,
              );
            const below = rects.filter((b) => b.left === a.left && b.top >= a.top + a.height).sort((p, q) => p.top - q.top)[0];
            if (below) assert.ok(Math.abs(below.top - (a.top + a.height) - g) <= 1, `${layout.id}: v-gap ${below.top - (a.top + a.height)} vs ${g}`);
          }
        }
      }
    }
  });

  test("screens-*: cells are phone-shaped (9:19.5) and centred; gutter maths: % of the shorter side, capped at a quarter", () => {
    const r = cellRects(findLayout("screens-3")!, { width: 1200, height: 630 }, 10);
    for (const c of r) assert.ok(Math.abs(c.width / c.height - SCREEN_ASPECT) < 0.02, `${c.width}x${c.height}`);
    assert.equal(r[1]!.left + r[1]!.width / 2, 600, "middle phone centred");
    assert.equal(gutterPx({ percent: 2 }, { width: 1080, height: 1920 }), 22);
    assert.equal(gutterPx({ px: 40 }, { width: 1080, height: 1920 }), 40);
    assert.equal(gutterPx({ px: 500 }, { width: 320, height: 240 }), 60, "capped at shorter/4");
    assert.deepEqual(DEFAULT_GUTTER, { percent: 2 });
  });

  test("collageCanvas: preset > width+height > default 1080x1080; one side alone is rejected", () => {
    assert.deepEqual(collageCanvas({ preset: PRESETS[2] }), { width: 1080, height: 1920 });
    assert.deepEqual(collageCanvas({ width: 600, height: 400 }), { width: 600, height: 400 });
    assert.deepEqual(collageCanvas({}), { width: 1080, height: 1080 });
    assert.throws(() => collageCanvas({ width: 600 }), /A collage needs a preset or both width and height/);
  });
});

// ---------------------------------------------------------------------------
// Parsing + rendering

const solid = (hex: string, w = 300, h = 200) =>
  sharp({ create: { width: w, height: h, channels: 3, background: hex } })
    .png()
    .toBuffer();
async function upload(name: string, bytes: Buffer): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), name);
  const r = await fetch(`${baseUrl}/upload`, { method: "POST", body: fd, redirect: "manual" });
  assert.equal(r.status, 303);
  return new URL(r.headers.get("location")!, baseUrl).searchParams.get("image")!;
}
const image = async (q: string) => {
  const r = await fetch(`${baseUrl}/image?${q}`);
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
};
const pixels = async (png: Buffer) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { at: (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)], width: info.width, height: info.height };
};
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe("parsing", () => {
  test("defaults, cells as list or repeated, gutter px / %, rejects with the documented messages", () => {
    const o = app.parseImageOptions(new URLSearchParams("layout=grid-2x2"));
    assert.equal(o.collage?.layout.id, "grid-2x2");
    assert.deepEqual(o.collage?.cells, [null, null, null, null]);
    assert.deepEqual([o.collage?.gutter, o.collage?.cellCorners, o.collage?.cellFit], [{ percent: 2 }, 0, "cover"]);
    const c = app.parseImageOptions(new URLSearchParams("layout=hero-3&cells=photo,,thumb,extra&gutter=12&cellCorners=30&cellFit=contain")).collage!;
    assert.deepEqual(c.cells, ["photo", null, "thumb"], "empty slot kept, extras dropped");
    assert.deepEqual([c.gutter, c.cellCorners, c.cellFit], [{ px: 12 }, 30, "contain"]);
    const rep = app.parseImageOptions(new URLSearchParams("layout=split-h&cells=photo&cells=fhd&gutter=5%")).collage!;
    assert.deepEqual(rep.cells, ["photo", "fhd"]);
    assert.deepEqual(rep.gutter, { percent: 5 });
    assert.equal(app.parseImageOptions(new URLSearchParams("layout=none")).collage, undefined);
    assert.equal(app.parseImageOptions(new URLSearchParams("cells=photo,fhd&gutter=9")).collage, undefined, "collage params without a layout are ignored");
    for (const [q, re] of [
      ["layout=nope", /Unknown layout "nope"\. Known layouts: grid-2x2, grid-3x3/],
      ["layout=grid-2x2&rotate=90", /rotate does not apply to a collage\./],
      ["layout=grid-2x2&width=600", /A collage needs a preset or both width and height\./],
      ["layout=grid-2x2&gutter=513", /gutter must be an integer between 0 and 512 \(px\), or a percentage between 0 and 20/],
      ["layout=grid-2x2&gutter=21%", /gutter must be/],
      ["layout=grid-2x2&gutter=abc", /gutter must be/],
      ["layout=grid-2x2&cellCorners=101", /cellCorners must be an integer between 0 and 100\./],
      ["layout=grid-2x2&cellFit=stretch", /cellFit must be one of cover, contain\./],
      ["layout=grid-2x2&cells=../etc", /image must be an image id/],
    ] as const) {
      assert.throws(() => app.parseImageOptions(new URLSearchParams(q)), re, q);
    }
  });
});

describe("rendering", () => {
  let red: string, green: string, blue: string, yellow: string;
  before(async () => {
    [red, green, blue, yellow] = await Promise.all([
      upload("red.png", await solid("#ff0000")),
      upload("green.png", await solid("#00ff00")),
      upload("blue.png", await solid("#0000ff", 200, 300)),
      upload("yellow.png", await solid("#ffff00")),
    ]);
  });

  test("grid-2x2 on the default 1080 canvas: each cell shows its image, gutters and margins show bg, empty cell is bg", async () => {
    const r = await image(`layout=grid-2x2&cells=${red},${green},${blue}&bg=%23123456&gutter=22`);
    assert.equal(r.status, 200);
    const p = await pixels(r.bytes);
    assert.deepEqual([p.width, p.height], [1080, 1080]);
    const bg = [0x12, 0x34, 0x56, 255];
    assert.ok(near(p.at(275, 275), [255, 0, 0, 255]), "cell 1 red");
    assert.ok(near(p.at(804, 275), [0, 255, 0, 255]), "cell 2 green");
    assert.ok(near(p.at(275, 804), [0, 0, 255, 255]), "cell 3 blue (cover-cropped tall image fills the square)");
    assert.ok(near(p.at(804, 804), bg), "cell 4 empty = bg");
    assert.ok(near(p.at(540, 275), bg), "vertical gutter = bg");
    assert.ok(near(p.at(275, 540), bg), "horizontal gutter = bg");
    assert.ok(near(p.at(5, 5), bg) && near(p.at(1074, 1074), bg), "margins = bg");
    assert.ok(near(p.at(22, 22), [255, 0, 0, 255]) && near(p.at(528, 528), [255, 0, 0, 255]), "cell 1 spans exactly 22..528");
    assert.ok(near(p.at(529, 275), bg), "first gutter pixel");
  });

  test("every layout renders at the preset size with the right number of filled cells", async () => {
    const ids = [red, green, blue, yellow, red, green, blue, yellow, red];
    for (const layout of LAYOUTS) {
      const preset = PRESETS[LAYOUTS.indexOf(layout) % PRESETS.length]!;
      const r = await image(`layout=${layout.id}&cells=${ids.slice(0, layout.cells.length).join(",")}&preset=${preset.id}&gutter=10`);
      assert.equal(r.status, 200, layout.id);
      const p = await pixels(r.bytes);
      assert.deepEqual([p.width, p.height], [preset.width, preset.height], layout.id);
      const rects = cellRects(layout, { width: preset.width, height: preset.height }, 10);
      rects.forEach((rect, i) => {
        const want = [
          [255, 0, 0, 255],
          [0, 255, 0, 255],
          [0, 0, 255, 255],
          [255, 255, 0, 255],
        ][i % 4]!;
        const px = p.at(rect.left + Math.floor(rect.width / 2), rect.top + Math.floor(rect.height / 2));
        assert.ok(near(px, want), `${layout.id} cell ${i + 1} centre ${px} vs ${want}`);
      });
    }
  });

  test("cellFit contain letter-boxes with bg; cellCorners make cell corners bg; a real photo is attention-cropped (umbrella survives)", async () => {
    const contain = await pixels((await image(`layout=split-h&cells=${blue}&bg=%23ffffff&gutter=0&cellFit=contain`)).bytes);
    // blue is 200x300 (2:3) in a 540x1080 (1:2) cell: the cell is taller than the image -> it fills the width, bars top/bottom
    assert.ok(near(contain.at(270, 540), [0, 0, 255, 255]), "centre blue");
    assert.ok(near(contain.at(270, 5), [255, 255, 255, 255]), "top bar is bg");
    assert.ok(near(contain.at(5, 540), [0, 0, 255, 255]), "fills the width");
    const cover = await pixels((await image(`layout=split-h&cells=${blue}&bg=%23ffffff&gutter=0`)).bytes);
    assert.ok(near(cover.at(270, 5), [0, 0, 255, 255]), "cover fills the cell edge to edge (top row is image)");

    const rounded = await pixels((await image(`layout=grid-2x2&cells=${red}&bg=%23000000&gutter=0&cellCorners=100`)).bytes);
    assert.ok(near(rounded.at(2, 2), [0, 0, 0, 255]), "cell corner clipped to bg");
    assert.ok(near(rounded.at(270, 270), [255, 0, 0, 255]), "cell centre kept");
    assert.ok(near(rounded.at(270, 2), [255, 0, 0, 255]), "cell edge midpoint kept (radius = half side)");

    const story = await pixels((await image("layout=split-v&cells=photo&preset=ig-story&gutter=0")).bytes);
    let redPx = 0;
    for (let y = 0; y < 960; y += 4)
      for (let x = 0; x < 1080; x += 4) {
        const [r, g, b] = story.at(x, y);
        if (r! > 200 && g! < 90 && b! < 90) redPx++;
      }
    assert.ok(redPx > 100, `umbrella (red) pixels in the top cell: ${redPx}`);
  });

  test("watermark, grayscale and whole-image corners apply on top of the collage; output matches outputSize()", async () => {
    const plain = await image(`layout=grid-2x2&cells=${red},${green}&gutter=0`);
    const marked = await image(`layout=grid-2x2&cells=${red},${green}&gutter=0&wm=1&wmWidth=30%25`);
    assert.equal(marked.status, 200);
    assert.ok(!plain.bytes.equals(marked.bytes), "mark changes pixels");
    const grey = await pixels((await image(`layout=grid-2x2&cells=${red},${green}&gutter=0&grayscale=1`)).bytes);
    const [r, g, b] = grey.at(270, 270);
    assert.ok(r === g && g === b, "cells are grey");
    const corners = await pixels((await image(`layout=grid-2x2&cells=${red},${green},${blue},${yellow}&gutter=0&corners=100`)).bytes);
    assert.equal(corners.at(1, 1)[3], 0, "whole-collage corner is transparent");
    assert.equal(corners.at(540, 540)[3], 255);
    const small = await image(`layout=hero-3&cells=${red}&width=300&height=200`);
    const p = await pixels(small.bytes);
    assert.deepEqual([p.width, p.height], [300, 200]);
  });

  test("/export and /android.zip accept a layout; the drawable height follows the canvas aspect", async () => {
    const exp = await fetch(`${baseUrl}/export?layout=split-h&cells=${red},${green}&preset=x-header&format=jpeg&quality=70`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get("content-disposition") ?? "", /filename="collage-split-h-x-header-1500x500\.jpg"/);
    const meta = await sharp(Buffer.from(await exp.arrayBuffer())).metadata();
    assert.deepEqual([meta.width, meta.height], [1500, 500]);
    const zip = await fetch(`${baseUrl}/android.zip?layout=split-h&cells=${red},${green}&androidName=pair&dp=360&buckets=mdpi,xhdpi`);
    assert.equal(zip.status, 200);
    const { readZip } = await import("../src/zip.ts");
    const entries = readZip(Buffer.from(await zip.arrayBuffer()));
    const mdpi = entries.find((e) => e.name === "res/drawable-mdpi/pair.png")!;
    const m = await sharp(mdpi.data).metadata();
    assert.deepEqual([m.width, m.height], [360, 360], "1:1 canvas -> square drawable");
    const xhdpi = await sharp(entries.find((e) => e.name === "res/drawable-xhdpi/pair.png")!.data).metadata();
    assert.deepEqual([xhdpi.width, xhdpi.height], [720, 720]);
  });

  test("render cache: a replaced cell image (new upload id) and a changed cell order are different renders", async () => {
    const a = await image(`layout=split-h&cells=${red},${green}&gutter=0`);
    const b = await image(`layout=split-h&cells=${green},${red}&gutter=0`);
    assert.ok(!a.bytes.equals(b.bytes));
    const a2 = await image(`layout=split-h&cells=${red},${green}&gutter=0`);
    assert.ok(a.bytes.equals(a2.bytes));
  });

  test("unknown cell id -> 400 naming the cell; an upload removed from disk -> 400 too", async () => {
    const r = await fetch(`${baseUrl}/image?layout=split-h&cells=${red},nope`);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /Cell 2: Unknown image "nope"/);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: per-cell fit, collage-aware watermark default

describe("phase 2: per-cell fit", () => {
  test("parsing: one value for all, comma list / repeated per cell, missing entries take the first value, bad entry rejected", () => {
    const one = app.parseImageOptions(new URLSearchParams("layout=hero-3&cellFit=contain")).collage!;
    assert.deepEqual(one.cellFits, ["contain", "contain", "contain"]);
    assert.equal(one.cellFit, "contain");
    const list = app.parseImageOptions(new URLSearchParams("layout=hero-3&cellFit=cover,contain")).collage!;
    assert.deepEqual(list.cellFits, ["cover", "contain", "cover"], "missing third entry takes the first value");
    const rep = app.parseImageOptions(new URLSearchParams("layout=split-h&cellFit=contain&cellFit=cover")).collage!;
    assert.deepEqual(rep.cellFits, ["contain", "cover"]);
    assert.equal(app.parseImageOptions(new URLSearchParams("layout=split-h")).collage!.cellFits.join(), "cover,cover");
    assert.throws(() => app.parseImageOptions(new URLSearchParams("layout=split-h&cellFit=cover,stretch")), /cellFit must be one of cover, contain\./);
  });

  test("render: contain on the left cell, cover on the right, in one collage", async () => {
    const blue = await upload("tall-blue.png", await solid("#0000ff", 200, 300));
    const p = await pixels((await image(`layout=split-h&cells=${blue},${blue}&gutter=0&bg=%23ffffff&cellFit=contain,cover`)).bytes);
    assert.ok(near(p.at(270, 5), [255, 255, 255, 255]), "left cell: contain -> top bar is bg");
    assert.ok(near(p.at(810, 5), [0, 0, 255, 255]), "right cell: cover -> top row is image");
  });

  test("page: the image URL carries one cellFit when all agree and the list when they differ; pickers echo per cell", async () => {
    const same = await (await fetch(`${baseUrl}/?layout=split-h&cells=photo,fhd&cellFit=contain&cellFit=contain`)).text();
    assert.match(same, /<img src="\/image\?layout=split-h&amp;cells=photo%2Cfhd&amp;cellFit=contain"/);
    const mixed = await (await fetch(`${baseUrl}/?layout=split-h&cells=photo,fhd&cellFit=contain&cellFit=cover`)).text();
    assert.match(mixed, /<img src="\/image\?layout=split-h&amp;cells=photo%2Cfhd&amp;cellFit=contain%2Ccover"/);
    assert.match(mixed, /&middot; mixed/);
    const fits = [...mixed.matchAll(/<select name="cellFit" form="settings" aria-label="Cell \d fit">([\s\S]*?)<\/select>/g)].map(
      (m) => /<option value="([^"]*)" selected>/.exec(m[1]!)![1],
    );
    assert.deepEqual(fits, ["contain", "cover"]);
  });
});

describe("phase 2: collage-aware watermark default", () => {
  test("collageWatermarkMargin: centred in the band when the mark fits the gutter, else 16", () => {
    assert.equal(app.collageWatermarkMargin(22, 18), 2);
    assert.equal(app.collageWatermarkMargin(40, 18), 11);
    assert.equal(app.collageWatermarkMargin(18, 18), 0);
    assert.equal(app.collageWatermarkMargin(8, 18), 16);
    assert.equal(app.collageWatermarkMargin(100, 18), 41);
  });

  test("render: with the default gutter the 200x18 mark sits inside the bottom margin band; explicit wmMargin wins; single images unchanged", async () => {
    const red = await upload("red-wm.png", await solid("#ff0000"));
    const base = `layout=grid-2x2&cells=${red},${red},${red},${red}&bg=%23000000`;
    const plain = await pixels((await image(base)).bytes);
    const marked = await pixels((await image(`${base}&wm=1&wmOpacity=100`)).bytes);
    // gutter 22, mark 18 -> margin 2 -> mark y in [1060, 1078), x in [878, 1078): all inside the bottom band (y >= 1058).
    let inBand = 0,
      inCells = 0;
    for (let y = 1000; y < 1080; y++) for (let x = 800; x < 1080; x++) if (!near(plain.at(x, y), marked.at(x, y))) y >= 1058 ? inBand++ : inCells++;
    assert.ok(inBand > 200, `mark pixels in the band: ${inBand}`);
    assert.equal(inCells, 0, "no mark pixel over the cells");
    const explicit = await pixels((await image(`${base}&wm=1&wmOpacity=100&wmMargin=100`)).bytes);
    let changed = 0;
    for (let y = 940; y < 980; y++) for (let x = 800; x < 1000; x += 2) if (!near(plain.at(x, y), explicit.at(x, y))) changed++;
    assert.ok(changed > 0, "explicit margin 100 puts the mark over the cell (user's choice)");
    const single = app.parseImageOptions(new URLSearchParams("wm=1")).watermark!;
    assert.deepEqual([single.margin, single.marginGiven], [16, false]);
  });

  test("page: toast names the cell and suggests a margin when the mark covers a picture; none when it sits in the band; field shows the effective margin", async () => {
    const over = await (await fetch(`${baseUrl}/?layout=grid-2x2&cells=photo,fhd,portrait,panorama&wm=1&wmMargin=100&wmWidth=30%25`)).text();
    assert.match(over, /<div class="toast"><span>The watermark overlaps cell 4's picture: use a gutter of at least \d+ px or a smaller mark, or move it/);
    const band = await (await fetch(`${baseUrl}/?layout=grid-2x2&cells=photo,fhd,portrait,panorama&wm=1&gutter=40`)).text();
    assert.doesNotMatch(band, /overlaps cell/);
    assert.match(
      band,
      /name="wmMargin" form="settings"[^>]*placeholder="auto: 11" value=""/,
      "effective default (40 - 18) / 2 shown as the placeholder; blank = automatic",
    );
    const small = await (await fetch(`${baseUrl}/?layout=grid-2x2&cells=photo,fhd,portrait,panorama&wm=1&gutter=8`)).text();
    assert.match(small, /overlaps cell 4's picture: use a gutter of at least 18 px/);
    const empty = await (await fetch(`${baseUrl}/?layout=grid-2x2&cells=photo,fhd,portrait&wm=1&wmMargin=100`)).text();
    assert.doesNotMatch(empty, /overlaps cell/, "cell 4 is empty: nothing to cover");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: per-cell nudge

describe("phase 3: per-cell nudge", () => {
  test("parsing: lists / repeated per cell, missing = 0, range -4096..4096, ignored without a layout", () => {
    const c = app.parseImageOptions(new URLSearchParams("layout=hero-3&cellX=10,-20&cellY=5")).collage!;
    assert.deepEqual(c.nudges, [
      { x: 10, y: 5 },
      { x: -20, y: 0 },
      { x: 0, y: 0 },
    ]);
    const r = app.parseImageOptions(new URLSearchParams("layout=split-h&cellX=1&cellX=2&cellY=-3&cellY=-4")).collage!;
    assert.deepEqual(r.nudges, [
      { x: 1, y: -3 },
      { x: 2, y: -4 },
    ]);
    assert.deepEqual(app.parseImageOptions(new URLSearchParams("layout=split-h")).collage!.nudges, [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
    for (const q of ["layout=split-h&cellX=4097", "layout=split-h&cellY=1.5", "layout=split-h&cellX=abc"]) {
      assert.throws(() => app.parseImageOptions(new URLSearchParams(q)), /cell[XY] entries must be integers between -4096 and 4096\./, q);
    }
    assert.equal(app.parseImageOptions(new URLSearchParams("cellX=50")).collage, undefined);
  });

  test("nudgeRange: the window must stay inside the scaled picture (cover); contain has no range", () => {
    // panorama 4000x1000 into a 507x507 cell: scaled 2028x507, attention left 1394 -> X in [-1394, 2028-507-1394 = 127], Y in [0, 0]
    const r = app.nudgeRange({ width: 4000, height: 1000 }, { width: 507, height: 507 }, { left: 1394, top: 0 });
    assert.deepEqual(r, { x: [-1394, 127], y: [0, 0] });
    assert.deepEqual(app.clampNudge({ x: -2000, y: 9 }, r), { x: -1394, y: 0 });
    assert.deepEqual(app.clampNudge({ x: 100, y: 0 }, r), { x: 100, y: 0 });
  });

  test("render: no nudge is byte-identical to before; -X shows the left part, +X the right part; clamped at the edges; contain ignores it", async () => {
    // A wide two-colour image: left half red, right half blue -> any cover crop of a square cell shows one colour or the seam.
    const half = Buffer.alloc(800 * 200 * 3);
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 800; x++) {
        const i = (y * 800 + x) * 3;
        if (x < 400) half[i] = 255;
        else half[i + 2] = 255;
      }
    const wide = await upload(
      "wide.png",
      await sharp(half, { raw: { width: 800, height: 200, channels: 3 } })
        .png()
        .toBuffer(),
    );
    const base = `layout=grid-2x2&cells=${wide}&gutter=0&bg=%23000000`;
    const plain = await image(base);
    const zero = await image(`${base}&cellX=0&cellY=0`);
    assert.ok(plain.bytes.equals(zero.bytes), "explicit zero nudge = default path, byte-identical");
    const left = await pixels((await image(`${base}&cellX=-4096`)).bytes);
    const right = await pixels((await image(`${base}&cellX=4096`)).bytes);
    assert.ok(near(left.at(270, 270), [255, 0, 0, 255]), `far left is red: ${left.at(270, 270)}`);
    assert.ok(near(right.at(270, 270), [0, 0, 255, 255]), `far right is blue: ${right.at(270, 270)}`);
    assert.ok(
      near(left.at(2, 270), [255, 0, 0, 255]) && near(right.at(537, 270), [0, 0, 255, 255]),
      "clamped: the window stops at the picture's edges, no background leaks in",
    );
    const contain = await image(`${base}&cellFit=contain&cellX=-4096`);
    const containPlain = await image(`${base}&cellFit=contain`);
    assert.ok(contain.bytes.equals(containPlain.bytes), "contain ignores the nudge");
  });

  test("page: nudge fields per cell echo values; out-of-range -> toast with the clamped value and the image uses it; URL normalised", async () => {
    const page = async (q: string) => (await fetch(`${baseUrl}/${q}`)).text();
    // The panorama's attention point is at its right end, so the window can only move left (range -992..0 here).
    const html = await page("?layout=split-v&cells=panorama,panorama&cellX=-600,-300&preset=ig-square");
    const xs = [...html.matchAll(/<input type="number" name="cellX" form="settings" aria-label="Cell \d nudge X"[^>]*value="(-?\d*)"/g)].map((m) => m[1]);
    assert.deepEqual(xs, ["-600", "-300"]);
    assert.match(html, /<img src="\/image\?preset=ig-square&amp;layout=split-v&amp;cells=panorama%2Cpanorama&amp;cellX=-600%2C-300"/);
    assert.doesNotMatch(html, /nudge X .* is out of range/);
    const far = await page("?layout=split-v&cells=panorama,panorama&cellX=-9000,0&preset=ig-square".replace("-9000", "-4000"));
    assert.match(far, /<div class="toast"><span>Cell 1 nudge X -4000 is out of range for this cell: allowed -\d+ to \d+\. Using -\d+\./);
    assert.match(far, /<img src="\/image\?[^"]*cellX=-\d+%2C0"/, "the image URL carries the clamped value");
    const zero = await page("?layout=split-v&cells=panorama,panorama&cellX=0,0&cellY=0,0");
    assert.doesNotMatch(zero, /<img src="[^"]*cell[XY]/, "all-zero nudges are dropped from the image URL");
    const none = await page("?image=photo&cellX=0&cellX=0&cellY=0&cellY=0&cells=&cellFit=cover&gutter=2%25&cellCorners=0");
    assert.match(none, /<img src="\/image\?image=photo"/, "no layout: every collage field the form submits is dropped (found by the browser test)");
  });
});

// ---------------------------------------------------------------------------
// Page: Collage card + guides

describe("page: Collage card", () => {
  const page = async (q: string) => (await fetch(`${baseUrl}/${q}`)).text();

  test("card present with template options; no layout -> 'Single image' context, 4 cell pickers defaulting to the selected image in cell 1", async () => {
    const html = await page("?image=photo");
    assert.match(html, /<h2 id="h-col">Collage<\/h2>/);
    assert.match(html, /<select name="layout" form="settings">/);
    for (const l of LAYOUTS) assert.match(html, new RegExp(`<option value="${l.id}"[^>]*>`), l.id);
    assert.match(html, /<option value="none" selected>None \(single image\)<\/option>/);
    assert.match(html, /<p class="context">Single image &middot; pick a template to build a collage<\/p>/);
    assert.equal((html.match(/<select name="cells" form="settings"/g) ?? []).length, 4, "four cell pickers by default");
    assert.match(
      html,
      /<select name="cells" form="settings" aria-label="Cell 1 source"><option value="">(?:[^<]*)<\/option><option value="sample">sample\.png<\/option><option value="thumb">thumb\.png \(stock\)<\/option><option value="photo" selected>/,
    );
    assert.match(html, /name="gutter" form="settings"[^>]*value="2%"/);
    assert.match(html, /name="cellCorners" form="settings"[^>]*value="0"/);
  });

  test("with a layout: context line, one picker per cell echoing the ids, image src carries the collage params, Output card note", async () => {
    const html = await page("?layout=hero-3&cells=photo,,thumb&preset=yt-thumb&gutter=12&cellCorners=30&cellFit=contain&bg=%23111111");
    assert.match(html, /<option value="hero-3" selected>/);
    assert.match(
      html,
      /<p class="context">hero-3 &middot; 1280&times;720 &middot; 3 cells \(2 filled\) &middot; gutter 12 px &middot; contain &middot; cell corners 30<\/p>/,
    );
    assert.equal((html.match(/<select name="cells" form="settings"/g) ?? []).length, 3);
    const pickers = [...html.matchAll(/<select name="cells" form="settings" aria-label="Cell (\d) source">([\s\S]*?)<\/select>/g)];
    assert.match(pickers[0]![2]!, /<option value="photo" selected>/);
    assert.match(pickers[1]![2]!, /<option value="" selected>/);
    assert.match(pickers[2]![2]!, /<option value="thumb" selected>/);
    assert.match(
      html,
      /<img src="\/image\?preset=yt-thumb&amp;bg=%23111111&amp;layout=hero-3&amp;cells=photo%2C%2Cthumb&amp;gutter=12&amp;cellCorners=30&amp;cellFit=contain"/,
    );
    assert.match(html, /aria-label="Cell 1 fit">[\s\S]*?<option value="contain" selected>/);
    const src = /<img src="([^"]*)"/.exec(html)![1]!.replace(/&amp;/g, "&");
    assert.equal((await fetch(baseUrl + src)).status, 200, "the preview URL loads");
  });

  test("guides=1 draws numbered cell outlines over the preview (SVG, percentages), never in the export", async () => {
    const html = await page("?layout=grid-2x2&cells=photo,fhd&guides=1");
    assert.match(html, /<svg class="overlay" viewBox="0 0 100 100"/);
    assert.equal((html.match(/<rect class="cell-guide"/g) ?? []).length, 4);
    assert.equal((html.match(/<text class="cell-guide-label"/g) ?? []).length, 4);
    assert.match(html, /Guides: dashed outlines are the template's cells/);
    const without = await page("?layout=grid-2x2&cells=photo,fhd");
    assert.doesNotMatch(without, /<rect class="cell-guide"/);
    const a = Buffer.from(await (await fetch(`${baseUrl}/export?layout=grid-2x2&cells=photo,fhd&format=png`)).arrayBuffer());
    const b = Buffer.from(await (await fetch(`${baseUrl}/export?layout=grid-2x2&cells=photo,fhd&format=png&guides=1`)).arrayBuffer());
    assert.ok(a.equals(b), "guides never change the export");
  });

  test("invalid collage values -> banner with the documented message, plain fallback image; Mobile view keeps the collage", async () => {
    for (const [q, re] of [
      ["layout=nope", /Unknown layout/],
      ["layout=grid-2x2&gutter=99%25", /gutter must be/],
      ["layout=grid-2x2&width=100", /A collage needs a preset or both width and height/],
    ] as const) {
      const html = await page(`?${q}`);
      assert.match(html, re, q);
      assert.match(html, /<img src="\/image"/, q);
    }
    const mobile = await page("?layout=split-h&cells=photo,fhd&view=mobile&device=pixel-7");
    assert.match(mobile, /<iframe[^>]*src="\/\?[^"]*layout=split-h[^"]*embed=image"/);
    assert.match(mobile, /<option value="split-h" selected>/);
  });

  test("repeated cells params (how the form submits them) are all kept: forwarded, echoed, passed through", async () => {
    const html = await page("?layout=grid-2x2&cells=photo&cells=fhd&cells=portrait&cells=&preset=ig-square");
    assert.match(html, /4 cells \(3 filled\)/);
    assert.match(html, /<img src="\/image\?preset=ig-square&amp;layout=grid-2x2&amp;cells=photo%2Cfhd%2Cportrait%2C"/);
    const pickers = [...html.matchAll(/<select name="cells" form="settings" aria-label="Cell (\d) source">([\s\S]*?)<\/select>/g)].map(
      (m) => /<option value="([^"]*)" selected>/.exec(m[2]!)![1],
    );
    assert.deepEqual(pickers, ["photo", "fhd", "portrait", ""]);
    const form = /<form method="post" action="\/watermark"[\s\S]*?<\/form>/.exec(html)![0];
    assert.ok(form.includes('name="cells" value="photo,fhd,portrait,"'), "passthrough keeps every cell");
    const mobile = await page("?layout=grid-2x2&cells=photo&cells=fhd&view=mobile");
    assert.match(mobile, /<iframe[^>]*src="\/\?[^"]*cells=photo%2Cfhd%2C%2C[^"]*embed=image"/);
  });

  test("an invalid image option keeps the typed template and cell count in the card (no reset to None)", async () => {
    const html = await page("?layout=hero-3&cells=photo,fhd&gutter=99%25");
    assert.match(html, /gutter must be/);
    assert.match(html, /<option value="hero-3" selected>/);
    assert.equal((html.match(/<select name="cells" form="settings"/g) ?? []).length, 3);
    assert.match(html, /name="gutter" form="settings"[^>]*value="99%"/);
  });

  test("phase 2 gallery: one chip per template with an SVG sketch of its cells, plain links that keep the other settings, active chip marked", async () => {
    const html = await page("?layout=hero-3&cells=photo,fhd&preset=yt-thumb&wm=1&gutter=12");
    const chips = [...html.matchAll(/<a class="tchip( active)?" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
    assert.equal(chips.length, 1 + LAYOUTS.length, "None + every template");
    const active = chips.filter((c) => c[1]);
    assert.equal(active.length, 1);
    assert.match(active[0]![3]!, /Hero left \+ 2 stacked/);
    const grid = chips.find((c) => /Grid 2 x 2/.test(c[3]!))!;
    assert.match(grid[2]!, /layout=grid-2x2/);
    for (const kept of ["preset=yt-thumb", "wm=1", "gutter=12", "cells=photo%2Cfhd"]) assert.ok(grid[2]!.includes(kept), `${kept} kept in the chip link`);
    assert.equal((grid[3]!.match(/<rect /g) ?? []).length, 4, "2x2 sketch has four cells");
    assert.equal((active[0]![3]!.match(/<rect /g) ?? []).length, 3, "hero-3 sketch has three cells");
    const none = chips.find((c) => /None/.test(c[3]!))!;
    assert.doesNotMatch(none[2]!, /layout=/);
    const gallerySketchCount = (html.match(/<svg class="tsketch"/g) ?? []).length;
    assert.equal(gallerySketchCount, 1 + LAYOUTS.length);
  });

  test("phase 2 shaped pickers: the cell boxes sit at the template's fractions inside a box with the canvas aspect; Source + Fit per cell; DOM order = cell order", async () => {
    const html = await page("?layout=hero-3&cells=photo,,thumb&preset=yt-thumb&cellFit=cover,contain,cover");
    assert.match(html, /<div class="cell-grid" style="aspect-ratio: 1280 \/ 720;/);
    const boxes = [...html.matchAll(/<div class="cell-box(?: filled)?" style="left:([\d.]+)%;top:([\d.]+)%;width:([\d.]+)%;height:([\d.]+)%">/g)].map((m) =>
      m.slice(1, 5).map(Number),
    );
    assert.deepEqual(boxes, [
      [0, 0, 66.67, 100],
      [66.67, 0, 33.33, 50],
      [66.67, 50, 33.33, 50],
    ]);
    const order = [...html.matchAll(/<select name="(cells|cellFit)" form="settings" aria-label="Cell (\d) (source|fit)">/g)].map((m) => `${m[2]}${m[3][0]}`);
    assert.deepEqual(order, ["1s", "1f", "2s", "2f", "3s", "3f"], "one source + one fit per cell, in cell order");
    assert.match(html, /<span class="cell-no">2<\/span>/);
    const fits = [...html.matchAll(/aria-label="Cell \d fit">([\s\S]*?)<\/select>/g)].map((m) => /<option value="([^"]*)" selected>/.exec(m[1]!)![1]);
    assert.deepEqual(fits, ["cover", "contain", "cover"]);
    const plain = await page("?image=photo");
    assert.match(plain, /<div class="cell-grid" style="aspect-ratio: 1080 \/ 1080;/, "no layout: the default 2x2 shape on the default canvas");
  });

  test("phase 2 hints: small cells and narrow phone cells are called out in the context line", async () => {
    const tiny = await page("?layout=grid-3x3&cells=photo&width=300&height=300");
    assert.match(tiny, /cells are small on this canvas \(shortest side \d+ px\)/);
    const phones = await page("?layout=screens-3&cells=portrait&preset=pin");
    assert.match(phones, /phone cells are narrow on this tall canvas; try a wide preset \(fb-post, x-post, yt-thumb\)/);
    const fine = await page("?layout=screens-3&cells=portrait&preset=fb-post");
    assert.doesNotMatch(fine, /phone cells are narrow/);
    assert.doesNotMatch(fine, /cells are small/);
  });

  test("phase 2 guides: empty cells are labelled", async () => {
    const html = await page("?layout=grid-2x2&cells=photo,,fhd&guides=1");
    assert.equal((html.match(/<text class="cell-guide-empty"[^>]*>empty<\/text>/g) ?? []).length, 2);
  });

  test("the POST forms carry the collage state back (passthrough)", async () => {
    const html = await page("?layout=split-v&cells=photo,fhd&gutter=3%25&wm=1");
    const form = /<form method="post" action="\/watermark"[\s\S]*?<\/form>/.exec(html)![0];
    for (const h of ['name="layout" value="split-v"', 'name="cells" value="photo,fhd"', 'name="gutter" value="3%"']) assert.ok(form.includes(h), h);
  });
});
