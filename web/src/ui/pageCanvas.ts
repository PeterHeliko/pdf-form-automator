/** Editable field overlay: port of gui/page_canvas.py.
 *
 * The page bitmap (a <canvas>) is handled by the app; this class owns the
 * SVG overlay on top of it. Coordinates: candidate rects live in fitz page
 * points; the SVG viewBox is in points and CSS-scaled by app.zoom (pixels
 * per point), so drawing needs no manual scaling — only screen-fixed things
 * (text size, handles, hit slack) divide by zoom.
 *
 * Selection is a list of candidate indices (app.selection). Dragging a
 * selected field moves the whole selection; the handles sit on the
 * selection's bounding box and resizing applies the same edge delta to
 * every selected field.
 */

import { Rect } from "../geometry";
import type { Candidate } from "../types";

const SVG_NS = "http://www.w3.org/2000/svg";
const HANDLE = 4; // half-size of a resize handle, in screen pixels
export const MIN_W = 8.0; // minimum field size, in page points
export const MIN_H = 6.0;

/** Field overlay colors, from preview.py COLORS. */
export const COLORS: Record<string, string> = {
  text: "#1e5adc",
  date: "#e68c00",
  checkbox: "#00963c",
  signature: "#d21e1e",
};

const CURSORS: Record<string, string> = {
  nw: "nwse-resize", n: "ns-resize", ne: "nesw-resize", e: "ew-resize",
  se: "nwse-resize", s: "ns-resize", sw: "nesw-resize", w: "ew-resize",
};

export interface CanvasApp {
  readonly zoom: number; // pixels per point
  mode(): "select" | "draw";
  currentCands(): Candidate[];
  selection: number[];
  selectSingle(i: number): void;
  selectAdd(i: number): void;
  selectToggle(i: number): void;
  selectSet(indices: number[]): void;
  pageSize(): [number, number];
  commitRects(changes: Map<number, Rect>): void;
  onNudge(region: Rect): void;
}

type Drag =
  | { kind: "nudge"; x0: number; y0: number; el: SVGRectElement }
  | { kind: "select"; x0: number; y0: number; el: SVGRectElement; extend: boolean }
  | { kind: "move" | "resize"; corner: string | null; bases: Map<number, Rect>; sx: number; sy: number };

export class PageCanvas {
  private svg: SVGSVGElement;
  private app: CanvasApp;
  private items = new Map<number, { g: SVGGElement; rect: SVGRectElement; text: SVGTextElement }>();
  private handles = new Map<string, SVGRectElement>();
  private drag: Drag | null = null;
  private pending: Map<number, Rect> | null = null;

  constructor(svg: SVGSVGElement, app: CanvasApp) {
    this.svg = svg;
    this.app = app;
    svg.addEventListener("pointerdown", (e) => this.onPress(e));
    svg.addEventListener("pointermove", (e) => (this.drag ? this.onMotion(e) : this.onHover(e)));
    svg.addEventListener("pointerup", (e) => this.onRelease(e));
    svg.addEventListener("pointercancel", () => this.cancelDrag());
  }

  /** Pointer event position in page points. */
  private toPoint(e: PointerEvent): [number, number] {
    const box = this.svg.getBoundingClientRect();
    const z = this.app.zoom;
    return [(e.clientX - box.left) / z, (e.clientY - box.top) / z];
  }

  // ------------------------------------------------------------ rendering

