import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  placeholdersIn, placeholderMismatch, scriptOf, expectedScripts, wrongScript, translationProblem, lintLanguage, effectiveLocalization, recordTranslation, textHash,
  orphanedTranslations, pruneOrphanedTranslations, translationImpact, moveTranslationKey, movedTranslationKeys, applySurveyActions, coerceSurveyActions, changeItems, diffSurveys, K,
} from "./index.js";

/*
 * TRANSLATION INTELLIGENCE, PHASE 6 (audit R19): one placeholder grammar for
 * the lint, the write-time refusal and the provider path — `{label}` closed,
 * question codes kept; a translation in the wrong script refused; the
 * translations of removed elements pruned (and a recode's moved, not lost);
 * and the impact of a change on the translations as a report, element by
 * element, instead of a count.
 */

test("placeholdersIn — pipes, ${…}, [[…]], every {word} parameter, and the question codes the text names; in order, never overlapping", () => {
  const src = "Hello ${first_name}, why {{ Q1.label|and }} about {label}? See Q7.R1 and [[loop.item]] (Q12).";
  const ps = placeholdersIn(src);
  assert.deepEqual(ps.map((p) => [p.kind, p.text]), [["variable", "${first_name}"], ["pipe", "{{ Q1.label|and }}"], ["parameter", "{label}"], ["code", "Q7.R1"], ["loop", "[[loop.item]]"], ["code", "Q12"]]);
  assert.equal(ps[1].key, "{{Q1.label|and}}", "whitespace inside a token is not part of it");
  assert.equal(ps[1].pipe?.ref, "Q1", "a pipe is read with the piping grammar");
  assert.equal(src.slice(ps[3].start, ps[3].end), "Q7.R1");
  assert.deepEqual(placeholdersIn("{{n}} of {n}").map((p) => p.kind), ["pipe", "parameter"], "a pipe before a parameter");
  assert.deepEqual(placeholdersIn("Q7.R1.C1, then S2 and QS3b").map((p) => p.text), ["Q7.R1.C1", "S2", "QS3b"]);
  assert.deepEqual(placeholdersIn("COVID19, B2B, iPhone15, MP3s, 4K and Q7.").map((p) => p.text), ["Q7"], "a code never starts or ends inside a word; the full stop is the sentence's");
  assert.deepEqual(placeholdersIn("{{Q1}}").map((p) => p.kind), ["pipe"], "the code inside a pipe is the pipe's");
  assert.deepEqual(placeholdersIn("See Q7", { codes: false }), []);
});

test("placeholderMismatch — the tokens must be the same multiset; a source code must survive, an extra one is allowed", () => {
  assert.equal(placeholderMismatch("“{label}” cannot be selected together", "„{label}“ kann nicht zusammen gewählt werden"), null);
  assert.deepEqual(placeholderMismatch("“{label}” cannot be selected together", "Kann nicht zusammen gewählt werden")!.missing, ["{label}"]);
  assert.deepEqual(placeholderMismatch("You said {{Q1}}", "Sie sagten {{Q1}} {{Q1}}")!.extra, ["{{Q1}}"]);
  assert.deepEqual(placeholderMismatch("As in Q7, rate Q7.R1", "Wie in Frage 7, bewerten Sie")!.missing.sort(), ["Q7", "Q7.R1"]);
  assert.equal(placeholderMismatch("Rate it", "Bewerten Sie es (Q7)"), null, "a code the source never had is not refused");
  assert.equal(placeholderMismatch("{{ Q1 }} and {n}", "{n} und {{Q1}}"), null, "order and spacing do not matter");
});

test("scripts — the script a text is written in, and the scripts a language uses", () => {
  assert.equal(scriptOf("Насколько вы довольны?"), "Cyrillic");
  assert.equal(scriptOf("どのくらい満足していますか"), "Kana");
  assert.equal(scriptOf("आप कितने संतुष्ट हैं"), "Devanagari");
  assert.equal(scriptOf("123 — !"), null);
  assert.deepEqual(expectedScripts("ru"), ["Cyrillic"]);
  assert.deepEqual(expectedScripts("ja-JP"), ["Kana", "Han"]);
  assert.deepEqual(expectedScripts("pt-BR"), ["Latin"]);
  assert.deepEqual(expectedScripts("sr"), ["Cyrillic", "Latin"]);
  assert.equal(expectedScripts("tlh"), null, "an unknown language is not judged");
});

