/** TS reimplementation of PyMuPDF's find_tables(strategy="lines_strict"),
 * ported from pymupdf/table.py (itself a pdfplumber port). Consumes the
 * normalized RawDrawing list and page chars produced by extract.ts instead
 * of page.get_drawings()/rawdict, and returns the Table shape extract.py
 * builds (cell rects + row/col indices + cell text).
 */

import { Rect } from "./geometry";
import type { PageChar, RawDrawing, RawItem, Table, TableCell } from "./types";

const SNAP_X = 3;
const SNAP_Y = 3;
const JOIN_X = 3;
const JOIN_Y = 3;
const EDGE_MIN_LENGTH = 3; // thin-rect detection threshold in make_edges
const INTERSECT_X = 3;
const INTERSECT_Y = 3;

interface Edge {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  orientation: "h" | "v";
}

type Cell = [number, number, number, number]; // x0, top, x1, bottom

// ------------------------------------------------------------ make_edges

/** Port of table.py clean_graphics: join "connected" vector graphics into
 * cluster bboxes; keep clusters that contain text. Returns the bboxes and
 * the filtered path list. */
function cleanGraphics(
  allPaths: RawDrawing[], chars: PageChar[], pageHeight: number,
): { bboxes: Rect[]; paths: RawDrawing[] } {
  const paths: RawDrawing[] = [];
  for (const p of allPaths) {
    // lines_strict: ignore fill-only paths except simulated lines
    if (p.type === "f" && p.rect.width > SNAP_X && p.rect.height > SNAP_Y) continue;
    paths.push(p);
  }

  // unique rects, sorted by (y1, x0)
  const seen = new Set<string>();
  const prects: Rect[] = [];
  for (const p of paths) {
    const key = `${p.rect.x0},${p.rect.y0},${p.rect.x1},${p.rect.y1}`;
    if (!seen.has(key)) {
      seen.add(key);
      prects.push(p.rect.clone());
    }
  }
  prects.sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0);

  const areNeighbors = (r1: Rect, r2: Rect): boolean => {
    if (
      (r2.x0 - SNAP_X <= r1.x0 && r1.x0 <= r2.x1 + SNAP_X ||
       r2.x0 - SNAP_X <= r1.x1 && r1.x1 <= r2.x1 + SNAP_X) &&
      (r2.y0 - SNAP_Y <= r1.y0 && r1.y0 <= r2.y1 + SNAP_Y ||
       r2.y0 - SNAP_Y <= r1.y1 && r1.y1 <= r2.y1 + SNAP_Y)
    ) return true;
    if (
      (r1.x0 - SNAP_X <= r2.x0 && r2.x0 <= r1.x1 + SNAP_X ||
       r1.x0 - SNAP_X <= r2.x1 && r2.x1 <= r1.x1 + SNAP_X) &&
      (r1.y0 - SNAP_Y <= r2.y0 && r2.y0 <= r1.y1 + SNAP_Y ||
       r1.y0 - SNAP_Y <= r2.y1 && r2.y1 <= r1.y1 + SNAP_Y)
    ) return true;
    return false;
  };

  // chars_in_rect from table.py, including its mixed-coordinate comparison
  // (char y0/y1 are PDF-space, i.e. flipped by the page height)
  const charsInRect = (r: Rect): boolean =>
    chars.some((c) =>
      r.x0 <= c.x0 && c.x1 <= r.x1 &&
      r.y0 <= pageHeight - c.bottom && r.y1 >= pageHeight - c.top,
    );

  const includePoint = (r: Rect, x: number, y: number) => {
    if (x < r.x0) r.x0 = x;
    if (x > r.x1) r.x1 = x;
    if (y < r.y0) r.y0 = y;
    if (y > r.y1) r.y1 = y;
  };

  const bboxes: Rect[] = [];
  while (prects.length) {
    const prect0 = prects[0].clone();
    let repeat = true;
    while (repeat) {
      repeat = false;
      for (let i = prects.length - 1; i > 0; i--) {
        if (areNeighbors(prect0, prects[i])) {
          includePoint(prect0, prects[i].x0, prects[i].y0);
          includePoint(prect0, prects[i].x1, prects[i].y1);
          prects.splice(i, 1);
          repeat = true;
        }
      }
    }
    if (charsInRect(prect0)) bboxes.push(prect0);
    prects.shift();
  }
  return { bboxes, paths };
}

