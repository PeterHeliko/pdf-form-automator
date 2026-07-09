/** Port of extract.py: text spans and normalized line geometry per page.
 *
 * PyMuPDF's get_text("rawdict") is rebuilt from mupdf.js structured text
 * (per-char quads/origins), and get_drawings() from a custom JS Device that
 * walks the page's paths. Everything downstream (heuristics, tables) only
 * sees the normalized PageData / RawDrawing shapes.
 */

import * as mupdf from "mupdf";

import { Rect, pyRound } from "./geometry";
import { findTables } from "./tables";
import type {
  Box, HSeg, PageChar, PageData, RawDrawing, RawItem, Span, TextLine, VSeg,
} from "./types";

export const THIN = 2.5; // a rect thinner than this is a line in disguise

// ------------------------------------------------------------------- text

interface RawChar {
  c: string;
  bbox: Rect;
  originX: number;
  originY: number;
}

/** Equivalent of one rawdict span: chars grouped by font/size/color. */
interface RawSpan {
  key: string;
  size: number;
  bold: boolean;
  ascender: number;
  descender: number;
  chars: RawChar[];
}

/** Part of a span after underscore splitting (rawdict-span-shaped). */
interface SpanPart {
  text: string;
  bbox: Rect;
  size: number;
  bold: boolean;
  ascender: number;
  descender: number;
  originY: number;
}

