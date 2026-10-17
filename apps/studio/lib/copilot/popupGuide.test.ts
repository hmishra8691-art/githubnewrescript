import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "@rescript/engine";
import { COPILOT_UX_GUIDE, COPILOT_SYSTEM_PROMPT, classifyRequest, copilotUserPrompt, referencedQuestions } from "./prompt.ts";
import { copilotOutline } from "./outline.ts";

/**
 * P3 (2026-10-17) — "When Q3 has option 1 selected, display a popup": what the model is told
 * (CHOOSING THE PATTERN, the survey's popup, script edits) and what it sees (the outline).
 */
const survey = () => SurveyDefinition.parse({
  meta: { id: "p3", code: "P3", title: "Votes", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?" },
    { id: "q2", code: "Q2", variableName: "CIT", type: "single_select", text: "Citizen?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q3", code: "Q3", variableName: "VOTE", type: "single_select", text: "Will you vote?", options: [{ code: 1, label: "Definitely" }, { code: 2, label: "Maybe" }, { code: 3, label: "No" }], displayLogic: { type: "rule", source: { kind: "question", ref: "q2" }, operator: "eq", value: 1 } },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3"] }, { type: "end", id: "e", status: "complete" }],
});
const REQUEST = "When Q3 has option 1 selected, display a popup";

test("the UX guide says how to choose: declarative + show_popup for a conditional popup, scripts only with rs.popup, one mechanism per behaviour, edits", () => {
  assert.match(COPILOT_UX_GUIDE, /CHOOSING THE PATTERN:/);
  assert.match(COPILOT_UX_GUIDE, /select_option holds while selected and undoes itself after/);
  assert.match(COPILOT_UX_GUIDE, /A popup → the show_popup effect, never a hand-made overlay/);
  assert.match(COPILOT_UX_GUIDE, /"center" \(modal\) for confirmations, eligibility.*"anchored" \(next to its "target".*plain feedback beside the answer is show_message/);
  assert.match(COPILOT_UX_GUIDE, /rs\.popup \/ rs\.closePopup \/ rs\.showMessage, never your own position:fixed element/);
  assert.match(COPILOT_UX_GUIDE, /rs\.popup\(text, \{title, placement, target, dismiss\}\) rs\.closePopup\(\)/);
  assert.match(COPILOT_UX_GUIDE, /One mechanism per behaviour: if the outline lists one for the same target and event, update it by id/);
  assert.match(COPILOT_UX_GUIDE, /show_popup \{text, title, placement, dismiss, autoMs\} · hide_popup/);
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 14_800, "the system prompt is unchanged");
});

test("the worked example is the user's request, and the engine accepts it as written: Q3, option code 1, a centred popup that holds", () => {
  const lines = [...COPILOT_UX_GUIDE.matchAll(/^\{"op":"create_behavior","label":"Q3 option 1 popup".*\}$/gm)].map((m) => JSON.parse(m[0]));
  assert.equal(lines.length, 1);
  const c = coerceSurveyActions(lines);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(survey(), c.actions);
  assert.deepEqual(r.results.map((x) => x.ok), [true], r.errors.join("; "));
  const b = r.def.ux!.behaviors[0]!;
  assert.deepEqual([b.on, b.options, b.effects[0]!.do, b.effects[0]!.placement], ["select_option", ["1"], "show_popup", "center"]);
  assert.match(r.results[0]!.description, /shown only while that holds, closed when it stops/);
  // the edits example is a valid action too
  const edits = [...COPILOT_UX_GUIDE.matchAll(/^\{"op":"update_behavior","id":"…","edits".*?\}\]\}/gm)].map((m) => JSON.parse(m[0]));
  assert.equal(edits.length, 1);
  assert.deepEqual(coerceSurveyActions(edits).rejected, []);
});

