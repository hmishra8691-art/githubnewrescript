import { SurveyDefinition, QUESTION_VARIANTS } from "/home/claude/rescript/packages/schema/dist/index.js";
import * as E from "/home/claude/rescript/packages/engine/dist/index.js";
const { gridAxes, authoringValueChoicesFor, isCategoricalGrid, gridCellOperators, operatorsForQuestion, createQuestionFromVariant, isCellOperator, VALUELESS_OPERATORS } = E;
console.log("exports available:", ["gridAxes","authoringValueChoicesFor","isCategoricalGrid","gridCellOperators","operatorsForQuestion","createQuestionFromVariant","isCellOperator"].map(k=>k+"="+(typeof E[k])).join(" "));
const variants = Object.values(QUESTION_VARIANTS ?? {}).flat ? Object.values(QUESTION_VARIANTS) : [];
const list = (globalThis.__v = (Array.isArray(QUESTION_VARIANTS) ? QUESTION_VARIANTS : Object.values(QUESTION_VARIANTS)));
const wanted = ["matrix.single","matrix.multi","matrix.likert","matrix.rating","matrix.numeric","matrix.text","matrix.dropdown","matrix.mixed","matrix.random_rows","list.editable_table","matrix.sum","matrix.stars","matrix.drag"];
const base = { meta: { id: "s", code: "S", title: "t", version: "1" }, questions: [], flow: [] };
for (const id of wanted) {
  const v = list.find((x) => x.id === id);
  if (!v) { console.log(id, "— variant not found"); continue; }
  let q;
  try { q = createQuestionFromVariant(v, { id: "q_" + id.replace(".", "_"), code: "Q", variableName: "V" }); } catch (e) { console.log(id, "createQuestionFromVariant failed:", e.message); continue; }
  if (!q.rows?.length) q.rows = [{ code: "1", label: "Row 1", flags: [], validation: [], required: false }, { code: "2", label: "Row 2", flags: [], validation: [], required: false }];
  if (!q.options?.length && !q.columns?.length) q.options = [{ code: "1", label: "A" }, { code: "2", label: "B" }];
  const def = SurveyDefinition.parse({ ...base, questions: [q], flow: [{ type: "page", id: "p", questionIds: [q.id] }, { type: "end", id: "e", status: "complete" }] });
  const qq = def.questions[0];
  const axes = gridAxes(qq);
  const grid = isCategoricalGrid(qq);
  const ops = grid ? gridCellOperators(qq) : operatorsForQuestion(qq);
  console.log(`\n== ${id} (type=${qq.type} renderer=${qq.renderer ?? "-"} model=${axes.model} categorical=${grid}) options=${qq.options.length} columns=${qq.columns.length}`);
  console.log("  rows:", axes.rows.map(r => `${r.ref}:${r.label}`).join(" | "));
  console.log("  columns (picker):", axes.columns.map(c => grid ? c.label : `col: ${c.label}`).join(" | "), ` meaning=${axes.columnMeaning}`);
  for (const op of ops.slice(0, 4)) {
    const cellForm = grid && isCellOperator(op);
    const showCol = axes.columns.length > 0 && (!grid || cellForm);
    const needsValue = !(VALUELESS_OPERATORS ?? ["answered","unanswered","isEmpty","isNotEmpty","displayed","notDisplayed"]).includes(op) && !cellForm;
    const vc = authoringValueChoicesFor(qq, def, { rowCode: axes.rows[0]?.ref, columnId: axes.columns[0]?.ref });
    const vcNoCol = authoringValueChoicesFor(qq, def, { rowCode: axes.rows[0]?.ref });
    console.log(`  op=${op.padEnd(12)} column-picker=${showCol ? "shown" : "hidden"} value-control=${needsValue ? (vc.length ? "select" : "text") : "none"} values(col1)=[${vc.map(o => `${o.ref}: ${o.label}`).join(" | ")}] values(nocol)=[${vcNoCol.map(o=>`${o.ref}: ${o.label}`).join(" | ")}]`);
  }
}
