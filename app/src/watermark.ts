/**
 * The active watermark: the stock SVG or the custom text mark written from the UI, and its
 * rasterisation at a requested size/opacity.
 */
import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { BadRequestError } from "./errors.ts";
import type { Size } from "./geometry.ts";
import type { WatermarkOptions } from "./params.ts";
import { buildWatermarkSvg, watermarkTextOf } from "./watermark-svg.ts";

/** Stock watermark (committed, the default). */
export const watermarkPath = fileURLToPath(new URL("../public/watermark.svg", import.meta.url));

/**
 * Custom watermark written from the UI (git-ignored). When present it is the active mark.
 * SHARP_VIEWER_CUSTOM_WATERMARK overrides the location (used by the tests to stay isolated).
 */
export const customWatermarkPath = process.env.SHARP_VIEWER_CUSTOM_WATERMARK || fileURLToPath(new URL("../public/watermark.custom.svg", import.meta.url));

const watermarkFontPath = fileURLToPath(new URL("../tools/fonts/DejaVuSans-Bold.ttf", import.meta.url));

const WATERMARK_FONT_NAME = "DejaVuSans-Bold.ttf";

export interface ActiveWatermark {
  /** SVG bytes of the mark in use. */
  svg: Buffer;
  /** True when the UI-generated custom mark is in use, false for the stock mark. */
  custom: boolean;
  /** The text baked into the mark (from its comment), if known. */
  text: string | null;
  /** True when the mark comes from the request's `wmText` (A5), not from a file. */
  perRequest?: boolean;
  /** Native (SVG canvas) size when known without rasterising (per-request marks). */
  size?: Size;
}

/**
 * The watermark currently in use: the custom one if it exists, else the stock one.
 * Read fresh on every call (libvips caches file inputs by path, so sharp always gets bytes).
 */
/** Cheap completeness check: every mark we write ends with the closing tag. */
const looksComplete = (svg: Buffer) => svg.toString("utf8").trimEnd().endsWith("</svg>");

let warnedCorrupt = "";

