import type { Case, Dataset, VariableMeta } from "./dataset.js";
import { categoriesOf, categoricalColumn, numericColumn, scaleCodes } from "./dataset.js";

/**
 * THE ANALYSIS LAYER: derived ("hidden") variables that exist only for analysis (2026-11-15).
 *
 * A researcher used to make these by hand: add a hidden question, pick single or multi, map the codes, populate it,
 * check it, then tabulate it. Here an analysis carries the definitions of the variables it needs
 * (`options.layer`), and every run computes them from the raw answers before the analysis reads them:
 *
 *   group_numeric   a number into bands                 AGE 18–24 / 25–34 / …            → single category
 *   map_codes       codes into groups                   REGION 1,2 → "North"; 3 → "South" → single (or multi from a multi)
 *   nps_class       0–10 into the three NPS groups       0–6 Detractor, 7–8 Passive, 9–10 Promoter
 *   box             top / bottom 1–3 box of a scale      1 when in the box, 0 when answered otherwise
 *   flag            "chose any of these codes"           1 / 0 — "aware of Brand A", a filter or a base
 *   count / mean    over several numeric variables
 *
 * NOTHING IS WRITTEN BACK. The input dataset is never mutated: the run gets a copy with extra columns, the stored
 * responses and the questionnaire are untouched, and the next run recomputes from the raw answers — so a change to a
 * source answer can never leave a stale derived value behind. A layer variable's NAME is derived from its definition
 * (`layerName`), so the same instruction run twice reuses one variable instead of making two.
 *
 * EVERY VARIABLE IS CHECKED as it is populated (`LayerReport`): how many respondents were eligible, how many got a
 * value, how many had no answer, which source values fitted no rule (invalid), the resulting distribution, and the
 * arithmetic that must hold (populated + missing = eligible; the categories add up to the populated count). A
 * definition that cannot be computed honestly is refused with the reason, never approximated.
 */

export type LayerVariable =
  | { name?: string; label: string; kind: "group_numeric"; from: [string]; bins: { label: string; min?: number; max?: number }[] }
  | { name?: string; label: string; kind: "map_codes"; from: [string]; groups: { label: string; codes: string[] }[] }
  | { name?: string; label: string; kind: "nps_class"; from: [string] }
  | { name?: string; label: string; kind: "box"; from: [string]; side: "top" | "bottom"; size: 1 | 2 | 3 }
  | { name?: string; label: string; kind: "flag"; from: [string]; codes: string[] }
  | { name?: string; label: string; kind: "count"; from: string[] }
  | { name?: string; label: string; kind: "mean"; from: string[] };

/** keep or drop respondents by a variable's codes — applied after the layer is computed, so it may read a layer variable */
export interface LayerFilter { variable: string; keep?: string[]; drop?: string[]; label?: string }

export interface LayerReport {
  name: string;
  label: string;
  kind: LayerVariable["kind"];
  sources: string[];
  role: VariableMeta["role"];
  /** respondents in the dataset the variable was computed on */
  eligible: number;
  /** respondents who got a value */
  populated: number;
  /** respondents with no answer to the source(s) */
  missing: number;
  /** source values no rule covered — left without a value, never forced into a group */
  invalid: { value: string; n: number }[];
  categories?: { code: string; label: string; n: number }[];
  /** the checks that passed, in words */
  checks: string[];
  /** anything that stopped it or should be read before trusting it */
  problems: string[];
  /** true when the variable could not be computed at all (it is then absent from the dataset) */
  refused: boolean;
}

export interface LayerResult { dataset: Dataset; reports: LayerReport[]; problems: string[]; filtered?: { label: string; before: number; after: number }[] }

/* ------------------------------------------------------------ identity: one definition, one variable */

