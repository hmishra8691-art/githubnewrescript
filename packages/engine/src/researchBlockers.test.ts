import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { newResearchBlockers, researchBlockers, researchStrict } from "./researchBlockers.js";
import { applySurveyActions, describeAction, type SurveyAction } from "./surveyActions.js";
import { reviewSurvey } from "./surveyReview.js";
import { interpretRequest, type Interpretation } from "./nlIntent.js";

/*
 * RESEARCH ENGINE AUDIT, PHASE 7 (§F ⑤) — research-level checks promoted
 * to blockers when the researcher asks. The gaps are the review's own; an
 * enforced design refuses a change that OPENS one, names it and the way to
 * close it, and lists the gaps it already has as blockers. Not enforced,
 * the same gaps are the warnings and critical findings they always were.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(strict?: boolean): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "T" },
    research: { objective: "O", hypotheses: ["Price perception drives switching", "Women are more satisfied than men"], hypothesisDetails: [{ type: "causal", direction: "positive", independent: "Price perception", dependent: "Switching" }, { type: "difference", direction: "positive", group: "women", lower: "men", dependent: "Satisfaction" }],
      constructs: [{ name: "Price perception", role: "independent", questionIds: ["q6"] }, { name: "Switching", role: "dependent", questionIds: ["q4"] }, { name: "Satisfaction", role: "dependent", questionIds: ["q7"] }, { name: "Gender", role: "control", questionIds: ["q2"] }],
      kpis: [{ name: "Satisfaction", variable: "SAT", measure: "top-2-box share" }], analysis: [], assumptions: [], sources: [], ...(strict !== undefined ? { strict } : {}),
      analysisPlan: { crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H2"] }], tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H2"] }, { id: "t2", method: "chi_square", outcome: "SWITCHED", variables: ["SWITCHED"], groupBy: "PRICE_PERC", priority: 1, hypotheses: ["H1"] }], derived: [], segments: [] } },
    questions: [
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "Gender?", options: opts("Male", "Female") },
      { id: "q4", code: "Q4", variableName: "SWITCHED", type: "single_select", text: "Switched?", options: opts("Yes", "No") },
      { id: "q6", code: "Q6", variableName: "PRICE_PERC", type: "single_select", text: "Value for money", options: opts("1", "2", "3", "4", "5") },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "Satisfied?", options: opts("1", "2", "3", "4", "5") },
      { id: "q9", code: "Q9", variableName: "REGION", type: "single_select", text: "Region?", options: opts("N", "S") },
    ],
    flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", title: "P", questionIds: ["q2", "q4", "q6", "q7", "q9"] }] }, { type: "end", id: "e", status: "complete" }],
  });
}
const actionsOf = (r: Interpretation) => { assert.equal(r.kind, "actions", JSON.stringify(r)); return r as Extract<Interpretation, { kind: "actions" }>; };

test("the gaps: none in a complete design; a deleted question opens an unmeasured construct, a dead plan reference and a dead KPI; a hypothesis nothing tests", () => {
  const def = survey();
  assert.deepEqual(researchBlockers(def), []);
  assert.equal(researchStrict(def), false);
  const without = applySurveyActions(def, [{ op: "delete_question", target: "Q7" }]).def;
  const gaps = researchBlockers(without);
  // the delete action prunes the plan's references to Q7 itself, so what is left open is the construct, the hypothesis and the KPI
  assert.deepEqual(gaps.map((g) => g.code).sort(), ["dead_kpi", "unmeasured_construct", "unmeasured_construct"]);
  assert.match(gaps.find((g) => g.code === "dead_kpi")!.message, /The KPI “Satisfaction” is read from SAT, which is not in the survey/);
  assert.match(gaps.find((g) => g.code === "unmeasured_construct")!.message, /^The dependent construct “Satisfaction” is measured by no question\.$/, "the delete pruned the construct's question id too");
  assert.match(gaps.find((g) => g.code === "unmeasured_construct")!.suggestion!, /Add a question that measures Satisfaction, or remove the construct/);
  assert.ok(gaps.some((g) => /^H2 cannot be tested: “Satisfaction” is measured by no question\.$/.test(g.message)), JSON.stringify(gaps));
  // a plan that reads what is not in the survey (an import, a JSON edit) is a dead reference
  const dead = SurveyDefinition.parse({ ...def, research: { ...def.research, analysisPlan: { ...def.research!.analysisPlan, crosstabs: [{ id: "x9", rows: ["GONE"], columns: ["GENDER"], priority: 1, hypotheses: [] }], tests: [{ id: "t9", method: "anova", outcome: "GONE", variables: ["GONE"], groupBy: "REGION", priority: 2, hypotheses: [] }] } } });
  const refs = researchBlockers(dead);
  assert.deepEqual(refs.map((g) => g.code), ["dead_plan_reference", "dead_plan_reference"]);
  assert.match(refs[0].message, /Planned crosstab x9 reads GONE, which is not in the survey/);
  assert.match(refs[1].message, /Planned anova reads GONE/);
  // only what a change opens is new
  assert.equal(newResearchBlockers(def, without).length, 3);
  assert.equal(newResearchBlockers(without, without).length, 0);
  // a hypothesis nothing tests
  const loose = SurveyDefinition.parse({ ...def, research: { ...def.research, hypotheses: [...def.research!.hypotheses, "The moon matters"], hypothesisDetails: [...def.research!.hypothesisDetails, {}] } });
  assert.deepEqual(researchBlockers(loose).map((g) => g.code), ["unlinked_hypothesis"]);
  assert.match(researchBlockers(loose)[0].message, /^H3 \(“The moon matters”\) names no construct/);
  // a derived variable built from what is gone
  const dd = SurveyDefinition.parse({ ...without, research: { ...without.research, analysisPlan: { ...without.research!.analysisPlan, derived: [{ name: "SAT_SCORE", kind: "mean_score", from: ["SAT"] }] } } });
  assert.ok(researchBlockers(dd).some((g) => g.code === "dead_derived"));
  // a KPI read from a derived variable or a calculation is not dead
  const viaDerived = SurveyDefinition.parse({ ...def, research: { ...def.research, kpis: [{ name: "Score", variable: "SAT_SCORE" }], analysisPlan: { ...def.research!.analysisPlan, derived: [{ name: "SAT_SCORE", kind: "mean_score", from: ["SAT", "PRICE_PERC"] }] } } });
  assert.deepEqual(researchBlockers(viaDerived), []);
});

test("enforced: a batch that opens a gap is refused whole, with the gap and the way out; what the design already lacks does not block; not enforced, the same batch goes through with the plan's warning", () => {
  const strict = survey(true);
  assert.equal(researchStrict(strict), true);
  const refused = applySurveyActions(strict, [{ op: "delete_question", target: "Q7" }, { op: "update_question", target: "Q9", required: true }]);
  assert.equal(refused.valid, false);
  assert.equal(refused.def, strict, "the input stands");
  assert.ok(refused.results.every((r) => !r.ok), "every action in the batch is refused");
  assert.match(refused.results[1].error!, /^Blocked by the research design \(enforced\): /, "every action carries the gaps, so a card built from one result says them");
  assert.equal(refused.errors.length, 1, "one line for the batch, every gap in it");
  assert.match(refused.errors[0], /^Blocked by the research design \(enforced\): /);
  assert.match(refused.errors[0], /KPI “Satisfaction”/);
  assert.match(refused.errors[0], /The dependent construct “Satisfaction” is measured by no question\. Add a question that measures Satisfaction/);
  assert.match(refused.errors[0], /Ask “stop enforcing the research design” to make this a warning instead\.$/);
  // a change that opens no gap is fine
  const fine = applySurveyActions(strict, [{ op: "delete_question", target: "Q9" }]);
  assert.equal(fine.valid, true);
  assert.equal(fine.def.questions.length, 4);
  // a gap the design already has does not block further unrelated changes — and closing it is of course allowed
  const already = applySurveyActions(survey(), [{ op: "delete_question", target: "Q7" }]).def;
  const alreadyStrict = SurveyDefinition.parse({ ...already, research: { ...already.research, strict: true } });
  assert.equal(researchBlockers(alreadyStrict).length, 3);
  assert.equal(applySurveyActions(alreadyStrict, [{ op: "update_question", target: "Q9", required: true }]).valid, true);
  // not enforced: the batch goes through, the plan review warns
  const loose = applySurveyActions(survey(false), [{ op: "delete_question", target: "Q7" }]);
  assert.equal(loose.valid, true);
  assert.ok(loose.destructive.some((w) => /planned crosstab reads it/.test(w)), JSON.stringify(loose.destructive));
  // turning enforcement on with gaps present is allowed (it is how they become blockers), turning it off too
  const on = applySurveyActions(already, [{ op: "set_research", strict: true }]);
  assert.equal(on.valid, true);
  assert.equal(on.def.research!.strict, true);
  assert.equal(on.results[0].description, "Research design: enforced (research gaps are blockers)");
  assert.equal(describeAction({ op: "set_research", strict: true }), "Enforce the research design");
  assert.equal(describeAction({ op: "set_research", strict: false }), "Stop enforcing the research design");
  assert.equal(describeAction({ op: "set_research", strict: true, objective: "O" }), "Record the research design");
  const off = applySurveyActions(on.def, [{ op: "set_research", strict: false }]);
  assert.equal(off.def.research!.strict, false);
  assert.equal(off.results[0].description, "Research design: no longer enforced");
  // an edit of the objective keeps the flag
  assert.equal(applySurveyActions(on.def, [{ op: "set_research", objective: "New" }]).def.research!.strict, true);
});

test("the review: enforced, the gaps are blockers — critical, marked, first, counted; not enforced, they are what they were", () => {
  const already = applySurveyActions(survey(), [{ op: "delete_question", target: "Q7" }]).def;
  const loose = reviewSurvey(already);
  assert.equal(loose.blockers, undefined);
  assert.ok(loose.findings.every((f) => !f.blocks));
  const strict = reviewSurvey(SurveyDefinition.parse({ ...already, research: { ...already.research, strict: true } }));
  assert.equal(strict.blockers, 3);
  const marked = strict.findings.filter((f) => f.blocks);
  assert.equal(marked.length, 3);
  assert.ok(marked.every((f) => f.severity === "critical"));
  assert.deepEqual(strict.findings.slice(0, 3).map((f) => !!f.blocks), [true, true, true], "blockers first");
  assert.ok(marked.some((f) => /KPI “Satisfaction”/.test(f.message)), "a gap the review did not name on its own is added");
  assert.ok(!strict.findings.some((f) => /is not measured by any question/.test(f.message)), "the review's own line for the same gap does not stand beside the blocker's");
  assert.equal(strict.findings.filter((f) => /“Satisfaction” is measured by no question/.test(f.message)).length, 2, "the construct's line and H2's — once each");
  // a gap the review already names in the same words (a dead plan reference) is marked, not added twice
  const dead = SurveyDefinition.parse({ ...survey(true), research: { ...survey(true).research, analysisPlan: { crosstabs: [{ id: "x9", rows: ["GONE"], columns: ["GENDER"], priority: 1, hypotheses: [] }], tests: [], derived: [], segments: [] } } });
  const d = reviewSurvey(dead);
  assert.equal(d.blockers, 1);
  const lines = d.findings.filter((f) => /GONE/.test(f.message));
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].blocks, true, "the review's own finding is the one marked");
  assert.equal(lines[0].severity, "critical");
  // a complete design enforced: no blockers, said as zero
  assert.equal(reviewSurvey(survey(true)).blockers, 0);
});

test("by sentence: enforce, stop enforcing, already so, nothing to enforce", () => {
  const def = survey();
  let r = actionsOf(interpretRequest(def, "enforce the research design"));
  assert.deepEqual(r.actions, [{ op: "set_research", strict: true }]);
  assert.match(r.understood, /^Enforce the research design: from now on a change that opens a research gap/);
  assert.doesNotMatch(r.understood, /listed as blockers/, "no gaps now");
  const already = applySurveyActions(def, [{ op: "delete_question", target: "Q7" }]).def;
  r = actionsOf(interpretRequest(already, "treat research gaps as blockers"));
  assert.match(r.understood, /the 3 gaps the design has now are listed as blockers in Review/);
  r = actionsOf(interpretRequest(survey(true), "stop enforcing the research design"));
  assert.deepEqual(r.actions, [{ op: "set_research", strict: false }]);
  const same = interpretRequest(survey(true), "enforce the research design");
  assert.equal(same.kind, "refused");
  assert.ok((same as { noop?: boolean }).noop);
  const none = interpretRequest(SurveyDefinition.parse({ ...def, research: undefined }), "enforce the research design");
  assert.equal(none.kind, "refused");
  assert.match((none as { reason: string }).reason, /no research design to enforce yet/);
  for (const t of ["make research-level checks blockers", "block changes that break the research design", "turn on research design enforcement"]) assert.deepEqual(actionsOf(interpretRequest(def, t)).actions, [{ op: "set_research", strict: true }], t);
  for (const t of ["relax the research design", "treat research gaps as warnings", "research design enforcement off"]) assert.deepEqual(actionsOf(interpretRequest(survey(true), t)).actions, [{ op: "set_research", strict: false }], t);
  // the model's set_research is read with the flag
  const coerced = applySurveyActions(def, [{ op: "set_research", strict: "yes" } as unknown as SurveyAction]);
  assert.equal(coerced.def.research!.strict, undefined, "a non-boolean is not a flag");
});
