/**
 * Clustering (k-means++, agglomerative), PCA / factor analysis (principal
 * axis + varimax), reliability (Cronbach's alpha) and weighting (cell weights,
 * rim weighting by raking).
 */
import { inverse, symmetricEigen, type Matrix } from "./matrix.js";
import { correlationMatrix, pearson } from "./correlation.js";
import { mulberry32 } from "@rescript/engine";

/* ------------------------------------------------------------ k-means */

export interface KMeansResult {
  k: number;
  assignments: number[];
  centroids: number[][];
  sizes: number[];
  withinSS: number;
  totalSS: number;
  iterations: number;
  /** average silhouette over a sample — a fit indicator that needs no labels */
  silhouette: number | null;
}

const dist2 = (a: number[], b: number[]) => a.reduce((t, v, i) => t + (v - b[i]) ** 2, 0);

/** Standardize columns (z-scores) so a 0–10 scale does not dominate a 1–5 one. */
export function standardize(rows: number[][]): { rows: number[][]; means: number[]; sds: number[] } {
  const k = rows[0]?.length ?? 0, n = rows.length;
  const means = Array.from({ length: k }, (_, j) => rows.reduce((t, r) => t + r[j], 0) / n);
  const sds = Array.from({ length: k }, (_, j) => Math.sqrt(rows.reduce((t, r) => t + (r[j] - means[j]) ** 2, 0) / Math.max(1, n - 1)) || 1);
  return { rows: rows.map((r) => r.map((v, j) => (v - means[j]) / sds[j])), means, sds };
}

export function kMeans(rows: number[][], k: number, seed = 42, maxIter = 100): KMeansResult {
  const n = rows.length;
  if (n < k) k = Math.max(1, n);
  const rnd = mulberry32(seed);
  // k-means++ seeding
  const centroids: number[][] = [rows[Math.floor(rnd() * n)].slice()];
  while (centroids.length < k) {
    const d = rows.map((r) => Math.min(...centroids.map((c) => dist2(r, c))));
    const total = d.reduce((a, b) => a + b, 0);
    let pick = rnd() * total, idx = 0;
    for (; idx < n - 1; idx++) { pick -= d[idx]; if (pick <= 0) break; }
    centroids.push(rows[idx].slice());
  }
  let assignments = new Array(n).fill(0), iter = 0;
  for (iter = 0; iter < maxIter; iter++) {
    const next = rows.map((r) => { let best = 0, bd = Infinity; centroids.forEach((c, ci) => { const d = dist2(r, c); if (d < bd) { bd = d; best = ci; } }); return best; });
    const changed = next.some((a, i) => a !== assignments[i]);
    assignments = next;
    for (let c = 0; c < k; c++) {
      const members = rows.filter((_, i) => assignments[i] === c);
      if (!members.length) continue;
      centroids[c] = members[0].map((_, j) => members.reduce((t, r) => t + r[j], 0) / members.length);
    }
    if (!changed) break;
  }
  const grand = rows[0].map((_, j) => rows.reduce((t, r) => t + r[j], 0) / n);
  const withinSS = rows.reduce((t, r, i) => t + dist2(r, centroids[assignments[i]]), 0);
  const totalSS = rows.reduce((t, r) => t + dist2(r, grand), 0);
  const sizes = Array.from({ length: k }, (_, c) => assignments.filter((a) => a === c).length);
  // silhouette on up to 300 sampled points
  let silhouette: number | null = null;
  if (k > 1 && n > k) {
    const sample = rows.map((_, i) => i).filter((_, i) => n <= 300 || rnd() < 300 / n);
    let sum = 0, cnt = 0;
    for (const i of sample) {
      const own = assignments[i];
      const same = rows.filter((_, j) => j !== i && assignments[j] === own);
      if (!same.length) continue;
      const a = same.reduce((t, r) => t + Math.sqrt(dist2(rows[i], r)), 0) / same.length;
      let b = Infinity;
      for (let c = 0; c < k; c++) {
        if (c === own) continue;
        const others = rows.filter((_, j) => assignments[j] === c);
        if (!others.length) continue;
        b = Math.min(b, others.reduce((t, r) => t + Math.sqrt(dist2(rows[i], r)), 0) / others.length);
      }
      if (Number.isFinite(b)) { sum += (b - a) / Math.max(a, b); cnt++; }
    }
    silhouette = cnt ? sum / cnt : null;
  }
  return { k, assignments, centroids, sizes, withinSS, totalSS, iterations: iter + 1, silhouette };
}