test("translationProblem — refuses a dropped {label}, a lost question code, and a translation in the wrong script; keeps brand names and placeholders out of the count", () => {
  const exclusive = "“{label}” cannot be selected together with other answers.";
  assert.match(translationProblem(exclusive, "Diese Antwort kann nicht mit anderen kombiniert werden.", [], "de")!, /piping \/ placeholders must be kept exactly — the source has \{label\}, the translation has none \(\{label\} is missing\)/);
  assert.equal(translationProblem(exclusive, "„{label}“ kann nicht zusammen mit anderen Antworten gewählt werden.", [], "de"), null);
  assert.match(translationProblem("As in Q7, how satisfied are you?", "Wie bei der vorigen Frage: wie zufrieden sind Sie?", [], "de")!, /Q7 is missing/);
  /* the wrong script */
  assert.match(translationProblem("How satisfied are you with Miures?", "How satisfied are you with Miures?", [], "ru")!, /^the translation is written in Latin script, but Русский is written in Cyrillic — 100% of its letters are not/);
  assert.match(translationProblem("How satisfied are you?", "Kak vy dovol'ny?", [], "ru")!, /Latin script/, "transliterated Russian");
  assert.match(translationProblem("How satisfied are you?", "Anata wa dono kurai manzoku shite imasu ka?", [], "ja")!, /Kana \/ Han/, "Japanese with no kana or kanji");
  assert.match(translationProblem("How satisfied are you?", "Aap kitne santusht hain?", [], "hi")!, /Devanagari/, "Hindi in Latin letters");
  assert.equal(translationProblem("How satisfied are you with Miures?", "Насколько вы довольны Miures?", [], "ru"), null, "a brand name copied from the source is not Russian in Latin");
  assert.equal(translationProblem("Miuresにどのくらい満足していますか？", "Miuresにどのくらい満足していますか？", [], "ja"), null);
  assert.equal(translationProblem("Do you own an iPhone Pro Max?", "У вас есть iPhone Pro Max?", [], "ru"), null);
  const dnt = [{ id: "g", source: "Brand Alpha Plus", targets: {}, scope: "project" as const, caseSensitive: false, doNotTranslate: true }];
  assert.equal(translationProblem("Rate Brand Alpha Plus", "Оцените Brand Alpha Plus", dnt, "ru"), null);
  assert.equal(translationProblem("Hello {{Q1}}", "Привет {{Q1}}", [], "ru"), null, "a pipe's letters are not counted");
  assert.equal(translationProblem("OK", "OK", [], "ru"), null, "fewer than 4 letters cannot be judged");
  assert.equal(translationProblem("This question is required.", "Diese Frage ist erforderlich.", [], "de"), null);
});

function multi() {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Countries", version: "1.0" },
    questions: [
      { id: "q7", code: "Q7", variableName: "COUNTRY", type: "single_select", text: "Where do you live?", options: [{ code: 1, label: "Germany" }, { code: 2, label: "France" }, { code: 3, label: "Spain" }, { code: 4, label: "United States" }] },
      { id: "q8", code: "Q8", variableName: "WHY", type: "open_text", text: "Why?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q7", "q8"] }, { type: "end", id: "e", status: "complete" }],
    localization: { sourceLanguage: "en", languages: [{ code: "de", status: "draft" }, { code: "es", status: "draft" }] },
  });
}
function translate(def: SurveyDefinition, lang: string, entries: Record<string, string>, status: "ai" | "approved" = "ai") {
  let loc = effectiveLocalization(def);
  const src: Record<string, string> = { "q:q7:text": "Where do you live?", "q:q7:opt:1": "Germany", "q:q7:opt:2": "France", "q:q7:opt:3": "Spain", "q:q7:opt:4": "United States", "q:q8:text": "Why?" };
  for (const [k, v] of Object.entries(entries)) loc = recordTranslation(loc, lang, k, v, src[k] ?? v, { origin: "ai", status });
  return { ...def, localization: loc } as SurveyDefinition;
}

