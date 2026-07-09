/** The detection heuristics were written against PyMuPDF's fitz.Rect and
 * depend on its exact semantics; these tests pin the behaviors that differ
 * from naive rectangle math. */

import { describe, expect, it } from "vitest";

import { Rect, pyRound } from "../src/geometry";
import { FIELD_GAP, dedupe, trimRect } from "../src/heuristics";
import { makeCandidate } from "../src/types";

describe("Rect (fitz semantics)", () => {
  it("width/height clamp to 0 for inverted rects", () => {
    const r = new Rect(10, 10, 5, 20);
    expect(r.width).toBe(0);
    expect(r.height).toBe(10);
  });

  it("isEmpty when x0>=x1 or y0>=y1, area of empty is 0", () => {
    expect(new Rect(0, 0, 0, 10).isEmpty).toBe(true);
    expect(new Rect(0, 0, 10, 0).isEmpty).toBe(true);
    expect(new Rect(0, 0, 10, 10).isEmpty).toBe(false);
    expect(new Rect(10, 0, 0, 10).area()).toBe(0);
    expect(new Rect(0, 0, 4, 5).area()).toBe(20);
  });

  it("intersects requires an open (non-touching) overlap", () => {
    const a = new Rect(0, 0, 10, 10);
    expect(a.intersects(new Rect(10, 0, 20, 10))).toBe(false); // shared edge
    expect(a.intersects(new Rect(9.9, 0, 20, 10))).toBe(true);
    expect(a.intersects(new Rect(2, 2, 2, 8))).toBe(false); // empty operand
  });

  it("intersect of disjoint rects becomes empty", () => {
    const r = new Rect(0, 0, 5, 5).intersect(new Rect(6, 6, 9, 9));
    expect(r.isEmpty).toBe(true);
    expect(r.area()).toBe(0);
  });

  it("includeRect ignores empty operands", () => {
    const r = new Rect(0, 0, 5, 5);
    r.includeRect(new Rect(100, 100, 100, 200)); // empty: zero width
    expect(r.toTuple()).toEqual([0, 0, 5, 5]);
    r.includeRect(new Rect(2, 2, 8, 3));
    expect(r.toTuple()).toEqual([0, 0, 8, 5]);
  });

  it("normalize swaps inverted coordinates in place", () => {
    expect(new Rect(10, 20, 2, 4).normalize().toTuple()).toEqual([2, 4, 10, 20]);
  });

  it("plus offsets componentwise (inflate and translate)", () => {
    expect(new Rect(10, 10, 20, 20).plus(2, 2, -2, -2).toTuple()).toEqual([12, 12, 18, 18]);
    expect(new Rect(10, 10, 20, 20).plus(3, 4, 3, 4).toTuple()).toEqual([13, 14, 23, 24]);
  });
});

describe("pyRound (banker's rounding)", () => {
  it("rounds half to even like Python", () => {
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(-0.5) === 0).toBe(true);
    expect(pyRound(2.4)).toBe(2);
    expect(pyRound(2.6)).toBe(3);
  });
});

describe("trimRect", () => {
  it("keeps the largest usable side band, leaving the field gap", () => {
    const r = new Rect(0, 0, 100, 50);
    const k = new Rect(80, -10, 120, 60); // covers the right edge
    expect(trimRect(r, k)!.toTuple()).toEqual([0, 0, 80 - FIELD_GAP, 50]);
  });

  it("returns null when every option is too small", () => {
    const r = new Rect(0, 0, 20, 10);
    const k = new Rect(2, 2, 18, 8); // centered, leaves only slivers
    expect(trimRect(r, k)).toBeNull();
  });
});

describe("dedupe field gap", () => {
  it("separates fields that touch without overlapping", () => {
    const a = makeCandidate(0, new Rect(0, 0, 50, 20), "text", "a");
    const b = makeCandidate(0, new Rect(0, 20, 50, 40), "text", "b"); // touches a
    const out = dedupe([a, b]);
    expect(out).toHaveLength(2);
    expect(out[1].rect.y0 - out[0].rect.y1).toBeGreaterThanOrEqual(FIELD_GAP);
  });

  it("leaves a field alone when shrinking would make it unusably small", () => {
    const a = makeCandidate(0, new Rect(0, 0, 50, 20), "text", "a");
    const b = makeCandidate(0, new Rect(0, 20, 50, 26), "text", "b"); // 6pt tall
    const out = dedupe([a, b]);
    expect(out[1].rect.toTuple()).toEqual([0, 20, 50, 26]);
  });

  it("trims overlapping fields down to the gap", () => {
    const a = makeCandidate(0, new Rect(0, 0, 50, 20), "text", "a");
    const b = makeCandidate(0, new Rect(0, 15, 50, 40), "text", "b"); // 5pt overlap
    const out = dedupe([a, b]);
    expect(out[1].rect.y0).toBeCloseTo(20 + FIELD_GAP);
  });

  it("separates horizontal neighbors", () => {
    const a = makeCandidate(0, new Rect(0, 0, 50, 20), "text", "a");
    const b = makeCandidate(0, new Rect(50, 0, 100, 20), "text", "b");
    const out = dedupe([a, b]);
    expect(out[1].rect.x0 - out[0].rect.x1).toBeGreaterThanOrEqual(FIELD_GAP);
  });
});
