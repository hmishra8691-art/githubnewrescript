/**
 * RATING-BASED CONJOINT (CVA, full profile) — the design generator. F4, 2026-10-22.
 *
 * Sawtooth's CVA: the respondent RATES full-profile concepts (0–10, or a likelihood-to-buy scale),
 * one at a time, or rates PAIRS of concepts on a preference scale ("strongly prefer left … strongly
 * prefer right"). Utilities are estimated per respondent by least squares (analytics conjoint/cva.ts),
 * so a version must have more profiles than parameters and an information matrix that is as close to
 * orthogonal as the levels allow.
 *
 * DESIGN. A D-optimal fractional factorial per version, from the legal candidate set (the full
 * factorial when it is at most 20 000 concepts, else a seeded sample of it) by Fedorov-style
 * exchange: start from a level-balanced selection, then repeatedly swap a design profile for the
 * candidate that most raises det(XᵀX) of the main-effects linear model, until no swap helps or the
 * evaluation budget is spent (a count, not a clock — the design is reproducible from (config, seed)).
 * The coding is orthonormal contrasts scaled by √levels, so an orthogonal, level-balanced design has
 * XᵀX / N = I and the reported D-efficiency (SAS %MktEx convention, 100 × det(XᵀX / N)^(1/p)) is
 * 100%. A PAIRED version is coded as differences (right − left), with no intercept; its efficiency
 * is reported against the most a difference can carry, 2l/(l−1) per column (the two profiles
 * always differ, levels drawn evenly).
 *
 * ROWS. `version, task, alt, is_holdout, <attributes…>` — one row per profile (alt 1), two per pair
 * (alt 1 = left, alt 2 = right). Holdout profiles (fixed, identical in every version) come last and
 * are flagged; they are rated but not estimated from.
 *
 * ANSWER. `{ "<task>": rating }` — a number on the configured scale.
 */
import type { DesignGeneratorPlugin } from "@rescript/schema";
import { mulberry32, subSeed } from "@rescript/engine";
import { conceptMatches, effectiveProhibition, type ConjointProhibition } from "./conjoint.js";
import { orthonormalContrasts } from "./conjointEfficiency.js";

export interface CvaConfig {
  attributes: { name: string; levels: string[] }[];
  prohibitions?: ConjointProhibition[];
  /** "single" (rate each profile) or "paired" (rate a pair on a preference scale); default single */
  mode?: "single" | "paired";
  /** profiles (single) or pairs (paired) per version; default ≈ 1.5 × parameters, at least parameters + 3 */
  profiles?: number;
  versions?: number;
  /** holdout profiles / pairs, identical in every version, not estimated from; default 0 */
  holdouts?: number;
  /** rating scale; default 0–10 (single), 1–9 (paired) */
  scaleMin?: number;
  scaleMax?: number;
  /** end labels shown under the scale (render time) */
  minLabel?: string;
  maxLabel?: string;
  /** "Attribute: increasing|decreasing" — the order of utilities the analysis may enforce (analysis option `monotone`) */
  monotone?: string[];
}

const CANDIDATE_CAP = 20_000;
const EXCHANGE_BUDGET = 400_000;

function normalize(c: CvaConfig) {
  const attrs = c.attributes ?? [];
  const params = attrs.reduce((t, a) => t + Math.max(0, (a.levels?.length ?? 0) - 1), 0);
  const mode = c.mode === "paired" ? "paired" : "single";
  const minProfiles = mode === "single" ? params + 1 : params;
  return {
    attributes: attrs,
    prohibitions: c.prohibitions ?? [],
    mode,
    params,
    profiles: c.profiles ?? Math.max(minProfiles + 3, Math.ceil(1.5 * minProfiles)),
    versions: c.versions ?? 1,
    holdouts: c.holdouts ?? 0,
    scaleMin: c.scaleMin ?? (mode === "paired" ? 1 : 0),
    scaleMax: c.scaleMax ?? (mode === "paired" ? 9 : 10),
  } as const;
}
export type CvaNormalized = ReturnType<typeof normalize>;
export const normalizeCva = normalize;

