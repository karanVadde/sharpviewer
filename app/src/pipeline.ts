/**
 * The image pipeline: native-size cache, compose() (rotate -> preset fit / resize -> sharpen ->
 * grayscale -> watermark -> rounded corners), the PNG preview and the encoded export with
 * its file-size search.
 */
import sharp, { type OverlayOptions, type Sharp } from "sharp";
import { cached } from "./cache.ts";
import { type CollageOptions, cellRects, clampNudge, coverScaled, gutterPx, type Nudge, nudgeRange } from "./collage.ts";
import { BadRequestError } from "./errors.ts";
import { collageWatermarkMargin, cornerMask, cornerRadius, outputSize, placeWatermark, type Size, thumbSize, watermarkSize } from "./geometry.ts";
import { fileKey, type ImageSource, resolveImage, SAMPLE_IMAGE } from "./images.ts";
import type { ExportOptions, ImageOptions, WatermarkOptions } from "./params.ts";
import { type ExportFormat, MIN_SEARCH_QUALITY } from "./presets.ts";
import { autoTone, customWatermarkPath, markFor, readActiveWatermark, renderWatermark, watermarkPath } from "./watermark.ts";

export interface NativeSizes {
  image: Size;
  mark: Size;
  /** sharp's format name of the source ("jpeg", "png", "webp", ...). */
  format: string;
}

const nativeSizes = new Map<string, { key: string; sizes: Promise<NativeSizes> }>();

/**
 * Native pixel sizes of an image and the active watermark. Cached per image, keyed on the
 * files' modification times, so a regenerated/restored watermark or a replaced file is
 * picked up on the next request without restarting the server.
 */
/** mtime/size key of the source image and both watermark files: changes whenever any of them does. */
export async function sourceKey(imageId: string): Promise<string> {
  const source = await resolveImage(imageId);
  return (await Promise.all([fileKey(source.path), fileKey(customWatermarkPath), fileKey(watermarkPath)])).join("|");
}

export async function getNativeSizes(imageId: string = SAMPLE_IMAGE.id): Promise<NativeSizes> {
  const source = await resolveImage(imageId);
  const key = await sourceKey(imageId);
  const cached = nativeSizes.get(source.id);
  if (cached?.key !== key) {
    const sizes = Promise.all([sharp(source.path).metadata(), readActiveWatermark().then((mark) => sharp(mark.svg).metadata())]).then(([image, mark]) => ({
      image: { width: image.width ?? 0, height: image.height ?? 0 },
      mark: { width: mark.width ?? 0, height: mark.height ?? 0 },
      format: image.format ?? "",
    }));
    nativeSizes.set(source.id, { key, sizes });
    // A failed lookup (file replaced mid-read, unreadable mark) must not be served to every later
    // request until the key changes: drop it so the next call retries.
    sizes.catch(() => {
      if (nativeSizes.get(source.id)?.sizes === sizes) nativeSizes.delete(source.id);
    });
    return sizes;
  }
  return cached.sizes;
}

/** Load the sample image, apply the requested transforms and encode as PNG. */
/**
 * Run the whole pipeline and return a sharp instance holding the composed image (ready
 * for an output format): rotate -> preset fit / resize -> sharpen -> grayscale ->
 * watermark -> rounded corners.
 */
/**
 * Collage first stage (4k): each cell rendered at its own pixel size (cover = attention crop,
 * contain = pad with bg), optionally rounded, all composited once onto a bg canvas. Returns raw RGBA.
 */
export async function renderCollage(
  collage: CollageOptions,
  canvas: Size,
  bg: string,
): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> {
  const rects = cellRects(collage.layout, canvas, gutterPx(collage.gutter, canvas));
  const sources: Array<ImageSource | null> = [];
  for (const [i, id] of collage.cells.entries()) {
    if (id === null) {
      sources.push(null);
      continue;
    }
    try {
      sources.push(await resolveImage(id));
    } catch (error) {
      throw new BadRequestError(`Cell ${i + 1}: ${(error as Error).message}`);
    }
  }
  const layers: OverlayOptions[] = [];
  for (const [i, rect] of rects.entries()) {
    const source = sources[i];
    if (!source) continue;
    let cell = sharp(source.path).rotate(); // phone uploads are already upright; rotate() is a no-op guard for EXIF in stock files
    const fit = collage.cellFits[i] ?? collage.cellFit;
    const nudge = collage.nudges[i] ?? { x: 0, y: 0 };
    if (fit === "cover" && (nudge.x !== 0 || nudge.y !== 0)) {
      // Nudged cover (4k phase 3): the attention crop window, shifted and clamped inside the scaled picture.
      const { base, scaled } = await attentionBase(source.path, rect);
      const shifted = clampNudge(nudge, nudgeRange(await sourceDims(source.path), rect, base));
      cell = cell
        .resize(scaled.width, scaled.height, { fit: "fill" })
        .extract({ left: base.left + shifted.x, top: base.top + shifted.y, width: rect.width, height: rect.height });
    } else {
      cell =
        fit === "cover"
          ? cell.resize(rect.width, rect.height, { fit: "cover", position: sharp.strategy.attention })
          : cell.resize(rect.width, rect.height, { fit: "contain", background: bg });
    }
    const radius = cornerRadius(rect, collage.cellCorners);
    let data: Buffer;
    if (radius > 0) {
      const raw = await cell.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      data = await sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: 4 } })
        .composite([{ input: cornerMask(rect, radius), blend: "dest-in" }])
        .png()
        .toBuffer();
    } else {
      data = await cell.png().toBuffer();
    }
    layers.push({ input: data, left: rect.left, top: rect.top });
  }
  const base = sharp({ create: { width: canvas.width, height: canvas.height, channels: 4, background: bg } });
  return (layers.length ? base.composite(layers) : base).raw().toBuffer({ resolveWithObject: true });
}

