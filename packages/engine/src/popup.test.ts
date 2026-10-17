import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, UxEffect } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { evaluateUxTriggers, questionHooks, uxBehaviorTrigger, uxContextFor, validateUxItem, validateUxScript, UX_SCRIPT_API } from "./ux.js";
import { popupProblems, scriptAuthoringProblems } from "./uxScriptGuard.js";
import { migrateLegacyCustomCode } from "./legacyScripts.js";

/**
 * P3 (2026-10-17) — "When Q3 has option 1 selected, display a popup."
 *
 * The survey's own popup (the show_popup effect, rs.popup in a script) instead of hand-built
 * overlays; one behaviour per thing; small script edits without resending the script; and the
 * Custom Code ↔ script audit.
 */
const survey = () => SurveyDefinition.parse({
  meta: { id: "pop", code: "POP", title: "Popups", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?" },
    { id: "q2", code: "Q2", variableName: "CIT", type: "single_select", text: "Citizen?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q3", code: "Q3", variableName: "VOTE", type: "single_select", text: "Will you vote?", options: [{ code: 1, label: "Definitely" }, { code: 2, label: "Maybe" }, { code: 3, label: "No" }] },
    { id: "q4", code: "Q4", variableName: "WIDGET", type: "custom_component", text: "Widget", customJs: "el.textContent = 'component';" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3"] }, { type: "page", id: "p3", questionIds: ["q4"] }, { type: "end", id: "e", status: "complete" }],
});
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const run = (def: SurveyDefinition, actions: unknown[]) => {
  const c = coerceSurveyActions(actions);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  return applySurveyActions(def, c.actions, { ids, now: "2026-10-17T00:00:00Z" });
};
const Q3_POPUP = { op: "create_behavior", label: "Q3 option 1 popup", target: "Q3", on: "select_option", options: ["1"], effects: [{ do: "show_popup", title: "Thank you", text: "Thanks — your vote matters.", placement: "center" }] };

test("the user's example: Q3 option 1 → a centred popup, by its real option code, described in words", () => {
  const r = run(survey(), [Q3_POPUP]);
  assert.deepEqual(r.results.map((x) => x.ok), [true], r.errors.join("; "));
  const b = r.def.ux!.behaviors[0]!;
  assert.equal(b.on, "select_option");
  assert.deepEqual(b.options, ["1"]);
  assert.deepEqual(b.effects, [{ do: "show_popup", title: "Thank you", text: "Thanks — your vote matters.", placement: "center" }]);
  assert.equal(b.target.questionId, "q3");
  assert.match(r.results[0]!.description, /when option 1 is selected on Q3 → open a centred popup “Thank you”: “Thanks — your vote matters\.”, with a close button — shown only while that holds, closed when it stops/);
  // an option named by its label is stored as its code; a code that does not exist is refused with the reason
  const byLabel = run(survey(), [{ ...Q3_POPUP, options: ["Definitely"] }]);
  assert.deepEqual(byLabel.def.ux!.behaviors[0]!.options, ["1"]);
  assert.match(run(survey(), [{ ...Q3_POPUP, options: ["7"] }]).errors.join(" "), /Q3 has no option “7”/);
});

test("schema: show_popup is additive — the old effects parse as before, the new fields are bounded", () => {
  assert.deepEqual(UxEffect.parse({ do: "show_message", text: "hi" }), { do: "show_message", text: "hi" });
  assert.equal(UxEffect.parse({ do: "show_popup", text: "x", placement: "anchored", dismiss: "auto", autoMs: 3000 }).placement, "anchored");
  assert.throws(() => UxEffect.parse({ do: "show_popup", text: "x", placement: "left" }));
  assert.throws(() => UxEffect.parse({ do: "show_popup", text: "x", autoMs: 10 }));
  assert.equal(UxEffect.parse({ do: "hide_popup" }).do, "hide_popup");
});

test("the model's words for a popup are read as the survey's popup; nonsense is refused with the choices", () => {
  const r = run(survey(), [{ op: "create_behavior", label: "hint", target: "Q3", on: "select_option", options: ["2"], effects: [{ do: "popup", text: "Tell us why", placement: "tooltip", dismiss: "close", target: "Q3.option:2" }] }]);
  assert.equal(r.results[0]!.ok, true, r.errors.join("; "));
  const e = r.def.ux!.behaviors[0]!.effects[0]!;
  assert.deepEqual([e.do, e.placement, e.dismiss, e.target?.code], ["show_popup", "anchored", "button", "2"]);
  assert.match(r.results[0]!.description, /open a popup next to Q3 option “Maybe”/);
  assert.match(run(survey(), [{ ...Q3_POPUP, effects: [{ do: "show_popup", text: "x", placement: "left-corner" }] }]).errors.join(" "), /is not a popup placement \(center, anchored, top, inline\)/);
});

test("validation: text required; a centred popup the respondent cannot close is refused; a momentary event without dismiss is warned", () => {
  assert.match(run(survey(), [{ ...Q3_POPUP, effects: [{ do: "show_popup" }] }]).errors.join(" "), /\(show_popup\) needs text/);
  assert.match(run(survey(), [{ ...Q3_POPUP, effects: [{ do: "show_popup", text: "x", dismiss: "none" }] }]).errors.join(" "), /a centred popup covers the survey, so the respondent must be able to close it/);
  const inlineNone = run(survey(), [{ ...Q3_POPUP, effects: [{ do: "show_popup", text: "x", placement: "inline", dismiss: "none" }] }]);
  assert.equal(inlineNone.results[0]!.ok, true, "an inline popup may stay while its condition holds");
  const onAnswer = run(survey(), [{ op: "create_behavior", label: "a", target: "Q1", on: "answer", effects: [{ do: "show_popup", text: "Thanks" }] }]);
  assert.equal(onAnswer.results[0]!.ok, true);
  assert.match(onAnswer.warnings.join(" "), /on answer the popup opens and stays until the respondent closes it/);
  const onAnswerDismiss = run(survey(), [{ op: "create_behavior", label: "a", target: "Q1", on: "answer", effects: [{ do: "show_popup", text: "Thanks", dismiss: "auto", autoMs: 4000 }] }]);
  assert.doesNotMatch(onAnswerDismiss.warnings.join(" "), /opens and stays/);
  assert.doesNotMatch(run(survey(), [Q3_POPUP]).warnings.join(" "), /opens and stays/, "select_option holds: no warning");
});

test("hold and undo: shown while option 1 is selected, released when it is not, held once again — and again on coming back to the page", () => {
  const def = run(survey(), [Q3_POPUP]).def;
  const id = def.ux!.behaviors[0]!.id;
  const step = (prev: Record<string, unknown> | null, now: Record<string, unknown>, active: string[]) => evaluateUxTriggers({ def, prev, now, shown: ["q3"], active: new Set(active), fired: new Set() });
  const open = step(null, {}, []);
  assert.deepEqual([open.hold.length, open.release.length, open.fire.length], [0, 0, 0], "nothing selected: no popup");
  const sel1 = step({}, { q3: 1 }, []);
  assert.deepEqual(sel1.hold.map((b) => b.id), [id], "option 1 → held (shown)");
  assert.deepEqual(step({ q3: 1 }, { q3: 1 }, [id]).hold, [], "a re-render while it holds does not show it twice");
  assert.deepEqual(step({ q3: 1 }, { q3: 2 }, [id]).release.map((b) => b.id), [id], "option 2 → released (closed)");
  assert.deepEqual(step({ q3: 2 }, { q3: 1 }, []).hold.map((b) => b.id), [id], "option 1 again → held again, once");
  assert.deepEqual(step({ q3: 1 }, {}, [id]).release.map((b) => b.id), [id], "deselected → released");
  assert.deepEqual(step(null, { q3: 1 }, []).hold.map((b) => b.id), [id], "Back to the page with option 1 kept → shown once");
  assert.deepEqual(evaluateUxTriggers({ def, prev: null, now: { q3: 1 }, shown: ["q4"], active: new Set(), fired: new Set() }).hold, [], "another page: never shown");
});

test("a declarative behaviour and a script on the same event: the engine fires the declarative one once and never the script (the script hears it from the host, once)", () => {
  const d = survey();
  d.ux = { styles: [], animations: [], behaviors: [
    { id: "b_decl", label: "decl", target: { kind: "question", questionId: "q2" }, on: "answer", effects: [{ do: "show_message", text: "thanks" }] },
    { id: "b_scr", label: "scr", target: { kind: "question", questionId: "q2" }, effects: [], script: 'rs.listen("answer", "self", function (e) { rs.log(e.value); });' },
  ] };
  const r = evaluateUxTriggers({ def: d, prev: {}, now: { q2: 1 }, shown: ["q1", "q2"], active: new Set(), fired: new Set() });
  assert.deepEqual(r.fire.map((b) => b.id), ["b_decl"]);
  assert.deepEqual([...r.hold, ...r.release].map((b) => b.id), []);
});

test("one behaviour per thing: a second one for the same target, event, options and condition is refused with “update <id>”", () => {
  // in one batch
  const batch = run(survey(), [Q3_POPUP, { ...Q3_POPUP, label: "again", effects: [{ do: "show_message", text: "x" }] }]);
  assert.deepEqual(batch.results.map((x) => x.ok), [true, false]);
  const id = batch.def.ux!.behaviors[0]!.id;
  assert.match(batch.errors.join(" "), new RegExp(`there is already a behaviour for this — ${id} “Q3 option 1 popup”.*Update ${id} instead of adding a second one`));
  // against an existing one — and a script the engine wrapped for the same event is the same thing
  const def = batch.def;
  const script = run(def, [{ op: "create_behavior", label: "scripted", target: "Q3", on: "select_option", options: ["1"], script: "rs.showMessage('self', 'hi');" }]);
  assert.match(script.errors.join(" "), new RegExp(`Update ${id}`));
  // the other way round: a declarative one where the wrapped script already is
  const s1 = run(survey(), [{ op: "create_behavior", label: "scripted", target: "Q3", on: "select_option", options: ["1"], script: "rs.showMessage('self', 'hi');" }]);
  assert.deepEqual(uxBehaviorTrigger(s1.def.ux!.behaviors[0]!), { on: "select_option", options: ["1"] });
  assert.match(run(s1.def, [Q3_POPUP]).errors.join(" "), /there is already a behaviour for this .*a script\)\. Update .* with "edits" or a new "script"/);
  // not a duplicate: other options, another condition, another question
  assert.deepEqual(run(def, [{ ...Q3_POPUP, options: ["2"] }]).results.map((x) => x.ok), [true]);
  assert.deepEqual(run(def, [{ ...Q3_POPUP, when: "Q2 = 1" }]).results.map((x) => x.ok), [true]);
  assert.deepEqual(run(def, [{ ...Q3_POPUP, target: "Q2" }]).results.map((x) => x.ok), [true]);
  // updating the one there is is fine
  assert.deepEqual(run(def, [{ op: "update_behavior", id, effects: [{ do: "show_popup", text: "New text" }] }]).results.map((x) => x.ok), [true]);
});

test("update_behavior edits: one string of a stored script changes, the rest is not resent; each find must occur exactly once", () => {
  const script = `rs.listen("answer", "self", function (e) {\n  if (Number(e.value) >= 18) rs.popup("You are eligible", { placement: "center" });\n  else rs.closePopup();\n});`;
  const base = run(survey(), [{ op: "create_behavior", label: "Q1 eligible", target: "Q1", script }]);
  assert.equal(base.results[0]!.ok, true, base.errors.join("; "));
  const id = base.def.ux!.behaviors[0]!.id;
  const r = run(base.def, [{ op: "update_behavior", id, edits: [{ find: "You are eligible", replace: "You are an eligible voter" }] }]);
  assert.equal(r.results[0]!.ok, true, r.errors.join("; "));
  assert.equal(r.def.ux!.behaviors[0]!.script, script.replace("You are eligible", "You are an eligible voter"));
  assert.match(r.results[0]!.description, /1 edit to its script \(“You are eligible” → “You are an eligible voter”\) — checked before it was added/);
  // several, in order
  const two = run(base.def, [{ op: "update_behavior", id, edits: [{ find: ">= 18", replace: ">= 21" }, { find: "\"center\"", replace: "\"top\"" }] }]);
  assert.match(two.def.ux!.behaviors[0]!.script!, />= 21\) rs\.popup\("You are eligible", \{ placement: "top" \}\)/);
  // the outline shows a short script on one line: the same text across its line breaks still matches once
  const ws = run(base.def, [{ op: "update_behavior", id, edits: [{ find: "{ placement: \"center\" }); else rs.closePopup();", replace: "{ placement: \"top\" }); else rs.closePopup();" }] }]);
  assert.equal(ws.results[0]!.ok, true, ws.errors.join("; "));
  assert.match(ws.def.ux!.behaviors[0]!.script!, /\{ placement: "top" \}\); else rs\.closePopup\(\);\n\}\);$/);
  // refusals, each with the reason
  assert.match(run(base.def, [{ op: "update_behavior", id, edits: [{ find: "not there", replace: "x" }] }]).errors.join(" "), /edit 1: “not there” is not in the script of “Q1 eligible”/);
  assert.match(run(base.def, [{ op: "update_behavior", id, edits: [{ find: "rs.", replace: "x" }] }]).errors.join(" "), /edit 1: “rs\.” occurs 3 times .* include more of the text around it/);
  assert.match(run(base.def, [{ op: "update_behavior", id, script: "rs.log(1);", edits: [{ find: "18", replace: "21" }] }]).errors.join(" "), /give the whole script or edits to it, not both/);
  assert.match(run(base.def, [{ op: "update_behavior", id, edits: [{ find: "rs.closePopup();", replace: "fetch('/x');" }] }]).errors.join(" "), /fetch is not available/, "the edited script passes the same gate");
  const decl = run(survey(), [Q3_POPUP]);
  assert.match(run(decl.def, [{ op: "update_behavior", id: decl.def.ux!.behaviors[0]!.id, edits: [{ find: "a", replace: "b" }] }]).errors.join(" "), /has no script to edit/);
  assert.equal(coerceSurveyActions([{ op: "update_behavior", id, edits: [{ nope: 1 }] }]).rejected.length, 1, "edits that are not {find, replace} are refused at the gate");
});

