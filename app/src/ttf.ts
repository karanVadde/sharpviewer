/**
 * Minimal TrueType (glyf) font reader: enough to turn text into glyph outlines.
 *
 * Supports: cmap formats 4 and 12, short/long loca, simple and composite glyphs
 * (XY offsets, scale / x-y scale / 2x2 transforms), horizontal advances.
 * Not supported: CFF-based OpenType (.otf), variable fonts, cubic 'glyf' flags,
 * point-matched component placement. Errors are thrown for those.
 */

export type Point = [number, number];

/** One contour: TrueType points with on/off-curve flags, in font units. */
export interface Contour {
  points: Point[];
  onCurve: boolean[];
}

export interface Component {
  glyphId: number;
  /** (xx, xy, yx, yy, dx, dy) - fontTools' component transform order. */
  transform: [number, number, number, number, number, number];
}

export type Glyph = { kind: "simple"; contours: Contour[] } | { kind: "composite"; components: Component[] } | { kind: "empty" };

const ON_CURVE = 0x01,
  X_SHORT = 0x02,
  Y_SHORT = 0x04,
  REPEAT = 0x08,
  X_SAME = 0x10,
  Y_SAME = 0x20,
  CUBIC = 0x80;
const ARG_1_AND_2_ARE_WORDS = 0x0001,
  ARGS_ARE_XY_VALUES = 0x0002,
  WE_HAVE_A_SCALE = 0x0008,
  MORE_COMPONENTS = 0x0020,
  WE_HAVE_AN_X_AND_Y_SCALE = 0x0040,
  WE_HAVE_A_TWO_BY_TWO = 0x0080;

export class TrueTypeFont {
  readonly unitsPerEm: number;
  readonly numGlyphs: number;
  private readonly view: DataView;
  private readonly tables = new Map<string, { offset: number; length: number }>();
  private readonly loca: Uint32Array;
  private readonly glyf: { offset: number; length: number };
  private readonly advances: Uint16Array;
  private readonly cmap = new Map<number, number>();
  private readonly glyphCache = new Map<number, Glyph>();

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const v = this.view;
    const tag = v.getUint32(0);
    if (tag === 0x4f54544f) throw new Error("CFF-based OpenType (.otf) fonts are not supported; use a TrueType (.ttf) font");
    if (tag !== 0x00010000 && tag !== 0x74727565) throw new Error("not a TrueType font");