test("lintLanguage — reports a dropped {label} as placeholder_mismatch, a wrong script as wrong_script (not blocking), and stops counting orphans", () => {
  let def = multi();
  def = translate(def, "de", { "q:q7:text": "Wo wohnen Sie?" });
  let loc = effectiveLocalization(def);
  loc = recordTranslation(loc, "de", K.ui("exclusive_option"), "Diese Antwort kann nicht kombiniert werden.", "“{label}” cannot be selected together with other answers.", { origin: "manual" });
  loc = recordTranslation(loc, "de", "q:q8:text", "Why?", "Why?", { origin: "manual" });
  loc = recordTranslation(loc, "de", "q:q99:text", "Weg", "Gone", { origin: "manual" });
  def = { ...def, localization: loc } as SurveyDefinition;
  const r = lintLanguage(def, "de");
  const ph = r.issues.find((i) => i.kind === "placeholder_mismatch")!;
  assert.equal(ph.key, "ui:exclusive_option");
  assert.ok(ph.blocking);
  assert.match(ph.message, /source has \{label\}, translation has none \(missing \{label\}\)/);
  assert.equal(r.orphaned, 1, "the translation of a deleted question is counted as an orphan, nowhere else");
  assert.ok(!r.issues.some((i) => i.key === "q:q99:text"));
  /* Russian in Latin letters */
  let ru = { ...multi(), localization: { ...effectiveLocalization(multi()), languages: [{ code: "ru", status: "draft", enabled: true, format: {} }] } } as SurveyDefinition;
  ru = translate(ru, "ru", { "q:q7:text": "Gde vy zhivete?" });
  const w = lintLanguage(ru, "ru").issues.find((i) => i.kind === "wrong_script")!;
  assert.equal(w.blocking, false);
  assert.match(w.message, /^Written in Latin script — Русский is written in Cyrillic/);
});

test("orphaned translations — listed per language, pruned by every batch with a warning; a recode moves its option's translations (status kept)", () => {
  let def = translate(multi(), "de", { "q:q7:text": "Wo wohnen Sie?", "q:q7:opt:3": "Spanien", "q:q7:opt:4": "Vereinigte Staaten", "q:q8:text": "Warum?" }, "approved");
  def = translate(def, "es", { "q:q7:opt:3": "España" });
  /* an option removed in the Studio, outside any action: orphans */
  const edited = structuredClone(def); edited.questions[0].options = edited.questions[0].options.filter((o) => o.code !== 3);
  assert.deepEqual(orphanedTranslations(edited), [{ language: "de", keys: ["q:q7:opt:3"] }, { language: "es", keys: ["q:q7:opt:3"] }]);
  const p = pruneOrphanedTranslations(structuredClone(edited));
  assert.deepEqual([p.dropped, p.moved, p.languages], [2, 0, ["de", "es"]]);
  /* through the actions: removing the option drops its translations and says so */
  const out = applySurveyActions(def, coerceSurveyActions([{ op: "update_question", target: "Q7", removeOptions: [3] }]).actions);
  assert.ok(out.valid, out.errors.join());
  assert.ok(out.warnings.includes("2 translations (de, es) of removed elements were dropped."), out.warnings.join(" | "));
  assert.equal(out.def.localization!.translations.de["q:q7:opt:3"], undefined);
  assert.deepEqual(orphanedTranslations(out.def), []);
  /* a recode MOVES the translation: same text, same approved status, under the new key */
  const rc = applySurveyActions(def, coerceSurveyActions([{ op: "update_option", target: "Q7", option: 4, code: 9 }]).actions);
  assert.ok(rc.valid, rc.errors.join());
  const moved = rc.def.localization!.translations.de["q:q7:opt:9"];
  assert.deepEqual([moved?.text, moved?.status], ["Vereinigte Staaten", "approved"]);
  assert.equal(rc.def.localization!.translations.de["q:q7:opt:4"], undefined);
  assert.ok(!rc.warnings.some((w) => /dropped/.test(w)), "nothing was dropped");
  assert.ok(rc.results[0].destructive && /1 translation moved with it/.test(rc.results[0].destructive), rc.results[0].destructive);
  assert.ok(!diffSurveys(def, rc.def).summary.some((l) => /Translate/.test(l)), "a moved translation is not a new one");
  /* a recode made outside the action (an option list rebuilt) is rescued by the source hash */
  const rebuilt = structuredClone(def); rebuilt.questions[0].options[3].code = 7;
  const r2 = pruneOrphanedTranslations(rebuilt);
  assert.deepEqual([r2.dropped, r2.moved], [0, 1]);
  assert.equal(rebuilt.localization!.translations.de["q:q7:opt:7"].status, "approved");
});

