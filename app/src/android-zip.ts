/**
 * Android asset sets (spec 4j): drawable density sets and launcher icons rendered through the
 * pipeline, packed as a ZIP with a README.
 */
import sharp, { type Sharp } from "sharp";
import { BUCKETS, type Bucket, type BucketPlan, dpToPx, formatFactor, ICON, maxDpFor, planBuckets } from "./android.ts";
import { cached } from "./cache.ts";
import { BadRequestError } from "./errors.ts";
import { cornerMask, type Size, sourceSize } from "./geometry.ts";
import { resolveImage } from "./images.ts";
import { MAX_DIMENSION } from "./limits.ts";
import type { AndroidFormat, AndroidOptions, ImageOptions } from "./params.ts";
import { compose, getNativeSizes, sourceKey } from "./pipeline.ts";
import { writeZip, type ZipEntry } from "./zip.ts";

/** The size an Android plan is computed from: the source after rotation. */
export async function androidSource(image: ImageOptions): Promise<Size> {
  return sourceSize((await getNativeSizes(image.image)).image, image);
}

/** `Android: xxxhdpi would be 16384x12288 px; the limit is 4096 px per side (max 1024 dp wide at xxxhdpi). Lower the dp or untick the bucket.` */
function oversizeMessage(bucket: Bucket, width: number, height: number): string {
  return `Android: ${bucket.id} would be ${width}x${height} px; the limit is ${MAX_DIMENSION} px per side (max ${maxDpFor(bucket)} dp wide at ${bucket.id}). Lower the dp or untick the bucket.`;
}

/** Planned buckets split into the ones that fit MAX_DIMENSION and the ones that must be skipped (B1). */
export interface DrawablePlan {
  fit: BucketPlan[];
  skipped: BucketPlan[];
}

/**
 * Bucket plans for a drawable. Buckets whose output would exceed MAX_DIMENSION on either side are
 * skipped (listed in the table and the README) instead of rendered; if none fits the request is
 * rejected. Called before anything is rendered (ZIP) and when the Android card's tables are built (page).
 */
export function planDrawable(source: Size, options: Pick<AndroidOptions, "dpWidth" | "dpHeight" | "buckets">): DrawablePlan {
  const plans = planBuckets(source, options.dpWidth, options.dpHeight, options.buckets);
  const fit = plans.filter((p) => p.verdict !== "too-large");
  const skipped = plans.filter((p) => p.verdict === "too-large");
  if (fit.length === 0 && skipped.length > 0) {
    const first = skipped[0]!;
    throw new BadRequestError(oversizeMessage(first.bucket, first.output.width, first.output.height));
  }
  return { fit, skipped };
}

const encodeAsset = (s: Sharp, format: AndroidFormat) => (format === "webp" ? s.webp({ lossless: true }).toBuffer() : s.png().toBuffer());

