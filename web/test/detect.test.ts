/** Detection on a synthetic Word-style form (no drawn boxes): label rows,
 * underscore lines, a signature block and a typed checkbox glyph. */

import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";

import { extractPage } from "../src/extract";
import { detect } from "../src/heuristics";

function makeForm(): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument();
  const regular = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const bold = doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"));
  const dingbats = doc.addSimpleFont(new mupdf.Font("ZapfDingbats"));
  const line = "_".repeat(30);
  const contents = `
    BT /FB 12 Tf 72 780 Td (Teilnehmer) Tj ET
    BT /F0 12 Tf 72 750 Td (Vorname:) Tj ET
    BT /F0 12 Tf 300 750 Td (Nachname:) Tj ET
    BT /F0 12 Tf 72 721 Td (Adresse:) Tj ET

    BT /F0 12 Tf 72 670 Td (Hinweise:) Tj ET
    BT /F0 12 Tf 72 655 Td (Bitte alle Angaben vollstaendig machen.) Tj ET

    BT /FB 12 Tf 72 620 Td (Vorbereitete Werke) Tj ET
    BT /F0 12 Tf 72 595 Td (${line}) Tj ET
    BT /F0 12 Tf 72 570 Td (${line}) Tj ET

    BT /F0 12 Tf 72 520 Td (Begleitung:) Tj ET
    BT /F0 12 Tf 300 520 Td (Playalong) Tj /FD 10 Tf ( o) Tj ET
    BT /F0 12 Tf 72 478 Td (${line}) Tj ET

    BT /FB 12 Tf 72 440 Td (Unterschriften) Tj ET
    BT /F0 12 Tf 72 425 Td (Teilnehmer:) Tj ET
    BT /F0 12 Tf 300 425 Td (Eltern:) Tj ET
    BT /F0 12 Tf 72 395 Td (${line}) Tj ET
    BT /F0 12 Tf 300 395 Td (${line}) Tj ET
  `;
  const page = doc.addPage([0, 0, 595, 842], 0,
    { Font: { F0: regular, FB: bold, FD: dingbats } }, contents);
  doc.insertPage(-1, page);
  return doc;
}

describe("detect on a form without drawn boxes", () => {
  const doc = makeForm();
  const cands = detect(extractPage(doc.loadPage(0) as mupdf.PDFPage, 0));
  const summary = cands.map((c) => [c.ftype, c.label, c.source]);

  it("finds every fill-in spot with its own label and type", () => {
    expect(summary).toEqual([
      ["text", "Vorname:", "label"],
      ["text", "Nachname:", "label"],
      // a lone label, but one row of a stack of label rows
      ["text", "Adresse:", "label"],
      // underscore runs under a colon-less heading, the second inheriting
      ["text", "Vorbereitete Werke", "underline"],
      ["text", "Vorbereitete Werke", "underline"],
      // ZapfDingbats box glyph, labeled from the text on its left
      ["checkbox", "Playalong", "checkbox"],
      // label 40pt above its line, beyond a typical row gap
      ["text", "Begleitung:", "underline"],
      // signer roles under an "Unterschriften" heading; each line takes the
      // label right above it, and those labels get no field of their own
      ["signature", "Teilnehmer:", "underline"],
      ["signature", "Eltern:", "underline"],
    ]);
  });

  it("sizes a glyph checkbox to the drawn square, not the text cell", () => {
    const box = cands.find((c) => c.ftype === "checkbox")!.rect;
    expect(box.width).toBeGreaterThan(5);
    expect(box.width).toBeLessThan(9);
    expect(Math.abs(box.width - box.height)).toBeLessThan(1.5);
  });
});
