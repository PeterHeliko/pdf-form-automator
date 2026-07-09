"""Dump the Python pipeline's intermediate results as JSON parity fixtures.

Run from the repo root with the project venv:
    .venv/bin/python web/scripts/dump.py

Writes web/test/expected/<stem>.json for every sample PDF in the repo root,
containing per-page PageData (lines, segments, boxes, tables) and the final
candidate list. The web port's tests compare their output against these.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import fitz  # noqa: E402

from pdf_form_automator.extract import extract_page  # noqa: E402
from pdf_form_automator.fields import assign_names  # noqa: E402
from pdf_form_automator.heuristics import detect  # noqa: E402


def r4(v: float) -> float:
    return round(v, 4)


def rect(r: fitz.Rect) -> list[float]:
    return [r4(r.x0), r4(r.y0), r4(r.x1), r4(r.y1)]


def dump_pdf(path: Path) -> dict:
    doc = fitz.open(path)
    pages = []
    all_cands = []
    for page in doc:
        data = extract_page(page)
        cands = detect(data)
        all_cands.extend(cands)
        pages.append({
            "number": data.number,
            "width": r4(data.width),
            "height": r4(data.height),
            "lines": [{
                "bbox": rect(l.bbox),
                "spans": [{"text": s.text, "bbox": rect(s.bbox),
                           "size": r4(s.size), "bold": s.bold} for s in l.spans],
            } for l in data.lines],
            "hsegs": [{"y": r4(s.y), "x0": r4(s.x0), "x1": r4(s.x1),
                       "from_text": s.from_text} for s in data.hsegs],
            "vsegs": [{"x": r4(s.x), "y0": r4(s.y0), "y1": r4(s.y1)}
                      for s in data.vsegs],
            "boxes": [rect(b.rect) for b in data.boxes],
            "tables": [{
                "bbox": rect(t.bbox),
                "rows": [[{"rect": rect(c.rect), "text": c.text,
                           "row": c.row, "col": c.col} for c in row]
                         for row in t.rows],
            } for t in data.tables],
            "candidates": [],  # filled below, after assign_names
        })
    assign_names(all_cands)
    for c in all_cands:
        pages[c.page]["candidates"].append({
            "rect": rect(c.rect), "ftype": c.ftype, "label": c.label,
            "multiline": c.multiline, "source": c.source, "name": c.name,
        })
    doc.close()
    return {"file": path.name, "pages": pages}


def main() -> None:
    out_dir = ROOT / "web" / "test" / "expected"
    out_dir.mkdir(parents=True, exist_ok=True)
    samples = sorted(p for p in ROOT.glob("*.pdf")
                     if not p.name.lower().endswith(".fillable.pdf"))
    samples += sorted(p for p in ROOT.glob("*.PDF")
                      if not p.name.lower().endswith(".fillable.pdf"))
    if not samples:
        sys.exit("no sample PDFs found in repo root")
    for path in samples:
        data = dump_pdf(path)
        out = out_dir / (path.stem + ".json")
        out.write_text(json.dumps(data, ensure_ascii=False, indent=1))
        n = sum(len(p["candidates"]) for p in data["pages"])
        print(f"{path.name}: {len(data['pages'])} page(s), {n} candidate(s) -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