/** Port of make_edges' make_line + line_to_edge. */
function makeLine(
  p1x: number, p1y: number, p2x: number, p2y: number, clip: Rect,
): Edge | null {
  // only accept roughly axis-parallel lines
  if (!(Math.abs(p1x - p2x) <= SNAP_X || Math.abs(p1y - p2y) <= SNAP_Y)) return null;
  let x0 = Math.min(p1x, p2x);
  let x1 = Math.max(p1x, p2x);
  let y0 = Math.min(p1y, p2y);
  let y1 = Math.max(p1y, p2y);
  if (x0 > clip.x1 || x1 < clip.x0 || y0 > clip.y1 || y1 < clip.y0) return null;
  if (x0 < clip.x0) x0 = clip.x0;
  if (x1 > clip.x1) x1 = clip.x1;
  if (y0 < clip.y0) y0 = clip.y0;
  if (y1 > clip.y1) y1 = clip.y1;
  if (x1 - x0 === 0 && y1 - y0 === 0) return null;
  return { x0, x1, top: y0, bottom: y1, orientation: y0 === y1 ? "h" : "v" };
}

/** Port of make_edges: decompose paths + cluster bboxes into edges. */
function makeEdges(drawings: RawDrawing[], chars: PageChar[], pageWidth: number, pageHeight: number): Edge[] {
  const clip = new Rect(0, 0, pageWidth, pageHeight);
  const { bboxes, paths } = cleanGraphics(drawings, chars, pageHeight);
  const edges: Edge[] = [];
  const add = (e: Edge | null) => { if (e) edges.push(e); };

  for (const p of paths) {
    const items: RawItem[] = p.items.slice();
    // closePath: add a line from last to first point
    const first = items[0];
    const last = items[items.length - 1];
    if (p.closePath && first?.kind === "l" && last?.kind === "l") {
      items.push({ kind: "l", x0: last.x1, y0: last.y1, x1: first.x0, y1: first.y0 });
    }
    for (const item of items) {
      if (item.kind === "l") {
        add(makeLine(item.x0, item.y0, item.x1, item.y1, clip));
      } else if (item.kind === "re") {
        const rect = item.rect.clone().normalize();
        if (rect.width <= EDGE_MIN_LENGTH && rect.width < rect.height) {
          // simulates a vertical line
          const x = Math.abs(rect.x1 + rect.x0) / 2;
          add(makeLine(x, rect.y0, x, rect.y1, clip));
          continue;
        }
        if (rect.height <= EDGE_MIN_LENGTH && rect.height < rect.width) {
          // simulates a horizontal line
          const y = Math.abs(rect.y1 + rect.y0) / 2;
          add(makeLine(rect.x0, y, rect.x1, y, clip));
          continue;
        }
        add(makeLine(rect.x0, rect.y0, rect.x0, rect.y1, clip)); // tl-bl
        add(makeLine(rect.x0, rect.y1, rect.x1, rect.y1, clip)); // bl-br
        add(makeLine(rect.x1, rect.y1, rect.x1, rect.y0, clip)); // br-tr
        add(makeLine(rect.x1, rect.y0, rect.x0, rect.y0, clip)); // tr-tl
      } else {
        // quad: up to 4 lines between the corners
        const pts = item.points;
        for (let i = 0; i < 4; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % 4];
          add(makeLine(a[0], a[1], b[0], b[1], clip));
        }
      }
    }
  }

  for (const bbox of bboxes) {
    add(makeLine(bbox.x0, bbox.y0, bbox.x1, bbox.y0, clip)); // top
    add(makeLine(bbox.x0, bbox.y1, bbox.x1, bbox.y1, clip)); // bottom
    add(makeLine(bbox.x0, bbox.y0, bbox.x0, bbox.y1, clip)); // left
    add(makeLine(bbox.x1, bbox.y0, bbox.x1, bbox.y1, clip)); // right
  }

  return edges;
}

// -------------------------------------------------------- snap and merge

