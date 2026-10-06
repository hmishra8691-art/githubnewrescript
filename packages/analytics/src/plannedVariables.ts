import type { AnalysisPlan, PlannedDerived, PlannedSegment, SurveyDefinition } from "@rescript/schema";
import { buildAnalysisFramework, evaluateExpression, segmentVariableName } from "@rescript/engine";
import type { Case, Dataset, VariableMeta } from "./dataset.js";
import { scaleCodes } from "./dataset.js";
import { MIN_BASE } from "./analyses/common.js";

/**
 * THE PLAN'S OWN VARIABLES, COMPUTED BEFORE THE PLAN RUNS.
 *
 * The analysis framework declares derived variables (a construct's mean
 * score, an outcome's top-2-box, a count, a flag, a recode) and segments
 * (the crossing of a few profile variables), and planned tests and tables
 * name them — "regression of BRAND_TRUST_SCORE on …", "PURCHASE_INT_T2B by
 * COUNTRY". Until now nothing computed them: the bridge turned the crosstabs
 * and tests into analyses and silently dropped the rest, so an item naming a
 * derived variable ran on a column that did not exist and said "needs a
 * variable" — or, worse, was never noticed.
 *
 * This adds each one as a dataset column, in plan order (a later derived
 * variable may read an earlier one), with the metadata the runners read (its
 * role, and a 0/1 code frame for a box or a flag), so a planned item that
 * names it runs on it exactly as on a question. Nothing is written back: the
 * caller's dataset is untouched and the columns live only for this run.
 *
 *   mean_score / sum_score   over the numbers of `from` (a matrix named by
 *                            its question expands to its rows); a respondent
 *                            gets the mean of what they answered
 *   top_box / bottom_box     1 when the answer is one of the two highest /
 *                            lowest codes of the source's ordered scale, 0
 *                            when answered otherwise; several sources: the
 *                            box of their mean
 *   count                    how many of `from` were answered / selected
 *   flag                     1 when any of `from` was selected / answered
 *   recode / index           the `expression`, evaluated per respondent with
 *                            the engine's calc evaluator; without one it is
 *                            not computed, and the run's warnings say so
 *   segment                  one label per combination of `by` ("Female ×
 *                            UK"); segments under 30 respondents are named
 *                            in the warnings
 */

export interface PlannedVariables {
  dataset: Dataset;
  /** the names of the columns added */
  computed: string[];
  warnings: string[];
}

const words = (k: string) => k.replace(/_/g, " ");

/** the numeric columns a name stands for: itself, or — for a matrix / battery named by its question — its rows */
function numericSources(ds: Dataset, name: string): string[] {
  const m = ds.byName.get(name);
  if (m && (m.role === "numeric" || m.role === "scale")) return [name];
  const q = ds.def.questions.find((x) => x.variableName === name || String(x.code) === name);
  if (q) {
    const rows = ds.variables.filter((v) => v.questionId === q.id && v.name !== name && (v.role === "scale" || v.role === "numeric" || (v.role === "categorical" && v.rowCode != null)) && !v.derived);
    if (rows.length) return rows.map((v) => v.name);
  }
  return m ? [name] : [];
}

