/** Port of fields.py: unique field names. (Stripping existing fields moved
 * to writer.ts, where the PDF object layer lives.) */

import { slugify } from "./heuristics";
import type { Candidate } from "./types";

export const TYPE_SUFFIX: Record<string, string> = {
  date: "Datum",
  signature: "Unterschrift",
  checkbox: "Checkbox",
};

export function assignNames(candidates: Candidate[]): void {
  const used = new Set<string>();
  for (const cand of candidates) {
    let base = cand.name || slugify(cand.label);
    if (base === "Feld" && cand.ftype in TYPE_SUFFIX) {
      base = TYPE_SUFFIX[cand.ftype];
    }
    let name = base;
    let n = 2;
    while (used.has(name)) {
      name = `${base}_${n}`;
      n++;
    }
    used.add(name);
    cand.name = name;
  }
}
