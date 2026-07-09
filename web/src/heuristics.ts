/** Port of heuristics.py: turn extracted page geometry into form-field
 * candidates. Kept as close to a line-by-line translation as possible —
 * thresholds and control flow are load-bearing.
 */

import { Rect } from "./geometry";
import type { Box, Candidate, FType, HSeg, PageData, Span, Table, TextLine } from "./types";
import { lineText, makeCandidate } from "./types";

export const SIGNATURE_RE = /unterschrift|unterzeichn|signatur|signature|visum/i;
export const DATE_RE = /\bdatum\b|geburtsdatum|\bdate\b/i;

/** Minimum breathing room between two fields: touching rects read as one
 * blob. Kept tiny so no usable space is wasted. */
export const FIELD_GAP = 1.5;

const MIN_INLINE_GAP = 40.0; // min width for a field right of a label on the same line
const MIN_UNDERLINE_GAP = 30.0;
const MIN_VGAP = 12.0; // min height of an empty area below a label inside a box
const FIELD_HEIGHT = 16.0; // default height for underline fields
const CHECKBOX_MIN = 6.0;
const CHECKBOX_MAX = 18.0;

export function classify(label: string): FType {
  if (SIGNATURE_RE.test(label)) return "signature";
  if (DATE_RE.test(label)) return "date";
  return "text";
}

export function slugify(label: string, maxLen = 40): string {
  let s = label.trim().replace(/:+$/, "").trim();
  const pairs: [string, string][] = [
    ["ä", "ae"], ["ö", "oe"], ["ü", "ue"], ["Ä", "Ae"], ["Ö", "Oe"], ["Ü", "Ue"], ["ß", "ss"],
  ];
  for (const [a, b] of pairs) s = s.split(a).join(b);
  s = s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s.slice(0, maxLen).replace(/^_+|_+$/g, "") || "Feld";
}

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/** Spans that end a label, i.e. end with a colon. */
function labelSpans(line: TextLine): Span[] {
  return line.spans.filter((s) => s.text.trimEnd().endsWith(":"));
}

/** Text of the contiguous span run ending at spans[endIndex]. */
function runLabel(spans: Span[], endIndex: number): string {
  let start = endIndex;
  while (start > 0 && spans[start].bbox.x0 - spans[start - 1].bbox.x1 < 8) start--;
  return spans.slice(start, endIndex + 1).map((s) => s.text).join(" ").trim();
}

/** Fields in the horizontal gaps after each ':'-label on a text line. */
function lineGapFields(line: TextLine, rightEdge: number, page: number): Candidate[] {
  const out: Candidate[] = [];
  const spans = line.spans.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (!span.text.trimEnd().endsWith(":")) continue;
    const gapEnd = i + 1 < spans.length ? spans[i + 1].bbox.x0 - 4 : rightEdge;
    const gapStart = span.bbox.x1 + 4;
    if (gapEnd - gapStart < MIN_INLINE_GAP) continue;
    const label = runLabel(spans, i);
    const rect = new Rect(gapStart, span.bbox.y0 - 2, gapEnd, span.bbox.y1 + 2);
    out.push(makeCandidate(page, rect, classify(label), label));
  }
  return out;
}

/** Row 0 is only a header if most of its non-first cells carry text. */
function isHeaderRow(row: Table["rows"][number]): boolean {
  const rest = row.filter((c) => c.col > 0);
  if (!rest.length) return false;
  const filled = rest.filter((c) => c.text).length;
  return filled >= Math.max(1, rest.length / 2);
}

/** Column headers for a table; falls back to a matching table directly above. */
function tableHeaders(table: Table, allTables: Table[]): { headers: Map<number, string>; ownHeader: boolean } {
  const grid = table.rows;
  if (grid.length && isHeaderRow(grid[0])) {
    const headers = new Map<number, string>();
    for (const c of grid[0]) {
      if (c.text) headers.set(c.col, c.text.replaceAll("\n", " "));
    }
    return { headers, ownHeader: true };
  }
  for (const other of allTables) {
    if (other === table || !other.rows.length) continue;
    const sameCols = other.rows[0].length > 0 &&
      Math.abs(other.bbox.x0 - table.bbox.x0) < 10 &&
      Math.abs(other.bbox.x1 - table.bbox.x1) < 10;
    const dy = table.bbox.y0 - other.bbox.y1;
    if (sameCols && dy >= 0 && dy < 25) {
      const headers = new Map<number, string>();
      for (const row of other.rows) {
        for (const c of row) {
          if (c.text && !headers.has(c.col)) headers.set(c.col, c.text.replaceAll("\n", " "));
        }
      }
      return { headers, ownHeader: false };
    }
  }
  return { headers: new Map(), ownHeader: false };
}

