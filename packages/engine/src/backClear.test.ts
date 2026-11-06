import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { start, advance, goBack, setAnswer } from "./flow.js";
import { applyScriptWrite } from "./scriptWrites.js";
import { goToPage } from "./sectionNav.js";

/**
 * WHAT BACK TAKES BACK (backClear.ts, 2026-11-05).
 *
 * Q1 on p1. A hidden SEGMENT on p2, punched ONCE from Q1 (the default rule): 1 → Low, 2 → High. Q2 on p2 and
 * Q3 on p3. Before this change SEGMENT kept its first value for the rest of the interview whatever Q1 became.
 */
const survey = () => SurveyDefinition.parse({
  meta: { id: "b", code: "B", title: "Back", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Band?", options: [{ code: "1", label: "One" }, { code: "2", label: "Two" }] },
    { id: "seg", code: "SEG", variableName: "SEG", type: "single_select", text: "", settings: { hidden: true }, options: [{ code: "L", label: "Low" }, { code: "H", label: "High" }],
      punches: [
        { id: "pl", source: { kind: "codes", codes: ["L"] }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "once", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "1" } },
        { id: "ph", source: { kind: "codes", codes: ["H"] }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "once", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "2" } },
      ] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Why?" },
    { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "Age" },
  ],
  flow: [
    { type: "embedded_data", id: "ed", fields: [{ name: "SOURCE", source: "url" }, { name: "P2_NOTE", source: "url" }] },
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["seg", "q2"] },
    { type: "page", id: "p3", questionIds: ["q3"] },
    { type: "end", id: "e", status: "complete" },
  ],
});
const at = (r: ReturnType<typeof advance>) => { const s = r.steps[r.stepIndex]; return s?.kind === "page" ? s.pageId : s?.kind; };

test("a once-punched hidden question is cleared by Back and re-punched from the new answer on the way forward", () => {
  const def = survey();
  const st = createResponseState(def);
  start(def, st);
  setAnswer(def, st, "q1", "1", null);
  assert.equal(at(advance(def, st)), "p2");
  assert.equal(st.answers.seg, "L");
  setAnswer(def, st, "q2", "because", null);
  assert.equal(at(advance(def, st)), "p3");
  assert.equal(at(goBack(def, st)), "p2");
  assert.equal(st.answers.seg, undefined, "landing on the hidden question's own page clears it");
  assert.equal(st.answers.q2, "because", "the respondent's own answer is kept");
  assert.equal(at(goBack(def, st)), "p1");
  assert.equal(st.answers.q1, "1", "the answer being revisited is kept");
  setAnswer(def, st, "q1", "2", null);
  assert.equal(at(advance(def, st)), "p2");
  assert.equal(st.answers.seg, "H", "re-derived from the changed answer — this used to stay L for good");
});

test("Back from p3 to p2 does not clear a hidden question whose rules read only pages still behind", () => {
  const def = SurveyDefinition.parse({
    ...survey(),
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "seg"] },
      { type: "page", id: "p2", questionIds: ["q2"] },
      { type: "page", id: "p3", questionIds: ["q3"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
  const st = createResponseState(def);
  start(def, st);
  setAnswer(def, st, "q1", "2", null);
  advance(def, st);
  assert.equal(st.answers.seg, "H");
  advance(def, st);
  assert.equal(at(goBack(def, st)), "p2");
  assert.equal(st.answers.seg, "H", "p1 is behind the respondent: nothing it derived is taken back");
  assert.equal(at(goBack(def, st)), "p1");
  assert.equal(st.answers.seg, undefined, "now p1 is ahead again");
});

test("a programmed defaultValue on a derived question is the programmer's and survives Back", () => {
  const base = survey();
  const def = SurveyDefinition.parse({
    ...base,
    questions: base.questions.map((q) => q.id === "seg" ? { ...q, settings: { ...q.settings, defaultValue: "L" } } : q),
  });
  const st = createResponseState(def);
  start(def, st);
  setAnswer(def, st, "q1", "2", null);
  advance(def, st);
  advance(def, st);
  goBack(def, st);
  goBack(def, st);
  assert.notEqual(st.answers.seg, undefined);
});

test("script writes made from the pages Back puts ahead are taken back; writes from behind and from the survey are kept", () => {
  const def = survey();
  const st = createResponseState(def);
  start(def, st);
  /* the survey-level on_load: no page */
  assert.ok(applyScriptWrite(def, st, { kind: "embedded", name: "SOURCE", value: "panel" }, { scriptId: "s0", scope: { kind: "survey" }, shown: [] }).ok);
  setAnswer(def, st, "q1", "1", null);
  /* p1's on_load wrote a calc */
  assert.ok(applyScriptWrite(def, st, { kind: "calculated", name: "FROM_P1", value: 1 }, { scriptId: "s1", scope: { kind: "page", pageId: "p1" }, shown: ["q1"], page: "p1" }).ok);
  advance(def, st);
  /* p2's on_load set the open end, a flag and an embedded */
  assert.ok(applyScriptWrite(def, st, { kind: "answer", ref: "Q2", value: "prefilled" }, { scriptId: "s2", scope: { kind: "question", questionId: "q2" }, shown: ["q2"], page: "p2" }).ok);
  assert.ok(applyScriptWrite(def, st, { kind: "flag", name: "SAW_P2" }, { scriptId: "s2", scope: { kind: "page", pageId: "p2" }, shown: ["q2"], page: "p2" }).ok);
  assert.ok(applyScriptWrite(def, st, { kind: "embedded", name: "P2_NOTE", value: "x" }, { scriptId: "s2", scope: { kind: "page", pageId: "p2" }, shown: ["q2"], page: "p2" }).ok);
  assert.equal(st.answers.q2, "prefilled");
  assert.ok(st.scriptWrites!.every((w) => w.script === "s0" || typeof w.page === "string"), "each page write records its page");
  advance(def, st);
  assert.equal(at(goBack(def, st)), "p2");
  assert.equal(st.answers.q2, undefined, "p2's script-set answer is gone — its on_load will set it afresh");
  assert.ok(!st.flags.includes("SAW_P2"));
  assert.equal(st.embedded.P2_NOTE, undefined);
  assert.equal(st.calculated.FROM_P1, 1, "p1 is behind: its write stays");
  assert.equal(st.embedded.SOURCE, "panel", "the survey-level write stays");
  assert.deepEqual(st.scriptWrites!.map((w) => w.script), ["s0", "s1"], "the taken-back writes leave the paradata too");
});

test("a backward section jump takes back the same things Back does", () => {
  const def = survey();
  const st = createResponseState(def);
  start(def, st);
  setAnswer(def, st, "q1", "1", null);
  advance(def, st);
  assert.equal(st.answers.seg, "L");
  advance(def, st);
  const r = goToPage(def, st, "p1", {}, {}, { as: "page" });
  assert.ok(r.ok);
  assert.equal(st.answers.seg, undefined);
});
