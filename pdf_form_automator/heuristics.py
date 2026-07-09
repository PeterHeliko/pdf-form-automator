"""Turn extracted page geometry into form-field candidates."""

from __future__ import annotations

import re
from dataclasses import dataclass

import fitz

from .extract import Box, HSeg, PageData, Span, TextLine

SIGNATURE_RE = re.compile(r"unterschrift|unterzeichn|signatur|signature|visum", re.I)
DATE_RE = re.compile(r"\bdatum\b|geburtsdatum|\bdate\b", re.I)

MIN_INLINE_GAP = 40.0   # min width for a field right of a label on the same line
MIN_UNDERLINE_GAP = 30.0
MIN_VGAP = 12.0         # min height of an empty area below a label inside a box
FIELD_HEIGHT = 16.0     # default height for underline fields
CHECKBOX_MIN, CHECKBOX_MAX = 6.0, 18.0


@dataclass
class Candidate:
    page: int
    rect: fitz.Rect
    ftype: str  # text | checkbox | signature | date
    label: str
    multiline: bool = False
    source: str = "heuristic"
    name: str = ""


def classify(label: str) -> str:
    if SIGNATURE_RE.search(label):
        return "signature"
    if DATE_RE.search(label):
        return "date"
    return "text"


def slugify(label: str, max_len: int = 40) -> str:
    s = label.strip().rstrip(":").strip()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("Ä", "Ae"),
                 ("Ö", "Oe"), ("Ü", "Ue"), ("ß", "ss")):
        s = s.replace(a, b)
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")
    return s[:max_len].strip("_") or "Feld"


def _label_spans(line: TextLine) -> list[Span]:
    """Spans that end a label, i.e. end with a colon."""
    return [s for s in line.spans if s.text.rstrip().endswith(":")]


def _run_label(spans: list[Span], end_index: int) -> str:
    """Text of the contiguous span run ending at spans[end_index] (bold and
    regular parts of one label are separate spans; a real gap breaks the run)."""
    start = end_index
    while start > 0 and spans[start].bbox.x0 - spans[start - 1].bbox.x1 < 8:
        start -= 1
    return " ".join(s.text for s in spans[start:end_index + 1]).strip()


def _line_gap_fields(line: TextLine, right_edge: float, page: int) -> list[Candidate]:
    """Fields in the horizontal gaps after each ':'-label on a text line."""
    out: list[Candidate] = []
    spans = sorted(line.spans, key=lambda s: s.bbox.x0)
    for i, span in enumerate(spans):
        if not span.text.rstrip().endswith(":"):
            continue
        gap_end = spans[i + 1].bbox.x0 - 4 if i + 1 < len(spans) else right_edge
        gap_start = span.bbox.x1 + 4
        if gap_end - gap_start < MIN_INLINE_GAP:
            continue
        label = _run_label(spans, i)
        rect = fitz.Rect(gap_start, span.bbox.y0 - 2, gap_end, span.bbox.y1 + 2)
        out.append(Candidate(page, rect, classify(label), label))
    return out


def _is_header_row(row) -> bool:
    """Row 0 is only a header if most of its non-first cells carry text;
    grids are often split so that the first data row lands in row 0."""
    rest = [c for c in row if c.col > 0]
    if not rest:
        return False
    filled = sum(1 for c in rest if c.text)
    return filled >= max(1, len(rest) / 2)


def _table_headers(table, all_tables) -> tuple[dict[int, str], bool]:
    """Column headers for a table; falls back to a matching table directly
    above (grids are frequently split into a header table + a data table)."""
    grid = table.rows
    if grid and _is_header_row(grid[0]):
        return {c.col: c.text.replace("\n", " ") for c in grid[0] if c.text}, True
    for other in all_tables:
        if other is table or not other.rows:
            continue
        same_cols = len(other.rows[0]) and abs(other.bbox.x0 - table.bbox.x0) < 10 \
            and abs(other.bbox.x1 - table.bbox.x1) < 10
        if same_cols and 0 <= table.bbox.y0 - other.bbox.y1 < 25:
            headers: dict[int, str] = {}
            for row in other.rows:
                for c in row:
                    if c.text and c.col not in headers:
                        headers[c.col] = c.text.replace("\n", " ")
            return headers, False
    return {}, False