async function sourceDims(path: string): Promise<Size> {
  const m = await sharp(path).metadata();
  const swap = (m.orientation ?? 1) >= 5;
  return { width: (swap ? m.height : m.width) ?? 0, height: (swap ? m.width : m.height) ?? 0 };
}

/** Where sharp's attention strategy puts the cover crop window for a source in a cell, in scaled-picture px. */
export async function attentionBase(path: string, cell: Size): Promise<{ base: { left: number; top: number }; scaled: Size }> {
  const { info } = await sharp(path)
    .rotate()
    .resize(cell.width, cell.height, { fit: "cover", position: sharp.strategy.attention })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scaled = coverScaled(await sourceDims(path), cell);
  return { base: { left: -(info.cropOffsetLeft ?? 0), top: -(info.cropOffsetTop ?? 0) }, scaled };
}

/** The clamped nudge for a filled cover cell (what the render will actually use), or null when the nudge does not apply. */
export async function effectiveNudge(
  collage: CollageOptions,
  index: number,
  rect: Size,
  path: string,
): Promise<{ applied: Nudge; range: { x: [number, number]; y: [number, number] } } | null> {
  const fit = collage.cellFits[index] ?? collage.cellFit;
  if (fit !== "cover") return null;
  const { base } = await attentionBase(path, rect);
  const range = nudgeRange(await sourceDims(path), rect, base);
  return { applied: clampNudge(collage.nudges[index] ?? { x: 0, y: 0 }, range), range };
}

/** Diagnostic / test hook: how many times the two-stage path rendered stage 1 to raw pixels. */
export const pipelineStats = { stage1Renders: 0 };

export async function compose(options: ImageOptions): Promise<Sharp> {
  const source = await resolveImage(options.image);
  const native = await getNativeSizes(options.image);
  const output = outputSize(native.image, options);
  const radius = cornerRadius(output, options.corners);

  // Validate the watermark placement up front (A7): same helpers the page uses, so a request
  // that cannot be satisfied is rejected before libvips does any work. The sizes computed here
  // are exact (outputSize() is passed to sharp explicitly below), so the checked geometry is
  // the rendered geometry.
  let placement: { size: Size; left: number; top: number } | undefined;
  if (options.watermark !== undefined) {
    const size = watermarkSize(await markNativeSize(native, options.watermark), options.watermark, output);
    const wm = effectiveWatermark(options, output, size);
    placement = { size, ...placeWatermark(output, size, wm) };
  }

  let pipeline: Sharp;
  if (options.collage) {
    // Collage (4k): the canvas with every cell composited is the "source"; nothing to rotate/resize.
    const canvas = await renderCollage(options.collage, output, options.bg);
    pipeline = sharp(canvas.data, { raw: { width: canvas.info.width, height: canvas.info.height, channels: canvas.info.channels as 1 | 2 | 3 | 4 } });
  } else {
    pipeline = sharp(source.path);
  }

  if (!options.collage && options.rotate !== 0) {
    pipeline = pipeline.rotate(options.rotate);
  }

  if (options.collage) {
    // already at canvas size
  } else if (options.preset) {
    // Fixed platform size: crop to fill (keeping the "interesting" region) or pad with bg.
    pipeline =
      options.fit === "cover"
        ? pipeline.resize(output.width, output.height, { fit: "cover", position: sharp.strategy.attention })
        : pipeline.resize(output.width, output.height, { fit: "contain", background: options.bg });
  } else if (options.width !== undefined || options.height !== undefined) {
    // Always give sharp both dimensions, computed by outputSize(): codecs that shrink on load
    // (JPEG, WebP) round the auto-sized side slightly differently per format, and the page
    // validates against outputSize() before rendering, so the two must agree exactly.
    pipeline = pipeline.resize(output.width, output.height, { fit: "fill" });
  }

  // Enhancements: sharpen the output size (not the source), then grayscale.
  if (options.sharpen) pipeline = pipeline.sharpen();
  if (options.grayscale) pipeline = pipeline.grayscale();

  if (placement === undefined && radius === 0) {
    return pipeline;
  }

  // Second stage: sharp runs `composite` before colour ops inside one pipeline, so the
  // watermark and the corner mask are applied to the finished first stage. The mark goes
  // on first (sized against the final output, bottom-right of what the viewer sees), the
  // rounded-corner mask last, so the whole composition is clipped - as a feed would show it.
  pipelineStats.stage1Renders += 1;
  const base = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const layers: OverlayOptions[] = [];
  if (placement !== undefined && options.watermark !== undefined) {
    const mark = await renderWatermark(effectiveWatermark(options, output, placement.size), placement.size);
    layers.push({ input: mark.data, raw: { width: mark.width, height: mark.height, channels: 4 }, left: placement.left, top: placement.top });
  }
  if (radius > 0) layers.push({ input: cornerMask(base.info, radius), blend: "dest-in" });

  return sharp(base.data, { raw: { width: base.info.width, height: base.info.height, channels: base.info.channels } }).composite(layers);
}