function tableCandidates(data: PageData): Candidate[] {
  const out: Candidate[] = [];
  for (const table of data.tables) {
    const grid = table.rows;
    if (grid.length < 2) continue;
    const { headers, ownHeader } = tableHeaders(table, data.tables);
    for (const row of ownHeader ? grid.slice(1) : grid) {
      if (row.length && row.every((c) => c.text)) continue; // pre-filled row
      const rowLabel = row.length && row[0].col === 0 ? row[0].text.replaceAll("\n", " ") : "";
      for (const cell of row) {
        // a col-0 cell with text is a row header; an empty one is data
        if (cell.text) continue;
        const header = headers.get(cell.col) ?? "";
        let label: string;
        if (header) {
          label = `${header} ${rowLabel}`.trim();
        } else {
          label = `${rowLabel} ${cell.col}`.trim() || `Zeile${cell.row}_Spalte${cell.col}`;
        }
        const rect = cell.rect.plus(2, 2, -2, -2);
        if (rect.isEmpty || rect.width < 10 || rect.height < 8) continue;
        out.push(makeCandidate(data.number, rect, "text", label, { source: "table" }));
      }
    }
  }
  return out;
}

function checkboxCandidates(data: PageData): Candidate[] {
  const out: Candidate[] = [];
  for (const box of data.boxes) {
    const r = box.rect;
    if (!(CHECKBOX_MIN <= r.width && r.width <= CHECKBOX_MAX &&
          CHECKBOX_MIN <= r.height && r.height <= CHECKBOX_MAX &&
          Math.abs(r.width - r.height) <= 4)) continue;
    if (data.lines.some((line) => line.bbox.intersects(r))) continue;
    let label = "";
    let best = 1e9;
    for (const line of data.lines) {
      if (line.bbox.y0 < r.y1 && line.bbox.y1 > r.y0 && line.bbox.x0 >= r.x1 - 2) {
        const d = line.bbox.x0 - r.x1;
        if (d < best) {
          best = d;
          label = lineText(line);
        }
      }
    }
    out.push(makeCandidate(data.number, r.clone(), "checkbox",
      words(label).slice(0, 5).join(" "), { source: "checkbox" }));
  }
  return out;
}

function isCheckboxBox(r: Rect): boolean {
  return CHECKBOX_MIN <= r.width && r.width <= CHECKBOX_MAX &&
         CHECKBOX_MIN <= r.height && r.height <= CHECKBOX_MAX;
}

