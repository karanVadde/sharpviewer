/**
 * Collage templates (spec 4k): named layouts whose cells are fractions of the canvas, and the
 * maths that turns them into non-overlapping pixel rectangles with a gutter. Pure: no sharp.
 */
import { BadRequestError } from "./errors.ts";
import type { Size } from "./geometry.ts";

/** A cell in canvas fractions (0..1). */
export interface CellFraction {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  id: string;
  label: string;
  cells: readonly CellFraction[];
}

const grid = (cols: number, rows: number): CellFraction[] =>
  Array.from({ length: cols * rows }, (_, i) => ({ x: (i % cols) / cols, y: Math.floor(i / cols) / rows, w: 1 / cols, h: 1 / rows }));

/** Phone-aspect cells (9:19.5) centred side by side, filling the canvas height. */
const screens = (n: number): CellFraction[] => {
  // Fractions are canvas-relative, so the phone aspect is only exact on a square canvas; the
  // renderer corrects the cell aspect per canvas (see cellRects), which keeps the template pure.
  const w = 1 / (n + 0.5);
  const gap = (1 - n * w) / (n + 1);
  return Array.from({ length: n }, (_, i) => ({ x: gap + i * (w + gap), y: 0, w, h: 1 }));
};

export const LAYOUTS: readonly Layout[] = [
  { id: "grid-2x2", label: "Grid 2 x 2", cells: grid(2, 2) },
  { id: "grid-3x3", label: "Grid 3 x 3", cells: grid(3, 3) },
  { id: "split-h", label: "Split left / right", cells: grid(2, 1) },
  { id: "split-v", label: "Split top / bottom", cells: grid(1, 2) },
  {
    id: "hero-3",
    label: "Hero left + 2 stacked",
    cells: [
      { x: 0, y: 0, w: 2 / 3, h: 1 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 1 / 2 },
      { x: 2 / 3, y: 1 / 2, w: 1 / 3, h: 1 / 2 },
    ],
  },
  {
    id: "hero-4",
    label: "Hero top + 3 below",
    cells: [
      { x: 0, y: 0, w: 1, h: 2 / 3 },
      { x: 0, y: 2 / 3, w: 1 / 3, h: 1 / 3 },
      { x: 1 / 3, y: 2 / 3, w: 1 / 3, h: 1 / 3 },
      { x: 2 / 3, y: 2 / 3, w: 1 / 3, h: 1 / 3 },
    ],
  },
  { id: "strip-3", label: "Strip of 3", cells: grid(3, 1) },
  { id: "strip-4", label: "Strip of 4", cells: grid(4, 1) },
  { id: "story-3", label: "3 stacked rows", cells: grid(1, 3) },
  { id: "screens-2", label: "2 phone screens", cells: screens(2) },
  { id: "screens-3", label: "3 phone screens", cells: screens(3) },
];

export function findLayout(id: string): Layout | undefined {
  return LAYOUTS.find((l) => l.id === id);
}

/** Phone aspect used by the `screens-*` templates (width / height). */
export const SCREEN_ASPECT = 9 / 19.5;

/** A gutter: absolute px or a percentage of the canvas' shorter side. */
export type Gutter = { px: number } | { percent: number };
export const DEFAULT_GUTTER: Gutter = { percent: 2 };
export const MAX_GUTTER_PX = 512;
export const MAX_GUTTER_PERCENT = 20;

export function gutterPx(gutter: Gutter, canvas: Size): number {
  const shorter = Math.min(canvas.width, canvas.height);
  const px = "px" in gutter ? gutter.px : Math.round((shorter * gutter.percent) / 100);
  // Never let the gutter eat the whole canvas.
  return Math.min(px, Math.floor(shorter / 4));
}

export interface CellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Pixel rectangles for a layout on a canvas with a gutter (gap between cells and to the edge).
 * Each fraction cell is mapped into the canvas minus the outer gutter, then shrunk by half a
 * gutter on each inner side. Edges are rounded so that neighbours never overlap, and every cell
 * is at least 1x1 px. `screens-*` cells are additionally fitted to the phone aspect, centred.
 */