const violates = (p: Record<string, string>, pro: ConjointProhibition[]) => pro.some((x) => conceptMatches(p, effectiveProhibition(x)));

/** the coded row of a profile: √l-scaled orthonormal contrasts per attribute */
function coder(attrs: { name: string; levels: string[] }[]) {
  const codes = attrs.map((a) => orthonormalContrasts(a.levels.length).map((row) => row.map((v) => v * Math.sqrt(a.levels.length))));
  const p = attrs.reduce((t, a) => t + a.levels.length - 1, 0);
  return {
    p,
    encode(lv: number[]): Float64Array {
      const x = new Float64Array(p); let o = 0;
      attrs.forEach((a, q) => { const r = codes[q][lv[q]]; for (let k = 0; k < r.length; k++) x[o + k] = r[k]; o += a.levels.length - 1; });
      return x;
    },
  };
}

function logDet(M: Float64Array, p: number): number {
  const L = new Float64Array(p * p); let ld = 0;
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) {
    let s = M[i * p + j];
    for (let k = 0; k < j; k++) s -= L[i * p + k] * L[j * p + k];
    if (i === j) { if (!(s > 1e-10)) return -Infinity; L[i * p + i] = Math.sqrt(s); ld += Math.log(L[i * p + i]); }
    else L[i * p + j] = s / L[j * p + j];
  }
  return 2 * ld;
}

/** D-efficiency (0..1) of a CVA design: rows = profiles (single, with intercept) or pairs (differences) */
export function cvaDEfficiency(attrs: { name: string; levels: string[] }[], rows: number[][][], mode: "single" | "paired"): number | null {
  const cd = coder(attrs);
  const p = cd.p + (mode === "single" ? 1 : 0);
  if (!rows.length || p === 0) return null;
  const M = new Float64Array(p * p);
  for (const r of rows) {
    const x = mode === "single" ? [1, ...cd.encode(r[0])] : Array.from(cd.encode(r[1])).map((v, k) => v - cd.encode(r[0])[k]);
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) M[i * p + j] += (x[i] * x[j]) / rows.length;
  }
  const ld = logDet(M, p);
  if (ld === -Infinity) return 0;
  if (mode === "single") return Math.min(1, Math.exp(ld / p));
  /* pairs: the most a difference column can carry is 2l/(l−1) (two different levels, drawn evenly) */
  const bound = attrs.reduce((t, a) => t + (a.levels.length - 1) * Math.log((2 * a.levels.length) / (a.levels.length - 1)), 0) / p;
  return Math.min(1, Math.exp(ld / p - bound));
}

/** the legal candidate concepts as level-index vectors */
function candidates(c: CvaNormalized, rng: () => number): number[][] {
  const size = c.attributes.reduce((n, a) => n * a.levels.length, 1);
  const legal = (lv: number[]) => !violates(Object.fromEntries(c.attributes.map((a, q) => [a.name, a.levels[lv[q]]])), c.prohibitions);
  if (size <= CANDIDATE_CAP) {
    const out: number[][] = [];
    for (let k = 0; k < size; k++) { const lv: number[] = []; let r = k; for (const a of c.attributes) { lv.push(r % a.levels.length); r = Math.floor(r / a.levels.length); } if (legal(lv)) out.push(lv); }
    return out;
  }
  const out: number[][] = []; const seen = new Set<string>();
  for (let t = 0; t < CANDIDATE_CAP * 3 && out.length < CANDIDATE_CAP; t++) {
    const lv = c.attributes.map((a) => Math.floor(rng() * a.levels.length));
    const k = lv.join(",");
    if (!seen.has(k) && legal(lv)) { seen.add(k); out.push(lv); }
  }
  return out;
}

