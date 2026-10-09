import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { coverageReport, questionRelevance, relevanceSummary, removalSet } from "./relevance.js";
import { interpretRequest, type Interpretation } from "./nlIntent.js";
import { applySurveyActions } from "./surveyActions.js";

/*
 * RESEARCH RELEVANCE (Phase 3.3): every question scored by what it serves
 * and what reads it; "make it shorter without losing the objectives" is a
 * removal set of the unconnected questions nothing reads, with a target
 * reaching into the supporting ones and never the essential ones; the
 * audience is recorded by sentence and carried to the model.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const rule = (ref: string, operator: string, value: unknown) => ({ type: "rule", source: { kind: "question", ref }, operator, value });
function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "Brand switching" },
    research: { objective: "Understand why customers switch from Brand A to Brand B", hypotheses: ["Price perception drives switching", "Service satisfaction reduces switching"], constructs: [{ name: "Price perception", role: "independent", questionIds: ["q6"] }], kpis: [{ name: "Switching rate", variable: "SWITCHED" }], analysis: [], assumptions: [], sources: [] },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?", skipLogic: [{ id: "s1", when: rule("AGE", "lt", 18), target: { kind: "terminate", status: "screened" } }] },
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
      { id: "q3", code: "Q3", variableName: "BRAND_PREF", type: "single_select", text: "Which brand do you prefer?", options: opts("Brand A", "Brand B"), analysis: { role: "dependent", hypotheses: ["H1"] } },
      { id: "q4", code: "Q4", variableName: "SWITCHED", type: "single_select", text: "Have you switched brands?", options: opts("Yes", "No") },
      { id: "q5", code: "Q5", variableName: "REASONS", type: "multi_select", text: "Why did you switch?", options: opts("Price", "Quality") },
      { id: "q6", code: "Q6", variableName: "PRICE_PERC", type: "single_select", text: "Brand B offers better value", options: opts("Disagree", "Agree") },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "How satisfied are you with your current brand?", options: opts("1", "2", "3"), analysis: { hypotheses: ["H2"] } },
      { id: "q8", code: "Q8", variableName: "PETS", type: "single_select", text: "Do you have pets?", options: opts("Yes", "No") },
      { id: "q9", code: "Q9", variableName: "PET_TYPE", type: "single_select", text: "What kind of pet?", options: opts("Dog", "Cat"), displayLogic: rule("PETS", "eq", 1) },
      { id: "q10", code: "Q10", variableName: "COLOUR", type: "single_select", text: "Favourite colour?", options: opts("Red", "Blue") },
      { id: "q11", code: "Q11", variableName: "COMMENTS", type: "open_text", text: "Anything else?" },
    ],
    flow: [{ type: "page", id: "p1", title: "p", questionIds: ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10", "q11"] }, { type: "end", id: "e", status: "complete" }],
  });
}
const actionsOf = (r: Interpretation) => { assert.equal(r.kind, "actions", JSON.stringify(r)); return r as Extract<Interpretation, { kind: "actions" }>; };

test("relevance: tiers, scores, reasons and readers", () => {
  const all = questionRelevance(survey());
  const by = Object.fromEntries(all.map((x) => [x.question.code, x]));
  assert.equal(relevanceSummary(all), "5 essential, 2 supporting, 4 unconnected (Q8, Q9, Q10, Q11)");
  assert.equal(by.Q1.tier, "essential"); assert.match(by.Q1.reasons[0], /selects the sample/);
  assert.equal(by.Q3.tier, "essential"); assert.match(by.Q3.reasons[0], /measures H1 \(tagged\)/);
  assert.equal(by.Q6.tier, "essential"); assert.match(by.Q6.reasons[0], /measures H1 through “Price perception”/);
  assert.equal(by.Q4.tier, "essential"); assert.match(by.Q4.reasons[0], /KPI “Switching rate”/);
  assert.equal(by.Q7.tier, "essential"); assert.match(by.Q7.reasons[0], /measures H2/);
  assert.equal(by.Q2.tier, "supporting"); assert.match(by.Q2.reasons[0], /demographic/);
  assert.equal(by.Q5.tier, "supporting"); assert.match(by.Q5.reasons[0], /objective's words/);
  assert.equal(by.Q8.tier, "unconnected", "nothing in the design reads it"); assert.deepEqual(by.Q8.readers, ["Q9 — display logic"], "…but Q9's display logic does, so it is held, not free");
  assert.equal(by.Q8.score, 1);
  assert.equal(by.Q9.tier, "unconnected"); assert.equal(by.Q10.tier, "unconnected"); assert.equal(by.Q11.tier, "unconnected");
  assert.ok(by.Q6.score > by.Q3.score && by.Q3.score > by.Q2.score && by.Q2.score > by.Q9.score);
  assert.ok(questionRelevance({ ...survey(), research: undefined }).filter((x) => x.tier === "essential").every((x) => x.question.code === "Q1"), "no design: nothing is essential but the screener");
});

test("removalSet: the free unconnected questions, then supporting ones to reach a target, never the essential; held ones listed", () => {
  const def = survey();
  const base = removalSet(def);
  assert.deepEqual(base.remove.map((x) => x.question.code), ["Q11", "Q10", "Q9"], "lowest first, latest first among equals");
  assert.deepEqual(base.held.map((x) => x.question.code), ["Q8"], "unconnected, but Q9's logic reads it");
  assert.equal(base.kept.length, 8);
  const to6 = removalSet(def, { questions: 6 });
  assert.deepEqual(to6.remove.map((x) => x.question.code), ["Q11", "Q10", "Q9", "Q5", "Q2"], "the supporting ones go, lowest first; Q8 stays (read by Q9's logic)");
  assert.equal(to6.short, undefined);
  const to3 = removalSet(def, { questions: 3 });
  assert.match(to3.short ?? "", /6 questions remain .* not proposed/, "the five essential ones and the held Q8");
  assert.ok(to3.remove.every((x) => x.tier !== "essential"));
  const minutes = removalSet(def, { minutes: 1 });
  assert.equal(minutes.target?.minutes, 1);
  assert.ok(minutes.remove.length >= 3);
  // an unconnected question read by logic is held, not removed
  const held = survey();
  held.questions.find((q) => q.id === "q11")!.displayLogic = rule("COLOUR", "eq", 1) as never;
  const h = removalSet(held);
  assert.deepEqual(h.remove.map((x) => x.question.code), ["Q11", "Q9"]);
  assert.deepEqual(h.held.map((x) => x.question.code), ["Q8", "Q10"]);
  assert.deepEqual(h.held[1].readers, ["Q11 — display logic"]);
});

test("the sentences: shorten, remove the unnecessary, a target, nothing to remove, no design", () => {
  const def = survey();
  for (const t of ["Make the questionnaire shorter without losing the important research objectives.", "Remove the unnecessary questions", "Delete the questions that are not related to the research objective", "Shorten the survey", "Cut the survey down while keeping the hypotheses testable"]) {
    const a = actionsOf(interpretRequest(def, t));
    assert.deepEqual(a.actions.map((x) => (x as { target: string }).target), ["Q11", "Q10", "Q9"], t);
    assert.match(a.understood, /Remove 3 questions that serve nothing in the research design: Q11 .*5 essential questions stay \(Q1, Q3, Q4, Q6, Q7\)/);
    assert.match(a.understood, /Q8 is also unconnected but read by Q9 — remove that logic first, or keep it/);
    assert.ok(a.detected.some((d) => d.what === "relevance" && /5 essential, 2 supporting, 4 unconnected/.test(d.value)));
    const out = applySurveyActions(def, a.actions);
    assert.ok(out.valid && out.def.questions.length === 8);
  }
  const target = actionsOf(interpretRequest(def, "Shorten the survey to 6 questions"));
  assert.equal(target.actions.length, 5);
  const by = actionsOf(interpretRequest(def, "Shorten the questionnaire by 4 questions"));
  assert.equal(by.actions.length, 4);
  const held = survey();
  held.questions.find((q) => q.id === "q11")!.displayLogic = rule("COLOUR", "eq", 1) as never;
  const h = actionsOf(interpretRequest(held, "Remove the unnecessary questions"));
  assert.match(h.understood, /Q8 is also unconnected but read by Q9 — remove that logic first, or keep it; Q10 is also unconnected but read by Q11/);
  const tight = survey();
  tight.questions = tight.questions.filter((q) => !["q8", "q9", "q10", "q11"].includes(q.id));
  (tight.flow[0] as unknown as { questionIds: string[] }).questionIds = tight.questions.map((q) => q.id);
  const none = interpretRequest(tight, "Remove the unnecessary questions");
  assert.equal(none.kind, "refused");
  assert.match((none as { reason: string }).reason, /Every question serves the design or the sample: 5 essential, 2 supporting, 0 unconnected\./);
  const heldOnly = survey();
  heldOnly.questions = heldOnly.questions.filter((q) => !["q10", "q11"].includes(q.id));
  (heldOnly.flow[0] as unknown as { questionIds: string[] }).questionIds = heldOnly.questions.map((q) => q.id);
  heldOnly.questions.find((q) => q.id === "q9")!.analysis = { hypotheses: ["H2"] } as never;
  const onlyHeld = interpretRequest(heldOnly, "Remove the unnecessary questions");
  assert.equal(onlyHeld.kind, "refused");
  assert.match((onlyHeld as { reason: string }).reason, /Q8 is connected to nothing but read by Q9 — remove that logic first/);
  const bare = survey();
  bare.research = undefined;
  const noDesign = interpretRequest(bare, "Make the questionnaire shorter");
  assert.equal(noDesign.kind, "refused");
  assert.match((noDesign as { reason: string }).reason, /no research design to measure the questions against/);
  const which = interpretRequest(def, "Which questions could be removed?");
  assert.equal(which.kind, "answer", JSON.stringify(which));
  const w = which as Extract<Interpretation, { kind: "answer" }>;
  assert.match(w.answer, /Q8, Q9, Q10, Q11 serve nothing in the research design \(Q8 read by logic\)/);
  assert.deepEqual(w.sections.map((s) => s.items.length), [4, 2, 5]);
  assert.equal(interpretRequest(def, "Which questions are the least important?").kind, "answer");
});

test("the audience: recorded by sentence, carried in the design; an adaptation request goes to the model with what the engine can do first", () => {
  const def = survey();
  const set = actionsOf(interpretRequest(def, "Set the audience to first-time smartphone buyers"));
  assert.deepEqual(set.actions, [{ op: "set_research", audience: { description: "First-time smartphone buyers" } }]);
  const after = applySurveyActions(def, set.actions).def;
  assert.equal(after.research!.audience?.description, "First-time smartphone buyers");
  assert.ok((interpretRequest(after, "The audience is first-time smartphone buyers") as { noop?: boolean }).noop, "already recorded");
  const adapt = interpretRequest(def, "Make this survey more suitable for first-time smartphone buyers and remove unnecessary questions.");
  assert.equal(adapt.kind, "model", JSON.stringify(adapt));
  const m = adapt as Extract<Interpretation, { kind: "model" }>;
  assert.equal(m.category, "question_modification");
  assert.match(m.reason, /adapting the wording for first-time smartphone buyers is writing/);
  assert.deepEqual(m.fallback?.choices.map((c) => c.text), ['Set the audience to "first-time smartphone buyers"', "Remove the unnecessary questions"]);
  assert.ok(m.detected.some((d) => d.what === "audience"));
  const recordedAlready = interpretRequest(after, "Adapt the questionnaire for first-time smartphone buyers") as Extract<Interpretation, { kind: "model" }>;
  assert.equal(recordedAlready.fallback, undefined, "nothing for the engine to do first: the audience is recorded and no removal was asked");
  // each choice is a sentence the engine reads
  assert.equal(interpretRequest(def, m.fallback!.choices[0].text).kind, "actions");
  assert.equal(interpretRequest(def, m.fallback!.choices[1].text).kind, "actions");
});

test("coverageReport: a generated survey is connected when every hypothesis is measured and every question serves something", () => {
  const def = survey();
  const c = coverageReport(def);
  assert.equal(c.ok, false);
  assert.deepEqual(c.unmeasured, [], "H1 through Price perception and the tag, H2 through its tag");
  assert.deepEqual(c.unconnected.map((q) => q.code), ["Q8", "Q9", "Q10", "Q11"], "demographics are exempt, these are not");
  assert.match(c.summary, /Q8, Q9, Q10, Q11 serve no hypothesis, construct, plan item or KPI/);
  const loose = survey();
  loose.research!.hypotheses.push("Awareness drives consideration");
  const c2 = coverageReport(loose);
  assert.deepEqual(c2.unmeasured, ["H3"]);
  assert.match(c2.summary, /H3 has no question that measures it; Q8, Q9/);
  const tight = survey();
  tight.questions = tight.questions.filter((q) => !["q8", "q9", "q10", "q11"].includes(q.id));
  (tight.flow[0] as unknown as { questionIds: string[] }).questionIds = tight.questions.map((q) => q.id);
  const c3 = coverageReport(tight);
  assert.equal(c3.ok, true);
  assert.equal(c3.summary, "every hypothesis measured (H1, H2); every question serves the design or the sample");
  const noDesign = coverageReport({ ...tight, research: undefined });
  assert.equal(noDesign.ok, false, "with no design nothing but the screener serves anything");
  assert.match(noDesign.summary, /Q3, Q4, Q5, Q6, Q7 serve no hypothesis/);
});
