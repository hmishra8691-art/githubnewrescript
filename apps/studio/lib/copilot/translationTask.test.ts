import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type SurveyDefinition as Def } from "@rescript/schema";
import { effectiveLocalization, lintLanguage, registerBuiltinQuestionTypes, translatableElements } from "@rescript/engine";
import {
  applyTranslationBatch, checkTranslationBatch, createTranslationTask, outstandingUnits, refreshOutdated,
  translationBatches, translationComplete, translationInventory, translationResumeFrom, translationSpec,
  translationSteps, DEFAULT_TRANSLATION_BATCH,
  type TranslationUnit,
} from "./translationTask.ts";
import { checkDeliverable } from "./deliverable.ts";
import { isolatedTaskStore } from "./taskStore.ts";

registerBuiltinQuestionTypes();

/* ------------------------------------------------------------ fixtures */

/**
 * A survey whose strings carry every protected shape the one placeholder
 * grammar knows: a pipe, a `{word}` parameter, a question code and a
 * `${variable}`.
 */
function survey(): Def {
  return SurveyDefinition.parse({
    meta: { id: "loc", code: "LOC", title: "Shopping habits", description: "A short study" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "What is your name?" },
      { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Hello {{Q1}}, which do you buy?", instruction: "See Q1 if you are unsure.", options: [{ code: "1", label: "Milk" }, { code: "2", label: "Bread" }] },
      { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "How many times a week, ${first_name}?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete", message: "Thank you." }],
    localization: { sourceLanguage: "en", languages: [{ code: "en", status: "live" }, { code: "de", status: "draft" }] },
  });
}

/** every mandatory key translated, except the `leaveShort` last ones */
function translateAll(def: Def, lang: string, opts: { leaveShort?: number; mangle?: Record<string, string> } = {}): Def {
  const inv = translationInventory(def, lang);
  const mandatory = inv.units.filter((u) => u.mandatory);
  const take = mandatory.slice(0, mandatory.length - (opts.leaveShort ?? 0));
  const answered: Record<string, string> = {};
  for (const u of take) answered[u.key] = opts.mangle?.[u.key] ?? `${u.source} [de]`;
  const check = checkTranslationBatch(take, answered);
  const { localization } = applyTranslationBatch(effectiveLocalization(def), lang, check.accepted, { origin: "ai", status: "approved", now: "2026-10-24T00:00:00.000Z" });
  return SurveyDefinition.parse({ ...JSON.parse(JSON.stringify(def)), localization });
}

/** every element, optional ones included */
function translateEverything(def: Def, lang: string): Def {
  const units = translationInventory(def, lang).units;
  const answered: Record<string, string> = {};
  for (const u of units) answered[u.key] = `${u.source} [de]`;
  const check = checkTranslationBatch(units, answered);
  const { localization } = applyTranslationBatch(effectiveLocalization(def), lang, check.accepted, { origin: "ai", status: "approved", now: "2026-10-24T00:00:00.000Z" });
  return SurveyDefinition.parse({ ...JSON.parse(JSON.stringify(def)), localization });
}

/* ============================================ THE INVENTORY */

