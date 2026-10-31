/**
 * Query-string parsing and the option types it produces: image / export / Android / preview
 * state, plus the parameter registries that say which names belong to which scope.
 * Pure: no I/O, no sharp. Every invalid value is a BadRequestError with the documented message.
 */

import { BUCKETS, type Bucket, findBucket, ICON, MAX_DP, validateResourceName } from "./android.ts";
import { type CollageOptions, DEFAULT_GUTTER, findLayout, type Gutter, LAYOUTS, MAX_GUTTER_PERCENT, MAX_GUTTER_PX, MAX_NUDGE, type Nudge } from "./collage.ts";
import { DEVICES, type Device, findDevice, ORIENTATIONS, type Orientation } from "./devices.ts";
import { BadRequestError } from "./errors.ts";
import { parseImageId } from "./images.ts";
import { MAX_DIMENSION } from "./limits.ts";
import { DEFAULT_QUALITY, EXPORT_FORMATS, type ExportFormat, FITS, type Fit, findPreset, MAX_EXPORT_KB, PRESETS, type Preset } from "./presets.ts";
import { validateWatermarkText } from "./watermark-svg.ts";

/** Rotation angles accepted by `/image?rotate=`. */
export const ALLOWED_ROTATIONS = [0, 90, 180, 270] as const;

export type Rotation = (typeof ALLOWED_ROTATIONS)[number];

/** Default watermark inset from the bottom-right edges, in pixels. */
export const DEFAULT_WATERMARK_MARGIN = 16;

/** Default watermark opacity, in percent. */
export const DEFAULT_WATERMARK_OPACITY = 70;

/** Default watermark width when neither width nor height is given, in pixels. */
export const DEFAULT_WATERMARK_WIDTH = 200;

/** A watermark dimension: absolute pixels, or a percentage of the output image's width/height. */
export type WatermarkLength = { px: number } | { percent: number };

export interface WatermarkOptions {
  width?: WatermarkLength;
  height?: WatermarkLength;
  /** Pixels between the watermark and the bottom/right edges. */
  margin: number;
  /** True when `wmMargin` was given (collages otherwise derive the margin from the gutter, 4k). */
  marginGiven: boolean;
  /** 0-100 percent. */
  opacity: number;
  /** Extra offset from the bottom-right anchor, px. Screen convention: +X right, +Y down. */
  traverseX: number;
  traverseY: number;
  /** Per-request mark text (`wmText`), overriding the active stock/custom file for this render only (A5). */
  text?: string;
  /** Green tone 0 (light) .. 100 (dark) for the glyph fill; undefined = the mark's own colours. */
  tone?: number;
}

export interface ImageOptions {
  /** Image id: "sample", a stock id, or an upload id. */
  image: string;
  width?: number;
  height?: number;
  rotate: Rotation;
  /** Enhancements (3b). */
  sharpen: boolean;
  grayscale: boolean;
  /** Rounded corners, 0-100: 0 = square, 100 = radius of min(width, height) / 2. */
  corners: number;
  /** Platform preset: fixes the output size (overrides width/height) and fills it per `fit`. */
  preset?: Preset;
  /** How the image fills a preset: cover = crop (attention strategy), contain = pad with `bg`. */
  fit: Fit;
  /** Background colour (#rrggbb) for contain padding and for flattening transparency into JPEG. */
  bg: string;
  /** Present only when the watermark is switched on (`wm=1`). */
  watermark?: WatermarkOptions;
  /** Collage mode (spec 4k): replaces source + rotate + resize as the first stage. */
  collage?: CollageOptions;
  /** Display scale applied last (spec 3.2 step 7): how a platform shows the finished image small. */
  thumb?: Thumb;
}

/** `thumb` grammar: `N` longest side, `WxH` centre cover-crop, `Wx` width, `xH` height. */
export type Thumb =
  | { fit: "inside"; width: number; height: number }
  | { fit: "cover"; width: number; height: number }
  | { fit: "width"; width: number }
  | { fit: "height"; height: number };
export const THUMB_MIN = 16;
export const THUMB_MAX = 1024;

export function parseThumb(raw: string | null): Thumb | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const error = () =>
    new BadRequestError(`thumb must be N, WxH, Wx or xH with integers between ${THUMB_MIN} and ${THUMB_MAX} (e.g. 150, 150x150, 470x, x300).`);
  const m = /^(\d*)(x?)(\d*)$/.exec(raw.trim());
  if (!m) throw error();
  const [, w, x, h] = m;
  const num = (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < THUMB_MIN || n > THUMB_MAX) throw error();
    return n;
  };
  if (!x) return { fit: "inside", width: num(w!), height: num(w!) };
  if (w && h) return { fit: "cover", width: num(w), height: num(h) };
  if (w) return { fit: "width", width: num(w) };
  if (h) return { fit: "height", height: num(h) };
  throw error();
}

