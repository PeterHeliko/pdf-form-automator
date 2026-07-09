/** Shared data model: the TS equivalents of extract.py's dataclasses plus
 * JSON (de)serialization so PageData/Candidate survive postMessage between
 * the worker and the main thread (Rect is a class and would lose its
 * prototype in a structured clone).
 */

import { Rect, type RectTuple } from "./geometry";

export type FType = "text" | "checkbox" | "date" | "signature";
export const FTYPES: FType[] = ["text", "checkbox", "date", "signature"];

export interface Span {
  text: string;
  bbox: Rect;
  size: number;
  bold: boolean;
}

export interface TextLine {
  spans: Span[];
  bbox: Rect;
}

export function lineText(line: TextLine): string {
  return line.spans.map((s) => s.text).join(" ");
}

export interface HSeg {
  y: number;
  x0: number;
  x1: number;
  fromText: boolean; // derived from a '____' character run
}

export interface VSeg {
  x: number;
  y0: number;
  y1: number;
}

export interface Box {
  rect: Rect;
}

export interface TableCell {
  rect: Rect;
  text: string;
  row: number;
  col: number;
}

export interface Table {
  bbox: Rect;
  rows: TableCell[][];
}

export interface PageData {
  number: number;
  width: number;
  height: number;
  lines: TextLine[];
  hsegs: HSeg[];
  vsegs: VSeg[];
  boxes: Box[];
  tables: Table[];
}

export interface Candidate {
  page: number;
  rect: Rect;
  ftype: FType;
  label: string;
  multiline: boolean;
  source: string;
  name: string;
}

export function makeCandidate(
  page: number, rect: Rect, ftype: FType, label: string,
  opts: { multiline?: boolean; source?: string; name?: string } = {},
): Candidate {
  return {
    page, rect, ftype, label,
    multiline: opts.multiline ?? false,
    source: opts.source ?? "heuristic",
    name: opts.name ?? "",
  };
}

export function cloneCandidate(c: Candidate): Candidate {
  return { ...c, rect: c.rect.clone() };
}

// ---------------------------------------------------------------- JSON layer

export interface SpanJSON { text: string; bbox: RectTuple; size: number; bold: boolean }
export interface TextLineJSON { spans: SpanJSON[]; bbox: RectTuple }
export interface HSegJSON { y: number; x0: number; x1: number; fromText: boolean }
export interface TableCellJSON { rect: RectTuple; text: string; row: number; col: number }
export interface TableJSON { bbox: RectTuple; rows: TableCellJSON[][] }

export interface PageDataJSON {
  number: number;
  width: number;
  height: number;
  lines: TextLineJSON[];
  hsegs: HSegJSON[];
  vsegs: VSeg[];
  boxes: RectTuple[];
  tables: TableJSON[];
}

export interface CandidateJSON {
  page: number;
  rect: RectTuple;
  ftype: FType;
  label: string;
  multiline: boolean;
  source: string;
  name: string;
}

export function pageDataToJSON(d: PageData): PageDataJSON {
  return {
    number: d.number,
    width: d.width,
    height: d.height,
    lines: d.lines.map((l) => ({
      bbox: l.bbox.toTuple(),
      spans: l.spans.map((s) => ({ text: s.text, bbox: s.bbox.toTuple(), size: s.size, bold: s.bold })),
    })),
    hsegs: d.hsegs.map((s) => ({ ...s })),
    vsegs: d.vsegs.map((s) => ({ ...s })),
    boxes: d.boxes.map((b) => b.rect.toTuple()),
    tables: d.tables.map((t) => ({
      bbox: t.bbox.toTuple(),
      rows: t.rows.map((row) => row.map((c) => ({ rect: c.rect.toTuple(), text: c.text, row: c.row, col: c.col }))),
    })),
  };
}

export function pageDataFromJSON(d: PageDataJSON): PageData {
  return {
    number: d.number,
    width: d.width,
    height: d.height,
    lines: d.lines.map((l) => ({
      bbox: Rect.from(l.bbox),
      spans: l.spans.map((s) => ({ text: s.text, bbox: Rect.from(s.bbox), size: s.size, bold: s.bold })),
    })),
    hsegs: d.hsegs.map((s) => ({ ...s })),
    vsegs: d.vsegs.map((s) => ({ ...s })),
    boxes: d.boxes.map((b) => ({ rect: Rect.from(b) })),
    tables: d.tables.map((t) => ({
      bbox: Rect.from(t.bbox),
      rows: t.rows.map((row) => row.map((c) => ({ rect: Rect.from(c.rect), text: c.text, row: c.row, col: c.col }))),
    })),
  };
}

export function candidateToJSON(c: Candidate): CandidateJSON {
  return { ...c, rect: c.rect.toTuple() };
}

export function candidateFromJSON(c: CandidateJSON): Candidate {
  return { ...c, rect: Rect.from(c.rect) };
}

// ------------------------------------------------- raw drawings (worker only)

/** Normalized page vector graphics, the equivalent of what extract.py and
 * table.py consume from PyMuPDF's page.get_drawings(). */
export interface RawLineItem { kind: "l"; x0: number; y0: number; x1: number; y1: number }
export interface RawRectItem { kind: "re"; rect: Rect }
/** Non-axis-aligned closed 4-point subpath; points are the transformed corners. */
export interface RawQuadItem { kind: "qu"; points: [number, number][]; rect: Rect }
export type RawItem = RawLineItem | RawRectItem | RawQuadItem;

export interface RawDrawing {
  type: "f" | "s";
  rect: Rect; // bbox over all items
  items: RawItem[];
  closePath: boolean;
  width: number; // stroke line width (0 for fills)
}

/** Page character for the table finder (equivalent of table.py's CHARS). */
export interface PageChar {
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}
