"""Canvas widget: renders the current page and the editable field overlays.

Coordinates: candidate rects live in fitz page points (origin top-left); the
canvas is a pure scale of that space by app.zoom (pixels per point). Event
coordinates must go through canvasx/canvasy to account for scrolling.

Selection is a list of candidate indices (app.selection). Dragging a selected
field moves the whole selection; the handles sit on the selection's bounding
box and resizing applies the same edge delta to every selected field.
"""

from __future__ import annotations

import tkinter as tk

import fitz
from PIL import ImageTk

from ..preview import COLORS

HANDLE = 4                 # half-size of a resize handle, in pixels
MIN_W, MIN_H = 8.0, 6.0    # minimum field size, in page points

CTRL, SHIFT = 0x4, 0x1     # X11 modifier bits in event.state

_HEX = {t: "#%02x%02x%02x" % c for t, c in COLORS.items()}

_CURSORS = {"nw": "top_left_corner", "n": "top_side", "ne": "top_right_corner",
            "e": "right_side", "se": "bottom_right_corner", "s": "bottom_side",
            "sw": "bottom_left_corner", "w": "left_side"}


class PageCanvas(tk.Canvas):
    """The app provides: zoom, mode(), current_cands(), selection,
    select_single(i), select_add(i), select_toggle(i), select_set(list),
    page_size(), render_page_image(), commit_rects(dict), on_nudge(rect),
    zoom_by(factor)."""

    def __init__(self, master: tk.Widget, app) -> None:
        super().__init__(master, bg="#7a7a7a", highlightthickness=0)
        self.app = app
        self._photo: ImageTk.PhotoImage | None = None
        self._items: dict[int, tuple[int, int]] = {}   # cand index -> (rect, text)
        self._handles: dict[str, int] = {}
        self._drag: tuple | None = None
        self._pending: dict[int, fitz.Rect] | None = None

        self.bind("<ButtonPress-1>", self._on_press)
        self.bind("<B1-Motion>", self._on_motion)
        self.bind("<ButtonRelease-1>", self._on_release)
        self.bind("<Motion>", self._on_hover)
        # X11 delivers wheel events as Button-4/5
        self.bind("<Button-4>", lambda e: self.yview_scroll(-3, "units"))
        self.bind("<Button-5>", lambda e: self.yview_scroll(3, "units"))
        self.bind("<Shift-Button-4>", lambda e: self.xview_scroll(-3, "units"))
        self.bind("<Shift-Button-5>", lambda e: self.xview_scroll(3, "units"))
        self.bind("<Control-Button-4>", lambda e: self.app.zoom_by(1.2))
        self.bind("<Control-Button-5>", lambda e: self.app.zoom_by(1 / 1.2))
        self.bind("<MouseWheel>", self._on_wheel)
        self.bind("<Control-MouseWheel>",
                  lambda e: self.app.zoom_by(1.2 if e.delta > 0 else 1 / 1.2))

    # ------------------------------------------------------------- rendering

    def refresh(self, full: bool = False) -> None:
        if full:
            self.delete("all")
            self._photo = None
            img = self.app.render_page_image()
            if img is None:
                return
            self._photo = ImageTk.PhotoImage(img)  # keep the reference alive
            self.create_image(0, 0, image=self._photo, anchor="nw", tags=("page",))
            self.configure(scrollregion=(0, 0, img.width, img.height))
        self.redraw_overlays()

    def redraw_overlays(self) -> None:
        self.delete("overlay")
        self._items.clear()
        self._handles.clear()
        z = self.app.zoom
        cands = self.app.current_cands()
        selected = set(self.app.selection)
        for i, c in enumerate(cands):
            color = _HEX.get(c.ftype, _HEX["text"])
            x0, y0, x1, y1 = c.rect.x0 * z, c.rect.y0 * z, c.rect.x1 * z, c.rect.y1 * z
            rid = self.create_rectangle(
                x0, y0, x1, y1, outline=color, width=3 if i in selected else 1,
                fill=color, stipple="gray25" if i in selected else "gray12",
                tags=("overlay", f"c{i}"))
            tid = self.create_text(
                x0 + 3, y0 + 1, text=c.name or c.label, anchor="nw", fill=color,
                font=("TkDefaultFont", 8), tags=("overlay", f"c{i}"))
            self._items[i] = (rid, tid)
        bbox = self._selection_bbox({i: cands[i].rect for i in selected
                                     if i < len(cands)})
        if bbox is not None:
            self._draw_handles(bbox)

    @staticmethod
    def _selection_bbox(rects: dict[int, fitz.Rect]) -> fitz.Rect | None:
        bbox = None
        for r in rects.values():
            bbox = fitz.Rect(r) if bbox is None else bbox | r
        return bbox

    def _handle_positions(self, rect: fitz.Rect) -> dict[str, tuple[float, float]]:
        z = self.app.zoom
        x0, y0, x1, y1 = rect.x0 * z, rect.y0 * z, rect.x1 * z, rect.y1 * z
        xc, yc = (x0 + x1) / 2, (y0 + y1) / 2
        return {"nw": (x0, y0), "n": (xc, y0), "ne": (x1, y0), "e": (x1, yc),
                "se": (x1, y1), "s": (xc, y1), "sw": (x0, y1), "w": (x0, yc)}

    def _draw_handles(self, rect: fitz.Rect) -> None:
        for name, (px, py) in self._handle_positions(rect).items():
            self._handles[name] = self.create_rectangle(
                px - HANDLE, py - HANDLE, px + HANDLE, py + HANDLE,
                fill="white", outline="black",
                tags=("overlay", "handle", f"h:{name}"))

    def _preview_rects(self, rects: dict[int, fitz.Rect]) -> None:
        """Live update of the dragged overlays (pixels only, no commit)."""
        z = self.app.zoom
        for i, rect in rects.items():
            if i not in self._items:
                continue
            x0, y0, x1, y1 = rect.x0 * z, rect.y0 * z, rect.x1 * z, rect.y1 * z
            rid, tid = self._items[i]
            self.coords(rid, x0, y0, x1, y1)
            self.coords(tid, x0 + 3, y0 + 1)
        bbox = self._selection_bbox(rects)
        if bbox is not None and self._handles:
            for name, (px, py) in self._handle_positions(bbox).items():
                hid = self._handles.get(name)
                if hid:
                    self.coords(hid, px - HANDLE, py - HANDLE,
                                px + HANDLE, py + HANDLE)

    # ---------------------------------------------------------------- events

    def _on_wheel(self, e: tk.Event) -> None:
        self.yview_scroll(-3 if e.delta > 0 else 3, "units")

    def _hit_handle(self, cx: float, cy: float) -> str | None:
        for item in self.find_overlapping(cx - 1, cy - 1, cx + 1, cy + 1):
            tags = self.gettags(item)
            if "handle" in tags:
                for t in tags:
                    if t.startswith("h:"):
                        return t[2:]
        return None

    def _hit_candidate(self, px: float, py: float) -> int | None:
        cands = self.app.current_cands()
        slack = 2 / self.app.zoom
        for i in range(len(cands) - 1, -1, -1):
            r = cands[i].rect
            if r.x0 - slack <= px <= r.x1 + slack and r.y0 - slack <= py <= r.y1 + slack:
                return i
        return None

    def _selection_bases(self) -> dict[int, fitz.Rect]:
        cands = self.app.current_cands()
        return {i: fitz.Rect(cands[i].rect) for i in self.app.selection
                if i < len(cands)}

    def _on_press(self, e: tk.Event) -> None:
        self.focus_set()
        cx, cy = self.canvasx(e.x), self.canvasy(e.y)
        z = self.app.zoom
        if self.app.mode() == "draw":
            rid = self.create_rectangle(cx, cy, cx, cy, outline="#cc0044",
                                        dash=(4, 3), width=2, tags=("rubber",))
            self._drag = ("nudge", cx, cy, rid)
            return
        handle = self._hit_handle(cx, cy)
        if handle and self.app.selection:
            self._drag = ("resize", handle, self._selection_bases(), cx, cy)
            return
        ctrl, shift = bool(e.state & CTRL), bool(e.state & SHIFT)
        hit = self._hit_candidate(cx / z, cy / z)
        if hit is None:
            # rubber-band selection; plain drag replaces, Ctrl/Shift extends
            rid = self.create_rectangle(cx, cy, cx, cy, outline="#444444",
                                        dash=(2, 2), tags=("rubber",))
            self._drag = ("select", cx, cy, rid, ctrl or shift)
            return
        if ctrl:
            self.app.select_toggle(hit)
            return
        if shift:
            self.app.select_add(hit)
            return
        if hit not in self.app.selection:
            self.app.select_single(hit)
        self._drag = ("move", None, self._selection_bases(), cx, cy)

    def _on_motion(self, e: tk.Event) -> None:
        if not self._drag:
            return
        cx, cy = self.canvasx(e.x), self.canvasy(e.y)
        kind = self._drag[0]
        if kind in ("nudge", "select"):
            _, x0, y0, rid = self._drag[:4]
            self.coords(rid, x0, y0, cx, cy)
            return
        _, corner, bases, sx, sy = self._drag
        if not bases:
            self._drag = None
            return
        z = self.app.zoom
        dx, dy = self.clamp_delta(corner, bases, (cx - sx) / z, (cy - sy) / z)
        self._pending = {i: self._apply_delta(corner, r, dx, dy)
                         for i, r in bases.items()}
        self._preview_rects(self._pending)

    def _on_release(self, e: tk.Event) -> None:
        drag, self._drag = self._drag, None
        if not drag:
            return
        if drag[0] in ("nudge", "select"):
            kind, x0, y0, rid = drag[:4]
            self.delete(rid)
            cx, cy = self.canvasx(e.x), self.canvasy(e.y)
            z = self.app.zoom
            rect = fitz.Rect(min(x0, cx) / z, min(y0, cy) / z,
                             max(x0, cx) / z, max(y0, cy) / z)
            if kind == "nudge":
                if rect.width >= 4 or rect.height >= 4:
                    self.app.on_nudge(rect)
                return
            extend = drag[4]
            if rect.width < 3 and rect.height < 3:  # just a click on empty space
                if not extend:
                    self.app.select_set([])
                return
            hits = [i for i, c in enumerate(self.app.current_cands())
                    if fitz.Rect(c.rect).intersects(rect)]
            if extend:
                hits = sorted(set(self.app.selection) | set(hits))
            self.app.select_set(hits)
            return
        pending, self._pending = self._pending, None
        if pending:
            self.app.commit_rects(pending)

    def cancel_drag(self) -> None:
        if self._drag and self._drag[0] in ("nudge", "select"):
            self.delete(self._drag[3])
        self._drag = None
        self._pending = None
        self.redraw_overlays()

    def _on_hover(self, e: tk.Event) -> None:
        if self._drag:
            return
        if self.app.mode() == "draw":
            self.configure(cursor="crosshair")
            return
        cx, cy = self.canvasx(e.x), self.canvasy(e.y)
        handle = self._hit_handle(cx, cy)
        if handle:
            self.configure(cursor=_CURSORS.get(handle, ""))
            return
        z = self.app.zoom
        hit = self._hit_candidate(cx / z, cy / z)
        self.configure(cursor="fleur" if hit is not None else "")

    # ----------------------------------------------------------------- utils

    @staticmethod
    def _apply_delta(corner: str | None, r: fitz.Rect,
                     dx: float, dy: float) -> fitz.Rect:
        new = fitz.Rect(r)
        if corner is None:  # move
            return new + (dx, dy, dx, dy)
        if "w" in corner:
            new.x0 += dx
        if "e" in corner:
            new.x1 += dx
        if "n" in corner:
            new.y0 += dy
        if "s" in corner:
            new.y1 += dy
        return new

    def clamp_delta(self, corner: str | None, bases: dict[int, fitz.Rect],
                    dx: float, dy: float) -> tuple[float, float]:
        """Restrict a move/resize delta so every field keeps its minimum size
        and stays on the page. corner=None means move."""
        w, h = self.app.page_size()
        lo_x, hi_x = -1e9, 1e9
        lo_y, hi_y = -1e9, 1e9
        for r in bases.values():
            if corner is None:
                lo_x, hi_x = max(lo_x, -r.x0), min(hi_x, w - r.x1)
                lo_y, hi_y = max(lo_y, -r.y0), min(hi_y, h - r.y1)
                continue
            if "e" in corner:
                lo_x, hi_x = max(lo_x, MIN_W - r.width), min(hi_x, w - r.x1)
            elif "w" in corner:
                lo_x, hi_x = max(lo_x, -r.x0), min(hi_x, r.width - MIN_W)
            else:
                dx = 0.0
            if "s" in corner:
                lo_y, hi_y = max(lo_y, MIN_H - r.height), min(hi_y, h - r.y1)
            elif "n" in corner:
                lo_y, hi_y = max(lo_y, -r.y0), min(hi_y, r.height - MIN_H)
            else:
                dy = 0.0
        dx = 0.0 if lo_x > hi_x else max(lo_x, min(hi_x, dx))
        dy = 0.0 if lo_y > hi_y else max(lo_y, min(hi_y, dy))
        return dx, dy

    def clamp(self, rect: fitz.Rect) -> fitz.Rect:
        """Normalize, enforce a minimum size and keep the rect on the page."""
        w, h = self.app.page_size()
        r = fitz.Rect(rect).normalize()
        if r.width < MIN_W:
            r.x1 = r.x0 + MIN_W
        if r.height < MIN_H:
            r.y1 = r.y0 + MIN_H
        dx = -r.x0 if r.x0 < 0 else min(0.0, w - r.x1)
        dy = -r.y0 if r.y0 < 0 else min(0.0, h - r.y1)
        return r + (dx, dy, dx, dy)
