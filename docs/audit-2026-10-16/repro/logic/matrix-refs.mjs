import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import {
  parseLogicExpression, formatCondition, evaluateCondition, createResponseState, setAnswer, start, compileFlow, advance,
} from "/home/claude/rescript/packages/engine/dist/index.js";

const def = SurveyDefinition.parse({
  meta: { id: "g", code: "G", title: "Grid", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "SAT", type: "matrix_single", text: "Rate",
      options: [{code:"1",label:"Poor"},{code:"2",label:"OK"},{code:"3",label:"Great"}],
      rows: [{code:"1",label:"Service",flags:[],validation:[],required:false},{code:"2",label:"Price",flags:[],validation:[],required:false}] },
    { id: "q2", code: "Q2", variableName: "USE", type: "matrix_multi", text: "Which",
      options: [{code:"a",label:"Alpha"},{code:"b",label:"Beta"}],
      rows: [{code:"1",label:"Web",flags:[],validation:[],required:false},{code:"2",label:"App",flags:[],validation:[],required:false}] },
    { id: "q3", code: "Q3", variableName: "TXT", type: "matrix_text", text: "Say",
      rows: [{code:"1",label:"Web",flags:[],validation:[],required:false}] },
    { id: "q4", code: "Q4", variableName: "NUM", type: "matrix_numeric", text: "How many",
      rows: [{code:"1",label:"Web",flags:[],validation:[],required:false},{code:"2",label:"App",flags:[],validation:[],required:false}] },
    { id: "q5", code: "Q5", variableName: "TAB", type: "composite", text: "Per brand",
      rows: [{code:"a",label:"Brand A",flags:[],validation:[],required:false}],
      columns: [{ id:"spend", label:"Spend", responseType:"numeric", variableStem:"SPEND", options:[], validation:[], readOnly:false },
                { id:"note", label:"Note", responseType:"text", variableStem:"NOTE", options:[], validation:[], readOnly:false }] },
    { id: "q6", code: "Q6", variableName: "T", type: "text", text: "shown?" },
  ],
  flow: [{ type:"page", id:"p1", questionIds:["q1","q2","q3","q4","q5"] }, { type:"page", id:"p2", questionIds:["q6"] }, { type:"end", id:"e", status:"complete" }],
});

// ---- actual answer shapes, written the way the runtime's Matrix renderer writes them
// (packages/renderer/src/QuestionRenderer.tsx Matrix(): setRow(rc, v) => onChange({...vals,[rc]: v}))
const state = createResponseState(def);
setAnswer(def, state, "q1", { "1": "3", "2": "1" }, null);         // matrix_single: {row: optionCode}
setAnswer(def, state, "q2", { "1": ["a","b"], "2": ["b"] }, null);  // matrix_multi: {row: optionCode[]}
setAnswer(def, state, "q3", { "1": "hello world" }, null);          // matrix_text: {row: string}
setAnswer(def, state, "q4", { "1": 30, "2": 4 }, null);             // matrix_numeric: {row: number}
setAnswer(def, state, "q5", { a: { spend: 120, note: "ok" } }, null); // composite: {row: {colId: value}}
console.log("stored answers:", JSON.stringify(state.answers));

const ctx = { def, state, loop: null };
const cases = [
  "Q1.R1.C3", "Q1.R1.C2", "Q1.R1 = 3", "Q1.R1 >= 2", "Q1.C3", "Q1.C2", "Q1.R2.C1 is selected", "Q1.R1.C1 not selected",
  "Q1.1.3", "Q1.Service.Great", "Q1.R1 answered", "Q1.R9.C1",
  "Q2.R1.Ca", "Q2.R1.Cb", "Q2.R2.Ca", "Q2.R1 contains a", "Q2.R1 contains \"b\"", "Q2.Ca", "COUNT(Q2.R1) >= 2",
  "Q3.R1 contains hello", "Q3.R1 answered",
  "Q4.R1 > 23", "Q4.R2 > 23", "Q4 > 23", "Q4.R1 between 20 and 40",
  "Q5.a.spend > 100", "Q5.a.note = ok", "Q5.Ra.Cspend > 100", "Q5.spend > 100",
  "Q1.R1.C3 AND Q2.R1.Ca", "NOT (Q1.R1.C3)", "(Q1.R1.C1 OR Q1.R1.C3) AND Q4.R1 > 10",
  "Q1.R1 = Q1.R2", "Q4.R1 > Q4.R2",
];
for (const expr of cases) {
  const r = parseLogicExpression(def, expr);
  if (!r.condition) { console.log(`${expr.padEnd(42)} PARSE ERROR: ${r.errors.map(e=>e.message).join("; ")}`); continue; }
  const trace = [];
  const ok = evaluateCondition(r.condition, { ...ctx, trace });
  const printed = formatCondition(def, r.condition);
  const rt = parseLogicExpression(def, printed);
  const stable = rt.condition && JSON.stringify(rt.condition) === JSON.stringify(r.condition);
  console.log(`${expr.padEnd(42)} => ${String(ok).padEnd(5)} printed=${printed.padEnd(32)} roundtrip=${stable ? "ok" : "DIFF"} src=${JSON.stringify(r.condition.type==="rule"?r.condition.source:"group")} val=${JSON.stringify(r.condition.value)}`);
}