export async function readActiveWatermark(): Promise<ActiveWatermark> {
  try {
    const svg = await readFile(customWatermarkPath);
    if (looksComplete(svg)) return { svg, custom: true, text: watermarkTextOf(svg.toString("utf8")) };
    // A truncated custom file (disk full, crash mid-write) must not turn every render into a 500:
    // fall back to the stock mark until the next Set text / Restore replaces it.
    if (warnedCorrupt !== customWatermarkPath) {
      warnedCorrupt = customWatermarkPath;
      console.warn(`Custom watermark ${customWatermarkPath} is incomplete; using the stock mark until it is set again.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const svg = await readFile(watermarkPath);
  return { svg, custom: false, text: watermarkTextOf(svg.toString("utf8")) };
}

/**
 * Generate a custom text watermark and make it the active mark. Atomic: written to a
 * temp file and renamed, so a concurrent request never reads a half-written file.
 */
let fontBytes: Promise<Buffer> | undefined;
const builtMarks = new Map<string, ReturnType<typeof buildWatermarkSvg>>();

/** Build (and memoise, bounded) the SVG mark for a text. Throws BadRequestError for text the font cannot show. */
async function buildMark(text: string, label: string): Promise<ReturnType<typeof buildWatermarkSvg>> {
  const hit = builtMarks.get(text);
  if (hit) return hit;
  fontBytes ??= readFile(watermarkFontPath);
  let built: ReturnType<typeof buildWatermarkSvg>;
  try {
    built = buildWatermarkSvg({ text, font: await fontBytes, fontName: WATERMARK_FONT_NAME });
  } catch (error) {
    throw new BadRequestError(`${label}: ${(error as Error).message}.`);
  }
  if (builtMarks.size >= 64) builtMarks.delete(builtMarks.keys().next().value as string);
  builtMarks.set(text, built);
  return built;
}

/** The mark a render should use: the request's `wmText` if given (A5), else the active file. */
export async function markFor(options: Pick<WatermarkOptions, "text"> | undefined): Promise<ActiveWatermark> {
  if (options?.text === undefined) return readActiveWatermark();
  const built = await buildMark(options.text, "wmText");
  return { svg: Buffer.from(built.svg, "utf8"), custom: false, text: options.text, perRequest: true, size: { width: built.width, height: built.height } };
}

/**
 * Writes are serialised (B10): concurrent Set text requests used to share a temp-file name
 * (`pid + Date.now()`), so one writer renamed a temp file another writer was still filling and
 * readers saw a truncated SVG. Now each write gets a unique temp name AND waits for the previous
 * write, so the file on disk is always a complete mark and the last request wins.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialised<T>(job: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(job, job);
  writeQueue = run.catch(() => {});
  return run;
}

export async function setCustomWatermarkText(text: string): Promise<{ width: number; height: number }> {
  const built = await buildMark(text, "Watermark text");
  await serialised(async () => {
    const tmp = `${customWatermarkPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, built.svg, "utf8");
    await rename(tmp, customWatermarkPath);
  });
  return { width: built.width, height: built.height };
}

/** Remove the custom mark so the stock one is active again. No-op if there is none. */
export async function restoreStockWatermark(): Promise<void> {
  await serialised(async () => {
    try {
      await unlink(customWatermarkPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
}

/**
 * Rasterise the stock SVG watermark at the requested size with the requested
 * opacity. Returns RGBA pixels plus dimensions so the caller can check fit.
 */
export async function renderWatermark(options: WatermarkOptions, size: Size): Promise<{ data: Buffer; width: number; height: number }> {
  // `size` is the resolved pixel size (from watermarkSize); render exactly that. The tone (if any)
  // recolours the SVG before rasterising; sizes are unaffected.
  const svg = Buffer.from(recolourMark((await markFor(options)).svg.toString("utf8"), options.tone), "utf8");
  const pipeline = sharp(svg).resize(size.width, size.height, { fit: "fill" });

  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // Scale the alpha channel to apply opacity (channels are RGBA after ensureAlpha).
  const factor = options.opacity / 100;
  for (let i = 3; i < data.length; i += 4) {
    data[i] = Math.round(data[i]! * factor);
  }
  return { data, width: info.width, height: info.height };
}

// ---------------------------------------------------------------------------
// Green tone scale (spec 4 `wmTone`): linear light -> dark green for the glyph fill.

/** Hue of the tone scale (a natural green), fixed. */
export const TONE_HUE = 152;
const TONE_SATURATION = 0.6;
const TONE_LIGHT = 0.88;
const TONE_DARK = 0.18;
/** The generator's default colours (stock and generated marks both use them). */
const GENERATOR_FILL = "#f6f5f1";
const GENERATOR_STROKE = "#1f2933";

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b]
    .map((v) =>
      Math.round((v! + m) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Fill colour for a tone 0 (light) .. 100 (dark): lightness interpolated linearly, hue and saturation fixed. */
export function toneColour(tone: number): string {
  const l = TONE_LIGHT + (TONE_DARK - TONE_LIGHT) * (tone / 100);
  return hslToHex(TONE_HUE, TONE_SATURATION, l);
}

/** Outline colour: the generator's dark outline on light tones, its light fill colour as outline on dark tones. */
export function toneStroke(tone: number): string {
  return tone > 50 ? GENERATOR_FILL : GENERATOR_STROKE;
}

/** Recolour a generated mark: rewrite exactly the generator's fill and stroke attributes. No tone -> unchanged. */
export function recolourMark(svg: string, tone: number | undefined): string {
  if (tone === undefined) return svg;
  return svg.replaceAll(`stroke="${GENERATOR_STROKE}"`, `stroke="${toneStroke(tone)}"`).replaceAll(`fill="${GENERATOR_FILL}"`, `fill="${toneColour(tone)}"`);
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two #rrggbb colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a),
    lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The end of the tone scale that contrasts better with a background: 100 (dark green) on light, 0 (light green) on dark. */
export function autoTone(bg: string): number {
  return contrastRatio(toneColour(100), bg) >= contrastRatio(toneColour(0), bg) ? 100 : 0;
}

/** Fill colour a mark is rendered with: its tone, or the generator's cream when it has none. */
export function markFill(tone: number | undefined): string {
  return tone === undefined ? GENERATOR_FILL : toneColour(tone);
}
