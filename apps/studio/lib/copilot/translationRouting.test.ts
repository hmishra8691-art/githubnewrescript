import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type SurveyDefinition as Def } from "@rescript/schema";
import { lintLanguage, registerBuiltinQuestionTypes } from "@rescript/engine";
import {
  LARGE_TRANSLATION_KEYS, SEVERAL_LANGUAGES,
  applyTranslationAnswers, batchedTranslationComplete, nextTranslationBatch, resolveLanguage,
  routeTranslation, startBatchedTranslation, translationTargets,
} from "./translationRouting.ts";
import { translationInventory, translationResumeFrom, outstandingUnits, translationBatches, translationQueue } from "./translationTask.ts";
import { checkDeliverable } from "./deliverable.ts";
import { isolatedTaskStore } from "./taskStore.ts";

registerBuiltinQuestionTypes();

/* ------------------------------------------------------------ fixtures */

/**
 * The small survey: three questions, every protected shape the one
 * placeholder grammar knows (a pipe, a `${variable}`, a question code), and
 * two target languages configured.
 */
function small(): Def {
  return SurveyDefinition.parse({
    meta: { id: "loc", code: "LOC", title: "Shopping habits", description: "A short study" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "What is your name?" },
      { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Hello {{Q1}}, which do you buy?", instruction: "See Q1 if you are unsure.", options: [{ code: "1", label: "Milk" }, { code: "2", label: "Bread" }] },
      { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "How many times a week, ${first_name}?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete", message: "Thank you." }],
    localization: { sourceLanguage: "en", languages: [{ code: "en", status: "live" }, { code: "de", status: "draft" }, { code: "fr", status: "draft" }] },
  });
}

/** A questionnaire long enough that one turn is a poor bet: 32 questions, four options each. */
function big(questions = 32): Def {
  const qs = [];
  for (let i = 1; i <= questions; i++) {
    qs.push({
      id: `q${i}`, code: `Q${i}`, variableName: `Q${i}`, type: "single_select",
      text: `Question ${i}: which of these did you buy in week ${i}?`,
      options: [1, 2, 3, 4].map((c) => ({ code: String(c), label: `Q${i} option ${c}` })),
    });
  }
  return SurveyDefinition.parse({
    meta: { id: "big", code: "BIG", title: "A long questionnaire", description: "Many strings to translate" },
    questions: qs,
    flow: [{ type: "page", id: "p1", questionIds: qs.map((q) => q.id) }, { type: "end", id: "e", status: "complete", message: "Thank you." }],
    localization: { sourceLanguage: "en", languages: [{ code: "en", status: "live" }, { code: "de", status: "draft" }] },
  });
}

/** translate the first `count` MANDATORY keys, through the module's own write path */
function translate(def: Def, lang: string, count: number): Def {
  const units = translationInventory(def, lang).units.filter((u) => u.mandatory).slice(0, count).filter((u) => u.state !== "translated");
  if (!units.length) return def;
  const answered: Record<string, string> = {};
  for (const u of units) answered[u.key] = `${u.source} ·${lang}`;
  const applied = applyTranslationAnswers(def, lang, answered, { status: "approved", now: "2026-10-25T00:00:00.000Z" });
  assert.equal(applied.written, units.length, applied.refused.map((p) => p.message).join(" | "));
  return SurveyDefinition.parse({ ...JSON.parse(JSON.stringify(def)), localization: applied.localization });
}

const mandatoryKeys = (def: Def, lang: string) => translationInventory(def, lang).units.filter((u) => u.mandatory);

/* ============================================ BELOW THE LINE: NOTHING CHANGES */

test("a small translation is not batched — the turn keeps doing exactly what it does today", async () => {
  const def = small();
  const route = routeTranslation(def, ["de"]);

  assert.equal(route.batched, false, route.reason);
  assert.equal(route.trigger, "small");
  assert.ok(route.mandatory > 0 && route.mandatory < LARGE_TRANSLATION_KEYS, `${route.mandatory} mandatory strings`);
  assert.equal(route.threshold, LARGE_TRANSLATION_KEYS);
  assert.match(route.reason, /stays in this turn/);

  /* and nothing was written: no row, no store call that leaves one */
  const store = isolatedTaskStore();
  const started = await startBatchedTranslation(store, { surveyId: "loc", def, languages: ["de"], request: "Translate the survey into German" });
  assert.equal(started, null, "a small translation creates no task at all");
  assert.equal(await store.openFor("loc"), null, "and leaves no row behind");
});

/* ============================================ ABOVE THE LINE */