test("the inventory is built from translatableElements, with the protected structure separated out", () => {
  const def = survey();
  const inv = translationInventory(def, "de");
  assert.equal(inv.units.length, translatableElements(def).length, "one unit per translatable element — no second walk of the definition");
  assert.equal(inv.sourceLanguage, "en");
  assert.ok(inv.mandatory > 0 && inv.optional > 0);
  assert.equal(inv.missing, inv.units.length, "nothing is translated yet");
  assert.ok(inv.units.slice(0, inv.mandatory).every((u) => u.mandatory), "mandatory strings come first — a launch is blocked by those");

  const q2 = inv.units.find((u) => u.key === "q:q2:text")!;
  assert.deepEqual(q2.protectedTokens, ["{{Q1}}"], "the pipe is protected");
  assert.deepEqual(inv.units.find((u) => u.key === "q:q3:text")!.protectedTokens, ["${first_name}"]);
  assert.deepEqual(inv.units.find((u) => u.key === "q:q2:instruction")!.protectedTokens, ["Q1"], "a question code is a name, not a word");
  assert.ok(inv.protectedStructure.tokens.includes("{{Q1}}") && inv.protectedStructure.tokens.includes("${first_name}"));

  /* ids, codes, scripts and calculations are not text and are never in the inventory */
  assert.ok(inv.units.every((u) => !/^script:|^calc:/.test(u.key)));
  const withScript = SurveyDefinition.parse({ ...JSON.parse(JSON.stringify(def)), scripts: [{ id: "s1", name: "s", code: "x=1" }] });
  assert.equal(translationInventory(withScript, "de").units.length, inv.units.length, "a script adds nothing to translate");
  assert.ok(translationInventory(withScript, "de").protectedStructure.excluded.some((e) => e.what === "custom scripts" && e.count === 1));
});

test("batches are a tuneable size and become one step row each, with the key range the panel shows", () => {
  const inv = translationInventory(survey(), "de");
  const units = outstandingUnits(inv);
  /* 2026-10-29: the engine's adaptive batches — at most `size` UNIQUE strings each, a question's elements together, every outstanding key in exactly one batch */
  const b = translationBatches(units, 4);
  assert.ok(b.length >= Math.ceil(units.length / 8) && b.length <= units.length, `${b.length} batches for ${units.length} keys`);
  for (const x of b) assert.ok(x.segments <= 4 && x.segments >= 1, JSON.stringify({ s: x.segments }));
  const all = b.flatMap((x) => x.units.map((u) => u.key));
  assert.equal(new Set(all).size, all.length, "no key twice");
  assert.deepEqual(new Set(all), new Set(units.filter((u) => !u.copyThrough).map((u) => u.key)), "every key with words to translate, once");
  assert.equal(b[0].from, 1);
  assert.ok(b.every((x) => x.from >= 1 && x.to <= units.length && x.from <= x.to), "the positions the panel shows are inside the outstanding list");
  assert.equal(translationBatches(units, 1).length, new Set(units.filter((u) => !u.copyThrough).map((u) => u.masked.replace(/\s+/g, " ").trim())).size, "the size is tuneable all the way down: one unique string per batch");
  assert.ok(translationBatches(units).length <= Math.ceil(units.length / DEFAULT_TRANSLATION_BATCH) + 1);

  const steps = translationSteps(b, 1, "loc");
  assert.equal(steps.length, b.length);
  assert.equal(steps[0].title, `Translate keys ${b[0].from}–${b[0].to}`);
  assert.equal(steps[0].inputRef, `keys ${b[0].from}-${b[0].to}`);
  assert.equal(steps[0].batchSize, b[0].units.length);
  assert.equal(new Set(steps.map((s) => s.idempotencyKey)).size, steps.length, "one idempotency key per batch — no double billing on a resume");
});

/* ============================================ WHAT CAME BACK */