/** Port of cluster_list: chain-cluster sorted unique values. */
function clusterList(values: number[], tolerance: number): number[][] {
  const xs = Array.from(new Set(values)).sort((a, b) => a - b);
  if (xs.length < 2) return xs.map((x) => [x]);
  const groups: number[][] = [];
  let current: number[] = [xs[0]];
  let lastVal = xs[0];
  for (const x of xs.slice(1)) {
    if (x <= lastVal + tolerance) {
      current.push(x);
    } else {
      groups.push(current);
      current = [x];
    }
    lastVal = x;
  }
  groups.push(current);
  return groups;
}

/** Port of snap_objects: move each edge so the clustered attribute becomes
 * the cluster average. */
function snapEdges(edges: Edge[], attr: "x0" | "top", tolerance: number): Edge[] {
  const clusters = clusterList(edges.map((e) => e[attr]), tolerance);
  const clusterOf = new Map<number, number>();
  clusters.forEach((vals, i) => vals.forEach((v) => clusterOf.set(v, i)));
  const groups: Edge[][] = clusters.map(() => []);
  for (const e of edges) groups[clusterOf.get(e[attr])!].push(e);
  const out: Edge[] = [];
  for (const group of groups) {
    const avg = group.reduce((s, e) => s + e[attr], 0) / group.length;
    for (const e of group) {
      const delta = avg - e[attr];
      if (attr === "x0") {
        out.push({ ...e, x0: e.x0 + delta, x1: e.x1 + delta });
      } else {
        out.push({ ...e, top: e.top + delta, bottom: e.bottom + delta });
      }
    }
  }
  return out;
}

/** Port of join_edge_group. */
function joinEdgeGroup(edges: Edge[], orientation: "h" | "v", tolerance: number): Edge[] {
  const minProp = orientation === "h" ? "x0" : "top";
  const maxProp = orientation === "h" ? "x1" : "bottom";
  const sorted = edges.slice().sort((a, b) => a[minProp] - b[minProp]);
  const joined: Edge[] = [{ ...sorted[0] }];
  for (const e of sorted.slice(1)) {
    const last = joined[joined.length - 1];
    if (e[minProp] <= last[maxProp] + tolerance) {
      if (e[maxProp] > last[maxProp]) last[maxProp] = e[maxProp];
    } else {
      joined.push({ ...e });
    }
  }
  return joined;
}

