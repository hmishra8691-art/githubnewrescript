import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type PlannedTest } from "@rescript/schema";
import { researchOnlyItems, studyKind, validateResearch } from "./researchValidation.js";
import { planItemSuitability, planSuitability } from "./researchSuitability.js";
import { reviewSurvey } from "./surveyReview.js";
import { applySurveyActions, coerceSurveyActions, describeAction, SURVEY_ACTION_OPS } from "./surveyActions.js";
import { pricingStudy, qualGuide } from "./researchFixtures.js";

/*
 * RESEARCH INTELLIGENCE (2026-10-17) — one validator for a research study
 * (blocking / warning / recommendation) that reuses the survey review and adds
 * the research checks; the method-suitability rules; the qualitative,
 * quantitative and mixed checks; and set_probe, the action that lets an
 * interview guide be probed.
 */

test("validation classes: the review classed (critical → blocking …) plus the research checks, blocking first", () => {
  const def = pricingStudy();
  const review = reviewSurvey(def);
  const v = validateResearch(def, { review });
  assert.equal(v.kind, "quantitative");
  assert.equal(v.ok, false);
  const classOf = { critical: "blocking", warning: "warning", suggestion: "recommendation" } as const;
  for (const f of review.findings) assert.ok(v.items.some((i) => i.source === "review" && i.message === f.message && i.class === classOf[f.severity]), f.message);
  const ranks = v.items.map((i) => ({ blocking: 0, warning: 1, recommendation: 2 })[i.class]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "blocking, then warnings, then recommendations");
  assert.equal(v.counts.blocking + v.counts.warning + v.counts.recommendation, v.items.length);
  const research = researchOnlyItems(v);
  const has = (cls: string, re: RegExp) => research.some((i) => i.class === cls && re.test(i.message));
  assert.ok(has("blocking", /Q3 is a multi-select: its options overlap, so it cannot be the groups of a t test/), "a multi-select grouping a t-test");
  assert.ok(has("warning", /Q4 serves no hypothesis, construct, research question, plan item or KPI/), "a question serving nothing");
  assert.ok(has("recommendation", /need(?:s)? enough completes for a chi-square's expected counts .* names no sample/), "expected counts: said once, not per item");
  assert.ok(has("recommendation", /accepts any number/), "a numeric with no range");
  // what the review already says is not said twice
  for (const i of research) assert.ok(!review.findings.some((f) => f.message === i.message), i.message);
  assert.equal(v.items.filter((i) => /reads LOYAL, which is not in the survey/.test(i.message)).length, 1, "the dead reference once (the review's line)");
  assert.match(v.summary, /^Quantitative study: \d+ blocking, \d+ warnings?, \d+ recommendations?\. Fix the blocking items before fieldwork\.$/);
});

test("document consistency and unsupported configurations: a 'supported' hypothesis with no run; HB named in the methodology", () => {
  const def = pricingStudy({ methodology: "Online survey, n=400; conjoint utilities by hierarchical Bayes", hypothesisDetails: [{ status: "supported" }, {}], analysis: ["regression of switching on price"] });
  const v = validateResearch(def);
  assert.ok(v.items.some((i) => i.area === "document" && i.class === "warning" && /H1 is recorded as “supported”, but no analysis run says so/.test(i.message)));
  assert.ok(v.items.some((i) => i.area === "unsupported" && i.class === "warning" && /Hierarchical Bayes .* not supported here: aggregate logit is run/.test(i.message)));
  const ran = validateResearch(def, { results: { verdicts: [{ label: "H1", verdict: "supported" }] } });
  assert.ok(!ran.items.some((i) => i.area === "document" && /H1 is recorded/.test(i.message)), "a run says so — no warning");
  assert.equal(ran.traceability.rows[0].status, "tested_supported");
});

test("method suitability: each rule decided by the engine, the plan review's own rule marked so it is not repeated", () => {
  const def = pricingStudy();
  const t = (x: Partial<PlannedTest>): PlannedTest => ({ id: "x", method: "t_test", variables: [], priority: 2, hypotheses: [], ...x } as PlannedTest);
  const rules = (x: Partial<PlannedTest>) => planItemSuitability(def, t(x)).map((i) => `${i.rule}:${i.level}`);
  assert.deepEqual(rules({ outcome: "SAT", groupBy: "CHANNELS" }), ["group_multi:blocking"]);
  assert.deepEqual(rules({ outcome: "COMMENT", groupBy: "GENDER" }), ["text_in_test:blocking"]);
  assert.deepEqual(rules({ method: "anova", groupBy: "GENDER" }), ["no_outcome:blocking"]);
  assert.deepEqual(rules({ method: "regression", outcome: "SWITCH", variables: ["CHANNELS", "PRICE_PERC"] }), ["predictor_multi:warning"]);
  assert.deepEqual(rules({ method: "regression", variables: ["PRICE_PERC"] }), ["no_outcome:blocking"]);
  assert.deepEqual(rules({ method: "text_themes", variables: ["SAT"] }), ["method_type:warning"]);
  assert.deepEqual(rules({ method: "text_themes", variables: ["COMMENT"] }), []);
  assert.deepEqual(rules({ method: "pricing", variables: ["AGE", "SAT"] }), ["method_type:warning"]);
  assert.deepEqual(rules({ method: "ranking_scores", variables: ["SAT"] }), ["method_type:warning"]);
  assert.deepEqual(rules({ method: "brand_funnel", variables: ["CHANNELS"] }), ["method_type:warning"]);
  assert.deepEqual(rules({ method: "chi_square", outcome: "GENDER", variables: ["SAT"] }), ["expected_counts:recommendation"]);
  const sized = pricingStudy({ sampleSize: 400 });
  assert.deepEqual(planItemSuitability(sized, t({ method: "chi_square", outcome: "GENDER", variables: ["SAT"] })), [], "with a sample the sample-size review takes over");
  const means = planItemSuitability(def, t({ outcome: "GENDER", groupBy: "S1" }));
  assert.ok(means.some((i) => i.rule === "mean_of_categories" && i.inReview), "the plan review says this one");
  assert.equal(planSuitability(def).filter((i) => i.itemId === "t2" && i.rule === "group_multi").length, 1);
});

test("qualitative: the kind is read; probe coverage with a fix that applies; the guide's flow; objective ↔ topic mapping; themes planned", () => {
  const def = qualGuide();
  assert.equal(studyKind(def), "qualitative");
  const v = validateResearch(def);
  assert.equal(v.kind, "qualitative");
  const probes = v.items.find((i) => i.area === "qualitative" && /2 of 3 topic questions have no AI follow-up probe \(Q3, Q4\)/.test(i.message));
  assert.ok(probes, JSON.stringify(v.items.map((i) => i.message)));
  const applied = applySurveyActions(def, probes!.fix!);
  assert.deepEqual(applied.errors, []);
  assert.equal(applied.def.questions.filter((q) => q.probe).length, 3, "the topic questions are probed; the warm-up and wrap-up are not");
  assert.ok(!v.items.some((i) => /serves no hypothesis/.test(i.message)), "the warm-up and wrap-up are framing, not loose questions");
  assert.ok(v.items.some((i) => /No text-themes analysis is planned/.test(i.message)));
  assert.ok(!v.items.some((i) => /no closing question/.test(i.message)), "Q5 is the wrap-up");
  assert.ok(!v.items.some((i) => /opens on the core topic/.test(i.message)), "Q1 is a warm-up");
  assert.deepEqual(v.traceability.rows.map((r) => [r.id, r.questions.map((q) => q.code).join(",")]), [["RQ1", "Q2,Q3"], ["RQ2", "Q4"]], "each research question mapped to its topic's questions");
  assert.match(v.traceability.rows[0].interpretation, /qualitative evidence — themes describe what was said, not how many/);
  // no research questions → the guide maps to nothing
  const bare = qualGuide({ researchQuestions: [], constructs: [] });
  assert.ok(validateResearch(bare).items.some((i) => i.class === "warning" && /No research questions or topics are recorded/.test(i.message)));
  // hypotheses in a qualitative study are propositions
  assert.ok(validateResearch(qualGuide({ hypotheses: ["Price rises trigger switching"] })).items.some((i) => /does not test hypotheses/.test(i.message)));
});

test("mixed: the kind from the methodology; phases, both sides recorded, a hypothesis never tagged on text themes", () => {
  const def = qualGuide({ methodology: "Mixed methods: phase 1 qualitative guide → propositions → phase 2 quantitative survey", hypotheses: ["Price rises trigger switching"], analysisPlan: { crosstabs: [], tests: [{ id: "tt", method: "text_themes", variables: ["TRIGGER"], priority: 2, hypotheses: ["H1"] }], derived: [], segments: [] } });
  assert.equal(studyKind(def), "mixed");
  const v = validateResearch(def);
  assert.ok(v.items.some((i) => i.area === "mixed" && i.class === "warning" && /tags a hypothesis on text themes — themes are qualitative evidence, not a test/.test(i.message)));
  assert.ok(!v.items.some((i) => /does not say how the phases connect/.test(i.message)));
  assert.ok(validateResearch(qualGuide({ methodology: "Mixed methods" })).items.some((i) => i.area === "mixed" && /needs both its qualitative research questions and the hypotheses/.test(i.message)));
  assert.equal(studyKind(pricingStudy()), "quantitative");
  assert.equal(studyKind(SurveyDefinition.parse({ meta: { id: "e", code: "E", title: "E" }, questions: [], flow: [] })), "none");
});

test("set_probe: writes question.probe on an open end (conditions through the gate), refuses a closed question, removes; old designs load unchanged", () => {
  assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes("set_probe"));
  const def = qualGuide();
  const c = coerceSurveyActions([
    { op: "set_probe", target: "Q3", maxProbes: 2, minWords: 4, instruction: "Ask what they did next.", when: "Q1 answered" },
    { op: "set_probe", target: "Q2", probe: null },
    { op: "set_probe", target: "Q4", maxProbes: 9 },
    { op: "set_probe" },
  ]);
  assert.deepEqual(c.rejected.map((r) => r.reason), ["set_probe: maxProbes is 1 to 5", "set_probe needs a target (the open-text question)"]);
  const r = applySurveyActions(def, c.actions);
  assert.deepEqual(r.errors, []);
  const q3 = r.def.questions.find((q) => q.code === "Q3")!;
  assert.equal(q3.probe?.maxProbes, 2);
  assert.equal(q3.probe?.minWords, 4);
  assert.equal(q3.probe?.when?.type, "rule");
  assert.match(r.results[0].description, /^Add the AI follow-up probe on Q3: up to 2 follow-ups, the AI writes it \(“Ask what they did next\.”\), answers of 4\+ words, when /);
  assert.equal(r.def.questions.find((q) => q.code === "Q2")!.probe, undefined);
  assert.ok(r.results[1].destructive);
  const closed = applySurveyActions(pricingStudy(), [{ op: "set_probe", target: "Q5", maxProbes: 1 } as never]);
  assert.match(closed.results[0].error ?? "", /Q5 is single select — a follow-up probe asks about an open answer/);
  assert.equal(describeAction({ op: "set_probe", target: "Q3", maxProbes: 2 } as never), "AI follow-up probe on Q3 (up to 2)");
  // backward compatibility: a design saved before any of this validates and traces as it parses
  const legacy = SurveyDefinition.parse(JSON.parse(JSON.stringify(pricingStudy())));
  assert.deepEqual(legacy, pricingStudy());
  assert.doesNotThrow(() => validateResearch(legacy));
});

test("a generation's set_research and its set_hypothesis in one batch: the reading is recorded (the hypothesis actions run after set_research)", () => {
  const def = SurveyDefinition.parse({ meta: { id: "n", code: "N", title: "New" }, questions: [], flow: [] });
  const c = coerceSurveyActions([
    { op: "set_hypothesis", hypothesis: "H1", detail: { type: "causal", direction: "positive", independent: "Price perception", dependent: "Switching" } },
    { op: "add_hypothesis", text: "Tenure lowers switching" },
    { op: "set_research", objective: "O", hypotheses: ["Price perception drives switching"], constructs: [{ name: "Price perception", role: "independent" }, { name: "Switching", role: "dependent" }] },
  ]);
  const r = applySurveyActions(def, c.actions);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.def.research?.hypotheses, ["Price perception drives switching", "Tenure lowers switching"], "add_hypothesis is not lost to set_research's list");
  assert.equal(r.def.research?.hypothesisDetails[0]?.independent, "Price perception");
});