/** One drawable at a bucket's pixel size: the full pipeline (enhance, watermark, corners) at that size. */
async function renderDrawable(options: AndroidOptions, plan: BucketPlan): Promise<Buffer> {
  const sized: ImageOptions = options.image.collage
    ? { ...options.image, preset: undefined, width: plan.output.width, height: plan.output.height }
    : options.dpHeight === undefined
      ? { ...options.image, preset: undefined, width: plan.output.width, height: undefined }
      : {
          ...options.image,
          preset: { id: `android-${plan.bucket.id}`, platform: "Android", label: "Android", width: plan.output.width, height: plan.output.height },
        };
  return encodeAsset(await compose(sized), options.format);
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** Adaptive-icon foreground layer: the image contained in the 66 dp safe zone of a 108 dp transparent canvas. */
async function renderIconForeground(options: AndroidOptions, bucket: Bucket): Promise<Buffer> {
  const canvas = dpToPx(ICON.adaptiveDp, bucket),
    safe = dpToPx(ICON.safeDp, bucket);
  const source = await resolveImage(options.image.image);
  let s = sharp(source.path);
  if (options.image.rotate !== 0) s = s.rotate(options.image.rotate);
  s = s.resize(safe, safe, { fit: "contain", background: TRANSPARENT });
  if (options.image.sharpen) s = s.sharpen();
  if (options.image.grayscale) s = s.grayscale();
  const pad = Math.floor((canvas - safe) / 2);
  return s
    .ensureAlpha()
    .extend({ top: pad, bottom: canvas - safe - pad, left: pad, right: canvas - safe - pad, background: TRANSPARENT })
    .png()
    .toBuffer();
}

async function renderIconBackground(options: AndroidOptions, px: number): Promise<Buffer> {
  return sharp({ create: { width: px, height: px, channels: 4, background: options.image.bg } })
    .png()
    .toBuffer();
}

/**
 * The adaptive icon as a launcher would show it: background + foreground, cropped to the
 * visible 72 dp of the 108 dp canvas, at `px` pixels, optionally rounded (legacy icons).
 */
export async function renderIconComposite(options: AndroidOptions, px: number, roundCorners: boolean): Promise<Buffer> {
  const key = `icon|${px}|${roundCorners}|${JSON.stringify(options)}|${await sourceKey(options.image.image)}`;
  return (await cached(key, async () => ({ bytes: await renderIconCompositeUncached(options, px, roundCorners) }))).bytes;
}

async function renderIconCompositeUncached(options: AndroidOptions, px: number, roundCorners: boolean): Promise<Buffer> {
  const bucket = BUCKETS[BUCKETS.length - 1]!; // render at xxxhdpi and scale down for quality
  const canvas = dpToPx(ICON.adaptiveDp, bucket),
    visible = dpToPx(ICON.visibleDp, bucket),
    off = Math.floor((canvas - visible) / 2);
  const fg = await renderIconForeground(options, bucket);
  // Two stages: sharp runs extract before composite within one pipeline.
  const layered = await sharp(await renderIconBackground(options, canvas))
    .composite([{ input: fg }])
    .png()
    .toBuffer();
  const full = await sharp(layered).extract({ left: off, top: off, width: visible, height: visible }).resize(px, px).png().toBuffer();
  if (!roundCorners) return full;
  const radius = Math.round(px * 0.2);
  return sharp(full)
    .composite([{ input: cornerMask({ width: px, height: px }, radius), blend: "dest-in" }])
    .png()
    .toBuffer();
}

export interface AndroidZipResult {
  bytes: Buffer;
  filename: string;
  entries: string[];
  warnings: string[];
}

/** Build the asset ZIP for the Android card. */
export async function renderAndroidZip(options: AndroidOptions): Promise<AndroidZipResult> {
  const source = await androidSource(options.image);
  const entries: ZipEntry[] = [];
  const warnings: string[] = [];
  const ext = options.format === "webp" ? "webp" : "png";
  const lines: string[] = [];

  if (options.mode === "drawable") {
    const { fit: plans, skipped } = planDrawable(source, options);
    lines.push(
      `Drawable "${options.name}" - ${options.dpWidth}${options.dpHeight ? `x${options.dpHeight}` : ""} dp, from a ${source.width}x${source.height} px source`,
      "",
    );
    for (const plan of plans) {
      const path = `res/drawable-${plan.bucket.id}/${options.name}.${ext}`;
      entries.push({ name: path, data: await renderDrawable(options, plan) });
      lines.push(
        `${path}: ${plan.output.width}x${plan.output.height} px (${plan.bucket.scale}x)${plan.verdict === "upscaled" ? ` - UPSCALED ${formatFactor(plan.factor)}` : ""}`,
      );
      if (plan.verdict === "upscaled")
        warnings.push(
          `${plan.bucket.id} (${plan.output.width}x${plan.output.height} px) is upscaled ${formatFactor(plan.factor)} from the ${source.width}x${source.height} px source.`,
        );
    }
    for (const plan of skipped) {
      warnings.push(
        `${plan.bucket.id} (${plan.output.width}x${plan.output.height} px) SKIPPED: exceeds the ${MAX_DIMENSION} px per side limit (max ${maxDpFor(plan.bucket)} dp wide at ${plan.bucket.id}).`,
      );
    }
    if (options.nodpi) {
      // nodpi is rendered at the mdpi size; mdpi is the smallest bucket, so it fits whenever anything does.
      const [plan] = planBuckets(source, options.dpWidth, options.dpHeight, [BUCKETS[0]!]);
      const path = `res/drawable-nodpi/${options.name}.${ext}`;
      entries.push({ name: path, data: await renderDrawable(options, plan!) });
      lines.push(`${path}: ${plan!.output.width}x${plan!.output.height} px (density-independent, drawn 1:1)`);
    }
    if (options.image.watermark && [options.image.watermark.width, options.image.watermark.height].some((l) => l && "px" in l)) {
      warnings.push("The watermark uses a px size, so it will look smaller at higher densities; use a % size for density sets.");
    }
  } else {
    lines.push(`Launcher icon "${options.name}" - adaptive (API 26+) + legacy + Play Store, background ${options.image.bg}`, "");
    for (const bucket of options.buckets) {
      const canvas = dpToPx(ICON.adaptiveDp, bucket),
        legacy = dpToPx(ICON.legacyDp, bucket);
      entries.push({ name: `res/mipmap-${bucket.id}/${options.name}_foreground.png`, data: await renderIconForeground(options, bucket) });
      entries.push({ name: `res/mipmap-${bucket.id}/${options.name}_background.png`, data: await renderIconBackground(options, canvas) });
      entries.push({ name: `res/mipmap-${bucket.id}/${options.name}.png`, data: await renderIconComposite(options, legacy, true) });
      lines.push(
        `res/mipmap-${bucket.id}/: ${options.name}.png ${legacy}x${legacy} (legacy 48 dp), ${options.name}_foreground.png + _background.png ${canvas}x${canvas} (adaptive 108 dp)`,
      );
    }
    const safePx = dpToPx(ICON.safeDp, BUCKETS[BUCKETS.length - 1]!);
    if (source.width < safePx && source.height < safePx) {
      warnings.push(
        `The source (${source.width}x${source.height} px) is smaller than the xxxhdpi safe zone (${safePx} px): the largest icons are upscaled ${formatFactor(safePx / Math.max(source.width, source.height))}.`,
      );
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@mipmap/${options.name}_background"/>\n    <foreground android:drawable="@mipmap/${options.name}_foreground"/>\n</adaptive-icon>\n`;
    entries.push({ name: `res/mipmap-anydpi-v26/${options.name}.xml`, data: Buffer.from(xml) });
    entries.push({ name: `res/mipmap-anydpi-v26/${options.name}_round.xml`, data: Buffer.from(xml) });
    entries.push({ name: `playstore/${options.name}-512.png`, data: await renderIconComposite(options, ICON.playStorePx, false) });
    lines.push(
      `res/mipmap-anydpi-v26/${options.name}.xml + ${options.name}_round.xml: adaptive icon definitions`,
      `playstore/${options.name}-512.png: Play Store listing icon (512x512, no transparency)`,
    );
    lines.push("", "Safe zone: the image is fitted into the 66 dp circle's square of the 108 dp canvas; launchers mask the outer 18 dp.");
  }

  const readme = [
    `Sharp Viewer - Android assets`,
    `Generated ${new Date().toISOString()}`,
    "",
    ...lines,
    "",
    warnings.length ? "WARNINGS" : "No warnings: the source has enough pixels for every size.",
    ...warnings.map((w) => `- ${w}`),
    "",
    "Copy the res/ folders into your module's src/main/res/.",
  ].join("\n");
  entries.push({ name: "README.txt", data: Buffer.from(readme, "utf8") });
  return { bytes: writeZip(entries), filename: `${options.name}-android.zip`, entries: entries.map((e) => e.name), warnings };
}
