import type { DesignGeneratorPlugin } from "@rescript/schema";
import { mulberry32, subSeed } from "@rescript/engine";
import { conceptMatches, effectiveProhibition, type ConjointAttribute, type ConjointProhibition } from "./conjoint.js";
import { makeCoder, logDetSPD } from "./conjointEfficiency.js";
import { maxdiffPlugin } from "./maxdiff.js";

/**
 * CUSTOM EXPERIMENTAL DESIGN (2026-11-09) — the design techniques a researcher reaches for when no packaged method
 * fits, each built by a proper algorithm and reported with the statistics that say whether it is sound:
 *
 *   full_factorial   every combination of the factors' levels (all effects estimable); refused above 5,000 runs
 *   fractional       a D-optimal fraction for main effects: Fedorov exchange over the (constraint-filtered) full
 *                    factorial, from several random starts; reports D-efficiency against an orthogonal array,
 *                    level balance and the largest correlation between factors — the design an "efficient /
 *                    optimized design" request means
 *   latin_square     each treatment once in each position across n sequences (order effects cancel)
 *   williams         a Williams design: order AND first-order carry-over balanced (each treatment follows each
 *                    other equally often) — n sequences for even n, 2n for odd
 *   bibd             balanced incomplete blocks: v treatments in blocks of k, each pair together as equally as
 *                    possible (the MaxDiff construction, reused)
 *
 * Rows: version (the block / sequence / respondent group), run or position, then the factors or the treatment.
 * Deterministic from the seed.
 */
export type ExperimentType = "full_factorial" | "fractional" | "latin_square" | "williams" | "bibd";
export interface ExperimentConfig {
  designType: ExperimentType;
  /** factorial designs: factors and their levels */
  factors?: ConjointAttribute[];
  /** order / block designs: the treatments (concepts, ads, products…) */
  treatments?: string[];
  /** fractional: runs (blank = recommended); full factorial: replicates are versions */
  runs?: number;
  /** bibd: treatments per block (blank = recommended) */
  blockSize?: number;
  /** bibd: blocks (blank = so each treatment appears at least 3 times) */
  blocks?: number;
  /** split the runs into this many blocks (factorial designs), balanced where possible */
  versions?: number;
  /** level combinations that may never occur (factorial designs) */
  prohibitions?: ConjointProhibition[];
  /** shuffle run order within each block */
  randomizeOrder?: boolean;
}

const MAX_FULL = 5000;
const MAX_CANDIDATES = 20000;

/** every combination, in order, without the prohibited ones */
export function fullFactorial(factors: ConjointAttribute[], prohibitions: ConjointProhibition[] = [], cap = MAX_CANDIDATES): Record<string, string>[] | null {
  const total = factors.reduce((t, f) => t * Math.max(1, f.levels.length), 1);
  if (total > cap) return null;
  const rules = prohibitions.map(effectiveProhibition);
  const out: Record<string, string>[] = [];
  const idx = factors.map(() => 0);
  for (let n = 0; n < total; n++) {
    const row: Record<string, string> = {};
    factors.forEach((f, i) => { row[f.name] = f.levels[idx[i]]; });
    if (!rules.some((r) => conceptMatches(row, r))) out.push(row);
    for (let i = factors.length - 1; i >= 0; i--) { idx[i]++; if (idx[i] < factors[i].levels.length) break; idx[i] = 0; }
  }
  return out;
}

/** main-effects parameters (plus the intercept) — the fewest runs that can estimate them */
export const mainEffectsParameters = (factors: ConjointAttribute[]) => 1 + factors.reduce((t, f) => t + Math.max(0, f.levels.length - 1), 0);

/** the run size an orthogonal main-effects design would like: ≥ parameters, divisible by each level count and by each pair's product where cheap */
export function recommendedRuns(factors: ConjointAttribute[]): number {
  const p = mainEffectsParameters(factors);
  const ls = factors.map((f) => f.levels.length).filter((l) => l > 1);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const lcm = (a: number, b: number) => (a * b) / gcd(a, b);
  const l1 = ls.reduce(lcm, 1);
  let pairs = l1;
  for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) pairs = lcm(pairs, ls[i] * ls[j]);
  const full = factors.reduce((t, f) => t * Math.max(1, f.levels.length), 1);
  for (const step of [pairs, l1]) {
    const n = Math.ceil(Math.max(p, 2) / step) * step;
    if (n <= Math.min(full, 4 * Math.max(p, 8))) return n;
  }
  return Math.min(full, Math.max(p + 2, Math.ceil(1.5 * p)));
}

