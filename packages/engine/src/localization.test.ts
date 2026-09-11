import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  translatableElements, localizeDefinition, resolveLanguage, offeredLanguages, lintLanguage, languageReady,
  recordTranslation, setTranslationStatus, audioFor, audioStale, applyGlossary, glossaryFor, textHash, uiText, uiStringsFor,
  translationRows, applyTranslationRows, formatNumber, formatDate, languageDirection, searchLanguages, K, LANGUAGE_VARIABLE,
  createResponseState, buildVariableDictionary, flattenVariables, validatePage, resolvePiping, compileFlow, evaluateCondition,
  effectiveLocalization,
} from "./index.js";

/**
 * LOCALIZATION — a layer over the survey, never a copy.
 *
 * What these tests hold: every id, code and condition of the localized
 * definition IS the source's; only text changes. Keys address elements by id
 * and code. Routing consults the sources in the configured order and only
 * ever yields a language the survey offers. QA blocks a language while
 * anything mandatory is missing or a placeholder is broken. Audio follows
 * the priority and goes stale when the words change.
 */

const base = () => SurveyDefinition.parse({
  meta: { id: "s1", code: "LOC", title: "Customer Satisfaction", version: "1.0" },
  branding: { buttons: { nextLabel: "Next", backLabel: "Back", submitLabel: "Submit" } },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "How was your visit to <b>Miures</b>?", instruction: "Pick one.", required: true,
      options: [{ code: 1, label: "Great" }, { code: 2, label: "Fine" }, { code: 3, label: "Poor" }, { code: 99, label: "Other", flags: ["other_specify"] }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "long_text", text: "Why do you say {{Q1}}?", validation: [{ kind: "min_length", value: 3, message: "Please write a little more." }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "matrix_single", text: "Rate each", rows: [{ code: "staff", label: "The staff" }, { code: "price", label: "The prices" }], options: [{ code: 1, label: "Good" }, { code: 2, label: "Bad" }] },
    { id: "q4", code: "Q4", variableName: "Q4", type: "numeric", text: "How many visits?", settings: { minValue: 0, maxValue: 50 } },
  ],
  flow: [
    { type: "page", id: "p1", title: "About your visit", questionIds: ["q1", "q2"] },
    { type: "page", id: "p2", questionIds: ["q3", "q4"], visibleIf: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "ne", value: 3 } },
    { type: "end", id: "e1", status: "complete", message: "Thanks, {{Q1}} it is." },
  ],
  localization: {
    sourceLanguage: "en",
    languages: [{ code: "hi", locale: "hi-IN", country: "IN", status: "draft" }, { code: "es", locale: "es-MX", status: "live" }, { code: "ar", status: "live" }],
    routing: { urlParam: "lang", embeddedField: "language", countryMap: { IN: "hi", MX: "es" }, order: ["url", "embedded", "country", "browser", "respondent"] },
    glossary: [{ id: "g1", source: "Miures", targets: {}, doNotTranslate: true }, { id: "g2", source: "Customer Satisfaction", targets: { hi: "ग्राहक संतुष्टि" } }],
  },
});

test("ELEMENTS: every respondent-facing string, by a key made of ids and codes — never of text", () => {
  const els = translatableElements(base());
  const keys = els.map((e) => e.key);
  assert.ok(keys.includes("meta:title"));
  assert.ok(keys.includes("q:q1:text") && keys.includes("q:q1:instruction"));
  assert.deepEqual(keys.filter((k) => k.startsWith("q:q1:opt:")), ["q:q1:opt:1", "q:q1:opt:2", "q:q1:opt:3", "q:q1:opt:99"]);
  assert.ok(keys.includes("q:q3:row:staff") && keys.includes("q:q3:opt:1"));
  assert.ok(keys.includes("q:q2:validation:0"), "a custom validation message is translatable");
  assert.ok(keys.includes("flow:p1:title") && keys.includes("flow:e1:message"));
  assert.ok(keys.includes("branding:buttons:next") && keys.includes("ui:required"));
  const q1 = els.find((e) => e.key === "q:q1:text")!;
  assert.equal(q1.source, "How was your visit to <b>Miures</b>?");
  assert.equal(q1.questionCode, "Q1");
  assert.equal(q1.mandatory, true);
  assert.equal(els.find((e) => e.key === "q:q2:validation:0")!.mandatory, false, "a custom message is optional — the English one still works");
});

