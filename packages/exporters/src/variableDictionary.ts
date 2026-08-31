import ExcelJS from "exceljs";
import type { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary } from "@rescript/engine";

const stripHtml = (html: string): string =>
  html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F2937" },
};

function styleHeaderRow(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle" };
  });
  header.height = 18;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/**
 * Export the survey's variable dictionary as a styled XLSX workbook with
 * three sheets: Variables, Survey (metadata) and Questions.
 * Deterministic apart from the exported-at timestamp on the Survey sheet.
 */
export async function exportVariableDictionaryXlsx(
  def: SurveyDefinition,
): Promise<Buffer> {
  const dict = buildVariableDictionary(def);
  const wb = new ExcelJS.Workbook();
  wb.creator = "rescript";
  wb.created = new Date(0); // keep workbook metadata deterministic

  // ---- Sheet 1: Variables -------------------------------------------------
  const vars = wb.addWorksheet("Variables");
  vars.columns = [
    { header: "Variable", key: "name", width: 24 },
    { header: "Label", key: "label", width: 42 },
    { header: "Question", key: "questionCode", width: 12 },
    { header: "Question Text", key: "questionText", width: 50 },
    { header: "Type", key: "dataType", width: 10 },
    { header: "Response Type", key: "responseType", width: 16 },
    { header: "Codes", key: "codes", width: 16 },
    { header: "Value Labels", key: "valueLabels", width: 40 },
    { header: "Page", key: "pageId", width: 14 },
    { header: "Section", key: "sectionId", width: 16 },
    { header: "Derived", key: "derived", width: 9 },
    { header: "Hidden", key: "hidden", width: 9 },
    { header: "Row", key: "rowCode", width: 8 },
    { header: "Column", key: "columnId", width: 10 },
    { header: "Option", key: "optionCode", width: 8 },
    { header: "Notes", key: "notes", width: 32 },
  ];
  for (const v of dict) {
    vars.addRow({
      name: v.name,
      label: v.label,
      questionCode: v.questionCode ?? "",
      questionText: v.questionText ?? "",
      dataType: v.dataType,
      responseType: v.responseType,
      codes: v.valueCodes.join(","),
      valueLabels: Object.entries(v.valueLabels)
        .map(([code, label]) => `${code}=${label}`)
        .join("; "),
      pageId: v.pageId ?? "",
      sectionId: v.sectionId ?? "",
      derived: v.derived ? "Y" : "",
      hidden: v.hidden ? "Y" : "",
      rowCode: v.rowCode ?? "",
      columnId: v.columnId ?? "",
      optionCode: v.optionCode ?? "",
      notes: v.notes ?? "",
    });
  }
  styleHeaderRow(vars);
  vars.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: vars.columns.length },
  };

  // ---- Sheet 2: Survey ----------------------------------------------------
  const survey = wb.addWorksheet("Survey");
  survey.columns = [
    { header: "Field", key: "field", width: 22 },
    { header: "Value", key: "value", width: 60 },
  ];
  const metaRows: Array<[string, string | number]> = [
    ["Survey ID", def.meta.id],
    ["Code", def.meta.code],
    ["Title", def.meta.title],
    ["Version", def.meta.version],
    ["Status", def.meta.status],
    ["Exported at", new Date().toISOString()],
    ["Question count", def.questions.length],
    ["Variable count", dict.length],
  ];
  for (const [field, value] of metaRows) survey.addRow({ field, value });
  styleHeaderRow(survey);

  // ---- Sheet 3: Questions -------------------------------------------------
  const questions = wb.addWorksheet("Questions");
  questions.columns = [
    { header: "Code", key: "code", width: 12 },
    { header: "Variable", key: "variableName", width: 22 },
    { header: "Type", key: "type", width: 16 },
    { header: "Required", key: "required", width: 10 },
    { header: "Text", key: "text", width: 60 },
    { header: "Options count", key: "options", width: 14 },
    { header: "Rows count", key: "rows", width: 12 },
    { header: "Columns count", key: "columns", width: 14 },
  ];
  for (const q of def.questions) {
    questions.addRow({
      code: q.code,
      variableName: q.variableName,
      type: q.type,
      required: q.required ? "Y" : "",
      text: stripHtml(q.text),
      options: q.options.length,
      rows: q.rows.length,
      columns: q.columns.length,
    });
  }
  styleHeaderRow(questions);

  const data = await wb.xlsx.writeBuffer();
  return Buffer.from(data as ArrayBuffer);
}