/** Fields inside drawn boxes: gaps right of labels and empty areas below. */
function boxCandidates(data: PageData): Candidate[] {
  const out: Candidate[] = [];
  const tableAreas = data.tables.map((t) => t.bbox);
  for (const box of data.boxes) {
    const r = box.rect;
    if (isCheckboxBox(r)) continue;
    if (tableAreas.some((t) => r.intersects(t.plus(-2, -2, 2, 2)))) continue;
    const lines = data.lines.filter((l) =>
      l.bbox.intersects(r) && l.bbox.clone().intersect(r).width > l.bbox.width * 0.5,
    );
    lines.sort((a, b) => a.bbox.y0 - b.bbox.y0);
    const inner = r.plus(3, 3, -3, -3);
    if (!lines.length) {
      // completely empty box: one multiline field
      if (inner.width >= MIN_INLINE_GAP && inner.height >= MIN_VGAP) {
        out.push(makeCandidate(data.number, inner, "text", "",
          { multiline: inner.height > 30, source: "box" }));
      }
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const labels = labelSpans(line);
      const belowTop = line.bbox.y1 + 2;
      const belowBottom = i + 1 < lines.length ? lines[i + 1].bbox.y0 - 2 : r.y1 - 3;
      const vgap = belowBottom - belowTop;
      const sortedSpans = line.spans.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
      const lineEndsWithLabel = labels.length > 0 &&
        sortedSpans[sortedSpans.length - 1].text.trimEnd().endsWith(":");
      if (lineEndsWithLabel && vgap >= MIN_VGAP) {
        const label = runLabel(sortedSpans, sortedSpans.length - 1);
        const rect = new Rect(r.x0 + 4, belowTop, r.x1 - 4, belowBottom);
        out.push(makeCandidate(data.number, rect, classify(label), label,
          { multiline: rect.height > 30, source: "box" }));
      } else if (labels.length) {
        for (const cand of lineGapFields(line, r.x1 - 4, data.number)) {
          cand.rect = cand.rect.intersect(inner); // stay inside the box
          cand.source = "box";
          if (!cand.rect.isEmpty && cand.rect.width >= MIN_INLINE_GAP) {
            growGapField(cand, lines, i, inner);
            out.push(cand);
          }
        }
      }
    }
  }
  return out;
}

/** Grow gap fields into the empty band below, up to the next line. */
function growGapField(cand: Candidate, lines: TextLine[], i: number, inner: Rect): void {
  const bottom = i + 1 < lines.length ? lines[i + 1].bbox.y0 - 2 : inner.y1;
  cand.rect.y1 = Math.max(cand.rect.y1, Math.min(bottom, cand.rect.y1 + 10));
}

function segInBoxes(seg: HSeg, boxes: Box[], tables: Rect[]): boolean {
  const TOL = 3.0;
  for (const box of boxes) {
    const r = box.rect;
    if ((Math.abs(seg.y - r.y0) <= TOL || Math.abs(seg.y - r.y1) <= TOL) &&
        seg.x0 >= r.x0 - TOL && seg.x1 <= r.x1 + TOL) {
      return true;
    }
  }
  return tables.some((t) =>
    t.y0 - TOL <= seg.y && seg.y <= t.y1 + TOL &&
    seg.x0 >= t.x0 - TOL && seg.x1 <= t.x1 + TOL,
  );
}

/** Fill-in lines: horizontal segments that are not box/table edges. */
function underlineCandidates(data: PageData): Candidate[] {
  const out: Candidate[] = [];
  const tableAreas = data.tables.map((t) => t.bbox);
  const TOL = 3.0;
  for (const seg of data.hsegs) {
    if (seg.x1 - seg.x0 < MIN_UNDERLINE_GAP) continue;
    // '____' character runs are always fill-in lines, never borders
    if (!seg.fromText) {
      if (segInBoxes(seg, data.boxes, tableAreas)) continue;
      // a segment whose end connects to a vertical is a border
      const connectsVertical = data.vsegs.some((v) =>
        [seg.x0, seg.x1].some((x) =>
          Math.abs(v.x - x) <= TOL && v.y0 <= seg.y + TOL && v.y1 >= seg.y - TOL &&
          v.y1 - v.y0 > 6,
        ),
      );
      if (connectsVertical) continue;
    }

    // spans sitting on (or immediately left of) the line divide it into
    // fillable stretches
    const onLine: Span[] = [];
    for (const line of data.lines) {
      for (const s of line.spans) {
        if (s.bbox.x1 > seg.x0 - 30 && s.bbox.x0 < seg.x1 &&
            seg.y - 16 <= s.bbox.y1 && s.bbox.y1 <= seg.y + 4) {
          onLine.push(s);
        }
      }
    }
    onLine.sort((a, b) => a.bbox.x0 - b.bbox.x0);

    const stretches: [number, number, string][] = [];
    let cursor = seg.x0;
    let label = "";
    for (let i = 0; i < onLine.length; i++) {
      const span = onLine[i];
      if (span.bbox.x0 - cursor >= MIN_UNDERLINE_GAP) {
        stretches.push([cursor, span.bbox.x0 - 4, label]);
      }
      cursor = Math.max(cursor, span.bbox.x1 + 4);
      label = runLabel(onLine, i);
    }
    if (seg.x1 - cursor >= MIN_UNDERLINE_GAP) {
      stretches.push([cursor, seg.x1, label]);
    }
    if (!onLine.length) {
      stretches.length = 0;
      stretches.push([seg.x0, seg.x1, ""]);
    }

    for (const [x0, x1, labIn] of stretches) {
      let lab = labIn;
      // a same-line label counts if it ends with ':' or is short and
      // label-like; long prose next to a line is usually decoration
      let ok = lab.trimEnd().endsWith(":") ||
        (lab.length > 0 && lab.length <= 40 && words(lab).length <= 5);
      if (!ok) {
        // fall back to the text line just above, colon required there
        const above = data.lines.filter((l) =>
          seg.y - l.bbox.y1 > 0 && seg.y - l.bbox.y1 < 35 && l.bbox.x1 > x0 && l.bbox.x0 < x1,
        );
        lab = above.length ? lineText(above[above.length - 1]) : "";
        ok = lab.trimEnd().endsWith(":");
      }
      if (!ok) {
        // unlabeled continuation line: inherit from the accepted field above
        for (let pi = out.length - 1; pi >= 0; pi--) {
          const prev = out[pi];
          const xOverlap = Math.min(prev.rect.x1, x1) - Math.max(prev.rect.x0, x0);
          const dy = seg.y - prev.rect.y1;
          if (dy > 0 && dy <= 30 && xOverlap > 0.8 * (x1 - x0)) {
            lab = prev.label;
            ok = true;
            break;
          }
        }
      }
      if (!ok) continue;
      const rect = new Rect(x0, seg.y - FIELD_HEIGHT, x1, seg.y + 1);
      out.push(makeCandidate(data.number, rect, classify(lab), lab, { source: "underline" }));
    }
  }
  return out;
}

