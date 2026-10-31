import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { BUCKETS, bucketForDpr, dpToPx, ICON, maxDpFor, planBuckets, planDevices, suggestResourceName, validateResourceName } from "../src/android.ts";
import { createApp, parseAndroidOptions, planDrawable, renderAndroidZip } from "../src/app.ts";
import { DEVICES } from "../src/devices.ts";
import { MAX_DIMENSION } from "../src/limits.ts";
import { crc32, readZip, writeZip } from "../src/zip.ts";

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

const size = async (png: Buffer) => {
  const m = await sharp(png).metadata();
  return { width: m.width, height: m.height, format: m.format, channels: m.channels };
};
async function zip(query: string) {
  const r = await fetch(`${baseUrl}/android.zip?${query}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  return {
    status: r.status,
    bytes,
    text: bytes.toString("utf8"),
    disposition: r.headers.get("content-disposition"),
    type: r.headers.get("content-type"),
    entries: r.headers.get("x-android-entries"),
    warnings: r.headers.get("x-android-warnings"),
  };
}

describe("zip writer/reader", () => {
  test("crc32 known values", () => {
    assert.equal(crc32(Buffer.from("")), 0);
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  });
  test("round-trip with stored and deflated entries, unicode names, CRC verified", () => {
    const entries = [
      { name: "res/drawable-mdpi/a.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
      { name: "README.txt", data: Buffer.from("hello ".repeat(500)) },
      { name: "dir/ünïcode.txt", data: Buffer.from("x") },
      { name: "empty.txt", data: Buffer.alloc(0) },
    ];
    const z = writeZip(entries, new Date(2026, 0, 2, 3, 4, 6));
    assert.equal(z.readUInt32LE(0), 0x04034b50);
    const back = readZip(z);
    assert.deepEqual(
      back.map((e) => e.name),
      entries.map((e) => e.name),
    );
    for (let i = 0; i < entries.length; i++) assert.ok(back[i]!.data.equals(entries[i]!.data), entries[i]!.name);
    assert.ok(z.length < 600, `text deflated: ${z.length} bytes`);
    // corrupt a byte inside the deflated README payload (entry 2 data starts at 60 + 30 + 10) -> detected
    const bad = Buffer.from(z);
    bad[105]! ^= 0xff;
    assert.throws(() => readZip(bad), /CRC mismatch|size mismatch|bad|invalid|incorrect/);
  });
});

describe("android maths", () => {
  test("buckets and dp -> px", () => {
    assert.deepEqual(
      BUCKETS.map((b) => [b.id, b.scale]),
      [
        ["mdpi", 1],
        ["hdpi", 1.5],
        ["xhdpi", 2],
        ["xxhdpi", 3],
        ["xxxhdpi", 4],
      ],
    );
    assert.deepEqual(
      BUCKETS.map((b) => dpToPx(360, b)),
      [360, 540, 720, 1080, 1440],
    );
    assert.deepEqual(
      BUCKETS.map((b) => dpToPx(ICON.legacyDp, b)),
      [48, 72, 96, 144, 192],
    );
    assert.deepEqual(
      BUCKETS.map((b) => dpToPx(ICON.adaptiveDp, b)),
      [108, 162, 216, 324, 432],
    );
    assert.equal(dpToPx(1, BUCKETS[1]!), 2, "1 dp at 1.5x rounds to 2 px");
  });
  test("device DPR -> bucket (nearest at or above)", () => {
    for (const [dpr, id] of [
      [1, "mdpi"],
      [1.5, "hdpi"],
      [2, "xhdpi"],
      [2.25, "xxhdpi"],
      [2.625, "xxhdpi"],
      [2.75, "xxhdpi"],
      [3, "xxhdpi"],
      [4, "xxxhdpi"],
      [4.5, "xxxhdpi"],
    ] as const) {
      assert.equal(bucketForDpr(dpr).id, id, String(dpr));
    }
    const byName = Object.fromEntries(planDevices({ width: 1600, height: 1200 }, 360, undefined).map((d) => [d.device.name, d.bucket.id]));
    assert.equal(byName["Pixel 7"], "xxhdpi");
    assert.equal(byName["Galaxy S9+"], "xxxhdpi");
    assert.equal(byName["iPad Mini"], "xhdpi");
  });
  test("planBuckets: sizes and upscale verdicts", () => {
    const photo = planBuckets({ width: 1600, height: 1200 }, 360, undefined);
    assert.deepEqual(
      photo.map((p) => [p.output.width, p.output.height, p.verdict]),
      [
        [360, 270, "ok"],
        [540, 405, "ok"],
        [720, 540, "ok"],
        [1080, 810, "ok"],
        [1440, 1080, "ok"],
      ],
    );
    const thumb = planBuckets({ width: 320, height: 240 }, 360, undefined);
    assert.deepEqual(
      thumb.map((p) => p.verdict),
      ["upscaled", "upscaled", "upscaled", "upscaled", "upscaled"],
    );
    assert.equal(thumb[4]!.factor, 4.5);
    const both = planBuckets({ width: 1600, height: 1200 }, 360, 200, [BUCKETS[4]!]);
    assert.deepEqual(both[0]!.output, { width: 1440, height: 800 });
    assert.equal(both[0]!.verdict, "ok");
    const tall = planBuckets({ width: 1600, height: 1200 }, 100, 400, [BUCKETS[4]!]);
    assert.equal(tall[0]!.verdict, "upscaled", "height axis limits");
  });
  test("resource names", () => {
    assert.equal(validateResourceName("ic_banner_2"), null);
    for (const bad of ["My-Banner", "2cool", "Banner", "a b", "", "ic-launcher"])
      assert.match(validateResourceName(bad) ?? "", /not a valid resource name/, bad);
    assert.equal(suggestResourceName("My Banner-2.png"), "my_banner_2");
    assert.equal(suggestResourceName("2024 photo.JPG"), "img_2024_photo");
    assert.equal(suggestResourceName("!!!"), "image");
    assert.equal(suggestResourceName("IMG_0042.jpg"), "img_0042");
  });
  test("parseAndroidOptions defaults and rejects", () => {
    const d = parseAndroidOptions(new URLSearchParams(""));
    assert.deepEqual([d.mode, d.name, d.dpWidth, d.dpHeight, d.buckets.length, d.nodpi, d.format], ["drawable", "image", 360, undefined, 5, false, "png"]);
    const i = parseAndroidOptions(new URLSearchParams("androidMode=icon"));
    assert.deepEqual([i.name, i.dpWidth], ["ic_launcher", 108]);
    const sub = parseAndroidOptions(new URLSearchParams("buckets=xxxhdpi&buckets=mdpi,xhdpi&buckets=mdpi"));
    assert.deepEqual(
      sub.buckets.map((b) => b.id),
      ["mdpi", "xhdpi", "xxxhdpi"],
      "deduplicated and sorted",
    );
    for (const [q, re] of [
      ["androidMode=vector", /androidMode must be one of/],
      ["androidName=Bad-Name", /not a valid resource name.*e\.g\. bad_name/],
      ["dp=0", /dp must be an integer/],
      ["buckets=ldpi", /Unknown density bucket "ldpi"/],
      ["androidFormat=jpeg", /androidFormat must be one of png, webp/],
    ] as Array<[string, RegExp]>) {
      assert.throws(() => parseAndroidOptions(new URLSearchParams(q)), re, q);
    }
  });
});

describe("B1: Android output is capped at MAX_DIMENSION px per side", () => {
  test("planBuckets: verdict too-large when dp x scale or the aspect-derived height exceeds the cap", () => {
    const wide = planBuckets({ width: 1600, height: 1200 }, 4096, undefined, [BUCKETS[4]!]);
    assert.equal(wide[0]!.verdict, "too-large");
    assert.deepEqual([wide[0]!.output.width, wide[0]!.output.height], [16384, 12288]);
    const exact = planBuckets({ width: 1600, height: 1200 }, 1024, undefined, [BUCKETS[4]!]);
    assert.equal(exact[0]!.verdict, "upscaled", "4096 px exactly is allowed (merely upscaled from 1600)");
    assert.equal(planBuckets({ width: 4096, height: 3072 }, 1024, undefined, [BUCKETS[4]!])[0]!.verdict, "ok");
    const tall = planBuckets({ width: 1000, height: 4000 }, 1100, undefined, [BUCKETS[0]!]);
    assert.equal(tall[0]!.verdict, "too-large", "height from the source aspect (4400 px) is over the cap");
    const both = planBuckets({ width: 1600, height: 1200 }, 100, 4096, [BUCKETS[1]!]);
    assert.equal(both[0]!.verdict, "too-large", "explicit dp height x 1.5");
  });

  test("maxDpFor: the largest dp that still fits each bucket", () => {
    assert.deepEqual(
      BUCKETS.map((b) => maxDpFor(b)),
      [4096, 2730, 2048, 1365, 1024],
    );
  });

  test("planDrawable: oversize buckets are split off; 400 only when none fits", () => {
    const photo = { width: 1600, height: 1200 };
    const opts = (q: string) => parseAndroidOptions(new URLSearchParams(q));
    assert.throws(
      () => planDrawable(photo, opts("dp=4096&buckets=xxxhdpi")),
      /xxxhdpi would be 16384x12288 px; the limit is 4096 px per side \(max 1024 dp wide at xxxhdpi\)/,
    );
    assert.throws(() => planDrawable(photo, opts("dp=100&dpHeight=3000&buckets=hdpi")), /hdpi would be 150x4500 px/);
    const mixed = planDrawable(photo, opts("dp=2000"));
    assert.deepEqual(
      mixed.fit.map((p) => p.bucket.id),
      ["mdpi", "hdpi", "xhdpi"],
    );
    assert.deepEqual(
      mixed.skipped.map((p) => [p.bucket.id, p.output.width]),
      [
        ["xxhdpi", 6000],
        ["xxxhdpi", 8000],
      ],
    );
    assert.equal(planDrawable(photo, opts("dp=1024&buckets=xxxhdpi")).skipped.length, 0);
    assert.doesNotThrow(() => opts("dp=4096&buckets=xxxhdpi"), "parsing is sync and source-agnostic; the plan is checked before rendering");
    assert.doesNotThrow(() => opts("androidMode=icon&dp=4096"), "icon sizes are fixed; dp is not used");
  });

  test("GET /android.zip: 400 when no bucket fits (no render), incl. the aspect-derived height", async () => {
    const started = Date.now();
    const r = await fetch(`${baseUrl}/android.zip?image=photo&dp=4096&buckets=xxxhdpi`);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /xxxhdpi would be 16384x12288 px; the limit is 4096 px per side \(max 1024 dp wide at xxxhdpi\)/);
    assert.ok(Date.now() - started < 2000, "rejected before rendering anything");
    const tall = await fetch(`${baseUrl}/android.zip?image=panorama&rotate=90&dp=1100&buckets=mdpi`);
    assert.equal(tall.status, 400);
    assert.match(await tall.text(), new RegExp(`mdpi would be 1100x4400 px; the limit is ${MAX_DIMENSION} px per side`));
  });

  test("GET /android.zip: oversize buckets are skipped and listed as warnings; the rest is delivered", async () => {
    const r = await fetch(`${baseUrl}/android.zip?image=thumb&androidName=big&dp=1400`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-android-entries"), "4", "mdpi, hdpi, xhdpi + README");
    assert.equal(r.headers.get("x-android-warnings"), "5", "3 upscaled + 2 skipped");
    const entries = readZip(Buffer.from(await r.arrayBuffer()));
    assert.deepEqual(
      entries.map((e) => e.name),
      ["res/drawable-mdpi/big.png", "res/drawable-hdpi/big.png", "res/drawable-xhdpi/big.png", "README.txt"],
    );
    const readme = entries.find((e) => e.name === "README.txt")!.data.toString("utf8");
    assert.match(readme, /- xxhdpi \(4200x3150 px\) SKIPPED: exceeds the 4096 px per side limit \(max 1365 dp wide at xxhdpi\)\./);
    assert.match(readme, /- xxxhdpi \(5600x4200 px\) SKIPPED/);
  });

  test("page: oversize buckets show as 'too large' rows, summary counts them, ZIP stays enabled; card error only when none fits", async () => {
    const html = await (await fetch(`${baseUrl}/?image=photo&dp=4096&wm=1`)).text();
    assert.doesNotMatch(html, /<p class="error"/, "no banner: the default card must not error just because a bucket is big");
    assert.equal(
      (html.match(/class="warn">too large \(skipped\)/g) ?? []).length,
      4 + DEVICES.length,
      "hdpi..xxxhdpi density rows + every device (all map to a skipped bucket)",
    );
    assert.match(html, /<strong>4 of 5 buckets too large \(skipped\)<\/strong>/);
    assert.match(html, /class="button-link" href="\/android\.zip\?image=photo&amp;wm=1&amp;dp=4096"\s+download>Download ZIP/);
    assert.match(html, /<img src="\/image\?image=photo&amp;wm=1"/);
    const none = await (await fetch(`${baseUrl}/?image=photo&dp=4096&buckets=xxxhdpi`)).text();
    assert.match(
      none,
      /<p class="error" role="alert">Android: xxxhdpi would be 16384x12288 px; the limit is 4096 px per side \(max 1024 dp wide at xxxhdpi\)\. Lower the dp or untick the bucket\.<\/p>/,
    );
    assert.match(none, /class="button-link" href="" aria-disabled="true" download>Download ZIP/);
    const tall = await (await fetch(`${baseUrl}/?image=panorama&rotate=90`)).text();
    assert.doesNotMatch(tall, /<p class="error"/, "rotated panorama with default 360 dp: xxhdpi/xxxhdpi skipped, not an error");
    assert.match(tall, /<strong>2 of 5 buckets too large \(skipped\)<\/strong>/);
  });
});

describe("GET /android.zip - drawables", () => {
  test("five buckets at the right sizes, README, headers, watermark % scales per bucket", async () => {
    const r = await zip("image=photo&androidName=banner&dp=360&wm=1&wmWidth=20%");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.type, "application/zip");
    assert.equal(r.disposition, 'attachment; filename="banner-android.zip"');
    assert.equal(r.entries, "6");
    assert.equal(r.warnings, null);
    const entries = readZip(r.bytes);
    assert.deepEqual(
      entries.map((e) => e.name),
      [
        "res/drawable-mdpi/banner.png",
        "res/drawable-hdpi/banner.png",
        "res/drawable-xhdpi/banner.png",
        "res/drawable-xxhdpi/banner.png",
        "res/drawable-xxxhdpi/banner.png",
        "README.txt",
      ],
    );
    const expected = [
      [360, 270],
      [540, 405],
      [720, 540],
      [1080, 810],
      [1440, 1080],
    ];
    for (let i = 0; i < 5; i++) {
      const s = await size(entries[i]!.data);
      assert.deepEqual([s.width, s.height, s.format], [...expected[i]!, "png"], entries[i]!.name);
    }
    // watermark at 20% of each width: the bottom-right differs from an unmarked render of the same size
    const plain = await (await fetch(`${baseUrl}/image?image=photo&width=360`)).arrayBuffer();
    assert.ok(!Buffer.from(plain).equals(entries[0]!.data));
    const readme = entries[5]!.data.toString();
    assert.match(readme, /Drawable "banner" - 360 dp, from a 1600x1200 px source/);
    assert.match(readme, /res\/drawable-xxxhdpi\/banner.png: 1440x1080 px \(4x\)\n/);
    assert.match(readme, /No warnings/);
  });

  test("upscale warnings: thumb at 360 dp, subset of buckets, nodpi, WebP", async () => {
    const r = await zip("image=thumb&androidName=hero&dp=360&dpHeight=200&fit=cover&buckets=mdpi,xhdpi,xxxhdpi&nodpi=1&androidFormat=webp");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.entries, "5");
    assert.equal(r.warnings, "3");
    const entries = readZip(r.bytes);
    assert.deepEqual(
      entries.map((e) => e.name),
      ["res/drawable-mdpi/hero.webp", "res/drawable-xhdpi/hero.webp", "res/drawable-xxxhdpi/hero.webp", "res/drawable-nodpi/hero.webp", "README.txt"],
    );
    assert.deepEqual(await size(entries[2]!.data).then((s) => [s.width, s.height, s.format]), [1440, 800, "webp"]);
    assert.deepEqual(await size(entries[3]!.data).then((s) => [s.width, s.height]), [360, 200]);
    const readme = entries[4]!.data.toString();
    assert.match(readme, /xxxhdpi \(1440x800 px\) is upscaled ×4\.5 from the 320x240 px source/);
    assert.match(readme, /density-independent/);
  });

  test("px watermark gets a density note; enhance settings apply per bucket", async () => {
    const r = await zip("image=photo&dp=100&buckets=mdpi,xxxhdpi&wm=1&wmWidth=40&grayscale=1&corners=50");
    assert.equal(r.status, 200);
    const entries = readZip(r.bytes);
    assert.match(entries[2]!.data.toString(), /watermark uses a px size/);
    const big = await sharp(entries[1]!.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(big.data[3], 0, "rounded corner transparent at xxxhdpi");
    assert.ok(big.data[(big.info.width * 100 + 200) * 4]! === big.data[(big.info.width * 100 + 200) * 4 + 1]!, "grey");
  });

  test("rejections: bad name, bad bucket, unknown image", async () => {
    for (const [q, re] of [
      ["androidName=My-Banner", /e\.g\. my_banner/],
      ["buckets=tvdpi", /Unknown density bucket/],
      ["image=nope", /Unknown image/],
      ["dp=5000", /dp must be an integer between 1 and 4096/],
    ] as Array<[string, RegExp]>) {
      const r = await zip(q);
      assert.equal(r.status, 400, q);
      assert.match(r.text, re);
    }
  });
});

describe("GET /android.zip - launcher icon", () => {
  test("legacy + adaptive layers + XML + Play Store icon at the right sizes", async () => {
    const r = await zip("image=photo&androidMode=icon&bg=%231f2933");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.disposition, 'attachment; filename="ic_launcher-android.zip"');
    const entries = readZip(r.bytes);
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    assert.equal(entries.length, 5 * 3 + 2 + 1 + 1);
    for (const b of BUCKETS) {
      assert.deepEqual(await size(byName.get(`res/mipmap-${b.id}/ic_launcher.png`)!).then((s) => [s.width, s.height]), [dpToPx(48, b), dpToPx(48, b)], b.id);
      assert.deepEqual(
        await size(byName.get(`res/mipmap-${b.id}/ic_launcher_foreground.png`)!).then((s) => [s.width, s.height, s.channels]),
        [dpToPx(108, b), dpToPx(108, b), 4],
        b.id,
      );
      assert.deepEqual(
        await size(byName.get(`res/mipmap-${b.id}/ic_launcher_background.png`)!).then((s) => [s.width, s.height]),
        [dpToPx(108, b), dpToPx(108, b)],
        b.id,
      );
    }
    const xml = byName.get("res/mipmap-anydpi-v26/ic_launcher.xml")!.toString();
    assert.match(xml, /<adaptive-icon xmlns:android="http:\/\/schemas.android.com\/apk\/res\/android">/);
    assert.match(xml, /@mipmap\/ic_launcher_background/);
    assert.match(xml, /@mipmap\/ic_launcher_foreground/);
    assert.equal(byName.get("res/mipmap-anydpi-v26/ic_launcher_round.xml")!.toString(), xml);
    const play = await size(byName.get("playstore/ic_launcher-512.png")!);
    assert.deepEqual([play.width, play.height], [512, 512]);
    assert.match(byName.get("README.txt")!.toString(), /Safe zone: the image is fitted into the 66 dp/);
  });

  test("foreground keeps the image inside the 66 dp safe zone; background is the solid colour; Play icon is opaque", async () => {
    const r = await zip("image=photo&androidMode=icon&bg=%231f2933&buckets=xxxhdpi");
    const byName = new Map(readZip(r.bytes).map((e) => [e.name, e.data]));
    const fg = await sharp(byName.get("res/mipmap-xxxhdpi/ic_launcher_foreground.png")!).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => fg.data[(y * fg.info.width + x) * 4 + 3]!;
    const pad = Math.floor((432 - 264) / 2); // 18 dp * 4 = 72... (432 - 264) / 2 = 84
    assert.equal(at(0, 0), 0);
    assert.equal(at(pad - 2, 216), 0, "outside the safe square is transparent");
    assert.equal(at(pad + 2, 216), 255, "inside the safe square is image");
    assert.equal(at(216, 216), 255);
    const bg = await sharp(byName.get("res/mipmap-xxxhdpi/ic_launcher_background.png")!).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([bg.data[0], bg.data[1], bg.data[2], bg.data[3]], [0x1f, 0x29, 0x33, 255]);
    const play = await sharp(byName.get("playstore/ic_launcher-512.png")!).raw().toBuffer({ resolveWithObject: true });
    assert.ok(play.info.channels === 3 || play.data.every((v, i) => i % 4 !== 3 || v === 255), "no transparency");
  });

  test("custom name flows into every file; a 320x240 source fits the 264 px safe zone (no warning)", async () => {
    const r = await zip("image=thumb&androidMode=icon&androidName=ic_app&buckets=mdpi");
    assert.equal(r.warnings, null);
    const names = readZip(r.bytes).map((e) => e.name);
    assert.deepEqual(names, [
      "res/mipmap-mdpi/ic_app_foreground.png",
      "res/mipmap-mdpi/ic_app_background.png",
      "res/mipmap-mdpi/ic_app.png",
      "res/mipmap-anydpi-v26/ic_app.xml",
      "res/mipmap-anydpi-v26/ic_app_round.xml",
      "playstore/ic_app-512.png",
      "README.txt",
    ]);
  });

  test("icon preview endpoint: 432 px square PNG", async () => {
    const r = await fetch(`${baseUrl}/android/icon-preview?image=photo&bg=%23ff0000`);
    assert.equal(r.status, 200);
    const s = await size(Buffer.from(await r.arrayBuffer()));
    assert.deepEqual([s.width, s.height, s.format], [432, 432, "png"]);
  });

  test("renderAndroidZip is deterministic apart from the README timestamp", async () => {
    const o = parseAndroidOptions(new URLSearchParams("image=thumb&buckets=mdpi"));
    const a = await renderAndroidZip(o),
      b = await renderAndroidZip(o);
    assert.deepEqual(a.entries, b.entries);
    assert.ok(readZip(a.bytes)[0]!.data.equals(readZip(b.bytes)[0]!.data));
  });
});

describe("page: Android card and guides", () => {
  const page = async (q: string) => (await fetch(`${baseUrl}/${q}`)).text();
  test("density and device tables with correct verdicts (thumb vs photo), context, ZIP link, echoes", async () => {
    const thumb = await page("?image=thumb&dp=360&androidName=hero&androidFormat=webp&buckets=mdpi&buckets=xxxhdpi&nodpi=1");
    assert.match(thumb, /<h2 id="h-and">Android<\/h2>/);
    assert.match(thumb, /hero &middot; 360 dp &middot; 360\/1440 px &middot; WEBP &middot; <strong>2 of 2 buckets upscaled<\/strong>/);
    assert.equal((thumb.match(/class="warn">upscaled/g) ?? []).length, 2 + DEVICES.length, "both buckets and every device upscaled");
    assert.match(
      thumb,
      /href="\/android\.zip\?image=thumb&amp;androidName=hero&amp;dp=360&amp;buckets=mdpi&amp;buckets=xxxhdpi&amp;nodpi=1&amp;androidFormat=webp"\s+download/,
    );
    assert.match(thumb, /name="buckets" value="mdpi" form="settings" checked/);
    assert.doesNotMatch(thumb, /name="buckets" value="hdpi" form="settings" checked/);
    assert.match(thumb, /name="nodpi" value="1" form="settings" checked/);
    assert.match(thumb, /<option value="webp" selected>/);
    const photo = await page("?image=photo&dp=360");
    assert.equal((photo.match(/class="warn">/g) ?? []).length, 0);
    assert.equal((photo.match(/class="ok">OK/g) ?? []).length, 5 + DEVICES.length);
    assert.match(photo, /source sufficient/);
    assert.match(photo, /placeholder="photo"/, "name placeholder suggested from the image");
  });

  test("device table: Pixel 7 -> xxhdpi needs 1080 px, Galaxy S9+ -> xxxhdpi needs 1440 px", async () => {
    const html = await page("?image=fhd&dp=360");
    assert.match(html, /<td>Pixel 7<\/td><td>2\.625<\/td><td>xxhdpi<\/td><td>1080&times;608<\/td><td class="ok">OK<\/td>/);
    assert.match(html, /<td>Galaxy S9\+<\/td><td>4\.5<\/td><td>xxxhdpi<\/td><td>1440&times;810<\/td><td class="ok">OK<\/td>/);
  });

  test("invalid Android settings: banner inside the card, ZIP disabled, preview unaffected", async () => {
    const html = await page("?image=photo&androidName=Bad-Name&wm=1");
    assert.match(html, /<p class="error" role="alert">Android name: &quot;Bad-Name&quot;[^<]*e\.g\. bad_name\.<\/p>/);
    assert.match(html, /class="button-link" href="" aria-disabled="true" download>Download ZIP/);
    assert.match(html, /<img src="\/image\?image=photo&amp;wm=1"/);
  });

  test("icon mode: preview shows the adaptive icon, tables show icon sizes, guides draw the safe-zone circles", async () => {
    const html = await page("?image=photo&androidMode=icon&bg=%231f2933&guides=1");
    assert.match(html, /<img src="\/android\/icon-preview\?image=photo&amp;bg=%231f2933&amp;androidMode=icon"/);
    assert.match(html, /<td>xxxhdpi<\/td><td>192 px<\/td><td>432 px<\/td><td>264 px<\/td>/);
    assert.match(html, /<svg class="overlay"/);
    assert.match(html, /<circle cx="50" cy="50" r="45\.83"/, "66/72 safe circle");
    assert.match(html, /66 dp safe zone/);
    assert.match(html, /name="guides" value="1" form="settings" checked/);
    const noGuides = await page("?image=photo&androidMode=icon");
    assert.doesNotMatch(noGuides, /<svg class="overlay"/);
  });

  test("guides in Mobile view: status bar, nav bar and the device's cut-out; none without the flag; never in the image-only page", async () => {
    const notch = await page("?view=mobile&device=iphone-13&guides=1");
    assert.match(notch, /class="guide status"/);
    assert.match(notch, /class="guide nav"/);
    assert.match(notch, /class="guide cutout notch"/);
    const punch = await page("?view=mobile&device=pixel-7&guides=1");
    assert.match(punch, /class="guide cutout punch"/);
    const pill = await page("?view=mobile&device=iphone-14-pro-max&guides=1");
    assert.match(pill, /class="guide cutout pill"/);
    const none = await page("?view=mobile&device=ipad-mini&guides=1");
    assert.doesNotMatch(none, /class="guide cutout/);
    const landscape = await page("?view=mobile&device=iphone-13&guides=1&orientation=landscape");
    assert.doesNotMatch(landscape, /class="guide cutout/, "cut-out only drawn in portrait");
    assert.match(landscape, /class="guide nav landscape"/);
    assert.doesNotMatch(await page("?view=mobile&device=iphone-13"), /class="guide /);
    assert.doesNotMatch(await page("?embed=image&guides=1"), /class="guide |class="overlay/);
  });

  test("story keep-clear guides with the ig-story preset; exports never contain guides", async () => {
    const html = await page("?image=photo&preset=ig-story&guides=1");
    assert.match(html, /<div class="overlay band top" style="height:13\.02%"/);
    assert.match(html, /keep text and logos out of the top and bottom 250 px/);
    const withGuides = Buffer.from(await (await fetch(`${baseUrl}/export?image=photo&preset=ig-story&guides=1&format=png`)).arrayBuffer());
    const without = Buffer.from(await (await fetch(`${baseUrl}/export?image=photo&preset=ig-story&format=png`)).arrayBuffer());
    assert.ok(withGuides.equals(without));
  });
});