    const numTables = v.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const name = String.fromCharCode(v.getUint8(rec), v.getUint8(rec + 1), v.getUint8(rec + 2), v.getUint8(rec + 3));
      this.tables.set(name, { offset: v.getUint32(rec + 8), length: v.getUint32(rec + 12) });
    }
    const need = (name: string) => {
      const t = this.tables.get(name);
      if (!t) throw new Error(`font has no '${name}' table`);
      return t;
    };

    const head = need("head");
    this.unitsPerEm = v.getUint16(head.offset + 18);
    const indexToLocFormat = v.getInt16(head.offset + 50);
    this.numGlyphs = v.getUint16(need("maxp").offset + 4);

    const loca = need("loca");
    this.loca = new Uint32Array(this.numGlyphs + 1);
    for (let i = 0; i <= this.numGlyphs; i++) {
      this.loca[i] = indexToLocFormat === 0 ? v.getUint16(loca.offset + i * 2) * 2 : v.getUint32(loca.offset + i * 4);
    }
    this.glyf = need("glyf");

    const numberOfHMetrics = v.getUint16(need("hhea").offset + 34);
    const hmtx = need("hmtx");
    this.advances = new Uint16Array(this.numGlyphs);
    for (let i = 0; i < this.numGlyphs; i++) {
      this.advances[i] = v.getUint16(hmtx.offset + Math.min(i, numberOfHMetrics - 1) * 4);
    }

    this.parseCmap(need("cmap").offset);
  }

  /** Same preference order as fontTools' getBestCmap(). */
  private parseCmap(base: number): void {
    const v = this.view;
    const n = v.getUint16(base + 2);
    const subtables = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const rec = base + 4 + i * 8;
      subtables.set(`${v.getUint16(rec)},${v.getUint16(rec + 2)}`, base + v.getUint32(rec + 4));
    }
    const order = ["3,10", "0,6", "0,4", "3,1", "0,3", "0,2", "0,1", "0,0"];
    const offset = order.map((k) => subtables.get(k)).find((o) => o !== undefined);
    if (offset === undefined) throw new Error("font has no usable Unicode cmap subtable");

    const format = v.getUint16(offset);
    if (format === 4) {
      const segCountX2 = v.getUint16(offset + 6);
      const segCount = segCountX2 / 2;
      const ends = offset + 14,
        starts = ends + segCountX2 + 2,
        deltas = starts + segCountX2,
        rangeOffsets = deltas + segCountX2;
      for (let s = 0; s < segCount; s++) {
        const end = v.getUint16(ends + s * 2),
          start = v.getUint16(starts + s * 2);
        const delta = v.getInt16(deltas + s * 2),
          rangeOffset = v.getUint16(rangeOffsets + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end; c++) {
          let g: number;
          if (rangeOffset === 0) g = (c + delta) & 0xffff;
          else {
            const addr = rangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
            g = v.getUint16(addr);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g !== 0 && !this.cmap.has(c)) this.cmap.set(c, g);
        }
      }
    } else if (format === 12) {
      const nGroups = v.getUint32(offset + 12);
      for (let i = 0; i < nGroups; i++) {
        const g = offset + 16 + i * 12;
        const start = v.getUint32(g),
          end = v.getUint32(g + 4),
          startGlyph = v.getUint32(g + 8);
        for (let c = start; c <= end; c++) if (!this.cmap.has(c)) this.cmap.set(c, startGlyph + (c - start));
      }
    } else {
      throw new Error(`unsupported cmap subtable format ${format}`);
    }
  }

  /** Glyph id for a code point, or undefined if the font has no glyph for it. */
  glyphId(codePoint: number): number | undefined {
    return this.cmap.get(codePoint);
  }

  advanceWidth(glyphId: number): number {
    return this.advances[glyphId] ?? 0;
  }

  glyph(glyphId: number): Glyph {
    const cached = this.glyphCache.get(glyphId);
    if (cached) return cached;
    const parsed = this.parseGlyph(glyphId);
    this.glyphCache.set(glyphId, parsed);
    return parsed;
  }

  private parseGlyph(glyphId: number): Glyph {
    if (glyphId < 0 || glyphId >= this.numGlyphs) throw new Error(`glyph id ${glyphId} out of range`);
    const start = this.glyf.offset + this.loca[glyphId]!,
      end = this.glyf.offset + this.loca[glyphId + 1]!;
    if (end <= start) return { kind: "empty" };
    const v = this.view;
    const numberOfContours = v.getInt16(start);
    return numberOfContours >= 0 ? this.parseSimple(start, numberOfContours) : this.parseComposite(start);
  }

  private parseSimple(start: number, numberOfContours: number): Glyph {
    const v = this.view;
    let p = start + 10;
    const endPts: number[] = [];
    for (let i = 0; i < numberOfContours; i++, p += 2) endPts.push(v.getUint16(p));
    const numPoints = numberOfContours === 0 ? 0 : endPts[numberOfContours - 1]! + 1;
    p += 2 + v.getUint16(p); // skip instructions

    const flags = new Uint8Array(numPoints);
    for (let i = 0; i < numPoints; ) {
      const f = v.getUint8(p++);
      flags[i++] = f;
      if (f & REPEAT) {
        let r = v.getUint8(p++);
        while (r-- > 0) flags[i++] = f;
      }
    }
    const xs = new Array<number>(numPoints),
      ys = new Array<number>(numPoints);
    let x = 0;
    for (let i = 0; i < numPoints; i++) {
      const f = flags[i]!;
      if (f & X_SHORT) {
        const d = v.getUint8(p++);
        x += f & X_SAME ? d : -d;
      } else if (!(f & X_SAME)) {
        x += v.getInt16(p);
        p += 2;
      }
      xs[i] = x;
    }
    let y = 0;
    for (let i = 0; i < numPoints; i++) {
      const f = flags[i]!;
      if (f & Y_SHORT) {
        const d = v.getUint8(p++);
        y += f & Y_SAME ? d : -d;
      } else if (!(f & Y_SAME)) {
        y += v.getInt16(p);
        p += 2;
      }
      ys[i] = y;
    }

    const contours: Contour[] = [];
    let s = 0;
    for (const e of endPts) {
      const points: Point[] = [],
        onCurve: boolean[] = [];
      for (let i = s; i <= e; i++) {
        if (flags[i]! & CUBIC) throw new Error("cubic 'glyf' outlines are not supported");
        points.push([xs[i]!, ys[i]!]);
        onCurve.push((flags[i]! & ON_CURVE) !== 0);
      }
      contours.push({ points, onCurve });
      s = e + 1;
    }
    return { kind: "simple", contours };
  }

  private parseComposite(start: number): Glyph {
    const v = this.view;
    let p = start + 10;
    const components: Component[] = [];
    for (;;) {
      const flags = v.getUint16(p),
        glyphId = v.getUint16(p + 2);
      p += 4;
      let dx: number, dy: number;
      if (!(flags & ARGS_ARE_XY_VALUES)) throw new Error("point-matched composite glyphs are not supported");
      if (flags & ARG_1_AND_2_ARE_WORDS) {
        dx = v.getInt16(p);
        dy = v.getInt16(p + 2);
        p += 4;
      } else {
        dx = v.getInt8(p);
        dy = v.getInt8(p + 1);
        p += 2;
      }
      const f2 = (o: number) => v.getInt16(o) / 16384;
      let xx = 1,
        xy = 0,
        yx = 0,
        yy = 1;
      if (flags & WE_HAVE_A_SCALE) {
        xx = yy = f2(p);
        p += 2;
      } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
        xx = f2(p);
        yy = f2(p + 2);
        p += 4;
      } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
        xx = f2(p);
        xy = f2(p + 2);
        yx = f2(p + 4);
        yy = f2(p + 6);
        p += 8;
      }
      components.push({ glyphId, transform: [xx, xy, yx, yy, dx, dy] });
      if (!(flags & MORE_COMPONENTS)) break;
    }
    return { kind: "composite", components };
  }
}