test("translationImpact — per language: outdated, new elements to translate, dropped, moved, kept — in words, with a one-line summary; the Changes row lists the elements", () => {
  const before = translate(multi(), "de", { "q:q7:text": "Wo wohnen Sie?", "q:q7:opt:1": "Deutschland", "q:q7:opt:2": "Frankreich", "q:q7:opt:3": "Spanien", "q:q7:opt:4": "Vereinigte Staaten", "q:q8:text": "Warum?" });
  const out = applySurveyActions(before, coerceSurveyActions([
    { op: "update_question", target: "Q7", text: "In which country do you live?", removeOptions: [3], addOptions: [{ label: "Italy" }] },
    { op: "update_option", target: "Q7", option: 2, code: 20 },
  ]).actions);
  assert.ok(out.valid, out.errors.join());
  const imp = translationImpact(before, out.def);
  const de = imp.languages.find((l) => l.language === "de")!;
  assert.deepEqual(de.outdated.map((e) => e.element), ["Q7 text"]);
  assert.deepEqual(de.missing.map((e) => e.element), ["Q7 option 5 — Italy"]);
  assert.deepEqual(de.dropped.map((e) => e.element), ["Q7 option 3 — Spain"]);
  assert.deepEqual(de.moved.map((m) => [m.from, m.to, m.element]), [["q:q7:opt:2", "q:q7:opt:20", "Q7 option 20 — France"]]);
  assert.equal(de.kept, 4, "opt 1, opt 4, the moved opt 20, Q8");
  assert.equal(de.sentence, "1 Deutsch translation becomes outdated, 1 new element needs Deutsch, 1 Deutsch translation is dropped with its element, 1 follows its option's new code.");
  assert.equal(imp.summary, "Deutsch: 1 outdated, 1 to translate, 1 dropped, 1 moved");
  assert.deepEqual([imp.outdated, imp.missing, imp.dropped], [1, 1, 0 + 1]);
  /* a language nobody started is all missing anyway: no noise */
  assert.equal(imp.languages.find((l) => l.language === "es")!.missing.length, 0);
  assert.equal(translationImpact(before, before).summary, "No translation is affected.");
  /* the Changes review: one Translation row per language, with the counts and the elements */
  const row = changeItems(before, out.def).items.find((i) => i.category === "Translation" && i.field === "Deutsch translations")!;
  assert.equal(row.to, "1 outdated, 1 to translate, 1 dropped, 1 moved with a recode");
  assert.equal(row.detail, "Outdated: Q7 text · To translate: Q7 option 5 — Italy · Dropped: Q7 option 3 — Spain · Moved: Q7 option 20 — France");
  assert.ok((row.technical as { impact?: unknown }).impact);
  void textHash;
});

/* ------------------------------------------------------------ mutation-checked edges (Phase 6) */

