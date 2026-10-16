import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { applySurveyActions, coerceSurveyActions } from "/home/claude/rescript/packages/engine/dist/index.js";
let n = 0; const ids = (p) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Audit" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
for (const acts of [
  [{ op: "create_question", ref: "AGE", type: "integer", text: "Age?" }],
  [{ op: "create_question", ref: "AGE", type: "integer", text: "Age?", validation: [{ kind: "min_value", value: 18 }] }],
  [{ op: "create_question", ref: "AGE", type: "integer", text: "Age?", validation: [{ kind: "min_value", value: 18, when: "AGE answered" }] }],
  [{ op: "create_question", ref: "Q", type: "quantity", text: "How many?" , validation: [{ kind: "max_value", value: 5 }] }],
  [{ op: "create_question", ref: "E", type: "email", text: "Email?" }],
  [{ op: "create_question", ref: "E", type: "email", text: "Email?", validation: [{ kind: "max_length", value: 80 }] }],
  [{ op: "create_question", ref: "P", type: "phone", text: "Phone?" }],
  [{ op: "create_question", ref: "Z", type: "zip", text: "Zip?" }],
  [{ op: "create_question", ref: "U", type: "url", text: "Site?" }],
  [{ op: "create_question", ref: "T", type: "text", text: "What is your email address?" }],
  [{ op: "create_question", ref: "A", type: "numeric", text: "What is your age?" }],
]) {
  const c = coerceSurveyActions(acts);
  const r = applySurveyActions(empty(), c.actions, { ids });
  const q = r.def?.questions[0];
  console.log(JSON.stringify(acts[0].type).padEnd(11), "valid=" + r.valid, r.errors.join(";"), "->", q?.type, q?.variant, "validation=", JSON.stringify(q?.validation.map(v => v.kind + (v.value !== undefined ? ":" + v.value : ""))), "settings=", JSON.stringify(Object.fromEntries(Object.entries(q?.settings ?? {}).filter(([k]) => !["readOnly","hidden"].includes(k)))));
}
