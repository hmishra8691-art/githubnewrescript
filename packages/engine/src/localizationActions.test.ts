import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  coerceSurveyActions, applySurveyActions, reviewSurvey, resolveTranslationTarget, translatableElements, translationProblem,
  resolveLanguage, lintLanguage, localizeDefinition, diffSurveys, applyLocalizationAction,
} from "./index.js";

/*
 * TRANSLATION INTELLIGENCE (research-intelligence Phase 3): the copilot's
 * localization actions — languages, the model's own translations checked
 * against their source, locking, routing, the glossary — and the impact loop
 * that marks translations outdated when a proposal changes their source.
 */

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey() {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Brand study", version: "1.0" },
    embeddedData: [{ name: "country", source: "url" }],
    questions: [
      { id: "q1", code: "Q1", variableName: "COUNTRY", type: "single_select", text: "Which country do you live in?", options: opts("United States", "Mexico", "Germany") },
      { id: "q2", code: "Q2", variableName: "BRAND", type: "single_select", text: "Which brand did you buy last?", instruction: "Select one", options: opts("Brand A", "Brand B", "None of these") },
      { id: "q3", code: "Q3", variableName: "WHY", type: "long_text", text: "Why did you choose {{BRAND}}?" },
      { id: "q4", code: "Q4", variableName: "TRUST", type: "matrix_single", text: "How much do you <b>trust</b> each brand?", rows: [{ code: "r1", label: "Brand A" }, { code: "r2", label: "Brand B" }], options: opts("Not at all", "A little", "A lot") },
    ],
    flow: [
      { type: "block", id: "b1", title: "Screening", children: [{ type: "page", id: "p1", questionIds: ["q1"] }] },
      { type: "block", id: "b2", title: "Brand", children: [{ type: "page", id: "p2", questionIds: ["q2", "q3", "q4"] }] },
      { type: "end", id: "e", status: "complete", message: "Thank you!" },
    ],
    deployment: { clientSlug: "c", studySlug: "s", languages: ["en"] },
  });
}
const acts = (raw: unknown[]) => coerceSurveyActions(raw);
const run = (def: SurveyDefinition, raw: unknown[]) => applySurveyActions(def, acts(raw).actions, { now: "2026-10-04T00:00:00Z" });

test("targets: a translation names its element the way a person does — Q2, Q2.option:2 (or by label), Q4.row:r1, Q3.instruction, meta:title, end:complete, ui:required", () => {
  const def = survey();
  const els = translatableElements(def);
  const q = (ref: string) => def.questions.find((x) => x.code === ref || x.variableName === ref);
  const r = (t: string) => resolveTranslationTarget(def, els, t, q)?.key;
  assert.equal(r("Q2"), "q:q2:text");
  assert.equal(r("BRAND"), "q:q2:text", "by variable too");
  assert.equal(r("Q2.instruction"), "q:q2:instruction");
  assert.equal(r("Q2.option:2"), "q:q2:opt:2");
  assert.equal(r("Q2.option:Brand B"), "q:q2:opt:2", "by label");
  assert.equal(r("Q4.row:r1"), "q:q4:row:r1");
  assert.equal(r("Q4.row:Brand B"), "q:q4:row:r2");
  assert.equal(r("Q4.option:A lot"), "q:q4:opt:3");
  assert.equal(r("meta:title"), "meta:title");
  assert.equal(r("end:e"), "flow:e:message");
  assert.equal(r("end:complete"), "flow:e:message");
  assert.equal(r("ui:required"), "ui:required");
  assert.equal(r("UI.required"), "ui:required", "the ui prefix in any spelling");
  assert.equal(r("title"), "meta:title"); assert.equal(r("Survey title"), "meta:title");
  assert.equal(r("button:next"), "branding:buttons:next");
  assert.equal(r("block:Brand"), "flow:b2:title");
  assert.equal(r("Q9"), undefined);
  assert.equal(r("Q2.option:7"), undefined);
  assert.equal(r("q:q2:opt:1"), "q:q2:opt:1", "an element key is accepted as it is");
});