/* ------------------------------------------------------------ hierarchical */

export interface DendrogramMerge { left: number; right: number; height: number; size: number }
export interface HierarchicalResult { merges: DendrogramMerge[]; assignments: number[]; k: number }

/** Agglomerative clustering (Ward or average linkage) on ≤ ~1,500 rows; returns the merge tree and a cut at k. */
export function hierarchical(rows: number[][], k: number, linkage: "ward" | "average" = "ward"): HierarchicalResult {
  const n = rows.length;
  let clusters = rows.map((r, i) => ({ id: i, members: [i], centroid: r.slice() }));
  const merges: DendrogramMerge[] = [];
  let nextId = n;
  const assignmentsAt = (target: number) => {
    // replay merges until `target` clusters remain
    const groups = rows.map((_, i) => [i]);
    const alive = new Map<number, number[]>(groups.map((g, i) => [i, g]));
    for (const m of merges) {
      if (alive.size <= target) break;
      const merged = [...(alive.get(m.left) ?? []), ...(alive.get(m.right) ?? [])];
      alive.delete(m.left); alive.delete(m.right);
      alive.set(n + merges.indexOf(m), merged);
    }
    const out = new Array(n).fill(0);
    let c = 0;
    for (const members of alive.values()) { for (const i of members) out[i] = c; c++; }
    return out;
  };
  const linkDist = (a: typeof clusters[number], b: typeof clusters[number]) => {
    if (linkage === "ward") return (a.members.length * b.members.length) / (a.members.length + b.members.length) * dist2(a.centroid, b.centroid);
    let s = 0;
    for (const i of a.members) for (const j of b.members) s += Math.sqrt(dist2(rows[i], rows[j]));
    return s / (a.members.length * b.members.length);
  };
  while (clusters.length > 1) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const d = linkDist(clusters[i], clusters[j]);
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
    const a = clusters[bi], b = clusters[bj];
    const members = [...a.members, ...b.members];
    const centroid = rows[0].map((_, col) => members.reduce((t, i) => t + rows[i][col], 0) / members.length);
    merges.push({ left: a.id, right: b.id, height: Math.sqrt(Math.max(0, bd)), size: members.length });
    clusters = clusters.filter((_, i) => i !== bi && i !== bj);
    clusters.push({ id: nextId++, members, centroid });
  }
  return { merges, assignments: assignmentsAt(Math.max(1, Math.min(k, n))), k };
}

/* ------------------------------------------------------------ PCA / factor */

export interface FactorResult {
  method: "pca" | "principal_axis";
  variables: string[];
  eigenvalues: number[];
  explained: number[];
  cumulative: number[];
  /** loadings[variable][factor] after rotation */
  loadings: number[][];
  factors: number;
  rotation: "none" | "varimax";
  kmo: number | null;
  /** factor scores per case (regression method on standardized data) */
  scores: number[][];
  communalities: number[];
}

function varimax(L: Matrix, maxIter = 50): Matrix {
  const p = L.length, k = L[0]?.length ?? 0;
  if (k < 2) return L;
  let R: Matrix = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
  const mult = (A: Matrix, B: Matrix) => A.map((row) => B[0].map((_, j) => row.reduce((t, v, i) => t + v * B[i][j], 0)));
  let d = 0;
  for (let it = 0; it < maxIter; it++) {
    const Lr = mult(L, R);
    const u = Lr.map((row) => row.map((v) => v ** 3 - (v * row.reduce((t, x) => t + x * x, 0)) / p));
    // R = (L' u) svd → use eigen on (L'u)'(L'u)
    const Lt = L[0].map((_, j) => L.map((row) => row[j]));
    const B = mult(Lt, u);
    const BtB = mult(B[0].map((_, j) => B.map((row) => row[j])), B);
    const { values, vectors } = symmetricEigen(BtB);
    const invSqrt = vectors.map((row) => row.map((v, j) => v / Math.sqrt(Math.max(values[j], 1e-12))));
    const V = mult(vectors, invSqrt[0].map((_, j) => invSqrt.map((row) => row[j])));
    R = mult(B, V);
    const dNew = values.reduce((t, v) => t + Math.sqrt(Math.max(v, 0)), 0);
    if (Math.abs(dNew - d) < 1e-7) break;
    d = dNew;
  }
  return mult(L, R);
}

