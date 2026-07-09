"""Main window: toolbar, page canvas, field sidebar, detection worker, export.

Threading: one background worker runs the detection pipeline and posts
messages to a queue that the Tk thread drains via after(). PyMuPDF is not
thread-safe, so FITZ_LOCK guards every fitz call in both threads; the slow
Ollama request runs outside the lock on a pre-rendered image.
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
from dataclasses import replace
from pathlib import Path
from tkinter import filedialog, messagebox

import fitz
from PIL import Image

from .. import ai
from ..extract import PageData, extract_page
from ..fields import assign_names, strip_existing_fields
from ..heuristics import (Candidate, _trim_rect, detect, detect_in_region,
                          slugify)
from ..writer import write_fields
from .page_canvas import PageCanvas

FITZ_LOCK = threading.Lock()

FTYPES = ("text", "checkbox", "date", "signature")
ZOOM_100 = 100 / 72  # pixels per point at "100%" (same scale as preview.py)


def _copy_cands(cands: list[Candidate]) -> list[Candidate]:
    """Deep-enough copies so worker and UI never share mutable objects."""
    return [replace(c, rect=fitz.Rect(c.rect)) for c in cands]


class App(tk.Tk):
    def __init__(self, path: str | None = None) -> None:
        super().__init__()
        self.title("pdf-form-automator")
        self.geometry("1240x860")

        self.path: Path | None = None
        self.doc: fitz.Document | None = None
        self.page_count = 0
        self.page = 0
        self.zoom_pct = 100.0
        self.page_data: dict[int, PageData] = {}
        self.cands: dict[int, list[Candidate]] = {}
        self.selection: list[int] = []
        # full undo/redo history: snapshots of one page's candidate list
        self.undo_hist: list[tuple[int, list[Candidate], list[int]]] = []
        self.redo_hist: list[tuple[int, list[Candidate], list[int]]] = []
        self.dirty_pages: set[int] = set()
        self._page_sizes: dict[int, tuple[float, float]] = {}

        self.queue: queue.Queue = queue.Queue()
        self.run_id = 0
        self.cancel = threading.Event()
        self.worker: threading.Thread | None = None

        self._syncing = False
        self._editor_loaded: tuple[str, str, str, bool] = ("", "", "", False)
        self._build_ui()
        self._bind_keys()
        self.after(100, self._poll)
        self._status("Open a PDF to begin.")
        if path:
            self.after(50, lambda: self.open_pdf(Path(path)))

    # --------------------------------------------------------------- UI setup

    def _build_ui(self) -> None:
        bar = tk.Frame(self, bd=1, relief="raised")
        bar.pack(side="top", fill="x")

        tk.Button(bar, text="Open…", command=self._open_dialog).pack(side="left", padx=(4, 8), pady=3)

        self.mode_var = tk.StringVar(value="select")
        for text, val in (("Select", "select"), ("Add field", "draw")):
            tk.Radiobutton(bar, text=text, value=val, variable=self.mode_var,
                           indicatoron=False, padx=8, pady=2).pack(side="left")
        self.mode_var.trace_add("write", self._on_mode_change)

        tk.Label(bar, text=" New type:").pack(side="left", padx=(10, 0))
        self.new_type_var = tk.StringVar(value="auto")
        tk.OptionMenu(bar, self.new_type_var, "auto", *FTYPES).pack(side="left")

        self.ai_var = tk.BooleanVar(value=True)
        tk.Checkbutton(bar, text="AI check", variable=self.ai_var).pack(side="left", padx=(12, 0))
        tk.Button(bar, text="Re-detect", command=self.redetect).pack(side="left", padx=4)

        tk.Button(bar, text="Export…", command=self.export).pack(side="right", padx=4)

        tk.Button(bar, text="+", width=2, command=lambda: self.zoom_by(1.2)).pack(side="right")
        self.zoom_label = tk.Label(bar, text="100%", width=5)
        self.zoom_label.pack(side="right")
        tk.Button(bar, text="−", width=2, command=lambda: self.zoom_by(1 / 1.2)).pack(side="right")

        tk.Button(bar, text="▶", width=2, command=lambda: self.goto_page(self.page + 1)).pack(side="right", padx=(0, 12))
        self.page_label = tk.Label(bar, text="– / –", width=7)
        self.page_label.pack(side="right")
        tk.Button(bar, text="◀", width=2, command=lambda: self.goto_page(self.page - 1)).pack(side="right")

        body = tk.PanedWindow(self, orient="horizontal", sashwidth=5)
        body.pack(fill="both", expand=True)

        canvas_frame = tk.Frame(body)
        self.canvas = PageCanvas(canvas_frame, self)
        vsb = tk.Scrollbar(canvas_frame, orient="vertical", command=self.canvas.yview)
        hsb = tk.Scrollbar(canvas_frame, orient="horizontal", command=self.canvas.xview)
        self.canvas.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        canvas_frame.rowconfigure(0, weight=1)
        canvas_frame.columnconfigure(0, weight=1)
        body.add(canvas_frame, stretch="always")

        side = tk.Frame(body, width=270)
        body.add(side, stretch="never", width=270)

        tk.Label(side, text="Fields on this page", anchor="w").pack(fill="x", padx=6, pady=(6, 0))
        list_frame = tk.Frame(side)
        list_frame.pack(fill="both", expand=True, padx=6, pady=4)
        self.field_list = tk.Listbox(list_frame, exportselection=False,
                                     selectmode="extended")
        lsb = tk.Scrollbar(list_frame, orient="vertical", command=self.field_list.yview)
        self.field_list.configure(yscrollcommand=lsb.set)
        self.field_list.pack(side="left", fill="both", expand=True)
        lsb.pack(side="right", fill="y")
        self.field_list.bind("<<ListboxSelect>>", self._on_list_select)

        editor = tk.LabelFrame(side, text="Selected field")
        editor.pack(fill="x", padx=6, pady=(0, 6))
        tk.Label(editor, text="Name").grid(row=0, column=0, sticky="w", padx=4)
        self.sv_name = tk.StringVar()
        self.e_name = tk.Entry(editor, textvariable=self.sv_name)
        self.e_name.grid(row=0, column=1, sticky="ew", padx=4, pady=2)
        tk.Label(editor, text="Label").grid(row=1, column=0, sticky="w", padx=4)
        self.sv_label = tk.StringVar()
        self.e_label = tk.Entry(editor, textvariable=self.sv_label)
        self.e_label.grid(row=1, column=1, sticky="ew", padx=4, pady=2)
        tk.Label(editor, text="Type").grid(row=2, column=0, sticky="w", padx=4)
        self.sv_type = tk.StringVar(value="text")
        tk.OptionMenu(editor, self.sv_type, *FTYPES).grid(row=2, column=1, sticky="ew", padx=4, pady=2)
        self.bv_multiline = tk.BooleanVar()
        tk.Checkbutton(editor, text="Multiline", variable=self.bv_multiline).grid(
            row=3, column=1, sticky="w", padx=4)
        btns = tk.Frame(editor)
        btns.grid(row=4, column=0, columnspan=2, sticky="ew", pady=(2, 4))
        tk.Button(btns, text="Delete (Del)", command=self.delete_selected).pack(side="left", padx=4)
        tk.Button(btns, text="Undo", command=self.undo).pack(side="left")
        tk.Button(btns, text="Redo", command=self.redo).pack(side="left", padx=4)
        editor.columnconfigure(1, weight=1)
        self.editor_frame = editor

        for entry in (self.e_name, self.e_label):
            entry.bind("<Return>", self._commit_editor)
            entry.bind("<FocusOut>", self._commit_editor)
        self.sv_type.trace_add("write", self._commit_editor)
        self.bv_multiline.trace_add("write", self._commit_editor)

        self.status = tk.Label(self, anchor="w", bd=1, relief="sunken", padx=6)
        self.status.pack(side="bottom", fill="x")

    def _bind_keys(self) -> None:
        self.bind("<Delete>", self._on_delete_key)
        self.bind("<BackSpace>", self._on_delete_key)
        self.bind("<Control-z>", lambda e: None if self._typing() else self.undo())
        self.bind("<Control-Z>", lambda e: None if self._typing() else self.redo())
        self.bind("<Control-y>", lambda e: None if self._typing() else self.redo())
        self.bind("<Control-a>", self._on_select_all)
        self.bind("<Prior>", lambda e: self.goto_page(self.page - 1))
        self.bind("<Next>", lambda e: self.goto_page(self.page + 1))
        self.bind("<Escape>", self._on_escape)
        self.bind("<Control-plus>", lambda e: self.zoom_by(1.2))
        self.bind("<Control-equal>", lambda e: self.zoom_by(1.2))
        self.bind("<Control-minus>", lambda e: self.zoom_by(1 / 1.2))
        self.bind("<Control-0>", lambda e: self.zoom_reset())
        for key, dx, dy in (("<Left>", -1, 0), ("<Right>", 1, 0),
                            ("<Up>", 0, -1), ("<Down>", 0, 1)):
            self.bind(key, lambda e, dx=dx, dy=dy: self._arrow_key(e, dx, dy))
            self.bind(f"<Shift{key[1:-1]}>".replace("<Shift", "<Shift-"),
                      lambda e, dx=dx, dy=dy: self._arrow_key(e, dx * 5, dy * 5))

    def _typing(self) -> bool:
        return isinstance(self.focus_get(), (tk.Entry, tk.Listbox))

    def _on_delete_key(self, _e: tk.Event) -> None:
        if not self._typing():
            self.delete_selected()

    def _on_select_all(self, _e: tk.Event) -> None:
        if not self._typing():
            self.select_set(list(range(len(self.current_cands()))))

    def _arrow_key(self, _e: tk.Event, dx: float, dy: float) -> None:
        if self._typing() or not self.selection:
            return
        cand_list = self.current_cands()
        bases = {i: fitz.Rect(cand_list[i].rect) for i in self.selection
                 if i < len(cand_list)}
        if not bases:
            return
        dx, dy = self.canvas.clamp_delta(None, bases, dx, dy)
        if not dx and not dy:
            return
        self.commit_rects({i: fitz.Rect(r) + (dx, dy, dx, dy)
                           for i, r in bases.items()})

    def _on_escape(self, _e: tk.Event) -> None:
        self.canvas.cancel_drag()
        if self.mode_var.get() != "select":
            self.mode_var.set("select")
        elif self.selection:
            self.select_set([])

    def _on_mode_change(self, *_a) -> None:
        if self.mode_var.get() == "draw":
            self._status("Add field: drag a rectangle where a field is missing - "
                         "it snaps to lines/boxes there, or is placed as drawn.")

    # ------------------------------------------------- interface for canvas

    def mode(self) -> str:
        return self.mode_var.get()

    def current_cands(self) -> list[Candidate]:
        return self.cands.get(self.page, [])

    @property
    def zoom(self) -> float:
        return self.zoom_pct / 100.0 * ZOOM_100

    def page_size(self) -> tuple[float, float]:
        if self.page in self._page_sizes:
            return self._page_sizes[self.page]
        if not self.doc:
            return (595.0, 842.0)
        with FITZ_LOCK:
            r = self.doc[self.page].rect
        self._page_sizes[self.page] = (r.width, r.height)
        return self._page_sizes[self.page]

    def render_page_image(self) -> Image.Image | None:
        if not self.doc:
            return None
        z = self.zoom
        with FITZ_LOCK:
            page = self.doc[self.page]
            self._page_sizes[self.page] = (page.rect.width, page.rect.height)
            pix = page.get_pixmap(matrix=fitz.Matrix(z, z))
        return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

    @property
    def selected(self) -> int | None:
        """Primary selection: the field whose values the editor shows."""
        return self.selection[-1] if self.selection else None

    def select_single(self, index: int) -> None:
        self.selection = [index]
        self._selection_changed()

    def select_add(self, index: int) -> None:
        if index not in self.selection:
            self.selection.append(index)
        self._selection_changed()

    def select_toggle(self, index: int) -> None:
        if index in self.selection:
            self.selection.remove(index)
        else:
            self.selection.append(index)
        self._selection_changed()

    def select_set(self, indices: list[int]) -> None:
        self.selection = list(indices)
        self._selection_changed()

    def _selection_changed(self) -> None:
        self._refresh_sidebar()
        self.canvas.redraw_overlays()

    # -------------------------------------------------------- undo history

    def _push_history(self) -> None:
        """Snapshot the current page before a mutation; every user edit goes
        through here, so Ctrl+Z walks back arbitrarily far."""
        self.undo_hist.append(
            (self.page, _copy_cands(self.current_cands()), list(self.selection)))
        del self.undo_hist[:-200]
        self.redo_hist.clear()

    def undo(self) -> None:
        self._apply_history(self.undo_hist, self.redo_hist, "Undo")

    def redo(self) -> None:
        self._apply_history(self.redo_hist, self.undo_hist, "Redo")

    def _apply_history(self, source: list, target: list, what: str) -> None:
        if not source:
            self._status(f"Nothing to {what.lower()}.")
            return
        page, snapshot, sel = source.pop()
        target.append((page, _copy_cands(self.cands.get(page, [])),
                       list(self.selection) if page == self.page else []))
        self.cands[page] = snapshot
        self.dirty_pages.add(page)
        if page != self.page:
            self.page = page
            self.canvas.refresh(full=True)
            self._update_nav()
        self.selection = [i for i in sel if i < len(snapshot)]
        self._refresh_sidebar()
        self.canvas.redraw_overlays()
        self._status(f"{what}: one step on page {page + 1}.")

    def commit_rects(self, changes: dict[int, fitz.Rect]) -> None:
        cand_list = self.current_cands()
        changes = {i: r for i, r in changes.items() if i < len(cand_list)}
        if not changes:
            return
        self._push_history()
        for i, r in changes.items():
            cand_list[i].rect = fitz.Rect(r)
        self.dirty_pages.add(self.page)
        self.canvas.redraw_overlays()

    def on_nudge(self, region: fitz.Rect) -> None:
        if self.path is None:
            return
        data = self.page_data.get(self.page)
        found = detect_in_region(data, region) if data else []
        override = self.new_type_var.get()
        if not found:
            ftype = override if override in FTYPES else "text"
            found = [Candidate(self.page, self.canvas.clamp(region), ftype, "",
                               multiline=region.height > 30, source="manual")]
            note = "no matching geometry, field placed as drawn"
        else:
            if override in FTYPES:
                for c in found:
                    c.ftype = override
            note = "snapped to page geometry"
        cand_list = self.cands.setdefault(self.page, [])
        # never create overlaps with fields already on the page: mostly
        # covered -> skip, slight overlap -> trim (same rule as detection)
        surviving = []
        for c in found:
            rect = fitz.Rect(c.rect)
            for k in cand_list:
                inter = fitz.Rect(rect).intersect(k.rect)
                if inter.is_empty or abs(inter) <= 0.01:
                    continue
                if abs(inter) > 0.5 * min(abs(rect), abs(k.rect)):
                    rect = None
                    break
                rect = _trim_rect(rect, k.rect)
                if rect is None:
                    break
            if rect is not None:
                c.rect = rect
                surviving.append(c)
        found = surviving
        if not found:
            self._status("A field already covers that area.")
            return
        self._push_history()
        first_new = len(cand_list)
        cand_list.extend(found)
        self.dirty_pages.add(self.page)
        self.mode_var.set("select")
        self.select_set(list(range(first_new, len(cand_list))))
        self._status(f"Added {len(found)} field(s) ({note}).")

    # ------------------------------------------------------------ field edits

    def delete_selected(self) -> None:
        cand_list = self.current_cands()
        doomed = sorted({i for i in self.selection if i < len(cand_list)},
                        reverse=True)
        if not doomed:
            return
        self._push_history()
        for i in doomed:
            cand_list.pop(i)
        self.dirty_pages.add(self.page)
        self.selection = []
        self._refresh_sidebar()
        self.canvas.redraw_overlays()
        self._status(f"Deleted {len(doomed)} field(s) - Ctrl+Z to undo.")

    def _commit_editor(self, *_a) -> None:
        if self._syncing:
            return
        cand_list = self.current_cands()
        sel = [i for i in self.selection if i < len(cand_list)]
        if not sel:
            return
        primary = cand_list[sel[-1]]
        new_name = self.sv_name.get().strip()
        new_label = self.sv_label.get().strip()
        new_type = self.sv_type.get()
        new_ml = self.bv_multiline.get()
        # name/label belong to the primary field; type/multiline apply to the
        # whole selection, but only when the user actually changed them (a
        # mixed selection must not be retyped by an unrelated rename)
        _, _, loaded_type, loaded_ml = self._editor_loaded
        type_changed = new_type != loaded_type and new_type in FTYPES
        ml_changed = new_ml != loaded_ml
        changed = (primary.name != new_name or primary.label != new_label
                   or type_changed or ml_changed)
        if not changed:
            return
        self._push_history()
        primary.name, primary.label = new_name, new_label
        for i in sel:
            if type_changed:
                cand_list[i].ftype = new_type
            if ml_changed:
                cand_list[i].multiline = new_ml
        self._editor_loaded = (new_name, new_label,
                               new_type if type_changed else loaded_type,
                               new_ml)
        self.dirty_pages.add(self.page)
        self.canvas.redraw_overlays()
        self._refresh_list_only()

    # ---------------------------------------------------------------- sidebar

    def _list_entry(self, c: Candidate) -> str:
        return f"{c.name or c.label or '(unnamed)'}  ·  {c.ftype}"

    def _refresh_list_only(self) -> None:
        self._syncing = True
        lb = self.field_list
        lb.delete(0, tk.END)
        for c in self.current_cands():
            lb.insert(tk.END, self._list_entry(c))
        for i in self.selection:
            if i < lb.size():
                lb.selection_set(i)
        if self.selected is not None and self.selected < lb.size():
            lb.see(self.selected)
        self._syncing = False

    def _refresh_editor(self) -> None:
        saved, self._syncing = self._syncing, True
        try:
            cand_list = self.current_cands()
            sel = [i for i in self.selection if i < len(cand_list)]
            if sel:
                c = cand_list[sel[-1]]
                types = {cand_list[i].ftype for i in sel}
                # blank type on a mixed selection: picking a value then
                # retypes the whole selection
                shown_type = c.ftype if len(types) == 1 and c.ftype in FTYPES else ""
                self.sv_name.set(c.name)
                self.sv_label.set(c.label)
                self.sv_type.set(shown_type)
                self.bv_multiline.set(c.multiline)
                self._editor_loaded = (c.name, c.label, shown_type, c.multiline)
            else:
                self.sv_name.set("")
                self.sv_label.set("")
                self.sv_type.set("")
                self.bv_multiline.set(False)
                self._editor_loaded = ("", "", "", False)
            self.editor_frame.config(
                text=f"Selected fields ({len(sel)})" if len(sel) > 1 else "Selected field")
        finally:
            self._syncing = saved

    def _refresh_sidebar(self) -> None:
        self._refresh_list_only()
        self._refresh_editor()

    def _on_list_select(self, _e: tk.Event) -> None:
        if self._syncing:
            return
        self.selection = list(self.field_list.curselection())
        self._refresh_editor()
        self.canvas.redraw_overlays()

    # ------------------------------------------------------- open & detection

    def _open_dialog(self) -> None:
        name = filedialog.askopenfilename(title="Open PDF",
                                          filetypes=[("PDF files", "*.pdf"), ("All files", "*")])
        if name:
            self.open_pdf(Path(name))

    def open_pdf(self, path: Path) -> None:
        if not path.is_file():
            messagebox.showerror("Not found", f"{path} does not exist.")
            return
        self.cancel.set()
        try:
            with FITZ_LOCK:
                doc = fitz.open(path)
        except Exception as e:
            messagebox.showerror("Cannot open", f"{path.name}: {e}")
            return
        with FITZ_LOCK:
            if self.doc:
                self.doc.close()
            self.doc = doc
            self.page_count = len(doc)
        self.path = path
        self.title(f"pdf-form-automator — {path.name}")
        self.page = 0
        self.selection = []
        self.page_data.clear()
        self.cands.clear()
        self.dirty_pages.clear()
        self.undo_hist.clear()
        self.redo_hist.clear()
        self._page_sizes.clear()
        self.canvas.refresh(full=True)
        self._refresh_sidebar()
        self._update_nav()
        self._start_worker()

    def redetect(self) -> None:
        if not self.path:
            return
        if self.dirty_pages and not messagebox.askyesno(
                "Re-run detection", "This discards your edits and re-runs detection. Continue?"):
            return
        self.selection = []
        self.page_data.clear()
        self.cands.clear()
        self.dirty_pages.clear()
        self.undo_hist.clear()
        self.redo_hist.clear()
        self.canvas.redraw_overlays()
        self._refresh_sidebar()
        self._start_worker()

    def _start_worker(self) -> None:
        self.cancel.set()
        self.run_id += 1
        self.cancel = threading.Event()
        self.worker = threading.Thread(
            target=self._detect_worker,
            args=(self.path, self.ai_var.get(), self.run_id, self.cancel),
            daemon=True)
        self.worker.start()

    def _detect_worker(self, path: Path, use_ai: bool, run_id: int,
                       cancel: threading.Event) -> None:
        def put(*msg) -> None:
            self.queue.put((run_id,) + msg)

        doc = None
        try:
            with FITZ_LOCK:
                doc = fitz.open(path)
                page_count = len(doc)
            if use_ai and not ai.ollama_available():
                put("ai_off", "Ollama not reachable at localhost:11434 - detection without AI pass.")
                use_ai = False
            pages: list[tuple[int, PageData, list[Candidate]]] = []
            for pno in range(page_count):
                if cancel.is_set():
                    return
                put("status", f"Detecting fields - page {pno + 1}/{page_count} …")
                with FITZ_LOCK:
                    data = extract_page(doc[pno])
                cands = detect(data)
                pages.append((pno, data, cands))
                put("page", pno, data, _copy_cands(cands))
            if use_ai:
                for pno, data, cands in pages:
                    if cancel.is_set():
                        return
                    if not cands:
                        continue
                    put("status", f"AI verification - page {pno + 1}/{page_count} "
                                  "(local model, this can take a while) …")
                    sub = [c for c in cands if c.source != "table"]
                    png = None
                    if sub and len(sub) <= 40:
                        with FITZ_LOCK:
                            png = ai._render_with_boxes(doc[pno], sub)
                    with FITZ_LOCK:
                        page = doc[pno]
                    verified = ai.verify_page(page, data, cands, render=png)
                    put("page", pno, data, _copy_cands(verified))
            put("done")
        except Exception as e:  # surfaced in the status bar / dialog
            put("error", f"{type(e).__name__}: {e}")
        finally:
            if doc is not None:
                with FITZ_LOCK:
                    doc.close()

    def _poll(self) -> None:
        while True:
            try:
                msg = self.queue.get_nowait()
            except queue.Empty:
                break
            if msg[0] != self.run_id:
                continue  # stale message from a superseded run
            kind = msg[1]
            if kind == "status":
                self._status(msg[2])
            elif kind == "ai_off":
                self.ai_var.set(False)
                self._status(msg[2])
            elif kind == "page":
                pno, data, cands = msg[2], msg[3], msg[4]
                self.page_data[pno] = data
                if pno not in self.dirty_pages:  # never clobber user edits
                    self.cands[pno] = cands
                    if pno == self.page:
                        self.selection = []
                        self._refresh_sidebar()
                        self.canvas.redraw_overlays()
            elif kind == "done":
                total = sum(len(v) for v in self.cands.values())
                self._status(f"Detection finished: {total} field(s). "
                             "Review/edit them, then Export.")
            elif kind == "error":
                self._status("Detection failed: " + msg[2])
                messagebox.showerror("Detection failed", msg[2])
        self.after(100, self._poll)

    # ------------------------------------------------------- nav, zoom, export

    def goto_page(self, pno: int) -> None:
        if not self.doc:
            return
        pno = max(0, min(self.page_count - 1, pno))
        if pno == self.page:
            return
        self.page = pno
        self.selection = []
        self.canvas.refresh(full=True)
        self._refresh_sidebar()
        self._update_nav()

    def zoom_by(self, factor: float) -> None:
        self.zoom_pct = max(40.0, min(400.0, self.zoom_pct * factor))
        self._update_nav()
        self.canvas.refresh(full=True)

    def zoom_reset(self) -> None:
        self.zoom_pct = 100.0
        self._update_nav()
        self.canvas.refresh(full=True)

    def _update_nav(self) -> None:
        self.page_label.config(text=f"{self.page + 1} / {self.page_count}" if self.doc else "– / –")
        self.zoom_label.config(text=f"{self.zoom_pct:.0f}%")

    def export(self) -> None:
        if not self.path:
            return
        if self.worker and self.worker.is_alive() and not messagebox.askyesno(
                "Detection still running", "Export with the fields found so far?"):
            return
        all_cands = [c for p in sorted(self.cands)
                     for c in sorted(self.cands[p], key=lambda c: (c.rect.y0, c.rect.x0))]
        if not all_cands:
            messagebox.showinfo("Nothing to export", "There are no form fields to write.")
            return
        out = filedialog.asksaveasfilename(
            title="Export fillable PDF",
            initialdir=str(self.path.parent),
            initialfile=f"{self.path.stem}.fillable.pdf",
            defaultextension=".pdf",
            filetypes=[("PDF files", "*.pdf")])
        if not out:
            return
        self.config(cursor="watch")
        self.update_idletasks()
        try:
            for c in all_cands:
                if c.name:
                    c.name = slugify(c.name)
            assign_names(all_cands)
            with FITZ_LOCK:
                doc = fitz.open(self.path)
                strip_existing_fields(doc)
                data = write_fields(doc, all_cands)
                doc.close()
            Path(out).write_bytes(data)
        except Exception as e:
            messagebox.showerror("Export failed", f"{type(e).__name__}: {e}")
            return
        finally:
            self.config(cursor="")
        counts: dict[str, int] = {}
        for c in all_cands:
            counts[c.ftype] = counts.get(c.ftype, 0) + 1
        summary = ", ".join(f"{n} {t}" for t, n in sorted(counts.items()))
        self._refresh_sidebar()  # names may have been assigned/uniquified
        self.canvas.redraw_overlays()
        self._status(f"Exported {Path(out).name}  ({summary})")

    def _status(self, text: str) -> None:
        self.status.config(text=text)