/** Export (download) options: the image options plus the encoding. */
export interface ExportOptions extends ImageOptions {
  format: ExportFormat;
  /** 1-100, ignored for PNG. */
  quality: number;
  /** Optional file-size target in KB (JPEG/WebP only). */
  maxKB?: number;
}

/** Flag spellings (case-insensitive, trimmed). Exactly what the spec documents; nothing else is accepted (B7). */
export const TRUTHY = new Set(["1", "true", "on"]);

export const FALSY = new Set(["0", "false", "off", ""]);

const FLAG_MESSAGE = "must be one of 1, true, on (or 0, false, off, omitted).";

export function parseInteger(params: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === "") return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function parseDimension(params: URLSearchParams, name: "width" | "height"): number | undefined {
  return parseInteger(params, name, 1, MAX_DIMENSION);
}

/** `200` -> { px: 200 }, `20%` / `12.5%` -> { percent: 20 }, absent -> undefined. */
export function parseWatermarkLength(params: URLSearchParams, name: "wmWidth" | "wmHeight"): WatermarkLength | undefined {
  const raw = (params.get(name) ?? "").trim();
  if (raw === "") return undefined;
  const error = () => new BadRequestError(`${name} must be an integer between 1 and ${MAX_DIMENSION} (px), or a percentage between 1 and 100 (e.g. 20%).`);
  if (raw.endsWith("%")) {
    const percent = Number(raw.slice(0, -1));
    if (!Number.isFinite(percent) || percent < 1 || percent > 100 || !/^\d+(\.\d+)?$/.test(raw.slice(0, -1))) throw error();
    return { percent };
  }
  const px = Number(raw);
  if (!Number.isInteger(px) || px < 1 || px > MAX_DIMENSION) throw error();
  return { px };
}

/** `1`/`true`/`on` -> true, `0`/`false`/`off`/absent -> false, anything else -> 400. */
export function parseFlag(params: URLSearchParams, name: string): boolean {
  const raw = (params.get(name) ?? "").trim().toLowerCase();
  if (FALSY.has(raw)) return false;
  if (TRUTHY.has(raw)) return true;
  throw new BadRequestError(`${name} ${FLAG_MESSAGE}`);
}

function parsePreset(params: URLSearchParams): Preset | undefined {
  const raw = params.get("preset") ?? "";
  if (raw === "" || raw === "none") return undefined;
  const preset = findPreset(raw);
  if (!preset) throw new BadRequestError(`Unknown preset "${raw}". Known presets: ${PRESETS.map((p) => p.id).join(", ")}.`);
  return preset;
}

function parseFit(params: URLSearchParams): Fit {
  const raw = (params.get("fit") ?? "cover") as Fit;
  if (!FITS.includes(raw)) throw new BadRequestError(`fit must be one of ${FITS.join(", ")}.`);
  return raw;
}

function parseColour(params: URLSearchParams, name: string, fallback: string): string {
  const raw = (params.get(name) ?? "").trim();
  if (raw === "") return fallback;
  if (!/^#[0-9a-fA-F]{6}$/.test(raw)) throw new BadRequestError(`${name} must be a hex colour like #ffffff.`);
  return raw.toLowerCase();
}

/** Parse and validate the `/export` query: image options plus format, quality and maxKB. */
export function parseExportOptions(params: URLSearchParams): ExportOptions {
  const image = parseImageOptions(params);
  const format = (params.get("format") ?? "png") as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) throw new BadRequestError(`format must be one of ${EXPORT_FORMATS.join(", ")}.`);
  const quality = parseInteger(params, "quality", 1, 100) ?? DEFAULT_QUALITY;
  const maxKB = parseInteger(params, "maxKB", 1, MAX_EXPORT_KB);
  if (maxKB !== undefined && format === "png") throw new BadRequestError("maxKB applies to JPEG and WebP only (PNG is lossless).");
  return { ...image, format, quality, maxKB };
}

