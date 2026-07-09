/** Main application: toolbar, page view, field sidebar, worker, export.
 * Port of gui/app.py — the Tk thread/queue machinery becomes worker
 * postMessage with runId staleness filtering.
 */

import { Rect, pyRound } from "../geometry";
import { detectInRegion, slugify, trimRect } from "../heuristics";
import { assignNames } from "../fields";
import type { Candidate, FType, PageData } from "../types";
import {
  FTYPES, candidateFromJSON, candidateToJSON, cloneCandidate, makeCandidate, pageDataFromJSON,
} from "../types";
import type { WorkerRequest, WorkerResponse } from "../worker/protocol";
import { History, snapshot } from "./history";
import { PageCanvas } from "./pageCanvas";

const ZOOM_100 = 100 / 72; // pixels per point at "100%" (same as preview.py)

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export class App {
  // document state
  fileName: string | null = null;
  pageCount = 0;
  page = 0;
  zoomPct = 100.0;
  pageData = new Map<number, PageData>();
  cands = new Map<number, Candidate[]>();
  selection: number[] = [];
  history = new History();
  dirtyPages = new Set<number>();
  pageSizes = new Map<number, [number, number]>();

  private worker: Worker;
  private runId = 0;
  private detecting = false;
  private msgId = 0;
  private lastRenderId = 0;
  private lastExportId = 0;
  private openId = 0;

  private canvas: PageCanvas;
  private syncing = false;
  private editorLoaded: [string, string, string, boolean] = ["", "", "", false];
  private listAnchor = 0;

  // DOM
  private dom = {
    fileInput: el<HTMLInputElement>("file-input"),
    modeSelect: el<HTMLButtonElement>("mode-select"),
    modeDraw: el<HTMLButtonElement>("mode-draw"),
    newType: el<HTMLSelectElement>("new-type"),
    pageLabel: el<HTMLSpanElement>("page-label"),
    zoomLabel: el<HTMLSpanElement>("zoom-label"),
    thumbs: el<HTMLElement>("thumbs"),
    viewport: el<HTMLElement>("viewport"),
    pageWrap: el<HTMLDivElement>("page-wrap"),
    bitmap: el<HTMLCanvasElement>("page-bitmap"),
    emptyState: el<HTMLDivElement>("empty-state"),
    fieldList: el<HTMLDivElement>("field-list"),
    editorLegend: el<HTMLElement>("editor-legend"),
    fName: el<HTMLInputElement>("f-name"),
    fLabel: el<HTMLInputElement>("f-label"),
    fType: el<HTMLSelectElement>("f-type"),
    fMultiline: el<HTMLInputElement>("f-multiline"),
    status: el<HTMLElement>("status"),
    dropHint: el<HTMLDivElement>("drop-hint"),
  };

  private overlay: SVGSVGElement;

  constructor() {
    this.worker = new Worker(new URL("../worker/pdf.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => {
      console.error("PDF worker error:", e.message, e.filename, e.lineno);
      this.status(`PDF engine error: ${e.message || "failed to load"}`);
    };
    this.overlay = document.getElementById("overlay") as unknown as SVGSVGElement;
    this.canvas = new PageCanvas(this.overlay, this);
    this.buildUI();
    this.bindKeys();
    this.status("Open a PDF to begin.");
  }

  // ------------------------------------------------------------- UI setup

  private buildUI(): void {
    el("btn-open").addEventListener("click", () => this.dom.fileInput.click());
    el("btn-open-2").addEventListener("click", () => this.dom.fileInput.click());
    this.dom.fileInput.addEventListener("change", () => {
      const file = this.dom.fileInput.files?.[0];
      if (file) void this.openPdf(file);
      this.dom.fileInput.value = "";
    });

    this.dom.modeSelect.addEventListener("click", () => this.setMode("select"));
    this.dom.modeDraw.addEventListener("click", () => this.setMode("draw"));

    el("btn-redetect").addEventListener("click", () => this.redetect());
    el("btn-export").addEventListener("click", () => this.export());
    el("page-prev").addEventListener("click", () => this.gotoPage(this.page - 1));
    el("page-next").addEventListener("click", () => this.gotoPage(this.page + 1));
    el("zoom-in").addEventListener("click", () => this.zoomBy(1.2));
    el("zoom-out").addEventListener("click", () => this.zoomBy(1 / 1.2));
    el("btn-delete").addEventListener("click", () => this.deleteSelected());
    el("btn-undo").addEventListener("click", () => this.undo());
    el("btn-redo").addEventListener("click", () => this.redo());

    for (const input of [this.dom.fName, this.dom.fLabel]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          this.commitEditor();
          input.blur();
        }
      });
      input.addEventListener("blur", () => this.commitEditor());
    }
    this.dom.fType.addEventListener("change", () => this.commitEditor());
    this.dom.fMultiline.addEventListener("change", () => this.commitEditor());

    // ctrl+wheel zoom on the page view
    this.dom.viewport.addEventListener("wheel", (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2);
      }
    }, { passive: false });

    // drag & drop anywhere
    let dragDepth = 0;
    window.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (++dragDepth === 1) this.dom.dropHint.hidden = false;
    });
    window.addEventListener("dragleave", () => {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        this.dom.dropHint.hidden = true;
      }
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      this.dom.dropHint.hidden = true;
      const file = e.dataTransfer?.files?.[0];
      if (file && /\.pdf$/i.test(file.name)) void this.openPdf(file);
    });
  }

  private bindKeys(): void {
    window.addEventListener("keydown", (e) => {
      if (this.typing()) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key;
      if (key === "Delete" || key === "Backspace") {
        e.preventDefault();
        this.deleteSelected();
      } else if (ctrl && !e.shiftKey && key.toLowerCase() === "z") {
        e.preventDefault();
        this.undo();
      } else if (ctrl && (key.toLowerCase() === "y" || (e.shiftKey && key.toLowerCase() === "z"))) {
        e.preventDefault();
        this.redo();
      } else if (ctrl && key.toLowerCase() === "a") {
        e.preventDefault();
        this.selectSet(this.currentCands().map((_, i) => i));
      } else if (key === "PageUp") {
        e.preventDefault();
        this.gotoPage(this.page - 1);
      } else if (key === "PageDown") {
        e.preventDefault();
        this.gotoPage(this.page + 1);
      } else if (key === "Escape") {
        this.onEscape();
      } else if (ctrl && (key === "+" || key === "=")) {
        e.preventDefault();
        this.zoomBy(1.2);
      } else if (ctrl && key === "-") {
        e.preventDefault();
        this.zoomBy(1 / 1.2);
      } else if (ctrl && key === "0") {
        e.preventDefault();
        this.zoomReset();
      } else if (key.startsWith("Arrow")) {
        const step = e.shiftKey ? 5 : 1;
        const [dx, dy] = {
          ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
        }[key as "ArrowLeft"] ?? [0, 0];
        if ((dx || dy) && this.selection.length) {
          e.preventDefault();
          this.arrowKey(dx, dy);
        }
      }
    });
  }

  private typing(): boolean {
    const a = document.activeElement;
    return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement;
  }

  private arrowKey(dx: number, dy: number): void {
    const candList = this.currentCands();
    const bases = new Map<number, Rect>();
    for (const i of this.selection) {
      if (i < candList.length) bases.set(i, candList[i].rect.clone());
    }
    if (!bases.size) return;
    [dx, dy] = this.canvas.clampDelta(null, bases, dx, dy);
    if (!dx && !dy) return;
    this.commitRects(new Map(Array.from(bases, ([i, r]) => [i, r.plus(dx, dy, dx, dy)])));
  }

  private onEscape(): void {
    this.canvas.cancelDrag();
    if (this.mode() !== "select") {
      this.setMode("select");
    } else if (this.selection.length) {
      this.selectSet([]);
    }
  }

  private setMode(mode: "select" | "draw"): void {
    this.dom.modeSelect.classList.toggle("active", mode === "select");
    this.dom.modeDraw.classList.toggle("active", mode === "draw");
    if (mode === "draw") {
      this.status("Add field: drag a rectangle where a field is missing – "
        + "it snaps to lines/boxes there, or is placed as drawn.");
    }
  }

  // ---------------------------------------------- interface for the canvas

  mode(): "select" | "draw" {
    return this.dom.modeDraw.classList.contains("active") ? "draw" : "select";
  }

  currentCands(): Candidate[] {
    return this.cands.get(this.page) ?? [];
  }

  get zoom(): number {
    return (this.zoomPct / 100.0) * ZOOM_100;
  }

  pageSize(): [number, number] {
    return this.pageSizes.get(this.page) ?? [595.0, 842.0];
  }

  get selected(): number | null {
    return this.selection.length ? this.selection[this.selection.length - 1] : null;
  }

  selectSingle(index: number): void {
    this.selection = [index];
    this.selectionChanged();
  }

  selectAdd(index: number): void {
    if (!this.selection.includes(index)) this.selection.push(index);
    this.selectionChanged();
  }

  selectToggle(index: number): void {
    const at = this.selection.indexOf(index);
    if (at >= 0) this.selection.splice(at, 1);
    else this.selection.push(index);
    this.selectionChanged();
  }

  selectSet(indices: number[]): void {
    this.selection = [...indices];
    this.selectionChanged();
  }

  private selectionChanged(): void {
    this.refreshSidebar();
    this.canvas.redrawOverlays();
  }

  // ---------------------------------------------------------- undo history

  private pushHistory(): void {
    this.history.push(this.page, this.currentCands(), this.selection);
  }

  undo(): void {
    this.applyHistory(this.history.undoStack, this.history.redoStack, "Undo");
  }

  redo(): void {
    this.applyHistory(this.history.redoStack, this.history.undoStack, "Redo");
  }

  private applyHistory(source: typeof this.history.undoStack, target: typeof this.history.redoStack, what: string): void {
    const snap = source.pop();
    if (!snap) {
      this.status(`Nothing to ${what.toLowerCase()}.`);
      return;
    }
    target.push(snapshot(snap.page, this.cands.get(snap.page) ?? [],
      snap.page === this.page ? this.selection : []));
    this.cands.set(snap.page, snap.cands);
    this.dirtyPages.add(snap.page);
    if (snap.page !== this.page) {
      this.page = snap.page;
      this.refreshFull();
      this.updateNav();
    }
    this.selection = snap.selection.filter((i) => i < snap.cands.length);
    this.refreshSidebar();
    this.canvas.redrawOverlays();
    this.updateThumbBadge(snap.page);
    this.status(`${what}: one step on page ${snap.page + 1}.`);
  }

  commitRects(changes: Map<number, Rect>): void {
    const candList = this.currentCands();
    const valid = new Map(Array.from(changes).filter(([i]) => i < candList.length));
    if (!valid.size) return;
    this.pushHistory();
    for (const [i, r] of valid) candList[i].rect = r.clone();
    this.dirtyPages.add(this.page);
    this.canvas.redrawOverlays();
  }

  onNudge(region: Rect): void {
    if (this.fileName === null) return;
    const data = this.pageData.get(this.page);
    let found = data ? detectInRegion(data, region) : [];
    const override = this.dom.newType.value;
    let note: string;
    if (!found.length) {
      const ftype = (FTYPES as string[]).includes(override) ? (override as FType) : "text";
      found = [makeCandidate(this.page, this.canvas.clamp(region), ftype, "",
        { multiline: region.height > 30, source: "manual" })];
      note = "no matching geometry, field placed as drawn";
    } else {
      if ((FTYPES as string[]).includes(override)) {
        for (const c of found) c.ftype = override as FType;
      }
      note = "snapped to page geometry";
    }
    const candList = this.cands.get(this.page) ?? [];
    this.cands.set(this.page, candList);
    // never create overlaps with fields already on the page
    const surviving: Candidate[] = [];
    for (const c of found) {
      let rect: Rect | null = c.rect.clone();
      for (const k of candList) {
        const inter = rect.clone().intersect(k.rect);
        if (inter.isEmpty || inter.area() <= 0.01) continue;
        if (inter.area() > 0.5 * Math.min(rect.area(), k.rect.area())) {
          rect = null;
          break;
        }
        rect = trimRect(rect, k.rect);
        if (rect === null) break;
      }
      if (rect !== null) {
        c.rect = rect;
        surviving.push(c);
      }
    }
    found = surviving;
    if (!found.length) {
      this.status("A field already covers that area.");
      return;
    }
    this.pushHistory();
    const firstNew = candList.length;
    candList.push(...found);
    this.dirtyPages.add(this.page);
    this.setMode("select");
    this.selectSet(found.map((_, i) => firstNew + i));
    this.updateThumbBadge(this.page);
    this.status(`Added ${found.length} field(s) (${note}).`);
  }

  // ------------------------------------------------------------ field edits

  deleteSelected(): void {
    const candList = this.currentCands();
    const doomed = Array.from(new Set(this.selection.filter((i) => i < candList.length))).sort((a, b) => b - a);
    if (!doomed.length) return;
    this.pushHistory();
    for (const i of doomed) candList.splice(i, 1);
    this.dirtyPages.add(this.page);
    this.selection = [];
    this.refreshSidebar();
    this.canvas.redrawOverlays();
    this.updateThumbBadge(this.page);
    this.status(`Deleted ${doomed.length} field(s) – Ctrl+Z to undo.`);
  }

  private commitEditor(): void {
    if (this.syncing) return;
    const candList = this.currentCands();
    const sel = this.selection.filter((i) => i < candList.length);
    if (!sel.length) return;
    const primary = candList[sel[sel.length - 1]];
    const newName = this.dom.fName.value.trim();
    const newLabel = this.dom.fLabel.value.trim();
    const newType = this.dom.fType.value;
    const newMl = this.dom.fMultiline.checked;
    // name/label belong to the primary field; type/multiline apply to the
    // whole selection, but only when the user actually changed them
    const [, , loadedType, loadedMl] = this.editorLoaded;
    const typeChanged = newType !== loadedType && (FTYPES as string[]).includes(newType);
    const mlChanged = newMl !== loadedMl;
    const changed = primary.name !== newName || primary.label !== newLabel || typeChanged || mlChanged;
    if (!changed) return;
    this.pushHistory();
    primary.name = newName;
    primary.label = newLabel;
    for (const i of sel) {
      if (typeChanged) candList[i].ftype = newType as FType;
      if (mlChanged) candList[i].multiline = newMl;
    }
    this.editorLoaded = [newName, newLabel, typeChanged ? newType : loadedType, newMl];
    this.dirtyPages.add(this.page);
    this.canvas.redrawOverlays();
    this.refreshListOnly();
  }

  // ---------------------------------------------------------------- sidebar

  private refreshListOnly(): void {
    this.syncing = true;
    const list = this.dom.fieldList;
    list.replaceChildren();
    const selected = new Set(this.selection);
    this.currentCands().forEach((c, i) => {
      const row = document.createElement("div");
      row.className = `row${selected.has(i) ? " selected" : ""}`;
      const name = document.createElement("span");
      name.textContent = c.name || c.label || "(unnamed)";
      const ftype = document.createElement("span");
      ftype.className = "ftype";
      ftype.textContent = c.ftype;
      row.append(name, ftype);
      row.addEventListener("click", (e) => this.onListClick(i, e));
      list.append(row);
    });
    const primary = this.selected;
    if (primary !== null && primary < list.children.length) {
      (list.children[primary] as HTMLElement).scrollIntoView({ block: "nearest" });
    }
    this.syncing = false;
  }

  private onListClick(i: number, e: MouseEvent): void {
    if (e.ctrlKey || e.metaKey) {
      this.selectToggle(i);
    } else if (e.shiftKey) {
      const [a, b] = [Math.min(this.listAnchor, i), Math.max(this.listAnchor, i)];
      this.selectSet(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else {
      this.listAnchor = i;
      this.selectSingle(i);
    }
  }

  private refreshEditor(): void {
    const saved = this.syncing;
    this.syncing = true;
    try {
      const candList = this.currentCands();
      const sel = this.selection.filter((i) => i < candList.length);
      if (sel.length) {
        const c = candList[sel[sel.length - 1]];
        const types = new Set(sel.map((i) => candList[i].ftype));
        // blank type on a mixed selection: picking a value then retypes all
        const shownType = types.size === 1 && (FTYPES as string[]).includes(c.ftype) ? c.ftype : "";
        this.dom.fName.value = c.name;
        this.dom.fLabel.value = c.label;
        this.dom.fType.value = shownType;
        this.dom.fMultiline.checked = c.multiline;
        this.editorLoaded = [c.name, c.label, shownType, c.multiline];
      } else {
        this.dom.fName.value = "";
        this.dom.fLabel.value = "";
        this.dom.fType.value = "";
        this.dom.fMultiline.checked = false;
        this.editorLoaded = ["", "", "", false];
      }
      this.dom.editorLegend.textContent =
        sel.length > 1 ? `Selected fields (${sel.length})` : "Selected field";
    } finally {
      this.syncing = saved;
    }
  }

  private refreshSidebar(): void {
    this.refreshListOnly();
    this.refreshEditor();
  }

  // ------------------------------------------------------- open & detection

  async openPdf(file: File): Promise<void> {
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (e) {
      this.status(`Cannot read ${file.name}: ${e}`);
      return;
    }
    this.fileName = file.name;
    this.status(`Opening ${file.name} …`);
    const id = ++this.openId;
    this.post({ type: "open", id, buffer }, [buffer]);
  }

  private onOpened(pageCount: number, sizes: [number, number][]): void {
    document.title = `PDF Form Automator — ${this.fileName}`;
    this.pageCount = pageCount;
    this.page = 0;
    this.selection = [];
    this.pageData.clear();
    this.cands.clear();
    this.dirtyPages.clear();
    this.history.clear();
    this.pageSizes.clear();
    sizes.forEach((s, i) => this.pageSizes.set(i, s));
    this.dom.emptyState.hidden = true;
    this.dom.pageWrap.hidden = false;
    this.buildThumbs();
    this.refreshFull();
    this.refreshSidebar();
    this.updateNav();
    this.startDetection();
  }

  redetect(): void {
    if (!this.fileName) return;
    if (this.dirtyPages.size &&
        !window.confirm("This discards your edits and re-runs detection. Continue?")) {
      return;
    }
    this.selection = [];
    this.pageData.clear();
    this.cands.clear();
    this.dirtyPages.clear();
    this.history.clear();
    this.canvas.redrawOverlays();
    this.refreshSidebar();
    for (let i = 0; i < this.pageCount; i++) this.updateThumbBadge(i);
    this.startDetection();
  }

  private startDetection(): void {
    this.runId++;
    this.detecting = true;
    this.post({ type: "detect", runId: this.runId });
  }

  private onWorkerMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case "ready": {
        this.workerReady = true;
        const pending = this.pendingPosts;
        this.pendingPosts = [];
        for (const [m, t] of pending) this.worker.postMessage(m, t);
        break;
      }
      case "opened":
        if (msg.id === this.openId) this.onOpened(msg.pageCount, msg.sizes);
        break;
      case "open-error":
        if (msg.id === this.openId) {
          this.status(`Cannot open ${this.fileName}: ${msg.message}`);
          this.fileName = null;
        }
        break;
      case "status":
        if (msg.runId === this.runId) this.status(msg.text);
        break;
      case "page": {
        if (msg.runId !== this.runId) break; // stale run
        const pno = msg.page;
        this.pageData.set(pno, pageDataFromJSON(msg.data));
        if (!this.dirtyPages.has(pno)) { // never clobber user edits
          this.cands.set(pno, msg.candidates.map(candidateFromJSON));
          this.updateThumbBadge(pno);
          if (pno === this.page) {
            this.selection = [];
            this.refreshSidebar();
            this.canvas.redrawOverlays();
          }
        }
        break;
      }
      case "detect-done": {
        if (msg.runId !== this.runId) break;
        this.detecting = false;
        let total = 0;
        for (const list of this.cands.values()) total += list.length;
        this.status(`Detection finished: ${total} field(s). Review/edit them, then Export.`);
        break;
      }
      case "detect-error":
        if (msg.runId === this.runId) {
          this.detecting = false;
          this.status("Detection failed: " + msg.message);
        }
        break;
      case "rendered":
        if (msg.id === this.lastRenderId) void this.drawBitmap(msg.png, msg.width, msg.height);
        break;
      case "thumbnail":
        this.setThumb(msg.page, msg.png);
        break;
      case "exported":
        if (msg.id === this.lastExportId) this.downloadExport(msg.bytes);
        break;
      case "export-error":
        if (msg.id === this.lastExportId) this.status(`Export failed: ${msg.message}`);
        break;
    }
  }

  /** The worker module suspends at mupdf's top-level await while the wasm
   * loads; messages posted before its onmessage handler exists would be
   * dropped. Queue everything until the worker says "ready". */
  private workerReady = false;
  private pendingPosts: [WorkerRequest, Transferable[]][] = [];

  private post(msg: WorkerRequest, transfer: Transferable[] = []): void {
    if (!this.workerReady) {
      this.pendingPosts.push([msg, transfer]);
      return;
    }
    this.worker.postMessage(msg, transfer);
  }

  // ------------------------------------------------------------- rendering

  /** Re-render the page bitmap and redraw overlays (Tk refresh(full=True)). */
  refreshFull(): void {
    if (!this.fileName) return;
    const dpr = window.devicePixelRatio || 1;
    const id = ++this.msgId;
    this.lastRenderId = id;
    this.post({ type: "render", id, page: this.page, scale: this.zoom * dpr });
    // size the wrap immediately so the layout doesn't jump when the render lands
    const [w, h] = this.pageSize();
    this.sizeWrap(w, h);
    this.canvas.redrawOverlays();
  }

  private sizeWrap(wPoints: number, hPoints: number): void {
    const cssW = wPoints * this.zoom;
    const cssH = hPoints * this.zoom;
    this.dom.bitmap.style.width = `${cssW}px`;
    this.dom.bitmap.style.height = `${cssH}px`;
    this.overlay.setAttribute("viewBox", `0 0 ${wPoints} ${hPoints}`);
  }

  private async drawBitmap(png: ArrayBuffer, width: number, height: number): Promise<void> {
    const bmp = await createImageBitmap(new Blob([png], { type: "image/png" }));
    const canvas = this.dom.bitmap;
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    const [w, h] = this.pageSize();
    this.sizeWrap(w, h);
  }

  // ------------------------------------------------------------ thumbnails

  private buildThumbs(): void {
    const thumbs = this.dom.thumbs;
    thumbs.replaceChildren();
    const dpr = window.devicePixelRatio || 1;
    for (let i = 0; i < this.pageCount; i++) {
      const btn = document.createElement("button");
      btn.className = `thumb${i === this.page ? " active" : ""}`;
      btn.dataset.page = String(i);
      const img = document.createElement("img");
      img.alt = `Page ${i + 1}`;
      const pageno = document.createElement("span");
      pageno.className = "pageno";
      pageno.textContent = String(i + 1);
      const badge = document.createElement("span");
      badge.className = "badge";
      btn.append(img, pageno, badge);
      btn.addEventListener("click", () => this.gotoPage(i));
      thumbs.append(btn);
      this.post({ type: "thumbnail", id: ++this.msgId, page: i, width: Math.round(120 * dpr) });
    }
  }

  private setThumb(pno: number, png: ArrayBuffer): void {
    const btn = this.dom.thumbs.querySelector<HTMLElement>(`[data-page="${pno}"] img`);
    if (btn instanceof HTMLImageElement) {
      const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      btn.onload = () => URL.revokeObjectURL(url);
      btn.src = url;
    }
  }

  private updateThumbBadge(pno: number): void {
    const badge = this.dom.thumbs.querySelector<HTMLElement>(`[data-page="${pno}"] .badge`);
    if (badge) {
      const n = this.cands.get(pno)?.length ?? 0;
      badge.textContent = n ? String(n) : "";
    }
  }

  // ------------------------------------------------------ nav, zoom, export

  gotoPage(pno: number): void {
    if (!this.fileName) return;
    pno = Math.max(0, Math.min(this.pageCount - 1, pno));
    if (pno === this.page) return;
    this.page = pno;
    this.selection = [];
    this.refreshFull();
    this.refreshSidebar();
    this.updateNav();
  }

  zoomBy(factor: number): void {
    this.zoomPct = Math.max(40.0, Math.min(400.0, this.zoomPct * factor));
    this.updateNav();
    this.refreshFull();
  }

  zoomReset(): void {
    this.zoomPct = 100.0;
    this.updateNav();
    this.refreshFull();
  }

  private updateNav(): void {
    this.dom.pageLabel.textContent = this.fileName ? `${this.page + 1} / ${this.pageCount}` : "– / –";
    this.dom.zoomLabel.textContent = `${pyRound(this.zoomPct)}%`;
    this.dom.thumbs.querySelectorAll(".thumb").forEach((t, i) => {
      t.classList.toggle("active", i === this.page);
    });
  }

  export(): void {
    if (!this.fileName) return;
    if (this.detecting &&
        !window.confirm("Detection is still running. Export with the fields found so far?")) {
      return;
    }
    const allCands: Candidate[] = [];
    for (const pno of Array.from(this.cands.keys()).sort((a, b) => a - b)) {
      const sorted = [...this.cands.get(pno)!].sort(
        (a, b) => a.rect.y0 - b.rect.y0 || a.rect.x0 - b.rect.x0,
      );
      allCands.push(...sorted);
    }
    if (!allCands.length) {
      this.status("There are no form fields to write.");
      return;
    }
    for (const c of allCands) {
      if (c.name) c.name = slugify(c.name);
    }
    assignNames(allCands);
    this.refreshSidebar(); // names may have been assigned/uniquified
    this.canvas.redrawOverlays();
    this.status("Exporting …");
    const id = ++this.msgId;
    this.lastExportId = id;
    this.post({ type: "export", id, candidates: allCands.map(candidateToJSON) });
  }

  private downloadExport(bytes: ArrayBuffer): void {
    const stem = (this.fileName ?? "form").replace(/\.pdf$/i, "");
    const name = `${stem}.fillable.pdf`;
    const blob = new Blob([bytes], { type: "application/pdf" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);

    const counts = new Map<string, number>();
    let total = 0;
    for (const list of this.cands.values()) {
      for (const c of list) {
        counts.set(c.ftype, (counts.get(c.ftype) ?? 0) + 1);
        total += 1;
      }
    }
    const summary = Array.from(counts).sort(([a], [b]) => a.localeCompare(b))
      .map(([t, n]) => `${n} ${t}`).join(", ");
    this.status(`Exported ${name}  (${summary || total})`);
  }

  status(text: string): void {
    this.dom.status.textContent = text;
  }
}
