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

export function lowBaseWarning(n: number, what = "This analysis"): string | null {
  if (n === 0) return `${what} has no respondents in the selected data.`;
  if (n < MIN_BASE) return `${what} is based on only ${n} respondents (fewer than ${MIN_BASE}) — read with caution.`;
  return null;
}

export function makeResult(
  def: AnalysisDefinition,
  ds: Dataset,
  parts: { tables: ResultTable[]; chart: ChartData; tests?: TestResult[]; insights?: string[]; warnings?: string[]; recommendedCharts: ChartType[]; segments?: AnalysisResult["segments"]; variablesUsed?: string[]; baseLabel?: string; totalCases: number; validN?: number },
): AnalysisResult {
  const warnings = [...(parts.warnings ?? [])];
  /*
   * THE BASE IS THE RESPONDENTS WHO ANSWERED. Until the audit's S-5 only the crosstab passed a valid n, so an NPS that
   * 8 of 400 respondents answered reported "base 400" and no low-base warning. A runner that knows its valid n passes
   * it; otherwise it is the cases that answered at least one of the analysis's variables.
   */
  const answered = parts.validN == null ? answeredCases(ds, parts.variablesUsed ?? def.variables) : null;
  const validN = parts.validN ?? (answered ? answered.filter(Boolean).length : undefined);
  const validWeightedN = answered && ds.weighted ? ds.cases.reduce((t, c, i) => t + (answered[i] ? c.weight : 0), 0) : undefined;
  const lb = lowBaseWarning(validN ?? ds.cases.length);
  if (lb) warnings.unshift(lb);
  /*
   * A truncated dataset is not a slow result, it is a wrong one — every base,
   * percentage and test in it describes a prefix of the study. It goes at the
   * FRONT of the warnings, ahead of the low-base note, because no other
   * caveat on the screen matters if this one is true.
   */
  if (ds.truncatedAt) warnings.unshift(`This analysis was computed on the first ${ds.truncatedAt.toLocaleString()} responses only — the study has more. Every base, percentage and test below describes that subset, not the whole study. Narrow the dataset (environment, status or date range) to bring it under the limit.`);
  if (ds.weighted && ds.weightInfo && ds.weightInfo.efficiency < 70) warnings.push(`Weighting efficiency is ${ds.weightInfo.efficiency.toFixed(0)}% (design effect ${ds.weightInfo.designEffect.toFixed(2)}) — effective sample size is reduced.`);
  return {
    kind: def.kind, name: def.name,
    base: baseOf(ds, parts.totalCases, ds.cases.length, parts.baseLabel, validN, validWeightedN),
    tables: parts.tables, chart: parts.chart, tests: parts.tests ?? [], insights: parts.insights ?? [], warnings,
    recommendedCharts: parts.recommendedCharts, segments: parts.segments,
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
