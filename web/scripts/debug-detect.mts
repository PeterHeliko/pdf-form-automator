/* Dump detection results + geometry summary for a PDF page. */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractPage } from "../src/extract";
import { detect } from "../src/heuristics";
import { lineText } from "../src/types";

const [pdfPath, pageNoStr] = process.argv.slice(2);
const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), "application/pdf") as mupdf.PDFDocument;
const pages = pageNoStr !== undefined ? [Number(pageNoStr)] : Array.from({length: doc.countPages()}, (_, i) => i);
for (const pno of pages) {
  const page = doc.loadPage(pno);
  const data = extractPage(page, pno);
  const cands = detect(data);
  console.log(`=== page ${pno + 1}: ${data.lines.length} lines, ${data.hsegs.length} hsegs, ${data.vsegs.length} vsegs, ${data.boxes.length} boxes, ${data.tables.length} tables -> ${cands.length} candidates`);
  console.log("--- boxes:");
  for (const b of data.boxes) {
    const r = b.rect;
    const inside = data.lines.filter((l) => l.bbox.intersects(r)).map((l) => lineText(l).slice(0, 40));
    console.log(`  [${r.x0.toFixed(0)} ${r.y0.toFixed(0)} ${r.x1.toFixed(0)} ${r.y1.toFixed(0)}] ${r.width.toFixed(0)}x${r.height.toFixed(0)} text:${JSON.stringify(inside)}`);
  }
  console.log("--- tables:", data.tables.map((t) => `${t.rows.length}rows bbox[${t.bbox.x0.toFixed(0)} ${t.bbox.y0.toFixed(0)} ${t.bbox.x1.toFixed(0)} ${t.bbox.y1.toFixed(0)}]`));
  console.log("--- candidates:");
  for (const c of cands) {
    const r = c.rect;
    console.log(`  ${c.ftype.padEnd(9)} [${r.x0.toFixed(0)} ${r.y0.toFixed(0)} ${r.x1.toFixed(0)} ${r.y1.toFixed(0)}] ${c.source} label=${JSON.stringify(c.label.slice(0, 50))}`);
  }
  page.destroy();
}
