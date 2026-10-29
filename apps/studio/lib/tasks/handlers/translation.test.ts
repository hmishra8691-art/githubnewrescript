import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, estimateTaskSize, localizeDefinition, surveyStructureHash, translationCoverage, translationInventory, registerBuiltinQuestionTypes } from "@rescript/engine";
import { __resetTaskRegistry, pickTaskPlanner } from "../registry.ts";
import { __resetFakeResponders, registerFakeResponder, fakeResponse } from "../fakeResponders.ts";
import { taskResult } from "../engine.ts";
import { runTaskInProcess, sliceInProcess } from "../testing.ts";
import { registerGenericTasks } from "./generic.ts";
import { parseTranslationRequest, registerTranslationTasks, fakeTranslationAnswer, translationPlanner, translationCompletion, translationWork } from "./translation.ts";
import { LARGE_TRANSLATION_KEYS } from "../../copilot/translationRouting.ts";

registerBuiltinQuestionTypes();

/*
 * TRANSLATION AS A DURABLE TASK (K3's tests re-expressed on the base runner, 2026-10-29): the production requests
 * are read deterministically; the planner forces a task only when the survey's own inventory says so; a
 * 78-question survey is translated to Urdu in N validated batches to 100 % coverage with the structure unchanged;
 * an interrupted run resumes without sending a completed batch again; "the first 10 questions" is scope, never
 * prose; refusals get one targeted repair; an output limit splits a batch; a source edit invalidates one key;
 * several languages are one task with a gate per language.
 */

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function bigSurvey(n: number) {
  const questions: unknown[] = [];
  const pages: unknown[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `q${i}`, code = `Q${i}`;
    const k = i % 5;
    if (k === 0) questions.push({ id, code, variableName: `V${i}`, type: "matrix_single", text: `How much do you agree with statement set ${i}?`, rows: [{ code: "r1", label: `Statement ${i} alpha` }, { code: "r2", label: `Statement ${i} beta` }], options: opts("Disagree", "Neutral", "Agree") });
    else if (k === 1) questions.push({ id, code, variableName: `V${i}`, type: "single_select", text: `Question number ${i}: which option fits {{brand}} best?`, instruction: "Select one answer", options: opts("Yes", "No", "Not sure") });
    else if (k === 2) questions.push({ id, code, variableName: `V${i}`, type: "multi_select", text: `Which of these did you use in topic ${i}? <b>Select all</b>`, options: [...opts(`Item ${i} one`, `Item ${i} two`), { code: 99, label: "None of these", flags: ["exclusive"] }] });
    else if (k === 3) questions.push({ id, code, variableName: `V${i}`, type: "allocation", text: `Split 100 points for area ${i}. Total so far: \${total}`, rows: [{ code: "a", label: `Price ${i}` }, { code: "b", label: `Speed ${i}` }] });
    else questions.push({ id, code, variableName: `V${i}`, type: "long_text", text: `Please describe your experience with area ${i} — see www.example.org/help.` });
    pages.push({ type: "page", id: `p${i}`, questionIds: [id] });
  }
  return SurveyDefinition.parse({
    meta: { id: "big", code: "BIG", title: "Large tracker", version: "1.0" },
    embeddedData: [{ name: "brand", source: "url" }],
    questions,
    flow: [{ type: "block", id: "b1", title: "Main", children: pages }, { type: "end", id: "e1", status: "screened", message: "Sorry, you do not qualify." }, { type: "end", id: "e", status: "complete", message: "Thank you!" }],
    deployment: { clientSlug: "c", studySlug: "big", languages: ["en"] },
  });
}

function setup() { __resetTaskRegistry(); __resetFakeResponders(); registerGenericTasks(); registerTranslationTasks(); }
const apply = (def: SurveyDefinition, actions: unknown[]) => { const c = coerceSurveyActions(actions); const r = applySurveyActions(def, c.actions, { now: "2026-10-29T11:00:00Z" }); assert.deepEqual([...c.rejected, ...r.errors], [], JSON.stringify({ rej: c.rejected, err: r.errors })); return r.def; };
const stepIds = (t: { steps: { stepId: string; status: string }[] }) => t.steps.filter((s) => s.status !== "tombstoned").map((s) => s.stepId);

