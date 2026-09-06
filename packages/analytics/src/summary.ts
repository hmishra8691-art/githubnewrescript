/**
 * EXECUTIVE SUMMARY (§22): assembled from the insights each analysis produced,
 * never invented. A report's summary block lists the headline finding of each
 * included analysis, with its base, so every sentence traces to a table.
 */
import type { AnalysisResult } from "./types.js";

export interface SummaryItem { analysis: string; kind: string; headline: string; supporting: string[]; base: string; warnings: string[] }

export function executiveSummary(results: { name: string; result: AnalysisResult }[]): SummaryItem[] {
  return results.filter((r) => r.result.insights.length).map(({ name, result }) => ({
    analysis: name, kind: result.kind, headline: result.insights[0], supporting: result.insights.slice(1, 4),
    base: `n = ${result.base.n}${result.base.weightedN !== result.base.n ? ` (weighted ${result.base.weightedN})` : ""}${result.base.label && result.base.label !== "All respondents" && !/respondents$/.test(result.base.label) ? `, ${result.base.label}` : ""}`,
    warnings: result.warnings,
  }));
}

export function summaryText(items: SummaryItem[]): string {
  return items.map((it) => `${it.analysis}: ${it.headline}${it.supporting.length ? " " + it.supporting.join(" ") : ""} (${it.base})`).join("\n\n");
}