test("a translation whose ids, piping, placeholders or scripts differ from the source is invalid and is not written", () => {
  const def = survey();
  const inv = translationInventory(def, "de");
  const units = inv.units.filter((u) => ["q:q2:text", "q:q3:text", "q:q2:instruction", "q:q1:text"].includes(u.key));

  const check = checkTranslationBatch(units, {
    "q:q2:text": "Hallo, was kaufen Sie?",                    // lost {{Q1}}
    "q:q3:text": "Wie oft pro Woche, ${vorname}?",            // renamed the variable
    "q:q2:instruction": "Siehe Frage 1, wenn Sie unsicher sind.", // lost the code Q1
    "q:q1:text": "Wie heißen Sie?",                           // fine
    "q:q9:text": "etwas",                                     // not a key in this batch
  });

  assert.equal(check.ok, false);
  assert.deepEqual(check.accepted.map((a) => a.key), ["q:q1:text"], "only the clean key is written");
  assert.deepEqual(check.invalidKeys.sort(), ["q:q2:instruction", "q:q2:text", "q:q3:text"]);
  /* 2026-10-29: the verdict and its wording are the engine's (validateTranslatedUnit → translationProblem) */
  assert.ok(check.problems.some((p) => p.key === "q:q2:text" && /\{\{Q1\}\} is missing/.test(p.message)), JSON.stringify(check.problems));
  assert.ok(check.problems.some((p) => p.key === "q:q3:text" && /\$\{first_name\}/.test(p.message)));
  assert.ok(check.problems.some((p) => p.key === "q:q2:instruction" && /Q1 is missing/.test(p.message)));
  assert.ok(check.problems.some((p) => p.kind === "unknown_key" && p.key === "q:q9:text"));
  assert.ok(check.problems.every((p) => /byte-identical/.test(p.message) || p.kind !== "placeholder"));

  /* an empty answer, and a key the model simply did not answer */
  const partial = checkTranslationBatch(units, { "q:q1:text": "   " });
  assert.ok(partial.problems.some((p) => p.kind === "empty"));
  assert.equal(partial.missingKeys.length, 3);
  assert.deepEqual(partial.accepted, []);

  /* and nothing invalid reaches the localization */
  const { localization, written } = applyTranslationBatch(effectiveLocalization(def), "de", check.accepted, { origin: "ai" });
  assert.equal(written, 1);
  assert.deepEqual(Object.keys(localization.translations.de ?? {}), ["q:q1:text"]);
  assert.equal(localization.translations.de!["q:q1:text"].sourceHash?.length! > 0, true, "the source hash is recorded, so an edit later marks it outdated");
});

/* ============================================ COMPLETION IS lintLanguage */

test("a translation left two mandatory keys short is reported INCOMPLETE and names the keys", () => {
  const def = translateAll(survey(), "de", { leaveShort: 2 });
  const short = lintLanguage(def, "de");
  assert.equal(short.missing, 2);

  const report = translationComplete(def, "de");
  assert.equal(report.ok, false);
  assert.equal(report.measured!.missing, 2);
  assert.equal(report.measured!.ready, false);

  const missingKeys = short.issues.filter((i) => i.kind === "missing").map((i) => i.key);
  assert.equal(missingKeys.length, 2);
  for (const k of missingKeys) assert.ok(report.problems.some((p) => p.startsWith(`${k} (`)), `${k} is named: ${report.problems.join(" | ")}`);
  assert.equal(report.measured!.resumeKey, missingKeys[0]);

  /* the same verdict through the one gate every task kind goes through */
  const viaSpec = checkDeliverable(translationSpec("de"), def);
  assert.equal(viaSpec.ok, false);
  assert.equal(viaSpec.measured!.missingKeys, 2);
  assert.equal(viaSpec.measured!.resumeKey, missingKeys[0]);
});

test("nothing marks a translation complete while lintLanguage says it is not ready", () => {
  const done = translateAll(survey(), "de");
  assert.equal(lintLanguage(done, "de").ready, true, "the fixture really is ready");
  assert.equal(translationComplete(done, "de").ok, true, translationComplete(done, "de").problems.join(" | "));
  assert.equal(checkDeliverable(translationSpec("de"), done).ok, true);

  /* a blocking QA issue with nothing missing still blocks: two options translated the same way */
  const dup = JSON.parse(JSON.stringify(done));
  dup.localization.translations.de["q:q2:opt:2"] = { ...dup.localization.translations.de["q:q2:opt:1"] };
  const parsed = SurveyDefinition.parse(dup);
  assert.equal(lintLanguage(parsed, "de").missing, 0, "nothing is missing…");
  assert.equal(lintLanguage(parsed, "de").ready, false, "…but it is not ready");
  const r = translationComplete(parsed, "de");
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /share the same translation/.test(p)), r.problems.join(" | "));

  /* a language that is not even configured on the survey is never "done" */
  assert.equal(translationComplete(done, "fr").ok, false);
  assert.ok(translationComplete(done, "fr").problems.some((p) => /not one of this survey's languages/.test(p)));
});

