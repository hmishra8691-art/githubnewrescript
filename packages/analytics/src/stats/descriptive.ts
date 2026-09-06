import { normalQuantile, tQuantile } from "./distributions.js";

/** A value with its case weight; weights default to 1 everywhere. */
export interface Weighted { value: number; w: number }

export function weightedValues(values: (number | null | undefined)[], weights?: number[]): Weighted[] {
  const out: Weighted[] = [];
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    const w = weights?.[i] ?? 1;
    if (w > 0) out.push({ value: v, w });
  });
  return out;
}

export interface Descriptives {
  n: number;
  weightedN: number;
  missing: number;
  mean: number | null;
  median: number | null;
  mode: number | null;
  min: number | null;
  max: number | null;
  range: number | null;
  sum: number | null;
  variance: number | null;
  sd: number | null;
  se: number | null;
  ci95: [number, number] | null;
  percentiles: Record<string, number | null>;
  quartiles: [number | null, number | null, number | null];
}

/** Weighted quantile by cumulative weight (type-7 style on unweighted data). */
export function quantile(sorted: Weighted[], p: number): number | null {
  if (!sorted.length) return null;
  const total = sorted.reduce((t, x) => t + x.w, 0);
  if (sorted.every((x) => x.w === 1)) {
    const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo].value + (sorted[hi].value - sorted[lo].value) * (idx - lo);
  }
  let cum = 0;
  const target = p * total;
  for (const x of sorted) { cum += x.w; if (cum >= target) return x.value; }
  return sorted[sorted.length - 1].value;
}

export function describe(values: (number | null | undefined)[], weights?: number[], confidence = 0.95): Descriptives {
  const wv = weightedValues(values, weights);
  const missing = values.length - wv.length;
  const n = wv.length;
  if (!n) {
    return { n: 0, weightedN: 0, missing, mean: null, median: null, mode: null, min: null, max: null, range: null, sum: null,
      variance: null, sd: null, se: null, ci95: null, percentiles: {}, quartiles: [null, null, null] };
  }
  const W = wv.reduce((t, x) => t + x.w, 0);
  const sum = wv.reduce((t, x) => t + x.value * x.w, 0);
  const mean = sum / W;
  // weighted sample variance with the (n-1)/n reliability correction on effective n
  const ss = wv.reduce((t, x) => t + x.w * (x.value - mean) ** 2, 0);
  const variance = n > 1 ? ss / (W * (n - 1) / n) : null;
  const sd = variance == null ? null : Math.sqrt(variance);
  const se = sd == null ? null : sd / Math.sqrt(n);
  const sorted = [...wv].sort((a, b) => a.value - b.value);
  const counts = new Map<number, number>();
  for (const x of wv) counts.set(x.value, (counts.get(x.value) ?? 0) + x.w);
  let mode: number | null = null, best = -1;
  for (const [v, c] of counts) if (c > best) { best = c; mode = v; }
  const tcrit = n > 1 ? tQuantile(1 - (1 - confidence) / 2, n - 1) : normalQuantile(1 - (1 - confidence) / 2);
  const pct: Record<string, number | null> = {};
  for (const p of [5, 10, 25, 50, 75, 90, 95]) pct[`p${p}`] = quantile(sorted, p / 100);
  return {
    n, weightedN: W, missing, mean, median: quantile(sorted, 0.5), mode,
    min: sorted[0].value, max: sorted[n - 1].value, range: sorted[n - 1].value - sorted[0].value, sum,
    variance, sd, se, ci95: se == null ? null : [mean - tcrit * se, mean + tcrit * se],
    percentiles: pct, quartiles: [quantile(sorted, 0.25), quantile(sorted, 0.5), quantile(sorted, 0.75)],
  };
}

/** Frequency of categorical values (codes) with weighted counts and percentages. */
export interface FrequencyRow { code: string; label: string; count: number; weightedCount: number; pct: number; validPct: number }
export function frequencies(
  values: (string | number | null | undefined | (string | number)[])[],
  weights: number[] | undefined,
  categories: { code: string; label: string }[] | null,
): { rows: FrequencyRow[]; n: number; valid: number; missing: number; weightedN: number; weightedValid: number } {
  const counts = new Map<string, { count: number; w: number }>();
  let valid = 0, weightedValid = 0, weightedN = 0;
  values.forEach((v, i) => {
    const w = weights?.[i] ?? 1;
    weightedN += w;
    const codes = Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)];
    if (!codes.length) return;
    valid += 1; weightedValid += w;
    for (const c of codes) { const cur = counts.get(c) ?? { count: 0, w: 0 }; cur.count += 1; cur.w += w; counts.set(c, cur); }
  });
  const keys = categories ? categories.map((c) => c.code) : [...counts.keys()].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const labelOf = (code: string) => categories?.find((c) => c.code === code)?.label ?? code;
  const rows: FrequencyRow[] = keys.map((code) => {
    const c = counts.get(code) ?? { count: 0, w: 0 };
    return { code, label: labelOf(code), count: c.count, weightedCount: c.w, pct: weightedN ? (c.w / weightedN) * 100 : 0, validPct: weightedValid ? (c.w / weightedValid) * 100 : 0 };
  });
  // categories that appear in the data but not in the code frame
  for (const code of counts.keys()) if (!keys.includes(code)) { const c = counts.get(code)!; rows.push({ code, label: code, count: c.count, weightedCount: c.w, pct: weightedN ? (c.w / weightedN) * 100 : 0, validPct: weightedValid ? (c.w / weightedValid) * 100 : 0 }); }
  return { rows, n: values.length, valid, missing: values.length - valid, weightedN, weightedValid };
}

/** Top/bottom box shares for an ordered scale (codes sorted ascending numerically). */
export interface BoxShares { n: number; weightedN: number; top1?: number; top2?: number; top3?: number; bottom1?: number; bottom2?: number; bottom3?: number; [k: string]: number | undefined }
export function boxShares(values: (number | null | undefined)[], weights: number[] | undefined, scaleCodes: number[], boxes = [1, 2, 3]): BoxShares {
  const sorted = [...scaleCodes].sort((a, b) => a - b);
  const wv = weightedValues(values, weights);
  const W = wv.reduce((t, x) => t + x.w, 0) || 1;
  const share = (codes: number[]) => (wv.filter((x) => codes.includes(x.value)).reduce((t, x) => t + x.w, 0) / W) * 100;
  const out: Record<string, number> = {};
  for (const k of boxes) {
    if (k > sorted.length) continue;
    out[`top${k}`] = share(sorted.slice(-k));
    out[`bottom${k}`] = share(sorted.slice(0, k));
  }
  return { n: wv.length, weightedN: W, ...out };
}