def _table_candidates(data: PageData) -> list[Candidate]:
    out: list[Candidate] = []
    for table in data.tables:
        grid = table.rows
        if len(grid) < 2:
            continue
        headers, own_header = _table_headers(table, data.tables)
        for row in grid[1:] if own_header else grid:
            if row and all(c.text for c in row):
                continue  # fully filled row: an example / pre-filled row
            row_label = row[0].text.replace("\n", " ") if row and row[0].col == 0 else ""
            for cell in row:
                # a col-0 cell with text is a row header; an empty one is data
                if cell.text:
                    continue
                header = headers.get(cell.col, "")
                if header:
                    label = f"{header} {row_label}".strip()
                else:
                    label = f"{row_label} {cell.col}".strip() or f"Zeile{cell.row}_Spalte{cell.col}"
                rect = fitz.Rect(cell.rect) + (2, 2, -2, -2)
                if rect.is_empty or rect.width < 10 or rect.height < 8:
                    continue
                out.append(Candidate(data.number, rect, "text", label, source="table"))
    return out


def _checkbox_candidates(data: PageData) -> list[Candidate]:
    out: list[Candidate] = []
    for box in data.boxes:
        r = box.rect
        if not (CHECKBOX_MIN <= r.width <= CHECKBOX_MAX
                and CHECKBOX_MIN <= r.height <= CHECKBOX_MAX
                and abs(r.width - r.height) <= 4):
            continue
        if any(line.bbox.intersects(r) for line in data.lines):
            continue
        label = ""
        best = 1e9
        for line in data.lines:
            if line.bbox.y0 < r.y1 and line.bbox.y1 > r.y0 and line.bbox.x0 >= r.x1 - 2:
                d = line.bbox.x0 - r.x1
                if d < best:
                    best, label = d, line.text
        out.append(Candidate(data.number, fitz.Rect(r), "checkbox",
                             " ".join(label.split()[:5]), source="checkbox"))
    return out


def _is_checkbox_box(r: fitz.Rect) -> bool:
    return (CHECKBOX_MIN <= r.width <= CHECKBOX_MAX
            and CHECKBOX_MIN <= r.height <= CHECKBOX_MAX)


def _box_candidates(data: PageData) -> list[Candidate]:
    """Fields inside drawn boxes: gaps right of labels and empty areas below."""
    out: list[Candidate] = []
    table_areas = [t.bbox for t in data.tables]
    for box in data.boxes:
        r = box.rect
        if _is_checkbox_box(r):
            continue
        if any(r.intersects(t + (-2, -2, 2, 2)) for t in table_areas):
            continue
        lines = [l for l in data.lines if l.bbox.intersects(r)
                 and l.bbox.intersect(r).width > l.bbox.width * 0.5]
        lines.sort(key=lambda l: l.bbox.y0)
        inner = fitz.Rect(r) + (3, 3, -3, -3)
        if not lines:
            # completely empty box: one multiline field
            if inner.width >= MIN_INLINE_GAP and inner.height >= MIN_VGAP:
                out.append(Candidate(data.number, inner, "text", "",
                                     multiline=inner.height > 30, source="box"))
            continue
        for i, line in enumerate(lines):
            labels = _label_spans(line)
            below_top = line.bbox.y1 + 2
            below_bottom = lines[i + 1].bbox.y0 - 2 if i + 1 < len(lines) else r.y1 - 3
            vgap = below_bottom - below_top
            sorted_spans = sorted(line.spans, key=lambda s: s.bbox.x0)
            line_ends_with_label = bool(labels) and sorted_spans[-1].text.rstrip().endswith(":")
            if line_ends_with_label and vgap >= MIN_VGAP:
                label = _run_label(sorted_spans, len(sorted_spans) - 1)
                rect = fitz.Rect(r.x0 + 4, below_top, r.x1 - 4, below_bottom)
                out.append(Candidate(data.number, rect, classify(label),
                                     label, multiline=rect.height > 30, source="box"))
            elif labels:
                for cand in _line_gap_fields(line, r.x1 - 4, data.number):
                    cand.rect = cand.rect & inner  # stay inside the box
                    cand.source = "box"
                    if not cand.rect.is_empty and cand.rect.width >= MIN_INLINE_GAP:
                        _grow_gap_field(cand, lines, i, inner)
                        out.append(cand)
    return out


