import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, interpretRequest, requestScope } from "@rescript/engine";
import { classifyRequest, uxIntent, lookOnlySaid, translationIntent, analysisIntent, quotaIntent, findingsIntent, reportingIntent, referencedQuestions, copilotUserPrompt, repairPrompt, COPILOT_TRANSLATION_GUIDE, COPILOT_ANALYSIS_GUIDE } from "./prompt.ts";
import { listFillIntent } from "./listFillGuide.ts";
import { methodsIntent } from "./methodsGuide.ts";
import { qualIntent, researchPlanIntent } from "./researchGuide.ts";
import { applyIntent, spokenQuestionNumbers, undoIntent } from "./spoken.ts";
import { foldPrompt, lastUndoable, repeatsTail, sameStep, withStep } from "./proposalSteps.ts";
import type { ClientOp } from "./history.ts";

/**
 * THE PRODUCTION REGRESSION CORPUS (E3, 2026-10-18): every prompt Intelligent Mode received in production
 * (intelligent_operations, 2026-10-06…17) with the routing the Studio must give it without a model — the
 * scope, the mode, the guides that go with it, the questions shown in full, undo / apply — and the
 * speech-to-text variants seen in it, with negatives. The fixture is shared with the real-model eval (E4).
 */
interface Expect { scope: string; mode: string; ux: boolean; uxOnly: boolean; lookOnlySaid: boolean; guides: Record<string, true>; refs: string[]; undo: boolean; apply: boolean; engine?: string }
interface Case { id: string; prompt: string; context: { questions: number; proposalOpen?: boolean }; tags: string[]; note?: string; expect: Expect }
const corpus = JSON.parse(readFileSync(new URL("./fixtures/productionPrompts.json", import.meta.url), "utf8")) as {
  survey: { ref: string; type: string; text: string; options?: string[] }[];
  cases: Case[];
  variants: Record<string, unknown>;
};

const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Production intents" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const def30 = applySurveyActions(empty(), [{ op: "create_block", title: "Main" }, ...corpus.survey.map((q) => ({ op: "create_question", ref: q.ref, type: q.type, text: q.text, ...(q.options ? { options: q.options } : {}) }))] as never, { ids }).def;
const def0 = empty();

/** the deterministic routing of one request, as the route and the page compute it */
function route(prompt: string, questions: number): Expect & { engine: string } {
  const def = questions ? def30 : def0;
  const cls = classifyRequest(prompt, def.questions.length, 0);
  const mode = cls.mode;
  const guides = Object.fromEntries(Object.entries({
    translation: translationIntent(prompt), analysis: analysisIntent(prompt) || mode === "generate", quota: quotaIntent(prompt), listFill: listFillIntent(prompt),
    methods: methodsIntent(prompt), findings: findingsIntent(prompt), reporting: reportingIntent(prompt), research: researchPlanIntent(prompt, mode), qual: qualIntent(prompt),
  }).filter(([, v]) => v).map(([k]) => [k, true as const]));
  return {
    scope: requestScope(prompt).scope, mode, ux: cls.ux || mode === "ux", uxOnly: cls.uxOnly, lookOnlySaid: lookOnlySaid(prompt), guides,
    refs: referencedQuestions(def, prompt).map((id) => String(def.questions.find((q) => q.id === id)?.code)),
    undo: undoIntent(prompt), apply: applyIntent(prompt), engine: interpretRequest(def, prompt).kind,
  };
}

test("the corpus: every production prompt (43 operations) is in it, each with its expected routing", () => {
  assert.equal(corpus.survey.length, 30);
  assert.ok(corpus.cases.length >= 43, `${corpus.cases.length}`);
  assert.equal(new Set(corpus.cases.map((c) => c.id)).size, corpus.cases.length, "ids are unique");
  for (const c of corpus.cases) {
    assert.ok(c.prompt.length <= 1600, `${c.id}: a long brief is truncated`);
    assert.doesNotMatch(c.prompt, /[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s-]{9,}\d/, `${c.id}: no email or phone number`);
  }
});

for (const c of (corpus.cases as Case[])) {
  test(`production ${c.id} [${c.tags.join(", ")}] routes as expected`, () => {
    const got = route(c.prompt, c.context.questions);
    const { engine, ...want } = c.expect;
    const { engine: gotEngine, ...rest } = got;
    assert.deepEqual(rest, want, `${c.id}: “${c.prompt.slice(0, 80)}”${c.note ? ` — ${c.note}` : ""}`);
    if (engine) assert.equal(gotEngine, engine, `${c.id}: the engine's reading`);
  });
}