export interface ExperimentQuality {
  runs: number;
  parameters: number;
  /** linear main-effects D-efficiency vs an orthogonal balanced design, 0–100 (100 = orthogonal) */
  dEfficiency: number | null;
  /** per factor: [fewest, most] appearances of a level */
  levelBalance: { factor: string; min: number; max: number }[];
  /** the largest absolute correlation between two factors' coded columns */
  maxCorrelation: number | null;
  estimable: boolean;
  notes: string[];
}

/** information matrix X'X (orthonormal coding with intercept) of a set of runs */
function infoMatrix(coder: ReturnType<typeof makeCoder>, runs: Record<string, string>[]): Float64Array {
  const p = coder.p + 1;
  const M = new Float64Array(p * p);
  for (const r of runs) {
    const x = [1, ...coder.encode(r)];
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) M[i * p + j] += x[i] * x[j];
  }
  return M;
}

export function measureExperiment(factors: ConjointAttribute[], runs: Record<string, string>[]): ExperimentQuality {
  const notes: string[] = [];
  const coder = makeCoder(factors);
  const p = coder.p + 1;
  const n = runs.length;
  const M = infoMatrix(coder, runs);
  /*
   * Orthonormal contrasts give a balanced l-level factor X'X = (n / l)·I on its columns. Scaled by √l, an orthogonal
   * balanced design has X'X = n·I, so D-efficiency = det(X'X / n)^(1/p) — 100% for an orthogonal array.
   */
  const scale = [1, ...factors.flatMap((f) => Array.from({ length: Math.max(0, f.levels.length - 1) }, () => Math.sqrt(f.levels.length)))];
  const scaled = M.map((v, k) => (v * scale[Math.floor(k / p)] * scale[k % p]) / Math.max(1, n));
  const ld = logDetSPD(scaled, p);
  const estimable = Number.isFinite(ld) && n >= p;
  const dEfficiency = estimable ? Math.round(Math.exp(ld / p) * 1000) / 10 : null;
  if (!estimable) notes.push(`Not every main effect can be estimated: ${n} runs for ${p} parameters, or factors confounded.`);
  const levelBalance = factors.map((f) => { const c = f.levels.map((l) => runs.filter((r) => r[f.name] === l).length); return { factor: f.name, min: Math.min(...c), max: Math.max(...c) }; });
  /* correlation between factors: average |r| between their coded columns, max over pairs */
  let maxCorrelation: number | null = null;
  if (factors.length > 1 && n > 2) {
    const cols = runs.map((r) => coder.encode(r));
    const offs: number[] = []; let o = 0; for (const f of factors) { offs.push(o); o += Math.max(0, f.levels.length - 1); }
    const corr = (a: number, b: number) => {
      const ma = cols.reduce((t, c) => t + c[a], 0) / n, mb = cols.reduce((t, c) => t + c[b], 0) / n;
      let sab = 0, saa = 0, sbb = 0;
      for (const c of cols) { sab += (c[a] - ma) * (c[b] - mb); saa += (c[a] - ma) ** 2; sbb += (c[b] - mb) ** 2; }
      return saa && sbb ? Math.abs(sab / Math.sqrt(saa * sbb)) : 0;
    };
    let worst = 0;
    for (let i = 0; i < factors.length; i++) for (let j = i + 1; j < factors.length; j++)
      for (let a = 0; a < factors[i].levels.length - 1; a++) for (let b = 0; b < factors[j].levels.length - 1; b++) worst = Math.max(worst, corr(offs[i] + a, offs[j] + b));
    maxCorrelation = Math.round(worst * 1000) / 1000;
  }
  return { runs: n, parameters: p, dEfficiency, levelBalance, maxCorrelation, estimable, notes };
}

/* ---------------------------------------------------------------- D-optimal exchange */

function invert(M: Float64Array, p: number): Float64Array | null {
  const A = new Float64Array(M), I = new Float64Array(p * p);
  for (let i = 0; i < p; i++) I[i * p + i] = 1;
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r * p + c]) > Math.abs(A[piv * p + c])) piv = r;
    if (Math.abs(A[piv * p + c]) < 1e-12) return null;
    if (piv !== c) for (let k = 0; k < p; k++) { [A[c * p + k], A[piv * p + k]] = [A[piv * p + k], A[c * p + k]]; [I[c * p + k], I[piv * p + k]] = [I[piv * p + k], I[c * p + k]]; }
    const d = A[c * p + c];
    for (let k = 0; k < p; k++) { A[c * p + k] /= d; I[c * p + k] /= d; }
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = A[r * p + c]; if (!f) continue; for (let k = 0; k < p; k++) { A[r * p + k] -= f * A[c * p + k]; I[r * p + k] -= f * I[c * p + k]; } }
  }
  return I;
}

