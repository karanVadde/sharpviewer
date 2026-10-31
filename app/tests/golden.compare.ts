/**
 * Pixel comparison for golden binaries. Exact bytes are the fast path; when they differ, the two
 * images are decoded and compared pixel by pixel. Third-party image code (libvips, libjpeg-turbo)
 * is compiled per OS/CPU with different SIMD paths and is NOT bit-exact across platforms
 * (incident I-7: a 1080->279 Lanczos reduce differs by +-1 LSB between linux-x64 and darwin-arm64),
 * so the contract is: identical on the generating platform, within tolerance everywhere else.
 */
import sharp from "sharp";

/** Largest per-channel difference that still counts as platform rounding. */
export const MAX_CHANNEL_DIFF = 2;
/** Largest share of pixels that may differ (any channel) and still count as platform rounding. */
export const MAX_DIFFERING_FRACTION = 0.005;

export interface ImageComparison {
  /** Bytes identical. */
  identical: boolean;
  /** Decoded pixels equal within tolerance (always true when identical). */
  withinTolerance: boolean;
  width: number;
  height: number;
  /** Dimensions differ (then nothing else is compared). */
  sizeMismatch: boolean;
  maxDiff: number;
  differingPixels: number;
  totalPixels: number;
  /** Up to 5 positions of differing pixels, for the report. */
  samples: Array<{ x: number; y: number; diff: number }>;
}

export async function compareImages(actual: Buffer, expected: Buffer): Promise<ImageComparison> {
  if (actual.equals(expected)) {
    const m = await sharp(actual).metadata();
    return {
      identical: true,
      withinTolerance: true,
      width: m.width ?? 0,
      height: m.height ?? 0,
      sizeMismatch: false,
      maxDiff: 0,
      differingPixels: 0,
      totalPixels: (m.width ?? 0) * (m.height ?? 0),
      samples: [],
    };
  }
  const a = await sharp(actual).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const e = await sharp(expected).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const totalPixels = e.info.width * e.info.height;
  if (a.info.width !== e.info.width || a.info.height !== e.info.height) {
    return {
      identical: false,
      withinTolerance: false,
      width: a.info.width,
      height: a.info.height,
      sizeMismatch: true,
      maxDiff: 255,
      differingPixels: totalPixels,
      totalPixels,
      samples: [],
    };
  }
  let maxDiff = 0;
  let differingPixels = 0;
  const samples: ImageComparison["samples"] = [];
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c]! - e.data[i + c]!));
    if (d > 0) {
      differingPixels++;
      if (d > maxDiff) maxDiff = d;
      if (samples.length < 5) samples.push({ x: (i / 4) % a.info.width, y: Math.floor(i / 4 / a.info.width), diff: d });
    }
  }
  const withinTolerance = maxDiff <= MAX_CHANNEL_DIFF && differingPixels / totalPixels <= MAX_DIFFERING_FRACTION;
  return { identical: false, withinTolerance, width: a.info.width, height: a.info.height, sizeMismatch: false, maxDiff, differingPixels, totalPixels, samples };
}

/** One-line human report for a comparison. */
export function describeComparison(c: ImageComparison): string {
  if (c.identical) return "identical bytes";
  if (c.sizeMismatch) return `size mismatch: got ${c.width}x${c.height}`;
  const pct = ((c.differingPixels / c.totalPixels) * 100).toFixed(3);
  return `${c.differingPixels} of ${c.totalPixels} px differ (${pct}%), max channel diff ${c.maxDiff}${c.samples.length ? `, e.g. ${c.samples.map((s) => `(${s.x},${s.y}):${s.diff}`).join(" ")}` : ""}`;
}
