"""Render preview PNGs with the placed fields drawn as colored overlays."""

from __future__ import annotations

from pathlib import Path

import fitz
from PIL import Image, ImageDraw

from .heuristics import Candidate

COLORS = {
    "text": (30, 90, 220),
    "date": (230, 140, 0),
    "checkbox": (0, 150, 60),
    "signature": (210, 30, 30),
}
ZOOM = 100 / 72


def render_previews(doc: fitz.Document, candidates: list[Candidate],
                    out_stem: Path) -> list[Path]:
    paths: list[Path] = []
    by_page: dict[int, list[Candidate]] = {}
    for c in candidates:
        by_page.setdefault(c.page, []).append(c)

    for page_no, cands in sorted(by_page.items()):
        page = doc[page_no]
        pix = page.get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM))
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("RGBA")
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        for c in cands:
            color = COLORS.get(c.ftype, COLORS["text"])
            box = [c.rect.x0 * ZOOM, c.rect.y0 * ZOOM, c.rect.x1 * ZOOM, c.rect.y1 * ZOOM]
            draw.rectangle(box, fill=color + (50,), outline=color + (255,), width=2)
            draw.text((box[0] + 3, box[1] + 1), c.name, fill=color + (255,))
        img = Image.alpha_composite(img, overlay).convert("RGB")
        path = out_stem.with_name(f"{out_stem.name}.fields.p{page_no + 1}.png")
        img.save(path)
        paths.append(path)
    return paths
