/**
 * One PageContext per request: every validation the page needs, done once, before any HTML.
 *
 * The rules (spec 4c): validate everything the render would reject BEFORE building the
 * `<img src>`, so the page never points the browser at a URL that answers 400. Out-of-bounds
 * traverse values are warned about (toast) and the mark keeps the last applied position.
 * The Android card is validated separately so its errors never block the preview.
 */

import { androidSource, type DrawablePlan, planDrawable } from "../android-zip.ts";
import { cellRects, gutterPx, type Nudge } from "../collage.ts";
import { DEVICES, viewportFor } from "../devices.ts";
import { BadRequestError } from "../errors.ts";
import {
  boxClippedByCorners,
  collageWatermarkMargin,
  cornerRadius,
  markVisibleFraction,
  maxSafeWidthPercent,
  outputSize,
  placeWatermark,
  requiredWidthPercent,
  type Size,
  sourceSize,
  thumbnailSafeTraverse,
  thumbScale,
  traverseRange,
  watermarkSize,
} from "../geometry.ts";
import { type ImageSource, resolveImage, SAMPLE_IMAGE } from "../images.ts";
import {
  ANDROID_PARAMS,
  type AndroidMode,
  type AndroidOptions,
  EXPORT_PARAMS,
  FEED_WIDTH,
  IMAGE_PARAMS,
  type ImageOptions,
  PASSTHROUGH_PARAMS,
  type PreviewState,
  parseAndroidOptions,
  parseExportOptions,
  parseExportOptionsLoose,
  parseImageOptions,
  parsePreviewState,
  parseThumb,
  TRUTHY,
} from "../params.ts";
import { effectiveNudge, effectiveWatermark, getNativeSizes, markNativeSize, type NativeSizes } from "../pipeline.ts";
import type { Fit, Preset } from "../presets.ts";
import { type ActiveWatermark, autoTone, contrastRatio, markFill, markFor } from "../watermark.ts";

export interface ViewerPageExtras {
  /** Error from a failed POST (/watermark or /upload), shown in the banner. */
  watermarkError?: string;
  /** The text the user typed (kept in the field after an error). */
  watermarkTextInput?: string;
  /** CSP nonce for the page's inline script (A11). */
  nonce?: string;
}

export interface EnhanceInfo {
  sharpen: boolean;
  grayscale: boolean;
  corners: number;
  radius: number;
}

export interface ExportInfo {
  output: Size;
  preset?: Preset;
  fit: Fit;
  bg: string;
  upscaledFrom?: Size;
}

export interface CollageInfo {
  options: NonNullable<ImageOptions["collage"]>;
  canvas: Size;
  gutterPx: number;
  /** Nudges as actually applied (clamped), for the form fields. */
  nudges: Nudge[];
}

export interface AndroidInfo {
  options: AndroidOptions;
  /** Source size the plan is computed from (after rotation). */
  source: Size;
  /** Drawable mode: the bucket plan (validated: at least one bucket fits). */
  plan?: DrawablePlan;
  href: string;
}

export interface PageContext {
  /** The raw page query. */
  params: URLSearchParams;
  /** Image parameters as given (non-empty), before normalisation: what the form echoes. */
  forwarded: URLSearchParams;
  /** The validated, normalised `/image` query (traverse "keep" applied, redundant params dropped). */
  imageQuery: URLSearchParams;
  exportQuery: URLSearchParams;
  androidQuery: URLSearchParams;
  extras: ViewerPageExtras;
  state: PreviewState;
  /** Banner error (preview state or image options), "" when the render is possible. */
  error: string;
  /** Toast warnings. */
  warnings: string[];
  /** Export-card error (format / quality / maxKB); never blanks the preview (B4). */
  exportError: string;
  /** Traverse values actually applied to the image shown. */
  applied: { X: number; Y: number };
  selectedImage: ImageSource;
  nativeImage: Size;
  /** Lower-case sharp format name of the source ("jpeg", "png", ...). */
  imageFormat: string;
  /** The rasterised mark size on this output, when the watermark is on and fits. */
  shownMark?: Size;
  /** The margin actually applied (collages default it to the gutter), for the form field. */
  effectiveMargin?: number;
  /** Set when the tone was chosen automatically (collage, mark on the background, no wmTone). */
  autoToneInfo?: { tone: number; bg: string };
  /** In context: traverse values that move the mark into the thumbnail-safe centre square (when it is cropped). */
  thumbnailFix?: { traverseX: number; traverseY: number };
  enhance: EnhanceInfo;
  exportInfo?: ExportInfo;
  /** Collage mode (valid options only). */
  collage?: CollageInfo;
  exportOptions: ReturnType<typeof parseExportOptionsLoose>;
  active: ActiveWatermark;
  /** Hidden fields every POST form carries so its redirect returns to the same page. */
  passthrough: URLSearchParams;
  /** Page-only: the Green tone checkbox. */
  toneOn: boolean;
  mobile: boolean;
  /** In-context view (4.9) with its scene. */
  context: boolean;
  /** Hidden fields / reset target for the current view (mobile or context); empty on desktop. */
  viewState: Record<string, string>;
  /** The composition's output size (for scene thumbnails) when the render is valid. */
  output?: Size;
  android?: AndroidInfo;
  androidError: string;
  androidMode: AndroidMode;
}

