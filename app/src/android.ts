/**
 * Android asset helpers: density buckets, resource names, device -> bucket mapping,
 * launcher-icon geometry, and the "will this be upscaled" analysis.
 */
import { DEVICES, type Device } from "./devices.ts";
import { MAX_DIMENSION } from "./limits.ts";

export interface Bucket {
  id: string;
  scale: number;
  dpi: number;
}

/** The density buckets that matter today (ldpi and tvdpi are obsolete). */
export const BUCKETS: readonly Bucket[] = [
  { id: "mdpi", scale: 1, dpi: 160 },
  { id: "hdpi", scale: 1.5, dpi: 240 },
  { id: "xhdpi", scale: 2, dpi: 320 },
  { id: "xxhdpi", scale: 3, dpi: 480 },
  { id: "xxxhdpi", scale: 4, dpi: 640 },
];

export const MAX_DP = 4096;

export function findBucket(id: string): Bucket | undefined {
  return BUCKETS.find((b) => b.id === id);
}

/** dp -> px for a bucket (Android rounds to whole pixels). */
export function dpToPx(dp: number, bucket: Bucket): number {
  return Math.max(1, Math.round(dp * bucket.scale));
}

/** The largest dp width/height that keeps a bucket's output within MAX_DIMENSION px. */
export function maxDpFor(bucket: Bucket): number {
  return Math.floor(MAX_DIMENSION / bucket.scale);
}

/** The bucket Android serves to a screen of the given density (device pixel ratio): the nearest one at or above. */
export function bucketForDpr(dpr: number): Bucket {
  return BUCKETS.find((b) => b.scale >= dpr - 1e-9) ?? BUCKETS[BUCKETS.length - 1]!;
}

const RESOURCE_NAME = /^[a-z][a-z0-9_]*$/;

/** Validate an Android resource name; returns an error message (with a suggestion) or null. */
export function validateResourceName(name: string): string | null {
  if (RESOURCE_NAME.test(name) && name.length <= 100) return null;
  return `"${name}" is not a valid resource name: use lowercase letters, digits and underscores, starting with a letter, e.g. ${suggestResourceName(name)}.`;
}

/** Turn any label into a valid resource name ("My Banner-2.png" -> "my_banner_2"). */
export function suggestResourceName(label: string): string {
  const base = label
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!base) return "image";
  const named = /^[a-z]/.test(base) ? base : `img_${base}`;
  return named.replace(/_+$/g, "").slice(0, 100);
}

export interface Size {
  width: number;
  height: number;
}

export interface BucketPlan {
  bucket: Bucket;
  output: Size;
  /** output px / source px on the tighter axis; > 1 means the source is upscaled. */
  factor: number;
  /** `too-large`: a side exceeds MAX_DIMENSION; the asset must not be rendered (B1). */
  verdict: "ok" | "upscaled" | "too-large";
}

/** Output size per bucket for a dp width (height from the source aspect) or dp width+height. */
export function planBuckets(source: Size, dpWidth: number, dpHeight: number | undefined, buckets: readonly Bucket[] = BUCKETS): BucketPlan[] {
  return buckets.map((bucket) => {
    const width = dpToPx(dpWidth, bucket);
    const height = dpHeight === undefined ? Math.max(1, Math.round((width * source.height) / source.width)) : dpToPx(dpHeight, bucket);
    const factor = Math.max(width / source.width, height / source.height);
    const verdict = width > MAX_DIMENSION || height > MAX_DIMENSION ? "too-large" : factor > 1.0001 ? "upscaled" : "ok";
    return { bucket, output: { width, height }, factor, verdict };
  });
}

export interface DeviceVerdict {
  device: Device;
  bucket: Bucket;
  /** Pixels the device needs for the dp width. */
  needs: Size;
  factor: number;
  verdict: BucketPlan["verdict"];
}

/** For each device profile: which bucket Android picks and whether the source is enough for it. */
export function planDevices(source: Size, dpWidth: number, dpHeight: number | undefined): DeviceVerdict[] {
  return DEVICES.map((device) => {
    const bucket = bucketForDpr(device.dpr);
    const [plan] = planBuckets(source, dpWidth, dpHeight, [bucket]);
    return { device, bucket, needs: plan!.output, factor: plan!.factor, verdict: plan!.verdict };
  });
}

/** Launcher icon geometry (dp). */
export const ICON = {
  legacyDp: 48,
  adaptiveDp: 108,
  visibleDp: 72,
  safeDp: 66,
  playStorePx: 512,
} as const;

export const formatFactor = (factor: number): string => `\u00d7${factor.toFixed(factor >= 10 ? 0 : 1)}`;
