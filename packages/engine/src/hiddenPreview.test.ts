import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  revealsHiddenQuestions, explainAutoPunch, questionConfigFingerprint, configFingerprints, invalidateStalePreviewAnswers,
} from "./hiddenPreview.js";
import { createResponseState, answerKey } from "./state.js";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { start, advance, setAnswer, visibleQuestions, goBack, resumeAt, compileFlow, punchDerivedQuestions, validatePage } from "./index.js";

/*
 * HIDDEN QUESTIONS SEEN BY THE PROGRAMMER (brief 19/10/2026, A15 + A66).
 *
 *   · which modes reveal a hidden question;
 *   · the respondent's flow never shows it (and a page holding only hidden
 *     questions is passed over — no empty page), the programmer's flow does;
 *   · a hidden required question never blocks Next (it is not validated);
 *   · the auto-punch explanation: applied / waiting / none / failed, the
 *     punched codes that make an option green, the per-rule details;
 *   · the stale-preview fix: a changed option, punch or Hidden setting drops
 *     exactly the dependent stored answers; navigation drops nothing.
 */

const Q = (id: string, extra: Record<string, unknown> = {}) => ({
  id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: `${id}?`,
  options: [{ code: "nike", label: "Nike" }, { code: "adidas", label: "<b>Adidas</b>" }, { code: "puma", label: "Puma" }],
  ...extra,
});

const punch = (target: string, source: string, sourceCode: string, codes: string[], extra: Record<string, unknown> = {}) => ({
  id: `p_${target}`, source: { kind: "codes", codes }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "always",
  when: { type: "rule", source: { kind: "question", ref: source }, operator: "selected", value: sourceCode },
  ...extra,
});

/** Q1 on page one; Q2 (hidden, punched from Q1) alone on page two; Q3 on page three. */
const def = () => SurveyDefinition.parse({
  meta: { id: "h2", code: "H2", title: "Hidden", version: "1.0" },
  questions: [
    Q("q1"),
    Q("q2", { settings: { hidden: true }, required: true, punches: [punch("q2", "q1", "adidas", ["adidas"])] }),
    Q("q3"),
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "page", id: "p3", questionIds: ["q3"] },
    { type: "end", id: "e", status: "complete" },
  ],
});

test("only test and preview reveal hidden questions; a respondent view inside a preview hides them again; anything else is live", () => {
  assert.equal(revealsHiddenQuestions("preview"), true);
  assert.equal(revealsHiddenQuestions("test"), true);
  assert.equal(revealsHiddenQuestions("live"), false);
  assert.equal(revealsHiddenQuestions("preview", true), false);
  assert.equal(revealsHiddenQuestions(undefined), false);
  assert.equal(revealsHiddenQuestions("TEST"), false, "a mode is exact, never guessed");
});

test("respondent flow: the hidden question is never visible and its page is passed over; programmer flow shows it", () => {
  const d = def();
  const live = createResponseState(d, { seed: 1 });
  let nav = start(d, live, {});
  const page = (s: typeof live, n: ReturnType<typeof start>) => n.steps[s.stepIndex] as Extract<ReturnType<typeof compileFlow>[number], { kind: "page" }>;
  assert.equal(page(live, nav).pageId, "p1");
  setAnswer(d, live, "q1", "adidas");
  nav = advance(d, live, {}, { fromPageId: "p1" });
  assert.equal(page(live, nav).pageId, "p3", "live: page two holds only a hidden question, so it is skipped — no empty page");
  assert.equal(live.answers.q2, "adidas", "…but the hidden question was punched on the way and the value is in the response data");
  assert.deepEqual(visibleQuestions(d, page(live, nav), live, {}).map((q) => q.id), ["q3"]);

  const tester = createResponseState(d, { seed: 1 });
  nav = start(d, tester, {}, { revealHidden: true });
  setAnswer(d, tester, "q1", "adidas");
  nav = advance(d, tester, {}, { fromPageId: "p1", revealHidden: true });
  const p2 = page(tester, nav);
  assert.equal(p2.pageId, "p2", "programmer view: the hidden question's page is shown");
  assert.deepEqual(visibleQuestions(d, p2, tester, {}).map((q) => q.id), [], "the respondent's set on that page is still empty");
  assert.deepEqual(visibleQuestions(d, p2, tester, {}, { revealHidden: true }).map((q) => q.id), ["q2"]);
  assert.equal(tester.answers.q2, "adidas", "the same punch, the same stored value");

  /* Back and resume honour the same view */
  nav = advance(d, tester, {}, { fromPageId: "p2", revealHidden: true });
  assert.equal(page(tester, nav).pageId, "p3");
  nav = goBack(d, tester, {}, { revealHidden: true });
  assert.equal(page(tester, nav).pageId, "p2");
  nav = goBack(d, tester, {});
  assert.equal(page(tester, nav).pageId, "p1", "the respondent's Back skips the hidden-only page");
  const resumed = createResponseState(d, { seed: 1 });
  resumed.answers.q1 = "adidas";
  nav = resumeAt(d, resumed, {}, 1, { revealHidden: true });
  assert.equal(page(resumed, nav).pageId, "p2");
  nav = resumeAt(d, resumed, {}, 1);
  assert.equal(page(resumed, nav).pageId, "p3");
});