test("wrongScript — the thresholds: 60% of at least 4 letters; 60% exactly is wrong, 56% is not; 4 letters can be judged, 3 cannot", () => {
  const at60 = wrongScript("abc", "да abc", "ru")!;
  assert.deepEqual([at60.script, at60.letters, at60.share], ["Latin", 5, 0.6], "3 of 5 letters out of place: at the threshold, refused");
  assert.equal(wrongScript("hello", "дада hello", "ru"), null, "5 of 9 (56%) is under the threshold");
  assert.equal(wrongScript("x", "hello", "ru")!.letters, 5, "5 letters are enough to judge");
  assert.equal(wrongScript("x", "abcd", "ru")!.letters, 4, "4 letters are enough to judge");
  assert.equal(wrongScript("x", "yes", "ru"), null, "3 letters are not");
});

test("wrongScript — what is not counted: a name with a capital inside it (iPhone, macOS), a lower-case do-not-translate term, the letters inside tokens", () => {
  assert.equal(translationProblem("Do you use iPhone, iPad or macOS?", "Вы iPhone, iPad или macOS?", [], "ru"), null, "names copied from the source are not Russian in Latin");
  const dnt = [{ id: "g", source: "easyjet club", targets: {}, scope: "project" as const, caseSensitive: false, doNotTranslate: true }];
  assert.equal(translationProblem("Join easyjet club today", "Вход easyjet club", dnt, "ru"), null, "a do-not-translate term is kept as written");
  assert.match(translationProblem("Join easyjet club today", "Вход easyjet club", [], "ru")!, /Latin script/, "…which it is only when the glossary says so");
  assert.equal(translationProblem("Hello ${first_name}, see [[loop.item]]", "Да ${first_name}, [[loop.item]]", [], "ru"), null, "a token's letters are not the translation's");
  /* the lint keeps the glossary's do-not-translate terms out of the count too */
  let ru = { ...multi(), localization: { ...effectiveLocalization(multi()), languages: [{ code: "ru", status: "draft", enabled: true, format: {} }], glossary: dnt } } as SurveyDefinition;
  ru = translate(ru, "ru", { "q:q8:text": "Почему easyjet club?" });
  assert.ok(!lintLanguage(ru, "ru").issues.some((i) => i.kind === "wrong_script"), JSON.stringify(lintLanguage(ru, "ru").issues.filter((i) => i.kind === "wrong_script")));
  const bare = { ...ru, localization: { ...ru.localization!, glossary: [] } } as SurveyDefinition;
  assert.ok(lintLanguage(bare, "ru").issues.some((i) => i.kind === "wrong_script" && i.key === "q:q8:text"));
});

test("orphans — edges: the source language's table is not judged; a move never overwrites a translation already there; a move needs the same source hash; two candidates are no rescue", () => {
  let loc = effectiveLocalization(multi());
  loc = recordTranslation(loc, "en", "q:q99:text", "Gone", "Gone", { origin: "manual" });
  loc = recordTranslation(loc, "de", "q:q7:opt:3", "Spanien", "Spain", { origin: "ai", status: "approved" });
  loc = recordTranslation(loc, "de", "q:q7:opt:4", "Vereinigte Staaten", "United States", { origin: "ai", status: "approved" });
  const def = { ...multi(), localization: loc } as SurveyDefinition;
  assert.deepEqual(orphanedTranslations(def), [], "the source language's own table is not a translation");
  /* a move onto a key that holds a translation keeps that translation */
  const mv = structuredClone(def);
  assert.equal(moveTranslationKey(mv, K.opt("q7", 3), K.opt("q7", 4)), 0);
  assert.equal(mv.localization!.translations.de["q:q7:opt:4"].text, "Vereinigte Staaten");
  /* the same words for a different source are not a move */
  const before = { "q:q7:opt:3": def.localization!.translations.de["q:q7:opt:3"] };
  const same = { "q:q7:opt:9": { ...before["q:q7:opt:3"] } };
  const other = { "q:q7:opt:9": { ...before["q:q7:opt:3"], sourceHash: textHash("Spain (mainland)") } };
  assert.deepEqual([...movedTranslationKeys(before, same)], [["q:q7:opt:9", "q:q7:opt:3"]]);
  assert.deepEqual([...movedTranslationKeys(before, other)], [], "same text, another source: a new translation, not a moved one");
  /* an orphan whose hash fits TWO untranslated options of its question is dropped, not guessed */
  const twin = structuredClone(def);
  twin.questions[0].options[3].code = 7;
  twin.questions[0].options.push({ ...twin.questions[0].options[3], code: 8 });
  const r = pruneOrphanedTranslations(twin);
  assert.deepEqual([r.dropped, r.moved], [1, 0]);
  assert.equal(twin.localization!.translations.de["q:q7:opt:7"], undefined);
});