function parseWatermark(params: URLSearchParams): WatermarkOptions | undefined {
  const flag = (params.get("wm") ?? "").trim().toLowerCase();
  if (FALSY.has(flag)) return undefined;
  if (!TRUTHY.has(flag)) {
    throw new BadRequestError(`wm ${FLAG_MESSAGE}`);
  }
  return {
    width: parseWatermarkLength(params, "wmWidth"),
    height: parseWatermarkLength(params, "wmHeight"),
    margin: parseInteger(params, "wmMargin", 0, MAX_DIMENSION) ?? DEFAULT_WATERMARK_MARGIN,
    marginGiven: (params.get("wmMargin") ?? "").trim() !== "",
    opacity: parseInteger(params, "wmOpacity", 0, 100) ?? DEFAULT_WATERMARK_OPACITY,
    traverseX: parseInteger(params, "traverseX", -MAX_DIMENSION, MAX_DIMENSION) ?? 0,
    traverseY: parseInteger(params, "traverseY", -MAX_DIMENSION, MAX_DIMENSION) ?? 0,
    text: parseWatermarkText(params),
    tone: parseInteger(params, "wmTone", 0, 100),
  };
}

/** `wmText`: 1-80 chars, no control characters (glyph coverage is checked when the mark is built). */
function parseWatermarkText(params: URLSearchParams): string | undefined {
  const raw = params.get("wmText");
  if (raw === null) return undefined;
  const problem = validateWatermarkText(raw);
  if (problem) throw new BadRequestError(`wmText: ${problem}.`);
  return raw;
}

function parseRotation(params: URLSearchParams): Rotation {
  const raw = params.get("rotate");
  if (raw === null || raw === "") return 0;

  const value = Number(raw);
  if (!(ALLOWED_ROTATIONS as readonly number[]).includes(value)) {
    throw new BadRequestError(`rotate must be one of ${ALLOWED_ROTATIONS.join(", ")}.`);
  }
  return value as Rotation;
}

/** `gutter`: px 0-512 or `0%`-`20%` of the canvas' shorter side. */
function parseGutter(params: URLSearchParams): Gutter {
  const raw = (params.get("gutter") ?? "").trim();
  if (raw === "") return DEFAULT_GUTTER;
  const error = () =>
    new BadRequestError(`gutter must be an integer between 0 and ${MAX_GUTTER_PX} (px), or a percentage between 0 and ${MAX_GUTTER_PERCENT} (e.g. 2%).`);
  if (raw.endsWith("%")) {
    const body = raw.slice(0, -1);
    const percent = Number(body);
    if (!/^\d+(\.\d+)?$/.test(body) || percent < 0 || percent > MAX_GUTTER_PERCENT) throw error();
    return { percent };
  }
  const px = Number(raw);
  if (!Number.isInteger(px) || px < 0 || px > MAX_GUTTER_PX) throw error();
  return { px };
}

/** Collage parameters (4k). Only when `layout` is set; the other collage params are ignored otherwise. */
function parseCollage(params: URLSearchParams, rotate: Rotation, width?: number, height?: number, preset?: Preset): CollageOptions | undefined {
  const raw = (params.get("layout") ?? "").trim();
  if (raw === "" || raw === "none") return undefined;
  const layout = findLayout(raw);
  if (!layout) throw new BadRequestError(`Unknown layout "${raw}". Known layouts: ${LAYOUTS.map((l) => l.id).join(", ")}.`);
  if (rotate !== 0) throw new BadRequestError("rotate does not apply to a collage.");
  if (!preset && (width === undefined) !== (height === undefined)) throw new BadRequestError("A collage needs a preset or both width and height.");
  const ids = params
    .getAll("cells")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim());
  const cells: Array<string | null> = layout.cells.map((_, i) => {
    const id = ids[i] ?? "";
    return id === "" ? null : parseImageId(id);
  });
  const fitList = params
    .getAll("cellFit")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "") as Fit[];
  for (const f of fitList) if (!FITS.includes(f)) throw new BadRequestError(`cellFit must be one of ${FITS.join(", ")}.`);
  const cellFit: Fit = fitList[0] ?? "cover";
  const cellFits = layout.cells.map((_, i) => fitList[i] ?? cellFit);
  const nudgeList = (name: "cellX" | "cellY") =>
    params
      .getAll(name)
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .map((v) => {
        if (v === "") return 0;
        const n = Number(v);
        if (!Number.isInteger(n) || n < -MAX_NUDGE || n > MAX_NUDGE)
          throw new BadRequestError(`${name} entries must be integers between -${MAX_NUDGE} and ${MAX_NUDGE}.`);
        return n;
      });
  const xs = nudgeList("cellX"),
    ys = nudgeList("cellY");
  const nudges: Nudge[] = layout.cells.map((_, i) => ({ x: xs[i] ?? 0, y: ys[i] ?? 0 }));
  return { layout, cells, gutter: parseGutter(params), cellCorners: parseInteger(params, "cellCorners", 0, 100) ?? 0, cellFit, cellFits, nudges };
}

