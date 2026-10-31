import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, utimesSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";

// Isolated uploads directory (other suites run in parallel and must not see these files).
const dir = mkdtempSync(join(tmpdir(), "uploads-"));
process.env.SHARP_VIEWER_UPLOADS = dir;
const app = await import("../src/app.ts");
const images = await import("../src/images.ts");

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

async function upload(file: { name: string; bytes: Buffer; type?: string } | null, fields: Record<string, string> = {}) {
  const fd = new FormData();
  if (file) fd.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type ?? "application/octet-stream" }), file.name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(`${baseUrl}/upload`, { method: "POST", body: fd, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location"), html: await r.text() };
}
async function remove(id: string, fields: Record<string, string> = {}) {
  const r = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ action: "remove", id, ...fields }).toString(),
    redirect: "manual",
  });
  return { status: r.status, location: r.headers.get("location"), html: await r.text() };
}
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const make = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#3b82f6" } });

describe("uploads", () => {
  test("config: isolated directory in effect", () => {
    assert.equal(images.uploadsDir, dir);
  });

  let pngId = "";
  test("PNG upload: stored, redirect selects it, renders through the pipeline, listed in the picker", async () => {
    const bytes = await make(500, 300).png().toBuffer();
    const r = await upload({ name: "My Picture.png", bytes, type: "image/png" }, { wm: "1", wmWidth: "20%", view: "mobile", device: "pixel-7" });
    assert.equal(r.status, 303, r.html);
    const loc = new URL(r.location!, baseUrl);
    pngId = loc.searchParams.get("image")!;
    assert.match(pngId, /^u-[0-9a-f]{16}$/);
    assert.deepEqual(
      [loc.searchParams.get("wm"), loc.searchParams.get("wmWidth"), loc.searchParams.get("view"), loc.searchParams.get("device")],
      ["1", "20%", "mobile", "pixel-7"],
    );
    assert.ok(existsSync(join(dir, `${pngId}.png`)) && existsSync(join(dir, `${pngId}.json`)));

    const img = await fetch(`${baseUrl}/image?image=${pngId}&wm=1&wmWidth=20%&rotate=90`);
    assert.equal(img.status, 200);
    assert.deepEqual(pngSize(Buffer.from(await img.arrayBuffer())), { width: 300, height: 500 });

    const html = await (await fetch(`${baseUrl}/?image=${pngId}`)).text();
    assert.match(html, new RegExp(`<optgroup label="Your uploads"><option value="${pngId}" selected>My Picture.png \\(upload\\)</option>`));
    assert.match(html, /My Picture.png &middot; 500&times;300 &middot; PNG &middot; uploaded/);
    assert.match(html, new RegExp(`<input type="hidden" name="id" value="${pngId}"><button type="submit" class="danger">Remove this upload</button>`));
  });

  test("EXIF orientation is baked in at upload (phone photo comes out upright)", async () => {
    const bytes = await make(640, 360).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = await upload({ name: "phone.jpg", bytes, type: "image/jpeg" });
    assert.equal(r.status, 303, r.html);
    const id = new URL(r.location!, baseUrl).searchParams.get("image")!;
    const stored = await sharp(join(dir, `${id}.jpg`)).metadata();
    assert.deepEqual([stored.width, stored.height, stored.orientation], [360, 640, undefined]);
    assert.deepEqual((await app.getNativeSizes(id)).image, { width: 360, height: 640 });
    const img = await fetch(`${baseUrl}/image?image=${id}`);
    assert.deepEqual(pngSize(Buffer.from(await img.arrayBuffer())), { width: 360, height: 640 });
  });

  test("B5: the orientation bake-in is near-lossless (JPEG q95 4:4:4, WebP q95), not sharp's default q80", async () => {
    // A detailed source so that re-encoding actually costs something.
    const detailed = sharp({ create: { width: 640, height: 360, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } });
    const source = await detailed.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).withMetadata({ orientation: 6 }).toBuffer();
    const r = await upload({ name: "noisy.jpg", bytes: source, type: "image/jpeg" });
    assert.equal(r.status, 303, r.html);
    const id = new URL(r.location!, baseUrl).searchParams.get("image")!;
    const storedPath = join(dir, `${id}.jpg`);
    const meta = await sharp(storedPath).metadata();
    assert.deepEqual([meta.width, meta.height, meta.orientation, meta.chromaSubsampling], [360, 640, undefined, "4:4:4"]);
    // Pixel error vs the upright original stays small (a q80 re-encode of this image is several times worse).
    const upright = await sharp(source).rotate().raw().toBuffer();
    const stored = await sharp(storedPath).raw().toBuffer();
    let sum = 0;
    for (let i = 0; i < upright.length; i++) sum += Math.abs(upright[i]! - stored[i]!);
    const mean = sum / upright.length;
    const q80 = await sharp(await sharp(source).rotate().jpeg().toBuffer())
      .raw()
      .toBuffer();
    let sum80 = 0;
    for (let i = 0; i < upright.length; i++) sum80 += Math.abs(upright[i]! - q80[i]!);
    assert.ok(mean < 1.5, `mean abs error ${mean.toFixed(2)}`);
    assert.ok(mean < sum80 / upright.length / 2, `q95 (${mean.toFixed(2)}) should be far better than q80 (${(sum80 / upright.length).toFixed(2)})`);

    const webpSrc = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } })
      .webp({ quality: 95 })
      .withMetadata({ orientation: 8 })
      .toBuffer();
    const w = await upload({ name: "p.webp", bytes: webpSrc, type: "image/webp" });
    const wid = new URL(w.location!, baseUrl).searchParams.get("image")!;
    const wmeta = await sharp(join(dir, `${wid}.webp`)).metadata();
    assert.deepEqual([wmeta.width, wmeta.height, wmeta.orientation], [32, 64, undefined]);
  });

  test("B9: an upload whose file name contains markup is escaped in the context line, picker and alt", async () => {
    const r = await upload({ name: "<img src=x onerror=alert(2)>&.png", bytes: await make(8, 8).png().toBuffer(), type: "image/png" });
    assert.equal(r.status, 303, r.html);
    const html = await (await fetch(`${baseUrl}${r.location}`)).text();
    assert.doesNotMatch(html, /<img src=x onerror/, "raw markup must not appear anywhere in the page");
    assert.match(html, /<p class="context">&lt;img src=x onerror=alert\(2\)&gt;&amp;\.png &middot; 8&times;8 &middot; PNG &middot; uploaded<\/p>/);
    assert.match(html, /selected>&lt;img src=x onerror=alert\(2\)&gt;&amp;\.png \(upload\)<\/option>/);
    assert.match(html, /alt="&lt;img src=x onerror=alert\(2\)&gt;&amp;\.png with watermark preview"/);
  });

  test("WebP and GIF are accepted; the label falls back when the name is blank", async () => {
    const webp = await upload({ name: "   ", bytes: await make(64, 64).webp().toBuffer(), type: "image/webp" });
    assert.equal(webp.status, 303, webp.html);
    const id = new URL(webp.location!, baseUrl).searchParams.get("image")!;
    assert.ok(existsSync(join(dir, `${id}.webp`)));
    assert.equal((await images.resolveImage(id)).label, "upload");
    const gif = await upload({ name: "anim.gif", bytes: await make(32, 32).gif().toBuffer(), type: "image/gif" });
    assert.equal(gif.status, 303, gif.html);
  });

  test("uploads are listed newest first after the built-ins", async () => {
    const list = await images.listImages();
    assert.deepEqual(
      list.slice(0, 6).map((i) => i.id),
      ["sample", "thumb", "photo", "fhd", "portrait", "panorama"],
    );
    assert.ok(list.slice(6).every((i) => i.kind === "upload") && list.length >= 10);
  });

  for (const [label, file, re] of [
    ["no file", null, /no file was selected/],
    ["empty file", { name: "e.png", bytes: Buffer.alloc(0) }, /no file was selected/],
    ["text file", { name: "x.txt", bytes: Buffer.from("hello") }, /not an image sharp can read/],
    ["svg", { name: "x.svg", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') }, /svg files are not supported/],
  ] as Array<[string, { name: string; bytes: Buffer } | null, RegExp]>) {
    test(`rejected: ${label} -> 400 page with banner, settings kept`, async () => {
      const r = await upload(file, { wm: "1", wmWidth: "300", image: "photo" });
      assert.equal(r.status, 400);
      assert.match(r.html, /<p class="error" role="alert">Upload: /);
      assert.match(r.html, re);
      assert.match(r.html, /<option value="photo" selected>/, "previous selection kept");
      assert.match(r.html, /<img src="\/image\?image=photo&amp;wm=1&amp;wmWidth=300"/);
    });
  }

  test("rejected: too many pixels / too large a side", async () => {
    const wide = await upload({ name: "wide.png", bytes: await make(9000, 10).png().toBuffer() });
    assert.equal(wide.status, 400);
    assert.match(wide.html, /9000x10 is too large; the limit is 8192 px per side/);
  });

  test("rejected: body over the size limit -> 400", async () => {
    const big = Buffer.alloc(images.MAX_UPLOAD_BYTES + 1024, 1);
    const r = await upload({ name: "big.bin", bytes: big }).catch(() => ({ status: 400, location: null, html: "" }));
    assert.equal(r.status, 400);
  });

  test("remove: deletes file + sidecar, drops the selection if it was selected, 400 for unknown", async () => {
    const r = await remove(pngId, { image: pngId, wm: "1" });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/?wm=1");
    assert.ok(!existsSync(join(dir, `${pngId}.png`)) && !existsSync(join(dir, `${pngId}.json`)));
    const gone = await fetch(`${baseUrl}/image?image=${pngId}`);
    assert.equal(gone.status, 400);
    assert.match(await gone.text(), /Unknown image/);
    const unknown = await remove("u-0000000000000000");
    assert.equal(unknown.status, 400);
    assert.match(unknown.html, /Unknown upload/);
    const bad = await remove("../../etc/passwd");
    assert.equal(bad.status, 400);
    assert.match(bad.html, /is not an upload id/);
  });

  test("ids and paths are safe: traversal-looking ids are rejected before touching the disk", async () => {
    for (const id of ["../x", "u-zzzzzzzzzzzzzzzz", "U-0123456789abcdef", "sample/../x"]) {
      const r = await fetch(`${baseUrl}/image?image=${encodeURIComponent(id)}`);
      assert.equal(r.status, 400, id);
    }
    assert.ok(readdirSync(dir).every((f) => /^u-[0-9a-f]{16}\.(png|jpg|webp|gif|tiff|avif|json)$/.test(f)));
  });

  test("GET /upload -> 405 Allow: POST; wrong content type -> 400", async () => {
    const g = await fetch(`${baseUrl}/upload`);
    assert.equal(g.status, 405);
    assert.equal(g.headers.get("allow"), "POST");
    const wrong = await fetch(`${baseUrl}/upload`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    assert.equal(wrong.status, 400);
  });
});

describe("A3: upload index is cached, page views do not rescan the directory", () => {
  test("one directory scan serves many page views; own writes and out-of-band deletes invalidate it", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await upload({
        name: `bulk-${i}.png`,
        bytes: await make(16 + i, 16)
          .png()
          .toBuffer(),
        type: "image/png",
      });
      assert.equal(r.status, 303, r.html);
    }
    const id = new URL((await upload({ name: "last.png", bytes: await make(20, 10).png().toBuffer(), type: "image/png" })).location!, baseUrl).searchParams.get(
      "image",
    )!;
    await fetch(`${baseUrl}/?image=${id}&wm=1&dp=360`); // warm
    const before = images.uploadIndexStats.scans;
    for (let i = 0; i < 3; i++) {
      const html = await (await fetch(`${baseUrl}/?image=${id}&wm=1&wmWidth=20%25&dp=360&androidMode=${i % 2 ? "icon" : "drawable"}`)).text();
      assert.match(html, /last\.png &middot; 20&times;10/);
    }
    assert.equal(images.uploadIndexStats.scans - before, 0, "three page views (image, watermark, android card, picker) must not rescan uploads/");

    // Our own write paths invalidate the index.
    const added = new URL(
      (await upload({ name: "added.png", bytes: await make(9, 9).png().toBuffer(), type: "image/png" })).location!,
      baseUrl,
    ).searchParams.get("image")!;
    assert.equal((await images.resolveImage(added)).label, "added.png");
    await remove(added);
    await assert.rejects(images.resolveImage(added), /Unknown image/);

    // An out-of-band delete (file removed behind the app's back) is noticed too.
    const victim = new URL(
      (await upload({ name: "victim.png", bytes: await make(7, 7).png().toBuffer(), type: "image/png" })).location!,
      baseUrl,
    ).searchParams.get("image")!;
    assert.equal((await images.resolveImage(victim)).label, "victim.png");
    unlinkSync(join(dir, `${victim}.png`));
    unlinkSync(join(dir, `${victim}.json`));
    // Make sure the directory mtime differs even on coarse clocks.
    utimesSync(dir, new Date(), new Date(Date.now() + 2000));
    await assert.rejects(images.resolveImage(victim), /Unknown image/);
    const img = await fetch(`${baseUrl}/image?image=${victim}`);
    assert.equal(img.status, 400);
  });

  test("getNativeSizes carries the source format, so the page needs no extra metadata read", async () => {
    const id = new URL(
      (await upload({ name: "fmt.webp", bytes: await make(12, 12).webp().toBuffer(), type: "image/webp" })).location!,
      baseUrl,
    ).searchParams.get("image")!;
    assert.equal((await app.getNativeSizes(id)).format, "webp");
    assert.equal((await app.getNativeSizes("photo")).format, "jpeg");
  });
});