export function factorAnalysis(columns: { name: string; values: (number | null | undefined)[] }[], opts: { method?: "pca" | "principal_axis"; factors?: number; rotation?: "none" | "varimax" } = {}): FactorResult | { error: string } {
  const method = opts.method ?? "pca";
  const p = columns.length;
  if (p < 2) return { error: "needs at least two variables" };
  // complete cases only
  const n = columns[0].values.length;
  const keep = Array.from({ length: n }, (_, i) => i).filter((i) => columns.every((c) => c.values[i] != null && Number.isFinite(c.values[i] as number)));
  if (keep.length < p + 2) return { error: `needs more complete cases (${keep.length}) than variables (${p})` };
  const data = keep.map((i) => columns.map((c) => c.values[i] as number));
  const z = standardize(data).rows;
  const corr = correlationMatrix(columns.map((c, j) => ({ name: c.name, values: keep.map((i) => c.values[i]) })));
  let R: Matrix = corr.r.map((row) => row.map((v) => v ?? 0));
  if (method === "principal_axis") {
    // replace the diagonal with squared multiple correlations (communality estimates), iterate a few times
    const inv = inverse(R);
    if (inv) R = R.map((row, i) => row.map((v, j) => (i === j ? 1 - 1 / inv[i][i] : v)));
  }
  const eig = symmetricEigen(R);
  const total = p;
  const factors = opts.factors ?? Math.max(1, eig.values.filter((v) => v > 1).length);
  let loadings: Matrix = columns.map((_, i) => eig.vectors[i].slice(0, factors).map((v, f) => v * Math.sqrt(Math.max(eig.values[f], 0))));
  const rotation = opts.rotation ?? (factors > 1 ? "varimax" : "none");
  if (rotation === "varimax") loadings = varimax(loadings);
  // sign convention: the largest absolute loading in each factor is positive
  for (let f = 0; f < factors; f++) {
    let big = 0; for (let i = 0; i < p; i++) if (Math.abs(loadings[i][f]) > Math.abs(loadings[big][f])) big = i;
    if (loadings[big][f] < 0) for (let i = 0; i < p; i++) loadings[i][f] = -loadings[i][f];
  }
  const communalities = loadings.map((row) => row.reduce((t, v) => t + v * v, 0));
  // scores: z · loadings (component scores for PCA; regression approximation otherwise)
  const scores = z.map((row) => Array.from({ length: factors }, (_, f) => row.reduce((t, v, i) => t + v * loadings[i][f], 0) / Math.max(1e-9, communalities.reduce((a, b) => a + b, 0) / p)));
  // KMO from the anti-image correlation matrix
  let kmo: number | null = null;
  const inv = inverse(corr.r.map((row) => row.map((v) => v ?? 0)));
  if (inv) {
    let r2 = 0, q2 = 0;
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) {
      if (i === j) continue;
      const rij = corr.r[i][j] ?? 0;
      const qij = -inv[i][j] / Math.sqrt(inv[i][i] * inv[j][j]);
      r2 += rij * rij; q2 += qij * qij;
    }
    kmo = r2 + q2 ? r2 / (r2 + q2) : null;
  }
  return {
    method, variables: columns.map((c) => c.name), eigenvalues: eig.values,
    explained: eig.values.map((v) => (v / total) * 100),
    cumulative: eig.values.reduce<number[]>((acc, v) => [...acc, (acc.at(-1) ?? 0) + (v / total) * 100], []),
    loadings, factors, rotation, kmo, scores, communalities,
  };
}

/* ------------------------------------------------------------ reliability */

export interface ReliabilityResult {
  alpha: number | null;
  standardizedAlpha: number | null;
  items: number;
  n: number;
  itemTotal: { name: string; correlation: number | null; alphaIfDeleted: number | null; mean: number; sd: number }[];
  interItem: (number | null)[][];
  meanInterItem: number | null;
}

