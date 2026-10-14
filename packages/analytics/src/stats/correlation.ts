import { normalCdf, normalQuantile, tTestP } from "./distributions.js";

export type CorrelationMethod = "pearson" | "spearman" | "kendall";

export interface Correlation { r: number | null; p: number | null; n: number; method: CorrelationMethod; /** confidence interval for r (Fisher z), null when not defined */ ci?: [number, number] | null }

/**
 * A confidence interval for a correlation, by Fisher's z transform: atanh(r) ± z·se, back-transformed.
 * The standard error depends on the coefficient: 1/√(n−3) for Pearson's r; Bonett & Wright's √((1+r²/2)/(n−3)) for
 * Spearman's rho (the plain value is too narrow once the data are ranked); Fieller's √(0.437/(n−4)) for Kendall's tau.
 * Null for n too small, |r| = 1, or no coefficient (a p-value alone said "different from zero", never how large).
 */
export function correlationInterval(r: number | null, n: number, method: CorrelationMethod = "pearson", confidence = 0.95): [number, number] | null {
  if (r == null || !Number.isFinite(r) || Math.abs(r) >= 1) return null;
  const minN = method === "kendall" ? 5 : 4;
  if (n < minN) return null;
  const se = method === "spearman" ? Math.sqrt((1 + (r * r) / 2) / (n - 3)) : method === "kendall" ? Math.sqrt(0.437 / (n - 4)) : 1 / Math.sqrt(n - 3);
  const z = normalQuantile(1 - (1 - confidence) / 2), c = Math.atanh(r);
  return [Math.tanh(c - z * se), Math.tanh(c + z * se)];
}

const pairs = (a: (number | null | undefined)[], b: (number | null | undefined)[]): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
};

const ranks = (xs: number[]): number[] => {
  const idx = xs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array(xs.length).fill(0);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
};

export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export function correlate(a: (number | null | undefined)[], b: (number | null | undefined)[], method: CorrelationMethod = "pearson"): Correlation {
  const ps = pairs(a, b);
  const n = ps.length;
  if (n < 3) return { r: null, p: null, n, method };
  const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
  if (method === "kendall") {
    let conc = 0, disc = 0, tx = 0, ty = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = Math.sign(xs[i] - xs[j]), dy = Math.sign(ys[i] - ys[j]);
      if (dx === 0 && dy === 0) continue;
      if (dx === 0) { tx++; continue; }
      if (dy === 0) { ty++; continue; }
      if (dx * dy > 0) conc++; else disc++;
    }
    const n0 = (n * (n - 1)) / 2;
    const tau = Math.sqrt((n0 - tx) * (n0 - ty)) ? (conc - disc) / Math.sqrt((n0 - tx) * (n0 - ty)) : null;
    const z = tau == null ? 0 : (3 * tau * Math.sqrt(n * (n - 1))) / Math.sqrt(2 * (2 * n + 5));
    return { r: tau, p: tau == null ? null : 2 * (1 - normalCdf(Math.abs(z))), n, method, ci: correlationInterval(tau, n, "kendall") };
  }
  const r = method === "spearman" ? pearson(ranks(xs), ranks(ys)) : pearson(xs, ys);
  if (r == null) return { r: null, p: null, n, method };
  const t = Math.abs(r) >= 1 ? Infinity : (r * Math.sqrt(n - 2)) / Math.sqrt(1 - r * r);
  return { r, p: Number.isFinite(t) ? tTestP(t, n - 2) : 0, n, method, ci: correlationInterval(r, n, method) };
}

export interface CorrelationMatrix { variables: string[]; r: (number | null)[][]; p: (number | null)[][]; n: number[][] }

export function correlationMatrix(columns: { name: string; values: (number | null | undefined)[] }[], method: CorrelationMethod = "pearson"): CorrelationMatrix {
  const k = columns.length;
  const r: (number | null)[][] = [], p: (number | null)[][] = [], n: number[][] = [];
  for (let i = 0; i < k; i++) {
    r.push([]); p.push([]); n.push([]);
    for (let j = 0; j < k; j++) {
      if (i === j) { r[i].push(1); p[i].push(0); n[i].push(columns[i].values.filter((v) => v != null).length); continue; }
      const c = correlate(columns[i].values, columns[j].values, method);
      r[i].push(c.r); p[i].push(c.p); n[i].push(c.n);
    }
  }
  return { variables: columns.map((c) => c.name), r, p, n };
}
