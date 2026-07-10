import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { collectDrawings, extractPage } from "../src/extract";

const [pdfPath, pageNoStr] = process.argv.slice(2);
const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), "application/pdf") as mupdf.PDFDocument;
const pno = Number(pageNoStr ?? 0);
const page = doc.loadPage(pno);
page.update();
const list = page.toDisplayList(true);
const drawings = collectDrawings(list);
console.log("drawings:", drawings.length);
for (const d of drawings) {
  console.log(` ${d.type} rect[${d.rect.x0.toFixed(1)} ${d.rect.y0.toFixed(1)} ${d.rect.x1.toFixed(1)} ${d.rect.y1.toFixed(1)}] w=${d.width} closed=${d.closePath} items=${d.items.map((i) => i.kind).join(",")}`);
}
const data = extractPage(page, pno);
console.log("hsegs:", data.hsegs.map((s) => `y${s.y.toFixed(1)} x${s.x0.toFixed(0)}..${s.x1.toFixed(0)}${s.fromText ? " (text)" : ""}`).join("\n  "));
console.log("vsegs:", data.vsegs.map((s) => `x${s.x.toFixed(1)} y${s.y0.toFixed(0)}..${s.y1.toFixed(0)}`).join("\n  "));