test("LOCALIZE: the same survey in Hindi — ids, codes, logic, flow and settings identical; only text differs; source language returns the very object", () => {
  const def = base();
  let loc = effectiveLocalization(def);
  loc = recordTranslation(loc, "hi", "q:q1:text", "<b>Miures</b> की आपकी यात्रा कैसी रही?", "How was your visit to <b>Miures</b>?", { origin: "ai" });
  loc = recordTranslation(loc, "hi", "q:q1:opt:3", "ख़राब", "Poor", { origin: "manual" });
  loc = recordTranslation(loc, "hi", "q:q2:text", "आप {{Q1}} क्यों कहते हैं?", "Why do you say {{Q1}}?", { origin: "ai" });
  loc = recordTranslation(loc, "hi", "flow:e1:message", "धन्यवाद, {{Q1}} ही है।", "Thanks, {{Q1}} it is.", { origin: "ai" });
  loc = recordTranslation(loc, "hi", "branding:buttons:next", "आगे", "Next", { origin: "ai" });
  const d2 = { ...def, localization: loc };
  const hi = localizeDefinition(d2, "hi");
  assert.notEqual(hi, d2);
  assert.equal(localizeDefinition(d2, "en"), d2, "the source language is the definition itself");
  assert.equal(localizeDefinition(d2, "hi"), hi, "cached per (definition, language)");
  assert.equal(hi.questions[0].text, "<b>Miures</b> की आपकी यात्रा कैसी रही?");
  assert.equal(hi.questions[0].options[2].label, "ख़राब");
  assert.equal(hi.questions[0].options[2].code, 3, "the code is the code");
  assert.equal(hi.questions[0].options[1].label, "Fine", "an untranslated option falls back to the source");
  assert.equal(hi.questions[0].id, "q1");
  assert.deepEqual(hi.questions[0].options.map((o) => o.code), d2.questions[0].options.map((o) => o.code));
  assert.equal(hi.flow[1], d2.flow[1], "a flow node with no text is the same object — its visibleIf untouched");
  assert.equal(hi.questions[3].settings.maxValue, 50);
  assert.equal(hi.branding.buttons.nextLabel, "आगे");
  assert.equal(hi.branding.buttons.backLabel, "Back");
  // logic evaluates identically against the localized definition
  const state = createResponseState(hi);
  state.answers.q1 = 3;
  assert.equal(evaluateCondition((hi.flow[1] as unknown as { visibleIf: never }).visibleIf, { def: hi, state }), false);
  assert.equal(compileFlow(hi, state).length, compileFlow(d2, state).length, "same compiled flow");
  // piping resolves to the TRANSLATED label
  assert.equal(resolvePiping(hi.questions[1].text, { def: hi, state }), "आप ख़राब क्यों कहते हैं?");
  assert.equal(resolvePiping(d2.questions[1].text, { def: d2, state }), "Why do you say Poor?");
});

test("VERSIONING: each change keeps the previous text; approval is of a text and drops on edit", () => {
  let loc = effectiveLocalization(base());
  loc = recordTranslation(loc, "es", "q:q1:opt:1", "Genial", "Great", { origin: "ai", now: "2026-09-10T10:00:00Z" });
  assert.equal(loc.translations.es["q:q1:opt:1"].status, "ai");
  assert.equal(loc.translations.es["q:q1:opt:1"].version, 1);
  loc = setTranslationStatus(loc, "es", "q:q1:opt:1", "approved", "ana");
  assert.equal(loc.translations.es["q:q1:opt:1"].status, "approved");
  assert.equal(loc.translations.es["q:q1:opt:1"].reviewedBy, "ana");
  loc = recordTranslation(loc, "es", "q:q1:opt:1", "Excelente", "Great", { origin: "manual", by: "luis", now: "2026-09-10T11:00:00Z" });
  const e = loc.translations.es["q:q1:opt:1"];
  assert.equal(e.text, "Excelente");
  assert.equal(e.version, 2);
  assert.equal(e.status, "edited", "an edit to an approved text is no longer approved");
  assert.equal(e.history[0].text, "Genial");
  assert.equal(e.history[0].version, 1);
  assert.equal(e.updatedBy, "luis");
  assert.equal(e.sourceHash, textHash("Great"));
});

