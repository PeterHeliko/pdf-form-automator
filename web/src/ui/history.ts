/** Undo/redo history: snapshots of one page's candidate list plus the
 * selection, exactly like gui/app.py (_push_history/_apply_history). */

import type { Candidate } from "../types";
import { cloneCandidate } from "../types";

export interface Snapshot {
  page: number;
  cands: Candidate[];
  selection: number[];
}

export function snapshot(page: number, cands: Candidate[], selection: number[]): Snapshot {
  return { page, cands: cands.map(cloneCandidate), selection: [...selection] };
}

export class History {
  undoStack: Snapshot[] = [];
  redoStack: Snapshot[] = [];

  /** Snapshot the current page before a mutation. */
  push(page: number, cands: Candidate[], selection: number[]): void {
    this.undoStack.push(snapshot(page, cands, selection));
    if (this.undoStack.length > 200) {
      this.undoStack.splice(0, this.undoStack.length - 200);
    }
    this.redoStack.length = 0;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