/** The preview: the composed image as PNG. */
/**
 * The watermark options as rendered on a collage (4k): without `wmMargin` the margin is derived
 * from the gutter, and when that puts the mark in the margin band - i.e. on the background colour -
 * and no `wmTone` was given, the tone is chosen to contrast with `bg` (I-8: the cream default is
 * invisible on a white background). Single images and explicit values are untouched.
 */
export function effectiveWatermark(options: ImageOptions, output: Size, mark: Size): WatermarkOptions & { autoTone?: boolean } {
  const wm = options.watermark!;
  if (!options.collage || wm.marginGiven) return wm;
  const gutter = gutterPx(options.collage.gutter, output);
  const inBand = gutter >= mark.height;
  const margin = collageWatermarkMargin(gutter, mark.height);
  if (!inBand || wm.tone !== undefined) return { ...wm, margin };
  return { ...wm, margin, tone: autoTone(options.bg), autoTone: true };
}

/** Native size of the mark a render will use: the per-request text's SVG canvas, or the active file's. */
export async function markNativeSize(native: NativeSizes, watermark: Pick<WatermarkOptions, "text">): Promise<Size> {
  if (watermark.text === undefined) return native.mark;
  return (await markFor(watermark)).size!;
}

/** Cache key for a render: kind + normalised options (parsed, so spelling/order do not matter) + file keys. */
async function renderKey(kind: string, options: ImageOptions | ExportOptions): Promise<string> {
  const cellKeys = options.collage ? await Promise.all(options.collage.cells.map((id) => (id ? sourceKey(id).catch(() => "missing") : "empty"))) : [];
  return `${kind}|${JSON.stringify(options)}|${await sourceKey(options.image)}|${cellKeys.join(",")}`;
}

/**
 * Display scale (spec 3.2 step 7): the finished composition scaled the way a platform renders a
 * thumbnail - a third stage on the composed pixels, so the watermark, corners and tone shrink with
 * the picture. `cover` centre-crops to the exact size; the other forms never upscale.
 */
export async function composeDisplay(options: ImageOptions): Promise<Sharp> {
  const composed = await compose(options);
  if (!options.thumb) return composed;
  const { data, info } = await composed.raw().toBuffer({ resolveWithObject: true });
  const target = thumbSize(info, options.thumb);
  const base = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels as 1 | 2 | 3 | 4 } });
  return options.thumb.fit === "cover"
    ? base.resize(target.width, target.height, { fit: "cover", position: "centre" })
    : base.resize(target.width, target.height, { fit: "fill" });
}

export async function renderImage(options: ImageOptions): Promise<Buffer> {
  const entry = await cached(await renderKey("image", options), async () => ({ bytes: await (await composeDisplay(options)).png().toBuffer() }));
  return entry.bytes;
}

export interface ExportResult {
  bytes: Buffer;
  contentType: string;
  filename: string;
  /** Quality actually used (PNG: undefined). */
  quality?: number;
  /** Set when maxKB could not be met even at the lowest quality. */
  warning?: string;
}

const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

const EXPORT_EXTENSIONS: Record<ExportFormat, string> = { png: "png", jpeg: "jpg", webp: "webp" };