/** Largest edge-trimmed sub-rect of r that no longer intersects k (and
 * keeps FIELD_GAP distance to it). */
export function trimRect(r: Rect, k: Rect): Rect | null {
  const g = FIELD_GAP;
  const options: Rect[] = [];
  if (k.y1 + g < r.y1) options.push(new Rect(r.x0, k.y1 + g, r.x1, r.y1)); // keep lower part
  if (k.y0 - g > r.y0) options.push(new Rect(r.x0, r.y0, r.x1, k.y0 - g)); // keep upper part
  if (k.x1 + g < r.x1) options.push(new Rect(k.x1 + g, r.y0, r.x1, r.y1)); // keep right part
  if (k.x0 - g > r.x0) options.push(new Rect(r.x0, r.y0, k.x0 - g, r.y1)); // keep left part
  const usable = options.filter((o) => o.width >= 8 && o.height >= 6);
  if (!usable.length) return null;
  let bestRect = usable[0];
  for (const o of usable.slice(1)) {
    if (o.area() > bestRect.area()) bestRect = o;
  }
  return bestRect;
}

/** Enforce that detection never emits overlapping fields. */
export function dedupe(candidates: Candidate[]): Candidate[] {
  const kept: Candidate[] = [];
  for (const cand of candidates) {
    let rect = cand.rect.clone();
    let drop = false;
    for (const k of kept) {
      const inter = rect.clone().intersect(k.rect);
      if (inter.isEmpty || inter.area() <= 0.01) continue;
      if (inter.area() > 0.5 * Math.min(rect.area(), k.rect.area())) {
        drop = true;
        break;
      }
      const trimmed = trimRect(rect, k.rect);
      if (trimmed === null) {
        drop = true;
        break;
      }
      rect = trimmed;
    }
    if (!drop) {
      cand.rect = rect;
      kept.push(cand);
    }
  }
  kept.sort((a, b) => a.rect.y0 - b.rect.y0 || a.rect.x0 - b.rect.x0);
  separateTouching(kept);
  return kept;
}

/** Fields from independent detectors may touch without overlapping; shrink
 * the later one (in reading order) just enough to leave FIELD_GAP between
 * them. Skipped when the field would fall below a usable size. */
