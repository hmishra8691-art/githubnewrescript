import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { coerceSurveyActions, applySurveyActions, validateQuestion, createResponseState } from "/home/claude/rescript/packages/engine/dist/index.js";
let n = 0; const ids = (p) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const cases = [
  ["email, no validation given", { op: "create_question", ref: "E1", type: "email", text: "Email?" }],
  ["email + required rule", { op: "create_question", ref: "E2", type: "email", text: "Email?", validation: [{ kind: "required" }] }],
  ["integer, no validation given", { op: "create_question", ref: "I1", type: "integer", text: "How many?" }],
  ["integer + min_value 0", { op: "create_question", ref: "I2", type: "integer", text: "How many?", validation: [{ kind: "min_value", value: 0 }] }],
  ["phone + max_length", { op: "create_question", ref: "P1", type: "phone", text: "Phone?", validation: [{ kind: "max_length", value: 20 }] }],
  ["numeric + min_value with when (conditional rule) + message", { op: "create_question", ref: "N1", type: "numeric", text: "Age?", validation: [{ kind: "min_value", value: 18, when: "I1 >= 1", message: "Must be 18+" }] }],
];
const r = applySurveyActions(empty(), coerceSurveyActions(cases.map((c) => c[1])).actions, { ids });
console.log("errors:", r.errors);
for (const [label, a] of cases) {
  const q = r.def.questions.find((x) => x.variableName === a.ref);
  const state = createResponseState(r.def);
  const probe = /email/.test(a.type) ? "nope" : /integer/.test(a.type) ? 2.5 : /phone/.test(a.type) ? "abc" : 10;
  const errs = q ? validateQuestion(r.def, q, probe, { def: r.def, state }) : [];
  console.log(`${label}\n   variant=${q?.variant} validation=${JSON.stringify(q?.validation)}\n   probe ${JSON.stringify(probe)} → ${errs.length ? errs.map((e) => e.message).join(" | ") : "ACCEPTED"}`);
}