const thumbLabel = (t: NonNullable<ImageOptions["thumb"]>) =>
  t.fit === "inside" ? String(t.width) : t.fit === "cover" ? `${t.width}x${t.height}` : t.fit === "width" ? `${t.width}x` : `x${t.height}`;

/** `photo-ig-square-1080x1080-grey-wm.jpg` */
export function exportFilename(options: ExportOptions, output: Size, label: string): string {
  const base =
    label
      .replace(/\.[a-z0-9]+$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "image";
  const stem = options.collage ? `collage-${options.collage.layout.id}` : base;
  const parts = [
    stem,
    options.preset ? options.preset.id : null,
    `${output.width}x${output.height}`,
    options.grayscale ? "grey" : null,
    options.watermark ? "wm" : null,
    options.thumb ? `thumb${thumbLabel(options.thumb)}` : null,
  ];
  return `${parts.filter(Boolean).join("-")}.${EXPORT_EXTENSIONS[options.format]}`;
}

/**
 * Encode at `quality`; if the result is over `limit` bytes, binary-search the highest quality in
 * [floor, quality - 1] that fits (at most ~7 more encodes). The floor is `min(MIN_SEARCH_QUALITY,
 * quality)`, so a request below the floor is never answered with a *bigger* file (B2). When nothing
 * fits, the lowest attempted encode (always the floor) is returned as is, not re-encoded (B8).
 */
export async function fitToLimit(
  encode: (quality: number) => Promise<Buffer>,
  quality: number,
  limit: number | undefined,
  floor: number = MIN_SEARCH_QUALITY,
): Promise<{ bytes: Buffer; quality: number; reached: boolean }> {
  const bytes = await encode(quality);
  if (limit === undefined || bytes.length <= limit) return { bytes, quality, reached: true };
  let lowest = { q: quality, b: bytes };
  let best: { q: number; b: Buffer } | undefined;
  let lo = Math.min(floor, quality),
    hi = quality - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await encode(mid);
    if (mid < lowest.q) lowest = { q: mid, b };
    if (b.length <= limit) {
      best = { q: mid, b };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return { bytes: best.b, quality: best.q, reached: true };
  return { bytes: lowest.b, quality: lowest.q, reached: false };
}

/**
 * Download: the composed image encoded as requested. Metadata is stripped (sharp default).
 * With maxKB, the highest quality <= the requested one whose file fits is found by binary
 * search (at most ~7 encodes); if even MIN_SEARCH_QUALITY is too big, that is delivered
 * with a warning.
 */
export async function renderExport(options: ExportOptions): Promise<ExportResult> {
  const entry = await cached(await renderKey("export", options), async () => {
    const result = await renderExportUncached(options);
    return { bytes: result.bytes, meta: { quality: result.quality, warning: result.warning, filename: result.filename } };
  });
  return {
    bytes: entry.bytes,
    contentType: EXPORT_CONTENT_TYPES[options.format],
    filename: String(entry.meta?.filename ?? ""),
    quality: entry.meta?.quality === undefined ? undefined : Number(entry.meta.quality),
    warning: entry.meta?.warning === undefined ? undefined : String(entry.meta.warning),
  };
}

async function renderExportUncached(options: ExportOptions): Promise<ExportResult> {
  const source = await resolveImage(options.image);
  const native = await getNativeSizes(options.image);
  const output = outputSize(native.image, options);
  const filename = exportFilename(options, output, source.label);

  const composed = await composeDisplay(options);
  if (options.format === "png") {
    return { bytes: await composed.png().toBuffer(), contentType: EXPORT_CONTENT_TYPES.png, filename };
  }

  // Encode from raw pixels so the size search does not redo the pipeline. JPEG has no alpha:
  // flatten transparent corners onto bg.
  const { data, info } = await composed.raw().toBuffer({ resolveWithObject: true });
  const encode = (quality: number) => {
    let s = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    if (options.format === "jpeg") s = s.flatten({ background: options.bg });
    return options.format === "jpeg" ? s.jpeg({ quality }).toBuffer() : s.webp({ quality }).toBuffer();
  };

  const limit = options.maxKB === undefined ? undefined : options.maxKB * 1024;
  const fit = await fitToLimit(encode, options.quality, limit);
  const warning = fit.reached
    ? undefined
    : `Could not get under ${options.maxKB} KB: even quality ${fit.quality} is ${Math.ceil(fit.bytes.length / 1024)} KB. Delivered at quality ${fit.quality}; reduce the size or use a smaller preset.`;
  const { bytes, quality } = fit;
  return { bytes, contentType: EXPORT_CONTENT_TYPES[options.format], filename, quality, warning };
}