test("a translation that would break the respondent's survey is refused: a dropped pipe, broken HTML, an empty text, a brand name translated", () => {
  const glossary = [{ id: "g1", source: "Brand A", targets: {}, scope: "project" as const, caseSensitive: false, doNotTranslate: true }];
  assert.equal(translationProblem("Why did you choose {{BRAND}}?", "Warum haben Sie {{BRAND}} gewählt?", glossary, "de"), null);
  assert.match(translationProblem("Why did you choose {{BRAND}}?", "Warum haben Sie diese Marke gewählt?", glossary, "de")!, /piping \/ placeholders must be kept/);
  assert.match(translationProblem("How much do you <b>trust</b> each brand?", "Wie sehr <b>vertrauen</b> Sie < jeder Marke?", glossary, "de")!, /unbalanced/);
  assert.match(translationProblem("How much do you <b>trust</b> each brand?", "Wie sehr vertrauen Sie jeder Marke?", glossary, "de")!, /HTML tags must match/);
  assert.match(translationProblem("Select one", "   ", glossary, "de")!, /empty/);
  assert.match(translationProblem("Select one", "123", glossary, "de")!, /no words/);
  assert.match(translationProblem("I trust Brand A", "Ich vertraue Marke A", glossary, "de")!, /“Brand A” is a term that is never translated/);
  assert.equal(translationProblem("I trust Brand A", "Ich vertraue Brand A", glossary, "de"), null);
  assert.equal(translationProblem("This question is required.", "Diese Frage ist erforderlich.", [], "de"), null);
});