const num = (v: unknown): number | null => {
  if (v == null || v === "" || Array.isArray(v) || typeof v === "object") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** answered / selected, for count and flag: an array by its length, a 0/1 option flag by its value, anything else by being there */
function selections(ds: Dataset, c: Case, name: string): number | null {
  const v = c.vars[name];
  if (v == null || v === "") return null;
  if (Array.isArray(v)) return v.length;
  const m = ds.byName.get(name);
  if (m?.optionCode != null) return Number(v) === 1 ? 1 : 0;
  return 1;
}

function compute(ds: Dataset, d: PlannedDerived, warnings: string[]): { values: (number | string | null)[]; meta: Omit<VariableMeta, "name"> } | null {
  const sources = d.from.flatMap((f) => (d.kind === "count" || d.kind === "flag" || d.kind === "recode" || d.kind === "index" ? [f] : numericSources(ds, f)));
  const missing = d.from.filter((f) => !ds.byName.has(f) && !numericSources(ds, f).length);
  if (missing.length && d.kind !== "recode" && d.kind !== "index") { warnings.push(`${d.name}: not computed — ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in the data.`); return null; }
  const label = `${d.name} — ${words(d.kind)} of ${d.from.join(", ")}`;
  switch (d.kind) {
    case "mean_score": case "sum_score": {
      const values = ds.cases.map((c) => {
        const xs = sources.map((s) => num(c.vars[s])).filter((x): x is number => x != null);
        if (!xs.length) return null;
        const sum = xs.reduce((t, x) => t + x, 0);
        return d.kind === "mean_score" ? sum / xs.length : sum;
      });
      return { values, meta: { label, role: d.kind === "mean_score" ? "scale" : "numeric", derived: true, hidden: false } };
    }
    case "top_box": case "bottom_box": {
      const codes = scaleCodes(ds, sources[0] ?? d.from[0]);
      if (codes.length < 3) { warnings.push(`${d.name}: not computed — ${d.from[0]} has no ordered scale to take a ${d.kind === "top_box" ? "top" : "bottom"} two of.`); return null; }
      const box = d.kind === "top_box" ? codes.slice(-2) : codes.slice(0, 2);
      const values = ds.cases.map((c) => {
        const xs = sources.map((s) => num(c.vars[s])).filter((x): x is number => x != null);
        if (!xs.length) return null;
        // one source: is the answer in the box; several: is their mean
        const v = xs.length === 1 ? xs[0] : xs.reduce((t, x) => t + x, 0) / xs.length;
        return d.kind === "top_box" ? (v >= box[0] ? 1 : 0) : (v <= box[1] ? 1 : 0);
      });
      return { values, meta: { label, role: "categorical", categories: [{ code: "0", label: d.kind === "top_box" ? "Not top 2" : "Not bottom 2" }, { code: "1", label: d.kind === "top_box" ? "Top 2 box" : "Bottom 2 box" }], derived: true, hidden: false } };
    }
    case "count": case "flag": {
      const values = ds.cases.map((c) => {
        const xs = sources.map((s) => selections(ds, c, s));
        if (xs.every((x) => x == null)) return null;
        const n = xs.reduce<number>((t, x) => t + (x ?? 0), 0);
        return d.kind === "count" ? n : n > 0 ? 1 : 0;
      });
      return { values, meta: d.kind === "count" ? { label, role: "numeric", derived: true, hidden: false } : { label, role: "categorical", categories: [{ code: "0", label: "No" }, { code: "1", label: "Yes" }], derived: true, hidden: false } };
    }
    case "recode": case "index": {
      if (!d.expression?.trim()) { warnings.push(`${d.name}: not computed — needs an expression the runner evaluates (a ${words(d.kind)} has no rule of its own).`); return null; }
      let failed = 0, firstError = "";
      const values = ds.cases.map((c) => {
        try {
          const v = evaluateExpression(d.expression!, { resolver: (n) => c.vars[n], names: () => Object.keys(c.vars) });
          if (v == null || v === "" || Array.isArray(v)) return null;
          if (typeof v === "boolean") return v ? 1 : 0;
          return typeof v === "number" ? (Number.isFinite(v) ? v : null) : String(v);
        } catch (e) { failed++; firstError ||= (e as Error).message; return null; }
      });
      if (failed === ds.cases.length && ds.cases.length) { warnings.push(`${d.name}: not computed — the expression “${d.expression}” failed (${firstError}).`); return null; }
      if (failed) warnings.push(`${d.name}: the expression failed for ${failed} of ${ds.cases.length} respondents (${firstError}); they have no value.`);
      const numeric = values.every((v) => v == null || typeof v === "number");
      const distinct = new Set(values.filter((v) => v != null).map(String));
      const categorical = !numeric || (d.kind === "recode" && distinct.size <= 12);
      return { values, meta: { label, role: categorical ? "categorical" : "numeric", derived: true, hidden: false } };
    }
  }
}

/** a variable's answer as its label, for a segment: the code frame's label, or the value itself */
function labelValue(ds: Dataset, name: string, v: unknown): string | null {
  if (v == null || v === "" || typeof v === "object") return null;
  const cat = ds.byName.get(name)?.categories?.find((c) => c.code === String(v));
  return cat?.label ?? String(v);
}

function segmentColumn(ds: Dataset, s: PlannedSegment, warnings: string[]): { name: string; values: (string | null)[]; meta: Omit<VariableMeta, "name"> } | null {
  const name = segmentVariableName(s);
  const absent = s.by.filter((v) => !ds.byName.has(v));
  if (absent.length) { warnings.push(`Segment “${s.name}”: not computed — ${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} not in the data.`); return null; }
  const multi = s.by.filter((v) => ds.byName.get(v)?.role === "multi");
  if (multi.length) { warnings.push(`Segment “${s.name}”: not computed — ${multi.join(", ")} ${multi.length === 1 ? "is a multi-select" : "are multi-selects"}, so a respondent would be in several segments at once.`); return null; }
  const values = ds.cases.map((c) => {
    const parts = s.by.map((v) => labelValue(ds, v, c.vars[v]));
    return parts.some((p) => p == null) ? null : parts.join(" × ");
  });
  // the code frame in the order of the variables' own categories (Male × US, Male × UK, Female × US …), keeping only combinations seen
  const frames = s.by.map((v) => ds.byName.get(v)?.categories?.map((c) => c.label) ?? [...new Set(values.filter((x): x is string => !!x).map((x) => x.split(" × ")[s.by.indexOf(v)]))]);
  const combos = frames.reduce<string[]>((acc, f) => acc.flatMap((a) => f.map((x) => (a ? `${a} × ${x}` : x))), [""]);
  const seen = new Set(values.filter((x): x is string => !!x));
  const categories = [...combos.filter((c) => seen.has(c)), ...[...seen].filter((c) => !combos.includes(c))].map((c) => ({ code: c, label: c }));
  // sizes: the segments too small to read
  const size = new Map<string, number>();
  for (const v of values) if (v) size.set(v, (size.get(v) ?? 0) + 1);
  const small = categories.filter((c) => (size.get(c.code) ?? 0) < MIN_BASE);
  if (small.length) warnings.push(`Segment “${s.name}” (${name}): ${small.map((c) => `${c.label} n = ${size.get(c.code) ?? 0}`).join(", ")} — under ${MIN_BASE}, read ${small.length === 1 ? "that column" : "those columns"} with caution (${categories.map((c) => `${c.label} ${size.get(c.code) ?? 0}`).join(", ")}).`);
  return { name, values, meta: { label: `${s.name} (segment)`, role: "categorical", categories, derived: true, hidden: false } };
}

/**
 * The dataset with the plan's derived variables and segments added as
 * columns, ready for `runAnalysis` — and what could not be computed, said.
 */
export function withPlannedVariables(def: SurveyDefinition, ds: Dataset, plan: AnalysisPlan = def.research?.analysisPlan ?? buildAnalysisFramework(def)): PlannedVariables {
  const warnings: string[] = [];
  if (!plan.derived.length && !plan.segments.length) return { dataset: ds, computed: [], warnings };
  const cases: Case[] = ds.cases.map((c) => ({ ...c, vars: { ...c.vars } }));
  const out: Dataset = { ...ds, cases, variables: [...ds.variables], byName: new Map(ds.byName) };
  const computed: string[] = [];
  const add = (name: string, values: (number | string | null)[], meta: Omit<VariableMeta, "name">) => {
    cases.forEach((c, i) => { c.vars[name] = values[i]; });
    const full: VariableMeta = { name, ...meta };
    out.variables.push(full);
    out.byName.set(name, full);
    computed.push(name);
  };
  for (const d of plan.derived) {
    if (out.byName.has(d.name) && !computed.includes(d.name)) { warnings.push(`${d.name}: not computed — the survey already has a variable of that name.`); continue; }
    const r = compute(out, d, warnings);
    if (r) add(d.name, r.values, r.meta);
  }
  for (const s of plan.segments) {
    const name = segmentVariableName(s);
    if (out.byName.has(name)) {
      // a segment named after the single variable that defines it IS that variable: nothing to add
      if (!(s.by.length === 1 && s.by[0] === name)) warnings.push(`Segment “${s.name}”: not computed — ${name} is already a variable.`);
      continue;
    }
    const r = segmentColumn(out, s, warnings);
    if (r) add(r.name, r.values, r.meta);
  }
  return { dataset: out, computed, warnings };
}
