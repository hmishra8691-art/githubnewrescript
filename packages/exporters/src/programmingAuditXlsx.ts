import ExcelJS from "exceljs";
import type { ProgrammingAuditRow } from "@rescript/engine";

/**
 * THE PROGRAMMING AUDIT LOG AS AN EXCEL SHEET (roadmap 3.6, tracker 3.1): one row per finding — #, severity,
 * category, location, object, issue, expected behaviour, actual behaviour, recommended correction, status (for the
 * programmer to fill in) — frozen header, filters, severity colours, plus an About sheet saying which survey and
 * version the log was taken from and when. Values are written as text, so no cell is read as a formula.
 */
const COLUMNS: { header: string; key: keyof ProgrammingAuditRow | "n" | "status"; width: number }[] = [
  { header: "#", key: "n", width: 5 },
  { header: "Severity", key: "severity", width: 10 },
  { header: "Category", key: "category", width: 22 },
  { header: "Location", key: "location", width: 14 },
  { header: "Object", key: "object", width: 30 },
  { header: "Issue", key: "issue", width: 60 },
  { header: "Expected behaviour", key: "expected", width: 48 },
  { header: "Actual behaviour", key: "actual", width: 48 },
  { header: "Recommended correction", key: "correction", width: 48 },
  { header: "Status", key: "status", width: 14 },
];
const FILL: Record<string, string> = { Critical: "FFFDE2E2", High: "FFFFEDD5", Medium: "FFFEF9C3", Low: "FFE0F2FE" };
/* a cell that starts with = + - @ would be read as a formula by a spreadsheet; prefix it so it stays text */
const safe = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export async function programmingAuditXlsx(rows: ProgrammingAuditRow[], meta: { surveyTitle: string; surveyCode: string; version: string; generatedAt?: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ResLens";
  wb.created = new Date(0);
  const ws = wb.addWorksheet("Programming audit");
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  rows.forEach((r, i) => {
    const row = ws.addRow({ n: i + 1, severity: r.severity, category: safe(r.category), location: safe(r.location), object: safe(r.object), issue: safe(r.issue), expected: safe(r.expected), actual: safe(r.actual), correction: safe(r.correction), status: "Open" });
    row.alignment = { vertical: "top", wrapText: true };
    row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[r.severity] ?? "FFFFFFFF" } };
  });
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  ws.getColumn(10).eachCell((cell, n) => { if (n > 1) cell.dataValidation = { type: "list", allowBlank: true, formulae: ['"Open,Fixed,Won\'t fix,Not a problem"'] }; });
  const counts = (["Critical", "High", "Medium", "Low"] as const).map((s) => `${s} ${rows.filter((r) => r.severity === s).length}`).join(" · ");
  const about = wb.addWorksheet("About");
  about.columns = [{ header: "", key: "k", width: 22 }, { header: "", key: "v", width: 80 }];
  about.addRows([
    ["Survey", `${safe(meta.surveyTitle)} (${safe(meta.surveyCode)})`],
    ["Version", safe(meta.version)],
    ["Generated", meta.generatedAt ?? new Date().toISOString()],
    ["Findings", `${rows.length} — ${counts}`],
    ["", ""],
    ["What this is", "Every problem the survey's own checks found: logic references, flow structure, circular dependencies, unreachable questions, calculations, the AI interviewer and translations — the checks behind the Studio's Logic › Check, plus questions no path reaches."],
    ["Severity", "Critical: a respondent can get a wrong path or a broken page. High: wrong behaviour likely. Medium: check before launch. Low: cosmetic or optional."],
  ]);
  about.getColumn(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