test("the request reaches the UX guide, names Q3, and the outline gives Q3's type, option codes and labels, display logic, hooks and existing behaviours by id", () => {
  const cls = classifyRequest(REQUEST, 3, 0);
  assert.equal(cls.ux, true);
  const d = survey();
  const focus = referencedQuestions(d, REQUEST);
  assert.deepEqual(focus, ["q3"]);
  const withB = applySurveyActions(d, [
    { op: "create_behavior", label: "Q3 maybe hint", target: "Q3", on: "select_option", options: ["2"], effects: [{ do: "show_popup", text: "Why maybe?", placement: "anchored", target: "Q3.option:2" }] },
  ] as never).def;
  const o = copilotOutline(withB, { focusIds: focus, ux: true });
  assert.match(o, /Q3 \(VOTE\) · single select · "Will you vote\?" · options: 1=Definitely, 2=Maybe, 3=No/);
  assert.match(o, /Q3 details: display logic: Q2 = 1/);
  assert.match(o, /Q3 ux: .*option \[data-qid="q3"\] \[data-rs-el="option"\]\[data-rs-id="<code>"\] \(1 Definitely, 2 Maybe, 3 No\)/);
  const id = withB.ux!.behaviors[0]!.id;
  assert.match(o, new RegExp(`behaviour ${id} “Q3 maybe hint” on Q3: on select_option 2 → show_popup Q3 option “Maybe” anchored “Why maybe\\?”`));
  assert.match(o, new RegExp(`Q3 ux: .*behaviour ${id} “Q3 maybe hint” on select_option 2 → show_popup`));
  const prompt = copilotUserPrompt({ message: REQUEST, outline: o, surveyLanguage: "en", mode: cls.mode, ux: cls.ux });
  assert.ok(prompt.includes("CHOOSING THE PATTERN"), "the guide goes with the request");
});

test("a long script on a named question is shown as stored, so a small change can be an edit", () => {
  const long = `rs.listen("answer", "self", function (e) {\n${Array.from({ length: 30 }, (_, i) => `  rs.log("line ${i}");`).join("\n")}\n  if (Number(e.value) >= 18) rs.popup("You are eligible"); else rs.closePopup();\n});`;
  const d = applySurveyActions(survey(), [{ op: "create_behavior", label: "Q1 long", target: "Q1", script: long }] as never);
  assert.deepEqual(d.results.map((x) => x.ok), [true], d.errors.join("; "));
  const id = d.def.ux!.behaviors[0]!.id;
  const o = copilotOutline(d.def, { focusIds: ["q1"], ux: true });
  assert.ok(o.includes(`${id} script as stored (${long.length} chars): ${JSON.stringify(long)}`));
  assert.doesNotMatch(copilotOutline(d.def, { focusIds: ["q2"], ux: true }), /script as stored/, "only for the questions the request names");
  // the edit a model would write from it
  const r = applySurveyActions(d.def, coerceSurveyActions([{ op: "update_behavior", id, edits: [{ find: "rs.popup(\"You are eligible\")", replace: "rs.popup(\"You are an eligible voter\", { placement: \"top\" })" }] }]).actions);
  assert.deepEqual(r.results.map((x) => x.ok), [true], r.errors.join("; "));
  assert.equal(r.def.ux!.behaviors[0]!.script, long.replace("rs.popup(\"You are eligible\")", "rs.popup(\"You are an eligible voter\", { placement: \"top\" })"));
});

test("popup, modal, tooltip and hint requests reach the UX guide (P3 browser finding: “show a small hint popup” went without it)", () => {
  for (const t of ["When Q3 option 2 is selected, show a small hint popup next to that option", "show a tooltip on Q3 option 2", "Display a centred modal when Q4 is Yes", "If Q3 = 1 show a message saying thanks", "When Q3 has option 1 selected, display a popup"]) {
    const c = classifyRequest(t, 3, 0);
    assert.equal(c.ux, true, t);
    assert.equal(c.uxOnly, false, t);
  }
  assert.equal(classifyRequest("Add a question about banner ads", 3, 0).ux, false);
});