/** Fedorov exchange: N runs from the candidates maximising det(X'X), best of several random starts */
export function dOptimal(factors: ConjointAttribute[], candidates: Record<string, string>[], N: number, seed: number, starts = candidates.length > 1500 ? 2 : 4): Record<string, string>[] {
  const coder = makeCoder(factors);
  const p = coder.p + 1;
  const X = candidates.map((c) => Float64Array.from([1, ...coder.encode(c)]));
  let best: number[] = [], bestLd = -Infinity;
  for (let s = 0; s < starts; s++) {
    const rand = mulberry32(subSeed(seed, `dopt:${s}`));
    /* a balanced-ish random start: cycle through a shuffled candidate list */
    const order = candidates.map((_, i) => i).sort(() => rand() - 0.5);
    let design = Array.from({ length: N }, (_, i) => order[i % order.length]);
    const info = () => { const M = new Float64Array(p * p); for (const d of design) { const x = X[d]; for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) M[i * p + j] += x[i] * x[j]; } for (let i = 0; i < p; i++) M[i * p + i] += 1e-6; return M; };
    for (let pass = 0; pass < 12; pass++) {
      let improved = false;
      /* large candidate sets: each pass looks at a fresh random sample (Fedorov with sampled candidates) */
      const pool = X.length > 1500 ? Array.from({ length: 1500 }, () => Math.floor(rand() * X.length)) : X.map((_, i) => i);
      for (let r = 0; r < N; r++) {
        const Mi = invert(info(), p);
        if (!Mi) break;
        const xo = X[design[r]];
        const mo = new Float64Array(p);
        for (let i = 0; i < p; i++) { let t = 0; for (let j = 0; j < p; j++) t += Mi[i * p + j] * xo[j]; mo[i] = t; }
        let dOld = 0; for (let i = 0; i < p; i++) dOld += xo[i] * mo[i];
        let bestDelta = 1e-9, bestC = -1;
        for (const c of pool) {
          if (c === design[r]) continue;
          const xn = X[c];
          let dNew = 0, dCross = 0;
          for (let i = 0; i < p; i++) { let t = 0; for (let j = 0; j < p; j++) t += Mi[i * p + j] * xn[j]; dNew += xn[i] * t; dCross += xn[i] * mo[i]; }
          const delta = dNew - dOld - (dNew * dOld - dCross * dCross);
          if (delta > bestDelta) { bestDelta = delta; bestC = c; }
        }
        if (bestC >= 0) { design[r] = bestC; improved = true; }
      }
      if (!improved) break;
    }
    const ld = logDetSPD(info(), p);
    if (ld > bestLd) { bestLd = ld; best = design.slice(); }
  }
  return best.map((i) => candidates[i]);
}

/* ---------------------------------------------------------------- order designs */

/** cyclic Latin square: sequence i, position j → treatment (i + j) mod n */
export function latinSquare(n: number): number[][] { return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i + j) % n)); }

/** Williams design: rows balanced for position and first-order carry-over (2n rows when n is odd) */
export function williams(n: number): number[][] {
  const first: number[] = [];
  for (let j = 0, lo = 0, hi = n - 1; j < n; j++) first.push(j % 2 === 0 ? lo++ : hi--);
  const rows = Array.from({ length: n }, (_, i) => first.map((t) => (t + i) % n));
  return n % 2 === 0 ? rows : [...rows, ...rows.map((r) => [...r].reverse())];
}

export function carryoverBalance(seqs: number[][], n: number): { min: number; max: number } {
  const c = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const s of seqs) for (let i = 1; i < s.length; i++) c[s[i - 1]][s[i]]++;
  const vals: number[] = []; for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (a !== b) vals.push(c[a][b]);
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

/* ---------------------------------------------------------------- the plugin */

