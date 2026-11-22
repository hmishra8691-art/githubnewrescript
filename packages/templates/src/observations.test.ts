import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "@rescript/engine";
import { observationLines, verifySurvey } from "./observations.js";

const base = () => SurveyDefinition.parse({
  meta: { id: "obs", code: "OBS", title: "Observations", version: "1.0" },
  questions: [
    { id: "own", code: "S1", variableName: "S1", type: "single_select", text: "Do you own a car?", options: [{ code: "y", label: "Yes" }, { code: "n", label: "No" }] },
    { id: "brand", code: "Q1", variableName: "Q1", type: "single_select", text: "Which brand?", options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }, { code: "c", label: "Gamma" }] },
    { id: "why", code: "Q2", variableName: "Q2", type: "single_select", text: "How satisfied are you with it?", options: [1, 2, 3, 4, 5].map((c) => ({ code: String(c), label: `Point ${c}` })) },
    { id: "age", code: "Q3", variableName: "Q3", type: "numeric", text: "How old are you?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["own"] }, { type: "page", id: "p2", questionIds: ["brand", "why"] }, { type: "page", id: "p3", questionIds: ["age"] }, { type: "end", id: "e", status: "complete" }],
});
const edited = (actions: SurveyAction[]) => { const r = applySurveyActions(base(), actions); assert.deepEqual(r.errors, []); return r.def; };
const sim = { count: 40, seed: 5, review: false } as const;

test("a sound survey: nothing observed, and what was checked is counted", () => {
  const v = verifySurvey(base(), sim);
  assert.equal(v.observations.filter((o) => o.severity !== "note").length, 0, JSON.stringify(v.observations.map((o) => o.message)));
  assert.ok(v.ok);
  assert.equal(v.simulated, true);
  assert.deepEqual([v.checked.simulatedRespondents, v.checked.questions, v.checked.questionsReached], [40, 4, 4]);
  assert.ok(v.checked.completed > 0);
});

test("a question whose display logic can never be true: the condition, what it reads, and respondents' answers to that", () => {
  const def = base();
  /* written by hand: the action layer refuses a code the question does not have */
  (def.questions[2] as { displayLogic?: unknown }).displayLogic = { type: "rule", source: { kind: "question", ref: "own" }, operator: "eq", value: "maybe" };
  const v = verifySurvey(SurveyDefinition.parse(def), sim);
  const o = v.observations.find((x) => x.kind === "never_shown");
  assert.ok(o, JSON.stringify(v.observations.map((x) => x.kind)));
  assert.equal(v.ok, false);
  assert.deepEqual(o!.where, { questionIds: ["why"], codes: ["Q2"], pageId: "p2" });
  assert.deepEqual(o!.condition!.reads, ["S1"]);
  assert.match(o!.condition!.text, /S1|own a car/i);
  assert.deepEqual(o!.seen, { count: 0, of: 40 });
  assert.ok(o!.respondents.length >= 1 && o!.respondents.length <= 3);
  for (const r of o!.respondents) { assert.match(r.code, /^SIM-/); assert.deepEqual(Object.keys(r.answers), ["S1"]); assert.ok(["y", "n"].includes(r.answers.S1 as string)); }
  assert.match(o!.message, /reached its page and its display logic hid it/);
  assert.match(o!.look, /reads S1/);
  assert.match(o!.look, /Check that it can be true at all/);
  assert.ok(observationLines(o!).some((l) => /simulated/.test(l)));
});

test("nobody completes: where they stopped and what they answered there", () => {
  const def = edited([{ op: "add_skip", from: "S1", when: "S1 = y", to: "screened" } as SurveyAction, { op: "add_skip", from: "S1", when: "S1 = n", to: "screened" } as SurveyAction]);
  const v = verifySurvey(def, sim);
  const o = v.observations.find((x) => x.kind === "nobody_completes");
  assert.ok(o, JSON.stringify(v.observations.map((x) => `${x.kind}: ${x.message}`)));
  assert.equal(o!.severity, "blocker");
  assert.equal(o!.where.pageId, "p1");
  assert.deepEqual(o!.where.codes, ["S1"]);
  assert.equal(v.checked.completed, 0);
  for (const r of o!.respondents) assert.ok("S1" in r.answers && r.lastPage === "p1");
  /* the questions after the screener were reached by nobody, and that is said too */
  assert.ok(v.observations.filter((x) => x.kind === "never_shown").length >= 3);
  assert.equal(v.observations[0]!.severity, "blocker");
});

test("an expectation that does not hold names the respondents it failed for", () => {
  const def = edited([{ op: "set_display_logic", target: "Q1", expression: "S1 = No" } as SurveyAction]);
  const v = verifySurvey(def, { ...sim, expectations: [{ id: "owners_see_brand", question: "brand", expect: "shown", when: { type: "rule", source: { kind: "question", ref: "own" }, operator: "eq", value: "y" } }] });
  const o = v.observations.find((x) => x.kind === "expectation_broken");
  assert.ok(o, JSON.stringify(v.observations.map((x) => x.kind)));
  assert.equal(o!.severity, "blocker");
  assert.ok(o!.seen!.count > 0 && o!.seen!.count === o!.seen!.of);
  assert.deepEqual(o!.condition!.reads, ["S1"]);
  for (const r of o!.respondents) assert.equal(r.answers.S1, "y");
  assert.equal(v.checked.expectations, 1);
});

test("the rule review's critical findings and mechanical fixes come through as observations", () => {
  const def = base();
  (def.questions[1] as { options: unknown[] }).options = [];
  const v = verifySurvey(SurveyDefinition.parse(def), { count: 10, seed: 2 });
  const fromReview = v.observations.filter((o) => o.source === "review");
  assert.ok(fromReview.length >= 1, JSON.stringify(v.observations.map((x) => `${x.source}/${x.kind}: ${x.message}`)));
  assert.ok(fromReview.every((o) => o.kind === "review_finding" && o.look.length > 5));
  assert.ok(v.checked.reviewFindings >= fromReview.length);
});

test("the path that failed: the answer that should show a question ends the interview first", () => {
  const def = edited([{ op: "set_display_logic", target: "Q2", expression: "S1 = No" } as SurveyAction, { op: "add_skip", from: "S1", when: "S1 = n", to: "screened" } as SurveyAction]);
  const v = verifySurvey(def, sim);
  const o = v.observations.find((x) => x.kind === "never_shown" && x.where.codes[0] === "Q2");
  assert.ok(o, JSON.stringify(v.observations.map((x) => x.message)));
  assert.match(o!.message, /answered so that it should show, and never reached it: \d+ ended screened after page p1/);
  assert.match(o!.look, /also end the interview or skip past it/);
  assert.ok(o!.respondents.length > 0);
  for (const r of o!.respondents) assert.deepEqual([r.answers.S1, r.endStatus, r.lastPage], ["n", "screened", "p1"]);
});
