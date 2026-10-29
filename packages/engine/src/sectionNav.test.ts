import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, type ResponseState } from "./state.js";
import { start, advance, goBack, setAnswer, visitedPages, type NavigationResult } from "./flow.js";
import { goToPage, sectionOutline, submitGate, sectionNavMode, resolveNavTarget } from "./sectionNav.js";
import { checkSubmission } from "./serverValidation.js";
import { compileFlow } from "./flow.js";

/**
 * NATIVE SECTION NAVIGATION (2026-10-30): one rule for the navigator, the
 * script API and the save route's replay.
 */
const yesNo = [{ code: "1", label: "Yes" }, { code: "2", label: "No" }];
const q = (id: string, extra: Record<string, unknown> = {}) => ({
  id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: id, options: yesNo, required: true, ...extra,
});
const paper = (navigation?: Record<string, unknown>, more: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "nav", code: "NAV", title: "Paper", version: "1" },
  questions: [q("q1"), q("q2"), q("q3"), q("q4"), q("q5", { required: false }), q("q6")],
  flow: [
    { type: "block", id: "b_hist", title: "History", children: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "page", id: "p2", questionIds: ["q2"] },
    ] },
    { type: "block", id: "b_geo", title: "Geography", children: [
      { type: "page", id: "p3", questionIds: ["q3"] },
      { type: "page", id: "p_hidden", questionIds: ["q5"], visibleIf: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "2" } },
    ] },
    { type: "block", id: "b_pol", title: "Polity", children: [
      { type: "page", id: "p4", questionIds: ["q4"] },
      { type: "page", id: "p6", questionIds: ["q6"] },
    ] },
    { type: "end", id: "e", status: "complete" },
  ],
  ...(navigation ? { navigation } : {}),
  ...more,
});
const at = (r: Pick<NavigationResult, "steps" | "stepIndex">) => {
  const s = r.steps[r.stepIndex];
  return s?.kind === "page" ? s.pageId : s?.kind;
};
const walkTo = (def: SurveyDefinition, st: ResponseState, answers: Record<string, string>, stopAt: string) => {
  let nav = start(def, st);
  while (at(nav) !== stopAt) {
    const s = nav.steps[nav.stepIndex];
    if (s?.kind !== "page") throw new Error("ran off");
    for (const id of s.questionIds) if (answers[id]) setAnswer(def, st, id, answers[id], null);
    nav = advance(def, st, {}, { fromPageId: s.pageId });
  }
  return nav;
};

test("the setting defaults to off, and off refuses forward jumps but allows Back-like jumps", () => {
  const def = paper();
  assert.equal(sectionNavMode(def), "off");
  const st = createResponseState(def);
  walkTo(def, st, { q1: "1", q2: "1" }, "p3");
  const fwd = goToPage(def, st, "b_pol");
  assert.equal(fwd.ok, false);
  assert.equal(fwd.refusal, "forward_locked");
  assert.equal(at(compileFlowResult(def, st)), "p3", "a refusal leaves the respondent where they were");
  const back = goToPage(def, st, "History", {}, {}, { as: "section" });
  assert.equal(back.ok, true);
  assert.equal(back.via, "back");
  assert.equal(at(back), "p1");
});

test("off + Back hidden: no jump at all", () => {
  const def = paper(undefined, { branding: { buttons: { showBack: false } } });
  const st = createResponseState(def);
  walkTo(def, st, { q1: "1", q2: "1" }, "p3");
  assert.equal(goToPage(def, st, "b_hist").refusal, "back_disabled");
});

test("visited mode: backward jump, then Back returns to the page before the target in the trail", () => {
  const def = paper({ sectionNav: "visited" });
  const st = createResponseState(def);
  walkTo(def, st, { q1: "1", q2: "1", q3: "1" }, "p4");
  assert.deepEqual(visitedPages(st), ["p1", "p2", "p3"]);
  const r = goToPage(def, st, "p2");
  assert.equal(r.ok, true);
  assert.equal(at(r), "p2");
  assert.deepEqual(visitedPages(st), ["p1"]);
  assert.equal(at(goBack(def, st)), "p1");
});

