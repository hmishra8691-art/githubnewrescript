import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import type { PlannedCrosstab, PlannedTest } from "@rescript/schema";
import {
  buildAnalysisFramework, explainPlanItem, explainPlan, requiredBase, expectedSample, reviewAnalysisPlan, sampleSizeReview, monadicDesigns,
  planSampleSize, segmentVariableName, interpretRequest, applySurveyActions, coerceSurveyActions, type Interpretation,
} from "./index.js";

/*
 * WHY THIS ANALYSIS, AND IS THE SAMPLE BIG ENOUGH (Intelligent Mode Phase 6,
 * audit R17 and §2.3): every planned item explained deterministically — the
 * objective, the variables and their levels, the rule that chose the method,
 * the output, the base it needs, its limits — the base checked against the
 * sample the quotas or the design expect, a multi-select never used as a
 * test's groups, a monadic randomizer compared across its recorded arm, and
 * the interpreter answering "why …?" and "what sample size …?" from it.
 */

const scale = (n = 5) => Array.from({ length: n }, (_, i) => ({ code: i + 1, label: ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"][i] ?? String(i + 1) }));
const opts = (...labels: string[]) => labels.map((l, i) => ({ code: i + 1, label: l }));
const rule = (ref: string, value: unknown) => ({ type: "rule" as const, source: { kind: "question" as const, ref }, operator: "eq" as const, value });

function survey(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Brand choice", version: "1.0" },
    research: {
      objective: "Why consumers choose Brand A over Brand B",
      hypotheses: ["Brand trust increases purchase intention", "Price perception moderates the effect of trust on purchase intention", "Advertising exposure raises awareness"],
      population: "US and UK adults 18–45",
      constructs: [
        { name: "Brand trust", role: "independent", questionIds: ["t1", "t2"] },
        { name: "Price perception", role: "moderator", questionIds: ["price"] },
        { name: "Purchase intention", role: "dependent", questionIds: ["pi"] },
        { name: "Advertising exposure", role: "independent", questionIds: ["ad"] },
        { name: "Awareness", role: "dependent", questionIds: ["aware"] },
      ],
      analysis: [], assumptions: [], sources: [],
    },
    questions: [
      { id: "gender", code: "S2", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female", "Other") },
      { id: "country", code: "S3", variableName: "COUNTRY", type: "single_select", text: "Which country do you live in?", options: opts("US", "UK") },
      { id: "aware", code: "Q1", variableName: "AWARE", type: "multi_select", text: "Which of these brands have you heard of?", options: opts("Brand A", "Brand B", "Brand C") },
      { id: "ad", code: "Q2", variableName: "AD_EXPOSE", type: "single_select", text: "Have you seen advertising for Brand A recently?", options: opts("Yes", "No") },
      { id: "t1", code: "Q3", variableName: "TRUST_1", type: "single_select", text: "Brand A keeps its promises", options: scale() },
      { id: "t2", code: "Q4", variableName: "TRUST_2", type: "single_select", text: "Brand A is honest", options: scale() },
      { id: "price", code: "Q5", variableName: "PRICE_PERC", type: "single_select", text: "Brand A is good value", options: scale() },
      { id: "pi", code: "Q6", variableName: "PURCHASE_INT", type: "single_select", text: "How likely are you to buy Brand A?", options: scale() },
    ],
    flow: [
      { type: "block", id: "b0", title: "Screening", children: [{ type: "page", id: "p0", questionIds: ["gender", "country"] }] },
      { type: "block", id: "b1", title: "Brand", children: [{ type: "page", id: "p1", questionIds: ["aware", "ad", "t1", "t2", "price", "pi"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
    ...extra,
  });
}
const tt = (o: Partial<PlannedTest> & Pick<PlannedTest, "method">): PlannedTest => ({ id: "t", variables: [], priority: 1, hypotheses: [], ...o });
const xt = (rows: string[], columns: string[], o: Partial<PlannedCrosstab> = {}): PlannedCrosstab => ({ id: "x", rows, columns, priority: 1, hypotheses: [], ...o });

test("explainPlanItem — a crosstab: the objective, the variables with their levels, the rule, the output, the base, the limits, one paragraph", () => {
  const def = survey();
  const plan = buildAnalysisFramework(def, { now: "" });
  const banner = plan.crosstabs.find((x) => x.rows[0] === "PURCHASE_INT" && x.columns.length > 1)!;
  const e = explainPlanItem(def, banner, plan);
  assert.equal(e.kind, "crosstab");
  assert.equal(e.title, "Q6 by S2, S3");
  assert.match(e.objective, /^The study's objective: Why consumers choose Brand A over Brand B\. This serves H1 \(“Brand trust increases purchase intention”\) and H2/);
  assert.deepEqual(e.hypotheses.map((h) => h.label), ["H1", "H2"]);
  assert.deepEqual(e.variables.map((v) => [v.code, v.role, v.level, v.categories]), [["Q6", "row", "ordinal", 5], ["S2", "column", "nominal", 3], ["S3", "column", "nominal", 2]]);
  assert.match(e.why, /^Q6 is an ordinal 5-point scale and S2 is nominal with 3 groups, S3 is nominal with 2 groups: groups across the top and categories down the side/);
  assert.match(e.expectedOutput, /^a crosstab of Q6 by S2, S3 \(column percentages, one banner\) with significance letters between columns and a chi-square test per column variable; a stacked bar chart$/);
  // 5 per cell × 5 × 3 = 75, but a banner column is read at 30 → 30 × 3 groups of S2
  assert.equal(e.requiredBase.minimum, 90);
  assert.equal(e.requiredBase.note, "30 per column × 3 columns of S2");
  assert.match(e.requiredBase.rule, /Cochran 1954/);
  assert.equal(e.expectedSample, null, "no quota, no sample size: nothing to compare with");
  assert.match(e.text, /^A crosstab of Q6 by S2, S3 is recommended because Q6 measures purchase intention and S2, S3 profile the sample\. Q6 is an ordinal/);
  assert.match(e.text, /It needs about 90 completes \(30 per column × 3 columns of S2\)\./);
});

test("explainPlanItem — a t-test says why it is a t-test and not ANOVA, and that an ordinal outcome is treated as interval", () => {
  const def = survey();
  const plan = buildAnalysisFramework(def, { now: "" });
  const t = plan.tests.find((x) => x.method === "t_test" && x.outcome === "PURCHASE_INT" && x.groupBy === "AD_EXPOSE")!;
  assert.ok(t, "a binary independent × a scale outcome is a t-test");
  const e = explainPlanItem(def, t, plan);
  assert.equal(e.why, "Q6 is an ordinal 5-point scale and Q2 is nominal with 2 groups, so the comparison of means is a t-test; with 3+ groups it would be ANOVA.");
  assert.equal(e.expectedOutput, "a table of means by group (n, mean, SD, median, 95% CI) with the t statistic, p-value and Cohen's d; a bar chart of the means with their confidence intervals");
  assert.deepEqual(e.variables.map((v) => [v.code, v.role]), [["Q6", "outcome"], ["Q2", "grouping"]]);
  assert.equal(e.requiredBase.minimum, 60);
  assert.ok(e.limitations.some((l) => /^Q6 is an ordinal 5-point scale treated as interval — equal distances between its points are assumed; the Mann–Whitney test makes no such assumption\.$/.test(l)), e.limitations.join(" | "));
  assert.match(e.text, /^A t-test is recommended because Q6 measures purchase intention and Q2 splits the sample into two groups\./);
  /* a t-test planned on three groups says so */
  const wrong = explainPlanItem(def, tt({ method: "t_test", outcome: "PURCHASE_INT", groupBy: "GENDER" }), plan);
  assert.match(wrong.why, /a t-test compares two groups, so it reads only the first two; with 3 groups ANOVA is the right test/);
});

test("explainPlanItem — a regression is a driver analysis, with Green's base, collinearity and correlation-is-not-causation", () => {
  const def = survey();
  const plan = buildAnalysisFramework(def, { now: "" });
  const reg = plan.tests.find((x) => x.method === "regression" && x.outcome === "PURCHASE_INT")!;
  const e = explainPlanItem(def, reg, plan);
  assert.match(e.text, /^Driver analysis is recommended because Q6 measures purchase intention and Q2–Q4 measure potential drivers\./);
  assert.match(e.why, /^Q6 \(the outcome\) is an ordinal 5-point scale and Q2–Q4 are scale or two-group predictors, so a linear regression estimates each one's effect on Q6 holding the others constant; Q5 enters with its interaction/);
  assert.deepEqual(e.variables.map((v) => v.role), ["outcome", "predictor", "predictor", "predictor", "moderator"]);
  // k = 3 predictors + the moderator and its interaction = 5 → max(50 + 40, 104 + 5)
  assert.equal(e.requiredBase.minimum, 109);
  assert.match(e.requiredBase.note, /^max\(50 \+ 8·5, 104 \+ 5\) for 5 predictors$/);
  assert.match(e.requiredBase.rule, /Green \(1991\)/);
  assert.ok(e.limitations.some((l) => /^Correlation is not causation/.test(l)));
  assert.ok(e.limitations.some((l) => /collinearity/i.test(l)));
  assert.ok(e.limitations.some((l) => /^Key driver analysis: /.test(l)), "the methodology card's trade-offs");
  assert.match(e.expectedOutput, /standardized β/);
});

test("explainPlanItem — a derived variable names its rule (top two codes of the scale) and every plan item explains", () => {
  const def = survey();
  const plan = buildAnalysisFramework(def, { now: "" });
  const t2b = explainPlanItem(def, plan.derived.find((d) => d.name === "PURCHASE_INT_T2B")!, plan);
  assert.equal(t2b.kind, "derived");
  assert.match(t2b.why, /^PURCHASE_INT_T2B is 1 when Q6 is in the top two points of its scale \(codes 4 and 5 — “Agree”, “Strongly agree”\), 0 otherwise/);
  assert.match(t2b.expectedOutput, /a new column PURCHASE_INT_T2B computed for every respondent before the planned tests run/);
  const score = explainPlanItem(def, plan.derived.find((d) => d.kind === "mean_score")!, plan);
  assert.match(score.why, /the mean of Q3, Q4 over the items each respondent answered/);
  const all = explainPlan(def, plan);
  assert.equal(all.length, plan.crosstabs.length + plan.tests.length + plan.derived.length + plan.segments.length);
  assert.ok(all.every((x) => x.text.length > 40 && x.why && x.expectedOutput && x.requiredBase.minimum >= 30));
  /* a multi-select across the top says its columns overlap */
  const multi = explainPlanItem(def, xt(["PURCHASE_INT"], ["AWARE"]), plan);
  assert.ok(multi.limitations.some((l) => /Q1 is multi-select: a respondent counts in every column they chose/.test(l)));
});

test("requiredBase — the rule of thumb per method, each with its source", () => {
  const def = survey();
  const base = (o: Parameters<typeof tt>[0], share?: number) => requiredBase(def, tt(o), { outcomeShare: share });
  assert.equal(base({ method: "t_test", outcome: "PURCHASE_INT", groupBy: "AD_EXPOSE" }).minimum, 60);
  assert.deepEqual([base({ method: "anova", outcome: "PURCHASE_INT", groupBy: "GENDER" }).minimum, base({ method: "anova", outcome: "PURCHASE_INT", groupBy: "GENDER" }).note], [60, "20 per group × 3 groups of S2"]);
  assert.deepEqual([base({ method: "chi_square", outcome: "AWARE", variables: ["GENDER"] }).minimum, base({ method: "chi_square", outcome: "AWARE", variables: ["GENDER"] }).note], [45, "5 per cell × 3 × 3"]);
  const r = base({ method: "correlation", outcome: "PURCHASE_INT", variables: ["TRUST_1"] });
  assert.deepEqual([r.minimum, r.recommended], [30, 85]);
  assert.match(r.rule, /85 to detect a correlation of \.3 with 80% power at α = \.05 \(Cohen 1988\)/);
  assert.equal(base({ method: "regression", outcome: "PURCHASE_INT", variables: ["TRUST_1"] }).minimum, 105, "max(50 + 8, 104 + 1)");
  assert.equal(base({ method: "regression", outcome: "PURCHASE_INT", variables: Array.from({ length: 10 }, (_, i) => `V${i}`) }).minimum, 130, "max(50 + 80, 104 + 10)");
  const logit = base({ method: "logistic_regression", outcome: "AD_EXPOSE", variables: ["TRUST_1", "TRUST_2"] });
  assert.equal(logit.minimum, 40);
  assert.match(logit.note, /rarer outcome's share is unknown before fieldwork; at 20% it would be 100/);
  assert.match(logit.rule, /Peduzzi et al\. 1996/);
  assert.equal(base({ method: "logistic_regression", outcome: "AD_EXPOSE", variables: ["TRUST_1", "TRUST_2"] }, 0.2).minimum, 100);
  assert.equal(base({ method: "factor", variables: ["A", "B", "C"] }).minimum, 100);
  assert.equal(base({ method: "factor", variables: Array.from({ length: 30 }, (_, i) => `I${i}`) }).minimum, 150, "5 per item beyond 20 items");
  assert.match(base({ method: "factor", variables: ["A", "B"] }).rule, /Gorsuch 1983/);
  assert.equal(base({ method: "cluster", variables: Array.from({ length: 8 }, (_, i) => `C${i}`) }).minimum, 256, "2^8");
  assert.equal(base({ method: "cluster", variables: ["A", "B"] }).minimum, 100, "never fewer than 100");
  assert.equal(base({ method: "maxdiff_scores", variables: ["MD"] }).minimum, 200);
  assert.equal(base({ method: "conjoint_utilities", variables: ["CBC"] }).minimum, 200);
  assert.equal(base({ method: "frequencies", variables: ["GENDER"] }).minimum, 30);
  assert.deepEqual([requiredBase(def, { name: "Profile", by: ["GENDER", "COUNTRY"] }).minimum, requiredBase(def, { name: "Profile", by: ["GENDER", "COUNTRY"] }).note], [180, "30 per segment × 6 segments"]);
  assert.equal(requiredBase(def, xt(["PURCHASE_INT"], ["GENDER"])).minimum, 90, "max(5 × 5 × 3, 30 × 3)");
  assert.equal(requiredBase(def, xt(["AWARE"], ["COUNTRY"], { measure: "pct_col" })).minimum, 60);
});

test("expectedSample — a quota's stated target, else the sum of its cells' maximums; else the design's sample size; else the population note; else null", () => {
  assert.equal(expectedSample(survey()), null);
  const capped = survey({ quotas: [{ id: "q1", name: "Gender", cells: [{ id: "c1", label: "Male", when: rule("GENDER", 1), limit: 100 }, { id: "c2", label: "Female", when: rule("GENDER", 2), limit: 100 }] }] });
  assert.deepEqual(expectedSample(capped), { n: 200, source: "quotas", note: "the quotas target 200", detail: "200 completes — quota “Gender”, the sum of its 2 cells' maximums" });
  const targeted = survey({ quotas: [
    { id: "q1", name: "Gender", cells: [{ id: "c1", label: "Male", when: rule("GENDER", 1), limit: 100 }, { id: "c2", label: "Female", when: rule("GENDER", 2), limit: 100 }] },
    { id: "q2", name: "Country", cells: [{ id: "c3", label: "US", when: rule("COUNTRY", 1), limit: 80, target: 60 }, { id: "c4", label: "UK", when: rule("COUNTRY", 2), limit: 80, target: 60 }] },
  ] });
  assert.equal(expectedSample(targeted)!.n, 120, "a stated target beats a cap");
  assert.match(expectedSample(targeted)!.detail, /the sum of its 2 cells' targets/);
  const total = survey({ quotas: [{ id: "q1", name: "Main", targetTotal: 500, cells: [{ id: "c1", label: "Male", when: rule("GENDER", 1), limit: 50, limitType: "percent" }] }] });
  assert.equal(expectedSample(total)!.n, 500);
  const sized = survey(); sized.research!.sampleSize = 300;
  assert.deepEqual([expectedSample(sized)!.n, expectedSample(sized)!.source, expectedSample(sized)!.note], [300, "research", "the research design plans 300"]);
  const pop = survey(); pop.research!.population = "UK adults, n = 1,200";
  assert.equal(expectedSample(pop)!.n, 1200);
  pop.research!.population = "About 450 respondents in three markets";
  assert.equal(expectedSample(pop)!.n, 450);
});

test("the review warns when a planned item needs more completes than the quotas target — and the framework bands rather than splits", () => {
  const def = survey({ quotas: [{ id: "q1", name: "Country", cells: [{ id: "c1", label: "US", when: rule("COUNTRY", 1), limit: 80, target: 60 }, { id: "c2", label: "UK", when: rule("COUNTRY", 2), limit: 80, target: 60 }] }] });
  def.questions.push({ ...def.questions[0], id: "region", code: "S4", variableName: "REGION", text: "Region", options: opts("N", "S", "E", "W", "C", "Other") } as never);
  (def.flow[0] as { children: { questionIds: string[] }[] }).children[0].questionIds.push("region");
  def.research!.analysisPlan = { crosstabs: [xt(["PURCHASE_INT"], ["REGION"], { id: "xr" })], tests: [tt({ id: "tr", method: "regression", outcome: "PURCHASE_INT", variables: ["TRUST_1", "TRUST_2"] }), tt({ id: "tc", method: "correlation", outcome: "PURCHASE_INT", variables: ["TRUST_1"] })], derived: [], segments: [] };
  const issues = reviewAnalysisPlan(def);
  const xr = issues.find((i) => i.itemId === "xr")!;
  assert.equal(xr.level, "warning");
  assert.equal(xr.message, "Q6 by S4 needs about 180 completes (30 per column × 6 columns of S4) — the quotas target 120.");
  assert.equal(xr.suggestion, "Consider banding S4 into fewer groups, or raise the sample.");
  assert.ok(!issues.some((i) => i.itemId === "tr"), "a two-predictor regression needs 106 — the 120 targeted are enough");
  assert.ok(!issues.some((i) => i.itemId === "tc"), "120 completes carry a correlation, power included");
  const small = structuredClone(def); small.quotas = []; small.research!.sampleSize = 60;
  const corr = reviewAnalysisPlan(small).find((i) => i.itemId === "tc")!;
  assert.equal(corr.level, "suggestion", "the correlation can be estimated; only the power rule is out of reach");
  assert.equal(corr.message, "The correlation of Q6 with Q3 can be estimated with 60 completes, but detecting a modest effect needs about 85 (30 to estimate r; 85 to detect r = .3).");
  assert.deepEqual(sampleSizeReview(survey()), [], "no expected sample: nothing to say");
  /* the framework: a 6-group segmentation cannot be a banner column on 120 completes */
  const plan = buildAnalysisFramework(def, { now: "" });
  const banner = plan.crosstabs.find((x) => x.rows[0] === "PURCHASE_INT" && x.reason?.includes("sample profile"))!;
  assert.ok(!banner.columns.includes("REGION"), banner.columns.join());
  assert.match(banner.reason!, /S4 \(6 groups\) left out of the banner — 120 expected completes cannot give each group 30; consider banding it/);
  assert.ok(banner.columns.includes("GENDER") && banner.columns.includes("COUNTRY"));
});

test("the review: a regression too big for the sample is told to use fewer predictors", () => {
  const def = survey(); def.research!.sampleSize = 100;
  def.research!.analysisPlan = { crosstabs: [], tests: [tt({ id: "tr", method: "regression", outcome: "PURCHASE_INT", variables: ["TRUST_1", "TRUST_2", "PRICE_PERC"] })], derived: [], segments: [] };
  const i = reviewAnalysisPlan(def).find((x) => x.itemId === "tr")!;
  assert.equal(i.message, "The regression of Q6 on Q3–Q5 needs about 107 completes (max(50 + 8·3, 104 + 3) for 3 predictors) — the research design plans 100.");
  assert.match(i.suggestion!, /fewer predictors/);
});

test("a multi-select independent is a crosstab with each option a column — never a t-test or ANOVA groupBy, and the reason says why", () => {
  const def = survey();
  def.research!.constructs.push({ name: "Channels", role: "independent", questionIds: ["ch"] });
  def.questions.push({ ...def.questions[2], id: "ch", code: "Q7", variableName: "CHANNELS", text: "Where have you seen Brand A?", options: opts("TV", "Online", "Store", "Radio") } as never);
  (def.flow[1] as { children: { questionIds: string[] }[] }).children[0].questionIds.push("ch");
  const plan = buildAnalysisFramework(def, { now: "" });
  assert.ok(!plan.tests.some((t) => t.groupBy === "CHANNELS"), "no t-test / ANOVA across overlapping groups");
  assert.ok(!plan.tests.some((t) => t.method === "chi_square" && t.variables.includes("CHANNELS")));
  assert.ok(!plan.tests.some((t) => t.method === "regression" && t.variables.includes("CHANNELS")));
  const x = plan.crosstabs.find((c) => c.rows[0] === "PURCHASE_INT" && c.columns[0] === "CHANNELS")!;
  assert.match(x.reason!, /Q7 is multi-select: each option is a column and a respondent can be in several, so the groups overlap and no t-test or ANOVA across its options is proposed/);
});

function monadic(recorded: boolean, parallel = false) {
  const def = survey();
  const block = (id: string, title: string, value: string, qs: string[]) => ({ type: "block", id, title, children: [...(recorded ? [{ type: "embedded_data", id: `ed_${id}`, fields: [{ name: "CONCEPT_ARM", source: "static", value }] }] : []), { type: "page", id: `p_${id}`, questionIds: qs }] });
  if (parallel) {
    def.questions.push({ ...def.questions[7], id: "pia", code: "Q10", variableName: "PI_A", text: "How likely to buy concept A?" } as never, { ...def.questions[7], id: "pib", code: "Q11", variableName: "PI_B", text: "How likely to buy concept B?" } as never);
    def.research!.constructs.find((c) => c.name === "Purchase intention")!.questionIds.push("pia", "pib");
  }
  def.questions.push({ ...def.questions[0], id: "sa", code: "C1", variableName: "STIM_A", type: "html", text: "Concept A", options: [] } as never, { ...def.questions[0], id: "sb", code: "C2", variableName: "STIM_B", type: "html", text: "Concept B", options: [] } as never);
  (def.flow as unknown[]).splice(1, 0, { type: "randomizer", id: "rz", title: "Concepts", show: 1, evenPresentation: true, children: [block("ba", "Concept A", "A", parallel ? ["sa", "pia"] : ["sa"]), block("bb", "Concept B", "B", parallel ? ["sb", "pib"] : ["sb"])] });
  return SurveyDefinition.parse(def);
}

test("a monadic randomizer: unrecorded arm → the review says so and offers create_embedded; recorded → a between-arms test; per-arm questions → one combined score", () => {
  const bare = monadic(false);
  const d = monadicDesigns(bare);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].title, d[0].arms.length, d[0].armVariable, d[0].outcomesAfter.map((q) => q.code)], ["Concepts", 2, null, ["Q1", "Q6"]]);
  const note = reviewAnalysisPlan(bare).find((i) => i.fix)!;
  assert.equal(note.level, "warning");
  assert.match(note.message, /^Randomizer “Concepts” shows each respondent one of 2 blocks \(Concept A, Concept B\) — a monadic design — but which one a respondent saw is not recorded, so Q1, Q6 cannot be compared between the arms\.$/);
  assert.deepEqual(note.fix, { op: "create_embedded", name: "CONCEPTS_ARM", source: "static" });
  // the fix is a real action the engine applies
  const fixed = applySurveyActions(bare, coerceSurveyActions([note.fix]).actions);
  assert.ok(fixed.valid && fixed.errors.length === 0, fixed.errors.join());
  assert.ok(!buildAnalysisFramework(bare, { now: "" }).tests.some((t) => t.reason?.startsWith("between-arms")), "nothing to compare across until the arm is recorded");
  /* recorded in each block: the outcome is compared across the arm */
  const rec = monadic(true);
  assert.equal(monadicDesigns(rec)[0].armVariable, "CONCEPT_ARM");
  assert.ok(!reviewAnalysisPlan(rec).some((i) => i.fix));
  const plan = buildAnalysisFramework(rec, { now: "" });
  const arm = plan.tests.find((t) => t.groupBy === "CONCEPT_ARM" && t.outcome === "PURCHASE_INT")!;
  assert.equal(arm.method, "t_test");
  assert.match(arm.reason!, /^between-arms comparison: each respondent saw one of 2 blocks of “Concepts”, so Q6 is compared across CONCEPT_ARM$/);
  rec.research!.analysisPlan = plan;
  assert.ok(!reviewAnalysisPlan(rec).some((i) => /CONCEPT_ARM, which is not in the survey/.test(i.message)), "the arm variable is a variable of the run, not a dead reference");
  assert.equal(explainPlanItem(rec, arm, plan).variables.find((v) => v.role === "grouping")!.designRole, "arm");
  /* the same outcome inside each arm: one combined score, compared across the arm */
  const par = monadic(true, true);
  const pp = buildAnalysisFramework(par, { now: "" });
  const combined = pp.derived.find((x) => x.name === "PI_ARMS")!;
  assert.deepEqual([combined.kind, combined.from], ["mean_score", ["PI_A", "PI_B"]]);
  assert.match(combined.reason!, /each respondent answered one, so their mean is the one they gave/);
  assert.ok(pp.tests.some((t) => t.outcome === "PI_ARMS" && t.groupBy === "CONCEPT_ARM" && t.method === "t_test"));
});

test("segmentVariableName and planSampleSize: the largest base drives the plan", () => {
  assert.equal(segmentVariableName({ name: "GENDER_X_AGE" }), "GENDER_X_AGE");
  assert.equal(segmentVariableName({ name: "Which country do you live in?" }), "SEG_WHICH_COUNTRY_DO_YOU_LIVE_IN");
  const def = survey(); def.research!.sampleSize = 100;
  const s = planSampleSize(def);
  assert.ok(s.minimum >= 109 && s.driver);
  assert.equal(s.expected!.n, 100);
  assert.equal(s.items[0].minimum, s.minimum);
});

/* ------------------------------------------------------------ the interpreter */

const say = (def: SurveyDefinition, text: string) => interpretRequest(def, text);
function answer(i: Interpretation) { assert.equal(i.kind, "answer", JSON.stringify(i).slice(0, 400)); return i as Extract<Interpretation, { kind: "answer" }>; }

test("interpreter — “why are you recommending driver analysis?” is the engine's explanation: objective, variables, why, output, sample, limitations", () => {
  const def = survey();
  const i = answer(say(def, "Why are you recommending driver analysis?"));
  assert.equal(i.category, "analysis");
  assert.match(i.answer, /^Driver analysis is recommended because Q6 measures purchase intention and Q2–Q4 measure potential drivers\./);
  assert.deepEqual(i.sections.map((s) => s.title), ["Objective", "Variables", "Why this method", "Expected output", "Required sample", "Limitations"]);
  assert.ok(i.sections.find((s) => s.title === "Variables")!.items.some((x) => x.label === "Q6 (PURCHASE_INT) — outcome" && x.key === "question:pi"));
  assert.match(i.sections.find((s) => s.title === "Required sample")!.items[0].label, /^about 109 completes/);
  /* by method and variable */
  const t = answer(say(def, "why a t-test on Q6"));
  assert.match(t.answer, /^A t-test is recommended because Q6 measures purchase intention/);
  assert.equal(t.sections.find((s) => s.title === "Why this method")!.items[0].label, "Q6 is an ordinal 5-point scale and Q2 is nominal with 2 groups, so the comparison of means is a t-test; with 3+ groups it would be ANOVA.");
  /* by the two variables of a table */
  const c = answer(say(def, "why is Q6 crossed with S2?"));
  assert.match(c.answer, /^A crosstab of Q6 by S2, S3 is recommended/);
  /* the whole plan */
  const p = answer(say(def, "explain the analysis plan"));
  assert.match(p.answer, /^The engine's plan \(not saved yet\) has \d+ items; each follows from the measurement levels/);
  assert.ok(p.sections.find((s) => s.title === "Why each item")!.items.length >= 5);
  assert.equal(answer(say(def, "why this analysis?")).sections[1].title, "Why each item");
  /* a method the plan does not have is said, not invented */
  const none = answer(say(def, "why a conjoint?"));
  assert.match(none.answer, /^The engine's plan has no conjoint — it plans /);
  /* "create an analysis framework" is still the proposal; "why is Q8 not showing" is still the Studio grammar's */
  assert.equal(say(def, "Create an analysis framework for this research").kind, "actions");
  const grammar = say(def, "why is Q6 not showing");
  assert.equal(grammar.kind, "model");
});

test("interpreter — “what sample size do I need for this plan?”: the largest base, the item that drives it, against the expected sample", () => {
  const def = survey({ quotas: [{ id: "q1", name: "Country", cells: [{ id: "c1", label: "US", when: rule("COUNTRY", 1), limit: 80, target: 50 }, { id: "c2", label: "UK", when: rule("COUNTRY", 2), limit: 80, target: 50 }] }] });
  const i = answer(say(def, "What sample size do I need for this plan?"));
  assert.match(i.answer, /^The plan needs about 109 completes, driven by the regression of Q6 on Q2–Q4 \(max\(50 \+ 8·5, 104 \+ 5\) for 5 predictors\)\. That is more than the quotas target 100 \(100 completes — quota “Country”, the sum of its 2 cells' targets\)\.$/);
  assert.deepEqual(i.sections.map((s) => s.title), ["Required sample by item", "Expected sample", "The rule that drives it"]);
  const bare = answer(say(survey(), "how many completes do we need for the analysis?"));
  assert.match(bare.answer, /No sample is recorded to compare it with/);
});

test("set_research records the planned sample size — and keeps a saved analysis plan (it used to rebuild the design without it)", () => {
  const def = survey();
  def.research!.analysisPlan = buildAnalysisFramework(def, { now: "" });
  const n = def.research!.analysisPlan.crosstabs.length;
  const out = applySurveyActions(def, coerceSurveyActions([{ op: "set_research", objective: "Why consumers choose Brand A", sampleSize: 400 }]).actions);
  assert.ok(out.valid, out.errors.join());
  assert.equal(out.def.research!.sampleSize, 400);
  assert.equal(out.def.research!.analysisPlan?.crosstabs.length, n, "the plan survives an edit of the research design");
  assert.equal(expectedSample(out.def)!.n, 400);
  const again = applySurveyActions(out.def, coerceSurveyActions([{ op: "set_research", hypotheses: ["H"] }]).actions);
  assert.equal(again.def.research!.sampleSize, 400, "kept when not named");
});

/* ------------------------------------------------------------ mutation-checked edges (Phase 6) */

test("requiredBase — edges: a share above one half is read as its complement; a mean table needs no cells; an ANOVA with no groups assumes 3; a derived box splits in 2; an unknown segment variable in 3", () => {
  const def = survey();
  def.questions.push({ ...def.questions[0], id: "b7", code: "Q9", variableName: "BRAND7", text: "Brand bought last", options: opts("A", "B", "C", "D", "E", "F", "G") } as never);
  (def.flow[1] as { children: { questionIds: string[] }[] }).children[0].questionIds.push("b7");
  const logit = requiredBase(def, tt({ method: "logistic_regression", outcome: "AD_EXPOSE", variables: ["TRUST_1", "TRUST_2"] }), { outcomeShare: 0.8 });
  assert.equal(logit.minimum, 100, "0.8 is the common outcome's share: the rarer one is 20%, so 10 × 2 ÷ 0.2");
  assert.match(logit.note, /20% rarer outcome/);
  assert.equal(requiredBase(def, tt({ method: "logistic_regression", outcome: "AD_EXPOSE", variables: ["TRUST_1", "TRUST_2"] }), { outcomeShare: 1 }).minimum, 40, "a share of 1 says nothing about the rarer outcome: unknown");
  assert.deepEqual([requiredBase(def, xt(["BRAND7"], ["COUNTRY"])).minimum, requiredBase(def, xt(["BRAND7"], ["COUNTRY"])).note], [70, "5 per cell × 7 × 2"]);
  assert.deepEqual([requiredBase(def, xt(["BRAND7"], ["COUNTRY"], { measure: "mean" })).minimum, requiredBase(def, xt(["BRAND7"], ["COUNTRY"], { measure: "mean" })).note], [60, "30 per column × 2 columns of S3"], "a table of means has no cells to fill");
  assert.deepEqual([requiredBase(def, tt({ method: "anova", outcome: "PURCHASE_INT" })).minimum, requiredBase(def, tt({ method: "anova", outcome: "PURCHASE_INT" })).note], [60, "20 per group × 3 groups"]);
  const plan = buildAnalysisFramework(def, { now: "" });
  assert.ok(plan.derived.some((d) => d.name === "PURCHASE_INT_T2B"));
  assert.deepEqual([requiredBase(def, xt(["PURCHASE_INT"], ["PURCHASE_INT_T2B"]), { plan }).minimum, requiredBase(def, xt(["PURCHASE_INT"], ["PURCHASE_INT_T2B"]), { plan }).note], [60, "30 per column × 2 columns of PURCHASE_INT_T2B"], "a top-2-box is two groups");
  assert.deepEqual([requiredBase(def, { name: "Mixed", by: ["GENDER", "SOME_FIELD"] }).minimum, requiredBase(def, { name: "Mixed", by: ["GENDER", "SOME_FIELD"] }).note], [270, "30 per segment × 9 segments"], "a variable of unknown categories counts as 3");
});

test("expectedSample — edges: the LARGEST of the targeted quotas; a percent cell is not a count; a target total beats the cells' targets", () => {
  const two = survey({ quotas: [
    { id: "q1", name: "Gender", cells: [{ id: "c1", label: "Male", when: rule("GENDER", 1), limit: 90, target: 60 }, { id: "c2", label: "Female", when: rule("GENDER", 2), limit: 90, target: 60 }] },
    { id: "q2", name: "Country", cells: [{ id: "c3", label: "US", when: rule("COUNTRY", 1), limit: 90, target: 75 }, { id: "c4", label: "UK", when: rule("COUNTRY", 2), limit: 90, target: 75 }] },
  ] });
  assert.equal(expectedSample(two)!.n, 150, "each independent quota covers the whole sample: the largest says how many");
  const pct = survey({ quotas: [{ id: "q1", name: "Mix", cells: [{ id: "c1", label: "Male", when: rule("GENDER", 1), limit: 100 }, { id: "c2", label: "Female", when: rule("GENDER", 2), limit: 50, limitType: "percent" }] }] });
  assert.deepEqual([expectedSample(pct)!.n, expectedSample(pct)!.detail], [100, "100 completes — quota “Mix”, the sum of its 1 cells' maximums"], "50% is not 50 completes");
  const total = survey({ quotas: [{ id: "q1", name: "Main", targetTotal: 400, cells: [{ id: "c1", label: "US", when: rule("COUNTRY", 1), limit: 90, target: 60 }, { id: "c2", label: "UK", when: rule("COUNTRY", 2), limit: 90, target: 60 }] }] });
  assert.deepEqual([expectedSample(total)!.n, expectedSample(total)!.detail], [400, "400 completes — quota “Main”, its target total"]);
});

test("the review — edges: exactly enough is enough; the banding remedy names only the variables with more than 2 groups", () => {
  const def = survey(); def.research!.sampleSize = 107;
  def.research!.analysisPlan = { crosstabs: [xt(["PURCHASE_INT"], ["GENDER", "COUNTRY"], { id: "xb" })], tests: [tt({ id: "tr", method: "regression", outcome: "PURCHASE_INT", variables: ["TRUST_1", "TRUST_2", "PRICE_PERC"] }), tt({ id: "tt", method: "t_test", outcome: "PURCHASE_INT", groupBy: "AD_EXPOSE" })], derived: [], segments: [] };
  assert.ok(!reviewAnalysisPlan(def).some((i) => i.itemId === "tr"), "107 completes for a regression that needs 107 is enough");
  def.research!.sampleSize = 60;
  const xb = reviewAnalysisPlan(def).find((i) => i.itemId === "xb")!;
  assert.equal(xb.message, "Q6 by S2, S3 needs about 90 completes (30 per column × 3 columns of S2) — the research design plans 60.");
  assert.equal(xb.suggestion, "Consider banding S2 into fewer groups, or raise the sample.", "S3 has two groups: banding it is no remedy");
  /* the explanation says the same: 60 for a t-test that needs 60 is enough */
  const e = explainPlanItem(def, def.research!.analysisPlan.tests[1], def.research!.analysisPlan);
  assert.match(e.text, /It needs about 60 completes \(30 per group × 2 groups\); the research design plans 60\./);
});

test("the framework — edges: a banner column that exactly fits stays; when nothing fits, the coarsest cut is kept and said; an ANOVA too big for the sample is told how far to band", () => {
  const exact = survey(); exact.research!.sampleSize = 90;
  const p1 = buildAnalysisFramework(exact, { now: "" });
  const b1 = p1.crosstabs.find((x) => x.rows[0] === "PURCHASE_INT" && x.reason?.includes("sample profile"))!;
  assert.deepEqual(b1.columns, ["GENDER", "COUNTRY"], "30 × 3 groups = 90 expected: S2 fits exactly");
  assert.ok(!/left out|consider banding/.test(b1.reason!), b1.reason);
  const tiny = survey(); tiny.research!.sampleSize = 50;
  const b2 = buildAnalysisFramework(tiny, { now: "" }).crosstabs.find((x) => x.rows[0] === "PURCHASE_INT" && x.reason?.includes("sample profile"))!;
  assert.deepEqual(b2.columns, ["COUNTRY"], "neither fits 50: the 2-group cut is kept, not the 3-group one");
  assert.match(b2.reason!, /S2 \(3 groups\) left out of the banner — 50 expected completes cannot give each group 30; consider banding it; S3 has more groups than 50 completes read well — consider banding$/);
  /* a 6-group independent compared on a scale outcome, with 50 expected */
  const six = survey(); six.research!.sampleSize = 50;
  six.questions.push({ ...six.questions[0], id: "region", code: "S4", variableName: "REGION", text: "Region", options: opts("N", "S", "E", "W", "C", "Other") } as never);
  (six.flow[1] as { children: { questionIds: string[] }[] }).children[0].questionIds.push("region");
  six.research!.constructs.push({ name: "Region", role: "independent", questionIds: ["region"] });
  const plan = buildAnalysisFramework(six, { now: "" });
  const anova = plan.tests.find((t) => t.method === "anova" && t.groupBy === "REGION" && t.outcome === "PURCHASE_INT")!;
  assert.match(anova.reason!, /— 6 groups need about 120 completes and 50 are expected; consider banding S4 into 2 or fewer groups$/);
  /* … and its explanation warns that six groups are small groups */
  assert.ok(explainPlanItem(six, anova, plan).limitations.includes("S4 has 6 groups — small groups make the test weak; consider banding it."));
});

test("the framework — a two-option multi-select is not a regression predictor either", () => {
  const def = survey();
  def.research!.constructs.push({ name: "Channels", role: "independent", questionIds: ["ch"] });
  def.questions.push({ ...def.questions[2], id: "ch", code: "Q7", variableName: "CHANNELS", text: "Where have you seen Brand A?", options: opts("TV", "Online") } as never);
  (def.flow[1] as { children: { questionIds: string[] }[] }).children[0].questionIds.push("ch");
  const plan = buildAnalysisFramework(def, { now: "" });
  assert.ok(plan.tests.some((t) => t.method === "regression" && t.outcome === "PURCHASE_INT"));
  assert.ok(!plan.tests.some((t) => t.variables.includes("CHANNELS") || t.groupBy === "CHANNELS"), JSON.stringify(plan.tests.filter((t) => t.variables.includes("CHANNELS"))));
});

test("explainPlanItem — collinearity is said for three predictors or more, not for two", () => {
  const def = survey();
  const three = explainPlanItem(def, tt({ method: "regression", outcome: "PURCHASE_INT", variables: ["TRUST_1", "TRUST_2", "PRICE_PERC"] }));
  const two = explainPlanItem(def, tt({ method: "regression", outcome: "PURCHASE_INT", variables: ["TRUST_1", "TRUST_2"] }));
  const coll = "Predictors that measure related things are correlated (collinearity): their individual coefficients can be unstable even when the model fits.";
  assert.ok(three.limitations.includes(coll));
  assert.ok(!two.limitations.includes(coll));
});

/** a randomizer over concept blocks, with the arm's variable set in each block (or not), any number of arms */
function design(o: { show?: number; values?: (string | null)[]; parallel?: boolean[] } = {}) {
  const def = survey();
  const values = o.values ?? ["A", "B"];
  const kids = values.map((v, i) => {
    const id = `b${i}`;
    const qs = [`s${i}`, ...(o.parallel?.[i] ? [`pi${i}`] : [])];
    def.questions.push({ ...def.questions[0], id: `s${i}`, code: `C${i + 1}`, variableName: `STIM_${i}`, type: "html", text: `Concept ${i}`, options: [] } as never);
    if (o.parallel?.[i]) {
      def.questions.push({ ...def.questions[7], id: `pi${i}`, code: `Q${20 + i}`, variableName: `PI_${i}`, text: `How likely to buy concept ${i}?` } as never);
      def.research!.constructs.find((c) => c.name === "Purchase intention")!.questionIds.push(`pi${i}`);
    }
    return { type: "block", id, title: `Concept ${i}`, children: [...(v != null ? [{ type: "embedded_data", id: `ed${i}`, fields: [{ name: "ARM", source: "static", value: v }] }] : []), { type: "page", id: `p${id}`, questionIds: qs }] };
  });
  (def.flow as unknown[]).splice(1, 0, { type: "randomizer", id: "rz", title: "Concepts", show: o.show ?? 1, evenPresentation: true, children: kids });
  return SurveyDefinition.parse(def);
}

test("monadicDesigns — edges: show 2 is not monadic; one value in every arm records nothing; three arms are an ANOVA; a question in only some arms is not a parallel outcome", () => {
  assert.equal(monadicDesigns(design()).length, 1);
  assert.equal(monadicDesigns(design()).at(0)!.armVariable, "ARM");
  assert.deepEqual(monadicDesigns(design({ show: 2 })), [], "each respondent sees two blocks: not monadic");
  assert.equal(monadicDesigns(design({ values: ["A", "A"] }))[0].armVariable, null, "the same value in every arm does not say which arm");
  const three = design({ values: ["A", "B", "C"] });
  const t3 = buildAnalysisFramework(three, { now: "" }).tests.find((t) => t.groupBy === "ARM" && t.outcome === "PURCHASE_INT")!;
  assert.equal(t3.method, "anova");
  assert.match(t3.reason!, /one of 3 blocks/);
  const all = design({ parallel: [true, true] });
  assert.equal(monadicDesigns(all)[0].parallel.length, 1);
  const some = design({ parallel: [true, false] });
  assert.deepEqual(monadicDesigns(some)[0]?.parallel ?? [], [], "a question asked in one arm only is not the same outcome in every arm");
});

test("interpreter — edges: “what is the sample size?” and “set the sample size …” are not the planner's question; a pair needs both variables; a hypothesis-linked item is explained first; “regression” finds a logistic one", () => {
  const def = survey();
  for (const t of ["what is the sample size?", "set the sample size to 400 for the analysis"]) {
    const i = say(def, t);
    assert.ok(!(i.kind === "answer" && /^The plan needs about/.test(i.answer)), `${t} → ${JSON.stringify(i).slice(0, 200)}`);
  }
  const pair = say(def, "why is Q6 crossed with Q99?");
  assert.equal(pair.kind, "refused");
  assert.match((pair as Extract<Interpretation, { kind: "refused" }>).reason, /^Q99 is not a question or planned variable of this survey\.$/);
  /* two t-tests: the one a hypothesis names is the one explained, whatever the order */
  const two = survey();
  two.research!.analysisPlan = { crosstabs: [], derived: [], segments: [], tests: [tt({ id: "plain", method: "t_test", outcome: "PURCHASE_INT", groupBy: "COUNTRY" }), tt({ id: "linked", method: "t_test", outcome: "PURCHASE_INT", groupBy: "AD_EXPOSE", hypotheses: ["H1"] })] };
  const t = answer(say(two, "why a t-test?"));
  assert.match(t.answer, /^A t-test is recommended because Q6 measures purchase intention and Q2 splits the sample into two groups\./);
  assert.deepEqual(t.sections.find((s) => s.title === "Also planned")!.items.map((x) => x.label), ["The t-test of Q6 across S3"]);
  /* “a regression” is any of the regression family */
  const logit = survey();
  logit.research!.analysisPlan = { crosstabs: [], derived: [], segments: [], tests: [tt({ id: "lr", method: "logistic_regression", outcome: "AD_EXPOSE", variables: ["TRUST_1", "TRUST_2"] })] };
  assert.match(answer(say(logit, "why are you recommending a regression?")).answer, /^A logistic regression is recommended because Q2 is a yes\/no outcome/);
});