def _grow_gap_field(cand: Candidate, lines: list[TextLine], i: int,
                    inner: fitz.Rect) -> None:
    """Gap fields are sized from the label text; grow them into the empty
    band below, up to the next line, so row-style boxes ('Name: |      |')
    get usefully tall fields instead of label-height slivers. Downward only:
    the band between two lines must belong to exactly one field, or the
    fields of consecutive labels overlap each other."""
    bottom = lines[i + 1].bbox.y0 - 2 if i + 1 < len(lines) else inner.y1
    cand.rect.y1 = max(cand.rect.y1, min(bottom, cand.rect.y1 + 10))


def _seg_in_boxes(seg: HSeg, boxes: list[Box], tables: list[fitz.Rect]) -> bool:
    TOL = 3.0
    for box in boxes:
        r = box.rect
        if (abs(seg.y - r.y0) <= TOL or abs(seg.y - r.y1) <= TOL) \
                and seg.x0 >= r.x0 - TOL and seg.x1 <= r.x1 + TOL:
            return True
    return any(t.y0 - TOL <= seg.y <= t.y1 + TOL
               and seg.x0 >= t.x0 - TOL and seg.x1 <= t.x1 + TOL for t in tables)


def _underline_candidates(data: PageData) -> list[Candidate]:
    """Fill-in lines: horizontal segments that are not box/table edges."""
    out: list[Candidate] = []
    table_areas = [t.bbox for t in data.tables]
    TOL = 3.0
    for seg in data.hsegs:
        if seg.length < MIN_UNDERLINE_GAP:
            continue
        # '____' character runs are always fill-in lines, never borders, even
        # when a drawn box outline coincides with them
        if not seg.from_text:
            if _seg_in_boxes(seg, data.boxes, table_areas):
                continue
            # a segment whose end connects to a vertical is a border
            if any(abs(v.x - x) <= TOL and v.y0 <= seg.y + TOL and v.y1 >= seg.y - TOL
                   and v.length > 6 for v in data.vsegs for x in (seg.x0, seg.x1)):
                continue

        # spans sitting on (or immediately left of) the line divide it into
        # fillable stretches
        on_line = sorted(
            (s for line in data.lines for s in line.spans
             if s.bbox.x1 > seg.x0 - 30 and s.bbox.x0 < seg.x1
             and seg.y - 16 <= s.bbox.y1 <= seg.y + 4),
            key=lambda s: s.bbox.x0,
        )
        stretches: list[tuple[float, float, str]] = []
        cursor = seg.x0
        label = ""
        for i, span in enumerate(on_line):
            if span.bbox.x0 - cursor >= MIN_UNDERLINE_GAP:
                stretches.append((cursor, span.bbox.x0 - 4, label))
            cursor = max(cursor, span.bbox.x1 + 4)
            label = _run_label(on_line, i)
        if seg.x1 - cursor >= MIN_UNDERLINE_GAP:
            stretches.append((cursor, seg.x1, label))
        if not on_line:
            stretches = [(seg.x0, seg.x1, "")]

        for x0, x1, lab in stretches:
            # a same-line label counts if it ends with ':' or is short and
            # label-like ('Unterschrift ___'); long prose next to a line is
            # usually decoration (underlined titles, footers)
            ok = lab.rstrip().endswith(":") or (lab and len(lab) <= 40 and len(lab.split()) <= 5)
            if not ok:
                # fall back to the text line just above, colon required there
                above = [l for l in data.lines
                         if 0 < seg.y - l.bbox.y1 < 35 and l.bbox.x1 > x0 and l.bbox.x0 < x1]
                lab = above[-1].text if above else ""
                ok = lab.rstrip().endswith(":")
            if not ok:
                # unlabeled continuation line: inherit from the accepted field
                # directly above (stacked '____' writing lines)
                for prev in reversed(out):
                    x_overlap = min(prev.rect.x1, x1) - max(prev.rect.x0, x0)
                    dy = seg.y - prev.rect.y1
                    if 0 < dy <= 30 and x_overlap > 0.8 * (x1 - x0):
                        lab, ok = prev.label, True
                        break
            if not ok:
                continue
            rect = fitz.Rect(x0, seg.y - FIELD_HEIGHT, x1, seg.y + 1)
            out.append(Candidate(data.number, rect, classify(lab), lab, source="underline"))
    return out


