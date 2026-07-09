"""Write AcroForm widgets into the PDF.

Text and checkbox widgets are created with PyMuPDF. Signature fields are not
supported by PyMuPDF's widget API, so they are added afterwards with pikepdf
as raw /FT /Sig widget annotations.
"""

from __future__ import annotations

import io

import fitz
import pikepdf

from .heuristics import Candidate


def _add_widget(page: fitz.Page, cand: Candidate) -> None:
    w = fitz.Widget()
    w.field_name = cand.name
    w.rect = cand.rect
    if cand.ftype == "checkbox":
        w.field_type = fitz.PDF_WIDGET_TYPE_CHECKBOX
        w.field_value = False
    else:
        w.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        w.text_fontsize = min(10.0, max(7.0, cand.rect.height - 6)) if not cand.multiline else 10.0
        if cand.multiline:
            w.field_flags = fitz.PDF_TX_FIELD_IS_MULTILINE
    w.border_width = 0
    page.add_widget(w)


def _add_signature_fields(pdf_bytes: bytes, sigs: list[Candidate],
                          pdf_rects: list[pikepdf.Array | list[float]]) -> bytes:
    """pikepdf pass: add empty /Sig widget annotations (rects in PDF space)."""
    out = io.BytesIO()
    with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
        if "/AcroForm" not in pdf.Root:
            pdf.Root.AcroForm = pdf.make_indirect(
                pikepdf.Dictionary(Fields=pikepdf.Array())
            )
        acro = pdf.Root.AcroForm
        if "/Fields" not in acro:
            acro.Fields = pikepdf.Array()
        for cand, rect in zip(sigs, pdf_rects):
            page = pdf.pages[cand.page]
            annot = pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name.Annot,
                Subtype=pikepdf.Name.Widget,
                FT=pikepdf.Name.Sig,
                T=pikepdf.String(cand.name),
                F=4,  # print
                Rect=pikepdf.Array([round(v, 2) for v in rect]),
                P=page.obj,
            ))
            if "/Annots" not in page:
                page.Annots = pikepdf.Array()
            page.Annots.append(annot)
            acro.Fields.append(annot)
        acro.SigFlags = int(acro.get("/SigFlags", 0)) | 1  # SignaturesExist
        pdf.save(out)
    return out.getvalue()


def write_fields(doc: fitz.Document, candidates: list[Candidate]) -> bytes:
    """Add all candidate fields to the document, return final PDF bytes."""
    sigs = [c for c in candidates if c.ftype == "signature"]
    pdf_rects: list[list[float]] = []
    for cand in sigs:
        page = doc[cand.page]
        # fitz page coords (origin top-left) -> PDF user space (origin bottom-left)
        r = cand.rect * ~page.transformation_matrix
        pdf_rects.append([min(r.x0, r.x1), min(r.y0, r.y1),
                          max(r.x0, r.x1), max(r.y0, r.y1)])

    for cand in candidates:
        if cand.ftype != "signature":
            _add_widget(doc[cand.page], cand)

    data = doc.tobytes(deflate=True, garbage=3)
    if sigs:
        data = _add_signature_fields(data, sigs, pdf_rects)
    return data
