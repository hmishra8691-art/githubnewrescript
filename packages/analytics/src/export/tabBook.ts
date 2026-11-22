/**
 * TAB BOOK (Level 5 roadmap M2). A run tab plan as an Excel workbook: a Contents sheet (plan, banner, filter,
 * weighting, significance level, one linked line per table with its base, and every stub the run could not make),
 * then one sheet per table in the same formatted style as the report export — header band, percentages as real
 * percentages, significance letters in their own column, the base above and the notes and warnings below.
 */
import ExcelJS from "exceljs";
import type { ReportTheme } from "../types.js";
import { DEFAULT_EXPORT_SETTINGS, DEFAULT_THEME } from "../types.js";
import type { TabRun } from "../tabPlan.js";
import { writeTable } from "./xlsx.js";

const argb = (c: string) => "FF" + c.replace("#", "").slice(0, 6).toUpperCase();

export async function buildTabBook(run: TabRun, opts: { theme?: ReportTheme | null; labelOf?: (v: string) => string; meta?: Record<string, string | number | null | undefined> } = {}): Promise<Buffer> {
  const theme = opts.theme ?? DEFAULT_THEME;
  const x = { ...DEFAULT_EXPORT_SETTINGS.xlsx!, autoFilter: false };
  const label = opts.labelOf ?? ((v: string) => v);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Rescript"; wb.created = new Date(run.computedAt);
  const toc = wb.addWorksheet("Contents");
  toc.getColumn(1).width = 10; toc.getColumn(2).width = 70; toc.getColumn(3).width = 14;
  let r = 1;
  toc.getCell(r, 1).value = run.plan.name; toc.getCell(r, 1).font = { bold: true, size: 14, color: { argb: argb(theme.colors.primary) } }; r += 2;
  const p = run.plan;
  const lines: [string, string][] = [
    ["Banner", p.banner.columns.map(label).join(" | ") + (p.banner.nets?.length ? ` (+ nets: ${p.banner.nets.map((n) => n.label).join(", ")})` : "")],
    ["Respondents", `${p.dataset.environment} data, ${p.dataset.dataset === "all" ? "all responses" : p.dataset.dataset === "clean" ? "quality-clean responses only" : `quality classes ${(p.dataset.qualityClasses ?? []).join(", ")}`}${p.filter ? ", filtered (see each table's base)" : ""}`],
    ["Weighting", p.weighting ? "weighted — bases show unweighted n" : "unweighted"],
    ["Significance", p.alpha === false ? "not tested" : `letters mark a column significantly higher than the lettered columns at the ${Math.round((1 - (p.alpha ?? 0.05)) * 100)}% level (column proportion / mean z-tests, Holm-adjusted within each row)`],
    ["Computed", run.computedAt],
    ...Object.entries(opts.meta ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)] as [string, string]),
  ];
  for (const [k, v] of lines) { toc.getCell(r, 1).value = k; toc.getCell(r, 1).font = { bold: true }; toc.getCell(r, 2).value = v; toc.getCell(r, 2).alignment = { wrapText: true }; r++; }
  r++;
  const hr = toc.getRow(r);
  ["Table", "Title", "Base (n)"].forEach((h, i) => { const c = hr.getCell(i + 1); c.value = h; c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(theme.colors.primary) } }; });
  r++;
  const used = new Set<string>(["contents"]);
  for (const t of run.tables) {
    let name = `T${t.number}`; while (used.has(name.toLowerCase())) name += "_"; used.add(name.toLowerCase());
    toc.getCell(r, 1).value = { text: name, hyperlink: `#'${name}'!A1` }; toc.getCell(r, 1).font = { color: { argb: "FF1D4ED8" }, underline: true };
    toc.getCell(r, 2).value = t.title; toc.getCell(r, 3).value = t.base.n; toc.getCell(r, 3).numFmt = "#,##0";
    r++;
    const ws = wb.addWorksheet(name);
    ws.getColumn(1).width = 42;
    for (let c = 2; c <= 2 * t.table.columns.length + 1; c++) ws.getColumn(c).width = 11;
    ws.getCell(1, 1).value = { text: "← Contents", hyperlink: "#'Contents'!A1" }; ws.getCell(1, 1).font = { color: { argb: "FF1D4ED8" }, size: 9 };
    const tableBase = t.table.base ?? { n: t.base.n, weightedN: t.base.weightedN, label: t.base.label };
    let end = writeTable(ws, { ...t.table, base: tableBase }, theme, x, 2, `${name}. ${t.title}`);
    for (const w of t.warnings) { ws.getCell(end, 1).value = `⚠ ${w}`; ws.getCell(end, 1).font = { size: 9, color: { argb: "FFB45309" } }; end++; }
    ws.views = [{ state: "frozen", xSplit: 1, ySplit: 4 }];
  }
  if (run.problems.length) {
    r++;
    toc.getCell(r, 1).value = "Not made / to check"; toc.getCell(r, 1).font = { bold: true, color: { argb: "FFB45309" } }; r++;
    for (const pr of run.problems) { toc.getCell(r, 2).value = pr; toc.getCell(r, 2).alignment = { wrapText: true }; r++; }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