function quadBounds(q: number[]): Rect {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return new Rect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

function walkText(list: mupdf.DisplayList): { rawLines: RawSpan[][]; pageChars: PageChar[] } {
  const rawLines: RawSpan[][] = [];
  const pageChars: PageChar[] = [];
  let curLine: RawSpan[] | null = null;
  let curSpan: RawSpan | null = null;

  // real space advance per font, to recognize synthetic gap-filler spaces
  const spaceAdv = new Map<number, number>();
  const spaceAdvance = (font: mupdf.Font): number => {
    let adv = spaceAdv.get(font.pointer as unknown as number);
    if (adv === undefined) {
      adv = font.advanceGlyph(font.encodeCharacter(32));
      if (!(adv > 0)) adv = 0.25;
      spaceAdv.set(font.pointer as unknown as number, adv);
    }
    return adv;
  };

  const st = list.toStructuredText("preserve-ligatures,preserve-whitespace,clip");
  try {
    st.walk({
      beginLine() {
        curLine = [];
        rawLines.push(curLine);
        curSpan = null;
      },
      endLine() {
        curLine = null;
        curSpan = null;
      },
      onChar(c, origin, font, size, quad, color) {
        if (curLine === null) return;
        const bbox = quadBounds(quad);
        pageChars.push({ text: c, x0: bbox.x0, x1: bbox.x1, top: bbox.y0, bottom: bbox.y1 });
        // group like PyMuPDF's span builder: font name without the subset
        // prefix, bold/italic flags, size, and the sRGB-quantized color
        const name = font.getName().replace(/^[A-Z]{6}\+/, "");
        const rgb = color.map((v) => Math.round(v * 255)).join(",");
        let key = `${name}|${font.isBold() ? 1 : 0}${font.isItalic() ? 1 : 0}|${size}|${rgb}`;
        // a space much wider than the font's space glyph was synthesized by
        // MuPDF to fill a gap (tab stops etc.); PyMuPDF puts it in a span of
        // its own (char_flags change), which breaks label runs at the gap
        if (c === " " && size > 0 && bbox.x1 - bbox.x0 > spaceAdvance(font) * size * 1.3 + 0.1) {
          key += "|synthetic";
        }
        if (curSpan === null || curSpan.key !== key) {
          // ascender/descender: MuPDF builds char quads from the font's
          // ascent/descent around the baseline, so they can be derived back
          let asc = 0.85;
          let desc = -0.25;
          if (size > 0 && bbox.y1 > bbox.y0) {
            asc = (origin[1] - bbox.y0) / size;
            desc = (origin[1] - bbox.y1) / size;
          }
          curSpan = { key, size, bold: font.isBold(), ascender: asc, descender: desc, chars: [] };
          curLine.push(curSpan);
        }
        curSpan.chars.push({ c, bbox, originX: origin[0], originY: origin[1] });
      },
    });
  } finally {
    st.destroy();
  }
  return { rawLines, pageChars };
}

/** Port of _tight_bbox: clamp the vertical extent around the baseline. */
function tightBbox(part: SpanPart): Rect {
  const r = part.bbox;
  const baseline = part.originY;
  const size = part.size;
  const asc = Math.min(part.ascender, 0.9);
  const desc = Math.max(part.descender, -0.3);
  return new Rect(
    r.x0, Math.max(r.y0, baseline - asc * size),
    r.x1, Math.min(r.y1, baseline - desc * size),
  );
}

/** Port of _split_underscores: split a span into text parts and
 * underscore-run underlines. */
function splitUnderscores(span: RawSpan): { parts: SpanPart[]; segs: HSeg[] } {
  const parts: SpanPart[] = [];
  const segs: HSeg[] = [];
  const chars = span.chars;
  let i = 0;
  while (i < chars.length) {
    if (chars[i].c === "_") {
      let j = i;
      while (j < chars.length && chars[j].c === "_") j++;
      if (j - i >= 3) {
        segs.push({ y: chars[i].originY, x0: chars[i].bbox.x0, x1: chars[j - 1].bbox.x1, fromText: true });
      }
      i = j;
    } else {
      let j = i;
      while (j < chars.length && chars[j].c !== "_") j++;
      const text = chars.slice(i, j).map((c) => c.c).join("");
      if (text.trim()) {
        // leading/trailing spaces widen the bbox over neighbouring geometry
        const inked = chars.slice(i, j).filter((c) => c.c !== " ");
        const bbox = inked[0].bbox.clone();
        for (const c of inked.slice(1)) bbox.includeRect(c.bbox);
        parts.push({
          text, bbox,
          size: span.size, bold: span.bold,
          ascender: span.ascender, descender: span.descender,
          originY: inked[0].originY,
        });
      }
      i = j;
    }
  }
  return { parts, segs };
}

/** Port of _text_lines. */
function textLines(rawLines: RawSpan[][]): { lines: TextLine[]; underscoreSegs: HSeg[] } {
  const lines: TextLine[] = [];
  const underscoreSegs: HSeg[] = [];
  for (const rawLine of rawLines) {
    const spans: Span[] = [];
    for (const raw of rawLine) {
      const { parts, segs } = splitUnderscores(raw);
      underscoreSegs.push(...segs);
      for (const p of parts) {
        spans.push({ text: p.text.trim(), bbox: tightBbox(p), size: p.size, bold: p.bold });
      }
    }
    if (spans.length) {
      const bbox = spans[0].bbox.clone();
      for (const s of spans.slice(1)) bbox.includeRect(s.bbox);
      lines.push({ spans, bbox });
    }
  }
  lines.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  return { lines: mergeBaselines(lines), underscoreSegs };
}

/** Port of _merge_baselines: join text lines sharing a baseline. */
export function mergeBaselines(lines: TextLine[]): TextLine[] {
  const merged: TextLine[] = [];
  for (const line of lines) {
    let target: TextLine | null = null;
    for (const m of merged) {
      const overlap = Math.min(m.bbox.y1, line.bbox.y1) - Math.max(m.bbox.y0, line.bbox.y0);
      if (overlap > 0.5 * Math.min(m.bbox.height, line.bbox.height)) {
        target = m;
        break;
      }
    }
    if (target) {
      target.spans = target.spans.concat(line.spans).sort((a, b) => a.bbox.x0 - b.bbox.x0);
      target.bbox.includeRect(line.bbox);
    } else {
      merged.push(line);
    }
  }
  merged.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  return merged;
}

// --------------------------------------------------------------- drawings

interface SubPath {
  pts: [number, number][];
  kinds: ("l" | "c")[]; // one per segment pts[i] -> pts[i+1]
  curvePts: [number, number][]; // control points, only for the bbox
  closed: boolean;
}

function transformPoint(m: mupdf.Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const EPS = 1e-6;

/** Convert one fill/stroke device call into a RawDrawing, reproducing the
 * item taxonomy of PyMuPDF's get_drawings (l / re / qu items). */
function pathToDrawing(
  path: mupdf.Path, ctm: mupdf.Matrix, type: "f" | "s", width: number,
): RawDrawing | null {
  const subpaths: SubPath[] = [];
  let cur: SubPath | null = null;
  path.walk({
    moveTo(x, y) {
      cur = { pts: [transformPoint(ctm, x, y)], kinds: [], curvePts: [], closed: false };
      subpaths.push(cur);
    },
    lineTo(x, y) {
      if (!cur) return;
      cur.pts.push(transformPoint(ctm, x, y));
      cur.kinds.push("l");
    },
    curveTo(x1, y1, x2, y2, x3, y3) {
      if (!cur) return;
      cur.curvePts.push(transformPoint(ctm, x1, y1), transformPoint(ctm, x2, y2));
      cur.pts.push(transformPoint(ctm, x3, y3));
      cur.kinds.push("c");
    },
    closePath() {
      if (cur) cur.closed = true;
    },
  });

  const items: RawItem[] = [];
  let closePath = false;
  const bbox = new Rect(Infinity, Infinity, -Infinity, -Infinity);
  const extend = (p: [number, number]) => {
    bbox.x0 = Math.min(bbox.x0, p[0]);
    bbox.y0 = Math.min(bbox.y0, p[1]);
    bbox.x1 = Math.max(bbox.x1, p[0]);
    bbox.y1 = Math.max(bbox.y1, p[1]);
  };

  for (const sp of subpaths) {
    for (const p of sp.pts) extend(p);
    for (const p of sp.curvePts) extend(p);
    if (sp.closed) closePath = true;

    let pts = sp.pts;
    const pureLines = sp.kinds.every((k) => k === "l");
    if (sp.closed && pureLines) {
      // drop a redundant trailing point equal to the start
      if (pts.length === 5 &&
          Math.abs(pts[4][0] - pts[0][0]) < EPS && Math.abs(pts[4][1] - pts[0][1]) < EPS) {
        pts = pts.slice(0, 4);
      }
      if (pts.length === 4) {
        const axisAligned = isAxisAlignedQuad(pts);
        const r = new Rect(
          Math.min(pts[0][0], pts[1][0], pts[2][0], pts[3][0]),
          Math.min(pts[0][1], pts[1][1], pts[2][1], pts[3][1]),
          Math.max(pts[0][0], pts[1][0], pts[2][0], pts[3][0]),
          Math.max(pts[0][1], pts[1][1], pts[2][1], pts[3][1]),
        );
        if (axisAligned) {
          items.push({ kind: "re", rect: r });
        } else {
          items.push({ kind: "qu", points: pts as [number, number][], rect: r });
        }
        continue;
      }
    }
    // plain polyline: one "l" item per line segment (curves are dropped,
    // like the "c" items both Python consumers ignore)
    for (let i = 0; i < sp.kinds.length; i++) {
      if (sp.kinds[i] === "l") {
        items.push({ kind: "l", x0: sp.pts[i][0], y0: sp.pts[i][1], x1: sp.pts[i + 1][0], y1: sp.pts[i + 1][1] });
      }
    }
  }

  if (!items.length && !subpaths.length) return null;
  if (bbox.x0 === Infinity) return null;
  return { type, rect: bbox, items, closePath, width };
}

function isAxisAlignedQuad(pts: [number, number][]): boolean {
  // consecutive edges (incl. the closing one) each horizontal or vertical
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const horiz = Math.abs(a[1] - b[1]) < EPS;
    const vert = Math.abs(a[0] - b[0]) < EPS;
    if (!horiz && !vert) return false;
  }
  return true;
}

export function collectDrawings(list: mupdf.DisplayList): RawDrawing[] {
  const drawings: RawDrawing[] = [];
  const dev = new mupdf.Device({
    fillPath(path, _evenOdd, ctm) {
      const d = pathToDrawing(path, ctm, "f", 0);
      if (d) drawings.push(d);
    },
    strokePath(path, stroke, ctm) {
      const d = pathToDrawing(path, ctm, "s", stroke.getLineWidth());
      if (d) drawings.push(d);
    },
  });
  try {
    list.run(dev, mupdf.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
  }
  return drawings;
}

// --------------------------------------------------------------- segments

/** Port of _merge_hsegs. */
export function mergeHsegs(segs: HSeg[]): HSeg[] {
  const merged: HSeg[] = [];
  const sorted = segs.slice().sort((a, b) => pyRound(a.y) - pyRound(b.y) || a.x0 - b.x0);
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.y - s.y) <= 1.5 &&
        s.x0 <= last.x1 + 2 && s.x1 >= last.x0 - 2) {
      last.x0 = Math.min(last.x0, s.x0);
      last.x1 = Math.max(last.x1, s.x1);
      last.fromText = last.fromText || s.fromText;
    } else {
      merged.push({ y: s.y, x0: s.x0, x1: s.x1, fromText: s.fromText });
    }
  }
  return merged.filter((s) => s.x1 - s.x0 >= 4);
}

