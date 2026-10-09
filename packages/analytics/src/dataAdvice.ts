import type { Dataset } from "./dataset.js";
import { categoricalColumn, categoriesOf, numericColumn, labelOf, scaleCodes } from "./dataset.js";
import { MIN_BASE } from "./analyses/common.js";
import type { AnalysisDefinition } from "./types.js";

/**
 * WHAT THE DATA SAYS ABOUT THE METHOD (Research Engine audit, Phase 4).
 *
 * The plan's explanations are rules of thumb written before fieldwork: a
 * t-test wants 30 per group, a chi-square five expected per cell. Once
 * there is data the rule can be CHECKED, and the check can say what to do
 * instead: Fisher's exact test when a 2×2 has thin cells, Mann–Whitney or
 * Kruskal–Wallis when a group is small and skewed, Welch's t when the
 * variances differ, Spearman when a correlation's variables are skewed, a
 * top-box reading when the scale is at its ceiling. Each piece of advice
 * names the check, the numbers behind it and the method it recommends;
 * nothing is switched silently — the run shows the advice beside the
 * result, and `runPlan({ adapt: true })` runs the recommended method as
 * well, so both readings are on the table.
 */
export type CheckCode = "low_base" | "small_group" | "expected_cells" | "skew" | "unequal_variance" | "ceiling" | "floor" | "missing" | "thin_category" | "one_group" | "few_per_predictor";
export interface DataCheck { code: CheckCode; message: string; severity: "warning" | "note" }
export interface DataAdvice {
  /** the analysis this advice is about */
  name: string;
  kind: AnalysisDefinition["kind"];
  planned?: string;
  checks: DataCheck[];
  /** the method the data recommends instead of (or beside) the planned one, as the analysis' `test` option */
  recommended?: { test: string; label: string; reason: string };
  /** nothing to flag */
  ok: boolean;
  summary: string;
}

export const TEST_LABELS: Record<string, string> = {
  chi_square: "chi-square", fisher_exact: "Fisher's exact test", t_independent: "t-test", t_welch: "Welch's t-test", anova_one_way: "one-way ANOVA",
  mann_whitney: "Mann–Whitney", kruskal_wallis: "Kruskal–Wallis", spearman: "Spearman's correlation", top_box: "a top-box reading",
};

const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** sample skewness (Fisher–Pearson); null below three values */
export function skewness(xs: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const m2 = xs.reduce((t, x) => t + (x - m) ** 2, 0) / n, m3 = xs.reduce((t, x) => t + (x - m) ** 3, 0) / n;
  if (m2 === 0) return 0;
  return m3 / Math.pow(m2, 1.5);
}
const variance = (xs: number[]) => { const n = xs.length; if (n < 2) return null; const m = xs.reduce((a, b) => a + b, 0) / n; return xs.reduce((t, x) => t + (x - m) ** 2, 0) / (n - 1); };

const SKEW = 1;            // |skewness| above this is "clearly skewed"
const VARIANCE_RATIO = 4;  // largest / smallest group variance above this is "unequal"
const END_SHARE = 0.5;     // half the answers at one end of a scale is a ceiling / floor
const MISSING = 0.2;       // a fifth of the base missing on a variable is worth saying
const GROUP = 30;          // per group, for a t-test / ANOVA to be read with confidence
const PER_PREDICTOR = 10;  // cases per predictor for a regression

function groupsOf(ds: Dataset, y: string, g: string): { label: string; xs: number[] }[] {
  const cats = categoriesOf(ds, g);
  const yv = numericColumn(ds, y), gv = categoricalColumn(ds, g);
  const by = new Map<string, number[]>(cats.map((c) => [c.code, []]));
  yv.forEach((v, i) => { const c = gv[i]; if (v == null || c == null || Array.isArray(c)) return; by.get(c)?.push(v); });
  return cats.map((c) => ({ label: c.label, xs: by.get(c.code) ?? [] })).filter((g) => g.xs.length > 0);
}

