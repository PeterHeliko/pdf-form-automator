/** Typed messages between the main thread and the PDF worker. */

import type { CandidateJSON, PageDataJSON } from "../types";

export type WorkerRequest =
  | { type: "open"; id: number; buffer: ArrayBuffer }
  | { type: "detect"; runId: number }
  | { type: "render"; id: number; page: number; scale: number }
  | { type: "thumbnail"; id: number; page: number; width: number }
  | { type: "export"; id: number; candidates: CandidateJSON[] };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "opened"; id: number; pageCount: number; sizes: [number, number][] }
  | { type: "open-error"; id: number; message: string }
  | { type: "status"; runId: number; text: string }
  | { type: "page"; runId: number; page: number; data: PageDataJSON; candidates: CandidateJSON[] }
  | { type: "detect-done"; runId: number }
  | { type: "detect-error"; runId: number; message: string }
  | { type: "rendered"; id: number; page: number; png: ArrayBuffer; width: number; height: number }
  | { type: "thumbnail"; id: number; page: number; png: ArrayBuffer }
  | { type: "exported"; id: number; bytes: ArrayBuffer }
  | { type: "export-error"; id: number; message: string };
