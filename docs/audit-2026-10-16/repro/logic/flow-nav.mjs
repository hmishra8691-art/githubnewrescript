import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import * as E from "/home/claude/rescript/packages/engine/dist/index.js";
const def = SurveyDefinition.parse({
  meta: { id: "f", code: "F", title: "Flow", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Own a car?", options: [{ code: "1", label: "Yes" }, { code: "2", label: "No" }],
      skipLogic: [{ id: "sk1", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "2" }, target: { kind: "question", ref: "q4" } },
                  { id: "sk0", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "9" }, target: { kind: "question", ref: "q0" } }] },
    { id: "q0", code: "Q0", variableName: "Q0", type: "text", text: "intro (before Q1)" },
    { id: "q2", code: "Q2", variableName: "Q2", type: "text", text: "Which car? (shown when Q1=1)", displayLogic: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "1" } },
    { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "Age", skipLogic: [{ id: "sk2", when: { type: "rule", source: { kind: "question", ref: "q3" }, operator: "lt", value: 18 }, target: { kind: "terminate", status: "screened" } }] },
    { id: "q4", code: "Q4", variableName: "Q4", type: "text", text: "You said {{Q1.label}}; age {{Q3}}" },
  ],
  flow: [
    { type: "page", id: "p0", questionIds: ["q0"] },
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "page", id: "p3", questionIds: ["q3"] },
    { type: "page", id: "p4", questionIds: ["q4"] },
    { type: "end", id: "e", status: "complete", redirectUrl: "https://panel.example/done?age={{Q3}}&rid={{ed.RID}}" },
  ],
});
const page = (r) => r.steps[r.stepIndex]?.kind === "page" ? r.steps[r.stepIndex].pageId : r.steps[r.stepIndex]?.kind;
const st = E.createResponseState(def, { embedded: { RID: "abc 1" } });
let r = E.start(def, st); console.log("start ->", page(r));
r = E.advance(def, st); console.log("advance p0 ->", page(r));
E.setAnswer(def, st, "q1", "1", null); r = E.advance(def, st); console.log("Q1=Yes advance ->", page(r), "(expect p2)");
E.setAnswer(def, st, "q2", "Volvo", null); r = E.advance(def, st); console.log("advance ->", page(r), "(expect p3)");
r = E.goBack(def, st); console.log("back ->", page(r), "answers kept:", JSON.stringify(st.answers));
r = E.goBack(def, st); console.log("back ->", page(r));
E.setAnswer(def, st, "q1", "2", null); r = E.advance(def, st); console.log("Q1=No advance (skip to Q4) ->", page(r), "(expect p4; p2 hidden & p3 skipped)");
console.log("  stale Q2 answer still stored:", JSON.stringify(st.answers.q2), "(skipped page's answer not cleared)");
r = E.goBack(def, st); console.log("back from p4 ->", page(r), "(expect p1: p3 was skipped by skip logic but is still visible going back!)");
E.setAnswer(def, st, "q1", "1", null); r = E.advance(def, st); console.log("Q1=Yes again ->", page(r));
r = E.advance(def, st); console.log("advance ->", page(r));
E.setAnswer(def, st, "q3", 16, null); r = E.advance(def, st); console.log("age 16 ->", r.done, r.endStatus, "status=", st.status, "(expect screened)");
// terminate/redirect with tokens
const st2 = E.createResponseState(def, { embedded: { RID: "abc 1" } });
E.start(def, st2); E.advance(def, st2); E.setAnswer(def, st2, "q1", "2", null); E.advance(def, st2);
E.setAnswer(def, st2, "q3", 40, null);
let r2 = E.advance(def, st2); console.log("complete ->", r2.done, r2.endStatus, "redirect:", r2.redirectUrl);
// skip target that lies BEFORE the current page (q0)
const st3 = E.createResponseState(def); E.start(def, st3); E.advance(def, st3); E.setAnswer(def, st3, "q1", "9", null);
let r3 = E.advance(def, st3); console.log("skip to a question BEFORE current page ->", page(r3), "triggered:", JSON.stringify(r3.triggeredSkips), "(silently falls through to next page)");
// validation on page: required + bounds order
const st4 = E.createResponseState(def);
const q3 = def.questions.find((q) => q.id === "q3"); q3.required = true; q3.settings.minValue = 0; q3.validation = [{ id: "v1", kind: "max_value", value: 120, message: "too old" }, { id: "v2", kind: "min_value", value: 1, message: "too young" }];
console.log("validate empty:", E.validateQuestion(def, q3, undefined, { def, state: st4, loop: null }).map((e) => e.message));
console.log("validate 500:", E.validateQuestion(def, q3, 500, { def, state: st4, loop: null }).map((e) => e.message));
console.log("validate -3:", E.validateQuestion(def, q3, -3, { def, state: st4, loop: null }).map((e) => e.message));
