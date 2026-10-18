import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions } from "./surveyActions.js";
import { normalizeCalcExpression, ifThenElse, calcNameHint } from "./calcRewrite.js";
import { runCalculations } from "./flow.js";
import { createResponseState } from "./state.js";

/**
 * PRODUCTION INTENTS (2026-10-18) — the engine half. Each case is an action the model really wrote in
 * production (`intelligent_operations`, 2026-10-06…17) that the engine refused although its meaning is
 * unambiguous, or refused with a reason that did not say what to write instead.
 */
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "CGP" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const survey = () => applySurveyActions(empty(), [
  { op: "create_block", title: "Screening" },
  { op: "create_question", ref: "CONSENT_INFO", type: "descriptive", text: "Welcome" },
  { op: "create_question", ref: "CITIZEN", type: "yes_no", text: "Are you a citizen?" },
  { op: "create_question", ref: "AGE", type: "numeric", text: "Your age?" },
  { op: "create_question", ref: "PERC_BATTERY", type: "matrix", text: "How much do you agree?", rows: ["Legitimate", "Peaceful", "Necessary", "Violent", "Justified"], scale: { points: 5 } },
  { op: "create_question", ref: "ELEC_4", type: "matrix", text: "How likely?", rows: ["BJP loses seats", "CGP wins seats", "Turnout rises"], scale: { points: 5 } },
] as never, { ids }).def;

/* ------------------------------------------------------------ case 7: calculations */

test("a grid row written GRID.R1 is that row's variable; the production expressions now apply", () => {
  const def = survey();
  const r = applySurveyActions(def, [
    { op: "create_calculation", name: "PROTEST_LEGIT_SCORE", expression: "(PERC_BATTERY.R1 + PERC_BATTERY.R2 + PERC_BATTERY.R3 + PERC_BATTERY.R5) / 4" },
    { op: "create_calculation", name: "ELEC_IMPACT_SCORE", expression: "(ELEC_4.R1 + ELEC_4.R2 + ELEC_4.R3) / 3" },
  ] as never, { ids });
  assert.deepEqual(r.results.map((x) => x.ok), [true, true], r.errors.join("; "));
  const calcs = r.def.calculations ?? [];
  assert.equal(calcs[0].expression, "(PERC_BATTERY_r1 + PERC_BATTERY_r2 + PERC_BATTERY_r3 + PERC_BATTERY_r5) / 4");
  assert.match(r.results[0].description, /read as the calculation language writes it: PERC_BATTERY\.R1 → PERC_BATTERY_r1/);
  // and it computes: the row variables are what the runtime reads
  const state = createResponseState(r.def);
  const grid = r.def.questions.find((q) => q.variableName === "PERC_BATTERY")!;
  state.answers[grid.id] = { r1: 4, r2: 2, r3: 3, r5: 5 };
  runCalculations(r.def, state, "on_page_submit");
  assert.equal(state.calculated.PROTEST_LEGIT_SCORE, 3.5);
});

test("the row variable itself (GRID_r1) is accepted — it used to be refused as 'not in the survey'", () => {
  const r = applySurveyActions(survey(), [{ op: "create_calculation", name: "S1", expression: "(PERC_BATTERY_r1 + PERC_BATTERY_r2) / 2" }] as never, { ids });
  assert.ok(r.results[0].ok, r.errors.join("; "));
});

