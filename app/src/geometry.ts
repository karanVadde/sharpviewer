/**
 * Size maths shared by the renderer and the page: output size after rotate/resize/preset,
 * watermark size and placement, traverse range, rounded-corner radius and clipping.
 * Pure functions; tests prove they match sharp's real output.
 */

import { collageCanvas } from "./collage.ts";
import { BadRequestError } from "./errors.ts";
import {
  DEFAULT_WATERMARK_MARGIN,
  DEFAULT_WATERMARK_WIDTH,
  type ImageOptions,
  type Rotation,
  type Thumb,
  type WatermarkLength,
  type WatermarkOptions,
} from "./params.ts";
import type { Preset } from "./presets.ts";

/** Corner radius in pixels for a `corners` value (0-100, linear) on an output of the given size. */
export function cornerRadius(output: Size, corners: number): number {
  return Math.round((corners / 100) * (Math.min(output.width, output.height) / 2));
}

/** SVG mask for rounded corners; composited with `dest-in` so the corners become transparent. */
export function cornerMask(output: Size, radius: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${output.width}" height="${output.height}"><rect width="${output.width}" height="${output.height}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );
}

/** True if any corner of the box (left, top, width, height) falls in a clipped corner of the rounded rect. */
export function boxClippedByCorners(output: Size, radius: number, box: { left: number; top: number; width: number; height: number }): boolean {
  if (radius <= 0) return false;
  const inside = (x: number, y: number) => {
    const cx = x < radius ? radius : x > output.width - radius ? output.width - radius : x;
    const cy = y < radius ? radius : y > output.height - radius ? output.height - radius : y;
    // Outside a corner square: always inside. Inside one: must be within the corner circle.
    if (cx === x || cy === y) return true;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  const { left, top, width, height } = box;
  return ![
    [left, top],
    [left + width - 1, top],
    [left, top + height - 1],
    [left + width - 1, top + height - 1],
  ].every(([x, y]) => inside(x!, y!));
}

/** Inclusive traverse range that keeps the whole mark inside the image (after the margin). */
export function traverseRange(output: Size, mark: Size, margin: number): { x: [number, number]; y: [number, number] } {
  return {
    x: [-(output.width - mark.width - margin), margin],
    y: [-(output.height - mark.height - margin), margin],
  };
}

/**
 * Where the watermark's top-left corner lands on an output of the given size:
 * bottom-right anchor, inset by the margin, then shifted by traverseX/Y.
 * Throws a BadRequestError if any part of the mark would fall outside the image.
 */
export function placeWatermark(
  output: { width: number; height: number },
  mark: { width: number; height: number },
  options: Pick<WatermarkOptions, "margin" | "traverseX" | "traverseY">,
): { left: number; top: number } {
  const { margin, traverseX, traverseY } = options;
  const size = `Watermark ${mark.width}x${mark.height}`;

  if (mark.width + margin > output.width || mark.height + margin > output.height) {
    throw new BadRequestError(`${size} plus margin ${margin} does not fit inside the ${output.width}x${output.height} image.`);
  }

  const left = output.width - mark.width - margin + traverseX;
  const top = output.height - mark.height - margin + traverseY;

  const overshoot: string[] = [];
  if (left < 0) overshoot.push(`${-left} px past the left edge`);
  if (left + mark.width > output.width) overshoot.push(`${left + mark.width - output.width} px past the right edge`);
  if (top < 0) overshoot.push(`${-top} px past the top edge`);
  if (top + mark.height > output.height) overshoot.push(`${top + mark.height - output.height} px past the bottom edge`);
  if (overshoot.length > 0) {
    throw new BadRequestError(
      `${size} with traverseX=${traverseX}, traverseY=${traverseY} would extend ${overshoot.join(" and ")} of the ${output.width}x${output.height} image.`,
    );
  }

  return { left, top };
}

export interface Size {
  width: number;
  height: number;
}

/** Size after sharp's resize: both -> exact (fill); one -> the other keeps the aspect ratio. */
export function resizedSize(native: Size, width?: number, height?: number): Size {
  if (width !== undefined && height !== undefined) return { width, height };
  if (width !== undefined) return { width, height: Math.max(1, Math.round((width * native.height) / native.width)) };
  if (height !== undefined) return { width: Math.max(1, Math.round((height * native.width) / native.height)), height };
  return { ...native };
}

/** Final output size for the given options (rotate, then resize) without rendering anything. */
export function outputSize(
  native: Size,
  options: Pick<ImageOptions, "width" | "height" | "rotate"> & { preset?: Preset; collage?: ImageOptions["collage"] },
): Size {
  if (options.collage) return collageCanvas(options);
  if (options.preset) return { width: options.preset.width, height: options.preset.height };
  const rotated = options.rotate === 90 || options.rotate === 270 ? { width: native.height, height: native.width } : native;
  return resizedSize(rotated, options.width, options.height);
}

/** Size of the image after rotation, before any resize (what a preset would be filled from). */
export function rotatedSize(native: Size, rotate: Rotation): Size {
  return rotate === 90 || rotate === 270 ? { width: native.height, height: native.width } : { ...native };
}

/** The "source" a preset or an Android plan is filled from: the rotated image, or the collage canvas. */
export function sourceSize(
  native: Size,
  options: Pick<ImageOptions, "rotate" | "width" | "height"> & { preset?: Preset; collage?: ImageOptions["collage"] },
): Size {
  return options.collage ? collageCanvas(options) : rotatedSize(native, options.rotate);
}

/** Resolve a watermark length to pixels against the output image. */
function lengthToPx(length: WatermarkLength | undefined, outputSide: number): number | undefined {
  if (length === undefined) return undefined;
  if ("px" in length) return length.px;
  return Math.max(1, Math.round((outputSide * length.percent) / 100));
}

/**
 * Rasterised watermark size for the given options and output size, without rendering anything.
 * With neither width nor height given, the default is DEFAULT_WATERMARK_WIDTH px wide, clamped so
 * that the mark plus its margin fits the output on both axes (B3: a tall mark such as a single
 * letter would otherwise overflow). Explicit sizes are never clamped (the fit check rejects them).
 */
export function watermarkSize(native: Size, options: Pick<WatermarkOptions, "width" | "height"> & { margin?: number }, output: Size): Size {
  let width = lengthToPx(options.width, output.width);
  const height = lengthToPx(options.height, output.height);
  if (width === undefined && height === undefined) {
    const margin = options.margin ?? DEFAULT_WATERMARK_MARGIN;
    const byHeight = Math.floor(((output.height - margin) * native.width) / native.height);
    const fitted = Math.min(DEFAULT_WATERMARK_WIDTH, output.width - margin, byHeight);
    // Nothing fits at all (margin >= image): keep the nominal default so the fit check reports it.
    width = fitted >= 1 ? fitted : DEFAULT_WATERMARK_WIDTH;
  }
  return resizedSize(native, width, height);
}

/**
 * Collage-aware watermark margin (4k): when the mark is no taller than the gutter, centre it in the
 * bottom-right margin band (`floor((gutter - markHeight) / 2)`), so it never covers a picture; else
 * the usual default. Explicit `wmMargin` always wins (the caller checks `marginGiven`).
 */
export function collageWatermarkMargin(gutter: number, markHeight: number): number {
  return gutter >= markHeight ? Math.floor((gutter - markHeight) / 2) : DEFAULT_WATERMARK_MARGIN;
}

/** Displayed size for a `thumb` on a composed output (never upscales; `cover` is exact). */
export function thumbSize(output: Size, thumb: Thumb): Size {
  const round = (v: number) => Math.max(1, Math.round(v));
  switch (thumb.fit) {
    case "cover":
      return { width: thumb.width, height: thumb.height };
    case "inside": {
      const scale = Math.min(1, thumb.width / output.width, thumb.height / output.height);
      return { width: round(output.width * scale), height: round(output.height * scale) };
    }
    case "width": {
      const scale = Math.min(1, thumb.width / output.width);
      return { width: round(output.width * scale), height: round(output.height * scale) };
    }
    case "height": {
      const scale = Math.min(1, thumb.height / output.height);
      return { width: round(output.width * scale), height: round(output.height * scale) };
    }
  }
}

/** Scale factor a `thumb` applies to the composition (what the watermark shrinks by). */
export function thumbScale(output: Size, thumb: Thumb): number {
  if (thumb.fit === "cover") return Math.max(thumb.width / output.width, thumb.height / output.height);
  const size = thumbSize(output, thumb);
  return size.width / output.width;
}

// ---------------------------------------------------------------------------
// Thumbnail placement review (spec 4.9): what a centre square crop keeps, and how to stay inside it

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The centre square a gallery tile / list row keeps of a composition (cover crop to a square). */
export function safeSquare(output: Size): Rect {
  const side = Math.min(output.width, output.height);
  return { left: Math.floor((output.width - side) / 2), top: Math.floor((output.height - side) / 2), width: side, height: side };
}

/** Fraction (0..1) of a mark rectangle that lies inside the centre square crop. */
export function markVisibleFraction(output: Size, mark: Rect): number {
  const safe = safeSquare(output);
  const w = Math.max(0, Math.min(mark.left + mark.width, safe.left + safe.width) - Math.max(mark.left, safe.left));
  const h = Math.max(0, Math.min(mark.top + mark.height, safe.top + safe.height) - Math.max(mark.top, safe.top));
  return mark.width * mark.height === 0 ? 0 : (w * h) / (mark.width * mark.height);
}

/**
 * Traverse that moves a bottom-right-anchored mark into the centre square: shift up by the cropped
 * bottom band for tall outputs, left by the cropped right band for wide ones. Zero for a square.
 */
export function thumbnailSafeTraverse(output: Size): { x: number; y: number } {
  const safe = safeSquare(output);
  const neg = (v: number) => (v === 0 ? 0 : -v); // no -0
  return { x: neg(output.width - safe.left - safe.width), y: neg(output.height - safe.top - safe.height) };
}

/**
 * The `wmWidth` percentage that makes the mark at least 8 px tall once the composition is shown at
 * `scale`, or null when even 100 % of the width would not do (honest: some sizes cannot carry text).
 */
export function requiredWidthPercent(markNative: Size, output: Size, scale: number, minHeight = 8): number | null {
  const neededFullHeight = minHeight / scale;
  const neededWidth = neededFullHeight * (markNative.width / markNative.height);
  const percent = Math.ceil((neededWidth / output.width) * 100);
  return percent <= 100 ? percent : null;
}

/** Largest `wmWidth` percentage whose mark (with its margin on both sides) fits inside the centre square crop. */
export function maxSafeWidthPercent(output: Size, margin: number): number {
  const side = Math.min(output.width, output.height);
  return Math.max(0, Math.floor(((side - 2 * margin) / output.width) * 100));
}