test("visited mode: a forward jump to a section never visited is refused; to a visited one it walks Next", () => {
  const def = paper({ sectionNav: "visited" });
  const st = createResponseState(def);
  walkTo(def, st, { q1: "1", q2: "1", q3: "1" }, "p4");
  assert.equal(goToPage(def, st, "b_hist").ok, true);
  // Polity was visited (p4 was the current page) → forward allowed, every page between validates
  const r = goToPage(def, st, "b_pol");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.via, "visited");
  assert.equal(at(r), "p4");
  assert.equal(at(goBack(def, st)), "p3", "Back after a visited jump is the previous page on the path");
  // p6 never visited
  const st2 = createResponseState(def);
  walkTo(def, st2, { q1: "1" }, "p2");
  const ref = goToPage(def, st2, "b_geo");
  assert.equal(ref.ok, false);
  assert.equal(ref.refusal, "forward_locked");
});

test("visited mode: a visited forward jump over a page made incomplete is refused with the reason", () => {
  const def = paper({ sectionNav: "visited" });
  const st = createResponseState(def);
  walkTo(def, st, { q1: "1", q2: "1", q3: "1" }, "p4");
  goToPage(def, st, "p1");
  setAnswer(def, st, "q2", null as never, null);
  const r = goToPage(def, st, "p4");
  assert.equal(r.ok, false);
  assert.equal(r.refusal, "incomplete");
  assert.equal(r.pageId, "p2");
  assert.equal(at(compileFlowResult(def, st)), "p1");
});

test("free mode: a forward jump skips unanswered pages; the Submit gate lists them per section", () => {
  const def = paper({ sectionNav: "free" });
  const st = createResponseState(def);
  start(def, st);
  const r = goToPage(def, st, "Polity");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.via, "free");
  assert.equal(at(r), "p4");
  assert.equal(at(goBack(def, st)), "p1", "Back after a free jump returns to the page jumped from");
  goToPage(def, st, "p6");
  setAnswer(def, st, "q6", "1", null);
  const gate = submitGate(def, st);
  assert.equal(gate.finishing, true);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.missing.map((m) => m.questionId), ["q1", "q2", "q3", "q4"]);
  assert.deepEqual(gate.bySection.map((g) => [g.sectionTitle, g.count]), [["History", 2], ["Geography", 1], ["Polity", 1]]);
  // not finishing on an earlier page
  goToPage(def, st, "p3");
  assert.equal(submitGate(def, st).finishing, false);
});

test("free mode: the outline reports visited / current / answered x of y / locked", () => {
  const def = paper({ sectionNav: "free" });
  const st = createResponseState(def);
  walkTo(def, st, { q1: "1", q2: "1" }, "p3");
  const o = sectionOutline(def, st);
  assert.deepEqual(o.map((s) => [s.title, s.current, s.visited, `${s.answered}/${s.total}`, s.locked]), [
    ["History", false, true, "2/2", false],
    ["Geography", true, true, "0/1", false],
    ["Polity", false, false, "0/2", false],
  ]);
  const v = sectionOutline(def, st, {}, { mode: "visited" });
  assert.equal(v[2].locked, true);
});

test("a page hidden by logic is refused as hidden, an unknown target as not found", () => {
  const def = paper({ sectionNav: "free" });
  const st = createResponseState(def);
  walkTo(def, st, { q1: "1" }, "p2");
  assert.equal(goToPage(def, st, "p_hidden").refusal, "hidden");
  assert.equal(goToPage(def, st, "nope").refusal, "not_found");
  // a question code resolves to its page
  assert.equal(at(goToPage(def, st, "Q3")), "p3");
});

test("free mode never jumps past an end, a quota check, or a firing skip rule", () => {
  const base = paper({ sectionNav: "free" });
  const withEnd = SurveyDefinition.parse({
    ...base,
    flow: [base.flow[0], { type: "end", id: "e_scr", status: "screened" }, base.flow[1], base.flow[2], base.flow[3]],
  });
  const st = createResponseState(withEnd);
  start(withEnd, st);
  const r = goToPage(withEnd, st, "b_pol");
  assert.equal(r.ok, false);
  assert.equal(r.refusal, "blocked_by_end");

  const withQuota = SurveyDefinition.parse({
    ...base,
    quotas: [{ id: "qa", name: "A", cells: [] }],
    flow: [base.flow[0], { type: "quota_check", id: "qc", quotaIds: ["qa"], onFull: { kind: "terminate" } }, base.flow[1], base.flow[2], base.flow[3]],
  });
  const st2 = createResponseState(withQuota);
  start(withQuota, st2);
  assert.equal(goToPage(withQuota, st2, "b_geo").refusal, "blocked_by_quota");

  const withSkip = SurveyDefinition.parse({
    ...base,
    questions: base.questions.map((x) => x.id === "q1" ? { ...x, skipLogic: [{ id: "s", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "2" }, target: { kind: "end" } }] } : x),
  });
  const st3 = createResponseState(withSkip);
  start(withSkip, st3);
  setAnswer(withSkip, st3, "q1", "2", null);
  assert.equal(goToPage(withSkip, st3, "b_geo").refusal, "skip_logic");
});