test("ROUTING: url → embedded → country → browser in the configured order; only offered languages; drafts only in preview; explicit choice wins", () => {
  const def = base();
  assert.deepEqual(offeredLanguages(def), ["en", "es", "ar"], "hi is a draft — not offered live");
  assert.deepEqual(offeredLanguages(def, true), ["en", "hi", "es", "ar"]);
  assert.equal(resolveLanguage(def, { urlParams: { lang: "es" } }), "es");
  assert.equal(resolveLanguage(def, { urlParams: { lang: "es-419" } }), "es", "a regional tag matches its language");
  assert.equal(resolveLanguage(def, { urlParams: { lang: "hi" } }), "en", "a draft language is not served live…");
  assert.equal(resolveLanguage(def, { urlParams: { lang: "hi" } }, true), "hi", "…but a preview may show it");
  assert.equal(resolveLanguage(def, { embedded: { language: "ar" } }), "ar");
  assert.equal(resolveLanguage(def, { embedded: { country: "MX" } }), "es", "country map");
  assert.equal(resolveLanguage(def, { browserLanguages: ["fr-FR", "ar-EG"] }), "ar");
  assert.equal(resolveLanguage(def, { browserLanguages: ["fr-FR"] }), "en", "nothing matched → the source");
  assert.equal(resolveLanguage(def, { urlParams: { lang: "es" }, chosen: "ar" }), "ar", "the respondent's own choice wins");
  assert.equal(resolveLanguage(def, { urlParams: { lang: "xx" }, browserLanguages: ["es"] }), "es", "an unknown url value falls through to the next source");
});

test("SURVEY_LANGUAGE is one dictionary variable with the language codes as categories; stored in embedded data; exported and flattened", () => {
  const def = base();
  const v = buildVariableDictionary(def).find((x) => x.name === LANGUAGE_VARIABLE)!;
  assert.ok(v);
  assert.deepEqual(v.valueCodes, ["en", "hi", "es", "ar"]);
  assert.equal(v.responseType, "embedded_data");
  const state = createResponseState(def);
  state.embedded.SURVEY_LANGUAGE = "es";
  assert.equal(flattenVariables(def, state).SURVEY_LANGUAGE, "es");
  assert.equal(buildVariableDictionary(SurveyDefinition.parse({ ...def, localization: undefined })).some((x) => x.name === LANGUAGE_VARIABLE), false, "a single-language survey has no such column");
});

test("QA: missing mandatory text blocks readiness; broken piping blocks; identical-to-source warns; duplicates block; stale source flags; ready once fixed", () => {
  const def = base();
  let r = lintLanguage(def, "es");
  assert.equal(r.ready, false);
  assert.ok(r.missing > 0);
  assert.equal(r.completion, 0);
  let loc = effectiveLocalization(def);
  for (const el of translatableElements(def)) {
    if (!el.mandatory) continue;
    loc = recordTranslation(loc, "es", el.key, `[es] ${el.source}`, el.source, { origin: "ai" });
  }
  let d2 = { ...def, localization: loc };
  r = lintLanguage(d2, "es");
  assert.equal(r.missing, 0);
  assert.equal(r.completion, 100);
  assert.equal(r.ready, true, "AI translations, unreviewed, still count as complete");
  assert.ok(r.issues.some((i) => i.kind === "not_approved"), "…but are flagged as not reviewed");
  // break the piping
  loc = recordTranslation(loc, "es", "q:q2:text", "¿Por qué dice eso?", "Why do you say {{Q1}}?", { origin: "manual" });
  d2 = { ...def, localization: loc };
  r = lintLanguage(d2, "es");
  assert.ok(r.issues.some((i) => i.kind === "placeholder_mismatch" && i.blocking));
  assert.equal(r.ready, false);
  // two options with the same translation
  loc = recordTranslation(loc, "es", "q:q2:text", "¿Por qué dice {{Q1}}?", "Why do you say {{Q1}}?", { origin: "manual" });
  loc = recordTranslation(loc, "es", "q:q1:opt:1", "Bien", "Great", { origin: "manual" });
  loc = recordTranslation(loc, "es", "q:q1:opt:2", "Bien", "Fine", { origin: "manual" });
  d2 = { ...def, localization: loc };
  r = lintLanguage(d2, "es");
  assert.ok(r.issues.some((i) => i.kind === "duplicate" && i.blocking));
  loc = recordTranslation(loc, "es", "q:q1:opt:2", "Regular", "Fine", { origin: "manual" });
  // left in English
  loc = recordTranslation(loc, "es", "q:q1:opt:3", "Poor", "Poor", { origin: "manual" });
  d2 = { ...def, localization: loc };
  r = lintLanguage(d2, "es");
  assert.ok(r.issues.some((i) => i.kind === "untranslated" && i.key === "q:q1:opt:3" && !i.blocking));
  assert.equal(r.ready, true);
  // the source changes underneath
  const d3 = { ...d2, questions: d2.questions.map((q) => (q.id === "q1" ? { ...q, text: "How was your LAST visit to <b>Miures</b>?" } : q)) };
  r = lintLanguage(d3, "es");
  assert.ok(r.issues.some((i) => i.kind === "stale_source" && i.key === "q:q1:text" && i.blocking));
  assert.equal(languageReady(d3, "es"), false);
  assert.equal(lintLanguage(def, "en").ready, true, "the source language is always ready");
});