/**
 * First value per name, except `cells`: the form submits one `cells` field per picker, so all of
 * them are kept, joined into the comma form (empty slots preserved, e.g. `photo,,thumb,`).
 */
const pick = (params: URLSearchParams, names: readonly string[]): URLSearchParams => {
  const out = new URLSearchParams();
  for (const name of names) {
    if (name === "cells" || name === "cellFit" || name === "cellX" || name === "cellY") {
      const all = params.getAll(name).flatMap((v) => v.split(","));
      if (all.some((v) => v.trim() !== "")) out.set(name, all.map((v) => v.trim()).join(","));
      continue;
    }
    const value = params.get(name);
    if (value !== null && value !== "") out.set(name, value);
  }
  return out;
};

export async function buildPageContext(params: URLSearchParams, extras: ViewerPageExtras = {}): Promise<PageContext> {
  const forwarded = pick(params, IMAGE_PARAMS);
  // The tone slider always submits a value; it only counts when its checkbox (page-only `wmToneOn`) is on.
  const toneOn = TRUTHY.has((params.get("wmToneOn") ?? "").trim().toLowerCase());
  if (!toneOn) forwarded.delete("wmTone");

  // Preview mode (banner / device frame). Unknown values fall back to desktop with an error banner.
  let state: PreviewState;
  let previewError = "";
  try {
    state = parsePreviewState(params);
  } catch (cause) {
    previewError = cause instanceof BadRequestError ? cause.message : "Invalid preview options.";
    state = {
      view: "desktop",
      device: DEVICES[0]!,
      orientation: "portrait",
      embed: false,
      guides: false,
      scene: "grid",
      tile: 150,
      row: 64,
      theme: "light",
      frame: false,
    };
  }

  let error = previewError;
  const warnings: string[] = [];
  const applied = { X: 0, Y: 0 };
  let selectedImage: ImageSource = SAMPLE_IMAGE;
  let shownMark: Size | undefined;
  let effectiveMargin: number | undefined;
  let autoToneInfo: { tone: number; bg: string } | undefined;
  let thumbnailFix: { traverseX: number; traverseY: number } | undefined;
  let enhance: EnhanceInfo = { sharpen: false, grayscale: false, corners: 0, radius: 0 };
  let exportInfo: ExportInfo | undefined;
  let collage: CollageInfo | undefined;
  const exportQuery = pick(params, EXPORT_PARAMS);
  const imageQuery = new URLSearchParams(forwarded);
  let native: NativeSizes | undefined;
  try {
    const options = parseImageOptions(forwarded);
    if (previewError) throw new BadRequestError(previewError);
    selectedImage = await resolveImage(options.image);
    if (!options.sharpen) imageQuery.delete("sharpen");
    if (!options.grayscale) imageQuery.delete("grayscale");
    if (options.corners === 0) imageQuery.delete("corners");
    if (!options.preset) {
      imageQuery.delete("preset");
      imageQuery.delete("fit");
    } else {
      imageQuery.delete("width");
      imageQuery.delete("height");
    }
    if (options.bg === "#ffffff") imageQuery.delete("bg");
    native = await getNativeSizes(selectedImage.id);
    const output = outputSize(native.image, options);
    {
      const from = sourceSize(native.image, options);
      exportInfo = {
        output,
        preset: options.preset,
        fit: options.fit,
        bg: options.bg,
        upscaledFrom: options.preset && (from.width < output.width || from.height < output.height) ? from : undefined,
      };
    }
    enhance = { sharpen: options.sharpen, grayscale: options.grayscale, corners: options.corners, radius: cornerRadius(output, options.corners) };
    if (options.collage) {
      collage = { options: options.collage, canvas: output, gutterPx: gutterPx(options.collage.gutter, output), nudges: options.collage.nudges };
      // Collage params are forwarded as parsed (normalised cells list); gutter/corners/fit only when non-default.
      imageQuery.set("cells", options.collage.cells.map((c) => c ?? "").join(","));
      if (/^,*$/.test(imageQuery.get("cells") ?? "")) imageQuery.delete("cells");
      if (options.collage.cellCorners === 0) imageQuery.delete("cellCorners");
      // One value when every cell agrees (dropped when it is the default), else the per-cell list.
      const fits = options.collage.cellFits;
      if (fits.every((f) => f === fits[0])) {
        if (fits[0] === "cover") imageQuery.delete("cellFit");
        else imageQuery.set("cellFit", fits[0]!);
      } else {
        imageQuery.set("cellFit", fits.join(","));
      }
      // Nudges (phase 3): clamp per filled cover cell, toast when a value had to change, drop all-zero lists.
      const rects = cellRects(options.collage.layout, output, gutterPx(options.collage.gutter, output));
      const applied = [...options.collage.nudges];
      for (const [i, nudge] of options.collage.nudges.entries()) {
        const id = options.collage.cells[i];
        if (id === null || (nudge.x === 0 && nudge.y === 0)) continue;
        const eff = await effectiveNudge(options.collage, i, rects[i]!, (await resolveImage(id)).path);
        if (!eff) continue;
        applied[i] = eff.applied;
        for (const axis of ["x", "y"] as const) {
          if (eff.applied[axis] !== nudge[axis]) {
            warnings.push(
              `Cell ${i + 1} nudge ${axis.toUpperCase()} ${nudge[axis]} is out of range for this cell: allowed ${eff.range[axis][0]} to ${eff.range[axis][1]}. Using ${eff.applied[axis]}.`,
            );
          }
        }
      }
      collage.nudges = applied;
      for (const [name, key] of [
        ["cellX", "x"],
        ["cellY", "y"],
      ] as const) {
        if (applied.every((n) => n[key] === 0)) imageQuery.delete(name);
        else imageQuery.set(name, applied.map((n) => String(n[key])).join(","));
      }
    } else {
      for (const name of ["layout", "cells", "gutter", "cellCorners", "cellFit", "cellX", "cellY"]) imageQuery.delete(name);
    }
    if (!options.watermark) {
      // Watermark off: its parameters are irrelevant (and unvalidated), keep them out of the image URL.
      for (const name of IMAGE_PARAMS) if (name.startsWith("wm") || name.startsWith("traverse")) imageQuery.delete(name);
    } else {
      const markNative = await markNativeSize(native, options.watermark);
      const mark = watermarkSize(markNative, options.watermark, output);
      const effective = effectiveWatermark(options, output, mark);
      const { margin, traverseX, traverseY } = effective;
      if (effective.autoTone) autoToneInfo = { tone: effective.tone!, bg: options.bg };
      // Fit check (mark + margin must fit): same rule and message as the render.
      placeWatermark(output, mark, { margin, traverseX: 0, traverseY: 0 });
      shownMark = mark;
      effectiveMargin = margin;
      // Traverse out of bounds: warn, and keep the mark where it was. "Where it was" is the value
      // last applied to the image, carried by the form's hidden appliedTraverseX/Y fields; if that
      // is missing or no longer fits (e.g. the size changed too), fall back to the anchor (0).
      const range = traverseRange(output, mark, margin);
      const keep = (axis: "X" | "Y", value: number, [min, max]: [number, number]) => {
        if (value >= min && value <= max) {
          applied[axis] = value;
          return;
        }
        const previous = Number(params.get(`appliedTraverse${axis}`));
        const kept = Number.isInteger(previous) && previous >= min && previous <= max ? previous : 0;
        applied[axis] = kept;
        warnings.push(`traverse${axis} ${value} is out of bounds for this size: allowed ${min} to ${max}. Keeping ${kept}.`);
        if (kept === 0) imageQuery.delete(`traverse${axis}`);
        else imageQuery.set(`traverse${axis}`, String(kept));
      };
      keep("X", traverseX, range.x);
      keep("Y", traverseY, range.y);
      // Collage: warn when the mark covers a filled cell's picture (the render is unchanged).
      if (options.collage) {
        const pos = placeWatermark(output, mark, { margin, traverseX: applied.X, traverseY: applied.Y });
        const rects = cellRects(options.collage.layout, output, gutterPx(options.collage.gutter, output));
        const hit = rects.findIndex(
          (r, i) =>
            options.collage!.cells[i] !== null &&
            pos.left < r.left + r.width &&
            r.left < pos.left + mark.width &&
            pos.top < r.top + r.height &&
            r.top < pos.top + mark.height,
        );
        if (hit >= 0) {
          const g = gutterPx(options.collage.gutter, output);
          const fix =
            g >= mark.height
              ? `set Margin to ${collageWatermarkMargin(g, mark.height)} (centred in the gutter band)`
              : `use a gutter of at least ${mark.height} px or a smaller mark`;
          warnings.push(`The watermark overlaps cell ${hit + 1}'s picture: ${fix}, or move it with traverseX/traverseY.`);
        }
        if (hit < 0) {
          // The mark sits on the background: it must contrast with it (I-8).
          const ratio = contrastRatio(markFill(effective.tone), options.bg);
          if (ratio < 3) warnings.push(`The watermark has low contrast on the background (${ratio.toFixed(1)}:1): try Green tone ${autoTone(options.bg)}.`);
        }
      }
      // In context (4.9): is the mark still there, and readable, the way the scene shows it?
      if (state.view === "context" && !state.embed) {
        const scene = state.scene;
        const feedWidth = state.scene === "feed" && state.frame ? viewportFor(state.device, state.orientation).width : FEED_WIDTH;
        const box =
          scene === "grid"
            ? { label: `grid (${state.tile} px tiles)`, thumb: parseThumb(`${state.tile}x${state.tile}`)! }
            : scene === "list"
              ? { label: `list (${state.row} px thumbnails)`, thumb: parseThumb(`${state.row}x${state.row}`)! }
              : { label: `feed (${feedWidth} px wide)`, thumb: parseThumb(`${feedWidth}x`)! };
        const scale = thumbScale(output, box.thumb);
        // 1. Square crops (grid, list) remove the bands a bottom-right mark lives in.
        if (scene !== "feed") {
          const pos = placeWatermark(output, mark, { margin, traverseX: applied.X, traverseY: applied.Y });
          const visible = markVisibleFraction(output, { ...pos, ...mark });
          if (visible < 0.999) {
            const side = Math.min(output.width, output.height);
            const band = output.height > output.width ? "bottom" : "right";
            const cut = Math.round((1 - visible) * 100);
            if (mark.width + margin <= side) {
              const fix = thumbnailSafeTraverse(output);
              const move = fix.y !== 0 ? `traverseY ${fix.y}` : `traverseX ${fix.x}`;
              warnings.push(
                `In the ${scene} the square thumbnail crop cuts off ${cut}% of the watermark (it sits in the ${band} band that gets cropped). Move it into the thumbnail-safe area: ${move}.`,
              );
              thumbnailFix = { traverseX: fix.x, traverseY: fix.y };
            } else {
              warnings.push(
                `In the ${scene} the square thumbnail crop cuts off ${cut}% of the watermark, and at ${mark.width} px it is wider than the ${side} px square the crop keeps: use a width of at most ${maxSafeWidthPercent(output, margin)}% so it can sit inside.`,
              );
            }
          }
        }
        // 2. Height at the scene's scale, with a number that would work.
        const height = Math.round(mark.height * scale);
        if (height < 8) {
          const pct = requiredWidthPercent(markNative, output, scale);
          // Grid / list: the readable width must also fit inside the square the crop keeps.
          const cap = scene === "feed" ? 100 : maxSafeWidthPercent(output, margin);
          const advice =
            pct === null
              ? "No width under 100% is readable at this size: thumbnails this small cannot carry a text mark; it protects the full-size view."
              : pct > cap
                ? `It would need a width of about ${pct}%, but only up to ${cap}% fits inside the square the crop keeps: at this size the thumbnail cannot carry a readable mark; it protects the full-size view.`
                : `It needs a width of about ${pct}% here (wmWidth=${pct}%).`;
          const tip = options.watermark.tone === undefined ? " Tip: Green tone 100 adds contrast on a light picture." : "";
          warnings.push(`In the ${box.label} the watermark is ${height} px tall - unreadable. ${advice}${tip}`);
        }
      }
      // Rounded corners clip the whole composition; warn if the mark sits in a clipped corner.
      if (enhance.radius > 0) {
        const pos = placeWatermark(output, mark, { margin, traverseX: applied.X, traverseY: applied.Y });
        if (boxClippedByCorners(output, enhance.radius, { ...pos, ...mark })) {
          warnings.push(
            `The rounded corners (radius ${enhance.radius} px) clip part of the watermark. Increase the margin or move it inward with traverseX/traverseY.`,
          );
        }
      }
    }
  } catch (cause) {
    error = cause instanceof BadRequestError ? cause.message : "Invalid image options.";
  }

  // Export-only parameters (format/quality/maxKB) are validated on their own (B4): a bad value
  // disables Download and is reported in the Export card, while the preview keeps its settings.
  let exportError = "";
  if (!error) {
    try {
      parseExportOptions(new URLSearchParams([...imageQuery.entries(), ...exportQuery.entries()]));
    } catch (cause) {
      exportError = cause instanceof BadRequestError ? cause.message : "Invalid export options.";
    }
  }

  // The mark the page describes: the request's wmText when it is on and valid, else the active file.
  const wmText = forwarded.get("wmText");
  const active = await markFor(!error && wmText !== null && imageQuery.has("wmText") ? { text: wmText } : undefined);
  const passthrough = pick(params, PASSTHROUGH_PARAMS);
  // Page-level view state the forms must carry so Apply / live updates / POST redirects keep the view.
  const viewState: Record<string, string> =
    state.view === "mobile" && !state.embed
      ? { view: "mobile", device: state.device.slug, orientation: state.orientation }
      : state.view === "context" && !state.embed
        ? {
            view: "context",
            scene: state.scene,
            tile: String(state.tile),
            row: String(state.row),
            theme: state.theme,
            ...(state.frame ? { frame: "1", device: state.device.slug, orientation: state.orientation } : {}),
          }
        : {};
  for (const [k, v] of Object.entries(viewState)) passthrough.set(k, v);
  // Same "applied" values the preview form carries (the position actually shown), not the raw input.
  for (const axis of ["X", "Y"] as const) {
    if (applied[axis] === 0) passthrough.delete(`appliedTraverse${axis}`);
    else passthrough.set(`appliedTraverse${axis}`, String(applied[axis]));
  }

  const mobile = state.view === "mobile" && !state.embed;
  const context = state.view === "context" && !state.embed;
  // Resolved once: on the error path selectedImage fell back to the sample.
  native ??= await getNativeSizes(selectedImage.id);
  const nativeImage = native.image;
  const imageFormat = native.format;

  // Android card: validated separately so its errors never block the preview.
  const androidQuery = new URLSearchParams();
  for (const name of ANDROID_PARAMS) for (const value of params.getAll(name)) if (value !== "") androidQuery.append(name, value);
  let androidError = "";
  let android: AndroidInfo | undefined;
  if (!error) {
    try {
      const options = parseAndroidOptions(new URLSearchParams([...imageQuery.entries(), ...androidQuery.entries()]));
      const source = await androidSource(options.image);
      const href = `/android.zip?${new URLSearchParams([...imageQuery.entries(), ...androidQuery.entries()]).toString()}`;
      // Drawable mode: plan now so that "no bucket fits" (B1) is this card's error, not a render failure.
      const plan = options.mode === "drawable" ? planDrawable(source, options) : undefined;
      android = { options, source, plan, href };
    } catch (cause) {
      androidError = cause instanceof BadRequestError ? cause.message : "Invalid Android options.";
    }
  }
  const androidMode = (androidQuery.get("androidMode") === "icon" ? "icon" : "drawable") as AndroidMode;

  return {
    params,
    forwarded,
    imageQuery,
    exportQuery,
    androidQuery,
    extras,
    state,
    error,
    warnings,
    exportError,
    applied,
    selectedImage,
    nativeImage,
    imageFormat,
    shownMark,
    effectiveMargin,
    autoToneInfo,
    thumbnailFix,
    enhance,
    exportInfo,
    collage,
    exportOptions: parseExportOptionsLoose(exportQuery),
    active,
    passthrough,
    toneOn,
    mobile,
    context,
    viewState,
    output: exportInfo?.output,
    android,
    androidError,
    androidMode,
  };
}
