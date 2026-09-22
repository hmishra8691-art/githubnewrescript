import { normalQuantile, tQuantile } from "./distributions.js";

/** A value with its case weight; weights default to 1 everywhere. */
export interface Weighted { value: number; w: number }

/**
 * A weights array shorter than its values is a bug, not a default.
 *
 * `weights?.[i] ?? 1` silently padded the tail with 1, so a truncated weight
 * vector produced a plausible wrong answer with nothing to notice:
 * `describe([1,2,3,4], [2,2])` returned a weighted n of 6 and a mean of
 * 2.1667 rather than failing. A missing array still means "unweighted" — that
 * is the documented calling convention and every caller relies on it — but a
 * present array of the wrong length is a caller error and now says so.
 */
function checkWeights(values: unknown[], weights?: number[]): void {
  if (weights && weights.length !== values.length) {
    throw new RangeError(`weights length ${weights.length} does not match values length ${values.length}`);
  }
}

export function weightedValues(values: (number | null | undefined)[], weights?: number[]): Weighted[] {
  checkWeights(values, weights);
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

/**
 * KISH EFFECTIVE SAMPLE SIZE — (Σw)² / Σw².
 *
 * How many respondents a weighted sample is WORTH for inference. Equals the
 * plain count exactly when every weight is the same, and falls as the weights
 * spread out: five cases weighted 1,1,1,1,10 carry about 1.9 cases of
 * information, not five.
 *
 * This is the number that belongs in every denominator that answers "how sure
 * are we" — the Bessel correction, the standard error, the t degrees of
 * freedom. `crosstab.ts` has computed it since it was written and uses it for
 * its significance letters; nothing else in the package did, which is why a
 * weighted confidence interval was up to five times too narrow.
 */
export function effectiveN(wv: Weighted[]): number {
  let w = 0, w2 = 0;
  for (const x of wv) { w += x.w; w2 += x.w * x.w; }
  return w2 ? (w * w) / w2 : 0;
}

/**
 * Weighted quantile, type-7 for any weights.
 *
 * The previous version interpolated (type 7) only when `every(x => x.w === 1)`
 * and otherwise returned the first value whose cumulative weight crossed the
 * target — a different estimator, biased low and discontinuous. An exact float
 * comparison against 1.0 decided which, so a weight vector of all 1.000001 —
 * i.e. essentially every real rim-weighted study — silently took the second
 * path, and doubling every weight (a statistical no-op) changed the answer.
 *
 * This is the type-7 plotting position generalised to weights: normalise the
 * weights to sum to n, let each value sit at the cumulative normalised weight
 * that precedes it, and interpolate between the two values bracketing p(n-1).
 * With equal weights each gap is exactly 1 and the positions collapse to
 * (i-1)/(n-1), so unweighted results are bit-for-bit what they were.
 */
export function quantile(sorted: Weighted[], p: number): number | null {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0].value;
  const total = sorted.reduce((t, x) => t + x.w, 0);
  if (!total) return null;
  const scale = n / total;              // normalised weights sum to n, so this is scale-invariant
  const target = p * (n - 1);
  let pos = 0;                          // cumulative normalised weight before the current value
  for (let i = 0; i < n - 1; i++) {
    const gap = sorted[i].w * scale;
    if (target <= pos + gap || i === n - 2) {
      const t = gap ? Math.min(1, Math.max(0, (target - pos) / gap)) : 0;
      return sorted[i].value + (sorted[i + 1].value - sorted[i].value) * t;
    }
    pos += gap;
  }
  return sorted[n - 1].value;
}

export function describe(values: (number | null | undefined)[], weights?: number[], confidence = 0.95): Descriptives {
  const wv = weightedValues(values, weights);
  /*
   * A zero-weight case is EXCLUDED, not missing.
   *
   * `values.length - wv.length` lumped the two together, so a respondent who
   * answered but carries weight 0 was reported identically to one who did not
   * answer at all. `frequencies` draws the same line now, so "missing" means
   * the same thing in a descriptives table and a frequency table of the same
   * variable.
   */
  const inBase = weights ? weights.reduce((t, w) => t + (w > 0 ? 1 : 0), 0) : values.length;
  const n = wv.length;
  const missing = inBase - n;
  if (!n) {
    return { n: 0, weightedN: 0, missing, mean: null, median: null, mode: null, min: null, max: null, range: null, sum: null,
      variance: null, sd: null, se: null, ci95: null, percentiles: {}, quartiles: [null, null, null] };
  }
  const W = wv.reduce((t, x) => t + x.w, 0);
  const sum = wv.reduce((t, x) => t + x.value * x.w, 0);
  const mean = sum / W;
  /*
   * Weighted sample variance with the Bessel correction on the EFFECTIVE base.
   *
   * The comment here used to say "on effective n" while the code used the raw
   * count — so the correction, the standard error and the t degrees of freedom
   * all behaved as though a sample of twenty cases weighted 0.3–3.5 carried
   * twenty cases of information when it carries about fourteen. Every interval
   * this produced was too narrow, never too wide, which is the direction that
   * turns a null result into a finding.
   *
   * `nEff` collapses to `n` exactly when the weights are equal, so unweighted
   * output is unchanged to the last bit.
   */
  const nEff = effectiveN(wv);
  const ss = wv.reduce((t, x) => t + x.w * (x.value - mean) ** 2, 0);
  const variance = nEff > 1 ? ss / (W * (nEff - 1) / nEff) : null;
  const sd = variance == null ? null : Math.sqrt(variance);
  const se = sd == null ? null : sd / Math.sqrt(nEff);
  const sorted = [...wv].sort((a, b) => a.value - b.value);
  const counts = new Map<number, number>();
  for (const x of wv) counts.set(x.value, (counts.get(x.value) ?? 0) + x.w);
  let mode: number | null = null, best = -1;
  for (const [v, c] of counts) if (c > best) { best = c; mode = v; }
  // degrees of freedom follow the effective base too, for the same reason
  const tcrit = nEff > 1 ? tQuantile(1 - (1 - confidence) / 2, nEff - 1) : normalQuantile(1 - (1 - confidence) / 2);
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
  checkWeights(values, weights);
  const counts = new Map<string, { count: number; w: number }>();
  let valid = 0, weightedValid = 0, weightedN = 0;
  /*
   * Missingness means the same thing here as it does in `describe`.
   *
   * It did not. `String(NaN)` is `"NaN"`, so a numeric variable carrying a NaN
   * grew a literal "NaN" category with a percentage beside it, while
   * `describe` counted that same case as missing — one variable, two answers,
   * on the same screen. A case with weight 0 had the same split: dropped by
   * `weightedValues`, counted as valid here.
   */
  const missingValue = (v: unknown) => v == null || v === "" || (typeof v === "number" && !Number.isFinite(v));
  values.forEach((v, i) => {
    const w = weights?.[i] ?? 1;
    if (!(w > 0)) return;              // a zero-weight case is not in the base, as in describe()
    weightedN += w;
    const codes = Array.isArray(v) ? v.filter((x) => !missingValue(x)).map(String) : missingValue(v) ? [] : [String(v)];
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
  // `n` counts the cases in the base, so valid + missing still reconciles
  // once zero-weight cases are excluded above
  const inBase = weights ? weights.reduce((t, w) => t + (w > 0 ? 1 : 0), 0) : values.length;
  return { rows, n: inBase, valid, missing: inBase - valid, weightedN, weightedValid };
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