test("GLOSSARY: preferred terms are enforced on a translation, whole words only, piping and tags untouched; do-not-translate keeps the term", () => {
  const loc = effectiveLocalization(base());
  const hi = glossaryFor(loc, "hi");
  assert.deepEqual(hi.map((g) => [g.source, g.target]), [["Miures", "Miures"], ["Customer Satisfaction", "ग्राहक संतुष्टि"]]);
  assert.equal(applyGlossary("Customer Satisfaction survey about {{Q1}} <b>Customer Satisfaction</b>", hi), "ग्राहक संतुष्टि survey about {{Q1}} <b>ग्राहक संतुष्टि</b>");
  assert.equal(applyGlossary("customer satisfactions", hi), "customer satisfactions", "not inside another word");
  assert.equal(applyGlossary("MIURES rocks", hi), "MIURES rocks", "a do-not-translate term is left exactly as it is");
});

test("AUDIO: the priority decides — human over approved AI over URL; unapproved AI never plays; stale when the words changed", () => {
  const def = base();
  const loc = effectiveLocalization(def);
  const t = recordTranslation(loc, "hi", "q:q1:text", "आपकी यात्रा कैसी रही?", "How was your visit to <b>Miures</b>?", { origin: "manual" });
  const d2 = { ...def, localization: { ...t, audio: [
    { id: "a1", elementKey: "q:q1:text", language: "hi", kind: "url" as const, url: "https://cdn/x.mp3", version: 1, approved: true, textHash: textHash("आपकी यात्रा कैसी रही?") },
    { id: "a2", elementKey: "q:q1:text", language: "hi", kind: "ai" as const, url: "https://cdn/ai.mp3", version: 1, approved: false, textHash: textHash("आपकी यात्रा कैसी रही?") },
  ] } };
  assert.equal(audioFor(d2, "q:q1:text", "hi")?.id, "a1", "unapproved AI is skipped; the URL plays");
  const d3 = { ...d2, localization: { ...d2.localization, audio: d2.localization.audio.map((a) => (a.id === "a2" ? { ...a, approved: true } : a)) } };
  assert.equal(audioFor(d3, "q:q1:text", "hi")?.id, "a2", "approved AI outranks a URL");
  const d4 = { ...d3, localization: { ...d3.localization, audio: [...d3.localization.audio, { id: "a3", elementKey: "q:q1:text", language: "hi", kind: "human" as const, url: "blob:h", version: 1, approved: true, textHash: textHash("आपकी यात्रा कैसी रही?") }] } };
  assert.equal(audioFor(d4, "q:q1:text", "hi")?.id, "a3", "a human recording outranks everything");
  assert.equal(audioFor(d4, "q:q1:text", "es"), null);
  assert.equal(audioStale(d4, d4.localization.audio[2]), false);
  const d5 = { ...d4, localization: recordTranslation(d4.localization, "hi", "q:q1:text", "कृपया बताएं, आपकी यात्रा कैसी रही?", "How was your visit to <b>Miures</b>?", { origin: "manual" }) };
  assert.equal(audioStale(d5, d5.localization.audio[2]), true, "the words changed → the recording is outdated");
  assert.ok(lintLanguage(d5, "hi").issues.some((i) => i.kind === "audio_stale"));
  const d6 = { ...d4, localization: { ...d4.localization, audioPriority: ["url" as const, "human" as const] } };
  assert.equal(audioFor(d6, "q:q1:text", "hi")?.id, "a1", "the programmer's priority order is obeyed");
});