test("the corpus's fixes, said plainly: Marathi gets the translation guide, the undo and the apply are the Studio's, STT references are read", () => {
  const byId = new Map(corpus.cases.map((c) => [c.id, c]));
  const mr = byId.get("fb4460c8")!;
  assert.equal(route(mr.prompt, 30).guides.translation, true, "#1 Marathi in Devanagari, garbled");
  const p = copilotUserPrompt({ message: mr.prompt, outline: "o", surveyLanguage: "en", mode: "question", translation: translationIntent(mr.prompt) });
  assert.ok(p.includes("TRANSLATION GUIDE") && p.includes("REPLACE THE WORDING OR ADD A VERSION"), "the guide, with how to decide instead of asking");
  assert.equal(route(byId.get("f5c4b002")!.prompt, 30).undo, true, "#3 “reward back” = roll back");
  assert.equal(route(byId.get("ab39e1bab")!.prompt, 30).apply, true, "#2 “Please apply the changes. It is good.”");
  assert.deepEqual(route(byId.get("a2a2bc91")!.prompt, 30).refs, ["Q9"], "#8 quotient 9");
  assert.deepEqual(route(byId.get("ab39e1baa")!.prompt, 30).refs, ["Q1", "Q2"], "#8 क्यूँ एन / क्यूँ टू");
  assert.equal(route(byId.get("ec98384b")!.prompt, 30).ux, true, "#8 Urdu جاوا سکرپٹ / پاپ اپ");
  assert.equal(route(byId.get("e4d34ad9")!.prompt, 0).mode, "generate", "a Hindi “survey design करके दो” is a generation, not a UX turn");
});

/* ------------------------------------------------------------ the speech-to-text variants */

test("STT question references: each variant names its question numbers; the negatives name none", () => {
  for (const [text, want] of corpus.variants.questionRefs as [string, number[]][]) assert.deepEqual(spokenQuestionNumbers(text), want, text);
  for (const text of corpus.variants.questionRefNegatives as string[]) assert.deepEqual(spokenQuestionNumbers(text), [], text);
  // and referencedQuestions shows them in full — only when the survey has them
  assert.deepEqual(referencedQuestions(def30, "एक क्यू फाय से क्यू सिक्स में लगाओ").map((id) => def30.questions.find((q) => q.id === id)?.code), ["Q5", "Q6"]);
  assert.deepEqual(referencedQuestions(def30, "क्वेशन 99 देखो"), [], "a number the survey does not have is not a reference");
});

test("STT script / popup words are look-and-behaviour (and never look-only); 'design a survey' and 'next question' are not", () => {
  for (const t of [...corpus.variants.script as string[], ...corpus.variants.popup as string[]]) {
    const u = uxIntent(t);
    assert.equal(u.ux, true, t);
    if (/[ऀ-ॿ؀-ۿ]/.test(t)) assert.equal(u.only, false, `another script is never look-only: ${t}`);
  }
  for (const t of corpus.variants.uxNegatives as string[]) assert.equal(uxIntent(t).ux, false, t);
  assert.equal(reportingIntent("make the options slide in from the left"), false, "“slide in” is not a deck");
  assert.equal(classifyRequest("Create a new survey about skincare with an animated, card-style design", 0, 0).ux, true, "a look word next to a generation still sends the UX guide");
});

test("STT languages: a language named in any script with a translation cue sends the translation guide; the negatives do not", () => {
  for (const t of corpus.variants.translation as string[]) assert.equal(translationIntent(t), true, t);
  for (const t of corpus.variants.translationNegatives as string[]) assert.equal(translationIntent(t), false, t);
});

test("undo said in words: English, Hindi, Hinglish, Marathi, Urdu and the STT “reward back”; never a request that names a question or creates something", () => {
  for (const t of corpus.variants.undo as string[]) assert.equal(undoIntent(t), true, t);
  for (const t of corpus.variants.undoNegatives as string[]) assert.equal(undoIntent(t), false, t);
});

test("apply said in words: a bare confirmation with an apply verb; a negation, an object or a request is not one", () => {
  for (const t of corpus.variants.apply as string[]) assert.equal(applyIntent(t), true, t);
  for (const t of corpus.variants.applyNegatives as string[]) assert.equal(applyIntent(t), false, t);
});

test("create / compute / derive a calculation is an edit — English, Hindi, Hinglish, Marathi, Urdu (E4's eval)", () => {
  for (const [text, mode] of corpus.variants.modes as [string, string][]) assert.equal(classifyRequest(text, 30, 0).mode, mode, text);
});

/* ------------------------------------------------------------ #6: stopping the respondent */