/* ------------------------------------------------------------ the request and the planner's score */

test("the production requests are read deterministically: language(s), mode and scope — questions about translations are not tasks", () => {
  const def = bigSurvey(78);
  const hi = parseTranslationRequest("सर्वे को उर्दू में ट्रांस्लेट कर दो", def);
  assert.deepEqual(hi && { l: hi.language, m: hi.mode, all: !hi.questionIds }, { l: "ur", m: "version", all: true });
  const ten = parseTranslationRequest("Translate the first 10 questions to Urdu", def);
  assert.equal(ten?.language, "ur");
  assert.deepEqual(ten?.questionIds, def.questions.slice(0, 10).map((q) => q.id));
  assert.equal(parseTranslationRequest("translate the survey into Urdu", def)?.language, "ur");
  assert.equal(parseTranslationRequest("पहले 5 सवाल उर्दू में ट्रांसलेट करो", def)?.questionIds?.length, 5);
  assert.deepEqual(parseTranslationRequest("translate Q3 to Q6 into German", def)?.questionIds, ["q3", "q4", "q5", "q6"]);
  assert.deepEqual(parseTranslationRequest("translate Q7 into Hindi please", def)?.questionIds, ["q7"]);
  assert.equal(parseTranslationRequest("اردو میں ترجمہ کر دیں", def)?.language, "ur");
  assert.equal(parseTranslationRequest("replace the wording with Urdu — translate it, nothing separate", def)?.mode, "replace");
  assert.equal(parseTranslationRequest("इसे ही पूरा उर्दू में कर दो", def)?.mode, "replace");
  assert.deepEqual(parseTranslationRequest("traduire le questionnaire en français et en arabe", def)?.languages, ["fr", "ar"], "several languages, in the order named");
  for (const m of ["which languages are missing text?", "approve the German translations", "route Mexican respondents to Spanish", "make Q7 a 5-point scale", "which strings are untranslated in Urdu?", "add 'Gold' to the glossary as do-not-translate", "translate"]) assert.equal(parseTranslationRequest(m, def), null, m);
  assert.equal(parseTranslationRequest("translate the survey into Urdu", SurveyDefinition.parse({ meta: { id: "e", code: "E", title: "Empty", version: "1" }, questions: [], flow: [] })), null, "nothing to translate");
});

test("planner score: the count is read off the survey — a large inventory or several languages force a task (≥ 0.9); a small one scores 0.5 (this planner when the estimate says task, else the in-turn path); not a translation → 0", () => {
  setup();
  const big = bigSurvey(78), small = bigSurvey(4);
  const m = (msg: string, s: unknown) => translationPlanner.matches({ message: msg, survey: s });
  assert.ok(translationWork(big, parseTranslationRequest("सर्वे को उर्दू में ट्रांस्लेट कर दो", big)!).pending >= LARGE_TRANSLATION_KEYS);
  assert.equal(m("सर्वे को उर्दू में ट्रांस्लेट कर दो", big), 0.95);
  assert.equal(m("translate the first 10 questions into Urdu", big), 0.5, "ten questions: under the line, by the survey's count");
  assert.equal(m("translate the survey into Urdu", small), 0.5);
  assert.equal(m("traduire le questionnaire en français et en arabe", small), 0.95, "two languages: two deliverables, a task however small");
  assert.equal(m("which strings are untranslated in Urdu?", big), 0);
  assert.equal(m("Add an NPS question", big), 0);
  assert.equal(pickTaskPlanner({ message: "translate the first 10 questions into Urdu", survey: big })?.planner.id, "translation", "beats the generic planner");
});