test("IF … THEN … ELSE (with ELSE IF chains) is written as nested if(); the production AGE_GROUP applies and computes", () => {
  assert.equal(ifThenElse("IF AGE <= 27 THEN 1 ELSE IF AGE <= 43 THEN 2 ELSE IF AGE <= 59 THEN 3 ELSE 4"), "if(AGE <= 27, 1, if(AGE <= 43, 2, if(AGE <= 59, 3, 4)))");
  assert.equal(ifThenElse("if AGE > 17 then 1 end"), "if(AGE > 17, 1, null)");
  assert.equal(ifThenElse("IF (AGE > 17 AND CITIZEN = 1) THEN 1 ELSE 0 END IF"), "if((AGE > 17 AND CITIZEN = 1), 1, 0)");
  assert.equal(ifThenElse("if(AGE > 17, 1, 0)"), null, "the function form is left alone");
  assert.equal(ifThenElse("AGE + 1"), null);
  assert.equal(ifThenElse('IF AGE > 17 THEN "adult" ELSE "minor"'), 'if(AGE > 17, "adult", "minor")');
  const r = applySurveyActions(survey(), [{ op: "create_calculation", name: "AGE_GROUP", expression: "IF AGE <= 27 THEN 1 ELSE IF AGE <= 43 THEN 2 ELSE IF AGE <= 59 THEN 3 ELSE 4" }] as never, { ids });
  assert.ok(r.results[0].ok, r.errors.join("; "));
  const state = createResponseState(r.def);
  state.answers[r.def.questions.find((q) => q.variableName === "AGE")!.id] = 50;
  runCalculations(r.def, state, "on_page_submit");
  assert.equal(state.calculated.AGE_GROUP, 3);
});

