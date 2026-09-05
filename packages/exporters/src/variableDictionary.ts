import ExcelJS from "exceljs";
import type { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary, loopNodes, loopVariablePrefix, maxLoopIterations, possibleLoopItems, directQuestionIdsInLoop } from "@rescript/engine";

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
    // §36/§37: a loop's variables say which loop and iteration they belong to
    { header: "Loop", key: "loopVar", width: 12 },
    { header: "Iteration", key: "iteration", width: 9 },
    { header: "Reference", key: "referenceColumn", width: 16 },
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
      loopVar: v.loopVar ?? "",
      iteration: v.iteration ?? "",
      referenceColumn: v.referenceColumn ?? "",
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

  /*
   * ---- Sheet 4: Loops (§37) ----------------------------------------------
   *
   * One row per (loop, iteration position, item, reference column, question
   * variable), which is the relationship the requirement asks to make clear:
   * Loop → Item → Reference → Question. Positions and items come from the
   * definition, so the sheet is complete before any respondent exists; the
   * item at position n for a RANDOMISED loop is "whichever ran n-th", and the
   * LOOP_*_ITEM_n_CODE column in the data says which — so the sheet lists every
   * possible item for each position rather than pretending to know.
   *
   * Only written when the survey has a loop, so a survey without one exports
   * the same three sheets it always did.
   */
  const loops = loopNodes(def).filter((l) => l.ancestors.length === 0);
  if (loops.length) {
    const sheet = wb.addWorksheet("Loops");
    sheet.columns = [
      { header: "Loop ID", key: "loopId", width: 14 },
      { header: "Loop", key: "loopVar", width: 12 },
      { header: "Source", key: "source", width: 22 },
      { header: "Iteration", key: "iteration", width: 9 },
      { header: "Item", key: "item", width: 18 },
      { header: "Item Code", key: "code", width: 10 },
      { header: "Reference Column", key: "refColumn", width: 18 },
      { header: "Reference Value", key: "refValue", width: 18 },
      { header: "Reference Type", key: "refType", width: 10 },
      { header: "Question Variable", key: "questionVar", width: 22 },
      { header: "Data Type", key: "dataType", width: 10 },
      { header: "Loop Variable", key: "loopVariable", width: 30 },
    ];
    for (const { node } of loops) {
      const items = possibleLoopItems(def, node) ?? [];
      const max = maxLoopIterations(def, node) ?? 0;
      const prefix = loopVariablePrefix(node);
      const source = node.source.kind === "question"
        ? `${def.questions.find((q) => q.id === (node.source as { questionId: string }).questionId)?.code ?? "?"} (${(node.source as { filter?: string }).filter ?? "selected"})`
        : node.source.kind;
      const questionVars = directQuestionIdsInLoop(node)
        .map((id) => def.questions.find((q) => q.id === id))
        .filter((q): q is NonNullable<typeof q> => !!q);
      const positional = node.order?.kind === "random" || node.order?.kind === "weightedRandom" || node.randomizeIterations
        || node.order?.kind === "selection" || node.order?.kind === "priority";

      sheet.addRow({ loopId: node.id, loopVar: node.loopVar, source, iteration: "", item: "", code: "", refColumn: "", refValue: "", refType: "", questionVar: "", dataType: "numeric", loopVariable: `${prefix}_COUNT` });
      for (let n = 1; n <= max; n++) {
        // which items can sit at position n: the n-th in source order when the
        // order is fixed, otherwise any item — the data's _CODE column decides
        const candidates = positional ? items : items.slice(n - 1, n);
        for (const it of candidates.length ? candidates : [{ code: "", label: "(any)" }]) {
          const row = node.references?.values?.[it.code] ?? {};
          const columns = node.references?.columns ?? [];
          const refRows = columns.length ? columns : [null];
          for (const col of refRows) {
            const qs = questionVars.length ? questionVars : [null];
            for (const q of qs) {
              sheet.addRow({
                loopId: node.id,
                loopVar: node.loopVar,
                source,
                iteration: n,
                item: it.label,
                code: it.code,
                refColumn: col?.name ?? "",
                refValue: col ? (row[col.name] ?? "") : "",
                refType: col?.dataType ?? "",
                questionVar: q ? `${q.variableName}_${n}` : "",
                dataType: q ? (q.type === "numeric" || q.type === "slider" ? "numeric" : "text") : "",
                loopVariable: col ? `${prefix}_ITEM_${n}_${col.name.toUpperCase()}` : `${prefix}_ITEM_${n}_CODE`,
              });
            }
          }
        }
      }
    }
    styleHeaderRow(sheet);
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
  }

  const data = await wb.xlsx.writeBuffer();
  return Buffer.from(data as ArrayBuffer);
}