function shuffleWithin<T>(xs: T[], rand: () => number): T[] { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export function validateExperiment(c: ExperimentConfig): string[] {
  const e: string[] = [];
  const t = c.designType;
  if (!["full_factorial", "fractional", "latin_square", "williams", "bibd"].includes(t)) e.push("Choose a design type.");
  if (t === "full_factorial" || t === "fractional") {
    const f = (c.factors ?? []).filter((x) => x.name?.trim());
    if (f.length < 1) e.push("Add at least one factor.");
    for (const x of f) if (x.levels.length < 2) e.push(`Factor “${x.name}” needs at least two levels.`);
    if (new Set(f.map((x) => x.name)).size !== f.length) e.push("Factor names must be unique.");
    const total = f.reduce((s, x) => s * Math.max(1, x.levels.length), 1);
    if (t === "full_factorial" && total > MAX_FULL) e.push(`A full factorial of these factors has ${total.toLocaleString("en")} runs — use a fractional (D-optimal) design.`);
    if (t === "fractional" && total > MAX_CANDIDATES) e.push(`These factors have ${total.toLocaleString("en")} combinations — more than this generator searches (${MAX_CANDIDATES.toLocaleString("en")}). Reduce levels, or use choice-based conjoint, which handles large designs.`);
    if (t === "fractional" && c.runs != null && c.runs < mainEffectsParameters(f)) e.push(`${c.runs} runs cannot estimate ${mainEffectsParameters(f)} main-effect parameters — use at least ${mainEffectsParameters(f)}.`);
  } else {
    const tr = (c.treatments ?? []).filter((x) => x.trim());
    if (tr.length < 2) e.push("Add at least two treatments.");
    if (t === "bibd") { const k = c.blockSize ?? 0; if (k && (k < 2 || k >= tr.length)) e.push("Block size must be at least 2 and smaller than the number of treatments."); }
    if ((t === "latin_square" || t === "williams") && tr.length > 26) e.push("Order designs above 26 treatments are impractical for respondents.");
  }
  if ((c.versions ?? 1) < 1) e.push("Versions must be at least 1.");
  return e;
}

export const experimentPlugin: DesignGeneratorPlugin<ExperimentConfig> = {
  kind: "experiment",
  label: "Custom experimental design",
  description: "Full or D-optimal fractional factorial, Latin square, Williams (carry-over balanced) or balanced incomplete block designs — with D-efficiency, level balance and correlation reported.",
  configFields: [
    { name: "designType", label: "Design type", type: "select", options: ["fractional", "full_factorial", "latin_square", "williams", "bibd"], default: "fractional", help: "fractional — D-optimal main-effects fraction; full_factorial — every combination; latin_square / williams — the order treatments are shown in (williams also balances which follows which); bibd — treatments in balanced subsets." },
    { name: "factors", label: "Factors & levels (factorial designs)", type: "attributes", help: "Each factor needs at least two levels." },
    { name: "prohibitions", label: "Combinations that may never occur (factorial designs)", type: "prohibitions" },
    { name: "runs", label: "Runs (fractional; blank = recommended)", type: "number" },
    { name: "treatments", label: "Treatments (order and block designs)", type: "list", help: "Concepts, ads, products… one per line." },
    { name: "blockSize", label: "Treatments per block (bibd; blank = recommended)", type: "number" },
    { name: "blocks", label: "Blocks (bibd; blank = each treatment at least 3 times)", type: "number" },
    { name: "versions", label: "Versions / blocks of runs (factorial designs)", type: "number", default: 1 },
    { name: "randomizeOrder", label: "Shuffle the run order within each version", type: "boolean", default: true },
  ],
  validateConfig: validateExperiment,
  generate(config, seed) {
    const errs = validateExperiment(config);
    if (errs.length) throw new Error(errs.join(" "));
    const rand = mulberry32(subSeed(seed, "experiment"));
    const t = config.designType;
    if (t === "full_factorial" || t === "fractional") {
      const factors = (config.factors ?? []).filter((f) => f.name.trim());
      const candidates = fullFactorial(factors, config.prohibitions ?? [])!;
      if (!candidates.length) throw new Error("Every combination is prohibited — loosen the prohibitions.");
      const N = t === "full_factorial" ? candidates.length : Math.min(config.runs ?? recommendedRuns(factors), Math.max(candidates.length, mainEffectsParameters(factors)));
      let runs = t === "full_factorial" ? candidates : dOptimal(factors, candidates, N, seed);
      const versions = Math.max(1, Math.min(config.versions ?? 1, runs.length));
      /* blocks: deal runs in a level-balancing round-robin of the first factor, then by position */
      const sorted = [...runs].sort((a, b) => factors[0].levels.indexOf(a[factors[0].name]) - factors[0].levels.indexOf(b[factors[0].name]));
      const byVersion: Record<string, string>[][] = Array.from({ length: versions }, () => []);
      sorted.forEach((r, i) => byVersion[i % versions].push(r));
      const rows: Record<string, unknown>[] = [];
      byVersion.forEach((rs, v) => { (config.randomizeOrder !== false ? shuffleWithin(rs, rand) : rs).forEach((r, i) => rows.push({ version: v + 1, run: i + 1, ...r })); });
      runs = rows.map((r) => Object.fromEntries(factors.map((f) => [f.name, String(r[f.name])])));
      const q = measureExperiment(factors, runs);
      const totalCombos = factors.reduce((s, f) => s * f.levels.length, 1);
      return {
        columns: ["version", "run", ...factors.map((f) => f.name)], rows,
        summary: { designType: t, ...q, totalCombinations: totalCombos, prohibitedCombinations: totalCombos - candidates.length, recommendedRuns: recommendedRuns(factors),
          explanation: t === "full_factorial"
            ? `All ${q.runs} combinations of ${factors.length} factors: every main effect and interaction can be estimated.`
            : `${q.runs} of ${candidates.length} possible combinations, chosen by a D-optimal (Fedorov) exchange to estimate ${q.parameters - 1} main-effect parameters plus the intercept. D-efficiency ${q.dEfficiency ?? "—"}% against an orthogonal array (100% = orthogonal); interactions are not estimable from a main-effects fraction.` },
      };
    }
    const treatments = (config.treatments ?? []).map((x) => x.trim()).filter(Boolean);
    const n = treatments.length;
    if (t === "latin_square" || t === "williams") {
      const seqs = t === "latin_square" ? latinSquare(n) : williams(n);
      const perm = shuffleWithin(treatments.map((_, i) => i), rand);
      const rows = seqs.flatMap((s, v) => s.map((ti, pos) => ({ version: v + 1, position: pos + 1, treatment: treatments[perm[ti]] })));
      const carry = carryoverBalance(seqs, n);
      return {
        columns: ["version", "position", "treatment"], rows,
        summary: { designType: t, sequences: seqs.length, treatments: n, positionBalanced: true, carryover: carry, carryoverBalanced: carry.min === carry.max,
          explanation: t === "williams"
            ? `${seqs.length} sequences: each treatment appears once in every position${seqs.length > n ? " per half" : ""} and follows every other treatment ${carry.min === carry.max ? `exactly ${carry.min} time${carry.min === 1 ? "" : "s"}` : `${carry.min}–${carry.max} times`} — order and carry-over effects are balanced. Assign respondents to sequences in equal numbers.`
            : `${n} sequences: each treatment appears once in every position, so position effects cancel when respondents are spread evenly across sequences. First-order carry-over is not balanced — use Williams when it matters.` },
      };
    }
    /* bibd via the MaxDiff construction (the same balancing of pairs and positions) */
    const k = config.blockSize ?? Math.max(2, Math.min(n - 1, n <= 6 ? 3 : n <= 12 ? 4 : 5));
    const b = config.blocks ?? Math.ceil((3 * n) / k);
    const md = maxdiffPlugin.generate({ items: treatments, itemsPerTask: k, tasks: b, versions: 1 } as never, seed);
    const rows = md.rows.map((r) => ({ version: Number(r.task), position: Number(r.position), treatment: String(r.item_label) }));
    const appear = treatments.map((x) => rows.filter((r) => r.treatment === x).length);
    const pair = new Map<string, number>();
    for (let v = 1; v <= b; v++) { const blk = rows.filter((r) => r.version === v).map((r) => r.treatment).sort(); for (let i = 0; i < blk.length; i++) for (let j = i + 1; j < blk.length; j++) { const key = `${blk[i]}|${blk[j]}`; pair.set(key, (pair.get(key) ?? 0) + 1); } }
    const allPairs = (n * (n - 1)) / 2;
    const counts = [...pair.values()];
    const lmin = counts.length < allPairs ? 0 : Math.min(...counts), lmax = Math.max(0, ...counts);
    return {
      columns: ["version", "position", "treatment"], rows,
      summary: { designType: t, treatments: n, blockSize: k, blocks: b, appearances: { min: Math.min(...appear), max: Math.max(...appear) }, pairConcurrence: { min: lmin, max: lmax }, balanced: lmin === lmax && Math.min(...appear) === Math.max(...appear),
        explanation: `${b} blocks of ${k} from ${n} treatments: each appears ${Math.min(...appear) === Math.max(...appear) ? Math.min(...appear) : `${Math.min(...appear)}–${Math.max(...appear)}`} times and each pair shares a block ${lmin === lmax ? `exactly ${lmin}` : `${lmin}–${lmax}`} time${lmax === 1 ? "" : "s"}${lmin === lmax ? " — a balanced incomplete block design" : " — near-balanced (no exact BIBD exists for these sizes, or more blocks are needed)"}.` },
    };
  },
};