test("the turn's decision (turnTask.ts: the estimate OR a planner at ≥ 0.9): the 78-question Urdu request is a task, 'the first 10 questions' is a task by size, a 4-question survey stays in the turn", () => {
  setup();
  const decide = (message: string, survey: SurveyDefinition) => { const e = estimateTaskSize({ message, survey }); const p = pickTaskPlanner({ message, survey }); return { task: e.task || (!!p && p.score >= 0.9), planner: p?.planner.id ?? null, score: p?.score ?? 0, units: e.units }; };
  const big = bigSurvey(78);
  assert.deepEqual(decide("सर्वे को उर्दू में ट्रांस्लेट कर दो", big), { task: true, planner: "translation", score: 0.95, units: 78 });
  const ten = decide("translate the first 10 questions into Urdu", big);
  assert.equal(ten.task, true, "ten questions: a task by the size estimate (TASK_MIN_TRANSLATE), planned by the translation planner — never prose");
  assert.equal(ten.planner, "translation");
  assert.equal(ten.units, 10);
  const small = decide("translate the survey into Urdu", bigSurvey(4));
  assert.equal(small.task, false, "four questions: the in-turn path, as before");
  assert.equal(small.planner, "translation");
});

/* ------------------------------------------------------------ whole tasks on the base runner */

test("C: a 78-question survey → Urdu as a task of N validated batches, one small-tier call each, 100 % coverage, structure unchanged, RTL; translation memory sends a shared wording once", { timeout: 300_000 }, async () => {
  setup();
  const prompts: string[] = [];
  registerFakeResponder("translation.batch", (call) => { prompts.push(call.prompt); assert.equal(call.tier, "small"); assert.ok(call.schema); const v = fakeTranslationAnswer(call.prompt); return v ? { value: v } : undefined; });
  const base = bigSurvey(78);
  const r = await runTaskInProcess({ message: "सर्वे को उर्दू में ट्रांस्लेट कर दो", definition: base, charge: 0.01 });
  assert.ok(r.plan.ok && r.plan.planner === "translation");
  const ids = stepIds(r.task);
  const batches = r.task.steps.filter((s) => s.kind === "translation.batch" && s.status !== "tombstoned");
  assert.ok(batches.length >= 2, `${batches.length} batches: ${ids.join(",")}`);
  assert.equal(ids[0], "tr.ur.prepare"); assert.equal(ids.at(-1), "tr.ur.verify");
  for (const b of batches) { const inp = b.input as { units: number; range: { from: number; to: number }; keys: string[] }; assert.equal(inp.units, inp.keys.length); assert.ok(inp.range.from <= inp.range.to); assert.equal(b.modelTier, "small"); }
  assert.equal(r.task.status, "completed", JSON.stringify({ e: r.task.blocked, s: r.task.steps.filter((s) => s.status !== "completed").map((s) => [s.stepId, s.status, s.failureKind, s.failureMessage]) }));
  assert.equal(r.calls, batches.length, "one model call per batch, none for prepare / verify");
  for (const b of batches) assert.ok(b.usage && (b.usage.charge ?? 0) > 0, `${b.stepId} carries its own cost`);
  const res = taskResult(r.task);
  const applied = apply(base, res.actions);
  const cov = translationCoverage(applied, "ur", translationInventory(applied).units);
  assert.equal(cov.complete, true, JSON.stringify({ i: cov.invalid.slice(0, 3), m: cov.missing.slice(0, 3) }));
  assert.equal(cov.percent, 100);
  assert.equal(cov.rtl, true);
  assert.equal(surveyStructureHash(applied), surveyStructureHash(base), "logic, piping, codes unchanged");
  const ur = localizeDefinition(applied, "ur");
  assert.ok(/\p{Script=Arabic}/u.test(ur.questions[0].text) && ur.questions[0].text.includes("{{brand}}"));
  assert.ok(ur.questions[2].text.includes("${total}"));
  assert.ok(ur.questions[3].text.includes("www.example.org/help"));
  assert.ok(/<b>[^<]*<\/b>/.test(ur.questions[1].text) && /\p{Script=Arabic}/u.test(ur.questions[1].text), "the tags are byte-identical, the words between them translated");
  const verify = r.task.steps.find((s) => s.stepId === "tr.ur.verify")!;
  assert.equal((verify.output as { data: { coverage: { percent: number }; rtl: boolean } }).data.coverage.percent, 100);
  assert.equal((verify.output as { data: { rtl: boolean } }).data.rtl, true);
  assert.equal(prompts.join("\n").split("Select one answer").length - 1, 1, "a wording shared by 16 questions went to the model once");
  assert.equal(translationCompletion(applied, r.task.completion ?? [])?.ok, true);
  assert.equal(translationCompletion(base, r.task.completion ?? [])?.ok, false, "the gate refuses the untranslated base");
});

