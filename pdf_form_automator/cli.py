"""Command line interface: flat PDF in, fillable PDF (+ preview PNGs) out."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import fitz

from . import ai
from .extract import extract_page
from .fields import assign_names, strip_existing_fields
from .heuristics import detect
from .preview import render_previews
from .writer import write_fields


def process(path: Path, out: Path | None, *, use_ai: bool, model: str,
            keep_existing: bool, preview: bool, debug: bool) -> Path:
    doc = fitz.open(path)
    out = out or path.with_name(path.stem + ".fillable.pdf")

    candidates = []
    for page in doc:
        data = extract_page(page)
        page_cands = detect(data)
        if debug:
            print(f"  page {page.number + 1}: {len(data.hsegs)} h-segments, "
                  f"{len(data.vsegs)} v-segments, {len(data.boxes)} boxes, "
                  f"{len(data.tables)} tables -> {len(page_cands)} candidates")
        if use_ai and page_cands:
            page_cands = ai.verify_page(page, data, page_cands, model=model)
        candidates.extend(page_cands)

    assign_names(candidates)
    if debug:
        for c in candidates:
            r = c.rect
            print(f"    {c.ftype:9s} p{c.page + 1} [{r.x0:5.0f} {r.y0:5.0f} "
                  f"{r.x1:5.0f} {r.y1:5.0f}] {c.name}  ({c.source}, label={c.label!r})")

    if not keep_existing:
        removed = strip_existing_fields(doc)
        if removed:
            print(f"  removed {removed} existing field(s)")
    if not candidates:
        print("  no field candidates found")

    data_bytes = write_fields(doc, candidates)
    out.write_bytes(data_bytes)

    counts: dict[str, int] = {}
    for c in candidates:
        counts[c.ftype] = counts.get(c.ftype, 0) + 1
    summary = ", ".join(f"{n} {t}" for t, n in sorted(counts.items()))
    print(f"  -> {out.name}  ({summary})" if counts else f"  -> {out.name}")

    if preview and candidates:
        final = fitz.open(stream=data_bytes, filetype="pdf")
        for p in render_previews(final, candidates, out.with_suffix("")):
            print(f"  -> {p.name}")
        final.close()
    doc.close()
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pdf-form-automator",
        description="Detect fill-in areas in flat PDFs and add AcroForm fields "
                    "(text, checkbox, date, signature). Runs fully locally; "
                    "optionally uses a local Ollama vision model.",
    )
    parser.add_argument("inputs", nargs="+", type=Path, metavar="PDF")
    parser.add_argument("-o", "--output", type=Path,
                        help="output path (single input only); default: <input>.fillable.pdf")
    parser.add_argument("--no-ai", action="store_true",
                        help="skip the Ollama vision verification pass")
    parser.add_argument("--model", default=ai.DEFAULT_MODEL,
                        help=f"Ollama model to use (default: {ai.DEFAULT_MODEL})")
    parser.add_argument("--keep-existing", action="store_true",
                        help="keep form fields already present in the PDF")
    parser.add_argument("--no-preview", action="store_true",
                        help="do not write preview overlay PNGs")
    parser.add_argument("--debug", action="store_true",
                        help="print detected geometry and candidates")
    args = parser.parse_args(argv)

    if args.output and len(args.inputs) > 1:
        parser.error("-o/--output only works with a single input PDF")

    use_ai = not args.no_ai
    if use_ai and not ai.ollama_available():
        print("Ollama not reachable at localhost:11434 - continuing without AI pass",
              file=sys.stderr)
        use_ai = False

    status = 0
    for path in args.inputs:
        if not path.is_file():
            print(f"{path}: not found", file=sys.stderr)
            status = 1
            continue
        print(f"{path.name}:")
        try:
            process(path, args.output, use_ai=use_ai, model=args.model,
                    keep_existing=args.keep_existing,
                    preview=not args.no_preview, debug=args.debug)
        except Exception as e:  # keep going with remaining inputs
            print(f"{path}: failed: {e}", file=sys.stderr)
            status = 1
    return status