export function cellRects(layout: Layout, canvas: Size, gutter: number): CellRect[] {
  const innerW = canvas.width - 2 * gutter;
  const innerH = canvas.height - 2 * gutter;
  const half = gutter / 2;
  const rects = layout.cells.map((c) => {
    // Outer edges in px, then pull inner edges in by half a gutter (outer edges sit on the margin).
    const x0 = gutter + c.x * innerW + (c.x > 0 ? half : 0);
    const x1 = gutter + (c.x + c.w) * innerW - (c.x + c.w < 1 - 1e-9 ? half : 0);
    const y0 = gutter + c.y * innerH + (c.y > 0 ? half : 0);
    const y1 = gutter + (c.y + c.h) * innerH - (c.y + c.h < 1 - 1e-9 ? half : 0);
    const left = Math.round(x0);
    const top = Math.round(y0);
    return { left, top, width: Math.max(1, Math.round(x1) - left), height: Math.max(1, Math.round(y1) - top) };
  });
  if (!layout.id.startsWith("screens-")) return rects;
  // Phone aspect: shrink each cell to 9:19.5 within its slot, keep it centred.
  return rects.map((r) => {
    let width = r.width;
    let height = Math.round(width / SCREEN_ASPECT);
    if (height > r.height) {
      height = r.height;
      width = Math.max(1, Math.round(height * SCREEN_ASPECT));
    }
    return { left: r.left + Math.round((r.width - width) / 2), top: r.top + Math.round((r.height - height) / 2), width, height };
  });
}

/** Parsed collage options (the image ids are validated for shape here, resolved by the renderer). */
export interface CollageOptions {
  layout: Layout;
  /** One entry per cell: an image id, or null for an empty (bg) cell. */
  cells: Array<string | null>;
  gutter: Gutter;
  /** 0-100, like `corners`, applied per cell. */
  cellCorners: number;
  /** The first (or only) fit given: the default shown in the card and used when all cells agree. */
  cellFit: "cover" | "contain";
  /** Fit per cell (same length as `cells`); missing entries take `cellFit`. */
  cellFits: Array<"cover" | "contain">;
  /** Per-cell crop nudge in px (cover cells only), same length as `cells`. */
  nudges: Nudge[];
}

export interface Nudge {
  x: number;
  y: number;
}

export const MAX_NUDGE = 4096;

/**
 * Allowed nudge for a cover cell: the scaled picture is `max(cell/img)` times the source, the
 * attention crop window starts at `base`; the window may move left/up by `base` and right/down
 * by what remains of the scaled picture.
 */
export function nudgeRange(source: Size, cell: Size, base: { left: number; top: number }): { x: [number, number]; y: [number, number] } {
  const scale = Math.max(cell.width / source.width, cell.height / source.height);
  const scaled = { width: Math.round(source.width * scale), height: Math.round(source.height * scale) };
  const neg = (v: number) => (v === 0 ? 0 : -v); // avoid -0 (it confuses deep-equality and JSON)
  return {
    x: [neg(base.left), Math.max(0, scaled.width - cell.width - base.left)],
    y: [neg(base.top), Math.max(0, scaled.height - cell.height - base.top)],
  };
}

export function clampNudge(nudge: Nudge, range: { x: [number, number]; y: [number, number] }): Nudge {
  const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));
  return { x: clamp(nudge.x, range.x), y: clamp(nudge.y, range.y) };
}

/** Scaled size of a source covering a cell (what the crop window moves within). */
export function coverScaled(source: Size, cell: Size): Size {
  const scale = Math.max(cell.width / source.width, cell.height / source.height);
  return { width: Math.round(source.width * scale), height: Math.round(source.height * scale) };
}

/** Canvas size for a collage: preset, else width x height (both), else 1080x1080. */
export function collageCanvas(options: { preset?: Size; width?: number; height?: number }): Size {
  if (options.preset) return { width: options.preset.width, height: options.preset.height };
  if (options.width !== undefined && options.height !== undefined) return { width: options.width, height: options.height };
  if (options.width !== undefined || options.height !== undefined) throw new BadRequestError("A collage needs a preset or both width and height.");
  return { width: 1080, height: 1080 };
}
