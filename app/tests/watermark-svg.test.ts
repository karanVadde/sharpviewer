import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { TrueTypeFont } from "../src/ttf.ts";
import { buildWatermarkSvg, pyFloat, validateWatermarkText, watermarkTextOf } from "../src/watermark-svg.ts";

const fontPath = fileURLToPath(new URL("../tools/fonts/DejaVuSans-Bold.ttf", import.meta.url));
const font = readFileSync(fontPath);
const stock = readFileSync(new URL("../public/watermark.svg", import.meta.url), "utf8");
const build = (text: string, extra: Partial<Parameters<typeof buildWatermarkSvg>[0]> = {}) =>
  buildWatermarkSvg({ text, font, fontName: "DejaVuSans-Bold.ttf", ...extra });

describe("TrueType reader", () => {
  const ttf = new TrueTypeFont(font);
  test("basic tables", () => {
    assert.equal(ttf.unitsPerEm, 2048);
    assert.ok(ttf.numGlyphs > 5000);
    assert.ok(ttf.glyphId(0x41)! > 0, "A");
    assert.equal(ttf.glyphId(0x65e5), undefined, "CJK not in DejaVu");
    assert.ok(ttf.advanceWidth(ttf.glyphId(0x41)!) > 1000);
  });
  test("simple and composite glyphs", () => {
    assert.equal(ttf.glyph(ttf.glyphId(0x41)!).kind, "simple");
    const eAcute = ttf.glyph(ttf.glyphId(0xe9)!);
    assert.equal(eAcute.kind, "composite", "é is built from components in DejaVu");
    assert.equal(ttf.glyph(ttf.glyphId(0x20)!).kind, "empty", "space has no outline");
  });
  test("rejects non-TrueType data", () => {
    assert.throws(() => new TrueTypeFont(new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0, 0, 0, 0, 0])), /CFF-based OpenType/);
    assert.throws(() => new TrueTypeFont(new Uint8Array(64)), /not a TrueType font/);
  });
});

describe("pyFloat (Python repr of floats)", () => {
  for (const [v, s] of [
    [46, "46.0"],
    [0, "0.0"],
    [-0, "-0.0"],
    [26.361328125, "26.361328125"],
    [-31.06640625, "-31.06640625"],
    [0.0107421875, "0.0107421875"],
    [1.5e-5, "1.5e-05"],
    [1e16, "1e+16"],
    [-2.5, "-2.5"],
  ] as Array<[number, string]>) {
    test(`${s}`, () => assert.equal(pyFloat(v), s));
  }
});

describe("buildWatermarkSvg", () => {
  test("default text reproduces the committed stock mark byte for byte", () => {
    assert.equal(build("SHARP VIEWER").svg, stock);
  });

  test("output is path-only, integer canvas, rasterises to the declared size and fills it", async () => {
    const { svg, width, height } = build("Hello, World! 123");
    assert.doesNotMatch(svg, /<text/);
    assert.equal((svg.match(/<path /g) ?? []).length, 2);
    assert.ok(Number.isInteger(width) && Number.isInteger(height));
    const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [width, height]);
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
    assert.ok(minX <= 1 && minY <= 1 && maxX >= width - 2 && maxY >= height - 2, JSON.stringify({ minX, minY, maxX, maxY }));
  });

  test("composite glyphs (accents) render and are counted in the bounds", async () => {
    const plain = build("e"),
      accented = build("é");
    assert.ok(accented.height > plain.height, "the acute accent makes the canvas taller");
    assert.equal(accented.width, plain.width);
  });

  test("options: stroke 0 -> single path; colours; size scales the canvas", () => {
    const a = build("ABC", { stroke: 0, fill: "#ff0000" });
    assert.equal((a.svg.match(/<path /g) ?? []).length, 1);
    assert.match(a.svg, /fill="#ff0000"/);
    const big = build("ABC", { size: 88 });
    assert.ok(big.width > build("ABC").width * 1.9);
  });

  test("text is XML-escaped in the comment and round-trips through watermarkTextOf", () => {
    const { svg } = build("A & B <c>");
    assert.doesNotMatch(svg, /<c>/);
    assert.equal(watermarkTextOf(svg), "A & B <c>");
    assert.equal(watermarkTextOf(stock), "SHARP VIEWER");
    assert.equal(watermarkTextOf("<svg/>"), null);
  });

  test("validation", () => {
    const ttf = new TrueTypeFont(font);
    assert.equal(validateWatermarkText("OK", ttf), null);
    assert.match(validateWatermarkText("   ", ttf)!, /must not be empty/);
    assert.match(validateWatermarkText("A".repeat(81), ttf)!, /at most 80 characters/);
    assert.match(validateWatermarkText("a\u0007b", ttf)!, /control characters/);
    assert.equal(validateWatermarkText("日本語", ttf), "font has no glyph for: '日' '本' '語'");
    assert.throws(() => build("日本語"), /no glyph for/);
    assert.throws(() => build("x", { size: 0 }), /size must be > 0/);
    assert.throws(() => build("x", { stroke: -1 }), /stroke must be >= 0/);
  });
});

// Cross-check against the Python generator when it is available (python3 + fonttools).
const probe = spawnSync("python3", ["-c", "import fontTools"], { encoding: "utf8" });
const pySkip = probe.status === 0 ? false : "python3 + fonttools not available";
describe("byte-identical with tools/make-watermark.py", { skip: pySkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-py-"));
  test.after?.(() => rmSync(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../tools/make-watermark.py", import.meta.url));
  const texts = [
    "SHARP VIEWER",
    "DARTH VADER (c) 2026",
    "Hello, World! 123",
    "àéîõü ñ ç ÅØ",
    "A & B <c>",
    "@#$%^*()_+-=[]{};:'\",./?",
    "ijl.|",
    "Ωμέγα",
    "ДЖЁ",
    "a",
    "  spaced  out  ",
  ];
  for (const text of texts) {
    test(JSON.stringify(text), () => {
      const out = join(dir, "py.svg");
      const r = spawnSync("python3", [script, "--text", text, "--out", out], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(build(text).svg, readFileSync(out, "utf8"));
    });
  }
  test("with options", () => {
    const out = join(dir, "opt.svg");
    spawnSync("python3", [
      script,
      "--text",
      "Opts",
      "--size",
      "60",
      "--letter-spacing",
      "5",
      "--stroke",
      "3",
      "--fill",
      "#123456",
      "--stroke-color",
      "#abcdef",
      "--out",
      out,
    ]);
    assert.equal(build("Opts", { size: 60, letterSpacing: 5, stroke: 3, fill: "#123456", strokeColor: "#abcdef" }).svg, readFileSync(out, "utf8"));
  });
});
