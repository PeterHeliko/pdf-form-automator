/** Port of writer.py + fields.strip_existing_fields: write AcroForm widgets
 * into a copy of the PDF.
 *
 * Instead of PyMuPDF's widget API (text/checkbox) plus a pikepdf pass for
 * signature fields, everything is created as raw PDF objects with mupdf.js —
 * the same approach writer.py used for /Sig fields, extended to all types.
 * Appearance streams are synthesized afterwards by MuPDF's own form layer
 * (page.update()), with NeedAppearances set as a belt-and-braces fallback
 * for viewers that prefer to regenerate them.
 */

import * as mupdf from "mupdf";

import { Rect } from "./geometry";
import type { Candidate } from "./types";

/** fitz page coords (origin top-left) -> PDF user space (origin bottom-left),
 * the equivalent of `rect * ~page.transformation_matrix`. */
function pageToPdfRect(page: mupdf.PDFPage, r: Rect): [number, number, number, number] {
  const inv = mupdf.Matrix.invert(page.getTransform());
  const t = mupdf.Rect.transform([r.x0, r.y0, r.x1, r.y1], inv);
  return [
    Math.min(t[0], t[2]), Math.min(t[1], t[3]),
    Math.max(t[0], t[2]), Math.max(t[1], t[3]),
  ];
}

/** Delete all existing form fields. Returns how many widgets were removed. */
export function stripExistingFields(doc: mupdf.PDFDocument): number {
  let removed = 0;
  const pageCount = doc.countPages();
  for (let i = 0; i < pageCount; i++) {
    const pobj = doc.findPage(i);
    const annots = pobj.get("Annots");
    if (annots.isNull() || !annots.isArray()) continue;
    const keep = doc.newArray();
    for (let j = 0; j < annots.length; j++) {
      const a = annots.get(j);
      const subtype = a.get("Subtype");
      if (subtype.isName() && subtype.asName() === "Widget") {
        removed++;
      } else {
        keep.push(a);
      }
    }
    pobj.put("Annots", keep);
  }
  const acro = doc.getTrailer().get("Root", "AcroForm");
  if (!acro.isNull()) {
    acro.put("Fields", doc.newArray());
    acro.delete("SigFlags");
  }
  return removed;
}

/** Make sure Root/AcroForm exists with fonts and defaults; returns it. */
function ensureAcroForm(doc: mupdf.PDFDocument): mupdf.PDFObject {
  const root = doc.getTrailer().get("Root");
  let acro = root.get("AcroForm");
  if (acro.isNull() || !acro.resolve().isDictionary()) {
    acro = doc.addObject(doc.newDictionary());
    root.put("AcroForm", acro);
  }
  if (acro.get("Fields").isNull()) acro.put("Fields", doc.newArray());
  acro.put("DA", doc.newString("/Helv 0 Tf 0 g"));

  let dr = acro.get("DR");
  if (dr.isNull() || !dr.resolve().isDictionary()) {
    dr = doc.newDictionary();
    acro.put("DR", dr);
  }
  let fonts = dr.get("Font");
  if (fonts.isNull() || !fonts.resolve().isDictionary()) {
    fonts = doc.newDictionary();
    dr.put("Font", fonts);
  }
  if (fonts.get("Helv").isNull()) {
    const helv = new mupdf.Font("Helvetica");
    fonts.put("Helv", doc.addSimpleFont(helv));
    helv.destroy();
  }
  if (fonts.get("ZaDb").isNull()) {
    const zadb = new mupdf.Font("ZapfDingbats");
    fonts.put("ZaDb", doc.addSimpleFont(zadb));
    zadb.destroy();
  }
  return acro;
}

function newRectArray(doc: mupdf.PDFDocument, rect: [number, number, number, number], decimals?: number): mupdf.PDFObject {
  const arr = doc.newArray();
  for (const v of rect) {
    arr.push(decimals === undefined ? v : Math.round(v * 10 ** decimals) / 10 ** decimals);
  }
  return arr;
}