/** one version: a D-optimal set of `n` profiles (single) or pairs (paired) by exchange */
function optimiseVersion(c: CvaNormalized, cand: number[][], n: number, rng: () => number, budget: number): { design: number[][][]; evaluations: number } {
  const cd = coder(c.attributes);
  const p = cd.p + (c.mode === "single" ? 1 : 0);
  const enc = cand.map((lv) => cd.encode(lv));
  const rowOf = (pair: number[]) => {
    if (c.mode === "single") { const x = new Float64Array(p); x[0] = 1; x.set(enc[pair[0]], 1); return x; }
    const x = new Float64Array(p); const a = enc[pair[0]], b = enc[pair[1]]; for (let k = 0; k < p; k++) x[k] = b[k] - a[k]; return x;
  };
  // level-balanced start: each slot takes the candidate whose levels are least used so far
  const used = c.attributes.map((a) => new Array(a.levels.length).fill(0));
  const pickBalanced = (exclude: Set<number>) => {
    let best = -1, bestScore = Infinity;
    for (let tries = 0; tries < Math.min(cand.length, 400); tries++) {
      const i = Math.floor(rng() * cand.length); if (exclude.has(i)) continue;
      const s = cand[i].reduce((t, l, q) => t + used[q][l], 0);
      if (s < bestScore) { bestScore = s; best = i; }
    }
    if (best < 0) best = Math.floor(rng() * cand.length);
    cand[best].forEach((l, q) => used[q][l]++);
    return best;
  };
  const design: number[][] = [];
  const taken = new Set<number>();
  for (let t = 0; t < n; t++) {
    if (c.mode === "single") { const i = pickBalanced(taken); taken.add(i); design.push([i]); }
    else {
      const a = pickBalanced(new Set()); let b = pickBalanced(new Set([a]));
      if (b === a) b = (a + 1) % cand.length;
      design.push([a, b]);
    }
  }
  const M = new Float64Array(p * p);
  const addRow = (x: Float64Array, w: number) => { for (let i = 0; i < p; i++) { if (x[i] === 0) continue; for (let j = 0; j < p; j++) M[i * p + j] += w * x[i] * x[j]; } };
  const ridge = 1e-6;
  const ld = () => { const R = Float64Array.from(M); for (let i = 0; i < p; i++) R[i * p + i] += ridge; return logDet(R, p); };
  for (const d of design) addRow(rowOf(d), 1);
  let cur = ld(), evaluations = 0;
  for (let pass = 0; pass < 12 && evaluations < budget; pass++) {
    let improved = false;
    for (let t = 0; t < design.length && evaluations < budget; t++) {
      for (let side = 0; side < design[t].length && evaluations < budget; side++) {
        const old = design[t].slice();
        const xOld = rowOf(old);
        addRow(xOld, -1);
        let bestVal = -Infinity, bestCand = old[side];
        // try a seeded sample of candidates (all of them when the set is small)
        const tries = Math.min(cand.length, 300);
        for (let k = 0; k < tries; k++) {
          const ci = cand.length <= 300 ? k : Math.floor(rng() * cand.length);
          const trial = old.slice(); trial[side] = ci;
          if (c.mode === "paired" && trial[0] === trial[1]) continue;
          if (c.mode === "single" && design.some((d, u) => u !== t && d[0] === ci)) continue;
          const x = rowOf(trial); addRow(x, 1); const v = ld(); addRow(x, -1); evaluations++;
          if (v > bestVal) { bestVal = v; bestCand = ci; }
        }
        const chosen = old.slice(); chosen[side] = bestCand;
        if (bestVal > cur + 1e-9 && bestCand !== old[side]) { design[t] = chosen; cur = bestVal; improved = true; }
        addRow(rowOf(design[t]), 1);
      }
    }
    if (!improved) break;
  }
  return { design: design.map((d) => d.map((i) => cand[i])), evaluations };
}