function contingency(ds: Dataset, a: string, b: string): { table: number[][]; rows: string[]; cols: string[]; n: number } {
  const ca = categoriesOf(ds, a), cb = categoriesOf(ds, b);
  const av = categoricalColumn(ds, a), bv = categoricalColumn(ds, b);
  const table = ca.map(() => cb.map(() => 0));
  let n = 0;
  av.forEach((x, i) => {
    const y = bv[i]; if (x == null || y == null) return;
    const xs = Array.isArray(x) ? x : [x], ys = Array.isArray(y) ? y : [y];
    let hit = false;
    for (const xi of xs) for (const yi of ys) { const r = ca.findIndex((c) => c.code === xi), c = cb.findIndex((c) => c.code === yi); if (r >= 0 && c >= 0) { table[r][c]++; hit = true; } }
    if (hit) n++;
  });
  return { table, rows: ca.map((c) => c.label), cols: cb.map((c) => c.label), n };
}

function missingShare(ds: Dataset, v: string): number {
  const meta = ds.byName.get(v);
  if (!meta || !ds.cases.length) return 0;
  const col = meta.role === "numeric" || meta.role === "scale" ? numericColumn(ds, v) : categoricalColumn(ds, v);
  return col.filter((x) => x == null || (Array.isArray(x) && !x.length)).length / ds.cases.length;
}