def _trim_rect(r: fitz.Rect, k: fitz.Rect) -> fitz.Rect | None:
    """Largest edge-trimmed sub-rect of r that no longer intersects k;
    None when every option is too small to be a usable field."""
    options = []
    if k.y1 < r.y1:
        options.append(fitz.Rect(r.x0, k.y1, r.x1, r.y1))  # keep lower part
    if k.y0 > r.y0:
        options.append(fitz.Rect(r.x0, r.y0, r.x1, k.y0))  # keep upper part
    if k.x1 < r.x1:
        options.append(fitz.Rect(k.x1, r.y0, r.x1, r.y1))  # keep right part
    if k.x0 > r.x0:
        options.append(fitz.Rect(r.x0, r.y0, k.x0, r.y1))  # keep left part
    options = [o for o in options if o.width >= 8 and o.height >= 6]
    return max(options, key=abs, default=None)


def _dedupe(candidates: list[Candidate]) -> list[Candidate]:
    """Enforce that detection never emits overlapping fields: candidates that
    mostly cover an earlier (higher-priority) one are dropped, slight
    overlaps are trimmed away, untrimmable ones are dropped too."""
    kept: list[Candidate] = []
    for cand in candidates:
        rect = fitz.Rect(cand.rect)
        drop = False
        for k in kept:
            inter = fitz.Rect(rect).intersect(k.rect)
            if inter.is_empty or abs(inter) <= 0.01:
                continue
            if abs(inter) > 0.5 * min(abs(rect), abs(k.rect)):
                drop = True
                break
            trimmed = _trim_rect(rect, k.rect)
            if trimmed is None:
                drop = True
                break
            rect = trimmed
        if not drop:
            cand.rect = rect
            kept.append(cand)
    kept.sort(key=lambda c: (c.rect.y0, c.rect.x0))
    return kept


def _bare_label_candidates(data: PageData) -> list[Candidate]:
    """Free-standing 'Label:' lines with empty space to the right and no
    write-on line at all: the blank area itself is the field (letter-style
    endings like 'Ort, Datum:        Unterschrift:')."""
    out: list[Candidate] = []
    if not data.hsegs and not data.boxes and not data.tables:
        # a page without any drawn geometry is a letter, not a form; its
        # 'Label:' lines are sign-below blocks (printed names/signatures)
        return out
    avoid = [b.rect for b in data.boxes] + [t.bbox for t in data.tables]
    right_edge = max([s.x1 for s in data.hsegs] + [b.rect.x1 for b in data.boxes]
                     + [l.bbox.x1 for l in data.lines] + [0.0])
    for line in data.lines:
        # two or more labels sharing the line is the letter-closing pattern;
        # a lone 'Label:' with white space is usually a sign-below block
        # (printed name/signature underneath), not a fill-in gap
        if len(_label_spans(line)) < 2:
            continue
        if any(line.bbox.intersects(a) for a in avoid):
            continue
        for cand in _line_gap_fields(line, right_edge, data.number):
            # only short, label-like runs: long prose ending in ':' is a
            # sentence ('Rücksendung bitte bis ... per Mail an:')
            if len(cand.label) > 40 or len(cand.label.split()) > 5:
                continue
            # a fill-in line at or just below the gap owns this label
            if any(seg.x1 > cand.rect.x0 and seg.x0 < cand.rect.x1
                   and line.bbox.y0 - 2 <= seg.y <= line.bbox.y1 + 25
                   for seg in data.hsegs):
                continue
            if any(cand.rect.intersects(a) for a in avoid):
                continue
            cand.source = "label"
            out.append(cand)
    return out


def detect(data: PageData) -> list[Candidate]:
    return _dedupe(
        _checkbox_candidates(data)
        + _table_candidates(data)
        + _box_candidates(data)
        + _underline_candidates(data)
        + _bare_label_candidates(data)
    )


def _nearby_label(data: PageData, rect: fitz.Rect) -> str:
    """Best-effort label for a user-placed field: the span run ending left of
    the rect on the same line, else the text line just above."""
    best_d, best = 80.0, ""
    for line in data.lines:
        spans = sorted(line.spans, key=lambda s: s.bbox.x0)
        for i, s in enumerate(spans):
            # require real vertical overlap: a span in the adjacent table row
            # touches the rect border by a hair and must not win
            overlap = min(s.bbox.y1, rect.y1) - max(s.bbox.y0, rect.y0)
            if overlap >= 2.0 and s.bbox.x1 <= rect.x0 + 2:
                d = rect.x0 - s.bbox.x1
                if d < best_d:
                    best_d, best = d, _run_label(spans, i)
    if best:
        return best
    above = [l for l in data.lines
             if 0 < rect.y0 - l.bbox.y1 < 35 and l.bbox.x1 > rect.x0 and l.bbox.x0 < rect.x1]
    return above[-1].text if above else ""