function separateTouching(kept: Candidate[]): void {
  for (let j = 1; j < kept.length; j++) {
    const b = kept[j].rect;
    for (let i = 0; i < j; i++) {
      const a = kept[i].rect;
      const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;
      const yOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;
      if (xOverlap && !yOverlap) {
        // vertical neighbors
        if (b.y0 >= a.y1 && b.y0 - a.y1 < FIELD_GAP && b.y1 - (a.y1 + FIELD_GAP) >= 6) {
          b.y0 = a.y1 + FIELD_GAP;
        } else if (a.y0 >= b.y1 && a.y0 - b.y1 < FIELD_GAP && (a.y0 - FIELD_GAP) - b.y0 >= 6) {
          b.y1 = a.y0 - FIELD_GAP;
        }
      } else if (yOverlap && !xOverlap) {
        // horizontal neighbors
        if (b.x0 >= a.x1 && b.x0 - a.x1 < FIELD_GAP && b.x1 - (a.x1 + FIELD_GAP) >= 8) {
          b.x0 = a.x1 + FIELD_GAP;
        } else if (a.x0 >= b.x1 && a.x0 - b.x1 < FIELD_GAP && (a.x0 - FIELD_GAP) - b.x0 >= 8) {
          b.x1 = a.x0 - FIELD_GAP;
        }
      }
    }
  }
}

/** Free-standing 'Label:' lines with empty space to the right. */
function bareLabelCandidates(data: PageData): Candidate[] {
  const out: Candidate[] = [];
  if (!data.hsegs.length && !data.boxes.length && !data.tables.length) {
    // a page without any drawn geometry is a letter, not a form
    return out;
  }
  const avoid = data.boxes.map((b) => b.rect).concat(data.tables.map((t) => t.bbox));
  const rightEdge = Math.max(
    ...data.hsegs.map((s) => s.x1),
    ...data.boxes.map((b) => b.rect.x1),
    ...data.lines.map((l) => l.bbox.x1),
    0.0,
  );
  for (const line of data.lines) {
    // two or more labels sharing the line is the letter-closing pattern
    if (labelSpans(line).length < 2) continue;
    if (avoid.some((a) => line.bbox.intersects(a))) continue;
    for (const cand of lineGapFields(line, rightEdge, data.number)) {
      // only short, label-like runs
      if (cand.label.length > 40 || words(cand.label).length > 5) continue;
      // a fill-in line at or just below the gap owns this label
      const owned = data.hsegs.some((seg) =>
        seg.x1 > cand.rect.x0 && seg.x0 < cand.rect.x1 &&
        line.bbox.y0 - 2 <= seg.y && seg.y <= line.bbox.y1 + 25,
      );
      if (owned) continue;
      if (avoid.some((a) => cand.rect.intersects(a))) continue;
      cand.source = "label";
      out.push(cand);
    }
  }
  return out;
}

export function detect(data: PageData): Candidate[] {
  return dedupe([
    ...checkboxCandidates(data),
    ...tableCandidates(data),
    ...boxCandidates(data),
    ...underlineCandidates(data),
    ...bareLabelCandidates(data),
  ]);
}

/** Best-effort label for a user-placed field. */
function nearbyLabel(data: PageData, rect: Rect): string {
  let bestD = 80.0;
  let best = "";
  for (const line of data.lines) {
    const spans = line.spans.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      // require real vertical overlap
      const overlap = Math.min(s.bbox.y1, rect.y1) - Math.max(s.bbox.y0, rect.y0);
      if (overlap >= 2.0 && s.bbox.x1 <= rect.x0 + 2) {
        const d = rect.x0 - s.bbox.x1;
        if (d < bestD) {
          bestD = d;
          best = runLabel(spans, i);
        }
      }
    }
  }
  if (best) return best;
  const above = data.lines.filter((l) =>
    rect.y0 - l.bbox.y1 > 0 && rect.y0 - l.bbox.y1 < 35 &&
    l.bbox.x1 > rect.x0 && l.bbox.x0 < rect.x1,
  );
  return above.length ? lineText(above[above.length - 1]) : "";
}

