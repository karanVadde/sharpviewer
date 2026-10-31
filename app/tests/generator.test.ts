import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const script = fileURLToPath(new URL("../tools/make-watermark.py", import.meta.url));
const stockSvg = fileURLToPath(new URL("../public/watermark.svg", import.meta.url));

/** Run the generator; returns { status, stdout, stderr }. */
function generate(args: string[]) {
  const r = spawnSync("python3", [script, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

// The generator needs python3 + fonttools. Skip (loudly) when they are not available.
const probe = spawnSync("python3", ["-c", "import fontTools"], { encoding: "utf8" });
const available = probe.status === 0;
const skip = available ? false : `python3 + fonttools not available (${probe.error?.message ?? probe.stderr.trim().split("\n").pop()})`;

function canvasOf(svg: string) {
  return { width: Number(/\bwidth="(\d+)"/.exec(svg)?.[1]), height: Number(/\bheight="(\d+)"/.exec(svg)?.[1]) };
}

async function paintedBox(svg: string) {
  const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
  let minX = Infinity,
    minY = Infinity,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! > 0) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  return { minX, minY, maxX, maxY, width: info.width, height: info.height };
}

describe("tools/make-watermark.py (custom text watermark generator)", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-"));
  const out = (name: string) => join(dir, name);
  test.after?.(() => rmSync(dir, { recursive: true, force: true }));

  test("default run reproduces the committed stock watermark byte for byte", () => {
    const r = generate(["--out", out("stock.svg")]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out("stock.svg"), "utf8"), readFileSync(stockSvg, "utf8"));
    assert.match(r.stdout, /"SHARP VIEWER" -> canvas 398x36/);
  });

  test("custom text: valid path-only SVG, integer canvas cropped to the paint", async () => {
    const r = generate(["--text", "DARTH VADER (c) 2026", "--out", out("custom.svg")]);
    assert.equal(r.status, 0, r.stderr);
    const svg = readFileSync(out("custom.svg"), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+" viewBox="-?\d+ -?\d+ \d+ \d+">/);
    assert.doesNotMatch(svg, /<text/, "no font dependency");
    assert.equal((svg.match(/<path /g) ?? []).length, 2, "outline + fill");
    assert.match(svg, /DARTH VADER \(c\) 2026/);
    const canvas = canvasOf(svg);
    const box = await paintedBox(svg);
    assert.deepEqual([box.width, box.height], [canvas.width, canvas.height], "sharp rasterises to the declared canvas");
    assert.ok(
      box.minX <= 1 && box.minY <= 1 && box.maxX >= canvas.width - 2 && box.maxY >= canvas.height - 2,
      `paint fills the canvas: ${JSON.stringify(box)}`,
    );
    assert.match(r.stdout, /wmWidth=200 -> 200x\d+/);
  });

  test("longer text gives a wider canvas; same glyphs give the same height", () => {
    assert.equal(generate(["--text", "AB", "--out", out("short.svg")]).status, 0);
    assert.equal(generate(["--text", "ABABABABAB", "--out", out("long.svg")]).status, 0);
    const a = canvasOf(readFileSync(out("short.svg"), "utf8"));
    const b = canvasOf(readFileSync(out("long.svg"), "utf8"));
    assert.ok(b.width > a.width * 3, `${b.width} vs ${a.width}`);
    assert.equal(a.height, b.height);
  });

  test("--stroke 0 gives a single fill path; colours are applied; text is XML-escaped", () => {
    const r = generate(["--text", "A & B <c>", "--stroke", "0", "--fill", "#ff0000", "--out", out("nostroke.svg")]);
    assert.equal(r.status, 0, r.stderr);
    const svg = readFileSync(out("nostroke.svg"), "utf8");
    assert.equal((svg.match(/<path /g) ?? []).length, 1);
    assert.match(svg, /fill="#ff0000"/);
    assert.doesNotMatch(svg, /<c>/);
    assert.match(svg, /A &amp; B &lt;c&gt;/);
  });

  test("a custom mark works end to end through the watermark pipeline", async () => {
    assert.equal(generate(["--text", "HELLO", "--out", out("hello.svg")]).status, 0);
    const svg = readFileSync(out("hello.svg"), "utf8");
    const mark = await sharp(Buffer.from(svg)).resize(200).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sample = fileURLToPath(new URL("../public/sample.png", import.meta.url));
    const png = await sharp(sample)
      .composite([
        {
          input: mark.data,
          raw: { width: mark.info.width, height: mark.info.height, channels: 4 },
          left: 960 - 16 - mark.info.width,
          top: 640 - 16 - mark.info.height,
        },
      ])
      .png()
      .toBuffer();
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [960, 640]);
  });

  for (const [args, re] of [
    [["--text", "   "], /text must not be empty/],
    [["--text", "日本語"], /no glyph for: '日' '本' '語'/],
    [["--font", "/nope.ttf"], /No such file/],
    [["--size", "0"], /size must be > 0/],
    [["--stroke", "-1"], /stroke must be >= 0/],
  ] as Array<[string[], RegExp]>) {
    test(`rejects ${args.join(" ")}`, () => {
      const r = generate([...args, "--out", out("bad.svg")]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, re);
    });
  }
});