test("a hidden required question never blocks Next: it is not in the respondent's validated set", () => {
  const d = def();
  const st = createResponseState(d, { seed: 1 });
  start(d, st, {}, { revealHidden: true });
  setAnswer(d, st, "q1", "nike"); // the punch does not fire → q2 stays unanswered
  const nav = advance(d, st, {}, { fromPageId: "p1", revealHidden: true });
  const p2 = nav.steps[st.stepIndex] as Extract<ReturnType<typeof compileFlow>[number], { kind: "page" }>;
  assert.equal(p2.pageId, "p2");
  const respondentSet = visibleQuestions(d, p2, st, {});
  assert.deepEqual(validatePage(d, respondentSet, { def: d, state: st, loop: null }), [], "nothing to validate — the required hidden question does not block");
  const shown = visibleQuestions(d, p2, st, {}, { revealHidden: true });
  assert.ok(validatePage(d, shown, { def: d, state: st, loop: null }).length > 0, "(the programmer's set WOULD fail — which is why the Runner validates the respondent's)");
});

test("explainAutoPunch: waiting → applied (green codes, selected answer, TRUE) → no matching condition; manual pick is not green", () => {
  const d = def();
  const st = createResponseState(d, { seed: 1 });
  const q2 = d.questions[1];
  const ctx = { def: d, state: st, loop: null };

  let x = explainAutoPunch(d, q2, ctx)!;
  assert.equal(x.status, "waiting", "Q1 unanswered: waiting for condition");
  assert.deepEqual(x.punchedCodes, []);
  assert.equal(x.rules.length, 1);
  assert.equal(x.rules[0].result, false);
  assert.equal(x.rules[0].target, "Q2");
  assert.deepEqual(x.rules[0].sourceQuestions, ["Q1"]);
  assert.match(x.rules[0].condition, /Q1/);
  assert.deepEqual(x.rules[0].selected, ["Adidas"], "labels, with the HTML stripped");

  setAnswer(d, st, "q1", "adidas");
  punchDerivedQuestions(d, st, {});
  x = explainAutoPunch(d, q2, ctx)!;
  assert.equal(x.status, "applied");
  assert.deepEqual(x.punchedCodes, ["adidas"]);
  assert.equal(x.selectedAnswer, "Adidas");
  assert.equal(x.rules[0].result, true);
  assert.equal(x.rules[0].status, "applied");

  setAnswer(d, st, "q1", "nike");
  punchDerivedQuestions(d, st, {});
  x = explainAutoPunch(d, q2, ctx)!;
  assert.equal(x.status, "none", "Q1 answered, no rule holds: no matching condition");
  assert.equal(st.answers.q2, undefined, "the stale punch was withdrawn");

  /* a manual selection on a punched question keeps the theme colour: it is not a punched code */
  st.answers.q2 = "puma";
  x = explainAutoPunch(d, q2, ctx)!;
  assert.deepEqual(x.punchedCodes, []);

  /* a question without answer-side rules has nothing to explain */
  assert.equal(explainAutoPunch(d, d.questions[0], ctx), null);
});