test("what cannot be rewritten is refused with a hint that says what to write (sent back on the repair call)", () => {
  const r = applySurveyActions(survey(), [{ op: "create_calculation", name: "BAD", expression: "(R1 + R2) / 2" }] as never, { ids });
  assert.equal(r.results[0].ok, false);
  assert.match(r.errors[0], /reads R1, R2, which are not in the survey \(a grid row in a calculation is that row's variable — e\.g\. PERC_BATTERY_r1/);
  assert.match(calcNameHint(survey(), ["THEN"]), /if\(condition, then, else\)/);
  assert.equal(calcNameHint(survey(), ["FOO"]), "");
  // a dotted name that is not a grid row stays as written (and is refused for what it is)
  assert.equal(normalizeCalcExpression(survey(), "AGE.R1 + 1").expression, "AGE.R1 + 1");
  assert.equal(normalizeCalcExpression(survey(), "ed.SOURCE").expression, "ed.SOURCE");
  assert.equal(normalizeCalcExpression(survey(), '"PERC_BATTERY.R1"').expression, '"PERC_BATTERY.R1"', "inside a string literal nothing changes");
});

/* ------------------------------------------------------------ case 4: the survey's custom code */

test("set_custom_code on the survey (“__survey__”, “survey”, “theme”) is a survey-wide script / stylesheet, not 'there is no question'", () => {
  const def = survey();
  const r = applySurveyActions(def, [{ op: "set_custom_code", target: "__survey__", js: "rs.log('hello');", css: "& { letter-spacing: .01em; }" }] as never, { ids });
  assert.ok(r.results[0].ok, r.errors.join("; "));
  const ux = r.def.ux!;
  assert.equal(ux.behaviors.filter((b) => b.target.kind === "survey" && b.source === "copilot_custom_code").length, 1);
  assert.equal(ux.styles.filter((s) => s.target.kind === "survey" && s.label === "Survey custom CSS").length, 1);
  // setting it again replaces (one script, one stylesheet), removing it removes both
  const again = applySurveyActions(r.def, [{ op: "set_custom_code", target: "survey", js: "rs.log('bye');" }] as never, { ids });
  assert.ok(again.results[0].ok);
  assert.equal(again.def.ux!.behaviors.filter((b) => b.target.kind === "survey").length, 1);
  const gone = applySurveyActions(again.def, [{ op: "set_custom_code", target: "survey", js: null, css: null }] as never, { ids });
  assert.ok(gone.results[0].ok, gone.errors.join("; "));
  assert.ok(gone.destructive.length, "a removal is destructive (the researcher confirms)");
  assert.equal(gone.def.ux!.behaviors.filter((b) => b.target.kind === "survey").length, 0);
  assert.equal(gone.def.ux!.styles.filter((s) => s.target.kind === "survey").length, 0);
});

test("removing survey code that is not there is refused precisely (the production 'Remove the custom code of survey')", () => {
  const r = applySurveyActions(survey(), [{ op: "set_custom_code", target: "survey", js: null, css: null }] as never, { ids });
  assert.equal(r.results[0].ok, false);
  assert.match(r.errors[0], /no survey-wide custom code to remove — its theme is the Branding \(set_theme\)/);
  assert.doesNotMatch(r.errors[0], /there is no question/);
  // a survey script still goes through the authoring gate
  const bad = applySurveyActions(survey(), [{ op: "set_custom_code", target: "__survey__", js: "fetch('https://x.example')" }] as never, { ids });
  assert.equal(bad.results[0].ok, false);
  // a real question is still a question
  const q = applySurveyActions(survey(), [{ op: "set_custom_code", target: "Q2", js: "rs.log('q2');" }] as never, { ids });
  assert.ok(q.results[0].ok, q.errors.join("; "));
});

/* ------------------------------------------------------------ case 5: script and effects */

test("the production popup behaviours (script + on appear / select_option) are no longer refused as 'both a script and effects'", () => {
  const def = survey();
  const r = applySurveyActions(def, [
    { op: "create_behavior", label: "Q1 Welcome Popup", target: "Q1", on: "appear", script: "rs.popup('Welcome!', { placement: 'center', dismiss: 'auto', autoMs: 2500 });" },
    { op: "create_behavior", label: "Q2 Eligible Popup on Yes", target: "Q2", on: "select_option", options: ["1"], script: "rs.popup('You are eligible to proceed!', { placement: 'center' }); rs.listen('deselect', 'self', function () { rs.closePopup(); });" },
  ] as never, { ids });
  assert.ok(r.results.every((x) => x.ok), r.errors.join("; "));
  // the model's own production script (a hand-built position:fixed overlay) is refused for THAT, with the fix — never as "both"
  const prod = applySurveyActions(def, [{ op: "create_behavior", label: "Q1 Welcome Popup", target: "Q1", on: "appear", script: "var o = document.createElement('div'); o.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999'; o.textContent = 'Welcome!'; document.body.appendChild(o); rs.after(2500, function(){ o.remove(); });" }] as never, { ids });
  assert.equal(prod.results[0].ok, false);
  assert.match(prod.errors[0], /show_popup|rs\.popup/);
  assert.ok(!prod.errors.some((e) => /both a script and effects/.test(e)));
});

test("effects AND a script on one event become two behaviours (instead of refusing both)", () => {
  const r = applySurveyActions(survey(), [
    { op: "create_behavior", label: "Q2 yes", target: "Q2", on: "select_option", options: ["1"], effects: [{ do: "show_popup", text: "You are eligible to proceed", placement: "center" }], script: "rs.log('eligible');" },
  ] as never, { ids });
  assert.ok(r.results[0].ok, r.errors.join("; "));
  const bs = r.def.ux!.behaviors;
  assert.equal(bs.length, 2);
  assert.equal(bs[0].on, "select_option");
  assert.equal(bs[0].effects[0].do, "show_popup");
  assert.equal(bs[1].label, "Q2 yes (script)");
  assert.match(bs[1].script!, /rs\.listen\("select", "self"/);
  assert.match(bs[1].script!, /\["1"\]\.indexOf/);
});

/* ------------------------------------------------------------ case 6: stopping the respondent in a look-only request */

test("a look-only request that was only inferred keeps validation allowed (Q3 javascript popup + 18+): set_validation applies", () => {
  const r = applySurveyActions(survey(), [{ op: "set_validation", target: "Q3", rules: [{ kind: "min_value", value: 18, message: "You must be 18 or older." }] }] as never, { ids, uxOnly: true, uxOnlyInferred: true });
  assert.ok(r.results[0].ok, r.errors.join("; "));
  const said = applySurveyActions(survey(), [{ op: "set_validation", target: "Q3", rules: [{ kind: "min_value", value: 18 }] }] as never, { ids, uxOnly: true });
  assert.equal(said.results[0].ok, false, "an explicit 'only the look' still refuses it");
});
