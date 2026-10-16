import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import * as E from "/home/claude/rescript/packages/engine/dist/index.js";
const def = SurveyDefinition.parse({
  meta: { id: "r", code: "R", title: "Ref", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "COLOR", type: "single_select", text: "Colour?", options: [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }] },
    { id: "q6", code: "Q6", variableName: "OTHER", type: "single_select", text: "Other colour?", options: [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }] },
    { id: "q2", code: "Q2", variableName: "WHY", type: "text", text: "Why" },
    { id: "q7", code: "Q7", variableName: "N", type: "numeric", text: "n" },
  ],
  calculations: [{ id: "c1", targetVariable: "ISBLUE", expression: "Q1 == 2", trigger: "on_change" }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q6", "q7"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e", status: "complete" }],
});
def.questions[2].displayLogic = E.parseLogicExpression(def, "Q1 = Q6").condition;
console.log("rule:", JSON.stringify(def.questions[2].displayLogic));
console.log("lint (no rename):", E.lintSurveyLogic(def).map((i) => `${i.level}: ${i.message}`).join(" || "));
// calc after question code rename
const st = E.createResponseState(def); E.setAnswer(def, st, "q1", "2", null); E.runCalculations(def, st, "on_page_submit");
console.log("calc before rename:", st.calculated, st.calcErrors);
def.questions[0].code = "Q1B";
const st2 = E.createResponseState(def); E.setAnswer(def, st2, "q1", "2", null); E.runCalculations(def, st2, "on_page_submit");
console.log("calc after code rename:", st2.calculated, st2.calcErrors);
// variable rename safe path
const def2 = SurveyDefinition.parse(JSON.parse(JSON.stringify(def)));
def2.questions[0].code = "Q1";
const imp = E.renameImpact(def2, "COLOR", "COLOUR");
console.log("renameImpact COLOR->COLOUR:", JSON.stringify(imp).slice(0, 400));