test("an edited source marks its translation outdated, and the resume point goes back to it", () => {
  const done = translateAll(survey(), "de");
  const edited = JSON.parse(JSON.stringify(done));
  edited.questions[0].text = "What should we call you?";
  const def = SurveyDefinition.parse({ ...edited, localization: refreshOutdated(SurveyDefinition.parse(edited)) });

  assert.equal(def.localization!.translations.de!["q:q1:text"].status, "outdated");
  const resume = translationResumeFrom(def, "de", 10)!;
  assert.equal(resume.key, "q:q1:text");
  assert.equal(resume.reason, "outdated");
  assert.equal(translationComplete(def, "de").ok, false, "an outdated mandatory string is blocking");
});

/* ============================================ RESUME */

test("a resumed translation starts at the first missing or invalid key, not at the first key", () => {
  const def = translateAll(survey(), "de", { leaveShort: 3 });
  const inv = translationInventory(def, "de");
  const stillMissing = inv.units.filter((u) => u.mandatory && u.state === "missing");
  assert.equal(stillMissing.length, 3);

  const r = translationResumeFrom(def, "de", 2)!;
  assert.equal(r.key, stillMissing[0].key, "the first OUTSTANDING key, in editor order");
  assert.equal(r.reason, "missing");
  assert.equal(r.position, 1);
  assert.equal(r.batchIndex, 0);
  assert.ok(r.remaining >= 3);

  /* a language that is READY still has optional strings outstanding — the resume point says so, and it is not mandatory */
  const ready = translateAll(survey(), "de");
  const after = translationResumeFrom(ready, "de")!;
  assert.ok(after, "optional strings are still work, even once the language may go live");
  assert.equal(translationInventory(ready, "de").units.find((u) => u.key === after.key)!.mandatory, false);

  /* and when every string, optional included, is translated there is nothing to resume */
  assert.equal(translationResumeFrom(translateEverything(survey(), "de"), "de"), null);
});

/* ============================================ THE TASK, THROUGH AN INJECTED STORE */

test("the task is created through an injected store — never taskStoreFor — and carries one step per batch", async () => {
  const store = isolatedTaskStore();
  const def = survey();
  const task = await createTranslationTask(store, { surveyId: "loc", def, language: "de", request: "Translate the survey into German", batchSize: 5 });
  assert.ok(task, "a survey with untranslated strings makes a task");
  assert.equal(task!.kind, "translation");
  assert.deepEqual(task!.deliverable, { kind: "translation", language: "de", invariants: ["schema_valid"] });

  const expected = translationBatches(outstandingUnits(translationInventory(def, "de")), 5).length;
  assert.equal(task!.steps.length, expected);
  assert.ok(task!.steps.every((s) => s.status === "pending" && s.inputRef?.startsWith("keys ")));

  const loaded = await store.load(task!.id);
  assert.equal(loaded!.steps.length, expected, "the rows persist in the store, not in this function");

  /* a language with nothing left to do makes no task at all */
  assert.equal(await createTranslationTask(store, { surveyId: "loc", def: translateAll(def, "de"), language: "de", request: "again", includeOptional: false }), null);
});

test("the inventory and the batches agree on what is outstanding, mandatory before optional", () => {
  const def = translateAll(survey(), "de", { leaveShort: 1 });
  const inv = translationInventory(def, "de");
  const all = outstandingUnits(inv);
  const mandatoryOnly = outstandingUnits(inv, { includeOptional: false });
  assert.ok(mandatoryOnly.length < all.length);
  assert.ok(mandatoryOnly.every((u: TranslationUnit) => u.mandatory));
  assert.equal(all[0].mandatory, true, "the one blocking string is first in the queue");
});