/** Add all candidate fields to a fresh copy of the document; returns the
 * final PDF bytes. Candidates must already carry unique names. */
export function writeFields(originalBytes: Uint8Array, candidates: Candidate[]): Uint8Array {
  const doc = mupdf.Document.openDocument(
    originalBytes.slice(), "application/pdf",
  ) as mupdf.PDFDocument;
  try {
    stripExistingFields(doc);
    const acro = ensureAcroForm(doc);
    const fields = acro.get("Fields");

    const pages = new Map<number, { pobj: mupdf.PDFObject; page: mupdf.PDFPage; annots: mupdf.PDFObject }>();
    const getPage = (pno: number) => {
      let entry = pages.get(pno);
      if (!entry) {
        const pobj = doc.findPage(pno);
        let annots = pobj.get("Annots");
        if (annots.isNull() || !annots.isArray()) {
          annots = doc.newArray();
          pobj.put("Annots", annots);
        }
        pages.set(pno, (entry = { pobj, page: doc.loadPage(pno), annots }));
      }
      return entry;
    };

    const addWidget = (cand: Candidate, dict: mupdf.PDFObject): void => {
      const { pobj, annots } = getPage(cand.page);
      dict.put("Type", doc.newName("Annot"));
      dict.put("Subtype", doc.newName("Widget"));
      dict.put("T", doc.newString(cand.name));
      dict.put("F", 4); // print
      dict.put("P", pobj);
      const ref = doc.addObject(dict);
      annots.push(ref);
      fields.push(ref);
    };

    // text and checkbox widgets first, then signatures — same field order
    // as the Python writer (PyMuPDF pass, then pikepdf pass)
    const sigs: Candidate[] = [];
    for (const cand of candidates) {
      if (cand.ftype === "signature") {
        sigs.push(cand);
        continue;
      }
      const { page } = getPage(cand.page);
      const dict = doc.newDictionary();
      dict.put("Rect", newRectArray(doc, pageToPdfRect(page, cand.rect)));
      if (cand.ftype === "checkbox") {
        dict.put("FT", doc.newName("Btn"));
        dict.put("V", doc.newName("Off"));
        dict.put("AS", doc.newName("Off"));
        dict.put("DA", doc.newString("/ZaDb 0 Tf 0 g"));
        const mk = doc.newDictionary();
        mk.put("CA", doc.newString("4")); // ZapfDingbats check mark
        dict.put("MK", mk);
      } else {
        dict.put("FT", doc.newName("Tx"));
        const size = cand.multiline ? 10.0 : Math.min(10.0, Math.max(7.0, cand.rect.height - 6));
        dict.put("DA", doc.newString(`/Helv ${size} Tf 0 g`));
        if (cand.multiline) dict.put("Ff", 4096); // PDF_TX_FIELD_IS_MULTILINE
      }
      addWidget(cand, dict);
    }

    for (const cand of sigs) {
      const { page } = getPage(cand.page);
      const dict = doc.newDictionary();
      dict.put("FT", doc.newName("Sig"));
      dict.put("Rect", newRectArray(doc, pageToPdfRect(page, cand.rect), 2));
      addWidget(cand, dict);
    }
    if (sigs.length) {
      const flags = acro.get("SigFlags");
      acro.put("SigFlags", (flags.isNumber() ? flags.asNumber() : 0) | 1); // SignaturesExist
    }

    // let MuPDF's form layer synthesize appearance streams for the new
    // widgets: setRect marks each annotation dirty, update() then builds
    // the streams (incl. checkbox Off/Yes states)
    for (const pno of pages.keys()) {
      const page = doc.loadPage(pno);
      for (const w of page.getWidgets()) {
        w.setRect(w.getRect());
        w.update();
      }
      page.destroy();
    }
    for (const { page } of pages.values()) page.destroy();

    const buf = doc.saveToBuffer("garbage=3,compress");
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}
