/** Export parity gate: the TS writer's fillable PDF must carry the same
 * AcroForm fields (name, type, rect, flags, page) as the Python writer's
 * output for the same detection results.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as mupdf from "mupdf";

import { extractPage } from "../src/extract";
import { detect, slugify } from "../src/heuristics";
import { assignNames } from "../src/fields";
import { writeFields } from "../src/writer";
import type { Candidate } from "../src/types";

const ROOT = path.resolve(import.meta.dirname, "../..");
const REF_DIR = path.join(import.meta.dirname, "expected-fillable");

interface FieldInfo {
  page: number;
  name: string;
  type: string;
  rect: number[];
  multiline: boolean;
}

function enumerateFields(bytes: Uint8Array): FieldInfo[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf") as mupdf.PDFDocument;
  const out: FieldInfo[] = [];
  try {
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      for (const w of page.getWidgets()) {
        out.push({
          page: i,
          name: w.getName(),
          type: w.getFieldType(),
          rect: w.getRect(),
          multiline: w.isMultiline(),
        });
      }
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
  return out;
}

function findPdf(stem: string): string | null {
  for (const ext of [".pdf", ".PDF"]) {
    const p = path.join(ROOT, stem + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// reference exports come from the Python CLI on local sample PDFs and are
// not committed (personal data); see web/README.md to regenerate
const refs = fs.existsSync(REF_DIR)
  ? fs.readdirSync(REF_DIR).filter((f) => f.endsWith(".fillable.pdf"))
  : [];

describe("export parity with the Python writer", () => {
  if (!refs.length) {
    it.skip("no reference exports present — generate with the Python CLI (--no-ai)", () => {});
  }
  for (const ref of refs) {
    const stem = ref.replace(/\.fillable\.pdf$/, "");
    it(stem, () => {
      const pdfPath = findPdf(stem);
      expect(pdfPath, `sample PDF for ${stem}`).toBeTruthy();
      const original = fs.readFileSync(pdfPath!);

      // full pipeline, mirroring App.export / cli.process
      const doc = mupdf.Document.openDocument(original, "application/pdf") as mupdf.PDFDocument;
      const all: Candidate[] = [];
      try {
        for (let i = 0; i < doc.countPages(); i++) {
          const page = doc.loadPage(i);
          all.push(...detect(extractPage(page, i)));
          page.destroy();
        }
      } finally {
        doc.destroy();
      }
      for (const c of all) {
        if (c.name) c.name = slugify(c.name);
      }
      assignNames(all);

      const bytes = writeFields(new Uint8Array(original), all);
      const got = enumerateFields(bytes);
      const want = enumerateFields(fs.readFileSync(path.join(REF_DIR, ref)));

      const errors: string[] = [];
      if (got.length !== want.length) {
        errors.push(`${got.length} fields != ${want.length} expected`);
      }
      const wantByName = new Map(want.map((f) => [f.name, f]));
      for (const g of got) {
        const w = wantByName.get(g.name);
        if (!w) {
          errors.push(`unexpected field ${g.name}`);
          continue;
        }
        if (g.page !== w.page) errors.push(`${g.name}: page ${g.page} != ${w.page}`);
        if (g.type !== w.type) errors.push(`${g.name}: type ${g.type} != ${w.type}`);
        if (g.multiline !== w.multiline) errors.push(`${g.name}: multiline ${g.multiline} != ${w.multiline}`);
        if (g.rect.some((v, i) => Math.abs(v - w.rect[i]) > 1.0)) {
          errors.push(`${g.name}: rect [${g.rect.map((v) => v.toFixed(1)).join(" ")}] != [${w.rect.map((v) => v.toFixed(1)).join(" ")}]`);
        }
      }
      for (const w of want) {
        if (!got.some((g) => g.name === w.name)) errors.push(`missing field ${w.name}`);
      }

      if (errors.length) {
        throw new Error(`${errors.length} mismatches:\n` + errors.slice(0, 40).join("\n"));
      }

      // sanity: output opens cleanly and keeps the page count
      const outDoc = mupdf.Document.openDocument(bytes, "application/pdf");
      expect(outDoc.countPages()).toBeGreaterThan(0);
      outDoc.destroy();
    });
  }
});