test("explainAutoPunch: failed when the rule holds but the answer does not carry the punched value; else-chain details say not reached", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "h2b", code: "H2B", title: "Hidden", version: "1.0" },
    questions: [
      Q("q1"),
      Q("q2", { settings: { hidden: true }, punches: [
        punch("q2", "q1", "adidas", ["adidas"], { id: "r1" }),
        punch("q2", "q1", "nike", ["nike"], { id: "r2", mode: "else_if" }),
        { id: "r3", mode: "else", source: { kind: "codes", codes: ["puma"] }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "always" },
      ] }),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
  });
  const st = createResponseState(d, { seed: 1 });
  const ctx = { def: d, state: st, loop: null };
  st.answers.q1 = "adidas"; // answered, but nothing ran the punch yet
  let x = explainAutoPunch(d, d.questions[1], ctx)!;
  assert.equal(x.status, "failed", "the condition is TRUE and the value is not in the answer");
  assert.deepEqual(x.expectedCodes, ["adidas"]);
  assert.deepEqual(x.rules.map((r) => r.status), ["applied", "not_reached", "not_reached"]);
  assert.equal(x.rules[1].result, null);
  assert.equal(x.rules[2].condition, "otherwise");

  punchDerivedQuestions(d, st, {});
  x = explainAutoPunch(d, d.questions[1], ctx)!;
  assert.equal(x.status, "applied");

  st.answers.q1 = "puma";
  punchDerivedQuestions(d, st, {});
  x = explainAutoPunch(d, d.questions[1], ctx)!;
  assert.equal(x.status, "applied");
  assert.deepEqual(x.punchedCodes, ["puma"], "the ELSE branch");
  assert.deepEqual(x.rules.map((r) => r.result), [false, false, true]);
});

test("explainAutoPunch on a multi-select keeps manual and punched codes apart", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "h2c", code: "H2C", title: "Hidden", version: "1.0" },
    questions: [Q("q1"), Q("q2", { type: "multi_select", punches: [punch("q2", "q1", "adidas", ["adidas"], { recompute: "once" })] })],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
  });
  const st = createResponseState(d, { seed: 1 });
  st.answers.q1 = "adidas";
  st.answers.q2 = ["puma", "adidas"];
  const x = explainAutoPunch(d, d.questions[1], { def: d, state: st, loop: null })!;
  assert.equal(x.status, "applied");
  assert.deepEqual(x.punchedCodes, ["adidas"], "Puma was the respondent's own");
  assert.equal(x.selectedAnswer, "Adidas");
});

test("fingerprints change for options, punches, Hidden, logic — and not for text, labels or instructions", () => {
  const base = def().questions[1];
  const fp = questionConfigFingerprint(base);
  assert.equal(questionConfigFingerprint({ ...base, text: "Different wording", instruction: "note" }), fp, "wording is not configuration");
  const q = (patch: Record<string, unknown>) => ({ ...base, ...patch }) as typeof base;
  assert.equal(questionConfigFingerprint(q({ options: base.options.map((o) => ({ ...o, label: `${o.label}!` })) })), fp, "a label edit keeps the answer valid");
  assert.notEqual(questionConfigFingerprint(q({ settings: { ...base.settings, hidden: false } })), fp, "Hidden");
  assert.notEqual(questionConfigFingerprint(q({ options: [...base.options, { code: "reebok", label: "Reebok", flags: [] }] })), fp, "an option");
  assert.notEqual(questionConfigFingerprint(q({ punches: [punch("q2", "q1", "adidas", ["puma"])] })), fp, "the punch target");
  assert.notEqual(questionConfigFingerprint(q({ punches: [punch("q2", "q1", "nike", ["adidas"])] })), fp, "the punch condition");
  assert.notEqual(questionConfigFingerprint(q({ displayLogic: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: "nike" } })), fp, "display logic");
  assert.notEqual(questionConfigFingerprint({ ...base, settings: { ...base.settings, defaultValue: "nike" } }), fp, "a default value");
  assert.match(fp, /^[0-9a-f]{8}$/);
});