test("#6 asking to block Next until a condition holds keeps validation allowed — even beside “only the UI”", () => {
  const inferred = "Q3 pe mujhe javascript lagana hai, agar age ki value 18 ke upar dalta hu to wahan pe automatic popup hokar aana chahiye ki you are eligible voter";
  assert.equal(classifyRequest(inferred, 30, 0).uxOnly, true);
  assert.equal(lookOnlySaid(inferred), false, "inferred, not said: set_validation is allowed (route → applySurveyActions uxOnlyInferred)");
  const both = "Only change the UI: keep the Next button disabled until the age in Q3 is 18 or more";
  assert.equal(lookOnlySaid(both), false, "the stopping was asked for, so validation is allowed");
  assert.equal(lookOnlySaid("Only change the UI of Q3, make it look modern"), true, "said look-only without a stop: unchanged");
  assert.equal(uxIntent("Q3 pe javascript lagao, jab tak 18 na ho tab tak next button band rahe").only, false, "Hinglish: Next stays off until … is a stop");
  // and the engine applies the validation in that turn
  const r = applySurveyActions(def30, [{ op: "set_validation", target: "Q3", rules: [{ kind: "min_value", value: 18 }] }] as never, { ids, uxOnly: true, uxOnlyInferred: !lookOnlySaid(both) });
  assert.ok(r.results[0].ok, r.errors.join("; "));
});

/* ------------------------------------------------------------ #7: calculations */

test("#7 calculations: the guide teaches the calculation language; a refusal names the fix, and the repair call carries it", () => {
  assert.match(COPILOT_ANALYSIS_GUIDE, /if\(test, then, else\)/);
  assert.match(COPILOT_ANALYSIS_GUIDE, /never IF … THEN … ELSE/);
  assert.match(COPILOT_ANALYSIS_GUIDE, /PERC_r1 \+ PERC_r2\), never PERC\.R1/);
  const r = applySurveyActions(def30, [{ op: "create_calculation", name: "X", expression: "IF AGE_SCR > 17 THEN R1 ELSE 0" }] as never, { ids });
  assert.equal(r.results[0].ok, false);
  const rp = repairPrompt({ prompt: "P", raw: {}, refused: r.errors.slice(0, 1), total: 1, uxGuideSent: false, ops: ["create_calculation"] });
  assert.match(rp.text, /a grid row in a calculation is that row's variable/);
  assert.ok(COPILOT_TRANSLATION_GUIDE.length < 6000);
});

/* ------------------------------------------------------------ #2: one step once */

test("#2 a repeated step is one step: “Plan the analysis → Plan the analysis → …” is not recorded again", () => {
  const plan = [{ op: "propose_analysis_plan" }] as never[];
  const s1 = withStep([], { request: "Plan the analysis", actions: plan });
  const s2 = withStep(s1, { request: "Plan the analysis", actions: plan });
  assert.equal(s2.length, 1, "the chip pressed twice");
  const s3 = withStep(s2, { request: "यही सारे question text मराठी में कर दो", actions: [{ op: "rename_block" }] as never[] });
  assert.equal(s3.length, 2);
  assert.ok(sameStep(s1[0], { request: " Plan the analysis ", actions: plan }));
  assert.equal(withStep(s1, { request: "Plan the analysis", actions: [{ op: "propose_analysis_plan", merge: true }] as never[] }).length, 2, "the same words with different actions are a new step");
  assert.equal(foldPrompt("Plan the analysis", "Plan the analysis"), "Plan the analysis");
  assert.equal(foldPrompt("Plan the analysis", "यही सारे … मराठी में कर दो"), "Plan the analysis → यही सारे … मराठी में कर दो");
  assert.equal(foldPrompt("a → b", "b"), "a → b");
  assert.ok(repeatsTail([1, 2, 3], [2, 3]));
  assert.ok(!repeatsTail([1, 2, 3], [3, 4]));
  assert.ok(!repeatsTail([1], []));
});

/* ------------------------------------------------------------ #3: which change undo means */

test("#3 undo means this page's last standing change, else the newest one History can restore with nothing after it", () => {
  const op = (key: string, status: string, createdAt: string, hasBefore = true) => ({ key, status, createdAt, hasBefore }) as unknown as ClientOp;
  assert.equal(lastUndoable([{ key: "a" }, { key: "b" }, { key: "c", reverted: true }], []), "b");
  const ops = [op("x3", "answered", "2026-10-17T10:12"), op("x2", "saved", "2026-10-17T10:11"), op("x1", "saved", "2026-10-17T10:07")];
  assert.equal(lastUndoable([], ops), "x2", "an earlier session's change, newest first");
  assert.equal(lastUndoable([], [op("y", "reverted", "2026-10-17T10:11"), op("z", "saved", "2026-10-17T10:00")]), "z");
  assert.equal(lastUndoable([], [op("w", "saved", "2026-10-17T10:00", false)]), null, "a change whose survey-before was not kept cannot be undone from words");
  assert.equal(lastUndoable([], []), null);
});
