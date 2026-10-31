/**
 * Text -> watermark SVG with the glyphs baked in as outline paths.
 *
 * This is a faithful port of tools/make-watermark.py (fontTools' SVGPathPen,
 * BoundsPen, BasePen quadratic decomposition, Glyph.draw contour handling and
 * Python float formatting), so both produce byte-identical SVG for the same
 * input. A test guards that equivalence.
 */
import { type Glyph, type Point, TrueTypeFont } from "./ttf.ts";

export interface WatermarkTextOptions {
  text: string;
  /** TrueType font file contents. */
  font: Uint8Array;
  fontName: string;
  size?: number;
  letterSpacing?: number;
  stroke?: number;
  fill?: string;
  strokeColor?: string;
}

export interface WatermarkSvg {
  svg: string;
  width: number;
  height: number;
}

export const WATERMARK_TEXT_MAX_LENGTH = 80;

/** Python repr() of a float, for byte-identical output with the Python generator. */
export function pyFloat(v: number): string {
  if (Number.isNaN(v) || !Number.isFinite(v)) throw new Error("non-finite coordinate");
  if (Object.is(v, -0)) return "-0.0";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) {
    // Python: "1.5e-05", "1e+16"; JS toExponential: "1.5e-5", "1e+16".
    const [mantissa, exp] = v.toExponential().split("e") as [string, string];
    const sign = exp.startsWith("-") ? "-" : "+";
    const digits = exp.replace(/^[-+]/, "").padStart(2, "0");
    return `${mantissa}e${sign}${digits}`;
  }
  if (Number.isInteger(v)) return `${v}.0`;
  return String(v);
}

type Transform = [number, number, number, number, number, number];

/** fontTools Transform.transformPoint */
function transformPoint(t: Transform, [x, y]: Point): Point {
  const [xx, xy, yx, yy, dx, dy] = t;
  return [xx * x + yx * y + dx, xy * x + yy * y + dy];
}

/** fontTools Transform.transform(other): `self` transformed by `other`. */
function composeTransform(self: Transform, other: Transform): Transform {
  const [xx1, xy1, yx1, yy1, dx1, dy1] = other;
  const [xx2, xy2, yx2, yy2, dx2, dy2] = self;
  return [xx1 * xx2 + xy1 * yx2, xx1 * xy2 + xy1 * yy2, yx1 * xx2 + yy1 * yx2, yx1 * xy2 + yy1 * yy2, xx2 * dx1 + yx2 * dy1 + dx2, xy2 * dx1 + yy2 * dy1 + dy2];
}

/** fontTools BasePen: segment-level API with quadratic decomposition; subclasses implement the *One hooks. */
abstract class BasePen {
  protected current: Point | null = null;

  moveTo(pt: Point): void {
    this._moveTo(pt);
    this.current = pt;
  }
  lineTo(pt: Point): void {
    this._lineTo(pt);
    this.current = pt;
  }
  closePath(): void {
    this._closePath();
    this.current = null;
  }

  /** points: off-curve..., on-curve (or null for an all-off-curve contour). */
  qCurveTo(points: Array<Point | null>): void {
    const n = points.length - 1;
    let pts: Point[];
    if (points[points.length - 1] === null) {
      const [x, y] = points[points.length - 2] as Point;
      const [nx, ny] = points[0] as Point;
      const implied: Point = [0.5 * (x + nx), 0.5 * (y + ny)];
      this.current = implied;
      this._moveTo(implied);
      pts = [...(points.slice(0, -1) as Point[]), implied];
    } else {
      pts = points as Point[];
    }
    if (n > 0) {
      for (let i = 0; i < n - 1; i++) {
        const [x, y] = pts[i]!,
          [nx, ny] = pts[i + 1]!;
        const implied: Point = [0.5 * (x + nx), 0.5 * (y + ny)];
        this._qCurveToOne(pts[i]!, implied);
        this.current = implied;
      }
      this._qCurveToOne(pts[n - 1]!, pts[n]!);
      this.current = pts[n]!;
    } else {
      this.lineTo(pts[0]!);
    }
  }

  protected abstract _moveTo(pt: Point): void;
  protected abstract _lineTo(pt: Point): void;
  protected abstract _qCurveToOne(c: Point, pt: Point): void;
  protected abstract _closePath(): void;
}

/** fontTools SVGPathPen */
class SVGPathPen extends BasePen {
  private commands: string[] = [];
  private lastCommand: string | null = null;
  private lastX: number | null = null;
  private lastY: number | null = null;

