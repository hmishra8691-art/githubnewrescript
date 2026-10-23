import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { normalizedTokens, readScript, similarity, tokenize } from "./scriptAst.js";
import { behaviourFingerprint } from "./uxDuplicates.js";
import { overlaySignals, popupProblems, scriptAuthoringProblems } from "./uxScriptGuard.js";
import { validateUxScript } from "./ux.js";
import { localizeDefinition, popupUiFor, translatableElements, uiStringsFor, lintLanguage } from "./localization.js";

/*
 * ENGINE WEAKNESS #14 (2026-10-22): script checks beyond patterns — a tokenizer and reader for the sandbox's script
 * language; duplicate behaviours found by what they do (not by identical text); hand-built overlays found in any
 * spelling; and every script already in the repository judged exactly as before (the corpus snapshot).
 */

const survey = () => SurveyDefinition.parse({
  meta: { id: "sc", code: "SC", title: "Scripts", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?" },
    { id: "q3", code: "Q3", variableName: "VOTE", type: "single_select", text: "Will you vote?", options: [{ code: 1, label: "Definitely" }, { code: 2, label: "Maybe" }, { code: 3, label: "No" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q3"] }, { type: "end", id: "e", status: "complete" }],
});
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const run = (def: SurveyDefinition, actions: unknown[]) => {
  const c = coerceSurveyActions(actions);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  return applySurveyActions(def, c.actions, { ids, now: "2026-10-22T00:00:00Z" });
};

/* ---------------------------------------------------------------- the tokenizer */

test("#14 tokenizer: comments and whitespace gone, strings decoded whatever the quotes, regex told from division, templates with their expressions", () => {
  const t = tokenize(`// hi\nvar a = 'x\\'y' /* c */ + "z" + \`t\${b + 1}\` ; var r = /a\\/b/g; var d = 4 / 2;`);
  assert.deepEqual(t.filter((x) => x.k === "str").map((x) => x.v), ["x'y", "z"]);
  assert.equal(t.find((x) => x.k === "re")?.v, "/a\\/b/g");
  assert.equal(t.filter((x) => x.k === "re").length, 1, "4 / 2 is a division");
  const tpl = t.find((x) => x.k === "tpl")!;
  assert.equal(tpl.v, "t${}");
  assert.deepEqual(tpl.parts![0]!.map((x) => x.v), ["b", "+", "1"]);
  assert.equal(t.some((x) => /hi|c/.test(x.v) && x.k === "id"), false);
});

test("#14 normalised: renaming the script's own names, re-quoting, re-spacing and comments do not make another script; rs, globals, properties and keys are kept", () => {
  const a = `rs.listen("select", "self", function (e) {\n  var msg = "Thanks";\n  if (e.option == "1") rs.popup(msg, { placement: "center" });\n});`;
  const b = `// popup for option 1\nrs.listen('select','self',function(ev){ var text='Thanks'; if (ev.option=="1") { rs.popup(text,{placement:'center'}) } })`;
  assert.deepEqual(normalizedTokens(`var x = 1; foo(x)`), ["var", "$1", "=", "1", "foo", "(", "$1", ")"]);
  assert.ok(normalizedTokens(a).includes("rs") && normalizedTokens(a).includes("popup") && normalizedTokens(a).includes("placement"));
  assert.ok(similarity(a, b) >= 0.6, `alike: ${similarity(a, b)}`);
  assert.equal(similarity(a, a), 1);
  assert.ok(similarity(a, `rs.listen("change", "self", function (e) { rs.addClass("self", "big"); });`) < 0.5);
});

test("#14 reading: what a script listens for (event, options filtered by its handler), the popups it opens and closes", () => {
  const r = readScript(`rs.listen("select", "self", function (e) { if (["2","3"].indexOf(String(e.option)) < 0) return; rs.popup("Tell us why"); });\nrs.listen("deselect", "self", function () { rs.closePopup(); });`);
  assert.deepEqual(r.listens.map((l) => [l.event, l.options]), [["select", ["2", "3"]], ["deselect", null]]);
  assert.deepEqual(r.popups, ["Tell us why"]);
  assert.equal(r.closesPopup, true);
  assert.deepEqual(readScript(`rs.listen("select","self",(e)=>{ if (e.option === 1) rs.popup('x') })`).listens[0]!.options, ["1"]);
});

/* ---------------------------------------------------------------- (b) overlays in any spelling */

const OVERLAYS: [string, string][] = [
  ["bracket access", `var o = document["createElement"]("div"); o["style"]["position"] = "fixed"; o["style"]["inset"] = "0"; document.body.appendChild(o);`],
  ["a style alias", `const el = document.createElement('div'); const s = el.style; s.position = 'fixed'; s.top = '0'; s.left = '0'; s.width = '100vw'; s.height = '100vh'; document.body.append(el);`],
  ["Object.assign of a named object", `var css = { position: "fixed", zIndex: 99999, top: 0, left: 0, right: 0, bottom: 0 }; var d = document.createElement("div"); Object.assign(d.style, css); document.body.appendChild(d);`],
  ["a style string built from pieces", `var d = document.createElement("div"); d.style.cssText = "posi" + "tion: fixed; inset: 0; background: rgba(0,0,0,.6)"; document.body.appendChild(d);`],
  ["setProperty", `var d = document.createElement("section"); d.style.setProperty("position", "FIXED"); d.style.setProperty("z-index", "100000"); document.body.prepend(d);`],
  ["setAttribute(style) and role=dialog, mounted in the card", `var d = document.createElement("div"); d.setAttribute("style", "position:fixed; top:10%; left:10%"); d.setAttribute("role", "dialog"); document.querySelector('[data-qid="q3"]').appendChild(d);`],
  ["HTML written with an inline style", `document.body.insertAdjacentHTML("beforeend", '<div class="x" style="position:fixed;inset:0;background:#000a">Hello</div>');`],
  ["absolute, full viewport, huge z-index", `var m = document.createElement("div"); m.style.position = "absolute"; m.style.width = "100%"; m.style.height = "100%"; m.style.top = "0"; m.style.left = "0"; m.style.zIndex = "2147483647"; document.body.appendChild(m);`],
  ["a template literal and a backdrop filter", "var b = document.createElement('div'); b.style.cssText = `position: fixed; inset: 0; backdrop-filter: blur(4px)`; document.body.appendChild(b);"],
  ["a class named modal", `var w = document.createElement("div"); w.className = "my-modal"; w.style.position = "fixed"; w.style.bottom = "20px"; document.body.appendChild(w);`],
];
for (const [what, code] of OVERLAYS) {
  test(`#14b a hand-built overlay is found in any spelling — ${what} — and steered to show_popup / rs.popup`, () => {
    assert.equal(overlaySignals(code).overlay, true, JSON.stringify(overlaySignals(code)));
    const said = popupProblems(code).join(" ");
    assert.match(said, /builds its own popup/);
    assert.match(said, /show_popup.*rs\.popup/);
  });
}

test("#14b not overlays: a small fixed badge, a tooltip inside the card, the survey's own popup, styles on existing elements", () => {
  for (const code of [
    `var b = document.createElement('span'); b.style.position = 'fixed'; b.style.right = '8px'; b.textContent = '2/5'; document.body.appendChild(b);`,
    `var t = document.createElement('div'); t.style.position = 'absolute'; t.style.top = '100%'; t.style.zIndex = '10'; document.querySelector('[data-qid="q3"]').appendChild(t);`,
    `rs.listen("select", "self", function (e) { if (e.option == "1") rs.popup("Thanks", { placement: "center" }); else rs.closePopup(); });`,
    `document.querySelector('[data-testid="rs-next"]').style.position = 'relative';`,
  ]) assert.equal(overlaySignals(code).overlay, false, `${code}\n${JSON.stringify(overlaySignals(code))}`);
});

/* ---------------------------------------------------------------- (a) duplicates by what they do */

const POPUP_1 = { op: "create_behavior", label: "Q3 option 1 popup", target: "Q3", on: "select_option", options: ["1"], effects: [{ do: "show_popup", text: "Thanks — your vote matters.", placement: "center" }] };
const SCRIPT_POPUP_1 = { op: "create_behavior", label: "Thanks popup (script)", target: "Q3", script: `rs.listen("select", "self", function (e) {\n  if (String(e.option) === "1") rs.popup("Thank you for voting!", { placement: "center" });\n  else rs.closePopup();\n});\nrs.listen("deselect", "self", function () { rs.closePopup(); });` };

test("#14a the same popup on the same question, once as an effect and once as a script: the second is refused, naming the first to update", () => {
  const one = run(survey(), [POPUP_1]);
  assert.equal(one.results[0]!.ok, true, one.errors.join(" | "));
  const id = one.def.ux!.behaviors[0]!.id;
  const two = run(one.def, [SCRIPT_POPUP_1]);
  assert.equal(two.results[0]!.ok, false);
  assert.match(two.results[0]!.error!, new RegExp(`repeats a behaviour.*${id}.*both open a popup on the same question.*Update ${id}`));
  /* a popup for ANOTHER option is another behaviour */
  const other = run(one.def, [{ ...SCRIPT_POPUP_1, script: SCRIPT_POPUP_1.script.replace('=== "1"', '=== "3"') }]);
  assert.equal(other.results[0]!.ok, true, other.errors.join(" | "));
});

test("#14a a near-duplicate script (renamed, re-quoted, commented) on the same event is refused; a different script on the same event is not", () => {
  const base = { op: "create_behavior", label: "Age message", target: "Q1", script: `rs.listen("change", "self", function (e) {\n  var age = Number(rs.getAnswer("Q1"));\n  if (age >= 18) rs.showMessage("self", "You are eligible");\n  else rs.showMessage("self", "You must be 18 or above");\n});` };
  const one = run(survey(), [base]);
  assert.equal(one.results[0]!.ok, true, one.errors.join(" | "));
  const renamed = { ...base, label: "Age message again", script: `// eligibility\nrs.listen('change','self',function(ev){ var years = Number(rs.getAnswer('Q1')); if (years >= 18) rs.showMessage('self','You are eligible'); else rs.showMessage('self','You must be 18 or above'); });` };
  const dup = run(one.def, [renamed]);
  assert.equal(dup.results[0]!.ok, false);
  assert.match(dup.results[0]!.error!, /script is \d+ % the same/);
  const different = { ...base, label: "Age colour", script: `rs.listen("change", "self", function () { rs.addClass("self", "rs-checked"); });` };
  assert.equal(run(one.def, [different]).results[0]!.ok, true);
  /* the same script on ANOTHER event is not a duplicate */
  const otherEvent = { ...renamed, script: renamed.script.replace("'change'", "'click'") };
  assert.equal(run(one.def, [otherEvent]).results[0]!.ok, true);
});

test("#14a effects and a script asked for together on one event are still one request (not refused as twins); an update of the behaviour itself is not a duplicate of itself", () => {
  const r = run(survey(), [{ op: "create_behavior", label: "Pulse and log", target: "Q3", on: "select_option", options: ["2"], effects: [{ do: "animate", preset: "pulse" }], script: "rs.popup('Why maybe?', { placement: 'anchored', dismiss: 'auto' });" }]);
  assert.deepEqual(r.results.map((x) => x.ok), [true], r.errors.join(" | "));
  const one = run(survey(), [POPUP_1]);
  const id = one.def.ux!.behaviors[0]!.id;
  assert.equal(run(one.def, [{ op: "update_behavior", id, effects: [{ do: "show_popup", text: "Thank you!", placement: "center" }] }]).results[0]!.ok, true);
});

test("#14a fingerprints: a declared trigger and one read from a script compare equal", () => {
  const one = run(survey(), [POPUP_1]).def.ux!.behaviors[0]!;
  const fp = behaviourFingerprint(one);
  const fs = behaviourFingerprint({ ...one, id: "x", effects: [], on: undefined, options: undefined, script: SCRIPT_POPUP_1.script } as never);
  assert.deepEqual([fp.question, fp.event, fp.options], [fs.question, fs.event, fs.options]);
  assert.equal(fp.popups.length > 0 && fs.popups.length > 0, true);
});

/* ---------------------------------------------------------------- every existing script: same verdict */

test("#14 every script in the repository (tests, browser suites, guides, fixtures, templates) is judged as before — the runtime gate exactly, the authoring checks with the same refusals", () => {
  const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../src/fixtures/script-corpus.json", import.meta.url)), "utf8")) as { def: unknown; scripts: { id: string; from: string[]; code: string; verdict: { runtime: string[]; authoring: string[] } }[] };
  const def = SurveyDefinition.parse(corpus.def);
  assert.ok(corpus.scripts.length > 100, `a real corpus (${corpus.scripts.length})`);
  const changed: string[] = [];
  for (const s of corpus.scripts) {
    assert.deepEqual(validateUxScript(s.code, def).errors, s.verdict.runtime, `runtime verdict changed for ${s.id} (${s.from[0]})`);
    const now = scriptAuthoringProblems(s.code, def);
    assert.equal(now.length > 0, s.verdict.authoring.length > 0, `authoring refusal changed for ${s.id} (${s.from[0]}): ${now.join(" | ") || "now accepted"}`);
    /* the refusals are the same ones; only the overlay sentence may now say what it saw (z-index, backdrop, names) */
    const strip = (xs: string[]) => xs.map((x) => x.replace(/ \((?:it sets|its names say)[^)]*\)(?=; use the survey)/, ""));
    if (JSON.stringify(strip(now)) !== JSON.stringify(s.verdict.authoring)) changed.push(s.id);
  }
  assert.deepEqual(changed, [], "no refusal changed beyond the added detail");
});

/* ---------------------------------------------------------------- (c) the popup's words in the survey's languages */


const multilingual = () => {
  const d = run(survey(), [POPUP_1]).def;
  d.localization = { sourceLanguage: "en", languages: [{ code: "hi", status: "live", enabled: true, format: {} }, { code: "ur", status: "live", enabled: true, format: {} }, { code: "xx", status: "live", enabled: true, format: {} }], translations: {} } as never;
  return d;
};

test("#14c the popup's close label and title-less name: the survey's translation, else the built-in text for the language, else English — RTL-aware", () => {
  const d = multilingual();
  assert.equal(popupUiFor(d, "en").close, "Close");
  assert.deepEqual([popupUiFor(d, "hi").close, popupUiFor(d, "hi").message, popupUiFor(d, "hi").dir], ["बंद करें", "संदेश", "ltr"]);
  assert.deepEqual([popupUiFor(d, "ur").close, popupUiFor(d, "ur").dir], ["بند کریں", "rtl"]);
  assert.equal(popupUiFor(d, "ar-EG").close, "إغلاق", "a regional code reads its base language");
  assert.equal(popupUiFor(d, "xx").close, "Close", "no built-in text: English until it is translated");
  /* the survey's own translation wins over the built-in */
  d.localization!.translations = { hi: { "ui:popup_close": { text: "बंद", status: "approved" } } } as never;
  assert.equal(uiStringsFor(d, "hi").popup_close, "बंद");
  /* a survey written IN Hindi (the source language) gets the Hindi words too */
  const src = structuredClone(d); src.localization = { sourceLanguage: "hi", languages: [], translations: {} } as never;
  assert.equal(popupUiFor(src).close, "बंद करें");
  /* every other interface string is unchanged (no built-in for them) */
  assert.equal(uiStringsFor(d, "hi").required, "This question is required.");
});

test("#14c translation: the popup's words and text are elements only when the survey has a popup, optional (never blocking a launch), and localised for the respondent", () => {
  const plain = survey();
  assert.equal(translatableElements(plain).some((e) => e.key === "ui:popup_close"), false, "a survey without a popup lists no popup words");
  const d = multilingual();
  const els = translatableElements(d);
  const b = d.ux!.behaviors[0]!;
  const keys = els.filter((e) => e.key.startsWith("ux:") || e.key.startsWith("ui:popup")).map((e) => [e.key, e.mandatory]);
  assert.deepEqual(keys, [[`ux:${b.id}:0:text`, false], ["ui:popup_close", false], ["ui:popup_message", false]]);
  d.localization!.translations = { hi: { [`ux:${b.id}:0:text`]: { text: "धन्यवाद — आपका वोट मायने रखता है।", status: "approved" } } } as never;
  const hi = localizeDefinition(d, "hi");
  assert.equal(hi.ux!.behaviors[0]!.effects[0]!.text, "धन्यवाद — आपका वोट मायने रखता है।");
  assert.equal(localizeDefinition(d, "ur").ux!.behaviors[0]!.effects[0]!.text, "Thanks — your vote matters.", "untranslated: the source text");
  const r = lintLanguage(d, "ur");
  assert.equal(r.issues.some((i) => i.blocking && /popup|ux:/.test(`${i.key} ${i.label}`)), false, "a missing popup translation never blocks");
});
