/**
 * Choice-design efficiency for CBC (conjoint audit, 2026-10-17).
 *
 * ## What is measured
 *
 * D-efficiency of the main-effects multinomial-logit model at β = 0 — the
 * standard measure of a choice design's statistical quality when nothing is
 * known about the utilities in advance (Huber & Zwerina 1996; Street &
 * Burgess 2007). Each attribute is coded with ORTHONORMAL contrasts, so the
 * information a choice set of m concepts contributes is
 *
 *     I_s = (1/m) Σ_j (x_j − x̄)(x_j − x̄)ᵀ
 *
 * and the design's information is the average over its choice sets.
 *
 * ## Relative to what
 *
 * To an upper bound that is exact for main effects: with orthonormal codes the
 * squared distance between two different levels is 2, so the trace of an
 * attribute's block in one choice set is 2·D/m², where D is the number of
 * concept pairs that differ on that attribute. D is at most S_q, the Street–
 * Burgess maximum (levels spread as evenly as possible over the m concepts),
 * and for a fixed trace the determinant is largest when the block is a
 * multiple of the identity with no correlation to other attributes. So
 *
 *     det(I) ≤ Π_q ( 2·S_q / (m²·(l_q − 1)) )^(l_q − 1)
 *
 * and D-efficiency = (det(I) / bound)^(1/p), p = Σ(l_q − 1). 100% means no
 * main-effects design with these attributes and m concepts per task can be
 * more efficient; a prohibition can make 100% unreachable, which is the cost
 * the summary should show.
 *
 * The None alternative is excluded (it carries no attribute information);
 * holdout tasks are excluded (they are not estimated from).
 */

export interface EfficiencyAttribute { name: string; levels: string[] }

/** l × (l − 1) orthonormal contrasts (Helmert, normalised): columns orthonormal and orthogonal to 1. */
export function orthonormalContrasts(l: number): number[][] {
  const C = Array.from({ length: l }, () => new Array(Math.max(0, l - 1)).fill(0));
  for (let k = 1; k < l; k++) {
    const d = Math.sqrt(k * (k + 1));
    for (let i = 0; i < k; i++) C[i][k - 1] = 1 / d;
    C[k][k - 1] = -k / d;
  }
  return C;
}

/** Street–Burgess S_q: the most concept pairs that can differ on an attribute of l levels in a set of m. */
export function maxDifferingPairs(m: number, l: number): number {
  const x = Math.floor(m / l), y = m % l;
  return (m * m - (l * x * x + 2 * x * y + y)) / 2;
}

/** log det of a symmetric positive-definite matrix by Cholesky; −Infinity when it is not positive definite. */
export function logDetSPD(M: Float64Array, p: number, work?: Float64Array): number {
  const L = work && work.length >= p * p ? work : new Float64Array(p * p);
  let ld = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let s = M[i * p + j];
      for (let k = 0; k < j; k++) s -= L[i * p + k] * L[j * p + k];
      if (i === j) {
        if (!(s > 1e-12)) return -Infinity;
        const r = Math.sqrt(s);
        L[i * p + i] = r;
        ld += Math.log(r);
      } else {
        L[i * p + j] = s / L[j * p + j];
      }
    }
  }
  return 2 * ld;
}

/** A coder for one design: profile → orthonormal-coded vector, and the per-set information. */
export function makeCoder(attributes: EfficiencyAttribute[]) {
  const codes = attributes.map((a) => orthonormalContrasts(a.levels.length));
  const offsets: number[] = [];
  let p = 0;
  for (const a of attributes) { offsets.push(p); p += Math.max(0, a.levels.length - 1); }
  const levelIndex = attributes.map((a) => new Map(a.levels.map((l, i) => [l, i])));
  const encode = (profile: Record<string, unknown>): Float64Array => {
    const x = new Float64Array(p);
    attributes.forEach((a, q) => {
      const li = levelIndex[q].get(String(profile[a.name]));
      if (li === undefined) return;
      const row = codes[q][li];
      for (let k = 0; k < row.length; k++) x[offsets[q] + k] = row[k];
    });
    return x;
  };
  /** information of one choice set (β = 0), added into `out` with weight w */
  const addSetInfo = (X: Float64Array[], out: Float64Array, w = 1) => {
    const m = X.length;
    if (m < 2) return;
    const xb = new Float64Array(p);
    for (const x of X) for (let i = 0; i < p; i++) xb[i] += x[i] / m;
    for (const x of X) {
      for (let i = 0; i < p; i++) {
        const di = x[i] - xb[i];
        if (di === 0) continue;
        for (let j = 0; j < p; j++) out[i * p + j] += (w * di * (x[j] - xb[j])) / m;
      }
    }
  };
  /** log of the upper bound on det(average set information) for sets of m concepts */
  const logBound = (m: number) =>
    attributes.reduce((t, a) => {
      const l = a.levels.length;
      if (l < 2) return t;
      return t + (l - 1) * Math.log((2 * maxDifferingPairs(m, l)) / (m * m * (l - 1)));
    }, 0);
  return { p, encode, addSetInfo, logBound };
}