test("resume: a run stopped after some batches carries on from the rows — a completed batch is never sent again, and the task completes", { timeout: 300_000 }, async () => {
  setup();
  const base = bigSurvey(60);
  const first = await runTaskInProcess({ message: "translate the survey into Urdu", definition: base, charge: 0.01, maxSlices: 1, slice: { maxSteps: 3 } });
  assert.equal(first.task.status, "running");
  const doneBefore = first.task.steps.filter((s) => s.kind === "translation.batch" && s.status === "completed").length;
  assert.ok(doneBefore >= 1, "at least one batch committed before the stop");
  let calls = 0;
  registerFakeResponder("translation.batch", (call) => { calls++; const v = fakeTranslationAnswer(call.prompt); return v ? { value: v } : undefined; });
  let task = first.task;
  for (let i = 0; i < 40 && (task.status === "running" || task.status === "pending"); i++) { await sliceInProcess(first.store, task.id, {}, 0.01); task = (await first.store.load(task.id))!; }
  assert.equal(task.status, "completed", JSON.stringify(task.blocked));
  const batches = task.steps.filter((s) => s.kind === "translation.batch" && s.status !== "tombstoned");
  assert.equal(calls, batches.length - doneBefore, "only the batches not yet committed were sent");
  const applied = apply(base, taskResult(task).actions);
  assert.equal(translationCoverage(applied, "ur", translationInventory(applied).units).percent, 100);
});

test("small request: 'translate the first 10 questions to Urdu' is scope, never prose — prepare → one batch → verify; a prose answer is retried, not stored", { timeout: 300_000 }, async () => {
  setup();
  let prose = 1;
  registerFakeResponder("translation.batch", (call) => (prose-- > 0 ? { fail: "invalid_output", message: "words, not JSON" } : (() => { const v = fakeTranslationAnswer(call.prompt); return v ? { value: v } : undefined; })()));
  const base = bigSurvey(30);
  const r = await runTaskInProcess({ message: "Translate the first 10 questions to Urdu", definition: base, charge: 0.01 });
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.blocked));
  assert.deepEqual(r.task.steps.filter((s) => s.status !== "tombstoned").map((s) => s.kind), ["translation.prepare", "translation.batch", "translation.verify"]);
  const out = apply(base, taskResult(r.task).actions);
  const table = out.localization!.translations.ur;
  for (const q of base.questions.slice(0, 10)) assert.ok(table[`q:${q.id}:text`], `${q.code} translated`);
  for (const q of base.questions.slice(10)) assert.ok(!table[`q:${q.id}:text`], `${q.code} not in scope`);
  assert.ok(!Object.keys(table).some((k) => k.startsWith("ui:")), "a question scope does not touch the interface strings");
  assert.equal(r.usage.failedCalls, 1);
});

test("validation → targeted repair: refused strings (Latin letters in Urdu, a lost placeholder) go to ONE repair step with the reason; only they are sent again", { timeout: 300_000 }, async () => {
  setup();
  const prompts: string[] = [];
  let tampered = false;
  registerFakeResponder("translation.batch", (call) => {
    prompts.push(call.prompt);
    const v = fakeTranslationAnswer(call.prompt);
    if (!v) return undefined;
    if (!tampered) { tampered = true; v.items[0].text = "Question number one in English"; v.items[1].text = v.items[1].text.replace(/\{0\}/g, ""); }
    return { value: v };
  });
  const base = bigSurvey(12);
  const r = await runTaskInProcess({ message: "translate the survey into Urdu", definition: base, charge: 0.01 });
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.blocked));
  const rep = r.task.steps.find((s) => s.stepId === "tr.ur.b01-r1");
  assert.ok(rep, `a repair step: ${stepIds(r.task).join(",")}`);
  assert.equal((rep!.input as { keys: string[] }).keys.length, 2);
  assert.ok(prompts.at(-1)!.includes("\"fix\""), "the repair prompt says what was wrong");
  const out = apply(base, taskResult(r.task).actions);
  assert.equal(translationCoverage(out, "ur", translationInventory(out).units).complete, true);
});

