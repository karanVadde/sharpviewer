#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Generate a text-only watermark SVG (glyph outline paths) - Node version of
 * tools/make-watermark.py, producing byte-identical output. Needs no Python.
 *
 * Usage (from the project root):
 *   npm run watermark:node -- --text "MY BRAND" [--size 44] [--stroke 2]
 *       [--letter-spacing 2] [--fill "#f6f5f1"] [--stroke-color "#1f2933"]
 *       [--font path/to/font.ttf] [--out public/watermark.svg]
 *
 * Note: writes the STOCK file by default, like the Python script. The UI writes
 * public/watermark.custom.svg instead and leaves the stock file alone.
 */
import { parseArgs } from "node:util";
import { buildWatermarkSvg } from "../src/watermark-svg.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    text: { type: "string", default: "SHARP VIEWER" },
    font: { type: "string", default: resolve(root, "tools/fonts/DejaVuSans-Bold.ttf") },
    size: { type: "string", default: "44" },
    "letter-spacing": { type: "string", default: "2" },
    stroke: { type: "string", default: "2" },
    fill: { type: "string", default: "#f6f5f1" },
    "stroke-color": { type: "string", default: "#1f2933" },
    out: { type: "string", default: resolve(root, "public/watermark.svg") },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    'usage: npm run watermark:node -- --text "MY BRAND" [--size N] [--letter-spacing N] [--stroke N] [--fill COLOR] [--stroke-color COLOR] [--font FILE] [--out FILE]',
  );
  process.exit(0);
}
const num = (name: string, raw: string) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`error: --${name} must be a number`);
    process.exit(2);
  }
  return n;
};
try {
  const { svg, width, height } = buildWatermarkSvg({
    text: values.text!,
    font: readFileSync(values.font!),
    fontName: basename(values.font!),
    size: num("size", values.size!),
    letterSpacing: num("letter-spacing", values["letter-spacing"]!),
    stroke: num("stroke", values.stroke!),
    fill: values.fill!,
    strokeColor: values["stroke-color"]!,
  });
  mkdirSync(dirname(resolve(values.out!)), { recursive: true });
  writeFileSync(values.out!, svg, "utf8");
  console.log(
    `wrote ${relative(process.cwd(), values.out!)}: "${values.text}" -> canvas ${width}x${height} (aspect ${(width / height).toFixed(2)}:1), stroke ${values.stroke}px`,
  );
  console.log(
    `  e.g. wmWidth=200 -> 200x${Math.round((200 * height) / width)}, wmWidth=300 -> 300x${Math.round((300 * height) / width)}, wmHeight=40 -> ${Math.round((40 * width) / height)}x40`,
  );
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
}