/** Port of _merge_vsegs. */
export function mergeVsegs(segs: VSeg[]): VSeg[] {
  const merged: VSeg[] = [];
  const sorted = segs.slice().sort((a, b) => pyRound(a.x) - pyRound(b.x) || a.y0 - b.y0);
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.x - s.x) <= 1.5 &&
        s.y0 <= last.y1 + 2 && s.y1 >= last.y0 - 2) {
      last.y0 = Math.min(last.y0, s.y0);
      last.y1 = Math.max(last.y1, s.y1);
    } else {
      merged.push({ x: s.x, y0: s.y0, y1: s.y1 });
    }
  }
  return merged.filter((s) => s.y1 - s.y0 >= 4);
}

/** Port of _segments: normalize drawings into h/v segments. */
function segments(drawings: RawDrawing[], pageArea: number): { hsegs: HSeg[]; vsegs: VSeg[] } {
  const hsegs: HSeg[] = [];
  const vsegs: VSeg[] = [];

  const addRectBorder = (r: Rect) => {
    hsegs.push({ y: r.y0, x0: r.x0, x1: r.x1, fromText: false });
    hsegs.push({ y: r.y1, x0: r.x0, x1: r.x1, fromText: false });
    vsegs.push({ x: r.x0, y0: r.y0, y1: r.y1 });
    vsegs.push({ x: r.x1, y0: r.y0, y1: r.y1 });
  };

  for (const drawing of drawings) {
    for (const item of drawing.items) {
      if (item.kind === "l") {
        if (Math.abs(item.y0 - item.y1) <= 1.5 && Math.abs(item.x1 - item.x0) > 2) {
          const [x0, x1] = item.x0 <= item.x1 ? [item.x0, item.x1] : [item.x1, item.x0];
          hsegs.push({ y: (item.y0 + item.y1) / 2, x0, x1, fromText: false });
        } else if (Math.abs(item.x0 - item.x1) <= 1.5 && Math.abs(item.y1 - item.y0) > 2) {
          const [y0, y1] = item.y0 <= item.y1 ? [item.y0, item.y1] : [item.y1, item.y0];
          vsegs.push({ x: (item.x0 + item.x1) / 2, y0, y1 });
        }
      } else if (item.kind === "re") {
        const r = item.rect.clone().normalize();
        if (r.area() > pageArea * 0.9) continue; // page background fill
        if (r.height <= THIN && r.width > 2) {
          hsegs.push({ y: (r.y0 + r.y1) / 2, x0: r.x0, x1: r.x1, fromText: false });
        } else if (r.width <= THIN && r.height > 2) {
          vsegs.push({ x: (r.x0 + r.x1) / 2, y0: r.y0, y1: r.y1 });
        } else if (drawing.type === "s") {
          addRectBorder(r);
        }
      } else {
        const r = item.rect;
        if (r.area() < pageArea * 0.9 && r.width > 2 && r.height > 2) {
          addRectBorder(r);
        }
      }
    }
  }

  return { hsegs: mergeHsegs(hsegs), vsegs: mergeVsegs(vsegs) };
}