test("a recode moves an option's image text too", () => {
  const def = multi();
  def.questions[0].options[3] = { ...def.questions[0].options[3], imageAlt: "The US flag" } as never;
  let loc = effectiveLocalization(def);
  loc = recordTranslation(loc, "de", "q:q7:opt:4", "Vereinigte Staaten", "United States", { origin: "ai", status: "approved" });
  loc = recordTranslation(loc, "de", K.optAlt("q7", 4), "Die US-Flagge", "The US flag", { origin: "ai", status: "approved" });
  const rc = applySurveyActions({ ...def, localization: loc } as SurveyDefinition, coerceSurveyActions([{ op: "update_option", target: "Q7", option: 4, code: 9 }]).actions);
  assert.ok(rc.valid, rc.errors.join());
  assert.equal(rc.def.localization!.translations.de[K.optAlt("q7", 9)]?.text, "Die US-Flagge");
  assert.equal(rc.def.localization!.translations.de[K.optAlt("q7", 4)], undefined);
  assert.ok(/2 translations moved with it/.test(rc.results[0].destructive ?? ""), rc.results[0].destructive);
});

test("translationImpact — edges: a translation outdated BEFORE the change is not this change's; an orphan before and after is not dropped by it; an added language is not an impact", () => {
  const before = translate(multi(), "de", { "q:q7:text": "Wo wohnen Sie?", "q:q8:text": "Warum?" });
  before.questions[0].text = "Where do you live now?"; // the German is already stale
  let loc = recordTranslation(before.localization!, "de", "q:q99:text", "Weg", "Gone", { origin: "manual" });
  const b = { ...before, localization: loc } as SurveyDefinition;
  const after = structuredClone(b);
  after.questions[1].text = "Why exactly?";
  loc = recordTranslation(after.localization!, "fr", "q:q8:text", "Pourquoi ?", "Why exactly?", { origin: "ai" });
  const a = { ...after, localization: { ...loc, languages: [...loc.languages, { code: "fr", status: "draft", enabled: true, format: {} }] } } as SurveyDefinition;
  const imp = translationImpact(b, a);
  assert.ok(!imp.languages.some((l) => l.language === "fr"), "French was added by this change: a Language row, not an impact");
  const de = imp.languages.find((l) => l.language === "de")!;
  assert.deepEqual(de.outdated.map((e) => e.element), ["Q8 text"], "Q7's German was outdated before — only Q8's is this change's");
  assert.deepEqual(de.dropped, [], "the orphan of a question deleted before is not dropped by this change");
});

test("the Changes row — a language whose translations were dropped AND outdated is modified, not removed", () => {
  const before = translate(multi(), "de", { "q:q7:text": "Wo wohnen Sie?", "q:q7:opt:3": "Spanien" });
  const both = applySurveyActions(before, coerceSurveyActions([{ op: "update_question", target: "Q7", text: "Your country?", removeOptions: [3] }]).actions);
  assert.ok(both.valid, both.errors.join());
  assert.equal(changeItems(before, both.def).items.find((i) => i.category === "Translation" && i.field === "Deutsch translations")!.kind, "modified");
  const drop = applySurveyActions(before, coerceSurveyActions([{ op: "update_question", target: "Q7", removeOptions: [3] }]).actions);
  assert.equal(changeItems(before, drop.def).items.find((i) => i.category === "Translation" && i.field === "Deutsch translations")!.kind, "removed");
});