/** Parse and validate the `/image` query string. Throws `BadRequestError` on invalid input. */
export function parseImageOptions(params: URLSearchParams): ImageOptions {
  const width = parseDimension(params, "width");
  const height = parseDimension(params, "height");
  const rotate = parseRotation(params);
  const preset = parsePreset(params);
  const options: ImageOptions = {
    image: parseImageId(params.get("image")),
    width,
    height,
    rotate,
    sharpen: parseFlag(params, "sharpen"),
    grayscale: parseFlag(params, "grayscale"),
    corners: parseInteger(params, "corners", 0, 100) ?? 0,
    preset,
    fit: parseFit(params),
    bg: parseColour(params, "bg", "#ffffff"),
    watermark: parseWatermark(params),
    collage: parseCollage(params, rotate, width, height, preset),
    thumb: parseThumb(params.get("thumb")),
  };
  return options;
}

export const ANDROID_MODES = ["drawable", "icon"] as const;

export type AndroidMode = (typeof ANDROID_MODES)[number];

export const ANDROID_FORMATS = ["png", "webp"] as const;

export type AndroidFormat = (typeof ANDROID_FORMATS)[number];

export interface AndroidOptions {
  image: ImageOptions;
  mode: AndroidMode;
  name: string;
  /** Drawable size in dp (height optional: from the source aspect when omitted). */
  dpWidth: number;
  dpHeight?: number;
  buckets: Bucket[];
  nodpi: boolean;
  format: AndroidFormat;
}

/** Parse the Android card's parameters (plus the image options they apply to). */
export function parseAndroidOptions(params: URLSearchParams): AndroidOptions {
  const image = parseImageOptions(params);
  const mode = (params.get("androidMode") ?? "drawable") as AndroidMode;
  if (!ANDROID_MODES.includes(mode)) throw new BadRequestError(`androidMode must be one of ${ANDROID_MODES.join(", ")}.`);
  const name = (params.get("androidName") ?? "").trim() || (mode === "icon" ? "ic_launcher" : "image");
  const nameError = validateResourceName(name);
  if (nameError) throw new BadRequestError(`Android name: ${nameError}`);
  const dpWidth = parseInteger(params, "dp", 1, MAX_DP) ?? (mode === "icon" ? ICON.adaptiveDp : 360);
  const dpHeight = parseInteger(params, "dpHeight", 1, MAX_DP);
  const chosen = params
    .getAll("buckets")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  const buckets =
    chosen.length === 0
      ? [...BUCKETS]
      : chosen.map((id) => {
          const b = findBucket(id);
          if (!b) throw new BadRequestError(`Unknown density bucket "${id}". Known buckets: ${BUCKETS.map((x) => x.id).join(", ")}.`);
          return b;
        });
  const uniq = [...new Map(buckets.map((b) => [b.id, b])).values()].sort((a, b) => a.scale - b.scale);
  const format = (params.get("androidFormat") ?? "png") as AndroidFormat;
  if (!ANDROID_FORMATS.includes(format)) throw new BadRequestError(`androidFormat must be one of ${ANDROID_FORMATS.join(", ")}.`);
  return { image, mode, name, dpWidth, dpHeight, buckets: uniq, nodpi: parseFlag(params, "nodpi"), format };
}

/** Query parameters that the viewer page forwards to `/image`. */
export const IMAGE_PARAMS = [
  "image",
  "width",
  "height",
  "rotate",
  "preset",
  "fit",
  "bg",
  "sharpen",
  "grayscale",
  "corners",
  "wm",
  "wmWidth",
  "wmHeight",
  "wmMargin",
  "wmOpacity",
  "wmText",
  "wmTone",
  "traverseX",
  "traverseY",
  "layout",
  "cells",
  "gutter",
  "cellCorners",
  "cellFit",
  "cellX",
  "cellY",
  "thumb",
] as const;

/** Export-only parameters: kept in the page URL and the Download link, never sent to `/image`. */
export const EXPORT_PARAMS = ["format", "quality", "maxKB"] as const;

/** Page-level (non-image) parameters: preview mode, device, orientation, embed (image-only page). */
export const VIEWS = ["desktop", "mobile", "context"] as const;
/** In-context scenes (spec 4.9) and their size options. */
export const SCENES = ["grid", "list", "feed"] as const;
export type Scene = (typeof SCENES)[number];
export const TILE_SIZES = [96, 150, 240] as const;
export const ROW_SIZES = [48, 64, 96] as const;
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
/** Width of the feed column, CSS px. */
export const FEED_WIDTH = 470;

