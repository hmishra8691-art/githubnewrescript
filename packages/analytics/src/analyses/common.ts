import type { AnalysisDefinition, AnalysisResult, ChartData, ChartType, ResultTable } from "../types.js";
import type { Dataset } from "../dataset.js";
import type { TestResult } from "../stats/tests.js";
import { answeredCases, weightedN } from "../dataset.js";
import { canonicalJson, fnv1a } from "../canonical.js";

export const MIN_BASE = 30;

export function round(x: number | null | undefined, d = 2): number | null {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

export function pct(x: number | null | undefined, d = 1): number | null { return round(x, d); }

export function fmtP(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return p < 0.001 ? "< .001" : p.toFixed(3).replace(/^0/, "");
}

/**
 * What the analysis IS, as a hash: the definition without its label (id, name, notes, version), with keys in a fixed
 * order, so the same analysis hashes the same however it was built (audit S-14).
 */
export function hashDefinition(def: AnalysisDefinition): string {
  return fnv1a(canonicalJson({ ...def, id: undefined, name: undefined, notes: undefined, version: undefined }));
}

/**
 * `total` — respondents in the dataset the researcher chose (environment,
 * status, quality); `filtered` — of those, the ones the analysis's own filter
 * kept; `n` — of those, the ones the analysis could actually use (answered
 * the variables it needs), when the runner knows it.
 */
export function baseOf(ds: Dataset, total: number, filtered: number, label = "All respondents", validN?: number, validWeightedN?: number) {
  return { total, filtered, n: validN ?? ds.cases.length, weightedN: ds.weighted ? (round(validWeightedN ?? weightedN(ds), 1) ?? ds.cases.length) : (validN ?? ds.cases.length), label };
}

/**
 * ONE BASE PER SCREEN (audit ANALYTICS-02/03). The respondents who answered at least one of `vars` — the same number
 * `makeResult` prints in the result header — for a table footer or a segment, so a topbox table no longer says
 * "Base: n = 30" under a header that says "n = 25". Falls back to the case count when none of the names is a
 * dataset variable (nothing is knowable about who answered).
 */
export function answeredN(ds: Dataset, vars: string[]): { n: number; weightedN: number } {
  const answered = answeredCases(ds, vars);
  if (!answered) return { n: ds.cases.length, weightedN: round(weightedN(ds), 1) ?? ds.cases.length };
  let n = 0, w = 0;
  answered.forEach((a, i) => { if (a) { n++; w += ds.weighted ? ds.cases[i].weight : 1; } });
  return { n, weightedN: round(w, 1) ?? n };
}

export function lowBaseWarning(n: number, what = "This analysis"): string | null {
  if (n === 0) return `${what} has no respondents in the selected data.`;
  if (n < MIN_BASE) return `${what} is based on only ${n} respondents (fewer than ${MIN_BASE}) — read with caution.`;
  return null;
}

/**
 * Segments with a thin base. Each segment is a table's column in all but name, so it gets the crosstab's rule: a
 * warning below MIN_BASE always, and with an `options.minBase` the segment's values are left out rather than shown.
 * One sentence for all of them, the first three named.
 */
export function segmentBases(segments: AnalysisResult["segments"], minBase = 0): { segments: AnalysisResult["segments"]; warning: string | null } {
  if (!segments?.length) return { segments, warning: null };
  const thin = segments.filter((x) => x.n > 0 && x.n < Math.max(MIN_BASE, minBase));
  const empty = segments.filter((x) => x.n === 0);
  const hidden = new Set(minBase > 0 ? segments.filter((x) => x.n < minBase).map((x) => x.name) : []);
  const list = (xs: typeof thin) => `${xs.slice(0, 3).map((x) => `${x.name} (n = ${x.n})`).join(", ")}${xs.length > 3 ? ` and ${xs.length - 3} more` : ""}`;
  const parts: string[] = [];
  if (thin.length) parts.push(`${thin.length === 1 ? "Segment" : "Segments"} ${list(thin)} ${thin.length === 1 ? "has" : "have"} fewer than ${Math.max(MIN_BASE, minBase)} respondents — read with caution`);
  if (empty.length) parts.push(`${empty.length === 1 ? "Segment" : "Segments"} ${empty.slice(0, 3).map((x) => x.name).join(", ")} ${empty.length === 1 ? "has" : "have"} no respondents`);
  if (hidden.size) parts.push(`the values of ${hidden.size === 1 ? "the segment" : "those segments"} below the minimum base of ${minBase} are not shown`);
  return { segments: hidden.size ? segments.map((x) => (hidden.has(x.name) ? { ...x, chart: {} } : x)) : segments, warning: parts.length ? `${parts.join("; ")}.` : null };
}

/**
 * An analysis the data cannot honestly answer: no numbers, the reason in words, and `error` set so a caller can tell
 * "refused" from "computed and empty". (Audit S-8: a mean of REGION came out as 1.97 and a regression on a nominal outcome as R² = 0.)
 */
export function refused(def: AnalysisDefinition, ds: Dataset, totalCases: number, message: string, recommendedCharts: ChartType[] = ["table"]): AnalysisResult {
  const r = makeResult(def, ds, { tables: [], chart: {}, warnings: [message], recommendedCharts, totalCases });
  return { ...r, error: { code: "not_computable", message } };
}

/** can the variable's codes be averaged? numeric answers and ordered scales, not nominal categories */
export const isOrdered = (ds: Dataset, name: string): boolean => { const r = ds.byName.get(name)?.role; return r === "numeric" || r === "scale"; };

/** the kinds whose tests and models do not use the weights */
export const UNWEIGHTED_KINDS: ReadonlySet<string> = new Set(["test", "correlation", "regression", "factor", "reliability", "cluster", "conjoint", "maxdiff"]);
const UNWEIGHTED_WORDS: Record<string, string> = { test: "test", correlation: "correlation", regression: "model", factor: "factor analysis", reliability: "reliability analysis", cluster: "cluster analysis", conjoint: "conjoint analysis", maxdiff: "MaxDiff analysis" };

export function makeResult(
  def: AnalysisDefinition,
  ds: Dataset,
  parts: { tables: ResultTable[]; chart: ChartData; tests?: TestResult[]; insights?: string[]; warnings?: string[]; recommendedCharts: ChartType[]; segments?: AnalysisResult["segments"]; variablesUsed?: string[]; baseLabel?: string; totalCases: number; validN?: number; validWeightedN?: number },
): AnalysisResult {
  const warnings = [...(parts.warnings ?? [])];
  /*
   * THE BASE IS THE RESPONDENTS WHO ANSWERED. Until the audit's S-5 only the crosstab passed a valid n, so an NPS that
   * 8 of 400 respondents answered reported "base 400" and no low-base warning. A runner that knows its valid n passes
   * it; otherwise it is the cases that answered at least one of the analysis's variables.
   */
  const answered = parts.validN == null ? answeredCases(ds, parts.variablesUsed ?? def.variables) : null;
  const validN = parts.validN ?? (answered ? answered.filter(Boolean).length : undefined);
  const validWeightedN = parts.validWeightedN ?? (answered && ds.weighted ? ds.cases.reduce((t, c, i) => t + (answered[i] ? c.weight : 0), 0) : undefined);
  const lb = lowBaseWarning(validN ?? ds.cases.length);
  if (lb) warnings.unshift(lb);
  const sb = segmentBases(parts.segments, Math.max(0, Number(def.options?.minBase ?? 0) || 0));
  if (sb.warning) warnings.push(sb.warning);
  /*
   * A truncated dataset is not a slow result, it is a wrong one — every base,
   * percentage and test in it describes a prefix of the study. It goes at the
   * FRONT of the warnings, ahead of the low-base note, because no other
   * caveat on the screen matters if this one is true.
   */
  if (ds.truncatedAt) warnings.unshift(`This analysis was computed on the first ${ds.truncatedAt.toLocaleString()} responses only — the study has more. Every base, percentage and test below describes that subset, not the whole study. Narrow the dataset (environment, status or date range) to bring it under the limit.`);
  /*
   * Say which results ignore the weights (S-6). These kinds compute their tests and models on respondents counted once
   * each; the "effective sample size is reduced" line below would imply they used the weights, so they get the
   * plain statement instead.
   */
  const unweighted = ds.weighted && UNWEIGHTED_KINDS.has(def.kind);
  if (unweighted) warnings.push(`The study is weighted, but this ${UNWEIGHTED_WORDS[def.kind] ?? "analysis"} is computed without the weights: every respondent counts equally in its tests and statistics.`);
  if (!unweighted && ds.weighted && ds.weightInfo && ds.weightInfo.efficiency < 70) warnings.push(`Weighting efficiency is ${ds.weightInfo.efficiency.toFixed(0)}% (design effect ${ds.weightInfo.designEffect.toFixed(2)}) — effective sample size is reduced.`);
  return {
    kind: def.kind, name: def.name,
    base: baseOf(ds, parts.totalCases, ds.cases.length, parts.baseLabel, validN, validWeightedN),
    tables: parts.tables, chart: parts.chart, tests: parts.tests ?? [], insights: parts.insights ?? [], warnings,
    recommendedCharts: parts.recommendedCharts, segments: sb.segments,
    computedAt: new Date().toISOString(), definitionHash: hashDefinition(def), variablesUsed: parts.variablesUsed ?? def.variables,
  };
}

export function opt<T>(def: AnalysisDefinition, key: string, fallback: T): T {
  const v = def.options?.[key];
  return (v === undefined || v === null ? fallback : v) as T;
}

/** Ordinal words for insights. */
export function nth(i: number): string { return ["first", "second", "third", "fourth", "fifth"][i] ?? `${i + 1}th`; }

export function fmtNum(x: number | null | undefined, d = 1): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
export function fmtPct(x: number | null | undefined, d = 0): string { return x == null ? "—" : `${fmtNum(x, d)}%`; }
