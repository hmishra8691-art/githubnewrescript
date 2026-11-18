import { inverse, multiplyVec, symmetricEigen, type Matrix } from "./matrix.js";

/**
 * RELATIVE IMPORTANCE OF CORRELATED DRIVERS (audit 2026-11-17, P2-06).
 *
 * Standardised betas rank drivers well only when the drivers are uncorrelated. In satisfaction data they never
 * are: two correlated attributes split, swap or even reverse their betas from one wave to the next, and a driver
 * that matters can show a near-zero beta because its partner took the credit. Two standard answers divide the
 * model's R² among the drivers instead. Both sum to R² and are never negative.
 *
 *   Shapley / LMG    each driver's average gain in R² over every order in which drivers can enter the model
 *                    (Lindeman, Merenda & Gold 1980; Grömping 2007). Exact, by enumerating all 2^p subsets, so it
 *                    is limited to MAX_SHAPLEY drivers.
 *   Johnson weights  the drivers are rotated to their nearest orthogonal counterparts, Z = R^½, and each driver
 *                    gets its share of R² through them (Johnson 2000). Fast at any size; agrees closely with
 *                    Shapley in practice.
 *
 * Both work from the correlation matrix of the complete cases (listwise), weighted when weights are given.
 */

export const MAX_SHAPLEY = 12;

export interface RelativeImportance {
  n: number;
  r2: number;
  /** per driver, in input order; each a share of R² (absolute), and as % of R² */
  shapley: number[] | null;
  johnson: number[];
}

function correlationMatrix(cols: number[][], w: number[] | undefined): Matrix {
  const n = cols[0].length, k = cols.length;
  const W = w ?? new Array(n).fill(1);
  const sw = W.reduce((a, b) => a + b, 0);
  const mean = cols.map((c) => c.reduce((a, v, i) => a + W[i] * v, 0) / sw);
  const cov: Matrix = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let a = 0; a < k; a++) for (let b = a; b < k; b++) {
    let s = 0; for (let i = 0; i < n; i++) s += W[i] * (cols[a][i] - mean[a]) * (cols[b][i] - mean[b]);
    cov[a][b] = cov[b][a] = s / sw;
  }
  return cov.map((row, a) => row.map((v, b) => (cov[a][a] > 0 && cov[b][b] > 0 ? v / Math.sqrt(cov[a][a] * cov[b][b]) : a === b ? 1 : 0)));
}

/** R² of y on the predictors in `set`, from the correlation matrix (index 0 = y) */
function r2Of(R: Matrix, set: number[]): number {
  if (!set.length) return 0;
  const Rxx = set.map((i) => set.map((j) => R[i + 1][j + 1]));
  const rxy = set.map((i) => R[i + 1][0]);
  const inv = inverse(Rxx);
  if (!inv) return NaN;
  const b = multiplyVec(inv, rxy);
  return Math.max(0, b.reduce((t, v, i) => t + v * rxy[i], 0));
}

export function relativeImportance(y: (number | null)[], xs: (number | null)[][], w?: number[]): RelativeImportance | { error: string } {
  const p = xs.length;
  if (!p) return { error: "no drivers" };
  const keep: number[] = [];
  for (let i = 0; i < y.length; i++) if (y[i] != null && Number.isFinite(y[i]!) && xs.every((x) => x[i] != null && Number.isFinite(x[i]!)) && (!w || w[i] > 0)) keep.push(i);
  if (keep.length <= p + 1) return { error: `needs more than ${p + 1} complete cases, has ${keep.length}` };
  const cols = [keep.map((i) => y[i]!), ...xs.map((x) => keep.map((i) => x[i]!))];
  const R = correlationMatrix(cols, w ? keep.map((i) => w[i]) : undefined);
  const all = Array.from({ length: p }, (_, j) => j);
  const r2 = r2Of(R, all);
  if (!Number.isFinite(r2)) return { error: "the drivers are perfectly collinear" };

  /* Shapley: exact over subsets, memoised by bitmask */
  let shapley: number[] | null = null;
  if (p <= MAX_SHAPLEY) {
    const memo = new Map<number, number>();
    const r2m = (mask: number) => { let v = memo.get(mask); if (v === undefined) { v = r2Of(R, all.filter((j) => mask & (1 << j))); memo.set(mask, v); } return v; };
    const fact = (n: number) => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
    shapley = all.map((j) => {
      let s = 0;
      for (let mask = 0; mask < 1 << p; mask++) {
        if (mask & (1 << j)) continue;
        const size = all.reduce((c, i) => c + ((mask >> i) & 1), 0);
        s += (fact(size) * fact(p - size - 1) / fact(p)) * (r2m(mask | (1 << j)) - r2m(mask));
      }
      return s;
    });
  }

  /* Johnson: R_xx = QΛQ', Λ* = QΛ^½Q', β = Λ*^-1 r_xy, ε_j = Σ_k Λ*_jk² β_k² */
  const Rxx = all.map((i) => all.map((j) => R[i + 1][j + 1]));
  const rxy = all.map((i) => R[i + 1][0]);
  const { values, vectors } = symmetricEigen(Rxx);
  const half = all.map((i) => all.map((j) => all.reduce((t, k) => t + vectors[i][k] * Math.sqrt(Math.max(values[k], 0)) * vectors[j][k], 0)));
  const hinv = inverse(half);
  if (!hinv) return { error: "the drivers are perfectly collinear" };
  const beta = multiplyVec(hinv, rxy);
  const johnson = all.map((j) => all.reduce((t, k) => t + half[j][k] ** 2 * beta[k] ** 2, 0));
  return { n: keep.length, r2, shapley, johnson };
}