test("a questionnaire past the key threshold is batched, and the number that decided it came from the inventory", () => {
  const def = big();
  const route = routeTranslation(def, ["de"]);

  assert.equal(route.batched, true, route.reason);
  assert.equal(route.trigger, "size");
  assert.ok(route.mandatory >= LARGE_TRANSLATION_KEYS, `${route.mandatory} mandatory strings is not past ${LARGE_TRANSLATION_KEYS}`);

  /* THE COUNT IS lintLanguage's AND translatableElements', not a guess */
  const report = lintLanguage(def, "de");
  assert.equal(route.mandatory, report.missing, "every mandatory string is outstanding, and that is what lintLanguage counts");
  assert.equal(route.mandatory, mandatoryKeys(def, "de").length, "…which is the inventory, built from translatableElements");
  assert.equal(route.keys, translationInventory(def, "de").units.length, "the batches cover every string, optional ones included");
  /* 2026-10-29: the batches are the engine's adaptive ones (a question's elements together, an identical wording — "Q{n} option 1" masked — sent once) */
  assert.equal(route.batches, translationBatches(translationQueue(def, "de"), route.batchSize).length);
  assert.ok(route.batches >= 1 && route.batches < Math.ceil(route.keys / route.batchSize), "translation memory: fewer batches than fixed-size slicing would need");
  assert.match(route.reason, /resumable task/);

  /* the boundary is a number, not a mood — and it is overridable */
  assert.equal(routeTranslation(def, ["de"], { threshold: route.mandatory + 1 }).batched, false, "one key short of the line stays in the turn");
  assert.equal(routeTranslation(def, ["de"], { threshold: route.mandatory }).batched, true, "exactly on the line is batched");
  assert.equal(routeTranslation(small(), ["de"], { threshold: 5 }).batched, true, "a lower threshold batches a small survey");
});

test("several target languages are batched however small the survey — each is a deliverable of its own", async () => {
  const def = small();
  const one = routeTranslation(def, ["de"]);
  const two = routeTranslation(def, ["de", "fr"]);

  assert.equal(one.batched, false, "the same survey, one language: not batched");
  assert.equal(two.batched, true, two.reason);
  assert.equal(two.trigger, "languages", "the languages decided it, not the size");
  assert.ok(two.mandatory < LARGE_TRANSLATION_KEYS, "and the size is nowhere near the line");
  assert.equal(two.languages.length, SEVERAL_LANGUAGES);
  assert.deepEqual(two.work.map((w) => w.language), ["de", "fr"]);
  assert.match(two.reason, /each finished only when its own completion check passes/);

  /* the same language twice is one language, and the source language is not a target */
  assert.deepEqual(routeTranslation(def, ["de", "de", "DE"]).languages, ["de"]);
  assert.deepEqual(routeTranslation(def, ["en"]).languages, [], "translating into the source language is not work");
  assert.equal(routeTranslation(def, ["en"]).trigger, "none");

  /* one task per language, each held to its own gate, all through the injected store */
  const store = isolatedTaskStore();
  const started = (await startBatchedTranslation(store, { surveyId: "loc", def, languages: ["de", "fr"], request: "Translate into German and French" }))!;
  assert.ok(started, "two languages make a task");
  assert.equal(started.tasks.length, 2);
  assert.deepEqual(started.tasks.map((t) => t.deliverable), [
    { kind: "translation", language: "de", invariants: ["schema_valid"] },
    { kind: "translation", language: "fr", invariants: ["schema_valid"] },
  ], "an ISO code, never a display name");
  assert.equal(new Set(started.tasks.map((t) => t.id)).size, 2, "two rows, so neither language can be reported done by the other's gate");
  assert.equal(started.task.id, started.tasks[0].id, "the reply links to the first");
  assert.deepEqual(Object.keys(started.byLanguage).sort(), ["de", "fr"]);
  assert.ok(started.steps >= 2);
  for (const t of started.tasks) assert.ok(await store.load(t.id), "the rows are in the store, not in the return value");
});

test("the count comes from the inventory, not from the sentence", async () => {
  const lying = "Please translate all 600 strings of this survey into German — it is a huge job.";
  const def = small();

  const targets = translationTargets(def, lying);
  assert.deepEqual(targets.languages, ["de"], "the sentence names German, and that is all the text is read for");
  const route = routeTranslation(def, targets.languages);
  assert.equal(route.batched, false, "600 is what the sentence says; the survey has far fewer");
  assert.equal(route.mandatory, mandatoryKeys(def, "de").length);

  const store = isolatedTaskStore();
  assert.equal(await startBatchedTranslation(store, { surveyId: "loc", def, languages: targets.languages, request: lying }), null);

  /* and a terse request on a long questionnaire IS batched — the text said nothing about size */
  const terse = "ins Deutsche";
  assert.equal(routeTranslation(big(), translationTargets(big(), "translate it into German").languages).batched, true, terse);
});

