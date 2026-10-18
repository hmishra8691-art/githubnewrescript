import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { researchTraceability, traceabilityTable, TRACEABILITY_COLUMNS, TRACE_STATUS_WORDS } from "./researchTraceability.js";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { pricingStudy } from "./researchFixtures.js";

/*
 * RESEARCH INTELLIGENCE (2026-10-17) — the traceability matrix is built from
 * the study as configured: objective → hypothesis → construct → questions →
 * variables → analysis → chart → interpretation → limitations, with its gaps
 * flagged, and no hypothesis ever reads as a finding unless a run says so.
 */
test("the matrix from the configuration: H1 planned with its constructs, questions, regression and chart; H2 untested; a research question row", () => {
  const t = researchTraceability(pricingStudy());
  assert.equal(t.objective, "Understand whether price perception drives switching among broadband customers");
  const [h1, h2, rq1] = t.rows;
  assert.equal(h1.id, "H1");
  assert.deepEqual(h1.constructs.map((c) => [c.name, c.measured]), [["Price perception", true], ["Switching intention", true]]);
  assert.deepEqual(h1.questions.map((q) => `${q.code}:${q.variable}:${q.level}`), ["Q1:PRICE_PERC:ordinal", "Q2:SWITCH:ordinal"]);
  assert.deepEqual(h1.analyses.map((a) => [a.id, a.method, a.compatible, a.inferential, a.chart]), [["t1", "regression", true, true, "coefficient_plot"]]);
  assert.deepEqual(h1.visualisations, ["coefficient_plot"]);
  assert.equal(h1.status, "planned");
  assert.match(h1.interpretation, /^Planned — not yet tested: .* No analysis has run, so nothing is supported or rejected yet\.$/);
  assert.ok(h1.limitations.some((l) => /association; a causal reading needs the design/.test(l)), "a causal hypothesis carries its limit");
  assert.ok(h1.limitations.some((l) => /No sample size is recorded/.test(l)));
  assert.equal(h2.status, "untested");
  assert.deepEqual(h2.gaps.sort(), ["analysis_incompatible", "hypothesis_unmeasured"].sort());
  assert.equal(rq1.kind, "research_question");
  assert.deepEqual(rq1.questions.map((q) => q.code), ["Q3"], "the research question is matched to the question that explores it by its words");
  assert.equal(rq1.status, "descriptive_only");
  assert.equal(t.executed, false);
  assert.match(t.summary, /nothing has been run/);
});

test("the gaps: an unmeasured hypothesis, a multi-select grouping a t-test, a variable not in the survey, a question serving nothing, a construct with no question", () => {
  const t = researchTraceability(pricingStudy());
  const by = (code: string) => t.gaps.filter((g) => g.code === code);
  assert.deepEqual(by("hypothesis_unmeasured").map((g) => [g.hypothesis, g.severity]), [["H2", "blocking"]]);
  assert.match(by("hypothesis_unmeasured")[0].message, /H2 has no measuring question — “Satisfaction” is measured by nothing/);
  const inc = by("analysis_incompatible");
  assert.ok(inc.some((g) => g.itemId === "t2" && g.severity === "blocking" && /Q3 is a multi-select: its options overlap, so it cannot be the groups of a t test/.test(g.message)), JSON.stringify(inc));
  assert.deepEqual(by("analysis_missing_variable").map((g) => [g.itemId, g.severity]), [["t3", "blocking"]]);
  assert.match(by("analysis_missing_variable")[0].message, /reads LOYAL, which is not in the survey/);
  assert.deepEqual(by("question_serves_nothing").map((g) => g.questionIds), [["q6"]], "Q4 (COMMENT) serves nothing; S1/S2 are cuts, Q3 and Q5 are read by the plan");
  assert.ok(by("construct_unmeasured").some((g) => /“Satisfaction” is measured by no question/.test(g.message)));
  assert.equal(t.counts.blocking, t.gaps.filter((g) => g.severity === "blocking").length);
  // the variable mapping: what every question serves
  const map = Object.fromEntries(t.questions.map((q) => [q.code, q.serves]));
  assert.deepEqual(map.Q1.sort(), ["H1", "construct “Price perception”", "t1"].sort());
  assert.deepEqual(map.Q4, []);
});

