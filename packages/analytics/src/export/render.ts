import type { AnalysisResult, DashboardDefinition, ExportSettings, ReportDefinition, ReportTheme } from "../types.js";
import { reportCoverage, type Coverage, type ReportFormat } from "../reportModel.js";
import { reportForExport, ExportUnsupportedError } from "./shared.js";
import { buildPptx } from "./pptx.js";
import { buildPdf, checkPdf } from "./pdf.js";
import { buildXlsx } from "./xlsx.js";
import { buildCsv } from "./csv.js";
import { buildReportDocx } from "./reportDocx.js";
import { checkDocx } from "./docxCheck.js";

/**
 * THE ONE WAY A REPORT BECOMES A FILE (Level 5 roadmap R1). A report — or a dashboard, read as the report its widgets
 * spell out — goes in with its results; the file comes out with its MIME type, a file name, the coverage (how each
 * block came out in this format, and which had no data) and a check that the bytes are the format they claim to be.
 * The Studio export, the share-link download and the scheduled delivery (R5/R6) all call this.
 */
export interface RenderInput {
  report: (ReportDefinition | DashboardDefinition) & { author?: string; date?: string };
  results: Record<string, AnalysisResult>;
  theme?: ReportTheme | null;
  settings?: Partial<ExportSettings>;
  meta?: { survey?: string; generatedBy?: string; [k: string]: string | number | null | undefined };
  /** client-drawn pictures by block id (maps, and charts for Word) */
  images?: Record<string, string>;
  notes?: Record<string, string[]>;
}
export interface Rendered { bytes: Buffer; mime: string; extension: ReportFormat; fileName: string; coverage: Coverage }

export const REPORT_MIME: Record<ReportFormat, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8",
};

export const reportFileName = (title: string, format: ReportFormat) => `${(title || "report").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 80) || "report"}.${format}`;

export async function renderReport(format: ReportFormat, input: RenderInput): Promise<Rendered> {
  const report = reportForExport(input.report) as ReportDefinition & { author?: string; date?: string };
  const coverage = reportCoverage(report, format, input.results);
  if (!coverage.renderable) throw new ExportUnsupportedError(`Nothing to put in the ${format.toUpperCase()}: ${coverage.notes.filter((n) => n.startsWith("“")).join(" ") || "no block in this report has data."}`);
  const meta = input.meta ?? {};
  let bytes: Buffer;
  switch (format) {
    case "pptx": bytes = await buildPptx({ report, results: input.results, theme: input.theme, settings: input.settings, meta: meta as never, images: input.images }); break;
    case "xlsx": bytes = await buildXlsx({ report, results: input.results, theme: input.theme, settings: input.settings, meta }); break;
    case "pdf": {
      bytes = await buildPdf({ report, results: input.results, theme: input.theme, meta: meta as never, notes: input.notes, settings: input.settings as never });
      const c = checkPdf(bytes); if (!c.ok) throw new Error(`the built PDF failed its check: ${c.problems.join("; ")}`);
      break;
    }
    case "docx": {
      bytes = await buildReportDocx({ report, results: input.results, theme: input.theme, meta: { survey: meta.survey as string | undefined, generatedBy: meta.generatedBy as string | undefined }, notes: input.notes, images: input.images, settings: input.settings as never });
      const c = checkDocx(bytes); if (!c.ok) throw new Error(`the built Word document failed its check: ${c.problems.join("; ")}`);
      break;
    }
    case "csv": bytes = Buffer.from(buildCsv({ report, results: input.results }), "utf8"); if (bytes.length < 10) throw new Error("the built CSV is empty"); break;
  }
  if ((format === "pptx" || format === "xlsx") && (bytes.length < 1500 || bytes.subarray(0, 2).toString("latin1") !== "PK")) throw new Error("the built file is empty or not a valid Office document");
  return { bytes, mime: REPORT_MIME[format], extension: format, fileName: reportFileName(report.title, format), coverage };
}