/** Port of merge_edges: snap, then join collinear groups. */
function mergeEdges(edges: Edge[]): Edge[] {
  const v = snapEdges(edges.filter((e) => e.orientation === "v"), "x0", SNAP_X);
  const h = snapEdges(edges.filter((e) => e.orientation === "h"), "top", SNAP_Y);
  const out: Edge[] = [];
  const groups = new Map<string, Edge[]>();
  for (const e of [...v, ...h]) {
    const key = e.orientation === "h" ? `h|${e.top}` : `v|${e.x0}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(e);
  }
  for (const [key, group] of groups) {
    const orientation = key[0] as "h" | "v";
    out.push(...joinEdgeGroup(group, orientation, orientation === "h" ? JOIN_X : JOIN_Y));
  }
  return out;
}

// --------------------------------------------- intersections, cells, tables

interface Intersection { v: Edge[]; h: Edge[] }

function edgeId(e: Edge): string {
  return `${e.x0},${e.top},${e.x1},${e.bottom}`;
}

/** Port of edges_to_intersections. */
function edgesToIntersections(edges: Edge[]): Map<string, Intersection> {
  const intersections = new Map<string, Intersection>();
  const vEdges = edges.filter((e) => e.orientation === "v")
    .sort((a, b) => a.x0 - b.x0 || a.top - b.top);
  const hEdges = edges.filter((e) => e.orientation === "h")
    .sort((a, b) => a.top - b.top || a.x0 - b.x0);
  for (const v of vEdges) {
    for (const h of hEdges) {
      if (
        v.top <= h.top + INTERSECT_Y && v.bottom >= h.top - INTERSECT_Y &&
        v.x0 >= h.x0 - INTERSECT_X && v.x0 <= h.x1 + INTERSECT_X
      ) {
        const key = `${v.x0},${h.top}`;
        let entry = intersections.get(key);
        if (!entry) intersections.set(key, (entry = { v: [], h: [] }));
        entry.v.push(v);
        entry.h.push(h);
      }
    }
  }
  return intersections;
}

/** Port of intersections_to_cells. */
function intersectionsToCells(intersections: Map<string, Intersection>): Cell[] {
  const points: [number, number][] = Array.from(intersections.keys()).map((k) => {
    const [x, y] = k.split(",").map(Number);
    return [x, y];
  });
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const pointKey = (p: [number, number]) => `${p[0]},${p[1]}`;
  const has = (p: [number, number]) => intersections.has(pointKey(p));

  const edgeConnects = (p1: [number, number], p2: [number, number]): boolean => {
    const i1 = intersections.get(pointKey(p1))!;
    const i2 = intersections.get(pointKey(p2))!;
    if (p1[0] === p2[0]) {
      const set1 = new Set(i1.v.map(edgeId));
      if (i2.v.some((e) => set1.has(edgeId(e)))) return true;
    }
    if (p1[1] === p2[1]) {
      const set1 = new Set(i1.h.map(edgeId));
      if (i2.h.some((e) => set1.has(edgeId(e)))) return true;
    }
    return false;
  };

  const cells: Cell[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) break;
    const pt = points[i];
    const rest = points.slice(i + 1);
    const below = rest.filter((x) => x[0] === pt[0]);
    const right = rest.filter((x) => x[1] === pt[1]);
    let found: Cell | null = null;
    for (const belowPt of below) {
      if (found) break;
      if (!edgeConnects(pt, belowPt)) continue;
      for (const rightPt of right) {
        if (!edgeConnects(pt, rightPt)) continue;
        const bottomRight: [number, number] = [rightPt[0], belowPt[1]];
        if (has(bottomRight) && edgeConnects(bottomRight, rightPt) && edgeConnects(bottomRight, belowPt)) {
          found = [pt[0], pt[1], bottomRight[0], bottomRight[1]];
          break;
        }
      }
    }
    if (found) cells.push(found);
  }
  return cells;
}

/** Port of cells_to_tables, including the PyMuPDF filter that drops tables
 * with fewer than 2 distinct column edges or without any text. */
function cellsToTables(cells: Cell[], chars: PageChar[]): Cell[][] {
  const remaining = cells.slice();
  let currentCorners = new Set<string>();
  let currentCells: Cell[] = [];
  const tables: Cell[][] = [];

  const corners = (c: Cell): string[] => [
    `${c[0]},${c[1]}`, `${c[0]},${c[3]}`, `${c[2]},${c[1]}`, `${c[2]},${c[3]}`,
  ];

  while (remaining.length) {
    const initialCount = currentCells.length;
    for (const cell of remaining.slice()) {
      const cc = corners(cell);
      if (currentCells.length === 0) {
        cc.forEach((c) => currentCorners.add(c));
        currentCells.push(cell);
        remaining.splice(remaining.indexOf(cell), 1);
      } else {
        const cornerCount = cc.filter((c) => currentCorners.has(c)).length;
        if (cornerCount > 0) {
          cc.forEach((c) => currentCorners.add(c));
          currentCells.push(cell);
          remaining.splice(remaining.indexOf(cell), 1);
        }
      }
    }
    if (currentCells.length === initialCount) {
      tables.push(currentCells.slice());
      currentCorners = new Set();
      currentCells = [];
    }
  }
  if (currentCells.length) tables.push(currentCells.slice());

  // PyMuPDF modification: remove tables without text or having only 1 column
  const kept = tables.filter((t) => {
    const x0s = new Set(t.map((c) => c[0]));
    const x1s = new Set(t.map((c) => c[2]));
    if (x0s.size < 2 || x1s.size < 2) return false;
    const r = new Rect(
      Math.min(...t.map((c) => c[0])), Math.min(...t.map((c) => c[1])),
      Math.max(...t.map((c) => c[2])), Math.max(...t.map((c) => c[3])),
    );
    return chars.some((c) => {
      if (!c.text.trim()) return false;
      const hMid = (c.x0 + c.x1) / 2;
      const vMid = (c.top + c.bottom) / 2;
      return hMid >= r.x0 && hMid < r.x1 && vMid >= r.y0 && vMid < r.y1;
    });
  });

  kept.sort((a, b) => {
    const ka = a.reduce((m, c) => (c[1] < m[0] || (c[1] === m[0] && c[0] < m[1]) ? [c[1], c[0]] : m), [Infinity, Infinity]);
    const kb = b.reduce((m, c) => (c[1] < m[0] || (c[1] === m[0] && c[0] < m[1]) ? [c[1], c[0]] : m), [Infinity, Infinity]);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
  return kept;
}

// ----------------------------------------------------------- cell text

/** Simplified port of table.py's extract_text for one cell: chars whose
 * center lies in the rect, grouped into lines (tolerance 3) and words
 * (whitespace or gap > 3), lines joined with newline. */
function textInCell(chars: PageChar[], cell: Cell): string {
  const inCell = chars.filter((c) => {
    const hMid = (c.x0 + c.x1) / 2;
    const vMid = (c.top + c.bottom) / 2;
    return hMid >= cell[0] && hMid < cell[2] && vMid >= cell[1] && vMid < cell[3];
  });
  if (!inCell.length) return "";
  inCell.sort((a, b) => a.top - b.top || a.x0 - b.x0);

  // cluster into lines by top with tolerance 3 (chained like cluster_list)
  const lines: PageChar[][] = [];
  let cur: PageChar[] = [inCell[0]];
  let lastTop = inCell[0].top;
  for (const c of inCell.slice(1)) {
    if (c.top <= lastTop + 3) {
      cur.push(c);
    } else {
      lines.push(cur);
      cur = [c];
    }
    lastTop = c.top;
  }
  lines.push(cur);

  const lineTexts: string[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x0 - b.x0);
    const words: string[] = [];
    let word = "";
    let prevX1: number | null = null;
    for (const c of line) {
      if (!c.text.trim()) {
        if (word) words.push(word);
        word = "";
        prevX1 = c.x1;
        continue;
      }
      if (word && prevX1 !== null && c.x0 - prevX1 > 3) {
        words.push(word);
        word = "";
      }
      word += c.text;
      prevX1 = c.x1;
    }
    if (word) words.push(word);
    if (words.length) lineTexts.push(words.join(" "));
  }
  return lineTexts.join("\n");
}

// ------------------------------------------------------------------ main

/** Equivalent of extract.py's _find_tables: full lines_strict pipeline down
 * to the Table/TableCell shape the heuristics consume. */
export function findTables(
  drawings: RawDrawing[], chars: PageChar[], pageWidth: number, pageHeight: number,
): Table[] {
  const rawEdges = makeEdges(drawings, chars, pageWidth, pageHeight);
  // lines_strict get_edges: min length 1 per orientation dimension
  const edges = mergeEdges(rawEdges).filter((e) =>
    e.orientation === "v" ? e.bottom - e.top >= 1 : e.x1 - e.x0 >= 1,
  );
  const intersections = edgesToIntersections(edges);
  const cells = intersectionsToCells(intersections);
  const tables = cellsToTables(cells, chars);

  const out: Table[] = [];
  for (const tableCells of tables) {
    // port of Table.rows: group cells by top, columns from unique x0s
    const sorted = tableCells.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const xs = Array.from(new Set(tableCells.map((c) => c[0]))).sort((a, b) => a - b);
    const rows: TableCell[][] = [];
    let ri = 0;
    let i = 0;
    while (i < sorted.length) {
      const y = sorted[i][1];
      const rowCells: Cell[] = [];
      while (i < sorted.length && sorted[i][1] === y) rowCells.push(sorted[i++]);
      const byX = new Map(rowCells.map((c) => [c[0], c]));
      const row: TableCell[] = [];
      xs.forEach((x, ci) => {
        const cell = byX.get(x);
        if (cell === undefined) return; // "None" cell: omitted, col keeps index
        row.push({
          rect: new Rect(cell[0], cell[1], cell[2], cell[3]),
          text: textInCell(chars, cell).trim(),
          row: ri,
          col: ci,
        });
      });
      rows.push(row);
      ri++;
    }
    const bbox = new Rect(
      Math.min(...tableCells.map((c) => c[0])), Math.min(...tableCells.map((c) => c[1])),
      Math.max(...tableCells.map((c) => c[2])), Math.max(...tableCells.map((c) => c[3])),
    );
    out.push({ bbox, rows });
  }
  return out;
}