export const cvaPlugin: DesignGeneratorPlugin<CvaConfig> = {
  kind: "cva",
  label: "Rating-based conjoint (CVA)",
  description:
    "Full-profile rating conjoint: respondents rate each concept (0–10 or likelihood to buy) or a pair of concepts on a preference scale. A D-optimal fractional factorial per version (exchange algorithm, prohibitions honoured); utilities are estimated per respondent by least squares.",
  configFields: [
    { name: "attributes", label: "Attributes & levels", type: "attributes", help: "Each attribute needs at least 2 levels." },
    { name: "prohibitions", label: "Prohibitions", type: "prohibitions", help: "Level combinations never shown in one profile." },
    { name: "mode", label: "Task", type: "select", options: ["single", "paired"], default: "single", help: "single — rate each profile; paired — rate two profiles side by side on a preference scale." },
    { name: "profiles", label: "Profiles (or pairs) per version (blank = 1.5 × parameters)", type: "number" },
    { name: "versions", label: "Versions (blocks)", type: "number", default: 1 },
    { name: "holdouts", label: "Holdout profiles (same in every version, not estimated)", type: "number", default: 0 },
    { name: "scaleMin", label: "Scale minimum (blank = 0, paired 1)", type: "number" },
    { name: "scaleMax", label: "Scale maximum (blank = 10, paired 9)", type: "number" },
    { name: "minLabel", label: "Label under the minimum", type: "text", help: "e.g. “Definitely would not buy” (paired: “Strongly prefer left”)." },
    { name: "maxLabel", label: "Label under the maximum", type: "text", help: "e.g. “Definitely would buy” (paired: “Strongly prefer right”)." },
    { name: "monotone", label: "Ordered attributes (optional)", type: "list", help: "One per line: Attribute: increasing | decreasing — the analysis can tie levels that break this order." },
  ],

  validateConfig(config: CvaConfig): string[] {
    const errors: string[] = [];
    const c = normalize(config);
    if (c.attributes.length < 2) errors.push("Rating-based conjoint needs at least 2 attributes.");
    for (const a of c.attributes) {
      if (!a.name?.trim()) errors.push("Every attribute needs a name.");
      if (!a.levels || a.levels.length < 2) errors.push(`Attribute "${a.name ?? "?"}" needs at least 2 levels.`);
      const dupes = (a.levels ?? []).filter((l, i) => a.levels.indexOf(l) !== i);
      if (dupes.length) errors.push(`Attribute "${a.name}" lists "${dupes[0]}" more than once.`);
      if (["version", "task", "alt", "is_holdout"].includes((a.name ?? "").trim().toLowerCase())) errors.push(`"${a.name}" cannot be an attribute name — the design file uses that column.`);
    }
    if (new Set(c.attributes.map((a) => a.name)).size !== c.attributes.length) errors.push("Attribute names must be unique.");
    if (config.mode != null && config.mode !== "single" && config.mode !== "paired") errors.push(`Unknown task "${String(config.mode)}" — use single or paired.`);
    for (const [k, v] of [["profiles", c.profiles], ["versions", c.versions], ["holdouts", c.holdouts]] as const) if (!Number.isInteger(v) || v < (k === "holdouts" ? 0 : 1)) errors.push(`${k} must be a whole number${k === "holdouts" ? "" : " of 1 or more"}.`);
    if (!(Number.isFinite(c.scaleMin) && Number.isFinite(c.scaleMax)) || c.scaleMax - c.scaleMin < 2) errors.push("The rating scale needs at least 3 points (maximum − minimum ≥ 2).");
    if (errors.length) return errors;
    const minN = c.mode === "single" ? c.params + 1 : c.params;
    if (c.profiles < minN) errors.push(`${c.profiles} ${c.mode === "single" ? "profiles" : "pairs"} cannot identify ${c.params} part-worths${c.mode === "single" ? " and an intercept" : ""} for one respondent — use at least ${minN} (about ${Math.ceil(1.5 * minN)} is recommended).`);
    const size = c.attributes.reduce((n, a) => n * a.levels.length, 1);
    if (size <= CANDIDATE_CAP) {
      const cand = candidates(c, mulberry32(1));
      if (!cand.length) errors.push("These prohibitions rule out every profile.");
      else {
        if (c.mode === "single" && cand.length < c.profiles) errors.push(`Only ${cand.length} different legal profiles exist, and each version needs ${c.profiles}.`);
        for (const [q, a] of c.attributes.entries()) for (const [li, l] of a.levels.entries()) if (!cand.some((x) => x[q] === li)) errors.push(`"${l}" (${a.name}) appears in no legal profile, so its utility could never be estimated.`);
      }
    }
    for (const line of config.monotone ?? []) if (!/^\s*[^:=]+[:=]\s*(increasing|decreasing|ascending|descending)\s*$/i.test(String(line))) errors.push(`Ordered attribute “${line}” — write it as “Price: decreasing”.`);
    return errors;
  },

  generate(config: CvaConfig, seed: number) {
    const problems = cvaPlugin.validateConfig!(config);
    if (problems.length) throw new Error(problems[0]);
    const c = normalize(config);
    const cand = candidates(c, mulberry32(subSeed(seed, "cva:candidates")));
    const columns = ["version", "task", "alt", "is_holdout", ...c.attributes.map((a) => a.name)];
    const rows: Record<string, unknown>[] = [];
    const budget = Math.max(5_000, Math.floor(EXCHANGE_BUDGET / c.versions));
    const perVersion: number[] = [];
    let evaluations = 0;
    const holdRng = mulberry32(subSeed(seed, "cva:holdouts"));
    const holdouts: number[][][] = Array.from({ length: c.holdouts }, () => {
      const a = cand[Math.floor(holdRng() * cand.length)];
      if (c.mode === "single") return [a];
      let b = cand[Math.floor(holdRng() * cand.length)]; let guard = 0;
      while (b.join() === a.join() && guard++ < 50) b = cand[Math.floor(holdRng() * cand.length)];
      return [a, b];
    });
    const levelCounts: Record<string, Record<string, number>> = Object.fromEntries(c.attributes.map((a) => [a.name, Object.fromEntries(a.levels.map((l) => [l, 0]))]));
    for (let v = 1; v <= c.versions; v++) {
      const opt = optimiseVersion(c, cand, c.profiles, mulberry32(subSeed(seed, `cva:v${v}`)), budget);
      evaluations += opt.evaluations;
      perVersion.push(cvaDEfficiency(c.attributes, opt.design, c.mode) ?? 0);
      // shuffle the task order (the exchange leaves related profiles adjacent)
      const order = opt.design.map((_, i) => i);
      const rr = mulberry32(subSeed(seed, `cva:order:v${v}`));
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rr() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const all = [...order.map((i) => ({ set: opt.design[i], holdout: false })), ...holdouts.map((h) => ({ set: h, holdout: true }))];
      all.forEach((t, k) => t.set.forEach((lv, j) => {
        const prof = Object.fromEntries(c.attributes.map((a, q) => [a.name, a.levels[lv[q]]]));
        if (!t.holdout) for (const a of c.attributes) levelCounts[a.name][prof[a.name]]++;
        rows.push({ version: v, task: k + 1, alt: j + 1, is_holdout: t.holdout ? 1 : 0, ...prof });
      }));
    }
    const mean = perVersion.reduce((t, x) => t + x, 0) / Math.max(1, perVersion.length);
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const warnings: string[] = [];
    if (mean < 0.8) warnings.push(`D-efficiency per version is ${Math.round(mean * 1000) / 10}% — the prohibitions or the number of profiles leave the part-worths correlated; add profiles or relax a prohibition.`);
    for (const [a, m] of Object.entries(levelCounts)) { const v = Object.values(m); if (Math.min(...v) === 0) warnings.push(`A level of "${a}" never appears outside the holdouts.`); }
    return {
      columns, rows,
      summary: {
        method: "d_optimal_exchange", mode: c.mode, parameters: c.params, profilesPerVersion: c.profiles, versions: c.versions, holdouts: c.holdouts,
        scale: { min: c.scaleMin, max: c.scaleMax },
        candidates: cand.length,
        efficiency: { method: c.mode === "single" ? "d_efficiency_linear_orthonormal" : "d_efficiency_paired_differences", perVersion: { mean: r3(mean), min: r3(Math.min(...perVersion)), max: r3(Math.max(...perVersion)), versions: c.versions } },
        degreesOfFreedom: c.profiles - (c.mode === "single" ? c.params + 1 : c.params),
        levelFrequencies: levelCounts, evaluations,
        ...(warnings.length ? { warnings } : {}),
      },
    };
  },
};