// ------------------------------------------------------------------ boxes

/** Port of _find_boxes: closed rectangles formed by the segments, keeping
 * only atomic cells. */
export function findBoxes(hsegs: HSeg[], vsegs: VSeg[]): Box[] {
  const TOL = 3.0;
  const boxes: Rect[] = [];
  for (const top of hsegs) {
    for (const bot of hsegs) {
      if (bot.y - top.y < 4) continue;
      const x0 = Math.max(top.x0, bot.x0);
      const x1 = Math.min(top.x1, bot.x1);
      if (x1 - x0 < 4) continue;
      const lefts = vsegs.some(
        (v) => Math.abs(v.x - x0) <= TOL && v.y0 <= top.y + TOL && v.y1 >= bot.y - TOL,
      );
      const rights = vsegs.some(
        (v) => Math.abs(v.x - x1) <= TOL && v.y0 <= top.y + TOL && v.y1 >= bot.y - TOL,
      );
      if (lefts && rights) boxes.push(new Rect(x0, top.y, x1, bot.y));
    }
  }

  const atomic = (r: Rect): boolean => {
    for (const h of hsegs) {
      if (r.y0 + TOL < h.y && h.y < r.y1 - TOL && h.x0 < r.x1 - TOL && h.x1 > r.x0 + TOL) return false;
    }
    for (const v of vsegs) {
      if (r.x0 + TOL < v.x && v.x < r.x1 - TOL && v.y0 < r.y1 - TOL && v.y1 > r.y0 + TOL) return false;
    }
    return true;
  };

  return boxes.filter(atomic).map((r) => ({ rect: r }));
}