const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => k !== "name" && k !== "label").sort().map((k) => `${k}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
};
/** what the variable computes, independent of what it is called */
export function layerSignature(v: LayerVariable): string { return canon(v); }

const hash = (s: string): string => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
};
/** `_L_<kind>_<source>_<hash>` — the leading underscore keeps it out of question pickers (it is a hidden variable) */
export function layerName(v: LayerVariable): string {
  const src = (v.from[0] ?? "x").replace(/[^A-Za-z0-9]+/g, "_").slice(0, 24);
  return `_L_${v.kind}_${src}_${hash(layerSignature(v))}`;
}
/** the variables with their names filled in, duplicates (same definition) removed */
export function normalizeLayer(vars: readonly LayerVariable[]): (LayerVariable & { name: string })[] {
  const out: (LayerVariable & { name: string })[] = [];
  const seen = new Set<string>();
  for (const v of vars) {
    const sig = layerSignature(v);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ ...v, name: v.name && /^_L_[A-Za-z0-9_]+$/.test(v.name) ? v.name : layerName(v) } as LayerVariable & { name: string });
  }
  return out;
}

/* ------------------------------------------------------------ computing */

type Value = string | string[] | number | null;
interface Computed { values: Value[]; meta: Omit<VariableMeta, "name">; invalid: Map<string, number>; problems: string[] }

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const fmtBin = (b: { min?: number; max?: number }) => `${b.min ?? "−∞"}–${b.max ?? "∞"}`;

function compute(ds: Dataset, v: LayerVariable): Computed | { refuse: string } {
  const missing = v.from.filter((s) => !ds.byName.has(s));
  if (missing.length) return { refuse: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not a variable of this survey.` };
  const invalid = new Map<string, number>();
  const bad = (x: unknown) => { const k = String(Array.isArray(x) ? x.join(",") : x); invalid.set(k, (invalid.get(k) ?? 0) + 1); };
  const src = v.from[0];
  const srcMeta = ds.byName.get(src)!;
  const base = { label: v.label, derived: true, hidden: true } as const;

  switch (v.kind) {
    case "group_numeric": {
      if (!v.bins.length) return { refuse: "No bands were given." };
      /* bands must not overlap: a respondent belongs to one group */
      const sorted = [...v.bins].sort((a, b) => (a.min ?? -Infinity) - (b.min ?? -Infinity));
      for (let i = 1; i < sorted.length; i++) if ((sorted[i - 1].max ?? Infinity) >= (sorted[i].min ?? -Infinity)) return { refuse: `The bands ${fmtBin(sorted[i - 1])} and ${fmtBin(sorted[i])} overlap — each respondent must fall in one band.` };
      if (srcMeta.role !== "numeric" && srcMeta.role !== "scale") return { refuse: `${srcMeta.label} is not a number, so it cannot be put into bands.` };
      const cats = v.bins.map((b, i) => ({ code: String(i + 1), label: b.label }));
      const values = numericColumn(ds, src).map((x): Value => {
        if (x == null) return null;
        const i = v.bins.findIndex((b) => (b.min == null || x >= b.min) && (b.max == null || x <= b.max));
        if (i < 0) { bad(x); return null; }
        return String(i + 1);
      });
      return { values, meta: { ...base, role: "categorical", categories: cats }, invalid, problems: [] };
    }
    case "map_codes": {
      const multi = srcMeta.role === "multi";
      const codes = new Map<string, string>();
      for (const [gi, g] of v.groups.entries()) for (const c of g.codes) {
        if (codes.has(String(c)) && !multi) return { refuse: `Code ${c} is mapped to two groups — on a single-choice question each answer goes to one group.` };
        codes.set(String(c), String(gi + 1));
      }
      const known = new Set(categoriesOf(ds, src).map((c) => c.code));
      const unknown = [...codes.keys()].filter((c) => known.size && !known.has(c));
      const problems = unknown.length ? [`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not an answer code of ${srcMeta.label}.`] : [];
      const cats = v.groups.map((g, i) => ({ code: String(i + 1), label: g.label }));
      const values = categoricalColumn(ds, src).map((x): Value => {
        if (x == null || (Array.isArray(x) && !x.length)) return null;
        if (Array.isArray(x)) {
          /* a multi-select maps to a multi-select: a group is chosen when any of its codes was */
          const out = [...new Set(x.map((c) => codes.get(String(c))).filter((g): g is string => !!g))].sort();
          for (const c of x) if (!codes.has(String(c))) bad(c);
          return out.length ? out : null;
        }
        const g = codes.get(String(x));
        if (!g) { bad(x); return null; }
        return g;
      });
      return { values, meta: { ...base, role: multi ? "multi" : "categorical", categories: cats }, invalid, problems };
    }
    case "nps_class": {
      const raw = numericColumn(ds, src);
      const xs = raw.filter(isNum);
      if (xs.length && (Math.min(...xs) < 0 || Math.max(...xs) > 10)) return { refuse: `${srcMeta.label} has answers from ${Math.min(...xs)} to ${Math.max(...xs)}, outside the 0–10 recommendation scale.` };
      if (xs.length >= 10 && Math.max(...xs) <= 5) return { refuse: `${srcMeta.label} only has answers from ${Math.min(...xs)} to ${Math.max(...xs)} — that looks like a 1–5 rating, not a 0–10 recommendation question.` };
      const values = raw.map((x): Value => {
        if (x == null) return null;
        if (!Number.isInteger(x)) { bad(x); return null; }
        return x >= 9 ? "3" : x >= 7 ? "2" : "1";
      });
      return { values, meta: { ...base, role: "categorical", categories: [{ code: "1", label: "Detractors (0–6)" }, { code: "2", label: "Passives (7–8)" }, { code: "3", label: "Promoters (9–10)" }] }, invalid, problems: [] };
    }
    case "box": {
      const scale = scaleCodes(ds, src);
      if (scale.length < 3) return { refuse: `${srcMeta.label} does not have an ordered scale of at least three points, so it has no top or bottom box.` };
      if (v.size * 2 > scale.length) return { refuse: `A ${v.side}-${v.size} box needs at least ${v.size * 2} scale points; ${srcMeta.label} has ${scale.length}.` };
      const box = new Set((v.side === "top" ? scale.slice(-v.size) : scale.slice(0, v.size)).map(String));
      const onScale = new Set(scale.map(String));
      const values = numericColumn(ds, src).map((x): Value => {
        if (x == null) return null;
        if (!onScale.has(String(x))) { bad(x); return null; }
        return box.has(String(x)) ? "1" : "0";
      });
      const boxLabel = [...box].join(", ");
      return { values, meta: { ...base, role: "categorical", categories: [{ code: "1", label: `${v.side === "top" ? "Top" : "Bottom"} ${v.size} box (${boxLabel})` }, { code: "0", label: "Other answers" }] }, invalid, problems: [] };
    }
    case "flag": {
      const want = new Set(v.codes.map(String));
      const known = new Set(categoriesOf(ds, src).map((c) => c.code));
      const unknown = [...want].filter((c) => known.size && !known.has(c));
      if (unknown.length === want.size) return { refuse: `${[...want].join(", ")} ${want.size === 1 ? "is" : "are"} not an answer code of ${srcMeta.label}.` };
      const values = categoricalColumn(ds, src).map((x): Value => {
        if (x == null || (Array.isArray(x) && !x.length)) return null;
        const chosen = Array.isArray(x) ? x : [x];
        return chosen.some((c) => want.has(String(c))) ? "1" : "0";
      });
      const names = categoriesOf(ds, src).filter((c) => want.has(c.code)).map((c) => c.label);
      return { values, meta: { ...base, role: "categorical", categories: [{ code: "1", label: names.length ? names.join(" / ") : "Yes" }, { code: "0", label: "No" }] }, invalid, problems: unknown.length ? [`${unknown.join(", ")} not found in ${srcMeta.label}.`] : [] };
    }
    case "count":
    case "mean": {
      const cols = v.from.map((s) => numericColumn(ds, s));
      const values = ds.cases.map((_, i): Value => {
        const xs = cols.map((c) => c[i]).filter(isNum);
        if (!xs.length) return null;
        return v.kind === "count" ? xs.length : xs.reduce((a, b) => a + b, 0) / xs.length;
      });
      return { values, meta: { ...base, role: "numeric" }, invalid, problems: [] };
    }
  }
}