test("authoring checks: a hand-built overlay is refused with the survey's popup as the fix; the survey's popup passes", () => {
  const full = `var o = document.createElement('div'); o.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5)'; o.textContent = 'Hi'; document.body.appendChild(o);`;
  assert.match(popupProblems(full).join(" "), /builds its own popup \(a position: fixed element appended to document\.body that covers the whole screen\).*show_popup.*rs\.popup/);
  const inset = `var box = document.createElement('div'); Object.assign(box.style, { position: 'fixed', inset: '0' }); document.body.append(box);`;
  assert.equal(popupProblems(inset).length, 1);
  // the one that landed in the far left corner: not full-screen, but plainly a popup
  const corner = `var popup = document.createElement('div'); popup.style.position = 'fixed'; popup.style.top = '20px'; popup.textContent = 'Eligible'; document.body.appendChild(popup);`;
  assert.match(popupProblems(corner).join(" "), /builds its own popup \(a position: fixed element appended to document\.body\)/);
  // not refused: a fixed element that is not a popup; an element in the card; rs.popup on page open
  assert.deepEqual(popupProblems(`var b = document.createElement('span'); b.style.position = 'fixed'; b.style.right = '8px'; b.textContent = '2/5'; document.body.appendChild(b);`), []);
  assert.deepEqual(popupProblems(`var m = document.createElement('div'); m.textContent = 'hi'; document.querySelector('[data-qid="q3"]').appendChild(m);`), []);
  assert.deepEqual(popupProblems(`rs.popup("Welcome!", { title: "Hello" });`), []);
  // through the action: refused where it is written, a warning in the editor (a stored script keeps running)
  const r = run(survey(), [{ op: "create_behavior", label: "overlay", target: "Q3", on: "select_option", options: ["1"], script: full }]);
  assert.equal(r.results[0]!.ok, false);
  assert.match(r.errors.join(" "), /builds its own popup/);
  assert.deepEqual(validateUxScript(full, survey()).errors, [], "the runtime gate is unchanged");
});