def detect_in_region(data: PageData, region: fitz.Rect) -> list[Candidate]:
    """Detection restricted to a user-drawn region, with relaxed thresholds.

    The user asserted a field exists here, so the evidence gating of detect()
    (colon labels, border/text vetoes) is dropped and sizes are relaxed.
    Returns an empty list when nothing snaps to page geometry; the caller then
    places a field covering the region exactly as drawn.
    """
    region = fitz.Rect(region).normalize()
    out: list[Candidate] = []

    # checkbox-sized squares (relaxed size range, no empty-interior veto)
    for box in data.boxes:
        r = box.rect
        if not region.intersects(r):
            continue
        if 5.0 <= r.width <= 22.0 and 5.0 <= r.height <= 22.0 \
                and abs(r.width - r.height) <= 5:
            label, best = "", 1e9
            for line in data.lines:
                if line.bbox.y0 < r.y1 and line.bbox.y1 > r.y0 and line.bbox.x0 >= r.x1 - 2:
                    d = line.bbox.x0 - r.x1
                    if d < best:
                        best, label = d, line.text
            out.append(Candidate(data.number, fitz.Rect(r), "checkbox",
                                 " ".join(label.split()[:5]), source="nudge"))
    if out:
        return _dedupe(out)

    # a drawn box that mostly covers the region — but only one of comparable
    # size; snapping a small drag onto a huge layout box places fields
    # nowhere near where the user pointed
    for box in data.boxes:
        inter = fitz.Rect(region).intersect(box.rect)
        if inter.is_empty or abs(inter) <= 0.5 * abs(region) \
                or abs(box.rect) > 4 * abs(region):
            continue
        r = box.rect
        inner = fitz.Rect(r) + (3, 3, -3, -3)
        # labelled box: the field is the gap right of the label, not the
        # whole interior (same as _box_candidates)
        gap_cands: list[Candidate] = []
        box_lines = sorted((l for l in data.lines if l.bbox.intersects(r)),
                           key=lambda l: l.bbox.y0)
        for li, line in enumerate(box_lines):
            if not _label_spans(line):
                continue
            for cand in _line_gap_fields(line, r.x1 - 4, data.number):
                cand.rect = cand.rect & inner
                cand.source = "nudge"
                if not cand.rect.is_empty and cand.rect.intersects(region):
                    _grow_gap_field(cand, box_lines, li, inner)
                    gap_cands.append(cand)
        if gap_cands:
            return _dedupe(gap_cands)
        label = _nearby_label(data, r)
        return [Candidate(data.number, inner, classify(label), label,
                          multiline=inner.height > 30, source="nudge")]

    # fill-in lines: inside a user region a box or table border is a
    # legitimate write-on line, so no border rejection here
    # the write-on line must lie inside the drawn region or just below its
    # bottom edge; a line above the region top would put the field body
    # (which extends upward from the line) outside what the user drew
    hits: list[tuple[float, float, float]] = []  # (seg.y, x0, x1)
    for seg in data.hsegs:
        if not (region.y0 <= seg.y <= region.y1 + 8):
            continue
        x0, x1 = max(seg.x0, region.x0), min(seg.x1, region.x1)
        if x1 - x0 < 12:
            continue
        on_line = sorted(
            (s for line in data.lines for s in line.spans
             if s.bbox.x1 > x0 and s.bbox.x0 < x1
             and seg.y - 16 <= s.bbox.y1 <= seg.y + 4),
            key=lambda s: s.bbox.x0,
        )
        cursor = x0
        stretches: list[tuple[float, float]] = []
        for span in on_line:
            if span.bbox.x0 - cursor >= 12:
                stretches.append((cursor, span.bbox.x0 - 4))
            cursor = max(cursor, span.bbox.x1 + 4)
        if x1 - cursor >= 12:
            stretches.append((cursor, x1))
        hits.extend((seg.y, sx0, sx1) for sx0, sx1 in stretches)

    if hits:
        # one drawn rectangle means one row of fields: keep only the
        # bottom-most line (a tall drag catching several stacked lines
        # would otherwise produce a field on each)
        ymax = max(h[0] for h in hits)
        for y, sx0, sx1 in hits:
            if ymax - y > 2:
                continue
            rect = fitz.Rect(sx0, y - FIELD_HEIGHT, sx1, y + 1)
            label = _nearby_label(data, rect)
            out.append(Candidate(data.number, rect, classify(label), label,
                                 source="nudge"))
    return _dedupe(out)