/** Detection restricted to a user-drawn region, with relaxed thresholds. */
export function detectInRegion(data: PageData, regionIn: Rect): Candidate[] {
  const region = regionIn.clone().normalize();
  const out: Candidate[] = [];

  // checkbox-sized squares (relaxed size range, no empty-interior veto)
  for (const box of data.boxes) {
    const r = box.rect;
    if (!region.intersects(r)) continue;
    if (5.0 <= r.width && r.width <= 22.0 && 5.0 <= r.height && r.height <= 22.0 &&
        Math.abs(r.width - r.height) <= 5) {
      let label = "";
      let best = 1e9;
      for (const line of data.lines) {
        if (line.bbox.y0 < r.y1 && line.bbox.y1 > r.y0 && line.bbox.x0 >= r.x1 - 2) {
          const d = line.bbox.x0 - r.x1;
          if (d < best) {
            best = d;
            label = lineText(line);
          }
        }
      }
      out.push(makeCandidate(data.number, r.clone(), "checkbox",
        words(label).slice(0, 5).join(" "), { source: "nudge" }));
    }
  }
  if (out.length) return dedupe(out);

  // a drawn box that mostly covers the region — but only one of comparable size
  for (const box of data.boxes) {
    const inter = region.clone().intersect(box.rect);
    if (inter.isEmpty || inter.area() <= 0.5 * region.area() ||
        box.rect.area() > 4 * region.area()) continue;
    const r = box.rect;
    const inner = r.plus(3, 3, -3, -3);
    // labelled box: the field is the gap right of the label
    const gapCands: Candidate[] = [];
    const boxLines = data.lines.filter((l) => l.bbox.intersects(r))
      .sort((a, b) => a.bbox.y0 - b.bbox.y0);
    for (let li = 0; li < boxLines.length; li++) {
      const line = boxLines[li];
      if (!labelSpans(line).length) continue;
      for (const cand of lineGapFields(line, r.x1 - 4, data.number)) {
        cand.rect = cand.rect.intersect(inner);
        cand.source = "nudge";
        if (!cand.rect.isEmpty && cand.rect.intersects(region)) {
          growGapField(cand, boxLines, li, inner);
          gapCands.push(cand);
        }
      }
    }
    if (gapCands.length) return dedupe(gapCands);
    const label = nearbyLabel(data, r);
    return [makeCandidate(data.number, inner, classify(label), label,
      { multiline: inner.height > 30, source: "nudge" })];
  }

  // fill-in lines: inside a user region a box or table border is a
  // legitimate write-on line, so no border rejection here
  const hits: [number, number, number][] = []; // (seg.y, x0, x1)
  for (const seg of data.hsegs) {
    if (!(region.y0 <= seg.y && seg.y <= region.y1 + 8)) continue;
    const x0 = Math.max(seg.x0, region.x0);
    const x1 = Math.min(seg.x1, region.x1);
    if (x1 - x0 < 12) continue;
    const onLine: Span[] = [];
    for (const line of data.lines) {
      for (const s of line.spans) {
        if (s.bbox.x1 > x0 && s.bbox.x0 < x1 &&
            seg.y - 16 <= s.bbox.y1 && s.bbox.y1 <= seg.y + 4) {
          onLine.push(s);
        }
      }
    }
    onLine.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    let cursor = x0;
    const stretches: [number, number][] = [];
    for (const span of onLine) {
      if (span.bbox.x0 - cursor >= 12) stretches.push([cursor, span.bbox.x0 - 4]);
      cursor = Math.max(cursor, span.bbox.x1 + 4);
    }
    if (x1 - cursor >= 12) stretches.push([cursor, x1]);
    for (const [sx0, sx1] of stretches) hits.push([seg.y, sx0, sx1]);
  }

  if (hits.length) {
    // one drawn rectangle means one row of fields: keep only the bottom line
    const ymax = Math.max(...hits.map((h) => h[0]));
    for (const [y, sx0, sx1] of hits) {
      if (ymax - y > 2) continue;
      const rect = new Rect(sx0, y - FIELD_HEIGHT, sx1, y + 1);
      const label = nearbyLabel(data, rect);
      out.push(makeCandidate(data.number, rect, classify(label), label, { source: "nudge" }));
    }
  }
  return dedupe(out);
}
