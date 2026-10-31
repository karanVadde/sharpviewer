/**
 * In context (spec 4.9) and the `thumb` display scale (3.1 / 3.2): honest small renders of the
 * finished composition, the grid / list / feed scenes with stock neighbours, the legibility toast.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import * as app from "../src/app.ts";
import { createApp, parseImageOptions, parseThumb, thumbSize } from "../src/app.ts";

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

const image = async (q: string) => {
  const r = await fetch(`${baseUrl}/image?${q}`);
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), text: r.status === 200 ? "" : Buffer.from(await r.clone().arrayBuffer()).toString() };
};
const dims = async (png: Buffer) => {
  const m = await sharp(png).metadata();
  return [m.width, m.height];
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("thumb: parsing and size maths", () => {
  test("grammar: N, WxH, Wx, xH; range 16-1024; rejects", () => {
    assert.deepEqual(parseThumb("150"), { fit: "inside", width: 150, height: 150 });
    assert.deepEqual(parseThumb("150x150"), { fit: "cover", width: 150, height: 150 });
    assert.deepEqual(parseThumb("470x"), { fit: "width", width: 470 });
    assert.deepEqual(parseThumb("x300"), { fit: "height", height: 300 });
    assert.equal(parseThumb(null), undefined);
    assert.equal(parseThumb(""), undefined);
    for (const bad of ["15", "1025", "abc", "x", "10x10", "150x2000", "1.5", "-150", "150x150x150"]) {
      assert.throws(() => parseThumb(bad), /thumb must be N, WxH, Wx or xH with integers between 16 and 1024/, bad);
    }
    assert.deepEqual(parseImageOptions(new URLSearchParams("thumb=150")).thumb, { fit: "inside", width: 150, height: 150 });
  });

  test("thumbSize: inside keeps the aspect, never upscales; cover is exact; width/height keep the aspect", () => {
    assert.deepEqual(thumbSize({ width: 1080, height: 1350 }, parseThumb("150")!), { width: 120, height: 150 });
    assert.deepEqual(thumbSize({ width: 1600, height: 900 }, parseThumb("240")!), { width: 240, height: 135 });
    assert.deepEqual(thumbSize({ width: 100, height: 50 }, parseThumb("240")!), { width: 100, height: 50 }, "no upscale");
    assert.deepEqual(thumbSize({ width: 1080, height: 1350 }, parseThumb("150x150")!), { width: 150, height: 150 });
    assert.deepEqual(thumbSize({ width: 1080, height: 1350 }, parseThumb("470x")!), { width: 470, height: 588 });
    assert.deepEqual(thumbSize({ width: 1600, height: 900 }, parseThumb("x300")!), { width: 533, height: 300 });
    assert.deepEqual(thumbSize({ width: 300, height: 200 }, parseThumb("470x")!), { width: 300, height: 200 }, "width form does not upscale either");
  });
});

describe("thumb: rendering", () => {
  test("sizes match thumbSize for every form; no thumb = unchanged bytes", async () => {
    const plain = await image("image=photo&preset=ig-portrait&wm=1&wmWidth=20%25");
    assert.deepEqual(await dims(plain.bytes), [1080, 1350]);
    for (const [t, want] of [
      ["150", [120, 150]],
      ["150x150", [150, 150]],
      ["470x", [470, 588]],
      ["x300", [240, 300]],
    ] as const) {
      const r = await image(`image=photo&preset=ig-portrait&wm=1&wmWidth=20%25&thumb=${t}`);
      assert.equal(r.status, 200, t);
      assert.deepEqual(await dims(r.bytes), want, t);
    }
    const again = await image("image=photo&preset=ig-portrait&wm=1&wmWidth=20%25");
    assert.equal(sha(again.bytes), sha(plain.bytes));
  });

  test("honesty: the thumbnail is the scaled *finished* composition - the mark is in it, tiny; corners and grayscale survive", async () => {
    const full = await sharp((await image("image=photo&preset=ig-square&wm=1&wmWidth=40%25&wmOpacity=100&wmToneOn=1&wmTone=100&wmMargin=20")).bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tile = await sharp((await image("image=photo&preset=ig-square&wm=1&wmWidth=40%25&wmOpacity=100&wmTone=100&wmMargin=20&thumb=150x150")).bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tilePlain = await sharp((await image("image=photo&preset=ig-square&thumb=150x150")).bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // The scaled mark (432 px wide at full size -> 60 px at 150) changes pixels in the tile's bottom-right corner.
    let changed = 0;
    let outside = 0;
    for (let y = 0; y < 150; y++)
      for (let x = 0; x < 150; x++) {
        const i = (y * 150 + x) * 4;
        const d = Math.abs(tile.data[i]! - tilePlain.data[i]!);
        if (y >= 130 && x >= 80) {
          if (d > 25) changed++;
        } else if (d > 25) outside++;
      }
    assert.ok(changed > 60, `mark pixels at thumbnail scale: ${changed}`);
    assert.equal(outside, 0, "nothing but the mark differs");
    assert.equal(full.info.width, 1080);
    const grey = await sharp((await image("image=photo&preset=ig-square&grayscale=1&corners=100&thumb=96x96")).bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [...grey.data.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4)];
    assert.equal(px(1, 1)[3], 0, "rounded corner survives the scale (transparent)");
    const [r, g, b] = px(48, 48);
    assert.ok(r === g && g === b, "grayscale survives");
  });

  test("thumb is a post-scale: a 1-letter mark that fits at full size still fits; exports carry -thumbN in the filename; collages work", async () => {
    const exp = await fetch(`${baseUrl}/export?image=photo&preset=ig-square&format=jpeg&thumb=150x150`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get("content-disposition") ?? "", /filename="photo-ig-square-1080x1080-thumb150x150\.jpg"/);
    assert.deepEqual(await dims(Buffer.from(await exp.arrayBuffer())), [150, 150]);
    const collage = await image("layout=grid-2x2&cells=photo,fhd&thumb=96");
    assert.deepEqual(await dims(collage.bytes), [96, 96]);
  });
});

// ---------------------------------------------------------------------------
// In-context view (4.9): grid + list scenes

const page = async (q: string) => (await fetch(`${baseUrl}/${q}`)).text();

describe("in context: mode switch and scenes", () => {
  test("header switch has three tabs; In context keeps the settings; unknown scene/tile/row/theme -> banner + Desktop", async () => {
    const html = await page("?image=photo&wm=1&wmWidth=20%25");
    const nav = /<nav class="mode-switch"[\s\S]*?<\/nav>/.exec(html)![0];
    assert.equal((nav.match(/<a /g) ?? []).length, 3);
    assert.match(nav, /href="\/\?image=photo&amp;wm=1&amp;wmWidth=20%25&amp;view=context&amp;device=iphone-se&amp;orientation=portrait"[^>]*>In context</);
    for (const q of ["scene=nope", "tile=100", "row=50", "theme=blue"]) {
      const bad = await page(`?view=context&${q}`);
      assert.match(bad, /<p class="error" role="alert">[^<]*(scene|tile|row|theme) must be/, q);
      assert.match(bad, /<img src="\/image"/, q);
    }
  });

  test("grid scene: 3x3 square tiles at the chosen size, ours in the centre with the full settings + thumb=WxH, neighbours = stock images through the preset only", async () => {
    const html = await page("?image=photo&preset=ig-portrait&wm=1&wmWidth=20%25&grayscale=1&view=context");
    assert.match(html, /<section class="scene scene-grid light" data-scene="grid"/);
    const tiles = [...html.matchAll(/<img class="tile(?: ours)?" src="([^"]*)" width="(\d+)" height="(\d+)"/g)];
    assert.equal(tiles.length, 9);
    assert.ok(
      tiles.every((t) => t[2] === "150" && t[3] === "150"),
      "default tile 150 px, square",
    );
    const ours = [...html.matchAll(/<img class="tile ours" src="([^"]*)"/g)];
    assert.equal(ours.length, 1);
    assert.equal(ours[0]![1]!.replace(/&amp;/g, "&"), "/image?image=photo&preset=ig-portrait&grayscale=1&wm=1&wmWidth=20%25&thumb=150x150");
    const neighbours = tiles.filter((t) => !t[0].includes("ours")).map((t) => t[1]!.replace(/&amp;/g, "&"));
    assert.equal(neighbours.length, 8);
    assert.ok(
      neighbours.every((n) => /^\/image\?image=(sample|thumb|fhd|portrait|panorama)&preset=ig-portrait&thumb=150x150$/.test(n)),
      `neighbours carry the preset only: ${neighbours[0]}`,
    );
    assert.ok(!neighbours.some((n) => n.includes("image=photo")), "the selected image is not its own neighbour");
    assert.equal(
      tiles.findIndex((t) => t[0].includes("ours")),
      4,
      "ours is the centre tile",
    );
    const big = await page("?image=photo&view=context&tile=240");
    assert.ok([...big.matchAll(/<img class="tile(?: ours)?" [^>]*width="240" height="240"/g)].length === 9);
    for (const src of [ours[0]![1]!, neighbours[0]!].map((u) => u.replace(/&amp;/g, "&"))) {
      const r = await fetch(baseUrl + src);
      assert.equal(r.status, 200, src);
      assert.deepEqual(await dims(Buffer.from(await r.arrayBuffer())), [150, 150], src);
    }
  });

  test("list scene: 5 rows, ours in the middle, square thumbnails at the row size; grid/list/size/theme chips are plain links that keep the settings", async () => {
    const html = await page("?image=fhd&wm=1&view=context&scene=list&row=96");
    assert.match(html, /<section class="scene scene-list light" data-scene="list"/);
    const rows = [...html.matchAll(/<li class="row(?: ours)?"><img src="([^"]*)" width="(\d+)" height="(\d+)"/g)];
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r[2] === "96" && r[3] === "96"));
    assert.equal(
      rows.findIndex((r) => r[0].includes("ours")),
      2,
    );
    assert.match(rows[2]![1]!, /image=fhd&amp;wm=1&amp;thumb=96x96$/);
    const chips = [...html.matchAll(/<a class="chip( active)?" href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [
      m[3],
      m[1] ? "active" : "",
      m[2]!.replace(/&amp;/g, "&"),
    ]);
    const labels = chips.map((c) => c[0]);
    for (const l of ["Grid", "List", "Feed", "48", "64", "96", "Light", "Dark"]) assert.ok(labels.includes(l), l);
    const grid = chips.find((c) => c[0] === "Grid")!;
    assert.ok(grid[2]!.includes("scene=grid") && grid[2]!.includes("image=fhd") && grid[2]!.includes("wm=1") && grid[2]!.includes("view=context"), grid[2]);
    assert.equal(chips.find((c) => c[0] === "List")![1], "active");
    assert.equal(chips.find((c) => c[0] === "96")![1], "active");
    assert.match(
      html,
      /<input type="hidden" name="view" value="context">[\s\S]*name="scene" value="list"[\s\S]*name="row" value="96"/,
      "the settings form keeps the scene on Apply",
    );
  });

  test("dark theme class; guides outline ours and label its pixel size", async () => {
    const html = await page("?image=photo&view=context&theme=dark&guides=1");
    assert.match(html, /<section class="scene scene-grid dark"/);
    assert.match(html, /<figure class="tile-box ours guided"[^>]*>[\s\S]*?<figcaption class="scene-size">150&times;150 px<\/figcaption>/);
    const plain = await page("?image=photo&view=context");
    assert.doesNotMatch(plain, /class="tile-box ours guided"|<figcaption class="scene-size"/);
  });

  test("legibility toast: the mark's height at the scene's scale below 8 px -> one toast naming the scene and size; none when legible; none outside the context view", async () => {
    // 200x18 mark on a 1080x1080 canvas; grid tile 150 -> scale 0.139 -> 2.5 px.
    const grid = await page("?image=photo&preset=ig-square&wm=1&view=context");
    assert.match(grid, /<div class="toast"><span>In the grid \(150 px tiles\) the watermark is 3 px tall - unreadable\. It needs a width of about \d+% here/);
    const list = await page("?image=photo&preset=ig-square&wm=1&wmWidth=60%25&view=context&scene=list&row=48");
    assert.match(list, /In the list \(48 px thumbnails\) the watermark is \d px tall - unreadable/);
    const legible = await page("?image=photo&preset=ig-square&wm=1&wmWidth=60%25&view=context&tile=240");
    assert.doesNotMatch(legible, /unreadable/);
    const desktop = await page("?image=photo&preset=ig-square&wm=1");
    assert.doesNotMatch(desktop, /unreadable/);
    const off = await page("?image=photo&preset=ig-square&view=context");
    assert.doesNotMatch(off, /unreadable/, "no watermark, no toast");
  });

  test("collage in context: ours is the collage at thumb size; neighbours use all six stock images", async () => {
    const html = await page("?layout=grid-2x2&cells=photo,fhd&view=context&tile=96");
    const ours = /<img class="tile ours" src="([^"]*)"/.exec(html)![1]!.replace(/&amp;/g, "&");
    assert.equal(ours, "/image?layout=grid-2x2&cells=photo%2Cfhd%2C%2C&thumb=96x96");
    const r = await fetch(baseUrl + ours);
    assert.deepEqual(await dims(Buffer.from(await r.arrayBuffer())), [96, 96]);
    assert.ok(/image=photo&amp;thumb=96x96/.test(html), "photo is a neighbour when the main image is a collage");
  });
});

describe("in context: feed scene", () => {
  test("desktop column: 3 posts, ours in the middle with thumb=470x and explicit dimensions, neighbours through the preset; chips offer Where", async () => {
    const html = await page("?image=photo&preset=ig-square&wm=1&wmWidth=30%25&view=context&scene=feed");
    assert.match(html, /<section class="scene scene-feed light" data-scene="feed"/);
    const posts = [...html.matchAll(/<article class="post( ours)?"/g)];
    assert.equal(posts.length, 3);
    assert.equal(
      posts.findIndex((p) => p[1]),
      1,
      "ours is the middle post",
    );
    assert.match(
      html,
      /<article class="post ours">[\s\S]*?<img src="\/image\?image=photo&amp;preset=ig-square&amp;wm=1&amp;wmWidth=30%25&amp;thumb=470x" width="470" height="470"/,
    );
    const neighbours = [...html.matchAll(/<article class="post">[\s\S]*?<img src="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
    assert.deepEqual(neighbours, ["/image?image=fhd&preset=ig-square&thumb=470x", "/image?image=portrait&preset=ig-square&thumb=470x"]);
    for (const n of neighbours) {
      const r = await fetch(baseUrl + n);
      assert.deepEqual(await dims(Buffer.from(await r.arrayBuffer())), [470, 470], n);
    }
    assert.match(html, /<a class="chip active" href="[^"]*"[^>]*>Desktop column<\/a>/);
    assert.match(html, /<a class="chip" href="[^"]*frame=1[^"]*"[^>]*>On a phone<\/a>/);
    assert.doesNotMatch(html, /<span class="platform">Device<\/span>/, "device chips only when framed");
  });

  test("on a phone: the device frame's iframe shows the scene-only page; device chips; the settings form carries frame/device", async () => {
    const html = await page("?image=photo&preset=ig-square&wm=1&view=context&scene=feed&frame=1&device=pixel-7&theme=dark");
    assert.match(
      html,
      /<iframe title="Pixel 7 feed preview" src="\/\?image=photo&amp;preset=ig-square&amp;wm=1&amp;view=context&amp;scene=feed&amp;theme=dark&amp;device=pixel-7&amp;orientation=portrait&amp;embed=scene" width="412" height="839">/,
    );
    assert.match(html, /<span class="platform">Device<\/span>[\s\S]*<a class="chip active" href="[^"]*device=pixel-7[^"]*"[^>]*>Pixel 7<\/a>/);
    assert.match(html, /name="frame" value="1"[\s\S]*name="device" value="pixel-7"/);
    const embed = await page("?image=photo&preset=ig-square&wm=1&view=context&scene=feed&theme=dark&device=pixel-7&embed=scene");
    assert.match(embed, /<body class="embed embed-scene">/);
    assert.match(
      embed,
      /<article class="post ours">[\s\S]*?thumb=412x" width="412" height="412"/,
      "inside the phone the feed renders at the device width (honest pixels)",
    );
    assert.match(embed, /<section class="scene scene-feed dark"/);
    assert.doesNotMatch(embed, /<nav class="mode-switch"|<form id="settings"|<script/, "scene-only page: no chrome, no form, no script");
    assert.equal((embed.match(/<article class="post/g) ?? []).length, 3);
  });
});

// ---------------------------------------------------------------------------
// Watermark placement review (design pass): thumbnail-safe position, numeric legibility advice

describe("in context: watermark placement review", () => {
  const { safeSquare, markVisibleFraction, thumbnailSafeTraverse, requiredWidthPercent } = app;

  test("safeSquare: the centre square crop a tile/row keeps; visible fraction of a mark rect inside it", () => {
    assert.deepEqual(safeSquare({ width: 1080, height: 1350 }), { left: 0, top: 135, width: 1080, height: 1080 });
    assert.deepEqual(safeSquare({ width: 1280, height: 720 }), { left: 280, top: 0, width: 720, height: 720 });
    assert.deepEqual(safeSquare({ width: 1080, height: 1080 }), { left: 0, top: 0, width: 1080, height: 1080 });
    const out = { width: 1280, height: 720 };
    assert.equal(markVisibleFraction(out, { left: 1064, top: 686, width: 200, height: 18 }), 0, "bottom-right mark of a 16:9 is entirely in the cropped band");
    assert.equal(markVisibleFraction(out, { left: 700, top: 686, width: 200, height: 18 }), 1);
    assert.ok(Math.abs(markVisibleFraction(out, { left: 900, top: 686, width: 200, height: 18 }) - 0.5) < 0.01, "half in");
  });

  test("thumbnailSafeTraverse: the single axis that moves the bottom-right mark into the safe square; zero for a square output", () => {
    assert.deepEqual(thumbnailSafeTraverse({ width: 1080, height: 1350 }), { x: 0, y: -135 });
    assert.deepEqual(thumbnailSafeTraverse({ width: 1080, height: 1920 }), { x: 0, y: -420 });
    assert.deepEqual(thumbnailSafeTraverse({ width: 1280, height: 720 }), { x: -280, y: 0 });
    assert.deepEqual(thumbnailSafeTraverse({ width: 1500, height: 500 }), { x: -500, y: 0 });
    assert.deepEqual(thumbnailSafeTraverse({ width: 1080, height: 1080 }), { x: 0, y: 0 });
  });

  test("requiredWidthPercent: the wmWidth that makes the mark 8 px tall at the scene's scale, or null when impossible", () => {
    // stock mark 398x36; grid 150 on 1080 -> scale 0.1389 -> need 57.6 px tall -> 637 px wide -> 59 %
    assert.equal(requiredWidthPercent({ width: 398, height: 36 }, { width: 1080, height: 1080 }, 150 / 1080), 59);
    assert.equal(requiredWidthPercent({ width: 398, height: 36 }, { width: 1080, height: 1080 }, 64 / 1080), null, "64 px rows: no width under 100 % works");
    assert.equal(requiredWidthPercent({ width: 398, height: 36 }, { width: 1080, height: 1350 }, 470 / 1080), 19);
  });

  test("page: a non-square preset in the grid -> crop toast with the fraction and the fix; chip applies the traverse; after it no crop toast", async () => {
    const html = await page("?image=photo&preset=ig-portrait&wm=1&wmWidth=40%25&view=context");
    assert.match(
      html,
      /<div class="toast"><span>In the grid the square thumbnail crop cuts off 100% of the watermark \(it sits in the bottom band that gets cropped\)\. Move it into the thumbnail-safe area: traverseY -135\./,
    );
    const chip = /<a class="chip fix" href="([^"]*)"[^>]*>Move the watermark into the thumbnail-safe area<\/a>/.exec(html);
    assert.ok(chip, "fix chip");
    const href = chip![1]!.replace(/&amp;/g, "&");
    assert.ok(href.includes("traverseY=-135") && href.includes("view=context") && href.includes("wmWidth=40%25"), href);
    const fixed = await page(href.replace(/^\//, ""));
    assert.doesNotMatch(fixed, /thumbnail crop cuts off/);
    assert.doesNotMatch(fixed, /class="chip fix"/);
    const wide = await page("?image=photo&preset=yt-thumb&wm=1&wmWidth=40%25&view=context&scene=list&row=64");
    assert.match(
      wide,
      /In the list the square thumbnail crop cuts off 52% of the watermark \(it sits in the right band that gets cropped\)\. Move it into the thumbnail-safe area: traverseX -280\./,
    );
    const partial = await page("?image=photo&preset=yt-thumb&wm=1&wmWidth=40%25&traverseX=-200&view=context");
    assert.match(partial, /cuts off \d\d% of the watermark/);
    const square = await page("?image=photo&preset=ig-square&wm=1&wmWidth=40%25&view=context");
    assert.doesNotMatch(square, /thumbnail crop cuts off/);
    const feed = await page("?image=photo&preset=ig-portrait&wm=1&wmWidth=40%25&view=context&scene=feed");
    assert.doesNotMatch(feed, /thumbnail crop cuts off/, "the feed shows the whole post: no crop");
  });

  test("advice is consistent: width and safe position are judged together (a 78% mark cannot sit inside a 720 px square)", async () => {
    assert.equal(app.maxSafeWidthPercent({ width: 1280, height: 720 }, 16), 53);
    assert.equal(app.maxSafeWidthPercent({ width: 1080, height: 1080 }, 16), 97);
    const html = await page("?image=photo&preset=yt-thumb&wm=1&view=context&scene=list&row=64");
    assert.match(
      html,
      /It would need a width of about \d+%, but only up to 53% fits inside the square the crop keeps: at this size the thumbnail cannot carry a readable mark/,
    );
    assert.doesNotMatch(html, /\(wmWidth=\d+%\)/, "no contradictory suggestion");
    const wide = await page("?image=photo&preset=yt-thumb&wm=1&wmWidth=78%25&view=context&scene=grid");
    assert.match(wide, /at 998 px it is wider than the 720 px square the crop keeps: use a width of at most 53%/);
    assert.doesNotMatch(wide, /class="chip fix"/, "no fix chip that would push the mark off the edge");
  });

  test("page: the legibility toast gives a number, or says honestly that the size cannot carry a text mark; phone feed uses the device width", async () => {
    const grid = await page("?image=photo&preset=ig-square&wm=1&view=context");
    assert.match(
      grid,
      /In the grid \(150 px tiles\) the watermark is 3 px tall - unreadable\. It needs a width of about 59% here \(wmWidth=59%\)\. Tip: Green tone 100 adds contrast on a light picture\./,
    );
    const toned = await page("?image=photo&preset=ig-square&wm=1&wmToneOn=1&wmTone=100&view=context");
    assert.doesNotMatch(toned, /Tip: Green tone/, "no tip when a tone is set");
    const list = await page("?image=photo&preset=ig-square&wm=1&view=context&scene=list&row=64");
    assert.match(
      list,
      /In the list \(64 px thumbnails\) the watermark is 1 px tall - unreadable\. No width under 100% is readable at this size: thumbnails this small cannot carry a text mark; it protects the full-size view\./,
    );
    const phone = await page("?image=photo&preset=ig-square&wm=1&view=context&scene=feed&frame=1&device=pixel-7");
    assert.match(phone, /In the feed \(412 px wide\) the watermark is 7 px tall - unreadable\. It needs a width of about 2\d% here/);
    const desk = await page("?image=photo&preset=ig-square&wm=1&view=context&scene=feed");
    assert.doesNotMatch(desk, /unreadable/, "470 px column: the default mark is 8 px - the threshold");
  });

  test("golden rule: the Desktop and Mobile pages are untouched by the review (no crop toast, no fix chip, same image URL)", async () => {
    for (const q of ["?image=photo&preset=ig-portrait&wm=1&wmWidth=40%25", "?image=photo&preset=ig-portrait&wm=1&wmWidth=40%25&view=mobile&device=pixel-7"]) {
      const html = await page(q);
      assert.doesNotMatch(html, /thumbnail crop cuts off|class="chip fix"|needs a width of about/, q);
    }
  });
});