  redrawOverlays(): void {
    this.svg.replaceChildren();
    this.items.clear();
    this.handles.clear();
    const z = this.app.zoom;
    const cands = this.app.currentCands();
    const selected = new Set(this.app.selection);
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const color = COLORS[c.ftype] ?? COLORS.text;
      const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
      g.setAttribute("class", `field${selected.has(i) ? " selected" : ""}`);
      const rect = document.createElementNS(SVG_NS, "rect") as SVGRectElement;
      this.setRectAttrs(rect, c.rect);
      rect.setAttribute("fill", color);
      rect.setAttribute("stroke", color);
      const text = document.createElementNS(SVG_NS, "text") as SVGTextElement;
      text.setAttribute("x", String(c.rect.x0 + 3 / z));
      text.setAttribute("y", String(c.rect.y0 + 1 / z));
      text.setAttribute("dominant-baseline", "hanging");
      text.setAttribute("font-size", String(11 / z));
      text.setAttribute("fill", color);
      text.textContent = c.name || c.label;
      g.append(rect, text);
      this.svg.append(g);
      this.items.set(i, { g, rect, text });
    }
    const bbox = this.selectionBbox(this.selectionRects(selected, cands));
    if (bbox) this.drawHandles(bbox);
  }

  private setRectAttrs(el: SVGRectElement, r: Rect): void {
    el.setAttribute("x", String(Math.min(r.x0, r.x1)));
    el.setAttribute("y", String(Math.min(r.y0, r.y1)));
    el.setAttribute("width", String(Math.abs(r.x1 - r.x0)));
    el.setAttribute("height", String(Math.abs(r.y1 - r.y0)));
  }

  private selectionRects(selected: Set<number>, cands: Candidate[]): Map<number, Rect> {
    const rects = new Map<number, Rect>();
    for (const i of selected) {
      if (i < cands.length) rects.set(i, cands[i].rect);
    }
    return rects;
  }

  private selectionBbox(rects: Map<number, Rect>): Rect | null {
    let bbox: Rect | null = null;
    for (const r of rects.values()) {
      if (bbox === null) bbox = r.clone();
      else bbox.includeRect(r);
    }
    return bbox;
  }

  private handlePositions(rect: Rect): Record<string, [number, number]> {
    const { x0, y0, x1, y1 } = rect;
    const xc = (x0 + x1) / 2;
    const yc = (y0 + y1) / 2;
    return {
      nw: [x0, y0], n: [xc, y0], ne: [x1, y0], e: [x1, yc],
      se: [x1, y1], s: [xc, y1], sw: [x0, y1], w: [x0, yc],
    };
  }

  private drawHandles(rect: Rect): void {
    const h = HANDLE / this.app.zoom;
    for (const [name, [px, py]] of Object.entries(this.handlePositions(rect))) {
      const el = document.createElementNS(SVG_NS, "rect") as SVGRectElement;
      el.setAttribute("class", "handle");
      el.setAttribute("x", String(px - h));
      el.setAttribute("y", String(py - h));
      el.setAttribute("width", String(2 * h));
      el.setAttribute("height", String(2 * h));
      this.svg.append(el);
      this.handles.set(name, el);
    }
  }

  /** Live update of the dragged overlays (no commit). */
  private previewRects(rects: Map<number, Rect>): void {
    const z = this.app.zoom;
    for (const [i, rect] of rects) {
      const item = this.items.get(i);
      if (!item) continue;
      this.setRectAttrs(item.rect, rect);
      item.text.setAttribute("x", String(rect.x0 + 3 / z));
      item.text.setAttribute("y", String(rect.y0 + 1 / z));
    }
    const bbox = this.selectionBbox(rects);
    if (bbox && this.handles.size) {
      const h = HANDLE / z;
      for (const [name, [px, py]] of Object.entries(this.handlePositions(bbox))) {
        const el = this.handles.get(name);
        if (el) {
          el.setAttribute("x", String(px - h));
          el.setAttribute("y", String(py - h));
        }
      }
    }
  }

  private makeRubber(color: string, dash: string): SVGRectElement {
    const el = document.createElementNS(SVG_NS, "rect") as SVGRectElement;
    el.setAttribute("class", "rubber");
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-dasharray", dash);
    el.setAttribute("stroke-width", "1.5");
    this.svg.append(el);
    return el;
  }

  // --------------------------------------------------------------- events

  private hitHandle(px: number, py: number): string | null {
    const z = this.app.zoom;
    const slack = (HANDLE + 1) / z;
    for (const [name, el] of this.handles) {
      const x = parseFloat(el.getAttribute("x")!) + HANDLE / z;
      const y = parseFloat(el.getAttribute("y")!) + HANDLE / z;
      if (Math.abs(px - x) <= slack && Math.abs(py - y) <= slack) return name;
    }
    return null;
  }

  private hitCandidate(px: number, py: number): number | null {
    const cands = this.app.currentCands();
    const slack = 2 / this.app.zoom;
    for (let i = cands.length - 1; i >= 0; i--) {
      const r = cands[i].rect;
      if (r.x0 - slack <= px && px <= r.x1 + slack && r.y0 - slack <= py && py <= r.y1 + slack) {
        return i;
      }
    }
    return null;
  }

  private selectionBases(): Map<number, Rect> {
    const cands = this.app.currentCands();
    const bases = new Map<number, Rect>();
    for (const i of this.app.selection) {
      if (i < cands.length) bases.set(i, cands[i].rect.clone());
    }
    return bases;
  }

  private onPress(e: PointerEvent): void {
    if (e.button !== 0) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.svg.setPointerCapture(e.pointerId);
    const [px, py] = this.toPoint(e);
    if (this.app.mode() === "draw") {
      const el = this.makeRubber("#cc0044", "4 3");
      this.drag = { kind: "nudge", x0: px, y0: py, el };
      return;
    }
    const handle = this.hitHandle(px, py);
    if (handle && this.app.selection.length) {
      this.drag = { kind: "resize", corner: handle, bases: this.selectionBases(), sx: px, sy: py };
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const hit = this.hitCandidate(px, py);
    if (hit === null) {
      // rubber-band selection; plain drag replaces, Ctrl/Shift extends
      const el = this.makeRubber("#444444", "2 2");
      this.drag = { kind: "select", x0: px, y0: py, el, extend: ctrl || shift };
      return;
    }
    if (ctrl) {
      this.app.selectToggle(hit);
      return;
    }
    if (shift) {
      this.app.selectAdd(hit);
      return;
    }
    if (!this.app.selection.includes(hit)) {
      this.app.selectSingle(hit);
    }
    this.drag = { kind: "move", corner: null, bases: this.selectionBases(), sx: px, sy: py };
  }

  private onMotion(e: PointerEvent): void {
    if (!this.drag) return;
    const [px, py] = this.toPoint(e);
    if (this.drag.kind === "nudge" || this.drag.kind === "select") {
      const { x0, y0, el } = this.drag;
      this.setRectAttrs(el, new Rect(Math.min(x0, px), Math.min(y0, py), Math.max(x0, px), Math.max(y0, py)));
      return;
    }
    const { corner, bases, sx, sy } = this.drag;
    if (!bases.size) {
      this.drag = null;
      return;
    }
    const [dx, dy] = this.clampDelta(corner, bases, px - sx, py - sy);
    this.pending = new Map(
      Array.from(bases, ([i, r]) => [i, PageCanvas.applyDelta(corner, r, dx, dy)]),
    );
    this.previewRects(this.pending);
  }

  private onRelease(e: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (drag.kind === "nudge" || drag.kind === "select") {
      drag.el.remove();
      const [px, py] = this.toPoint(e);
      const rect = new Rect(
        Math.min(drag.x0, px), Math.min(drag.y0, py),
        Math.max(drag.x0, px), Math.max(drag.y0, py),
      );
      if (drag.kind === "nudge") {
        if (rect.width >= 4 || rect.height >= 4) this.app.onNudge(rect);
        return;
      }
      if (rect.width < 3 && rect.height < 3) {
        // just a click on empty space
        if (!drag.extend) this.app.selectSet([]);
        return;
      }
      let hits = this.app.currentCands()
        .map((c, i) => (c.rect.intersects(rect) ? i : -1))
        .filter((i) => i >= 0);
      if (drag.extend) {
        hits = Array.from(new Set([...this.app.selection, ...hits])).sort((a, b) => a - b);
      }
      this.app.selectSet(hits);
      return;
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) this.app.commitRects(pending);
  }

  cancelDrag(): void {
    if (this.drag && (this.drag.kind === "nudge" || this.drag.kind === "select")) {
      this.drag.el.remove();
    }
    this.drag = null;
    this.pending = null;
    this.redrawOverlays();
  }

  private onHover(e: PointerEvent): void {
    if (this.app.mode() === "draw") {
      this.svg.style.cursor = "crosshair";
      return;
    }
    const [px, py] = this.toPoint(e);
    const handle = this.hitHandle(px, py);
    if (handle) {
      this.svg.style.cursor = CURSORS[handle] ?? "";
      return;
    }
    this.svg.style.cursor = this.hitCandidate(px, py) !== null ? "move" : "";
  }

  // ---------------------------------------------------------------- utils

  static applyDelta(corner: string | null, r: Rect, dx: number, dy: number): Rect {
    const next = r.clone();
    if (corner === null) return next.plus(dx, dy, dx, dy); // move
    if (corner.includes("w")) next.x0 += dx;
    if (corner.includes("e")) next.x1 += dx;
    if (corner.includes("n")) next.y0 += dy;
    if (corner.includes("s")) next.y1 += dy;
    return next;
  }

  /** Restrict a move/resize delta so every field keeps its minimum size and
   * stays on the page. corner=null means move. */
  clampDelta(corner: string | null, bases: Map<number, Rect>, dx: number, dy: number): [number, number] {
    const [w, h] = this.app.pageSize();
    let loX = -1e9, hiX = 1e9, loY = -1e9, hiY = 1e9;
    for (const r of bases.values()) {
      if (corner === null) {
        loX = Math.max(loX, -r.x0); hiX = Math.min(hiX, w - r.x1);
        loY = Math.max(loY, -r.y0); hiY = Math.min(hiY, h - r.y1);
        continue;
      }
      if (corner.includes("e")) {
        loX = Math.max(loX, MIN_W - r.width); hiX = Math.min(hiX, w - r.x1);
      } else if (corner.includes("w")) {
        loX = Math.max(loX, -r.x0); hiX = Math.min(hiX, r.width - MIN_W);
      } else {
        dx = 0.0;
      }
      if (corner.includes("s")) {
        loY = Math.max(loY, MIN_H - r.height); hiY = Math.min(hiY, h - r.y1);
      } else if (corner.includes("n")) {
        loY = Math.max(loY, -r.y0); hiY = Math.min(hiY, r.height - MIN_H);
      } else {
        dy = 0.0;
      }
    }
    dx = loX > hiX ? 0.0 : Math.max(loX, Math.min(hiX, dx));
    dy = loY > hiY ? 0.0 : Math.max(loY, Math.min(hiY, dy));
    return [dx, dy];
  }

  /** Normalize, enforce a minimum size and keep the rect on the page. */
  clamp(rect: Rect): Rect {
    const [w, h] = this.app.pageSize();
    const r = rect.clone().normalize();
    if (r.width < MIN_W) r.x1 = r.x0 + MIN_W;
    if (r.height < MIN_H) r.y1 = r.y0 + MIN_H;
    const dx = r.x0 < 0 ? -r.x0 : Math.min(0.0, w - r.x1);
    const dy = r.y0 < 0 ? -r.y0 : Math.min(0.0, h - r.y1);
    return r.plus(dx, dy, dx, dy);
  }
}
