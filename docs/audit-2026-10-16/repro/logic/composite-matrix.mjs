import { SurveyDefinition, QUESTION_VARIANTS } from "/home/claude/rescript/packages/schema/dist/index.js";
import * as E from "/home/claude/rescript/packages/engine/dist/index.js";
const mkq = (vid, id, code) => { const v = QUESTION_VARIANTS.find((x) => x.id === vid); const q = E.createQuestionFromVariant(v, { code, variableName: code }); q.id = id; return q; };
const qt = mkq("matrix.text", "qt", "QT"), qn = mkq("matrix.numeric", "qn", "QN"), qd = mkq("matrix.dropdown", "qd", "QD");
const def = SurveyDefinition.parse({ meta: { id: "c", code: "C", title: "t", version: "1" }, questions: [qt, qn, qd], flow: [{ type: "page", id: "p", questionIds: ["qt", "qn", "qd"] }, { type: "end", id: "e", status: "complete" }] });
console.log("Studio 'Text Matrix' is type:", qt.type, "columns:", qt.columns.map((c) => c.id), "| 'Numeric Matrix':", qn.type, "| 'Dropdown Matrix':", qd.type, qd.columns[0].options.map((o) => o.code));
const st = E.createResponseState(def);
// composite cell renderer writes { [row]: { [colId]: value } }
E.setAnswer(def, st, "qt", { "1": { c1: "hello world" } }, null);
E.setAnswer(def, st, "qn", { "1": { c1: 30 }, "2": { c1: 4 } }, null);
E.setAnswer(def, st, "qd", { "1": { c1: 2 } }, null);
const ctx = { def, state: st, loop: null };
for (const t of ["QT.R1 contains hello", "QT.R1.c1 contains hello", "QT.R1 answered", "QT.R2 answered", "QN.R1 > 23", "QN.R1.c1 > 23", "QN > 23", "QN.R2 > 23", "QD.R1 = 2", "QD.R1.c1 = 2", "QD.R1.c1.2", "QD.R1.C2", "QD.R1.c1 selected", "QD.c1 = 2"]) {
  const r = E.parseLogicExpression(def, t);
  console.log(t.padEnd(26), "->", r.condition ? `${E.evaluateCondition(r.condition, ctx)}  printed=${E.formatCondition(def, r.condition)}  src=${JSON.stringify(r.condition.source)} v=${JSON.stringify(r.condition.value)}` : "PARSE ERROR " + r.errors.map((e) => e.message).join(";"));
}
