/**
 * THE CSV EXPORT (M6) — every table of a report definition, one after another, in one file a spreadsheet opens:
 * a `#` line naming the analysis and the table, the header, the rows (numbers as numbers, significance letters in
 * their own column beside the value), a blank line. Nothing is formatted away: a percentage is the number, the
 * column header says it is one.
 */
import type { AnalysisResult, ReportDefinition, ResultTable } from "../types.js";

export interface CsvInput { report: Pick<ReportDefinition, "title" | "blocks">; results: Record<string, AnalysisResult>; /** every table of every analysis, not only the blocks' first (default true) */ allTables?: boolean }

const cell = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function tableCsv(name: string, t: ResultTable): string {
  const cols = t.columns.filter((c) => !/^__/.test(c.key));
  const sigCols = cols.filter((c) => t.rows.some((r) => typeof r[`${c.key}__sig`] === "string" && r[`${c.key}__sig`]));
  const header = cols.flatMap((c) => [`${c.label}${c.type === "pct" ? " (%)" : ""}`, ...(sigCols.includes(c) ? [`${c.label} sig.`] : [])]);
  const lines = [`# ${name} — ${t.title}${t.base ? ` (n = ${t.base.n})` : ""}`, header.map(cell).join(",")];
  for (const r of t.rows) lines.push(cols.flatMap((c) => [cell(r[c.key]), ...(sigCols.includes(c) ? [cell(r[`${c.key}__sig`])] : [])]).join(","));
  for (const n of t.notes ?? []) lines.push(`# ${n}`);
  return lines.join("\n");
}

export function buildCsv(input: CsvInput): string {
  const parts: string[] = [`# ${input.report.title}`];
  const seen = new Set<string>();
  for (const b of input.report.blocks) {
    if (!("analysisId" in b) || !b.analysisId) continue;
    const r = input.results[b.analysisId]; if (!r || r.error) continue;
    const tables = b.type === "table" && b.tableId ? r.tables.filter((t) => t.id === b.tableId) : input.allTables === false ? r.tables.slice(0, 1) : r.tables;
    for (const t of tables) { const k = `${b.analysisId}:${t.id}`; if (seen.has(k)) continue; seen.add(k); parts.push(tableCsv(r.name, t)); }
  }
  return `${parts.join("\n\n")}\n`;
}