test("loops: only iterations that exist are targets", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "lp", code: "LP", title: "Loop", version: "1" },
    navigation: { sectionNav: "free" },
    questions: [
      { id: "brands", code: "BR", variableName: "BR", type: "multi_select", text: "Brands", options: [{ code: "a", label: "Apple" }, { code: "g", label: "Google" }, { code: "m", label: "Meta" }], required: true },
      { id: "rate", code: "RT", variableName: "RT", type: "single_select", text: "Rate {{loop.label}}", options: yesNo },
    ],
    flow: [
      { type: "block", id: "b1", title: "Intro", children: [{ type: "page", id: "p1", questionIds: ["brands"] }] },
      { type: "block", id: "b2", title: "Ratings", children: [
        { type: "loop", id: "lp", loopVar: "brand", source: { kind: "question", questionId: "brands", filter: "selected" }, children: [{ type: "page", id: "pr", questionIds: ["rate"] }] },
      ] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
  const st = createResponseState(def);
  start(def, st);
  setAnswer(def, st, "brands", ["a", "g"], null);
  const steps = compileFlow(def, st);
  assert.ok(resolveNavTarget(def, steps, "pr@g") > 0);
  assert.equal(goToPage(def, st, "pr@m").ok, false, "Meta was not chosen — its iteration does not exist");
  const r = goToPage(def, st, "pr@g");
  assert.equal(r.ok, true, r.reason);
  assert.equal(at(r), "pr@g");
});

test("assessment: unanswered = unattempted — the gate asks to confirm instead of refusing", () => {
  const def = paper({ sectionNav: "free" }, { assessment: { enabled: true } });
  const st = createResponseState(def);
  start(def, st);
  goToPage(def, st, "p6");
  setAnswer(def, st, "q6", "1", null);
  const gate = submitGate(def, st);
  assert.equal(gate.finishing, true);
  assert.equal(gate.assessment, true);
  assert.equal(gate.ok, true);
  assert.equal(gate.needsConfirm, true);
  assert.equal(gate.unanswered, 4, "q5 sits on a page hidden by logic — not counted");
  assert.match(gate.message ?? "", /4 questions unanswered — submit anyway\?/);
});

test("server replay: accepts a free jump the engine allows, refuses the same payload without the setting", () => {
  const free = paper({ sectionNav: "free" });
  const st = createResponseState(free, { sessionId: "s".repeat(20), seed: 7 });
  start(free, st);
  goToPage(free, st, "p4");
  setAnswer(free, st, "q4", "1", null);
  const posted = { answers: st.answers, calculated: st.calculated, embedded: st.embedded, flags: st.flags, stepIndex: st.stepIndex, status: "in_progress" };
  const prior = { seed: 7, sessionId: "s".repeat(20) };
  const ok = checkSubmission({ def: free, prior, posted });
  assert.equal(ok.ok, true, JSON.stringify(ok.hard));
  assert.ok(ok.soft.some((p) => p.code === "skipped_required"));
  const strict = checkSubmission({ def: paper({ sectionNav: "visited" }), prior, posted });
  assert.equal(strict.ok, false, "visited mode cannot skip a required page");
  // completion: refused for a normal survey (the Submit gate would have refused), accepted for an assessment
  const done = { ...posted, status: "complete", completed: true };
  assert.equal(checkSubmission({ def: free, prior, posted: done }).ok, false);
  const exam = paper({ sectionNav: "free" }, { assessment: { enabled: true } });
  assert.equal(checkSubmission({ def: exam, prior, posted: done }).ok, true);
});

function compileFlowResult(def: SurveyDefinition, st: ResponseState) {
  return { steps: compileFlow(def, st), stepIndex: st.stepIndex };
}
