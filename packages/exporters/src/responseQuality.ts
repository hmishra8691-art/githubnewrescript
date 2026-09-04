import ExcelJS from "exceljs";
import type { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary, flattenVariables } from "@rescript/engine";
import type { ResponseStateLike } from "./csv.js";

/**
 * Response data with the quality assessment — two sheets, as the researcher
 * asked for them:
 *
 *   Main Data          Response ID, the survey variables in dictionary order,
 *                      and (optionally) QUALITY_STATUS / QUALITY_SCORE /
 *                      FRAUD_RISK_SCORE / RESPONSE_STATUS as summary columns.
 *   Response Quality   one row per response: both scores, classification, one
 *                      flag column per signal category, counts, the primary
 *                      and secondary reasons, the detailed explanation, the
 *                      researcher's decision and when it was made.
 *
 * REMOVED responses are excluded from the dataset only when the caller asks
 * for a clean dataset (`dataset` option); the raw rows are never deleted and
 * the quality sheet lists them either way so the decision is visible.
 *
 * The assessment shape is `@rescript/quality`'s QualityAssessment; it is typed
 * loosely here so the exporter does not depend on that package.
 */

export interface QualityLike {
  qualityScore: number;
  riskScore: number;
  classification: string;
  recommendation?: string;
  categories?: Record<string, number>;
  flags?: { ruleId: string; category: string; severity: string; title: string; observed?: string; expected?: string; explanation?: string; riskPoints?: number; qualityPenalty?: number }[];
  reasons?: string[];
  cluster?: { clusterId: string | null; size?: number; similarSessionIds?: string[] };
  system?: Record<string, unknown>;
}

export interface QualityExportRow {
  state: ResponseStateLike & { completedAt?: string | null; isTest?: boolean };
  quality: QualityLike | null;
  review: { status: string | null; reason?: string | null; by?: string | null; at?: string | null };
}

export type DatasetFilter =
  | { kind: "all" }
  /** approved (KEEP) plus unreviewed CLEAN — the default "clean dataset" */
  | { kind: "clean" }
  /** everything not REMOVED and not in the excluded classifications */
  | { kind: "custom"; exclude: string[] };

/** Which rows belong in the dataset the researcher chose. Removed rows never do, except in "all". */
export function inDataset(row: QualityExportRow, filter: DatasetFilter): boolean {
  const removed = row.review.status === "REMOVE";
  if (filter.kind === "all") return true;
  if (removed) return false;
  if (row.review.status === "KEEP") return true;
  const cls = row.quality?.classification ?? "UNSCORED";
  if (filter.kind === "clean") return cls === "CLEAN" || cls === "UNSCORED";
  return !filter.exclude.includes(cls);
}

const CATEGORY_FLAGS: [string, string][] = [
  ["timing", "Speeder Flag"], ["matrix", "Straightliner Flag"], ["attention", "Attention Flag"], ["consistency", "Consistency Flag"],
  ["open_end", "OpenEnd Flag"], ["bot", "Bot Flag"], ["duplicate", "Duplicate Flag"], ["pattern", "Pattern Flag"], ["navigation", "Navigation Flag"],
  ["device", "Device Flag"], ["network", "Network Flag"], ["cluster", "Cluster Flag"], ["interaction", "Interaction Flag"], ["screener", "Screener Flag"], ["custom", "Custom Rule Flag"],
];

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
function styleHeader(sheet: ExcelJS.Worksheet) {
  const h = sheet.getRow(1);
  h.font = { bold: true, color: { argb: "FFFFFFFF" } };
  h.eachCell((c) => { c.fill = HEADER_FILL; c.alignment = { vertical: "middle" }; });
  h.height = 18;
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 1 }];
}

const cell = (v: unknown) => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join("|") : typeof v === "object" ? JSON.stringify(v) : v);

export interface ResponseXlsxOptions {
  dataset?: DatasetFilter;
  /** add QUALITY_STATUS / QUALITY_SCORE / FRAUD_RISK_SCORE / RESPONSE_STATUS to Main Data */
  qualityColumns?: boolean;
}

