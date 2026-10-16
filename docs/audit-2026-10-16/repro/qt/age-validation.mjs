// QT audit: numeric "age" validation as the copilot would emit it vs with explicit bounds.
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { applySurveyActions, coerceSurveyActions, validateQuestion, createResponseState, blockingErrors } from "/home/claude/rescript/packages/engine/dist/index.js";

let n = 0;
const ids = (p) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Audit" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });

const inputs = [1, 100, 0, -1, 25.5, 101, "", "abc", " 42 ", "1e2"];

function run(label, rawActions, expect) {
  const coerced = coerceSurveyActions(rawActions);
  if (coerced.rejected.length) console.log("REJECTED", coerced.rejected);
  const r = applySurveyActions(empty(), coerced.actions, { ids, now: "2026-10-16T00:00:00Z" });
  if (!r.valid) { console.log(label, "apply errors", r.errors); return; }
  const def = r.def;
  const q = def.questions[0];
  console.log(`\n=== ${label}`);
  console.log("type/variant:", q.type, q.variant, "| validation:", JSON.stringify(q.validation.map(v => ({ kind: v.kind, value: v.value }))), "| settings.min/max/decimalPlaces:", q.settings.minValue, q.settings.maxValue, q.settings.decimalPlaces);
  const state = createResponseState(def, "sess", 1);
  for (const v of inputs) {
    const errs = validateQuestion(def, q, v, { def, state });
    const blocking = blockingErrors(errs).map(e => e.message);
    const exp = expect(v);
    const actual = blocking.length ? "REJECT" : "ACCEPT";
    console.log(`${JSON.stringify(v).padEnd(8)} expected=${exp.padEnd(7)} actual=${actual.padEnd(7)} ${actual === exp ? "" : "<-- MISMATCH"} ${blocking.join(" | ")}`);
  }
}

// What the engine considers a valid AGE answer in [18,100]-ish (or [1,100]) whole-number sense
const isWhole = (v) => { if (v === "" || v == null) return false; const s = String(v).trim(); return /^-?\d+$/.test(s); };

// A) The way the copilot prompt example shows it: type "numeric", validation [{min_value 18}] only — NO integer rule
run("A: AI-style create_question type=numeric, min_value 18, max_value 100 (no integer rule)",
  [{ op: "create_question", ref: "AGE", type: "numeric", text: "What is your age?", required: true, validation: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 100 }] }],
  (v) => (isWhole(v) && Number(v) >= 18 && Number(v) <= 100) ? "ACCEPT" : "REJECT");

// B) Explicit min 1 max 100 as the task asks
run("B: type=numeric, min_value 1, max_value 100 (no integer rule)",
  [{ op: "create_question", ref: "AGE", type: "numeric", text: "What is your age?", required: true, validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 100 }] }],
  (v) => (isWhole(v) && Number(v) >= 1 && Number(v) <= 100) ? "ACCEPT" : "REJECT");

// C) type=integer (the variant preset seeds an integer rule) with min 1 max 100
run("C: type=integer, min_value 1, max_value 100",
  [{ op: "create_question", ref: "AGE", type: "integer", text: "What is your age?", required: true, validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 100 }] }],
  (v) => (isWhole(v) && Number(v) >= 1 && Number(v) <= 100) ? "ACCEPT" : "REJECT");

// D) type=numeric with an explicit integer rule (the surveyActions.test.ts fixture)
run("D: type=numeric, min 1, max 100, integer rule",
  [{ op: "create_question", ref: "AGE", type: "numeric", text: "What is your age?", required: true, validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 100 }, { kind: "integer" }] }],
  (v) => (isWhole(v) && Number(v) >= 1 && Number(v) <= 100) ? "ACCEPT" : "REJECT");
