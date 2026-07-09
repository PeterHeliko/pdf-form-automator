"""Optional verification pass using a local Ollama vision model.

The heuristic candidates are drawn as numbered boxes on a page render and the
model is asked to confirm/reject/re-type/rename them and to report obviously
missed input areas. The model's answers are advisory: new boxes are only
accepted when they snap to real page geometry, since VLM coordinates alone are
too imprecise for field placement.
"""

from __future__ import annotations

import base64
import io
import json
import re
import sys
import urllib.error
import urllib.request

import fitz
from PIL import Image, ImageDraw

from .extract import PageData
from .heuristics import Candidate, classify, slugify

OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "qwen2.5vl"
RENDER_DPI = 150
TIMEOUT = 180

PROMPT = """You see a scanned form page. Numbered colored boxes mark places where a \
program plans to insert fillable PDF form fields (text inputs, checkboxes, \
date fields, signature fields).

Candidates (id, planned type, detected label):
{candidates}

Review them and answer with ONLY a JSON object, no other text:
{{
  "fields": [{{"id": 1, "keep": true, "type": "text|checkbox|date|signature", "name": "short_field_name"}}, ...],
  "missing": [{{"type": "text", "name": "short_field_name", "box": [x0, y0, x1, y1]}}, ...]
}}

Rules:
- One entry per candidate id. Set "keep": false only if the box clearly marks \
something that is NOT meant to be filled in by hand (decoration, body text, \
already-printed content).
- "type": "signature" only where a handwritten signature belongs (labels like \
Unterschrift/Signature), "date" where a date belongs (Datum/Date).
- "name": concise field name in the form's language, letters/digits/underscore.
- "missing": empty areas clearly meant to be filled in that have NO numbered \
box. Coordinates normalized 0-1000 relative to page width/height. Usually empty.
"""


def _warn(msg: str) -> None:
    print(f"  [ai] {msg}", file=sys.stderr)


def ollama_available(url: str = OLLAMA_URL) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/api/tags", timeout=3):
            return True
    except (urllib.error.URLError, OSError):
        return False


def _render_with_boxes(page: fitz.Page, cands: list[Candidate]) -> bytes:
    zoom = RENDER_DPI / 72
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    draw = ImageDraw.Draw(img)
    for i, c in enumerate(cands, 1):
        box = [v * zoom for v in (c.rect.x0, c.rect.y0, c.rect.x1, c.rect.y1)]
        draw.rectangle(box, outline=(220, 0, 0), width=3)
        draw.text((box[0] + 4, box[1] + 2), str(i), fill=(220, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _query(model: str, prompt: str, image_png: bytes, url: str) -> str:
    body = json.dumps({
        "model": model,
        "prompt": prompt,
        "images": [base64.b64encode(image_png).decode()],
        "stream": False,
        "options": {"temperature": 0},
    }).encode()
    req = urllib.request.Request(f"{url}/api/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read())["response"]


def _parse_json(text: str) -> dict | None:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def _snap_to_geometry(rect: fitz.Rect, data: PageData) -> fitz.Rect | None:
    """Accept a model-proposed box only if page geometry supports it."""
    TOL = 15.0
    for box in data.boxes:
        r = box.rect
        inter = fitz.Rect(rect).intersect(r)
        if not inter.is_empty and abs(inter) > 0.5 * abs(rect):
            return fitz.Rect(r.x0 + 3, r.y0 + 3, r.x1 - 3, r.y1 - 3)
    for seg in data.hsegs:
        if abs(seg.y - rect.y1) <= TOL and seg.x0 <= rect.x1 and seg.x1 >= rect.x0:
            x0, x1 = max(seg.x0, rect.x0), min(seg.x1, rect.x1)
            if x1 - x0 >= 30:
                return fitz.Rect(x0, seg.y - 16, x1, seg.y + 1)
    return None


def verify_page(page: fitz.Page, data: PageData, cands: list[Candidate],
                model: str = DEFAULT_MODEL, url: str = OLLAMA_URL,
                render: bytes | None = None) -> list[Candidate]:
    """Run the VLM over one page's candidates; returns the revised list.

    `render` may be a PNG pre-made with _render_with_boxes over the non-table
    candidates; callers that must serialize PyMuPDF access (the GUI) render
    under their lock and let the network wait happen outside it.
    """
    # table cells are systematic (grid geometry + header naming); reviewing
    # them adds nothing and hundreds of numbered boxes overwhelm the model
    table_cands = [c for c in cands if c.source == "table"]
    cands = [c for c in cands if c.source != "table"]
    if not cands:
        return table_cands
    if len(cands) > 40:
        _warn(f"page {page.number + 1}: {len(cands)} candidates, too many for "
              "a useful vision pass; keeping heuristic result")
        return table_cands + cands
    listing = "\n".join(
        f"{i}: type={c.ftype}, label={c.label!r}" for i, c in enumerate(cands, 1)
    )
    try:
        reply = _query(model, PROMPT.format(candidates=listing),
                       render or _render_with_boxes(page, cands), url)
    except (urllib.error.URLError, OSError, KeyError, json.JSONDecodeError) as e:
        _warn(f"Ollama request failed ({e}); keeping heuristic result for page {page.number + 1}")
        return table_cands + cands
    parsed = _parse_json(reply)
    if parsed is None:
        _warn(f"unparseable model reply on page {page.number + 1}; keeping heuristic result")
        return table_cands + cands

    result: list[Candidate] = list(table_cands)
    verdicts = {f.get("id"): f for f in parsed.get("fields", []) if isinstance(f, dict)}
    for i, cand in enumerate(cands, 1):
        v = verdicts.get(i)
        if v is None:
            result.append(cand)
            continue
        # only weakly-evidenced candidates may be dropped: geometry plus a
        # ':'-label (or a checkbox square) is more reliable than the model;
        # bare-label gaps have no geometry at all, so their colon doesn't count
        droppable = cand.ftype != "checkbox" and (
            cand.source == "label" or not cand.label.rstrip().endswith(":"))
        if v.get("keep") is False and droppable:
            _warn(f"page {page.number + 1}: dropped candidate {i} ({cand.label!r})")
            continue
        vtype = v.get("type")
        if vtype in ("text", "checkbox", "date", "signature") and vtype != cand.ftype:
            # geometry beats the model for checkboxes; trust it otherwise
            if "checkbox" not in (vtype, cand.ftype):
                cand.ftype = vtype
        if v.get("name"):
            cand.name = slugify(str(v["name"]))
        result.append(cand)

    for miss in parsed.get("missing", []):
        box = miss.get("box") if isinstance(miss, dict) else None
        if not (isinstance(box, list) and len(box) == 4):
            continue
        rect = fitz.Rect(
            box[0] / 1000 * data.width, box[1] / 1000 * data.height,
            box[2] / 1000 * data.width, box[3] / 1000 * data.height,
        )
        if any(not fitz.Rect(rect).intersect(c.rect).is_empty for c in result):
            continue
        snapped = _snap_to_geometry(rect, data)
        if snapped is None:
            continue
        ftype = miss.get("type") if miss.get("type") in ("text", "checkbox", "date", "signature") else "text"
        label = str(miss.get("name", ""))
        result.append(Candidate(page=data.number, rect=snapped,
                                ftype=ftype if ftype != "text" else classify(label) if label else "text",
                                label=label, source="ai", name=slugify(label) if label else ""))
        _warn(f"page {page.number + 1}: model added field {label!r}")
    return result