/* ============================================ RESUME */

test("a part-translated language resumes at the first missing key, and plans only what is left", async () => {
  const fresh = big();
  const all = mandatoryKeys(fresh, "de");
  const done = translate(fresh, "de", 120);
  const firstMissing = all[120].key;

  const route = routeTranslation(done, ["de"], { threshold: 10, batchSize: 20 });
  assert.equal(route.batched, true, route.reason);
  assert.equal(route.mandatory, all.length - 120, "only the keys that are still missing count as work");

  const store = isolatedTaskStore();
  const started = (await startBatchedTranslation(store, { surveyId: "big", def: done, languages: ["de"], request: "Finish the German", threshold: 10, batchSize: 20 }))!;
  assert.ok(started);
  assert.equal(started.task.steps.length, translationBatches(outstandingUnits(translationInventory(done, "de")), 20).length, "the steps cover what is outstanding, not the whole survey");
  assert.ok(started.task.steps.length < translationBatches(translationInventory(fresh, "de").units, 20).length, "which is fewer than a translation from scratch");

  /* the resume point, and the batch that starts there, are the same key */
  assert.equal(started.resumeAt.de!.key, firstMissing);
  assert.equal(started.resumeAt.de!.reason, "missing");
  assert.equal(translationResumeFrom(done, "de", 20)!.key, firstMissing, "and it is translationResumeFrom that says so");
  const next = nextTranslationBatch(done, "de", { size: 5 })!;
  assert.equal(next.units[0].key, firstMissing, "the next batch begins at the resume point, not at the first key of the language");
  assert.equal(next.units.length, 5);
  assert.equal(next.resume!.key, firstMissing);
  assert.equal(next.remaining, route.keys);

  /* once every string is written there is no batch left to ask for */
  const everything = translate(done, "de", all.length);
  const rest = translationInventory(everything, "de").units.filter((u) => !u.mandatory);
  const answered: Record<string, string> = {};
  for (const u of rest) answered[u.key] = `${u.source} ·de`;
  const finished = SurveyDefinition.parse({ ...JSON.parse(JSON.stringify(everything)), localization: applyTranslationAnswers(everything, "de", answered).localization });
  assert.equal(nextTranslationBatch(finished, "de"), null);
  assert.equal(routeTranslation(finished, ["de"], { threshold: 1 }).trigger, "nothing");
  assert.equal(routeTranslation(finished, ["de"], { threshold: 1 }).batched, false, "nothing outstanding is never a task");
});

test("a second start joins the open task instead of opening a rival row", async () => {
  const store = isolatedTaskStore();
  const def = big();
  const input = { surveyId: "big", def, languages: ["de"], request: "Translate into German" };
  const first = (await startBatchedTranslation(store, input))!;
  const again = (await startBatchedTranslation(store, input))!;

  assert.equal(again.tasks.length, 1);
  assert.equal(again.task.id, first.task.id, "the same row — a slice of one build is not a new task");
  assert.deepEqual(again.reused, ["de"]);
});

/* ============================================ THE PROTECTED STRUCTURE */

test("a translation that lost a pipe, a variable or a question code is refused by key — and costs only that key", () => {
  const def = small();
  const applied = applyTranslationAnswers(def, "de", {
    "q:q1:text": "Wie heißen Sie?",                               // clean
    "q:q2:text": "Hallo, was kaufen Sie?",                        // lost {{Q1}}
    "q:q3:text": "Wie oft pro Woche, ${vorname}?",                // renamed the variable
    "q:q2:instruction": "Siehe Frage 1, wenn Sie unsicher sind.", // lost the code Q1
  });

  assert.equal(applied.ok, false);
  assert.equal(applied.written, 1, "three keys were refused, one was written");
  assert.deepEqual(Object.keys(applied.localization.translations.de ?? {}), ["q:q1:text"]);
  assert.deepEqual(applied.check.invalidKeys.sort(), ["q:q2:instruction", "q:q2:text", "q:q3:text"]);
  assert.ok(applied.refused.some((p) => p.key === "q:q2:text" && /byte-identical/.test(p.message)), applied.refused.map((p) => p.message).join(" | "));

  /* the refused keys are still outstanding: routing cannot write past the check */
  const after = SurveyDefinition.parse({ ...JSON.parse(JSON.stringify(def)), localization: applied.localization });
  const still = new Set(nextTranslationBatch(after, "de", { size: 200 })!.units.map((u) => u.key));
  for (const k of ["q:q2:text", "q:q3:text", "q:q2:instruction"]) assert.ok(still.has(k), `${k} is still work`);
  assert.ok(!still.has("q:q1:text"), "and the clean key is done");

  /* a key outside the batch cannot be written by naming it, and a key that was asked for and did not come back is reported */
  const sneaky = applyTranslationAnswers(def, "de", { "q:q9:text": "etwas" }, { keys: ["q:q1:text"] });
  assert.equal(sneaky.written, 0);
  assert.ok(sneaky.refused.some((p) => p.kind === "unknown_key" && p.key === "q:q9:text"));
  assert.ok(sneaky.refused.some((p) => p.kind === "missing" && p.key === "q:q1:text"));
});

