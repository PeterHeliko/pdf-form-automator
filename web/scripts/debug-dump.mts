/* Dump the TS pipeline's PageData for one page as JSON (for fixture diffs).
   Usage: npx vite-node scripts/debug-dump.mts -- <pdf> <page> [what] */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

import { extractPage } from "../src/extract";
import { detect } from "../src/heuristics";
import { pageDataToJSON, candidateToJSON } from "../src/types";

const [pdfPath, pageNoStr, what] = process.argv.slice(2);
const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), "application/pdf") as mupdf.PDFDocument;
const pno = Number(pageNoStr);
const page = doc.loadPage(pno);
const data = extractPage(page, pno);
const json: any = pageDataToJSON(data);
json.candidates = detect(data).map(candidateToJSON);
console.log(JSON.stringify(what ? json[what] : json, null, 1));
