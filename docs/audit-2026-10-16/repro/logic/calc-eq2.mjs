import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import * as E from "/home/claude/rescript/packages/engine/dist/index.js";
const def = SurveyDefinition.parse({ meta: { id: "r", code: "R", title: "t", version: "1" },
  questions: [{ id: "q1", code: "Q1", variableName: "COLOR", type: "single_select", text: "c", options: [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }] },
              { id: "q7", code: "Q7", variableName: "N", type: "numeric", text: "n" }],
  calculations: [{ id: "c1", targetVariable: "OUT", expression: "Q7 > 3", trigger: "on_page_submit" }, { id: "c2", targetVariable: "OUT2", expression: "N > 3", trigger: "on_page_submit" }, { id: "c3", targetVariable: "OUT3", expression: "Q7 + 1", trigger: "on_page_submit" }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1","q7"] }, { type: "end", id: "e", status: "complete" }] });
const st = E.createResponseState(def); E.setAnswer(def, st, "q7", 5, null); E.setAnswer(def, st, "q1", "2", null);
console.log("flat keys:", Object.keys(E.flattenVariables(def, st)));
console.log("safeExpression Q7 + 1:", E.safeExpression("Q7 + 1", def, st, null), " N + 1:", E.safeExpression("N + 1", def, st, null), " Q7 > 3:", E.safeExpression("Q7 > 3", def, st, null), " Q1 == 2:", E.safeExpression("Q1 == 2", def, st, null));
E.runCalculations(def, st, "on_page_submit");
console.log("calculated:", st.calculated, "errors:", st.calcErrors);
const r = E.parseLogicExpression(def, "(Q7 + 1) > 3"); console.log("stored expr source:", JSON.stringify(r.condition.source));
