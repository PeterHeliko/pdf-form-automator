/** The PDF worker: owns the mupdf wasm instance and the open document.
 *
 * Port of the Tk app's background detection thread (gui/app.py
 * _detect_worker + queue): the main thread sends typed requests, results
 * come back tagged with a runId so superseded detections are dropped.
 * mupdf objects never leave this worker — PageData/Candidate travel as
 * plain JSON.
 */

self.addEventListener("unhandledrejection", (e) => {
  console.error("pdf.worker unhandled rejection:", (e as PromiseRejectionEvent).reason);
});
self.addEventListener("error", (e) => {
  console.error("pdf.worker error:", (e as ErrorEvent).message);
});

import * as mupdf from "mupdf";

import { extractPage } from "../extract";
import { detect } from "../heuristics";
import { writeFields } from "../writer";
import { candidateFromJSON, candidateToJSON, pageDataToJSON } from "../types";
import type { CandidateJSON } from "../types";
import type { WorkerRequest, WorkerResponse } from "./protocol";

let originalBytes: Uint8Array | null = null;
let doc: mupdf.PDFDocument | null = null;
let currentRun = 0;

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function openDoc(id: number, buffer: ArrayBuffer): void {
  try {
    const bytes = new Uint8Array(buffer);
    const newDoc = mupdf.Document.openDocument(bytes.slice(), "application/pdf") as mupdf.PDFDocument;
    currentRun++; // implicitly cancels a running detection
    if (doc) doc.destroy();
    doc = newDoc;
    originalBytes = bytes;
    const pageCount = doc.countPages();
    const sizes: [number, number][] = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      const b = page.getBounds();
      sizes.push([b[2] - b[0], b[3] - b[1]]);
      page.destroy();
    }
    post({ type: "opened", id, pageCount, sizes });
  } catch (e) {
    post({ type: "open-error", id, message: String(e instanceof Error ? e.message : e) });
  }
}

async function runDetect(runId: number): Promise<void> {
  currentRun = runId;
  if (!doc) return;
  try {
    const pageCount = doc.countPages();
    for (let pno = 0; pno < pageCount; pno++) {
      post({ type: "status", runId, text: `Detecting fields – page ${pno + 1}/${pageCount} …` });
      // yield to the event loop so a superseding open/detect can interleave
      await new Promise((r) => setTimeout(r, 0));
      if (currentRun !== runId || !doc) return;
      const page = doc.loadPage(pno);
      try {
        const data = extractPage(page, pno);
        const cands = detect(data);
        post({
          type: "page", runId, page: pno,
          data: pageDataToJSON(data),
          candidates: cands.map(candidateToJSON),
        });
      } finally {
        page.destroy();
      }
    }
    post({ type: "detect-done", runId });
  } catch (e) {
    post({ type: "detect-error", runId, message: String(e instanceof Error ? e.message : e) });
  }
}

function render(id: number, pno: number, scale: number): void {
  if (!doc) return;
  const page = doc.loadPage(pno);
  try {
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      const png = pix.asPNG();
      const buffer = png.buffer as ArrayBuffer;
      post({ type: "rendered", id, page: pno, png: buffer, width: pix.getWidth(), height: pix.getHeight() }, [buffer]);
    } finally {
      pix.destroy();
    }
  } finally {
    page.destroy();
  }
}

function thumbnail(id: number, pno: number, width: number): void {
  if (!doc) return;
  const page = doc.loadPage(pno);
  try {
    const b = page.getBounds();
    const scale = width / Math.max(1, b[2] - b[0]);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      const png = pix.asPNG();
      const buffer = png.buffer as ArrayBuffer;
      post({ type: "thumbnail", id, page: pno, png: buffer }, [buffer]);
    } finally {
      pix.destroy();
    }
  } finally {
    page.destroy();
  }
}

function exportPdf(id: number, candidatesJSON: CandidateJSON[]): void {
  if (!originalBytes) {
    post({ type: "export-error", id, message: "no document open" });
    return;
  }
  try {
    const candidates = candidatesJSON.map(candidateFromJSON);
    const bytes = writeFields(originalBytes, candidates);
    const buffer = bytes.buffer as ArrayBuffer;
    post({ type: "exported", id, bytes: buffer }, [buffer]);
  } catch (e) {
    post({ type: "export-error", id, message: String(e instanceof Error ? e.message : e) });
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case "open":
      openDoc(msg.id, msg.buffer);
      break;
    case "detect":
      void runDetect(msg.runId);
      break;
    case "render":
      render(msg.id, msg.page, msg.scale);
      break;
    case "thumbnail":
      thumbnail(msg.id, msg.page, msg.width);
      break;
    case "export":
      exportPdf(msg.id, msg.candidates);
      break;
  }
};

post({ type: "ready" });
