import type { AnalysisResult, ReportBlock, ReportDefinition } from "./types.js";

/**
 * ONE MODEL OF A DELIVERABLE (Level 5 roadmap R1, 2026-11-22).
 *
 * A report is a `ReportDefinition`: findings (executive summary, insights), charts, tables, KPIs, panel grids, text,
 * methodology, plus the viewer filters and segments a share may switch. A dashboard is the same model once its widgets
 * are read in order (`reportForExport`). Every output format renders THAT, through one entry point
 * (export/render.ts `renderReport`), and this file says — before anything is built — how each block will appear in
 * each format, so a block a format cannot draw is never dropped without a word.
 *
 *   native     drawn as itself (a PowerPoint chart is an editable chart)
 *   expanded   rendered through simpler blocks (a panel grid in a linear document becomes its headline and its panels)
 *   data       the numbers behind it, not the picture (a chart in Word or Excel is its data table)
 *   omitted    not part of this format (layout markers in a workbook), said in the coverage notes
 *
 * Browser-safe: no Node imports (the Studio shows the coverage before an export).
 */
export const REPORT_FORMATS = ["pptx", "pdf", "docx", "xlsx", "csv"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export type Rendering = "native" | "expanded" | "data" | "omitted";
export type BlockType = ReportBlock["type"];

const ALL: BlockType[] = ["cover", "section", "text", "chart", "table", "kpi", "insights", "executive_summary", "panel_grid", "page_break", "methodology"];

export const BLOCK_RENDERING: Record<ReportFormat, Record<BlockType, Rendering>> = {
  pptx: { cover: "native", section: "native", text: "native", chart: "native", table: "native", kpi: "native", insights: "native", executive_summary: "native", panel_grid: "native", page_break: "native", methodology: "native" },
  pdf: { cover: "native", section: "native", text: "native", chart: "native", table: "native", kpi: "native", insights: "native", executive_summary: "native", panel_grid: "expanded", page_break: "native", methodology: "native" },
  docx: { cover: "native", section: "native", text: "native", chart: "data", table: "native", kpi: "native", insights: "native", executive_summary: "native", panel_grid: "expanded", page_break: "native", methodology: "native" },
  xlsx: { cover: "omitted", section: "omitted", text: "omitted", chart: "data", table: "native", kpi: "data", insights: "omitted", executive_summary: "omitted", panel_grid: "data", page_break: "omitted", methodology: "native" },
  csv: { cover: "omitted", section: "omitted", text: "omitted", chart: "data", table: "native", kpi: "data", insights: "omitted", executive_summary: "omitted", panel_grid: "data", page_break: "omitted", methodology: "omitted" },
};

const WORDS: Record<Rendering, string> = { native: "drawn as itself", expanded: "rendered as its headline and its panels, one after another", data: "given as its data table", omitted: "not included in this format" };

/** the blocks a linear document (PDF, Word) reads: a panel grid becomes its headline as text, then each filled panel as a chart or a table */
export function expandPanels(blocks: ReportBlock[]): ReportBlock[] {
  const out: ReportBlock[] = [];
  for (const b of blocks) {
    if (b.type !== "panel_grid") { out.push(b); continue; }
    if (b.title || b.headline) out.push({ id: `${b.id}__head`, type: "text", ...(b.title ? { title: b.title } : {}), markdown: b.headline ?? "" });
    for (const p of b.panels) {
      if (!p.analysisId) continue;
      if (p.chart) out.push({ id: `${b.id}__${p.id}`, type: "chart", ...(p.title ? { title: p.title } : {}), analysisId: p.analysisId, chart: p.chart, ...(p.caption ? { caption: p.caption } : {}) });
      else out.push({ id: `${b.id}__${p.id}`, type: "table", ...(p.title ? { title: p.title } : {}), analysisId: p.analysisId, ...(p.tableId ? { tableId: p.tableId } : {}), ...(p.caption ? { caption: p.caption } : {}) });
    }
  }
  return out;
}

export interface CoverageLine { blockId: string; type: BlockType; title: string; rendering: Rendering; problem?: string }
export interface Coverage { format: ReportFormat; lines: CoverageLine[]; notes: string[]; renderable: boolean }

const titleOf = (b: ReportBlock): string => ("title" in b && typeof b.title === "string" && b.title) || b.type.replace("_", " ");
const refs = (b: ReportBlock): string[] =>
  b.type === "chart" || b.type === "table" || b.type === "kpi" ? (b.analysisId ? [b.analysisId] : [])
    : b.type === "panel_grid" ? b.panels.map((p) => p.analysisId).filter(Boolean)
    : b.type === "insights" || b.type === "executive_summary" ? b.analysisIds : [];

/**
 * How `report` will come out as `format`, block by block, with the analyses that are missing or failed named — what
 * the export screen shows before building, and what an export returns as its notes. `renderable` is false when no
 * block with data would appear (the file would be a shell).
 */
export function reportCoverage(report: Pick<ReportDefinition, "blocks">, format: ReportFormat, results: Record<string, AnalysisResult> = {}): Coverage {
  const table = BLOCK_RENDERING[format];
  const lines: CoverageLine[] = report.blocks.map((b) => {
    const rendering = table[b.type] ?? "omitted";
    const bad = refs(b).filter((id) => !results[id] || results[id].error || (results[id].base?.n ?? 0) === 0);
    const problem = rendering !== "omitted" && bad.length ? `${bad.length === refs(b).length ? "no data" : "partly without data"}: ${bad.map((id) => results[id]?.error?.message ?? (results[id] ? "no respondents in the selected data" : "analysis not computed")).filter((v, i, a) => a.indexOf(v) === i).join("; ")}` : undefined;
    return { blockId: b.id, type: b.type, title: titleOf(b), rendering, ...(problem ? { problem } : {}) };
  });
  const notes: string[] = [];
  for (const r of ["expanded", "data", "omitted"] as Rendering[]) {
    const types = [...new Set(lines.filter((l) => l.rendering === r).map((l) => l.type))].filter((t) => !(r === "omitted" && t === "page_break"));
    if (types.length) notes.push(`${types.map((t) => t.replace("_", " ")).join(", ")}: ${WORDS[r]}.`);
  }
  for (const l of lines) if (l.problem) notes.push(`“${l.title}” — ${l.problem}.`);
  const renderable = lines.some((l) => l.rendering !== "omitted" && !l.problem && refs(report.blocks.find((b) => b.id === l.blockId)!).length > 0)
    || (format !== "xlsx" && format !== "csv" && lines.some((l) => (l.type === "text" || l.type === "methodology") && l.rendering !== "omitted"));
  return { format, lines, notes, renderable };
}

/** structural problems with a report definition, whatever the format: duplicate block ids, blocks with no analysis chosen */
export function checkReportModel(report: Pick<ReportDefinition, "blocks">): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const b of report.blocks) {
    if (seen.has(b.id)) problems.push(`Two blocks share the id “${b.id}”.`);
    seen.add(b.id);
    if ((b.type === "chart" || b.type === "table" || b.type === "kpi") && !b.analysisId) problems.push(`“${titleOf(b)}” has no analysis chosen.`);
    if (b.type === "panel_grid" && !b.panels.some((p) => p.analysisId)) problems.push(`The panel grid “${titleOf(b)}” has no panel filled.`);
  }
  return problems;
}

export const isReportFormat = (v: unknown): v is ReportFormat => typeof v === "string" && (REPORT_FORMATS as readonly string[]).includes(v);
export { ALL as REPORT_BLOCK_TYPES };