// ------------------------------------------------------------------- main

/** Port of extract_page. Also returns the raw drawings and chars, which the
 * caller may want for debugging. */
export function extractPage(page: mupdf.PDFPage, pageNumber: number): PageData {
  // synthesize missing widget/annotation appearance streams so text drawn by
  // existing form fields is visible to extraction (PyMuPDF does this on load)
  page.update();
  const bounds = page.getBounds();
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];

  // display list with annotations/widgets: the page-level structured text
  // helper only runs the page contents, but PyMuPDF extraction sees both
  const list = page.toDisplayList(true);
  let drawings: RawDrawing[];
  let rawLines: RawSpan[][];
  let pageChars: PageChar[];
  try {
    drawings = collectDrawings(list);
    ({ rawLines, pageChars } = walkText(list));
  } finally {
    list.destroy();
  }
  const { hsegs: drawnH, vsegs } = segments(drawings, width * height);
  const { lines, underscoreSegs } = textLines(rawLines);
  const hsegs = mergeHsegs(drawnH.concat(underscoreSegs));

  const data: PageData = {
    number: pageNumber,
    width,
    height,
    lines,
    hsegs,
    vsegs,
    boxes: [],
    tables: findTables(drawings, pageChars, width, height),
  };
  data.boxes = findBoxes(hsegs, vsegs);
  return data;
}