test("stale preview (A66): a changed punch target drops Q2's stored value and keeps Q1 and Q3; plain navigation drops nothing", () => {
  const before = def();
  const stored = configFingerprints(before);
  const answers: Record<string, unknown> = { q1: "adidas", q2: "adidas", q2__other__x: "t", "q2@apple": "adidas", q3: "puma" };

  /* nothing changed → nothing invalidated */
  let r = invalidateStalePreviewAnswers(before, { ...answers }, stored);
  assert.deepEqual(r.invalidated, []);
  assert.deepEqual(r.removedKeys, []);

  /* the programmer changes the punch target to Puma and reopens the preview */
  const after = def();
  after.questions[1].punches = [punch("q2", "q1", "adidas", ["puma"])] as never;
  const a2 = { ...answers };
  r = invalidateStalePreviewAnswers(after, a2, stored);
  assert.deepEqual(r.changed, ["q2"]);
  assert.deepEqual(r.invalidated, ["q2"]);
  assert.deepEqual(Object.keys(a2).sort(), ["q1", "q3"], "every key of q2 (bare, side keys, loop keys) is gone; q1 and q3 are kept");

  /* re-evaluating from the new configuration gives the new value */
  const st = createResponseState(after, { seed: 1 });
  Object.assign(st.answers, a2);
  punchDerivedQuestions(after, st, {});
  assert.equal(st.answers.q2, "puma");

  /* a snapshot from before fingerprints existed is left alone */
  assert.deepEqual(invalidateStalePreviewAnswers(after, { ...answers }, undefined).invalidated, []);
});

test("stale preview: a change to the SOURCE question also drops the punched questions that read it, transitively, and nothing else", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "h2d", code: "H2D", title: "Hidden", version: "1.0" },
    questions: [
      Q("q1"),
      Q("q2", { settings: { hidden: true }, punches: [punch("q2", "q1", "adidas", ["adidas"])] }),
      Q("q3", { punches: [punch("q3", "q2", "adidas", ["adidas"])] }),
      Q("q4"),
      Q("q5", { punches: [punch("q5", "q4", "nike", ["nike"])] }),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5"] }, { type: "end", id: "e", status: "complete" }],
  });
  const stored = configFingerprints(d);
  const changed = SurveyDefinition.parse(JSON.parse(JSON.stringify(d)));
  changed.questions[0].options = changed.questions[0].options.filter((o) => o.code !== "puma"); // Q1 loses an option
  const answers: Record<string, unknown> = { q1: "adidas", q2: "adidas", q3: "adidas", q4: "nike", q5: "nike" };
  const r = invalidateStalePreviewAnswers(changed, answers, stored);
  assert.deepEqual(r.changed, ["q1"]);
  assert.deepEqual([...r.invalidated].sort(), ["q1", "q2", "q3"], "q2 reads q1, q3 reads q2; q4 and q5 are unrelated");
  assert.deepEqual(Object.keys(answers).sort(), ["q4", "q5"]);

  /* a deleted question's stored answer goes too */
  const shorter = SurveyDefinition.parse({ ...JSON.parse(JSON.stringify(d)), questions: d.questions.slice(0, 4) });
  const a2: Record<string, unknown> = { q1: "adidas", q5: "nike" };
  const r2 = invalidateStalePreviewAnswers(shorter, a2, stored);
  assert.deepEqual(r2.changed, ["q5"]);
  assert.deepEqual(Object.keys(a2), ["q1"]);
});

/* ---------------------------------------------------- Intelligent Mode (item 7) */

test("copilot: update_question { hidden } sets settings.hidden; Read Only is a no-op that says so", () => {
  const d = def();
  const coerced = coerceSurveyActions([{ op: "update_question", target: "Q1", hidden: true, readOnly: true }]);
  assert.equal(coerced.actions.length, 1);
  const r = applySurveyActions(d, coerced.actions);
  assert.deepEqual(r.errors, []);
  assert.equal(r.def.questions[0].settings.hidden, true);
  assert.equal(r.def.questions[0].settings.readOnly, false, "Read Only is never applied");
  assert.match(r.results[0].description, /hidden from respondents/);
  assert.match(r.results[0].description, /Read Only not applied/);

  const back = applySurveyActions(r.def, coerceSurveyActions([{ op: "update_question", target: "Q1", hidden: false }]).actions);
  assert.equal(back.def.questions[0].settings.hidden, false);
  assert.match(back.results[0].description, /shown to respondents/);

  /* Read Only on its own is refused with the reason, not silently accepted */
  const only = coerceSurveyActions([{ op: "update_question", target: "Q1", readOnly: true }]);
  assert.equal(only.actions.length, 0);
  assert.match(only.rejected.map((x) => x.reason).join(" "), /Read Only is no longer a question state/);
});