  protected _moveTo(pt: Point): void {
    if (this.lastCommand === "M") this.commands.pop();
    this.commands.push(`M${pyFloat(pt[0])} ${pyFloat(pt[1])}`);
    this.lastCommand = "M";
    [this.lastX, this.lastY] = pt;
  }

  protected _lineTo(pt: Point): void {
    const [x, y] = pt;
    let cmd: string | null, pts: string;
    if (x === this.lastX && y === this.lastY) return;
    if (x === this.lastX) {
      cmd = "V";
      pts = pyFloat(y);
    } else if (y === this.lastY) {
      cmd = "H";
      pts = pyFloat(x);
    } else if (this.lastCommand === "M") {
      cmd = null;
      pts = ` ${pyFloat(x)} ${pyFloat(y)}`;
    } else {
      cmd = "L";
      pts = `${pyFloat(x)} ${pyFloat(y)}`;
    }
    let t = "";
    if (cmd) {
      t += cmd;
      this.lastCommand = cmd;
    }
    this.commands.push(t + pts);
    [this.lastX, this.lastY] = pt;
  }

  protected _qCurveToOne(c: Point, pt: Point): void {
    this.commands.push(`Q${pyFloat(c[0])} ${pyFloat(c[1])} ${pyFloat(pt[0])} ${pyFloat(pt[1])}`);
    this.lastCommand = "Q";
    [this.lastX, this.lastY] = pt;
  }

  protected _closePath(): void {
    this.commands.push("Z");
    this.lastCommand = "Z";
    this.lastX = this.lastY = null;
  }

  getCommands(): string {
    return this.commands.join("");
  }
}

type Rect = [number, number, number, number];

/** fontTools BoundsPen (exact curve extremes) */
class BoundsPen extends BasePen {
  bounds: Rect | null = null;
  private start: Point | null = null;

  private addMoveTo(): void {
    if (this.start === null) return;
    this.bounds = this.bounds ? updateBounds(this.bounds, this.start) : [this.start[0], this.start[1], this.start[0], this.start[1]];
    this.start = null;
  }
  protected _moveTo(pt: Point): void {
    this.start = pt;
    this.addMoveTo();
  }
  protected _lineTo(pt: Point): void {
    this.addMoveTo();
    this.bounds = updateBounds(this.bounds, pt);
  }
  protected _qCurveToOne(c: Point, pt: Point): void {
    this.addMoveTo();
    let b = updateBounds(this.bounds, pt);
    if (!pointInRect(c, b)) b = unionRect(b, calcQuadraticBounds(this.current!, c, pt));
    this.bounds = b;
  }
  protected _closePath(): void {}
}