/** dependency order: a layer variable may read an earlier one; a cycle is refused */
function ordered(vars: (LayerVariable & { name: string })[]): { order: (LayerVariable & { name: string })[]; cycle: string[] } {
  const byName = new Map(vars.map((v) => [v.name, v]));
  const order: (LayerVariable & { name: string })[] = [];
  const state = new Map<string, "visiting" | "done">();
  const cycle: string[] = [];
  const visit = (v: LayerVariable & { name: string }) => {
    const s = state.get(v.name);
    if (s === "done") return;
    if (s === "visiting") { cycle.push(v.name); return; }
    state.set(v.name, "visiting");
    for (const d of v.from) { const dep = byName.get(d); if (dep) visit(dep); }
    state.set(v.name, "done");
    order.push(v);
  };
  for (const v of vars) visit(v);
  return { order, cycle };
}

/** compute the layer on a copy of the dataset; the input is never changed */
export function applyLayer(ds: Dataset, vars: readonly LayerVariable[], filters: readonly LayerFilter[] = []): LayerResult {
  const norm = normalizeLayer(vars);
  const problems: string[] = [];
  const reports: LayerReport[] = [];
  const cases: Case[] = ds.cases.map((c) => ({ ...c, vars: { ...c.vars } }));
  let out: Dataset = { ...ds, cases, variables: [...ds.variables], byName: new Map(ds.byName) };
  const { order, cycle } = ordered(norm);
  if (cycle.length) problems.push(`The derived variables ${cycle.join(", ")} depend on each other in a circle, so they were not computed.`);
  for (const v of order) {
    if (cycle.includes(v.name)) continue;
    const eligible = cases.length;
    const r = compute(out, v);
    if ("refuse" in r) {
      reports.push({ name: v.name, label: v.label, kind: v.kind, sources: [...v.from], role: "categorical", eligible, populated: 0, missing: 0, invalid: [], checks: [], problems: [r.refuse], refused: true });
      problems.push(`${v.label}: ${r.refuse}`);
      continue;
    }
    cases.forEach((c, i) => { c.vars[v.name] = r.values[i]; });
    const meta: VariableMeta = { name: v.name, ...r.meta };
    out.variables.push(meta);
    out.byName.set(v.name, meta);
    /* validation: the counts must reconcile with the data just written */
    const populated = r.values.filter((x) => x != null).length;
    const invalidN = [...r.invalid.values()].reduce((a, b) => a + b, 0);
    const missing = eligible - populated - (r.meta.role === "multi" ? 0 : invalidN);
    const checks: string[] = [];
    const vprob = [...r.problems];
    let categories: LayerReport["categories"];
    if (r.meta.categories) {
      categories = r.meta.categories.map((c) => ({ ...c, n: r.values.filter((x) => (Array.isArray(x) ? x.includes(c.code) : x === c.code)).length }));
      const sum = categories.reduce((a, c) => a + c.n, 0);
      if (r.meta.role === "multi") { if (sum >= populated) checks.push(`every one of the ${populated} respondents with a value is in at least one group`); else vprob.push("some respondents with a value are in no group"); }
      else if (sum === populated) checks.push(`the groups add up to the ${populated} respondents with a value`);
      else vprob.push(`the groups add up to ${sum}, not the ${populated} respondents with a value`);
    }
    if (r.meta.role !== "multi") {
      if (populated + Math.max(0, missing) + invalidN === eligible) checks.push(`${populated} populated + ${Math.max(0, missing)} without an answer + ${invalidN} not covered = ${eligible} respondents`);
      else vprob.push(`the counts do not reconcile (${populated} + ${missing} + ${invalidN} ≠ ${eligible})`);
    }
    if (invalidN) vprob.push(`${invalidN} answer${invalidN === 1 ? "" : "s"} fitted no rule and were left without a value (${[...r.invalid.entries()].slice(0, 5).map(([k, n]) => `${k} ×${n}`).join(", ")})`);
    if (!populated) vprob.push("no respondent got a value");
    reports.push({ name: v.name, label: v.label, kind: v.kind, sources: [...v.from], role: r.meta.role, eligible, populated, missing: Math.max(0, missing), invalid: [...r.invalid.entries()].map(([value, n]) => ({ value, n })), categories, checks, problems: vprob, refused: false });
  }
  /* filters: keep / drop respondents by a variable's codes (a question or a layer variable) */
  const filtered: NonNullable<LayerResult["filtered"]> = [];
  for (const f of filters) {
    if (!out.byName.has(f.variable)) { problems.push(`The filter on ${f.variable} was not applied: it is not a variable here.`); continue; }
    const col = categoricalColumn(out, f.variable);
    const keep = f.keep?.length ? new Set(f.keep.map(String)) : null;
    const drop = new Set((f.drop ?? []).map(String));
    const before = out.cases.length;
    const idx = col.map((x, i) => {
      const chosen = x == null ? [] : Array.isArray(x) ? x : [x];
      if (keep && !chosen.some((c) => keep.has(c))) return -1;
      if (chosen.some((c) => drop.has(c))) return -1;
      return i;
    }).filter((i) => i >= 0);
    out = { ...out, cases: idx.map((i) => out.cases[i]) };
    filtered.push({ label: f.label ?? `${f.variable}${keep ? ` is ${[...keep].join("/")}` : ""}${drop.size ? ` is not ${[...drop].join("/")}` : ""}`, before, after: out.cases.length });
  }
  return { dataset: out, reports, problems, ...(filtered.length ? { filtered } : {}) };
}

