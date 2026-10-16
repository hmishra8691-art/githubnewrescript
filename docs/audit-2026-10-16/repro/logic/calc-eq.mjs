import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import * as E from "/home/claude/rescript/packages/engine/dist/index.js";
const mk = (expr) => SurveyDefinition.parse({ meta: { id: "r", code: "R", title: "t", version: "1" },
  questions: [{ id: "q1", code: "Q1", variableName: "COLOR", type: "single_select", text: "c", options: [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }] },
              { id: "q7", code: "Q7", variableName: "N", type: "numeric", text: "n" }],
  calculations: [{ id: "c1", targetVariable: "OUT", expression: expr, trigger: "on_page_submit" }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1","q7"] }, { type: "end", id: "e", status: "complete" }] });
for (const [expr, ans] of [["Q1 == 2", "2"], ["Q1 == \"2\"", "2"], ["Q1 = 2", "2"], ["COLOR == 2", "2"], ["Q1 == 2", 2], ["if(Q1 == 2, 1, 0)", "2"], ["Q7 == 5", 5], ["Q7 > 3", 5], ["Q1 == 'Blue'", "2"]]) {
  const def = mk(expr); const st = E.createResponseState(def); E.setAnswer(def, st, "q1", ans, null); E.setAnswer(def, st, "q7", ans, null);
  E.runCalculations(def, st, "on_page_submit");
  console.log(`${expr.padEnd(22)} answer=${JSON.stringify(ans)} -> OUT=${JSON.stringify(st.calculated.OUT)} err=${st.calcErrors?.OUT ?? ""}`);
}
console.log("validateExpression:", E.validateExpression ? JSON.stringify(E.validateExpression(mk("Q1 == 2"), "Q1 == 2")) : "n/a");
console.log("lintCalculations(Q1 == 2 where variable is COLOR):", E.lintCalculations(mk("Q1 == 2")));
console.log("lintCalculations(Q7 > 3):", E.lintCalculations(mk("Q7 > 3")));
// expr condition source
const d = mk("Q7 > 3"); const st = E.createResponseState(d); E.setAnswer(d, st, "q7", 5, null);
for (const t of ["expr(Q7 > 3)", "expr(N > 3)", "(Q7 + 1) > 3", "(N + 1) > 3", "Q7 > 3"]) { const r = E.parseLogicExpression(d, t); console.log(t, "->", r.condition ? E.evaluateCondition(r.condition, { def: d, state: st, loop: null }) : "ERR " + r.errors.map(e=>e.message)); }
