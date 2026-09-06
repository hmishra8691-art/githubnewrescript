/**
 * EXCEL EXPORT (§20, §21). Structured, editable workbooks: a Summary sheet with
 * the executive summary and base sizes, then one sheet per result table
 * (frequencies, crosstabs with significance letters, statistical tests,
 * segments, NPS, conjoint, MaxDiff, …), a Charts-data sheet with the series
 * behind each chart, and Metadata. Sheet names, number formats, table style,
 * freeze panes and auto-filter follow the export settings.
 */
import ExcelJS from "exceljs";
import type { AnalysisResult, ChartSpec, ExportSettings, ReportDefinition, ReportTheme, ResultTable } from "../types.js";
import { DEFAULT_EXPORT_SETTINGS, DEFAULT_THEME } from "../types.js";
import { executiveSummary } from "../summary.js";
import { seriesForChart } from "./shared.js";

export interface XlsxInput {
  report: Pick<ReportDefinition, "title" | "subtitle" | "blocks">;
  results: Record<string, AnalysisResult>;
  theme?: ReportTheme | null;
  settings?: Partial<ExportSettings>;
  meta?: Record<string, string | number | null | undefined>;
}

const argb = (c: string) => "FF" + c.replace("#", "").slice(0, 6).toUpperCase();

function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 28) || "Sheet";
  let out = base, i = 2;
  while (used.has(out.toLowerCase())) out = `${base.slice(0, 25)} (${i++})`;
  used.add(out.toLowerCase());
  return out;
}

function writeTable(ws: ExcelJS.Worksheet, table: ResultTable, theme: ReportTheme, x: ExportSettings["xlsx"], startRow: number, title?: string): number {
  let r = startRow;
  if (title) { ws.getCell(r, 1).value = title; ws.getCell(r, 1).font = { bold: true, size: 12, color: { argb: argb(theme.colors.primary) } }; r++; }
  if (table.base) { ws.getCell(r, 1).value = `Base: n = ${table.base.n}${table.base.weightedN != null && table.base.weightedN !== table.base.n ? ` (weighted ${table.base.weightedN})` : ""}${table.base.label ? ` — ${table.base.label}` : ""}`; ws.getCell(r, 1).font = { italic: true, size: 9, color: { argb: "FF64748B" } }; r++; }
  const sigCols = table.columns.filter((c) => table.rows.some((row) => row[`${c.key}__sig`]));
  const header = table.columns.flatMap((c) => (sigCols.includes(c) ? [c.label, "sig."] : [c.label]));
  const hr = ws.getRow(r);
  header.forEach((h, i) => { const cell = hr.getCell(i + 1); cell.value = h; cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(theme.colors.primary) } }; cell.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "center", wrapText: true }; if (x?.tableStyle !== "plain") cell.border = { bottom: { style: "thin", color: { argb: "FFD9DEE6" } } }; });
  const headerRow = r; r++;
  table.rows.forEach((row, ri) => {
    let ci = 1;
    for (const c of table.columns) {
      const v = row[c.key];
      const cell = ws.getCell(r, ci++);
      const ctype = (row.__format as string | undefined) ?? c.type;
      if (typeof v === "number") {
        cell.value = ctype === "pct" ? v / 100 : v;
        cell.numFmt = ctype === "pct" ? (x?.percentFormat ?? "0.0%") : ctype === "count" ? "#,##0" : `#,##0${(c.decimals ?? x?.decimals ?? 1) > 0 ? "." + "0".repeat(c.decimals ?? x?.decimals ?? 1) : ""}`;
        cell.alignment = { horizontal: "right" };
      } else cell.value = v == null ? "" : String(v);
      if (x?.tableStyle === "striped" && ri % 2) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F7FA" } };
      if (x?.tableStyle === "bordered") cell.border = { top: { style: "thin", color: { argb: "FFD9DEE6" } }, bottom: { style: "thin", color: { argb: "FFD9DEE6" } }, left: { style: "thin", color: { argb: "FFD9DEE6" } }, right: { style: "thin", color: { argb: "FFD9DEE6" } } };
      if (sigCols.includes(c)) { const sc = ws.getCell(r, ci++); sc.value = row[`${c.key}__sig`] ? String(row[`${c.key}__sig`]) : ""; sc.font = { bold: true, color: { argb: argb(theme.colors.accent) } }; sc.alignment = { horizontal: "center" }; }
    }
    r++;
  });
  if (x?.autoFilter && table.rows.length > 1) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: r - 1, column: header.length } };
  if (x?.includeNotes && table.notes?.length) { for (const n of table.notes) { ws.getCell(r, 1).value = n; ws.getCell(r, 1).font = { italic: true, size: 9, color: { argb: "FF64748B" } }; r++; } }
  return r + 1;
}