test("authoring checks: rs.popup opened on an answer must close when the answer changes", () => {
  const noClose = `rs.listen("select", "self", function (e) { if (e.option === "1") rs.popup("Thanks!"); });`;
  assert.match(scriptAuthoringProblems(noClose, survey()).join(" "), /opens rs\.popup when the answer changes but never closes it.*rs\.closePopup\(\).*show_popup effect on select_option/);
  assert.deepEqual(popupProblems(`rs.listen("select", "self", function (e) { if (e.option === "1") rs.popup("Thanks!"); else rs.closePopup(); });`), []);
  assert.deepEqual(popupProblems(`rs.listen("select", "self", function () { rs.popup("Thanks!", { dismiss: "auto" }); });`), [], "one that closes itself");
  assert.equal(popupProblems(`var box = document.querySelector('[data-qid="q1"] input'); box.addEventListener('input', function () { rs.popup('x'); });`).length, 1, "an input listener is an answer event too");
  // the wrapped form (on + options + script) is checked the same way
  const wrapped = run(survey(), [{ op: "create_behavior", label: "w", target: "Q3", on: "select_option", options: ["1"], script: `rs.popup("Thanks!", { placement: "center" });` }]);
  assert.match(wrapped.errors.join(" "), /never closes it/);
  // the runtime gate knows the api
  assert.ok(UX_SCRIPT_API.includes("popup") && UX_SCRIPT_API.includes("closePopup"));
  assert.deepEqual(validateUxScript(`rs.popup("x", { title: "t", placement: "anchored", target: "Q3.option:1" }); rs.closePopup();`, survey()).errors, []);
});