test("add a language, translate a block into it, approve, then the model cannot overwrite what is approved without saying so", () => {
  const def = survey();
  const out = run(def, [
    { op: "add_language", code: "de-DE" },
    { op: "add_language", code: "klingon" },
    { op: "set_glossary", entries: [{ source: "Brand A", doNotTranslate: true }, { source: "Brand B", doNotTranslate: true }, { source: "trust", targets: { de: "vertrauen" } }] },
    { op: "set_translations", language: "de", entries: [
      { target: "Q2", text: "Welche Marke haben Sie zuletzt gekauft?" },
      { target: "Q2.instruction", text: "Eine auswählen" },
      { target: "Q2.option:1", text: "Brand A" }, { target: "Q2.option:2", text: "Brand B" }, { target: "Q2.option:None of these", text: "Keine davon" },
      { target: "Q3", text: "Warum haben Sie {{BRAND}} gewählt?" },
      { target: "Q4", text: "Wie sehr <b>glauben</b> Sie jeder Marke?" },
      { target: "Q4.row:r1", text: "Brand A" }, { target: "Q4.row:r2", text: "Marke B" },
      { target: "Q4.option:1", text: "Gar nicht" }, { target: "Q4.option:2", text: "Ein wenig" }, { target: "Q4.option:3", text: "Sehr" },
      { target: "Q7", text: "nichts" },
      { target: "end:complete", text: "Vielen Dank!" },
    ] },
    { op: "set_translations", language: "fr", entries: [{ target: "Q2", text: "Quelle marque ?" }] },
  ]);
  assert.ok(out.valid);
  assert.equal(acts([{ op: "add_language", code: "klingon" }]).rejected.length, 1, "not a language code");
  assert.equal(acts([{ op: "set_translations", language: "de", entries: [] }]).rejected.length, 1, "nothing to translate is refused at the gate");
  const env = { question: (ref: string) => def.questions.find((x) => x.code === ref || x.variableName === ref), condition: () => { throw new Error("no condition"); }, ids: (p: string) => `${p}_x`, now: "2026-10-04T00:00:00Z" };
  assert.throws(() => applyLocalizationAction(structuredClone(def), { op: "add_language", code: "zzzz" }, env), /is not a language code/, "and refused again if it ever got through");
  assert.match(run(def, [{ op: "add_language", code: "en" }]).errors[0], /source language/);
  assert.match(run(def, [{ op: "set_translations", language: "en", entries: [{ target: "Q2", text: "x" }] }]).errors[0], /source language — edit the question text itself/);
  const mx = run(def, [{ op: "add_language", code: "es", country: "MX" }]).def.localization!.languages[0];
  assert.equal(mx.locale, "es-MX", "the locale is picked from the library for the country");
  /* the Changes summary, and the order: translations listed before the language they need still work (localization runs last) */
  const summary = diffSurveys(def, out.def).summary;
  assert.ok(summary.includes("Add Deutsch as a language"), summary.join(" | "));
  assert.ok(summary.includes("Translate 12 elements into Deutsch"), summary.join(" | "));
  const reversed = run(def, [{ op: "set_translations", language: "es", status: "edited", entries: [{ target: "Q2", text: "¿Qué marca compró por última vez?" }] }, { op: "add_language", code: "es" }]);
  assert.deepEqual(reversed.errors, []);
  assert.equal(reversed.def.localization!.translations.es["q:q2:text"].status, "edited", "a human-edited status is kept through the gate");
  const newQ = run(def, [{ op: "set_translations", language: "de", entries: [{ target: "AGE", text: "Wie alt sind Sie?" }] }, { op: "add_language", code: "de" }, { op: "create_question", ref: "AGE", type: "number", text: "How old are you?" }]);
  assert.deepEqual(newQ.errors, [], "a translation of a question created in the same batch: the question first, then the language, then the translation");
  const ageId = newQ.def.questions.find((x) => x.variableName === "AGE")!.id;
  assert.equal(newQ.def.localization!.translations.de[`q:${ageId}:text`].text, "Wie alt sind Sie?");
  assert.equal(acts([{ op: "set_language_routing", merge: false }]).rejected.length, 1, "replacing with nothing changes nothing");
  const routed = run(def, [{ op: "set_language_routing", rules: [{ when: "REGION = 2", language: "de" }] }, { op: "add_language", code: "de" }, { op: "create_question", ref: "REGION", type: "single", text: "Region?", options: ["North", "South"] }]);
  assert.deepEqual(routed.errors, [], "a routing rule on a question created in the same batch: every language action runs after the structure");
  assert.equal(routed.def.localization!.routing.rules.length, 1);
  assert.equal(out.errors.length, 1); assert.match(out.errors[0], /set_translations: the survey has no \S+ \(fr\) version — add the language first \(add_language\)/);
  const loc = out.def.localization!;
  assert.deepEqual(loc.languages.map((l) => [l.code, l.locale, l.status]), [["de", "de-DE", "draft"]]);
  assert.deepEqual(out.def.deployment?.languages, ["en", "de"]);
  const de = loc.translations.de;
  assert.equal(de["q:q2:text"].text, "Welche Marke haben Sie zuletzt gekauft?");
  assert.equal(de["q:q2:text"].status, "ai"); assert.equal(de["q:q2:text"].origin, "ai");
  assert.equal(de["q:q2:opt:3"].text, "Keine davon", "an option by label");
  assert.equal(de["q:q3:text"].text, "Warum haben Sie {{BRAND}} gewählt?", "the pipe is kept");
  assert.equal(de["flow:e:message"].text, "Vielen Dank!");
  assert.equal(de["q:q4:row:r2"], undefined, "“Marke B” translates a do-not-translate brand name: refused");
  assert.ok(out.warnings.some((w) => /Q4 · row r2: “Brand B” is a term that is never translated/.test(w)), out.warnings.join("\n"));
  assert.ok(out.warnings.some((w) => /Q7: not a translatable element/.test(w)));
  assert.ok(out.warnings.some((w) => /Q4 · text \(de\): the glossary prefers “trust” → “vertrauen”/.test(w)), "a preferred term the translation did not use is a warning");
  assert.ok(out.results.find((r) => r.op === "set_translations" && r.ok)!.description.includes("12 translations written"));
  assert.ok(out.destructive.length === 0 && out.structureUnchanged === false, "translations change the definition but not its structure in any respondent-facing way other than language");
  /* the German survey reads German */
  const localized = localizeDefinition(out.def, "de");
  assert.equal(localized.questions[1].text, "Welche Marke haben Sie zuletzt gekauft?");
  assert.equal(localized.questions[1].options[2].label, "Keine davon");
  assert.equal(localized.questions[1].options[2].code, 3, "codes never change");
  /* approve = lock */
  const approved = run(out.def, [{ op: "approve_translations", language: "de", targets: ["Q2", "Q2.option:3"] }]);
  assert.equal(approved.def.localization!.translations.de["q:q2:text"].status, "approved");
  assert.equal(approved.def.localization!.translations.de["q:q2:instruction"].status, "ai", "only the named ones");
  const again = run(approved.def, [{ op: "set_translations", language: "de", entries: [{ target: "Q2", text: "Welche Marke kauften Sie zuletzt?" }, { target: "Q2.instruction", text: "Bitte eine auswählen" }] }]);
  assert.equal(again.def.localization!.translations.de["q:q2:text"].text, "Welche Marke haben Sie zuletzt gekauft?", "approved: kept");
  assert.equal(again.def.localization!.translations.de["q:q2:instruction"].text, "Bitte eine auswählen", "unapproved: replaced");
  assert.match(again.results[0].description, /1 translation written \(1 approved translation kept/);
  const edited = structuredClone(approved.def);
  edited.questions[1].text = "Which brand did you buy most recently?";
  const stale = run(edited, [{ op: "set_translations", language: "de", entries: [{ target: "Q2", text: "Welche Marke kauften Sie zuletzt?" }] }]);
  assert.equal(stale.def.localization!.translations.de["q:q2:text"].text, "Welche Marke kauften Sie zuletzt?", "an approved translation whose source changed is not locked against its re-translation");
  const forced = run(approved.def, [{ op: "set_translations", language: "de", overwriteApproved: true, entries: [{ target: "Q2", text: "Welche Marke kauften Sie zuletzt?" }] }]);
  assert.equal(forced.def.localization!.translations.de["q:q2:text"].text, "Welche Marke kauften Sie zuletzt?");
  assert.equal(forced.def.localization!.translations.de["q:q2:text"].status, "ai", "a new text is not approved by itself");
  /* a language with blocking issues cannot go live; a complete one can */
  const live = run(approved.def, [{ op: "set_language_status", code: "de", status: "live" }]);
  assert.match(live.errors[0], /cannot be live: \d+ blocking issues? — missing/);
  const dup = run(approved.def, [{ op: "set_translations", language: "de", entries: [{ target: "Q2.option:1", text: "Marke" }, { target: "Q2.option:2", text: "Marke" }] }]);
  assert.ok(dup.errors.length, "do-not-translate brands refuse the rename — and the duplicate rule would catch it anyway");
  /* the glossary: a term set twice is one term, removal is destructive */
  const gl = run(approved.def, [{ op: "set_glossary", entries: [{ source: "brand a", targets: { de: "Brand A" }, notes: "the client" }] }, { op: "set_glossary", remove: ["Brand B"] }]);
  assert.deepEqual(gl.def.localization!.glossary.map((g) => [g.source, g.doNotTranslate, g.targets.de ?? null]), [["Brand A", true, "Brand A"], ["trust", false, "vertrauen"]], "updated in place (case-insensitively), Brand B removed");
  assert.match(gl.destructive[0], /Removes 1 glossary term/);
  /* remove is destructive and takes the translations with it */
  const removed = run(approved.def, [{ op: "remove_language", code: "de" }]);
  assert.match(removed.destructive[0], /Removes the Deutsch version and its \d+ translations/);
  assert.equal(removed.def.localization!.translations.de, undefined);
  assert.deepEqual(removed.def.deployment?.languages, ["en"]);
});

test("a proposal that changes a translated question's wording marks its translations outdated and says so — the researcher is asked, not surprised", () => {
  const def = survey();
  const withDe = run(def, [{ op: "add_language", code: "de" }, { op: "set_translations", language: "de", entries: [{ target: "Q2", text: "Welche Marke haben Sie zuletzt gekauft?" }, { target: "Q2.option:3", text: "Keine davon" }, { target: "Q3", text: "Warum {{BRAND}}?" }] }]).def;
  const edit = run(withDe, [{ op: "update_question", target: "Q2", text: "Which brand did you buy most recently?" }]);
  assert.ok(edit.valid);
  assert.ok(edit.warnings.some((w) => /^1 translation is now outdated \(de\) — the source text changed/.test(w)), edit.warnings.join("\n"));
  const de = edit.def.localization!.translations.de;
  assert.equal(de["q:q2:text"].status, "outdated");
  assert.equal(de["q:q2:text"].text, "Welche Marke haben Sie zuletzt gekauft?", "the text is kept until re-translated");
  assert.equal(de["q:q2:opt:3"].status, "ai", "untouched elements are untouched");
  /* confirm: it still fits */
  const confirmed = run(edit.def, [{ op: "confirm_translations", language: "de" }]);
  assert.equal(confirmed.def.localization!.translations.de["q:q2:text"].status, "edited");
  assert.match(confirmed.results[0].description, /1 outdated translation confirmed/);
  assert.ok(diffSurveys(edit.def, confirmed.def).summary.includes("Confirm 1 outdated Deutsch translation"), "the Changes panel says what the confirmation is");
  /* the stale state may be only DETECTED, not stored — the source was edited in Studio, so no action marked the entry — and a confirmation is still a confirmation */
  const studioEdit = structuredClone(withDe);
  studioEdit.questions.find((q) => q.code === "Q2")!.text = "Which brand did you buy most recently?";
  assert.equal(studioEdit.localization!.translations.de["q:q2:text"].status, "ai", "nothing stored");
  assert.equal(lintLanguage(studioEdit, "de").issues.filter((i) => i.kind === "stale_source").length, 1, "but detected");
  const c2 = run(studioEdit, [{ op: "confirm_translations", language: "de" }]);
  assert.equal(c2.def.localization!.translations.de["q:q2:text"].status, "edited");
  assert.ok(diffSurveys(studioEdit, c2.def).summary.includes("Confirm 1 outdated Deutsch translation"), diffSurveys(studioEdit, c2.def).summary.join(" | "));
  assert.ok(!diffSurveys(studioEdit, c2.def).summary.some((l) => /^Translate|^Approve/.test(l)), "not counted as a translation or an approval");
  /* or re-translate */
  const re = run(edit.def, [{ op: "set_translations", language: "de", entries: [{ target: "Q2", text: "Welche Marke haben Sie zuletzt gekauft (neu)?" }] }]);
  assert.equal(re.def.localization!.translations.de["q:q2:text"].status, "ai");
  assert.equal(lintLanguage(re.def, "de").issues.filter((i) => i.kind === "stale_source").length, 0);
  /* the review reports it */
  const rv = reviewSurvey(edit.def);
  assert.ok(rv.findings.some((f) => f.category === "localization" && /Deutsch: 1 translation is outdated/.test(f.message)), rv.findings.map((f) => f.message).join("\n"));
  assert.ok(rv.findings.some((f) => f.category === "localization" && /Deutsch: \d+ elements have no translation/.test(f.message)));
  /* a translation with a lost pipe stored by hand is critical */
  edit.def.localization!.translations.de["q:q3:text"] = { ...edit.def.localization!.translations.de["q:q3:text"], text: "Warum diese Marke?" };
  assert.ok(reviewSurvey(edit.def).findings.some((f) => f.severity === "critical" && /lost or changed a piping token/.test(f.message)));
});

test("language routing in words: US → English, Mexico → Spanish, Germany → German; the URL parameter; a rule; the fallback — and the runtime follows it", () => {
  const def = survey();
  const out = run(def, [
    { op: "add_language", code: "es", locale: "es-MX" }, { op: "add_language", code: "de" },
    { op: "set_language_routing", countryMap: { US: "en", MX: "es" }, urlParam: "language", fallback: "en", allowSwitch: true, rules: [{ when: "COUNTRY = 3", language: "de", label: "German residents" }] },
    { op: "set_language_routing", countryMap: { DE: "de" }, rules: [{ when: "COUNTRY = 2", language: "es" }] },
    { op: "set_language_routing", countryMap: { FR: "fr" } },
    { op: "set_language_routing", order: ["url", "teleport"] },
  ]);
  assert.equal(out.errors.length, 1); assert.match(out.errors[0], /country FR names \S+ \(fr\), which the survey does not have/);
  assert.equal(acts([{ op: "set_language_routing", order: ["url", "teleport"] }]).rejected.length, 1);
  const r = out.def.localization!.routing;
  assert.deepEqual(r.countryMap, { US: "en", MX: "es", DE: "de" }, "a second country map merges into the first");
  assert.equal(r.urlParam, "language"); assert.equal(r.fallback, "en"); assert.equal(r.allowSwitch, true);
  assert.equal(r.rules.length, 2, "rules merge too"); assert.equal(r.rules[0].language, "de"); assert.equal(r.rules[0].when.type, "rule"); assert.equal(r.rules[1].language, "es");
  assert.ok(r.order.includes("country") && r.order.includes("rules"));
  assert.ok(r.order.indexOf("country") < r.order.indexOf("browser"), "country routing beats the browser's language");
  assert.ok(r.order.indexOf("rules") < r.order.indexOf("browser"), "so do the rules");
  const replaced = run(out.def, [{ op: "set_language_routing", merge: false, countryMap: { DE: "de" }, rules: [] }]).def.localization!.routing;
  assert.deepEqual(replaced.countryMap, { DE: "de" }, "merge: false replaces");
  const narrowed = run(out.def, [{ op: "set_language_routing", order: ["url", "browser"] }, { op: "set_language_routing", rules: [{ when: "COUNTRY = 1", language: "en" }] }]).def.localization!.routing;
  assert.deepEqual(narrowed.order, ["url", "rules", "browser"], "a rule added to an order without a rules step puts the step in, before the browser");
  assert.ok(out.warnings.some((w) => /Country routing was added to the precedence order/.test(w)));
  /* the runtime: drafts are not offered, so make them ready for the check */
  for (const l of out.def.localization!.languages) l.status = "ready";
  assert.equal(resolveLanguage(out.def, { country: "MX" }, true), "es");
  assert.equal(resolveLanguage(out.def, { urlParams: { language: "de" } }, true), "de");
  assert.equal(resolveLanguage(out.def, { country: "FR", browserLanguages: ["fr-FR"] }, true), "en", "nothing decides → the fallback");
  const rv = out.results.find((x) => x.op === "set_language_routing" && x.ok)!;
  assert.match(rv.description, /US → English, MX → Español/);
  assert.match(rv.description, /1 routing rule/);
});