/** The checks for one analysis on one dataset, and the method the data recommends. */
export function adviseAnalysis(def: AnalysisDefinition, ds: Dataset): DataAdvice {
  const checks: DataCheck[] = [];
  let recommended: DataAdvice["recommended"];
  const L = (v: string) => labelOf(ds, v);
  const role = (v: string) => ds.byName.get(v)?.role;
  const isNum = (v: string) => role(v) === "numeric" || role(v) === "scale";
  const n = ds.cases.length;
  const planned = def.options?.planned ? String(def.options.planned) : undefined;
  const base = { name: def.name, kind: def.kind, ...(planned ? { planned } : {}) };
  if (n < MIN_BASE) checks.push({ code: "low_base", severity: "warning", message: `Only ${n} respondents in the dataset — below the ${MIN_BASE} needed to read any test.` });

  const vars = def.kind === "crosstab" ? [...(def.rows ?? [def.variables[0]]), ...(def.columns ?? def.variables.slice(1))] : def.variables;
  for (const v of vars.filter((v) => ds.byName.has(v))) {
    const miss = missingShare(ds, v);
    if (miss >= MISSING && n >= MIN_BASE) checks.push({ code: "missing", severity: "note", message: `${L(v)} is missing for ${pct(miss)} of the base — the analysis reads the ${Math.round(n * (1 - miss))} who answered.` });
  }

  const scaleEnds = (v: string) => {
    const codes = scaleCodes(ds, v);
    if (codes.length < 3) return;
    const xs = numericColumn(ds, v).filter((x): x is number => x != null);
    if (xs.length < MIN_BASE) return;
    const hi = Math.max(...codes), lo = Math.min(...codes);
    const top = xs.filter((x) => x === hi).length / xs.length, bottom = xs.filter((x) => x === lo).length / xs.length;
    if (top >= END_SHARE) checks.push({ code: "ceiling", severity: "note", message: `${L(v)} is at its ceiling: ${pct(top)} chose the top point (${hi}), so a mean hides the spread — a top-box share reads it better.` });
    else if (bottom >= END_SHARE) checks.push({ code: "floor", severity: "note", message: `${L(v)} is at its floor: ${pct(bottom)} chose the bottom point (${lo}) — a bottom-box share reads it better than a mean.` });
  };

  const groupChecks = (y: string, g: string, test: string) => {
    const groups = groupsOf(ds, y, g);
    if (groups.length < 2) { checks.push({ code: "one_group", severity: "warning", message: `${L(g)} has ${groups.length === 1 ? "only one group" : "no group"} with data on ${L(y)} — nothing to compare.` }); return; }
    const small = groups.filter((x) => x.xs.length < GROUP);
    if (small.length) checks.push({ code: "small_group", severity: small.some((x) => x.xs.length < 10) ? "warning" : "note", message: `${small.map((x) => `${x.label} (n = ${x.xs.length})`).join(", ")} ${small.length === 1 ? "is" : "are"} below ${GROUP} per group.` });
    const skews = groups.map((x) => ({ label: x.label, s: skewness(x.xs) })).filter((x) => x.s != null && Math.abs(x.s) >= SKEW);
    if (skews.length) checks.push({ code: "skew", severity: "note", message: `${L(y)} is skewed within ${skews.map((x) => `${x.label} (skewness ${fmt(x.s, 1)})`).join(", ")}.` });
    const vs = groups.map((x) => variance(x.xs)).filter((v): v is number => v != null && v > 0);
    const ratio = vs.length >= 2 ? Math.max(...vs) / Math.min(...vs) : 1;
    if (ratio >= VARIANCE_RATIO) checks.push({ code: "unequal_variance", severity: "note", message: `The spread of ${L(y)} differs across ${L(g)} (variance ratio ${fmt(ratio, 1)}).` });
    scaleEnds(y);
    const parametric = ["t_independent", "t_welch", "anova_one_way", "auto"].includes(test);
    if (parametric && skews.length && small.length) {
      const np = groups.length > 2 ? "kruskal_wallis" : "mann_whitney";
      recommended = { test: np, label: TEST_LABELS[np], reason: `${L(y)} is skewed and ${small.length === 1 ? "a group is" : "groups are"} small — a rank test does not lean on normal means.` };
    } else if ((test === "t_independent" || (test === "auto" && groups.length === 2)) && ratio >= VARIANCE_RATIO && def.options?.equalVariance === true) {
      recommended = { test: "t_welch", label: TEST_LABELS.t_welch, reason: "the groups' variances differ — Welch's t does not assume them equal." };
    } else if (parametric && checks.some((c) => c.code === "ceiling" || c.code === "floor")) {
      recommended = { test: "top_box", label: TEST_LABELS.top_box, reason: "the scale is bunched at one end — compare the share at that end rather than the mean." };
    }
  };

  const tableChecks = (a: string, b: string) => {
    const full = contingency(ds, a, b);
    // the table as the data fills it: a category nobody chose is not a thin cell, it is absent
    const keepR = full.table.map((r, i) => i).filter((i) => full.table[i].some((x) => x > 0));
    const keepC = (full.table[0] ?? []).map((_, j) => j).filter((j) => full.table.some((r) => r[j] > 0));
    const table = keepR.map((i) => keepC.map((j) => full.table[i][j])), rows = keepR.map((i) => full.rows[i]), cols = keepC.map((j) => full.cols[j]), nn = full.n;
    const R = table.length, C = table[0]?.length ?? 0;
    if (R < 2 || C < 2 || !nn) { checks.push({ code: "one_group", severity: "warning", message: `${L(a)} by ${L(b)} has fewer than two rows or columns with data.` }); return; }
    const rowT = table.map((r) => r.reduce((x, y) => x + y, 0)), colT = cols.map((_, j) => table.reduce((x, r) => x + r[j], 0));
    let thin = 0, cells = 0;
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) { cells++; if ((rowT[i] * colT[j]) / nn < 5) thin++; }
    const smallCols = cols.filter((_, j) => colT[j] > 0 && colT[j] < MIN_BASE);
    if (smallCols.length) checks.push({ code: "small_group", severity: "note", message: `Column${smallCols.length === 1 ? "" : "s"} ${smallCols.map((c) => `${c} (n = ${colT[cols.indexOf(c)]})`).join(", ")} ${smallCols.length === 1 ? "is" : "are"} below ${MIN_BASE}.` });
    const empty = rows.filter((_, i) => rowT[i] > 0 && rowT[i] < 5);
    if (empty.length && nn >= 100) checks.push({ code: "thin_category", severity: "note", message: `${L(a)}: ${empty.join(", ")} ${empty.length === 1 ? "has" : "have"} fewer than five answers — combine ${empty.length === 1 ? "it" : "them"} with a neighbour before reading the table.` });
    if (thin) {
      checks.push({ code: "expected_cells", severity: thin / cells > 0.2 ? "warning" : "note", message: `${thin} of ${cells} cells have an expected count below 5 — the chi-square approximation is weak there.` });
      if (R === 2 && C === 2) recommended = { test: "fisher_exact", label: TEST_LABELS.fisher_exact, reason: "a 2×2 table with thin cells — Fisher's exact test needs no approximation." };
      else recommended = { test: "chi_square", label: "chi-square on combined categories", reason: `combine the thin categories of ${L(a)} or ${L(b)} so every cell expects at least 5, then read the chi-square.` };
    }
  };

  switch (def.kind) {
    case "crosstab": {
      const rows = def.rows ?? [def.variables[0]], colsV = def.columns ?? def.variables.slice(1);
      for (const r of rows) for (const c of colsV) {
        if (!ds.byName.has(r) || !ds.byName.has(c)) continue;
        if (isNum(r) && !isNum(c)) groupChecks(r, c, "anova_one_way");
        else if (!isNum(r) && !isNum(c)) tableChecks(r, c);
      }
      break;
    }
    case "test": {
      const test = String(def.options?.test ?? "auto");
      const [a, b] = def.variables;
      if (a && b && ds.byName.has(a) && ds.byName.has(b)) {
        if (isNum(a) && !isNum(b)) groupChecks(a, b, test);
        else if (!isNum(a) && !isNum(b)) tableChecks(a, b);
        else if (isNum(a) && isNum(b)) { scaleEnds(a); scaleEnds(b); }
      } else if (a && ds.byName.has(a)) scaleEnds(a);
      break;
    }
    case "correlation": {
      const skewed = def.variables.filter((v) => isNum(v)).map((v) => ({ v, s: skewness(numericColumn(ds, v).filter((x): x is number => x != null)) })).filter((x) => x.s != null && Math.abs(x.s) >= SKEW);
      if (skewed.length) {
        checks.push({ code: "skew", severity: "note", message: `${skewed.map((x) => `${L(x.v)} (skewness ${fmt(x.s, 1)})`).join(", ")} ${skewed.length === 1 ? "is" : "are"} skewed.` });
        if (def.options?.method !== "spearman") recommended = { test: "spearman", label: TEST_LABELS.spearman, reason: "a rank correlation is not pulled by a skewed tail." };
      }
      break;
    }
    case "regression": {
      const preds = def.variables.slice(1).length;
      if (preds && n < preds * PER_PREDICTOR) checks.push({ code: "few_per_predictor", severity: "warning", message: `${n} cases for ${preds} predictor${preds === 1 ? "" : "s"} — fewer than ${PER_PREDICTOR} per predictor; the coefficients will be unstable.` });
      break;
    }
    default: break;
  }
  const warnings = checks.filter((c) => c.severity === "warning");
  const summary = !checks.length ? "The data meets the method's assumptions as far as the checks go."
    : `${checks.map((c) => c.message).join(" ")}${recommended ? ` Recommended: ${recommended.label} — ${recommended.reason}` : ""}`;
  return { ...base, checks, ...(recommended ? { recommended } : {}), ok: !warnings.length && !recommended, summary };
}

/** "2 of 5 analyses have data advice: …" */
export function adviceSummary(advice: DataAdvice[]): string {
  const flagged = advice.filter((a) => !a.ok);
  if (!flagged.length) return advice.length ? `The data meets the planned methods' assumptions for all ${advice.length} analyses.` : "";
  return `${flagged.length} of ${advice.length} analyses ${flagged.length === 1 ? "has" : "have"} data advice: ${flagged.map((a) => `${a.name} — ${a.recommended ? `recommended ${a.recommended.label}` : a.checks.find((c) => c.severity === "warning")?.message ?? a.checks[0].message}`).join("; ")}.`;
}
