/**
 * A SEEDED, SERIALISABLE random number generator for the model estimators
 * (HB-MNL chains, LCA random starts).
 *
 * The generator is mulberry32 (the same family `@rescript/engine` uses for
 * designs), but its whole state is two numbers — the 32-bit counter and the
 * cached second Box–Muller normal — so a chain can be stopped, stored as JSON
 * and continued in another request and still produce exactly the draws an
 * uninterrupted run would have produced. That is what makes chunked HB
 * execution reproducible: same seed, same data → same posterior, however many
 * requests it took.
 */
export interface RngState { s: number; spare: number | null }

export class Rng {
  private s: number;
  private spare: number | null;
  constructor(seedOrState: number | RngState) {
    if (typeof seedOrState === "number") { this.s = (seedOrState >>> 0) ^ 0x9e3779b9; this.spare = null; }
    else { this.s = seedOrState.s | 0; this.spare = seedOrState.spare; }
  }
  save(): RngState { return { s: this.s, spare: this.spare }; }
  /** uniform on [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** uniform on (0, 1) — never exactly 0, so logs are safe */
  open(): number { let u = this.next(); while (u <= 0) u = this.next(); return u; }
  /** standard normal (Box–Muller; the second value is kept in the state) */
  normal(): number {
    if (this.spare != null) { const v = this.spare; this.spare = null; return v; }
    const u = this.open(), v = this.next();
    const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * v;
    this.spare = r * Math.sin(th);
    return r * Math.cos(th);
  }
  /** Gamma(shape, 1) — Marsaglia & Tsang (2000); shape < 1 by the boosting identity */
  gamma(shape: number): number {
    if (!(shape > 0)) throw new RangeError("gamma shape must be positive");
    if (shape < 1) return this.gamma(shape + 1) * Math.pow(this.open(), 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number, v: number;
      do { x = this.normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = this.open();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  /** χ²(df) */
  chisq(df: number): number { return 2 * this.gamma(df / 2); }
  /** an integer seed derived from this stream (for sub-streams) */
  int(): number { return Math.floor(this.next() * 2 ** 31); }
}
