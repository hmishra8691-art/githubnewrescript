import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import * as E from "/home/claude/rescript/packages/engine/dist/index.js";
const def = SurveyDefinition.parse({
  meta: { id: "f", code: "F", title: "Flow", version: "1" },
  questions: [
    { id: "q0", code: "Q0", variableName: "Q0", type: "text", text: "intro" },
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "x", options: [{ code: "1", label: "Yes" }],
      skipLogic: [{ id: "sk0", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "1" }, target: { kind: "question", ref: "q0" } },
                  { id: "sk1", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "1" }, target: { kind: "question", ref: "qZZ" } }] },
  ],
  flow: [{ type: "page", id: "p0", questionIds: ["q0"] }, { type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
});
console.log(E.lintSurveyLogic(def).map((i) => `${i.level}: ${i.message}`));
console.log("referencesTo q0:", E.referencesTo(def, "q0").map((r) => `${r.kind}@${r.path}`));
console.log("unresolvable (diagnose?):", typeof E.unresolvableSkipTargets, typeof E.diagnoseSurvey, typeof E.surveyReview);
const d = E.diagnoseSurvey ? E.diagnoseSurvey(def) : null; if (d) console.log(JSON.stringify(d).slice(0, 600));