export function cronbachAlpha(columns: { name: string; values: (number | null | undefined)[] }[]): ReliabilityResult {
  const p = columns.length;
  const n = columns[0]?.values.length ?? 0;
  const keep = Array.from({ length: n }, (_, i) => i).filter((i) => columns.every((c) => c.values[i] != null && Number.isFinite(c.values[i] as number)));
  const data = keep.map((i) => columns.map((c) => c.values[i] as number));
  const alphaOf = (cols: number[]) => {
    if (cols.length < 2 || data.length < 2) return null;
    const totals = data.map((r) => cols.reduce((t, j) => t + r[j], 0));
    const varOf = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.reduce((t, x) => t + (x - m) ** 2, 0) / (xs.length - 1); };
    const itemVar = cols.reduce((t, j) => t + varOf(data.map((r) => r[j])), 0);
    const totVar = varOf(totals);
    return totVar ? (cols.length / (cols.length - 1)) * (1 - itemVar / totVar) : null;
  };
  const all = columns.map((_, j) => j);
  const inter = correlationMatrix(columns.map((c) => ({ name: c.name, values: keep.map((i) => c.values[i]) }))).r;
  const offDiag: number[] = [];
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) if (i !== j && inter[i][j] != null) offDiag.push(inter[i][j] as number);
  const rBar = offDiag.length ? offDiag.reduce((a, b) => a + b, 0) / offDiag.length : null;
  return {
    alpha: alphaOf(all), standardizedAlpha: rBar == null ? null : (p * rBar) / (1 + (p - 1) * rBar), items: p, n: data.length,
    itemTotal: columns.map((c, j) => {
      const xs = data.map((r) => r[j]);
      const rest = data.map((r) => all.filter((x) => x !== j).reduce((t, x) => t + r[x], 0));
      const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
      return { name: c.name, correlation: pearson(xs, rest), alphaIfDeleted: alphaOf(all.filter((x) => x !== j)), mean: m, sd: Math.sqrt(xs.reduce((t, x) => t + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)) };
    }),
    interItem: inter, meanInterItem: rBar,
  };
}

/* ------------------------------------------------------------ weighting */

export interface RimTarget { variable: string; targets: Record<string, number> /* category → target share (0–1 or %) */ }
export interface WeightingResult {
  weights: number[];
  iterations: number;
  converged: boolean;
  efficiency: number;
  designEffect: number;
  min: number; max: number;
  achieved: { variable: string; category: string; target: number; achieved: number }[];
}

/**
 * Rim weighting (iterative proportional fitting / raking). `cases[i][variable]`
 * is the category of case i. One target dimension = cell weighting.
 */
export function rimWeights(cases: Record<string, string | null | undefined>[], targets: RimTarget[], opts: { maxIter?: number; cap?: [number, number] } = {}): WeightingResult {
  const n = cases.length;
  let w = new Array(n).fill(1);
  const norm = (t: Record<string, number>) => { const s = Object.values(t).reduce((a, b) => a + b, 0); return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, s ? v / s : 0])); };
  const dims = targets.map((t) => ({ variable: t.variable, targets: norm(t.targets) }));
  let iter = 0, converged = false;
  const [lo, hi] = opts.cap ?? [0.2, 5];
  for (iter = 0; iter < (opts.maxIter ?? 100); iter++) {
    let maxChange = 0;
    for (const d of dims) {
      const totals: Record<string, number> = {};
      let W = 0;
      cases.forEach((c, i) => { const cat = c[d.variable]; if (cat == null) return; totals[String(cat)] = (totals[String(cat)] ?? 0) + w[i]; W += w[i]; });
      cases.forEach((c, i) => {
        const cat = c[d.variable]; if (cat == null) return;
        const cur = totals[String(cat)] ?? 0; const target = d.targets[String(cat)];
        if (target == null || !cur) return;
        const f = (target * W) / cur;
        const nw = Math.min(hi, Math.max(lo, w[i] * f));
        maxChange = Math.max(maxChange, Math.abs(nw - w[i]));
        w[i] = nw;
      });
    }
    // rescale to mean 1
    const mean = w.reduce((a, b) => a + b, 0) / n;
    w = w.map((x) => x / mean);
    if (maxChange < 1e-6) { converged = true; break; }
  }
  const sumW = w.reduce((a, b) => a + b, 0), sumW2 = w.reduce((a, b) => a + b * b, 0);
  const deff = (n * sumW2) / (sumW * sumW);
  const achieved: WeightingResult["achieved"] = [];
  for (const d of dims) {
    const totals: Record<string, number> = {}; let W = 0;
    cases.forEach((c, i) => { const cat = c[d.variable]; if (cat == null) return; totals[String(cat)] = (totals[String(cat)] ?? 0) + w[i]; W += w[i]; });
    for (const [cat, t] of Object.entries(d.targets)) achieved.push({ variable: d.variable, category: cat, target: t, achieved: W ? (totals[cat] ?? 0) / W : 0 });
  }
  return { weights: w, iterations: iter + 1, converged, efficiency: 1 / deff, designEffect: deff, min: Math.min(...w), max: Math.max(...w), achieved };
}