test("the outline gives what the model needs to choose: type, option codes and labels, each behaviour with its id, event, effect and guard", () => {
  const d = run(survey(), [
    { ...Q3_POPUP, when: "Q2 = 1", once: true },
    { op: "create_behavior", label: "Q3 maybe", target: "Q3", on: "select_option", options: ["2"], script: "rs.showMessage('self', 'Why maybe?');" },
  ]).def;
  const lines = uxContextFor(d, "q3").join("\n");
  const [b1, b2] = d.ux!.behaviors;
  assert.match(lines, new RegExp(`behaviour ${b1!.id} “Q3 option 1 popup” on select_option 1 → show_popup center “Thanks — your vote matters\\.”, when Q2 = 1, once`));
  assert.match(lines, new RegExp(`behaviour ${b2!.id} “Q3 maybe” script \\(\\d+ chars, runs on select_option 2\\)`));
  assert.match(questionHooks(d, d.questions[2]!).join(" "), /\(1 Definitely, 2 Maybe, 3 No\)/);
});

test("Custom Code ↔ scripts audit: set_custom_code supersedes the question's old code in either form; a component's code is its own", () => {
  // the Studio migrates customJs into a script as soon as a survey opens — then the model writes the question's code
  const legacy = survey();
  legacy.questions[1]!.customJs = "el.classList.add('old');";
  const migrated = migrateLegacyCustomCode(legacy).def;
  const old = migrated.ux!.behaviors.find((b) => b.source === "question_custom_js")!;
  assert.ok(old && old.target.questionId === "q2");
  const r = run(migrated, [{ op: "set_custom_code", target: "Q2", js: "rs.showMessage('self', 'new');" }]);
  assert.equal(r.results[0]!.ok, true, r.errors.join("; "));
  const scripts = r.def.ux!.behaviors.filter((b) => b.target.questionId === "q2" && b.script);
  assert.equal(scripts.length, 1, "one script on Q2 — the old code no longer runs beside the new one");
  assert.equal(scripts[0]!.id, old.id, "it takes the old one's place");
  assert.equal(scripts[0]!.source, "copilot_custom_code");
  assert.equal(scripts[0]!.script, "rs.showMessage('self', 'new');");
  assert.ok(r.results[0]!.destructive, "replacing code is said");
  // un-migrated field: superseded too, never left to run as well
  const raw = survey();
  raw.questions[1]!.customJs = "el.classList.add('old');";
  const r2 = run(raw, [{ op: "set_custom_code", target: "Q2", js: "rs.showMessage('self', 'new');" }]);
  assert.equal(r2.def.questions[1]!.customJs, undefined);
  assert.equal(migrateLegacyCustomCode(r2.def).def.ux!.behaviors.filter((b) => b.target.questionId === "q2").length, 1, "nothing left for the migration to add");
  // removing it removes the old one as well
  const r3 = run(migrated, [{ op: "set_custom_code", target: "Q2", js: null }]);
  assert.equal(r3.def.ux!.behaviors.filter((b) => b.target.questionId === "q2").length, 0);
  // custom_component: its customJs IS the component — never migrated, written in place
  assert.equal(migrateLegacyCustomCode(survey()).def.questions[3]!.customJs, "el.textContent = 'component';");
  const c = run(survey(), [{ op: "set_custom_code", target: "Q4", js: "el.textContent = 'v2';" }]);
  assert.equal(c.def.questions[3]!.customJs, "el.textContent = 'v2';");
  assert.equal((c.def.ux?.behaviors ?? []).length, 0, "no script behaviour for a component");
});

test("a script's popup and a declarative popup on different questions are both fine; validateUxItem is lenient in the editor", () => {
  const d = survey();
  const b = { id: "x", label: "x", target: { kind: "question" as const, questionId: "q3" }, effects: [], script: `rs.listen("select", "self", function () { rs.popup("hi"); });` };
  assert.equal(validateUxItem(d, "behavior", b).errors.length, 0, "the editor only warns");
  assert.match(validateUxItem(d, "behavior", b).warnings.join(" "), /never closes it/);
  assert.match(validateUxItem(d, "behavior", b, { authoring: true }).errors.join(" "), /never closes it/);
});
