/** Port of the PyMuPDF (fitz) Rect semantics the pipeline relies on.
 *
 * The detection heuristics were written against fitz.Rect and are sensitive
 * to its exact behavior: width/height clamp to 0, empty means x0>=x1 or
 * y0>=y1, abs() of an empty rect is 0, unions ignore empty operands.
 */

export type RectTuple = [number, number, number, number];

export class Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;

  constructor(x0: number, y0: number, x1: number, y1: number) {
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
  }

  static from(r: Rect | RectTuple | number[]): Rect {
    if (r instanceof Rect) return new Rect(r.x0, r.y0, r.x1, r.y1);
    return new Rect(r[0], r[1], r[2], r[3]);
  }

  clone(): Rect {
    return new Rect(this.x0, this.y0, this.x1, this.y1);
  }

  toTuple(): RectTuple {
    return [this.x0, this.y0, this.x1, this.y1];
  }

  get width(): number {
    return Math.max(0, this.x1 - this.x0);
  }

  get height(): number {
    return Math.max(0, this.y1 - this.y0);
  }

  get isEmpty(): boolean {
    return this.x0 >= this.x1 || this.y0 >= this.y1;
  }

  /** Python abs(rect): the area, 0 for empty rects. */
  area(): number {
    return this.isEmpty ? 0 : (this.x1 - this.x0) * (this.y1 - this.y0);
  }

  /** Python rect + (a, b, c, d): componentwise offset, returns a new Rect. */
  plus(a: number, b: number, c: number, d: number): Rect {
    return new Rect(this.x0 + a, this.y0 + b, this.x1 + c, this.y1 + d);
  }

  normalize(): this {
    if (this.x1 < this.x0) [this.x0, this.x1] = [this.x1, this.x0];
    if (this.y1 < this.y0) [this.y0, this.y1] = [this.y1, this.y0];
    return this;
  }

  /** fitz.Rect.intersects: true only for a non-empty open intersection. */
  intersects(r: Rect): boolean {
    return (
      !this.isEmpty && !r.isEmpty &&
      this.x0 < r.x1 && r.x0 < this.x1 &&
      this.y0 < r.y1 && r.y0 < this.y1
    );
  }

  /** fitz.Rect.intersect: restrict to the common area, in place. The result
   * may be "empty" (inverted); callers test isEmpty like the Python code. */
  intersect(r: Rect): this {
    if (r.isEmpty) {
      this.x0 = r.x0; this.y0 = r.y0; this.x1 = r.x1; this.y1 = r.y1;
    } else if (!this.isEmpty) {
      this.x0 = Math.max(this.x0, r.x0);
      this.y0 = Math.max(this.y0, r.y0);
      this.x1 = Math.min(this.x1, r.x1);
      this.y1 = Math.min(this.y1, r.y1);
    }
    return this;
  }

  /** fitz.Rect |= r (include_rect): empty operands are ignored. */
  includeRect(r: Rect): this {
    if (r.isEmpty) return this;
    if (this.isEmpty) {
      this.x0 = r.x0; this.y0 = r.y0; this.x1 = r.x1; this.y1 = r.y1;
      return this;
    }
    this.x0 = Math.min(this.x0, r.x0);
    this.y0 = Math.min(this.y0, r.y0);
    this.x1 = Math.max(this.x1, r.x1);
    this.y1 = Math.max(this.y1, r.y1);
    return this;
  }
}

/** Python round(): banker's rounding (half to even). */
export function pyRound(v: number): number {
  const floor = Math.floor(v);
  const diff = v - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
