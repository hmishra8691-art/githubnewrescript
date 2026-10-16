import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { parseLogicExpression, formatCondition, evaluateCondition, createResponseState, setAnswer, conditionSummary } from "/home/claude/rescript/packages/engine/dist/index.js";
const def = SurveyDefinition.parse({
  meta: { id: "g", code: "G", title: "Grid", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "SAT", type: "matrix_single", text: "Rate",
      options: [{code:"1",label:"Poor"},{code:"2",label:"OK"},{code:"3",label:"Great"}],
      rows: [{code:"1",label:"Service",flags:[],validation:[],required:false},{code:"2",label:"Price",flags:[],validation:[],required:false}] },
    { id: "q2", code: "Q2", variableName: "USE", type: "matrix_multi", text: "Which",
      options: [{code:"a",label:"Alpha"},{code:"b",label:"Beta"}],
      rows: [{code:"1",label:"Web",flags:[],validation:[],required:false},{code:"2",label:"App",flags:[],validation:[],required:false}] },
    { id: "q5", code: "Q5", variableName: "TAB", type: "composite", text: "Per brand",
      rows: [{code:"a",label:"Brand A",flags:[],validation:[],required:false},{code:"b",label:"Brand B",flags:[],validation:[],required:false}],
      columns: [{ id:"spend", label:"Spend", responseType:"numeric", variableStem:"SPEND", options:[], validation:[], readOnly:false },
                { id:"note", label:"Note", responseType:"text", variableStem:"NOTE", options:[], validation:[], readOnly:false }] },
    { id: "q7", code: "Q7", variableName: "SAT7", type: "matrix_single", text: "Rate w/ columns array",
      options: [{code:"1",label:"Poor"},{code:"2",label:"OK"},{code:"3",label:"Great"}],
      columns: [{ id:"c1", label:"Answer", responseType:"single", variableStem:"X", options:[{code:"1",label:"Poor"},{code:"2",label:"OK"},{code:"3",label:"Great"}], validation:[], readOnly:false }],
      rows: [{code:"1",label:"Service",flags:[],validation:[],required:false},{code:"2",label:"Price",flags:[],validation:[],required:false}] },
  ],
  flow: [{ type:"page", id:"p1", questionIds:["q1","q2","q5","q7"] }, { type:"end", id:"e", status:"complete" }],
});
const state = createResponseState(def);
setAnswer(def, state, "q1", { "1": "3", "2": "1" }, null);
setAnswer(def, state, "q2", { "1": ["a","b"], "2": ["b"] }, null);
setAnswer(def, state, "q5", { a: { spend: 120, note: "ok" }, b: { spend: 20 } }, null);
setAnswer(def, state, "q7", { "1": "3", "2": "1" }, null);
const ctx = { def, state, loop: null };
const run = (expr) => {
  const r = parseLogicExpression(def, expr);
  if (!r.condition) { console.log(`${expr.padEnd(36)} PARSE ERROR: ${r.errors.map(e=>e.message).join("; ")}`); return; }
  const ok = evaluateCondition(r.condition, ctx);
  const printed = formatCondition(def, r.condition);
  const rt = parseLogicExpression(def, printed);
  console.log(`${expr.padEnd(36)} => ${String(ok).padEnd(5)} printed=${printed.padEnd(28)} reparse=${rt.condition ? (JSON.stringify(rt.condition)===JSON.stringify(r.condition)?"same":"DIFF "+JSON.stringify(rt.condition)) : "ERR "+rt.errors.map(e=>e.message).join(";")}`);
};
for (const e of ["Q2.R1.a","Q2.R1.b","Q2.R2.a","Q2.a","Q2.b","Q2.R1.Alpha","Q2.R1.O1","Q2.R1.A1","Q1.Service.Great","Q1.Service = 3","Q1.Service.O3","Q1.R1.O3","Q1.R1.A3","Q1.R1.Great",
  "Q7.R1.C1","Q7.R1.c1","Q7.R1 = 3","Q7.R1.C1 = 3","Q7.c1 = 3","Q7.R1.O3",
  "COUNT(Q2) >= 2","COUNT(Q2, rows) >= 1","COUNT(Q2, selected, rows) >= 1", "COUNT(Q1, rows, where (@option.value = 3)) >= 1"]) run(e);

// Visual-builder-shaped rules (not from text): column-only composite + print/reparse
console.log("\n--- builder-shaped rules ---");
for (const rule of [
  { type:"rule", source:{kind:"question", ref:"q5", columnId:"spend"}, operator:"gt", value:100 },
  { type:"rule", source:{kind:"question", ref:"q5", columnId:"note"}, operator:"contains", value:"ok" },
  { type:"rule", source:{kind:"question", ref:"q2", columnId:"a"}, operator:"selected" },
  { type:"rule", source:{kind:"question", ref:"q2", rowCode:"1", columnId:"a"}, operator:"selected" },
  { type:"rule", source:{kind:"question", ref:"q1", rowCode:"1", columnId:"3"}, operator:"selected", value:"3" },
  { type:"rule", source:{kind:"question", ref:"q1", rowCode:"1", columnId:"2"}, operator:"selected", value:"3" },
  { type:"rule", source:{kind:"question", ref:"q1", rowCode:"1", columnId:"2"}, operator:"eq", value:"3" },
  { type:"rule", source:{kind:"question", ref:"q7", rowCode:"1", columnId:"c1"}, operator:"eq", value:"3" },
  { type:"rule", source:{kind:"question", ref:"q7", rowCode:"1", columnId:"c1"}, operator:"selected" },
]) {
  const ok = evaluateCondition(rule, ctx);
  const printed = formatCondition(def, rule);
  const rt = parseLogicExpression(def, printed);
  console.log(`${JSON.stringify(rule.source).padEnd(70)} ${rule.operator} ${JSON.stringify(rule.value)??""} => ${ok} printed=${printed.padEnd(26)} reparse=${rt.condition ? JSON.stringify(rt.condition.source)+" "+rt.condition.operator+" "+JSON.stringify(rt.condition.value) : "ERR "+rt.errors.map(e=>e.message).join(";")} summary=${conditionSummary(def, rule)}`);
}