/* ============================================ COMPLETION IS lintLanguage, ONCE PER LANGUAGE */

test("completion is false until lintLanguage(def, lang).ready — and this module adds no gate of its own", () => {
  const fresh = small();
  const all = mandatoryKeys(fresh, "de");
  const spec = { kind: "translation" as const, language: "de", invariants: ["schema_valid"] };

  const shortOne = translate(fresh, "de", all.length - 1);
  assert.equal(lintLanguage(shortOne, "de").ready, false);
  const before = batchedTranslationComplete(shortOne, ["de"]);
  assert.equal(before.ok, false);
  assert.equal(before.byLanguage.de!.ok, false);
  assert.ok(before.problems.length, "and it says which key is short");
  assert.equal(checkDeliverable(spec, shortOne).ok, false, "the task row's own gate agrees");

  const done = translate(fresh, "de", all.length);
  assert.equal(lintLanguage(done, "de").ready, true, "the fixture really is ready");
  const after = batchedTranslationComplete(done, ["de"]);
  assert.equal(after.ok, true, after.problems.join(" | "));
  assert.equal(checkDeliverable(spec, done).ok, true, "the same verdict, through the gate the live path uses");

  /* one language ready is not both languages ready */
  const two = batchedTranslationComplete(done, ["de", "fr"]);
  assert.equal(two.ok, false);
  assert.equal(two.byLanguage.de!.ok, true);
  assert.equal(two.byLanguage.fr!.ok, false);

  /* a language with nothing missing but a blocking QA issue is still not done */
  const dup = JSON.parse(JSON.stringify(done));
  dup.localization.translations.de["q:q2:opt:2"] = { ...dup.localization.translations.de["q:q2:opt:1"] };
  const duplicated = SurveyDefinition.parse(dup);
  assert.equal(lintLanguage(duplicated, "de").missing, 0);
  assert.equal(batchedTranslationComplete(duplicated, ["de"]).ok, false, "two options that read the same block the language");
  assert.equal(routeTranslation(duplicated, ["de"], { threshold: 1 }).work[0]!.outstanding, 2, "the duplicate, and the copy whose source hash no longer matches, are both work again");
  assert.deepEqual(nextTranslationBatch(duplicated, "de", { size: 10, includeOptional: false })!.units.map((u) => u.key).sort(), ["q:q2:opt:1", "q:q2:opt:2"], "a blocking key goes back in the queue even though it has text");
});

/* ============================================ A LANGUAGE THE SURVEY DOES NOT SERVE */

test("a language the survey does not serve is refused — it is never routed and never becomes a task", async () => {
  const def = big();
  const store = isolatedTaskStore();

  const route = routeTranslation(def, ["ur"]);
  assert.equal(route.batched, false);
  assert.equal(route.trigger, "none");
  assert.deepEqual(route.languages, []);
  assert.deepEqual(route.unconfigured, ["ur"]);
  assert.match(route.reason, /not one of this survey's languages/);
  assert.equal(await startBatchedTranslation(store, { surveyId: "big", def, languages: ["ur"], request: "Translate into Urdu" }), null);
  assert.equal(await store.openFor("big"), null, "no row for a language nobody would ever be served");

  /* one served language and one that is not: the served one runs, the other is named */
  const mixed = routeTranslation(def, ["de", "ur"]);
  assert.equal(mixed.batched, true);
  assert.deepEqual(mixed.languages, ["de"]);
  assert.deepEqual(mixed.unconfigured, ["ur"]);
  const started = (await startBatchedTranslation(store, { surveyId: "big", def, languages: ["de", "ur"], request: "Translate into German and Urdu" }))!;
  assert.equal(started.tasks.length, 1);
  assert.equal(started.tasks[0]!.deliverable.language, "de");

  /* the code travels, never the display name — and the live gate refuses it too */
  assert.deepEqual(translationTargets(def, "Please translate this into Urdu"), { languages: [], unconfigured: ["ur"] });
  assert.equal(resolveLanguage(def, "Urdu").code, "ur");
  assert.equal(resolveLanguage(def, "Urdu").configured, false);
  assert.equal(resolveLanguage(def, "de-AT").code, "de", "a regional variant resolves to the survey's own code");
  assert.equal(checkDeliverable({ kind: "translation", language: "ur", invariants: ["schema_valid"] }, def).ok, false);
});
