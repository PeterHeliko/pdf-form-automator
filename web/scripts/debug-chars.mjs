import * as fs from "node:fs";
import * as mupdf from "mupdf";

const [pdfPath, pageNoStr, needle] = process.argv.slice(2);
const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), "application/pdf");
const page = doc.loadPage(Number(pageNoStr));
const st = page.toStructuredText("preserve-ligatures,preserve-whitespace,mediabox-clip");

let lineNo = -1;
let chars = [];
let text = "";
st.walk({
  beginLine() { lineNo++; chars = []; text = ""; },
  endLine() {
    if (text.includes(needle)) {
      console.log(`line ${lineNo}: ${JSON.stringify(text)}`);
      for (const c of chars) console.log(c);
    }
  },
  onChar(c, origin, font, size, quad, color) {
    text += c;
    chars.push(
      `${JSON.stringify(c)} font=${font.getName()} ptr=${font.pointer} bold=${font.isBold()} size=${size} color=${JSON.stringify(color)} oy=${origin[1].toFixed(2)} qy=${quad[1].toFixed(2)}..${quad[5].toFixed(2)}`,
    );
  },
});