export async function buildXlsx(input: XlsxInput): Promise<Buffer> {
  const theme = input.theme ?? DEFAULT_THEME;
  const settings: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, format: "xlsx", ...input.settings, include: { ...DEFAULT_EXPORT_SETTINGS.include, ...input.settings?.include }, xlsx: { ...DEFAULT_EXPORT_SETTINGS.xlsx, ...input.settings?.xlsx } };
  const x = settings.xlsx!;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Rescript Analytics";
  wb.created = new Date();
  const used = new Set<string>();
  const nameFor = (key: string, fallback: string) => safeSheetName(x.sheetNames?.[key] ?? fallback, used);
  const font = (x.fontFamily ?? theme.fontFamily).split(",")[0].trim();
  const results = input.report.blocks.flatMap((b) => ("analysisId" in b && b.analysisId && input.results[b.analysisId] ? [{ id: b.analysisId, title: ("title" in b && b.title) || input.results[b.analysisId].name, result: input.results[b.analysisId], block: b }] : [])).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);

  // Summary
  const summary = wb.addWorksheet(nameFor("summary", "Summary"));
  summary.getCell("A1").value = input.report.title; summary.getCell("A1").font = { bold: true, size: 16, color: { argb: argb(theme.colors.primary) } };
  if (input.report.subtitle) { summary.getCell("A2").value = input.report.subtitle; summary.getCell("A2").font = { size: 11, color: { argb: "FF64748B" } }; }
  let r = 4;
  if (settings.include.executiveSummary) {
    summary.getCell(r, 1).value = "Executive summary"; summary.getCell(r, 1).font = { bold: true, size: 12 }; r++;
    for (const it of executiveSummary(results.map((x) => ({ name: x.title, result: x.result })))) {
      summary.getCell(r, 1).value = it.analysis; summary.getCell(r, 1).font = { bold: true };
      summary.getCell(r, 2).value = `${it.headline}${it.supporting.length ? " " + it.supporting.join(" ") : ""}`; summary.getCell(r, 2).alignment = { wrapText: true, vertical: "top" };
      summary.getCell(r, 3).value = it.base; r++;
    }
    r++;
  }
  summary.getCell(r, 1).value = "Analyses in this report"; summary.getCell(r, 1).font = { bold: true, size: 12 }; r++;
  ["Analysis", "Type", "Base n", "Weighted n", "Sheet", "Variables"].forEach((h, i) => { const c = summary.getCell(r, i + 1); c.value = h; c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(theme.colors.primary) } }; }); r++;
  const sheetNames = new Map<string, string>();
  for (const it of results) { const sn = nameFor(it.id, it.title); sheetNames.set(it.id, sn); summary.getCell(r, 1).value = it.title; summary.getCell(r, 2).value = it.result.kind; summary.getCell(r, 3).value = it.result.base.n; summary.getCell(r, 4).value = it.result.base.weightedN; summary.getCell(r, 5).value = { text: sn, hyperlink: `#'${sn}'!A1` }; summary.getCell(r, 5).font = { color: { argb: argb(theme.colors.primary) }, underline: true }; summary.getCell(r, 6).value = it.result.variablesUsed.join(", "); r++; }
  summary.columns = [{ width: 32 }, { width: 70 }, { width: 14 }, { width: 14 }, { width: 28 }, { width: 40 }];

  // one sheet per analysis
  const order = x.sheetOrder?.length ? [...results].sort((a, b) => (x.sheetOrder!.indexOf(a.id) + 1 || 999) - (x.sheetOrder!.indexOf(b.id) + 1 || 999)) : results;
  for (const it of order) {
    const ws = wb.addWorksheet(sheetNames.get(it.id)!);
    ws.getCell("A1").value = it.title; ws.getCell("A1").font = { bold: true, size: 14, color: { argb: argb(theme.colors.primary) } };
    ws.getCell("A2").value = `${it.result.kind} · base n = ${it.result.base.n}${it.result.base.weightedN !== it.result.base.n ? ` (weighted ${it.result.base.weightedN})` : ""} · computed ${it.result.computedAt.slice(0, 16).replace("T", " ")}`; ws.getCell("A2").font = { size: 9, color: { argb: "FF64748B" } };
    let row = 4;
    if (it.result.insights.length) { ws.getCell(row, 1).value = "Insights"; ws.getCell(row, 1).font = { bold: true }; row++; for (const ins of it.result.insights) { ws.getCell(row, 1).value = ins; row++; } row++; }
    if (settings.include.tables) for (const t of it.result.tables) row = writeTable(ws, t, theme, x, row, t.title);
    if (settings.include.tests && it.result.tests.length && !it.result.tables.some((t) => t.id === "tests")) {
      row = writeTable(ws, { id: "tests", title: "Statistical tests", columns: [{ key: "test", label: "Test" }, { key: "statistic", label: "Statistic", type: "number", decimals: 3 }, { key: "df", label: "df" }, { key: "p", label: "p-value", type: "number", decimals: 4 }, { key: "effect", label: "Effect size" }, { key: "note", label: "Note" }], rows: it.result.tests.map((t) => ({ test: t.test, statistic: t.statistic, df: Array.isArray(t.df) ? t.df.join(", ") : t.df ?? "", p: t.p, effect: t.effectSize ? `${t.effectSize.name} = ${t.effectSize.value?.toFixed(3) ?? "—"}` : "", note: t.note ?? "" })) }, theme, x, row, "Statistical tests");
    }
    if (it.result.warnings.length) { ws.getCell(row, 1).value = "Notes"; ws.getCell(row, 1).font = { bold: true }; row++; for (const w of it.result.warnings) { ws.getCell(row, 1).value = w; ws.getCell(row, 1).font = { italic: true, color: { argb: "FF9A3412" } }; row++; } }
    ws.columns = [{ width: 34 }, ...Array.from({ length: 12 }, () => ({ width: 14 }))];
    if (x.freezePanes) ws.views = [{ state: "frozen", ySplit: 2 }];
    ws.eachRow((rw) => rw.eachCell((c) => { c.font = { ...(c.font ?? {}), name: font }; }));
  }

  // chart data
  if (settings.include.charts) {
    const cs = wb.addWorksheet(nameFor("charts", "Chart data"));
    let row = 1;
    for (const b of input.report.blocks) {
      if (b.type !== "chart" || !input.results[b.analysisId]) continue;
      const res = input.results[b.analysisId];
      const spec: ChartSpec = b.chart;
      const series = seriesForChart(res, spec);
      if (!series.length) continue;
      cs.getCell(row, 1).value = b.title ?? spec.options.title ?? res.name; cs.getCell(row, 1).font = { bold: true, size: 12, color: { argb: argb(theme.colors.primary) } }; row++;
      cs.getCell(row, 1).value = `Chart type: ${spec.type} · base n = ${res.base.n}`; cs.getCell(row, 1).font = { size: 9, color: { argb: "FF64748B" } }; row++;
      const hr = cs.getRow(row); hr.getCell(1).value = "Category"; series.forEach((s, i) => { hr.getCell(i + 2).value = s.name; }); hr.font = { bold: true }; row++;
      series[0].labels.forEach((lab, li) => { cs.getCell(row, 1).value = lab; series.forEach((s, si) => { const c = cs.getCell(row, si + 2); c.value = s.meta?.pct && s.values[li] != null ? s.values[li]! / 100 : s.values[li]; if (s.meta?.pct) c.numFmt = x.percentFormat ?? "0.0%"; }); row++; });
      row++;
    }
    cs.columns = [{ width: 34 }, ...Array.from({ length: 10 }, () => ({ width: 16 }))];
  }

  if (x.includeMetadata) {
    const ms = wb.addWorksheet(nameFor("metadata", "Metadata"));
    const rows: [string, unknown][] = [["Report", input.report.title], ["Generated", new Date().toISOString()], ["Generator", "Rescript Analytics"], ["Theme", theme.name], ...Object.entries(input.meta ?? {}).map(([k, v]) => [k, v ?? ""] as [string, unknown]), ...results.map((it) => [`${it.title} — definition hash`, it.result.definitionHash] as [string, unknown])];
    rows.forEach(([k, v], i) => { ms.getCell(i + 1, 1).value = k; ms.getCell(i + 1, 1).font = { bold: true }; ms.getCell(i + 1, 2).value = v as ExcelJS.CellValue; });
    ms.columns = [{ width: 40 }, { width: 60 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