test("an output limit splits a batch in halves; a source edited after translation invalidates only that key on the next plan", { timeout: 300_000 }, async () => {
  setup();
  let limit = 1;
  registerFakeResponder("translation.batch", (call) => (limit-- > 0 ? { fail: "output_limit", message: "max_tokens" } : (() => { const v = fakeTranslationAnswer(call.prompt); return v ? { value: v } : undefined; })()));
  const base = bigSurvey(20);
  const r = await runTaskInProcess({ message: "translate the survey into Urdu", definition: base, charge: 0.01 });
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.blocked));
  const ids = r.task.steps.map((s) => s.stepId);
  assert.ok(ids.includes("tr.ur.b01a") && ids.includes("tr.ur.b01b"), ids.join(","));
  assert.equal(r.task.steps.find((s) => s.stepId === "tr.ur.b01")!.status, "tombstoned");
  let def = apply(base, taskResult(r.task).actions);
  def = apply(def, [{ op: "update_question", target: "Q5", text: "A new wording for area five?" }]);
  const plan = await translationPlanner.plan({ message: "translate the survey into Urdu", survey: def, ai: async () => ({ ok: false, kind: "unknown", message: "no" }) });
  const b = plan.steps.filter((s) => s.kind === "translation.batch");
  assert.equal(b.length, 1);
  assert.deepEqual((b[0].input as { keys: string[] }).keys, ["q:q5:text"], "only the edited string is translated again");
});

test("several languages: one task, a prepare / batches / verify per language and a completion gate per language; replace mode rewrites the wording and makes the language the source", { timeout: 300_000 }, async () => {
  setup();
  const base = bigSurvey(8);
  const r = await runTaskInProcess({ message: "traduire le questionnaire en français et en arabe", definition: base, charge: 0.01 });
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.blocked));
  const ids = stepIds(r.task);
  assert.ok(ids.includes("tr.fr.prepare") && ids.includes("tr.fr.verify") && ids.includes("tr.ar.prepare") && ids.includes("tr.ar.verify"), ids.join(","));
  assert.deepEqual(r.task.completion, ["translation:fr:version:all", "translation:ar:version:all"]);
  const out = apply(base, taskResult(r.task).actions);
  for (const lang of ["fr", "ar"]) assert.equal(translationCoverage(out, lang, translationInventory(out).units).complete, true, lang);
  assert.ok(/\p{Script=Arabic}/u.test(localizeDefinition(out, "ar").questions[0].text));
  /* the fake responder is the registered one: a call nobody claims fails, so no step reached a model outside the family's door */
  assert.ok(fakeResponse({ purpose: "translation.batch", prompt: "TARGET_LANGUAGE=ur\n{\"id\":\"1\",\"ctx\":\"x\",\"text\":\"Hello\"}", maxTokens: 10 }));

  const rep = await runTaskInProcess({ message: "replace the wording with Urdu — translate it, nothing separate", definition: base, charge: 0.01 });
  assert.equal(rep.task.status, "completed", JSON.stringify(rep.task.blocked));
  const replaced = apply(base, taskResult(rep.task).actions);
  assert.ok(/\p{Script=Arabic}/u.test(replaced.questions[0].text) && replaced.questions[0].text.includes("{{brand}}"));
  assert.equal(replaced.localization?.sourceLanguage, "ur");
  assert.equal(surveyStructureHash(replaced), surveyStructureHash(base));
});
