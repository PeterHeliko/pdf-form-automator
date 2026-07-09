"""Extract text spans and normalized line geometry from PDF pages.

Different producers encode ruling lines differently: Word/Acrobat draws thin
filled rectangles, ONLYOFFICE draws real line segments. Everything is
normalized into horizontal/vertical segments so the heuristics only deal with
one representation.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import fitz

fitz.no_recommend_layout()  # silence the pymupdf_layout advertisement

THIN = 2.5  # a rect thinner than this is a line in disguise


@dataclass
class Span:
    text: str
    bbox: fitz.Rect
    size: float
    bold: bool


@dataclass
class TextLine:
    spans: list[Span]
    bbox: fitz.Rect

    @property
    def text(self) -> str:
        return " ".join(s.text for s in self.spans)


@dataclass
class HSeg:
    y: float
    x0: float
    x1: float
    from_text: bool = False  # derived from a '____' character run

    @property
    def length(self) -> float:
        return self.x1 - self.x0


@dataclass
class VSeg:
    x: float
    y0: float
    y1: float

    @property
    def length(self) -> float:
        return self.y1 - self.y0


@dataclass
class Box:
    rect: fitz.Rect


@dataclass
class TableCell:
    rect: fitz.Rect
    text: str
    row: int
    col: int


@dataclass
class Table:
    bbox: fitz.Rect
    rows: list[list[TableCell]]


@dataclass
class PageData:
    number: int
    width: float
    height: float
    lines: list[TextLine] = field(default_factory=list)
    hsegs: list[HSeg] = field(default_factory=list)
    vsegs: list[VSeg] = field(default_factory=list)
    boxes: list[Box] = field(default_factory=list)
    tables: list[Table] = field(default_factory=list)


def _merge_hsegs(segs: list[HSeg]) -> list[HSeg]:
    # segments must actually touch in x, not just start left of the previous
    # end: the sort groups by rounded y, so a segment from a *different*
    # y-group can otherwise be swallowed by a distant one
    merged: list[HSeg] = []
    for s in sorted(segs, key=lambda s: (round(s.y), s.x0)):
        if merged and abs(merged[-1].y - s.y) <= 1.5 \
                and s.x0 <= merged[-1].x1 + 2 and s.x1 >= merged[-1].x0 - 2:
            merged[-1].x0 = min(merged[-1].x0, s.x0)
            merged[-1].x1 = max(merged[-1].x1, s.x1)
            merged[-1].from_text = merged[-1].from_text or s.from_text
        else:
            merged.append(HSeg(s.y, s.x0, s.x1, s.from_text))
    return [s for s in merged if s.length >= 4]


def _merge_vsegs(segs: list[VSeg]) -> list[VSeg]:
    # same touch requirement as _merge_hsegs: Word draws table borders as
    # per-row 0.5pt rect pieces, and a piece 200pt above an unrelated vseg at
    # a near-identical x must start a new segment, not vanish into it
    merged: list[VSeg] = []
    for s in sorted(segs, key=lambda s: (round(s.x), s.y0)):
        if merged and abs(merged[-1].x - s.x) <= 1.5 \
                and s.y0 <= merged[-1].y1 + 2 and s.y1 >= merged[-1].y0 - 2:
            merged[-1].y0 = min(merged[-1].y0, s.y0)
            merged[-1].y1 = max(merged[-1].y1, s.y1)
        else:
            merged.append(VSeg(s.x, s.y0, s.y1))
    return [s for s in merged if s.length >= 4]


def _segments(page: fitz.Page) -> tuple[list[HSeg], list[VSeg]]:
    hsegs: list[HSeg] = []
    vsegs: list[VSeg] = []
    page_area = abs(page.rect)

    def add_rect_border(r: fitz.Rect) -> None:
        hsegs.append(HSeg(r.y0, r.x0, r.x1))
        hsegs.append(HSeg(r.y1, r.x0, r.x1))
        vsegs.append(VSeg(r.x0, r.y0, r.y1))
        vsegs.append(VSeg(r.x1, r.y0, r.y1))

    for drawing in page.get_drawings():
        for item in drawing["items"]:
            kind = item[0]
            if kind == "l":
                p1, p2 = item[1], item[2]
                if abs(p1.y - p2.y) <= 1.5 and abs(p2.x - p1.x) > 2:
                    x0, x1 = sorted((p1.x, p2.x))
                    hsegs.append(HSeg((p1.y + p2.y) / 2, x0, x1))
                elif abs(p1.x - p2.x) <= 1.5 and abs(p2.y - p1.y) > 2:
                    y0, y1 = sorted((p1.y, p2.y))
                    vsegs.append(VSeg((p1.x + p2.x) / 2, y0, y1))
            elif kind == "re":
                r = fitz.Rect(item[1]).normalize()
                if abs(r) > page_area * 0.9:
                    continue  # page background fill
                if r.height <= THIN and r.width > 2:
                    hsegs.append(HSeg((r.y0 + r.y1) / 2, r.x0, r.x1))
                elif r.width <= THIN and r.height > 2:
                    vsegs.append(VSeg((r.x0 + r.x1) / 2, r.y0, r.y1))
                elif "s" in drawing["type"]:
                    add_rect_border(r)
            elif kind == "qu":
                r = item[1].rect
                if abs(r) < page_area * 0.9 and r.width > 2 and r.height > 2:
                    add_rect_border(r)

    return _merge_hsegs(hsegs), _merge_vsegs(vsegs)


def _tight_bbox(span: dict) -> fitz.Rect:
    """Glyph-tight bbox. Some producers (e.g. ONLYOFFICE) report font-bbox
    ascenders of 1.5x the size, inflating span boxes far beyond the glyphs;
    clamp the vertical extent around the baseline."""
    r = fitz.Rect(span["bbox"])
    baseline = span["origin"][1]
    size = span["size"]
    asc = min(span.get("ascender", 0.85), 0.9)
    desc = max(span.get("descender", -0.25), -0.3)
    return fitz.Rect(r.x0, max(r.y0, baseline - asc * size),
                     r.x1, min(r.y1, baseline - desc * size))


def _split_underscores(span: dict) -> tuple[list[dict], list[HSeg]]:
    """Split a rawdict span into text parts and underscore-run underlines.
    Forms often draw fill-in lines as literal '____' character runs."""
    parts: list[dict] = []
    segs: list[HSeg] = []
    chars = span["chars"]
    i = 0
    while i < len(chars):
        if chars[i]["c"] == "_":
            j = i
            while j < len(chars) and chars[j]["c"] == "_":
                j += 1
            if j - i >= 3:
                x0 = chars[i]["bbox"][0]
                x1 = chars[j - 1]["bbox"][2]
                segs.append(HSeg(chars[i]["origin"][1], x0, x1, from_text=True))
            i = j
        else:
            j = i
            while j < len(chars) and chars[j]["c"] != "_":
                j += 1
            text = "".join(c["c"] for c in chars[i:j])
            if text.strip():
                # leading/trailing spaces widen the bbox over neighbouring
                # geometry (e.g. a checkbox square left of the text)
                inked = [c for c in chars[i:j] if c["c"] != " "]
                bbox = fitz.Rect(inked[0]["bbox"])
                for c in inked[1:]:
                    bbox |= fitz.Rect(c["bbox"])
                part = dict(span)
                part["bbox"] = tuple(bbox)
                part["text"] = text
                part["origin"] = inked[0]["origin"]
                parts.append(part)
            i = j
    return parts, segs


def _text_lines(page: fitz.Page) -> tuple[list[TextLine], list[HSeg]]:
    lines: list[TextLine] = []
    underscore_segs: list[HSeg] = []
    for block in page.get_text("rawdict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            spans: list[Span] = []
            for raw in line["spans"]:
                parts, segs = _split_underscores(raw)
                underscore_segs.extend(segs)
                for s in parts:
                    spans.append(Span(
                        text=s["text"].strip(),
                        bbox=_tight_bbox(s),
                        size=s["size"],
                        bold=bool(s["flags"] & 2**4),
                    ))
            if spans:
                bbox = fitz.Rect(spans[0].bbox)
                for s in spans[1:]:
                    bbox |= s.bbox
                lines.append(TextLine(spans=spans, bbox=bbox))
    lines.sort(key=lambda l: (l.bbox.y0, l.bbox.x0))
    return _merge_baselines(lines), underscore_segs


def _merge_baselines(lines: list[TextLine]) -> list[TextLine]:
    """Join text lines sharing a baseline (producers often split them into
    separate blocks, e.g. 'Datum:' and 'Unterschrift:' on one visual line)."""
    merged: list[TextLine] = []
    for line in lines:
        target = None
        for m in merged:
            overlap = min(m.bbox.y1, line.bbox.y1) - max(m.bbox.y0, line.bbox.y0)
            if overlap > 0.5 * min(m.bbox.height, line.bbox.height):
                target = m
                break
        if target:
            target.spans = sorted(target.spans + line.spans, key=lambda s: s.bbox.x0)
            target.bbox |= line.bbox
        else:
            merged.append(line)
    merged.sort(key=lambda l: (l.bbox.y0, l.bbox.x0))
    return merged


def _find_boxes(hsegs: list[HSeg], vsegs: list[VSeg]) -> list[Box]:
    """Closed rectangles formed by the segments, keeping only atomic cells
    (no other segment crossing their interior)."""
    TOL = 3.0
    boxes: list[fitz.Rect] = []
    for top in hsegs:
        for bot in hsegs:
            if bot.y - top.y < 4:
                continue
            x0 = max(top.x0, bot.x0)
            x1 = min(top.x1, bot.x1)
            if x1 - x0 < 4:
                continue
            lefts = [
                v for v in vsegs
                if abs(v.x - x0) <= TOL and v.y0 <= top.y + TOL and v.y1 >= bot.y - TOL
            ]
            rights = [
                v for v in vsegs
                if abs(v.x - x1) <= TOL and v.y0 <= top.y + TOL and v.y1 >= bot.y - TOL
            ]
            if lefts and rights:
                boxes.append(fitz.Rect(x0, top.y, x1, bot.y))

    def atomic(r: fitz.Rect) -> bool:
        for h in hsegs:
            if r.y0 + TOL < h.y < r.y1 - TOL and h.x0 < r.x1 - TOL and h.x1 > r.x0 + TOL:
                return False
        for v in vsegs:
            if r.x0 + TOL < v.x < r.x1 - TOL and v.y0 < r.y1 - TOL and v.y1 > r.y0 + TOL:
                return False
        return True

    return [Box(r) for r in boxes if atomic(r)]


def _find_tables(page: fitz.Page) -> list[Table]:
    tables: list[Table] = []
    finder = page.find_tables(strategy="lines_strict")
    for t in finder.tables:
        content = t.extract()
        rows: list[list[TableCell]] = []
        for ri, row_cells in enumerate(t.rows):
            row: list[TableCell] = []
            for ci, cell in enumerate(row_cells.cells):
                if cell is None:
                    continue
                text = (content[ri][ci] or "").strip() if ci < len(content[ri]) else ""
                row.append(TableCell(rect=fitz.Rect(cell), text=text, row=ri, col=ci))
            rows.append(row)
        tables.append(Table(bbox=fitz.Rect(t.bbox), rows=rows))
    return tables


def extract_page(page: fitz.Page) -> PageData:
    hsegs, vsegs = _segments(page)
    lines, underscore_segs = _text_lines(page)
    hsegs = _merge_hsegs(hsegs + underscore_segs)
    data = PageData(
        number=page.number,
        width=page.rect.width,
        height=page.rect.height,
        lines=lines,
        hsegs=hsegs,
        vsegs=vsegs,
        tables=_find_tables(page),
    )
    data.boxes = _find_boxes(hsegs, vsegs)
    return data
