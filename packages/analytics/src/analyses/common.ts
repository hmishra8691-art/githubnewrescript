import type { AnalysisDefinition, AnalysisResult, ChartData, ChartType, ResultTable } from "../types.js";
import type { Dataset } from "../dataset.js";
import type { TestResult } from "../stats/tests.js";
import { weightedN } from "../dataset.js";

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

export function hashDefinition(def: AnalysisDefinition): string {
  const s = JSON.stringify({ ...def, id: undefined, name: undefined, notes: undefined, version: undefined });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function baseOf(ds: Dataset, total: number, filtered: number, label = "All respondents") {
  return { total, filtered, n: ds.cases.length, weightedN: round(weightedN(ds), 1) ?? ds.cases.length, label };
}

export function lowBaseWarning(n: number, what = "This analysis"): string | null {
  if (n === 0) return `${what} has no respondents in the selected data.`;
  if (n < MIN_BASE) return `${what} is based on only ${n} respondents (fewer than ${MIN_BASE}) — read with caution.`;
  return null;
}

export function makeResult(
  def: AnalysisDefinition,
  ds: Dataset,
  parts: { tables: ResultTable[]; chart: ChartData; tests?: TestResult[]; insights?: string[]; warnings?: string[]; recommendedCharts: ChartType[]; segments?: AnalysisResult["segments"]; variablesUsed?: string[]; baseLabel?: string; totalCases: number },
): AnalysisResult {
  const warnings = [...(parts.warnings ?? [])];
  const lb = lowBaseWarning(ds.cases.length);
  if (lb) warnings.unshift(lb);
  if (ds.weighted && ds.weightInfo && ds.weightInfo.efficiency < 70) warnings.push(`Weighting efficiency is ${ds.weightInfo.efficiency.toFixed(0)}% (design effect ${ds.weightInfo.designEffect.toFixed(2)}) — effective sample size is reduced.`);
  return {
    kind: def.kind, name: def.name,
    base: baseOf(ds, parts.totalCases, ds.cases.length, parts.baseLabel),
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