/**
 * D-efficiency (0..1) of a set of choice sets, each a list of concepts
 * (attribute → level). Sets of different sizes are allowed; the bound uses
 * the most common size.
 */
export function choiceDEfficiency(attributes: EfficiencyAttribute[], sets: Record<string, unknown>[][]): number | null {
  const usable = sets.filter((s) => s.length >= 2);
  if (!usable.length || !attributes.length) return null;
  const coder = makeCoder(attributes);
  if (coder.p === 0) return null;
  const M = new Float64Array(coder.p * coder.p);
  for (const s of usable) coder.addSetInfo(s.map(coder.encode), M, 1 / usable.length);
  const ld = logDetSPD(M, coder.p);
  if (ld === -Infinity) return 0;
  const sizes = new Map<number, number>();
  for (const s of usable) sizes.set(s.length, (sizes.get(s.length) ?? 0) + 1);
  const m = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return Math.min(1, Math.exp((ld - coder.logBound(m)) / coder.p));
}

export interface ConjointEfficiency {
  method: "d_efficiency_mnl_beta0";
  /** the whole design (all versions pooled) — what an aggregate model estimates from */
  pooled: number | null;
  /** each version on its own — what one respondent answers (matters for individual-level models) */
  perVersion: { mean: number | null; min: number | null; max: number | null; versions: number };
  /** % of task × attribute cells that repeat a level although the task had room for distinct levels */
  avoidableOverlapPct: number;
  /** % of task × attribute cells that repeat a level at all (unavoidable when levels < concepts) */
  overlapPct: number;
  /** tasks containing the same concept twice (must be 0) */
  duplicateConceptTasks: number;
  /** main-effects parameters (Σ levels − 1) */
  parameters: number;
  /** the fewest choice degrees of freedom one version gives (Σ over its tasks of concepts − 1); below `parameters` one respondent's answers cannot identify the model */
  minVersionDegreesOfFreedom: number;
}

/**
 * Measure a generated CBC design: D-efficiency pooled and per version, level
 * overlap within tasks, duplicate concepts. Rows are the generator's rows;
 * holdouts and the None row are ignored.
 */
export function measureConjointDesign(attributes: EfficiencyAttribute[], rows: Record<string, unknown>[]): ConjointEfficiency {
  const real = rows.filter((r) => Number(r.none_option) !== 1 && Number(r.is_holdout) !== 1);
  const byTask = new Map<string, Record<string, unknown>[]>();
  const byVersion = new Map<string, Map<string, Record<string, unknown>[]>>();
  for (const r of real) {
    const v = String(r.version ?? "1"), t = String(r.task);
    const k = `${v}\u0000${t}`;
    (byTask.get(k) ?? byTask.set(k, []).get(k)!).push(r);
    const vm = byVersion.get(v) ?? byVersion.set(v, new Map()).get(v)!;
    (vm.get(t) ?? vm.set(t, []).get(t)!).push(r);
  }
  let cells = 0, overlap = 0, avoidable = 0, dup = 0;
  for (const alts of byTask.values()) {
    const keys = alts.map((r) => attributes.map((a) => String(r[a.name])).join("\u0001"));
    if (new Set(keys).size !== keys.length) dup++;
    for (const a of attributes) {
      cells++;
      const distinct = new Set(alts.map((r) => String(r[a.name]))).size;
      if (distinct < alts.length) overlap++;
      if (distinct < Math.min(alts.length, a.levels.length)) avoidable++;
    }
  }
  const per = [...byVersion.values()].map((vm) => choiceDEfficiency(attributes, [...vm.values()])).filter((x): x is number => x !== null);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    method: "d_efficiency_mnl_beta0",
    pooled: (() => { const d = choiceDEfficiency(attributes, [...byTask.values()]); return d === null ? null : r3(d); })(),
    perVersion: {
      mean: per.length ? r3(per.reduce((t, x) => t + x, 0) / per.length) : null,
      min: per.length ? r3(Math.min(...per)) : null,
      max: per.length ? r3(Math.max(...per)) : null,
      versions: byVersion.size,
    },
    avoidableOverlapPct: cells ? Math.round((1000 * avoidable) / cells) / 10 : 0,
    overlapPct: cells ? Math.round((1000 * overlap) / cells) / 10 : 0,
    duplicateConceptTasks: dup,
    parameters: attributes.reduce((t, a) => t + Math.max(0, a.levels.length - 1), 0),
    minVersionDegreesOfFreedom: byVersion.size
      ? Math.min(...[...byVersion.values()].map((vm) => [...vm.values()].reduce((t, alts) => t + Math.max(0, alts.length - 1), 0)))
      : 0,
  };
}