test("UI STRINGS: validation speaks the respondent's language; parameters filled after translation", () => {
  const def = base();
  const loc = recordTranslation(recordTranslation(effectiveLocalization(def), "es", "ui:required", "Esta pregunta es obligatoria.", "This question is required.", { origin: "manual" }), "es", "ui:max_value", "El valor debe ser como máximo {max}.", "Value must be at most {max}.", { origin: "manual" });
  const d2 = { ...def, localization: loc };
  const ui = uiStringsFor(d2, "es");
  assert.equal(ui.required, "Esta pregunta es obligatoria.");
  assert.equal(ui.min_value, "Value must be at least {min}.", "an untranslated string keeps its English default");
  const state = createResponseState(d2);
  state.answers.q4 = 99;
  const errs = validatePage(d2, [d2.questions[0], d2.questions[3]], { def: d2, state, ui });
  assert.deepEqual(errs.map((e) => e.message).sort(), ["El valor debe ser como máximo 50.", "Esta pregunta es obligatoria."]);
  assert.equal(validatePage(d2, [d2.questions[0]], { def: d2, state })[0].message, "This question is required.", "no ui → English, exactly as before");
  assert.equal(uiText(undefined, "page_of", { n: 2, total: 5 }), "Page 2 of 5");
});

test("IMPORT / EXPORT: rows carry element key, question, source, translation, status and audio; re-import applies only rows whose key still exists", () => {
  const def = base();
  const rows = translationRows(def, ["es"]);
  assert.ok(rows.length > 10);
  const r = rows.find((x) => x.elementKey === "q:q1:opt:1")!;
  assert.deepEqual([r.questionCode, r.sourceLanguage, r.targetLanguage, r.sourceText, r.translation, r.status], ["Q1", "en", "es", "Great", "", "not_translated"]);
  const res = applyTranslationRows(def, [
    { elementKey: "q:q1:opt:1", targetLanguage: "es", translation: "Genial", status: "reviewed" },
    { elementKey: "q:q1:opt:2", targetLanguage: "es", translation: "" },
    { elementKey: "q:gone:opt:1", targetLanguage: "es", translation: "x" },
    { elementKey: "q:q1:text", targetLanguage: "pt", translation: "Como foi a sua visita?", audioUrl: "https://cdn/pt.mp3" },
  ], "importer");
  assert.equal(res.applied, 2);
  assert.equal(res.skipped, 2);
  assert.equal(res.localization.translations.es["q:q1:opt:1"].status, "reviewed");
  assert.equal(res.localization.translations.es["q:q1:opt:1"].origin, "import");
  assert.ok(res.localization.languages.some((l) => l.code === "pt"), "a new language in the file is added as a draft");
  assert.equal(res.localization.audio.find((a) => a.language === "pt")?.kind, "url");
});

test("FORMATTING and DIRECTION follow the locale; the library is searchable by country", () => {
  assert.equal(formatNumber(1234567.891, { locale: "en-IN" }), "12,34,567.89");
  assert.equal(formatNumber(1234.5, { locale: "de-DE" }), "1.234,5");
  assert.equal(formatNumber(1234.5, { locale: "en-US", decimal: ",", thousands: "." }), "1.234,5", "a study's own separators override the locale's");
  assert.equal(formatDate("2026-09-10T12:00:00Z", { locale: "en-GB", datePattern: "dd/MM/yyyy" }), "10/09/2026");
  assert.equal(languageDirection("ar"), "rtl");
  assert.equal(languageDirection("ur"), "rtl");
  assert.equal(languageDirection("hi"), "ltr");
  assert.equal(languageDirection("hi", { code: "hi", direction: "rtl", status: "draft", enabled: true, format: {} }), "rtl", "a configured direction wins");
  assert.ok(searchLanguages("india").some((l) => l.code === "gu") && searchLanguages("india").some((l) => l.code === "ta"));
  assert.ok(searchLanguages("taiwan").some((l) => l.code === "zh"));
  assert.deepEqual(searchLanguages("Gujarati").map((l) => l.code), ["gu"]);
  assert.ok(K.opt("q1", 2) === "q:q1:opt:2");
});
