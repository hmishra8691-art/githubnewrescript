/**
 * THE CONJOINT SIMULATOR TO EXCEL AND POWERPOINT (F4, 2026-10-22).
 *
 * A conjoint result (Conjoint or Hierarchical Bayes analysis) carries its simulator tables
 * (`sim_*`, `menu_sim*`, `menu_curve_*`, the importance and utilities); these turn exactly those
 * tables into a workbook (one sheet per table, through the platform's own Excel writer) and a deck
 * (a title slide, then one table slide each, through the PowerPoint writer) — the same numbers the
 * screen shows, nothing recomputed.
 */
import type { AnalysisResult, ReportDefinition } from "../types.js";
import { buildXlsx } from "./xlsx.js";
import { buildPptx } from "./pptx.js";

const SIM = /^(?:importance|partworths|hb_mean|hb_importance|sim\d*_|menu_sim|menu_curve_|menu_model|acbc_price|holdout|fit$)/;

/** the simulator report: the result's simulator tables, importance and utilities, in result order */
export function simulatorReport(result: AnalysisResult, title = "Market simulator"): Pick<ReportDefinition, "title" | "subtitle" | "blocks"> {
  const tables = result.tables.filter((t) => SIM.test(t.id));
  return {
    title, subtitle: result.name,
    blocks: [{ id: "cover", type: "cover", title }, ...tables.map((t, i) => ({ id: `t${i}`, type: "table" as const, title: t.title, analysisId: "sim", tableId: t.id })), { id: "ins", type: "insights", analysisIds: ["sim"] }] as ReportDefinition["blocks"],
  };
}

export function buildSimulatorXlsx(result: AnalysisResult, title?: string): Promise<Buffer> {
  return buildXlsx({ report: simulatorReport(result, title), results: { sim: result }, meta: { analysis: result.name } });
}

export function buildSimulatorPptx(result: AnalysisResult, title?: string): Promise<Buffer> {
  return buildPptx({ report: simulatorReport(result, title), results: { sim: result }, meta: { survey: result.name } });
}
