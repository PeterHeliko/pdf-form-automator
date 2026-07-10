import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractPage } from "../src/extract";

const [pdfPath, pageNoStr] = process.argv.slice(2);
const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), "application/pdf") as mupdf.PDFDocument;
const pno = Number(pageNoStr ?? 0);
const page = doc.loadPage(pno);
const data = extractPage(page, pno);
for (const [ti, t] of data.tables.entries()) {
  console.log(`table ${ti} bbox [${t.bbox.x0.toFixed(0)} ${t.bbox.y0.toFixed(0)} ${t.bbox.x1.toFixed(0)} ${t.bbox.y1.toFixed(0)}]`);
  for (const row of t.rows) {
    console.log(" ", row.map((c) => `r${c.row}c${c.col}[${c.rect.width.toFixed(0)}x${c.rect.height.toFixed(0)}]=${JSON.stringify(c.text.slice(0, 38))}`).join("  "));
  }
}
const pix = page.toPixmap(mupdf.Matrix.scale(1.4, 1.4), mupdf.ColorSpace.DeviceRGB, false, true);
fs.writeFileSync(process.env.OUT ?? "/tmp/page.png", pix.asPNG());