/**
 * EFFICIENT DESIGN BY LEVEL SWAPPING (Huber & Zwerina 1996, "swapping").
 *
 * Starting from a level-balanced design, try exchanging the levels of one
 * attribute between two concepts of the same version; keep the exchange when
 * it raises det(information) at β = 0 and both new concepts are legal and new
 * to their tasks. A swap moves levels between concepts without changing how
 * often each level is shown, so the one-way level balance of the starting
 * design is preserved EXACTLY — efficiency is gained from the arrangement,
 * never by showing some levels more than others. Deterministic: the order the
 * pairs are tried in comes from the seeded RNG passed in, and the number of
 * passes is bounded (not timed), so (config, seed) → the same design.
 *
 * `tasks` is one version's estimation tasks (holdouts excluded), each a list
 * of profiles; it is modified in place.
 */
export function swapImprove(
  attributes: EfficiencyAttribute[],
  tasks: Record<string, string>[][],
  isLegal: ((profile: Record<string, string>) => boolean) | null,
  rng: () => number,
  /*
   * `fixed` (F4 2026-10-22, alternative-specific designs): attributes never swapped — the brand of a
   * labelled or alternative-specific design decides which other attributes a concept carries. A level
   * of "" means NOT APPLICABLE (an attribute that does not apply to that concept's brand): it codes as
   * zeros and is never swapped. Neither occurs in a generic design, so its swaps are exactly as before.
   */
  opts: { maxPasses?: number; maxEvaluations?: number; fixed?: string[] } = {},
): { passes: number; swaps: number; evaluations: number; exhausted: boolean } {
  const maxPasses = opts.maxPasses ?? 8;
  const maxEvaluations = opts.maxEvaluations ?? Infinity;
  const Q = attributes.length;
  const codes = attributes.map((a) => orthonormalContrasts(a.levels.length));
  const offsets: number[] = [];
  let p = 0;
  for (const a of attributes) { offsets.push(p); p += Math.max(0, a.levels.length - 1); }
  if (p === 0 || tasks.length === 0) return { passes: 0, swaps: 0, evaluations: 0, exhausted: false };
  const levelIndex = attributes.map((a) => new Map(a.levels.map((l, i) => [l, i])));
  /* concepts as level indices; a concept's key is its mixed-radix number */
  const L: number[][][] = tasks.map((ts) => ts.map((pr) => attributes.map((a, q) => (pr[a.name] === "" ? -1 : levelIndex[q].get(pr[a.name]) ?? 0))));
  const fixedQ = new Set((opts.fixed ?? []).map((n) => attributes.findIndex((a) => a.name === n)).filter((q) => q >= 0));
  const radix: number[] = [];
  { let r = 1; for (const a of attributes) { radix.push(r); r *= Math.max(1, a.levels.length) + 1; } }
  const keyOf = (lv: number[]) => { let k = 0; for (let q = 0; q < Q; q++) k += (lv[q] + 1) * radix[q]; return k; };
  const profileOf = (lv: number[]) => Object.fromEntries(attributes.map((a, q) => [a.name, lv[q] < 0 ? "" : a.levels[lv[q]]]));
  const maxM = Math.max(...tasks.map((t) => t.length));
  const X = new Float64Array(maxM * p), xb = new Float64Array(p);
  /** information of task t (with concept j1/j2 replaced), written into out */
  const taskInfo = (t: number, out: Float64Array, j1 = -1, c1: number[] | null = null, j2 = -1, c2: number[] | null = null) => {
    out.fill(0);
    const m = L[t].length;
    if (m < 2) return;
    xb.fill(0);
    const inv = 1 / m;
    for (let j = 0; j < m; j++) {
      const lv = j === j1 ? c1! : j === j2 ? c2! : L[t][j];
      for (let q = 0; q < Q; q++) {
        if (lv[q] < 0) { for (let k = 0; k < codes[q][0].length; k++) X[j * p + offsets[q] + k] = 0; continue; }
        const row = codes[q][lv[q]], o = offsets[q];
        for (let k = 0; k < row.length; k++) { X[j * p + o + k] = row[k]; xb[o + k] += row[k] * inv; }
      }
    }
    for (let j = 0; j < m; j++) {
      const b = j * p;
      for (let i = 0; i < p; i++) X[b + i] -= xb[i];
      for (let i = 0; i < p; i++) {
        const di = X[b + i] * inv;
        if (di === 0) continue;
        const r = i * p;
        for (let k = i; k < p; k++) out[r + k] += di * X[b + k];
      }
    }
    for (let i = 0; i < p; i++) for (let k = 0; k < i; k++) out[i * p + k] = out[k * p + i];
  };
  const infos = L.map((_, t) => { const o = new Float64Array(p * p); taskInfo(t, o); return o; });
  const M = new Float64Array(p * p);
  for (const I of infos) for (let i = 0; i < M.length; i++) M[i] += I[i];
  // a tiny ridge so a design that starts singular can still be compared and improved
  const ridge = 1e-9;
  const scratch = new Float64Array(p * p), chol = new Float64Array(p * p), next = new Float64Array(p * p), newA = new Float64Array(p * p), newB = new Float64Array(p * p);
  const ld = (A: Float64Array) => { scratch.set(A); for (let i = 0; i < p; i++) scratch[i * p + i] += ridge; return logDetSPD(scratch, p, chol); };
  let cur = ld(M);
  const concepts: [number, number][] = [];
  L.forEach((ts, t) => ts.forEach((_, j) => concepts.push([t, j])));
  const order: [number, number][] = [];
  for (let a = 0; a < concepts.length; a++) for (let b = a + 1; b < concepts.length; b++) order.push([a, b]);
  let passes = 0, swaps = 0, evaluations = 0, exhausted = false;
  for (; passes < maxPasses && !exhausted; passes++) {
    let improved = false;
    // the pairs in a seeded order, so no task or concept is always tried first
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const [ca, cb] of order) {
      if (evaluations >= maxEvaluations) { exhausted = true; break; }
      const [ta, ja] = concepts[ca], [tb, jb] = concepts[cb];
      for (let q = 0; q < Q; q++) {
        const A = L[ta][ja], B = L[tb][jb];
        if (A[q] === B[q] || A[q] < 0 || B[q] < 0 || fixedQ.has(q)) continue;
        const A2 = A.slice(), B2 = B.slice();
        A2[q] = B[q]; B2[q] = A[q];
        if (isLegal && (!isLegal(profileOf(A2)) || !isLegal(profileOf(B2)))) continue;
        // both concepts must stay new to their tasks
        const ka = keyOf(A2), kb = keyOf(B2);
        let clash = false;
        for (let j = 0; j < L[ta].length && !clash; j++) if (j !== ja && !(ta === tb && j === jb) && keyOf(L[ta][j]) === ka) clash = true;
        for (let j = 0; j < L[tb].length && !clash; j++) if (j !== jb && !(ta === tb && j === ja) && keyOf(L[tb][j]) === kb) clash = true;
        if (clash || (ta === tb && ka === kb)) continue;
        evaluations++;
        if (ta === tb) taskInfo(ta, newA, ja, A2, jb, B2);
        else { taskInfo(ta, newA, ja, A2); taskInfo(tb, newB, jb, B2); }
        for (let i = 0; i < next.length; i++) {
          next[i] = M[i] + newA[i] - infos[ta][i] + (ta === tb ? 0 : newB[i] - infos[tb][i]);
        }
        const val = ld(next);
        if (val > cur + 1e-10 * Math.max(1, Math.abs(cur))) {
          L[ta][ja] = A2; L[tb][jb] = B2;
          infos[ta].set(newA); if (ta !== tb) infos[tb].set(newB);
          M.set(next); cur = val; swaps++; improved = true;
        }
      }
    }
    if (!improved) { passes++; break; }
  }
  // write the result back as profiles
  L.forEach((ts, t) => ts.forEach((lv, j) => { tasks[t][j] = profileOf(lv); }));
  return { passes, swaps, evaluations, exhausted };
}