export type View = (typeof VIEWS)[number];

export interface PreviewState {
  view: View;
  device: Device;
  orientation: Orientation;
  /** `embed=image`: only the image (inside the device frame); `embed=scene`: only the in-context scene. */
  embed: false | "image" | "scene";
  /** `guides=1`: draw safe-area / cut-out guides over the preview (never in exports). */
  guides: boolean;
  /** In-context view (4.9). */
  scene: Scene;
  tile: (typeof TILE_SIZES)[number];
  row: (typeof ROW_SIZES)[number];
  theme: Theme;
  /** `frame=1`: show the feed scene inside the device frame. */
  frame: boolean;
}

/** Largest on-screen box the device frame is scaled to fit into (CSS px). */
export const FRAME_MAX = { width: 1040, height: 720 };

/** Parse view/device/orientation/embed from the page query. Throws BadRequestError on unknown values. */
export function parsePreviewState(params: URLSearchParams): PreviewState {
  const view = (params.get("view") ?? "desktop") as View;
  if (!VIEWS.includes(view)) throw new BadRequestError(`view must be one of ${VIEWS.join(", ")}.`);

  const slug = params.get("device") ?? DEVICES[0]!.slug;
  const device = findDevice(slug);
  if (!device) throw new BadRequestError(`Unknown device "${slug}". Known devices: ${DEVICES.map((d) => d.slug).join(", ")}.`);

  const orientation = (params.get("orientation") ?? "portrait") as Orientation;
  if (!ORIENTATIONS.includes(orientation)) throw new BadRequestError(`orientation must be one of ${ORIENTATIONS.join(", ")}.`);

  const embed = params.get("embed") ?? "";
  if (embed !== "" && embed !== "image" && embed !== "scene") throw new BadRequestError('embed must be "image" or "scene" (or omitted).');

  const scene = (params.get("scene") ?? "grid") as Scene;
  if (!SCENES.includes(scene)) throw new BadRequestError(`scene must be one of ${SCENES.join(", ")}.`);
  const oneOf = <T extends readonly number[]>(name: string, sizes: T, fallback: T[number]): T[number] => {
    const raw = params.get(name);
    if (raw === null || raw === "") return fallback;
    const n = Number(raw);
    if (!sizes.includes(n)) throw new BadRequestError(`${name} must be one of ${sizes.join(", ")}.`);
    return n as T[number];
  };
  const tile = oneOf("tile", TILE_SIZES, 150);
  const row = oneOf("row", ROW_SIZES, 64);
  const theme = (params.get("theme") ?? "light") as Theme;
  if (!THEMES.includes(theme)) throw new BadRequestError(`theme must be one of ${THEMES.join(", ")}.`);

  return {
    view,
    device,
    orientation,
    embed: embed === "" ? false : embed,
    guides: parseFlag(params, "guides"),
    scene,
    tile,
    row,
    theme,
    frame: parseFlag(params, "frame"),
  };
}

/** Export fields for the form even when the query is invalid: fall back to defaults per field. */
export function parseExportOptionsLoose(exportQuery: URLSearchParams): { format: ExportFormat; quality: number; maxKB?: number } {
  const format = (exportQuery.get("format") ?? "png") as ExportFormat;
  const q = Number(exportQuery.get("quality"));
  const m = Number(exportQuery.get("maxKB"));
  return {
    format: EXPORT_FORMATS.includes(format) ? format : "png",
    quality: Number.isInteger(q) && q >= 1 && q <= 100 ? q : DEFAULT_QUALITY,
    maxKB: Number.isInteger(m) && m >= 1 && m <= MAX_EXPORT_KB ? m : undefined,
  };
}

export function parseColourLoose(raw: string | null): string {
  return raw && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : "#ffffff";
}

/**
 * Fill the viewer page template: the <img src> gets the validated query
 * forwarded, the form fields echo the current values, and an invalid query
 * shows its message instead of a broken image.
 */
/** Page-level parameters the watermark-text form carries along so its redirect returns to the same page. */
/** Android-card parameters: page-only, kept in the URL and the ZIP link. */
export const ANDROID_PARAMS = ["androidMode", "androidName", "dp", "dpHeight", "buckets", "nodpi", "androidFormat"] as const;

export const PASSTHROUGH_PARAMS = [
  ...IMAGE_PARAMS,
  ...EXPORT_PARAMS,
  ...ANDROID_PARAMS,
  "appliedTraverseX",
  "appliedTraverseY",
  "view",
  "device",
  "orientation",
  "guides",
  "wmToneOn",
  "scene",
  "tile",
  "row",
  "theme",
  "frame",
] as const;