function updateBounds(b: Rect | null, [x, y]: Point): Rect {
  if (b === null) return [x, y, x, y];
  return [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
}
function unionRect(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
function pointInRect([x, y]: Point, [xMin, yMin, xMax, yMax]: Rect): boolean {
  return xMin <= x && x <= xMax && yMin <= y && y <= yMax;
}
function calcQuadraticBounds(pt1: Point, pt2: Point, pt3: Point): Rect {
  const [x2, y2] = pt2,
    [x3, y3] = pt3,
    [cx, cy] = pt1;
  const bx = (x2 - cx) * 2.0,
    by = (y2 - cy) * 2.0;
  const ax = x3 - cx - bx,
    ay = y3 - cy - by;
  const ax2 = ax * 2.0,
    ay2 = ay * 2.0;
  const roots: number[] = [];
  if (ax2 !== 0) roots.push(-bx / ax2);
  if (ay2 !== 0) roots.push(-by / ay2);
  const points: Point[] = roots.filter((t) => 0 <= t && t < 1).map((t) => [ax * t * t + bx * t + cx, ay * t * t + by * t + cy]);
  points.push(pt1, pt3);
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** fontTools _g_l_y_f.Glyph.draw + TransformPen + BasePen.addComponent, drawing into `pen`. */
function drawGlyph(font: TrueTypeFont, glyph: Glyph, transform: Transform, pen: BasePen): void {
  if (glyph.kind === "empty") return;
  if (glyph.kind === "composite") {
    for (const component of glyph.components) {
      drawGlyph(font, font.glyph(component.glyphId), composeTransform(transform, component.transform), pen);
    }
    return;
  }
  const tp = (p: Point) => transformPoint(transform, p);
  for (const contour of glyph.contours) {
    let points = contour.points.slice();
    let flags = contour.onCurve.slice();
    if (!flags.includes(true)) {
      // No on-curve point at all: BasePen's special case with a trailing null.
      pen.qCurveTo([...points.map(tp), null]);
    } else {
      const firstOnCurve = flags.indexOf(true) + 1;
      points = [...points.slice(firstOnCurve), ...points.slice(0, firstOnCurve)];
      flags = [...flags.slice(firstOnCurve), ...flags.slice(0, firstOnCurve)];
      pen.moveTo(tp(points[points.length - 1]!));
      while (points.length) {
        const nextOnCurve = flags.indexOf(true) + 1;
        if (nextOnCurve === 1) {
          if (points.length > 1) pen.lineTo(tp(points[0]!));
        } else {
          pen.qCurveTo(points.slice(0, nextOnCurve).map(tp));
        }
        points = points.slice(nextOnCurve);
        flags = flags.slice(nextOnCurve);
      }
    }
    pen.closePath();
  }
}

/** xml.sax.saxutils.escape: &, <, > only. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Python's `%g`-style formatting for the values used in the comment/attributes. */
function pyG(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Number(v.toPrecision(6)).toString();
}

/** Validate the text the way the generator and the UI both require. Returns an error message or null. */
export function validateWatermarkText(text: string, font?: TrueTypeFont): string | null {
  if (!text.trim()) return "text must not be empty or whitespace only";
  if ([...text].length > WATERMARK_TEXT_MAX_LENGTH) return `text must be at most ${WATERMARK_TEXT_MAX_LENGTH} characters`;
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return "text must not contain control characters";
  if (font) {
    const missing = [...new Set([...text].filter((ch) => !/\s/.test(ch) && font.glyphId(ch.codePointAt(0)!) === undefined))].sort();
    if (missing.length) return `font has no glyph for: ${missing.map((c) => `'${c}'`).join(" ")}`;
  }
  return null;
}

export function buildWatermarkSvg(options: WatermarkTextOptions): WatermarkSvg {
  const { text, fontName } = options;
  const size = options.size ?? 44,
    letterSpacing = options.letterSpacing ?? 2,
    stroke = options.stroke ?? 2;
  const fill = options.fill ?? "#f6f5f1",
    strokeColor = options.strokeColor ?? "#1f2933";
  if (size <= 0) throw new Error("size must be > 0");
  if (stroke < 0) throw new Error("stroke must be >= 0");

  const font = new TrueTypeFont(options.font);
  const problem = validateWatermarkText(text, font);
  if (problem) throw new Error(problem);

  const scale = size / font.unitsPerEm;
  const svgPen = new SVGPathPen();
  const boundsPen = new BoundsPen();
  const space = font.glyphId(0x20);
  let x = 0.0;
  for (const ch of text) {
    const gid = font.glyphId(ch.codePointAt(0)!) ?? space;
    if (gid === undefined) throw new Error("font has no space glyph");
    const glyph = font.glyph(gid);
    const t: Transform = [scale, 0, 0, -scale, x, 0];
    drawGlyph(font, glyph, t, svgPen);
    drawGlyph(font, glyph, t, boundsPen);
    x += font.advanceWidth(gid) * scale + letterSpacing;
  }

  const d = svgPen.getCommands();
  if (boundsPen.bounds === null) throw new Error("text produced no visible glyphs");
  let [xmin, ymin, xmax, ymax] = boundsPen.bounds;
  xmin = Math.floor(xmin - stroke / 2);
  ymin = Math.floor(ymin - stroke / 2);
  xmax = Math.ceil(xmax + stroke / 2);
  ymax = Math.ceil(ymax + stroke / 2);
  const w = xmax - xmin,
    h = ymax - ymin;

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${xmin} ${ymin} ${w} ${h}">`,
    `  <!-- Watermark: "${xmlEscape(text)}" as glyph outlines (no font needed), text only, no background.`,
    `       Generated by tools/make-watermark.py from ${xmlEscape(fontName)} at ${pyG(size)}px. -->`,
    '  <g id="mark">',
  ];
  if (stroke) {
    lines.push(`    <path d="${d}" fill="none" stroke="${xmlEscape(strokeColor)}" stroke-width="${pyG(stroke)}" stroke-linejoin="round"/>`);
  }
  lines.push(`    <path d="${d}" fill="${xmlEscape(fill)}"/>`, "  </g>", "</svg>", "");
  return { svg: lines.join("\n"), width: w, height: h };
}

/** Read the text back out of a generated watermark SVG (from its comment), or null. */
export function watermarkTextOf(svg: string): string | null {
  const m = /<!-- Watermark: "([\s\S]*?)" as glyph outlines/.exec(svg);
  if (!m) return null;
  return m[1]!.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}