test("never a finding without a run: a recorded 'supported' stays the researcher's; a run's verdicts make the rows TESTED", () => {
  const def = pricingStudy({ hypothesisDetails: [{ type: "causal", direction: "positive", independent: "Price perception", dependent: "Switching intention", status: "supported" }, {}] });
  const before = researchTraceability(def);
  assert.equal(before.rows[0].status, "planned", "the researcher's own status is not a test result");
  assert.equal(before.rows[0].researcherStatus, "supported");
  const after = researchTraceability(def, { verdicts: [{ label: "H1", verdict: "supported", reason: "β = .41, p < .001" }, { label: "H2", verdict: "untested" }], at: "2026-10-17" });
  assert.equal(after.rows[0].status, "tested_supported");
  assert.equal(after.rows[0].interpretation, "Tested — supported: β = .41, p < .001 (run 2026-10-17)");
  assert.equal(after.rows[1].status, "untested");
  assert.equal(after.executed, true);
  const corrected = researchTraceability(def, { verdicts: [{ label: "H1", verdict: "supported", corrected: { verdict: "mixed" } }] });
  assert.equal(corrected.rows[0].status, "tested_mixed", "the family-corrected verdict is the one read");
  for (const w of Object.values(TRACE_STATUS_WORDS)) assert.match(w, /^(Planned|Untested|Descriptive only|Tested) — /);
});

test("the chain updates it: a hypothesis about price sensitivity → three questions measuring it → an analysis serving it", () => {
  let def = pricingStudy();
  const step = (actions: unknown[]) => { const c = coerceSurveyActions(actions); assert.deepEqual(c.rejected, []); const r = applySurveyActions(def, c.actions); assert.deepEqual(r.errors, [], JSON.stringify(r.results.filter((x) => !x.ok))); def = r.def; return researchTraceability(def); };
  let t = step([{ op: "add_hypothesis", text: "Price-sensitive customers are more likely to switch", detail: { type: "association", direction: "positive", independent: "Price sensitivity", dependent: "Switching intention" } }]);
  const h3 = () => t.rows.find((r) => r.id === "H3")!;
  assert.equal(h3().status, "untested");
  assert.ok(t.gaps.some((g) => g.code === "hypothesis_unmeasured" && g.hypothesis === "H3"));
  t = step([
    { op: "create_question", ref: "PS_1", block: "Main", type: "rating", text: "I always look for the cheapest broadband deal", scale: { points: 5, low: "Strongly disagree", high: "Strongly agree" } },
    { op: "create_question", ref: "PS_2", block: "Main", type: "rating", text: "A small price rise would make me look elsewhere", scale: { points: 5, low: "Strongly disagree", high: "Strongly agree" } },
    { op: "create_question", ref: "PS_3", block: "Main", type: "rating", text: "Price matters more to me than speed", scale: { points: 5, low: "Strongly disagree", high: "Strongly agree" } },
    ...["PS_1", "PS_2", "PS_3"].map((target) => ({ op: "set_question_analysis", target, role: "independent", construct: "Price sensitivity", hypotheses: ["H3"] })),
  ]);
  assert.deepEqual(h3().questions.map((q) => q.variable), ["SWITCH", "PS_1", "PS_2", "PS_3"], "the dependent side through its construct, the new items through their tags");
  assert.ok(!t.gaps.some((g) => g.code === "hypothesis_unmeasured" && g.hypothesis === "H3"), "measured now");
  assert.ok(t.gaps.some((g) => g.code === "hypothesis_no_analysis" && g.hypothesis === "H3"), "but nothing tests it yet");
  t = step([{ op: "add_analysis_test", method: "regression", outcome: "SWITCH", variables: ["PS_1", "PS_2", "PS_3"], hypotheses: ["H3"] }]);
  assert.equal(h3().status, "planned");
  assert.deepEqual(h3().analyses.map((a) => [a.method, a.compatible]), [["regression", true]]);
  assert.ok(!t.gaps.some((g) => g.hypothesis === "H3"), JSON.stringify(t.gaps.filter((g) => g.hypothesis === "H3")));
});

test("traceabilityTable — the Word plan's rows; a survey with no design traces to one recommendation", () => {
  const t = researchTraceability(pricingStudy());
  const table = traceabilityTable(t);
  assert.equal(table.length, t.rows.length);
  for (const row of table) assert.equal(row.length, TRACEABILITY_COLUMNS.length);
  assert.match(table[0][1], /^H1: Higher price perception increases switching intention \(causal/);
  assert.match(table[1][5], /\[method does not fit\]/);
  const bare = SurveyDefinition.parse({ meta: { id: "b", code: "B", title: "Bare" }, questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "Hi" }], flow: [{ type: "page", id: "p", questionIds: ["q1"] }] });
  const tb = researchTraceability(bare);
  assert.deepEqual(tb.rows, []);
  assert.deepEqual(tb.gaps.map((g) => [g.code, g.severity]), [["no_design", "recommendation"]]);
  assert.equal(tb.summary, "No research design to trace.");
});