export async function exportResponsesXlsx(def: SurveyDefinition, rows: QualityExportRow[], opts: ResponseXlsxOptions = {}): Promise<Buffer> {
  const filter = opts.dataset ?? { kind: "all" };
  const dict = buildVariableDictionary(def);
  const varNames: string[] = [];
  const seen = new Set<string>();
  for (const v of dict) { if (v.responseType === "system" || seen.has(v.name)) continue; seen.add(v.name); varNames.push(v.name); }

  const wb = new ExcelJS.Workbook();
  wb.creator = "rescript";
  wb.created = new Date(0);

  /* ---------------------------------------------------------- Main Data */
  const main = wb.addWorksheet("Main Data");
  const qualityCols = opts.qualityColumns ? ["QUALITY_STATUS", "QUALITY_SCORE", "FRAUD_RISK_SCORE", "RESPONSE_STATUS"] : [];
  const header = ["Response ID", "Status", "Start Time", "End Time", ...varNames, ...qualityCols];
  main.columns = header.map((h) => ({ header: h, key: h, width: Math.min(40, Math.max(12, h.length + 2)) }));
  const included = rows.filter((r) => inDataset(r, filter));
  for (const r of included) {
    const flat = flattenVariables(def, r.state as any);
    const line: unknown[] = [r.state.sessionId, r.state.status, r.state.startedAt ?? "", r.state.completedAt ?? ""];
    for (const v of varNames) line.push(cell(flat[v]));
    if (opts.qualityColumns) {
      line.push(r.quality?.classification ?? "UNSCORED", r.quality?.qualityScore ?? "", r.quality?.riskScore ?? "", r.review.status === "REMOVE" ? "REMOVED" : r.review.status === "KEEP" ? "KEPT" : r.review.status === "REVIEW_LATER" ? "REVIEW_LATER" : "ACTIVE");
    }
    main.addRow(line);
  }
  styleHeader(main);
  main.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };

  /* ---------------------------------------------------- Response Quality */
  const q = wb.addWorksheet("Response Quality");
  const qHeader = [
    "Response ID", "In Dataset", "Quality Score", "Fraud Risk Score", "Classification", "Recommendation",
    ...CATEGORY_FLAGS.map(([, label]) => label),
    "Total Flags", "High Severity Flags", "Cluster ID", "Similar Respondents",
    "Primary Reason", "Secondary Reasons", "Detailed Explanation",
    "Researcher Decision", "Decision Reason", "Decided By", "Decision Timestamp",
  ];
  q.columns = qHeader.map((h) => ({ header: h, key: h, width: h.includes("Explanation") ? 80 : h.includes("Reason") ? 50 : Math.max(12, h.length + 2) }));
  for (const r of rows) {
    const a = r.quality;
    const flags = a?.flags ?? [];
    const cats = new Set(flags.map((f) => f.category));
    const reasons = a?.reasons ?? [];
    const detailed = flags.map((f) => `• ${f.title}: ${f.observed ?? ""}${f.expected ? ` (expected ${f.expected})` : ""} — ${f.explanation ?? ""} [${f.severity}, +${f.riskPoints ?? 0} risk, −${f.qualityPenalty ?? 0} quality]`).join("\n");
    q.addRow([
      r.state.sessionId, inDataset(r, filter) ? "YES" : "NO",
      a?.qualityScore ?? "", a?.riskScore ?? "", a?.classification ?? "UNSCORED", a?.recommendation ?? "",
      ...CATEGORY_FLAGS.map(([c]) => (cats.has(c) ? 1 : 0)),
      flags.length, flags.filter((f) => f.severity === "high" || f.severity === "critical").length,
      a?.cluster?.clusterId ?? "", (a?.cluster?.similarSessionIds ?? []).slice(0, 20).join("|"),
      reasons[0] ?? "", reasons.slice(1).join(" | "), detailed,
      r.review.status ?? "", r.review.reason ?? "", r.review.by ?? "", r.review.at ?? "",
    ]);
  }
  styleHeader(q);
  q.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: qHeader.length } };
  q.getColumn(qHeader.indexOf("Detailed Explanation") + 1).alignment = { wrapText: true, vertical: "top" };

  /* --------------------------------------------------------- Read Me */
  const info = wb.addWorksheet("About");
  info.columns = [{ header: "Field", key: "f", width: 28 }, { header: "Value", key: "v", width: 90 }];
  info.addRows([
    ["Survey", `${def.meta.code} — ${def.meta.title} (v${def.meta.version})`],
    ["Dataset", filter.kind === "all" ? "All responses (REMOVED responses included — see Response Quality → Researcher Decision)" : filter.kind === "clean" ? "Clean dataset: KEEP decisions plus unreviewed CLEAN responses; REMOVED excluded" : `Custom dataset: excludes ${filter.exclude.join(", ")} and REMOVED`],
    ["Rows in Main Data", included.length],
    ["Rows assessed", rows.filter((r) => r.quality).length],
    ["Quality Score", "0–100, 100 = very high-quality response (answers, attention, open ends)"],
    ["Fraud Risk Score", "0–100, 100 = extremely suspicious (duplicates, automation, coordination, network). Kept separate from quality on purpose."],
    ["Classification", `From the fraud-risk bands configured on the survey (${def.quality?.bands ? `REVIEW ≥ ${def.quality.bands.review}, SUSPICIOUS ≥ ${def.quality.bands.suspicious}, HIGHLY_SUSPICIOUS ≥ ${def.quality.bands.highlySuspicious}, CRITICAL ≥ ${def.quality.bands.critical}` : "defaults"})`],
    ["Strictness", def.quality?.strictness ?? "standard"],
    ["Important", "Every flag is a risk indicator that requires researcher judgement, never proof. Removed responses are retained in the database and can be restored."],
    ["Exported", new Date().toISOString()],
  ]);
  styleHeader(info);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** CSV columns appended to the main data when quality columns are requested. */
export const QUALITY_CSV_COLUMNS = ["QUALITY_STATUS", "QUALITY_SCORE", "FRAUD_RISK_SCORE", "RESPONSE_STATUS"] as const;
export function qualityCsvCells(row: QualityExportRow): (string | number)[] {
  return [
    row.quality?.classification ?? "UNSCORED", row.quality?.qualityScore ?? "", row.quality?.riskScore ?? "",
    row.review.status === "REMOVE" ? "REMOVED" : row.review.status === "KEEP" ? "KEPT" : row.review.status === "REVIEW_LATER" ? "REVIEW_LATER" : "ACTIVE",
  ];
}