/* ------------------------------------------------------------ the definition a phrase stands for */

/** "18-24, 25-34, 35+" → bands; null when the text names none */
export function parseBands(text: string): { label: string; min?: number; max?: number }[] | null {
  const out: { label: string; min?: number; max?: number }[] = [];
  const re = /(?:under|below|less than)\s*(\d+)|(\d+)\s*(?:-|–|to)\s*(\d+)|(\d+)\s*\+|(\d+)\s*(?:and|or)\s*(?:over|above|older|more)/gi;
  for (const m of text.matchAll(re)) {
    if (m[1]) out.push({ label: `Under ${m[1]}`, max: Number(m[1]) - 1 });
    else if (m[2] && m[3]) out.push({ label: `${m[2]}–${m[3]}`, min: Number(m[2]), max: Number(m[3]) });
    else if (m[4]) out.push({ label: `${m[4]}+`, min: Number(m[4]) });
    else if (m[5]) out.push({ label: `${m[5]}+`, min: Number(m[5]) });
  }
  return out.length >= 2 ? out : null;
}

/** the age bands used when a request says "age groups" and names none — stated in the proposal, never silent */
export const DEFAULT_AGE_BANDS = [
  { label: "18–24", min: 18, max: 24 }, { label: "25–34", min: 25, max: 34 }, { label: "35–44", min: 35, max: 44 },
  { label: "45–54", min: 45, max: 54 }, { label: "55–64", min: 55, max: 64 }, { label: "65+", min: 65 },
];

/** a code frame's "don't know" / "prefer not to say" style answers */
export function nonSubstantiveCodes(categories: readonly { code: string; label: string }[]): string[] {
  return categories.filter((c) => /\b(don'?t know|do not know|dk|not sure|unsure|prefer not|refused|no opinion|can'?t say|n\/a|not applicable)\b/i.test(c.label)).map((c) => c.code);
}
