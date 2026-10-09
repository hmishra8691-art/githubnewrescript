import test from "node:test";
import assert from "node:assert/strict";
import { def as base, synthDataset, synthRows, spec } from "./analyses/fixture.js";
import { buildDataset, type AnalyticsRow } from "./dataset.js";
import { adjustP, pairwiseComparisons } from "./posthoc.js";
import { adviseAnalysis, adviceSummary, skewness } from "./dataAdvice.js";
import { discoverSegments, findAnomalies, waveTrends, waveVariable, synthesize } from "./synthesis.js";
import { answerDataQuery } from "./dataQuery.js";
import { applyCorrections, correctedVerdict, runPlan, briefText, compactRun, type RunItem, type Finding, type HypothesisVerdict } from "./findings.js";
import type { AnalysisDefinition } from "./types.js";
import type { DataQuery } from "@rescript/engine";
import { SurveyDefinition } from "@rescript/schema";

/*
 * RESEARCH ENGINE PHASE 4 — automated analysis: the planned tests' p-values
 * corrected as families, the pairs that differ behind a significant ANOVA,
 * what the data says about each method, the findings beyond the plan, and
 * data questions answered on the dataset. The synthetic data plants a
 * gender effect on satisfaction (and so on the items and NPS), a weak
 * country lift, and no region effect.
 */

const D = (kind: AnalysisDefinition["kind"], variables: string[], extra: Partial<AnalysisDefinition> = {}): AnalysisDefinition => ({ name: kind, kind, dataset: spec, variables, ...extra });

function planned() {
  const def = structuredClone(base);
  def.research = {
    objective: "What drives satisfaction", population: "adults",
    hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], hypothesisDetails: [], researchQuestions: [], kpis: [],
    constructs: [], analysis: [], assumptions: [], sources: [],
    analysisPlan: {
      crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER", "REGION"], priority: 1, hypotheses: ["H1"] }],
      tests: [
        { id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] },
        { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 1, hypotheses: ["H2"] },
        { id: "t3", method: "anova", outcome: "NPS", variables: ["NPS"], groupBy: "COUNTRY", priority: 2, hypotheses: ["H2"] },
        { id: "t4", method: "correlation", variables: ["SAT", "NPS"], priority: 2, hypotheses: [] },
      ],
      derived: [], segments: [],
    },
  } as never;
  return def;
}

test("p-values are adjusted as a family: Holm step-down, Bonferroni, Benjamini–Hochberg — nulls stay out of the family", () => {
  const ps = [0.01, 0.04, 0.03, null, 0.2];
  assert.deepEqual(adjustP(ps, "bonferroni").map((x) => (x == null ? null : +x.toFixed(3))), [0.04, 0.16, 0.12, null, 0.8]);
  // Holm: sorted .01 .03 .04 .2 × (4,3,2,1) = .04 .09 .08→.09 (monotone) .2
  assert.deepEqual(adjustP(ps, "holm").map((x) => (x == null ? null : +x.toFixed(3))), [0.04, 0.09, 0.09, null, 0.2]);
  // BH: step-up — .2×4/4=.2; .04×4/3=.0533; .03×4/2=.06→min(.0533)=.0533; .01×4/1=.04
  assert.deepEqual(adjustP(ps, "bh").map((x) => (x == null ? null : +x.toFixed(3))), [0.04, 0.053, 0.053, null, 0.2]);
  assert.deepEqual(adjustP([], "holm"), []);
  assert.deepEqual(adjustP([null, undefined], "holm"), [null, null]);
  assert.equal(adjustP([0.9, 0.8], "bonferroni")[0], 1, "never above 1");
});

test("pairwise comparisons: every pair of groups, each p adjusted in the family of pairs, the summary naming the pairs that differ", () => {
  const ds = synthDataset(400);
  const pw = pairwiseComparisons(ds, "SAT", "REGION");
  assert.equal(pw.pairs.length, 3, "three regions → three pairs");
  assert.ok(pw.pairs.every((p) => p.pAdj != null && p.pAdj >= (p.p ?? 0)), "an adjusted p is never below the raw one");
  assert.match(pw.summary, /^Pairwise \(Holm-adjusted, 3 pairs\)/);
  // no region effect is planted: nothing differs
  assert.equal(pw.significant.length, 0);
  assert.match(pw.summary, /no pair differs once the comparisons are corrected/);
  // a strong planted effect: the pair differs, and the summary says which way
  const g = pairwiseComparisons(ds, "SAT", "GENDER");
  assert.equal(g.pairs.length, 1);
  assert.equal(g.significant.length, 1);
  assert.match(g.summary, /Female > Male \(3\.\d\d vs 3\.\d\d, p < \.001\)/);
  const np = pairwiseComparisons(ds, "SAT", "GENDER", { nonparametric: true });
  assert.equal(np.test, "mann_whitney");
  assert.equal(np.pairs[0].test, "mann_whitney");
  const npr = pairwiseComparisons(ds, "SAT", "REGION", { nonparametric: true });
  assert.notEqual(npr.pairs[0].p, pw.pairs[0].p, "a rank test gives its own p");
  // eight countries, a small lift: some pairs are significant on their own and not once the 28 are corrected
  const c = pairwiseComparisons(ds, "NPS", "COUNTRY");
  const rawSig = c.pairs.filter((p) => p.p != null && p.p < 0.05);
  assert.ok(rawSig.length > c.significant.length, `${rawSig.length} raw vs ${c.significant.length} adjusted`);
  assert.ok(c.pairs.every((p) => p.significant === (p.pAdj != null && p.pAdj < 0.05)), "significance is read from the adjusted p");
});

test("the planned tests are corrected by hypothesis family; a finding that loses significance is named, and the raw verdict stays", () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { now: "2026-10-09T00:00:00Z" });
  assert.ok(run.corrections, "the run carries its corrections");
  assert.equal(run.corrections!.method, "holm");
  const fam = Object.fromEntries(run.corrections!.families.map((f) => [f.family, f]));
  // H1: the crosstab's two banner findings and t1 — three tests; H2: t2 and t3; the correlation serves no hypothesis
  assert.equal(fam.H1.tests, 3); assert.equal(fam.H2.tests, 2); assert.equal(fam.plan.tests, 1);
  assert.ok(run.corrections!.families.indexOf(fam.plan) === run.corrections!.families.length - 1, "the plan family is listed last");
  for (const f of run.findings.filter((x) => x.evidence.adjusted)) assert.ok(f.evidence.adjusted!.p >= (f.evidence.p ?? 0), `${f.id}: adjusted ≥ raw`);
  // the planted gender effect holds under correction; the summary says every significant finding holds
  const t1 = run.findings.find((f) => f.analysis.planned === "t1")!;
  assert.equal(t1.evidence.adjusted!.significant, true);
  assert.match(run.corrections!.summary, /^Holm correction over 3 tests for H1, 2 tests for H2, 1 test for the plan: every significant finding holds\./);
  // no correction when asked
  const raw = runPlan(def, synthDataset(400), { correction: "none", discover: false });
  assert.equal(raw.corrections, undefined);
  assert.ok(raw.findings.every((f) => !f.evidence.adjusted));
  // a family built by hand where a borderline finding does not survive: Holm over three → .04 × 3 = .12
  const fake = (id: string, p: number, hyps: string[]): Finding => ({ id, kind: p < 0.05 ? "difference" : "no_difference", strength: "weak", significant: p < 0.05, headline: id, evidence: { p, n: 100 }, variables: ["A", "B"], hypotheses: hyps, analysis: { name: id, kind: "test", hash: id } });
  const items = [{ findings: [fake("a", 0.04, ["H1"]), fake("b", 0.01, ["H1"]), fake("c", 0.03, ["H1"])] }] as unknown as RunItem[];
  const c = applyCorrections(items, "holm");
  assert.deepEqual(c.families[0].lost.sort(), ["a", "c"]);
  assert.equal(c.families[0].before, 3); assert.equal(c.families[0].after, 1);
  assert.match(c.summary, /2 findings significant on their own are not once corrected/);
  // the verdict with the correction read: supported → mixed when some of its tests still hold, → not supported when none does
  const v: HypothesisVerdict = { label: "H1", text: "t", verdict: "supported", reason: "r", findings: items[0].findings, analyses: 1 };
  assert.equal(correctedVerdict(v)!.verdict, "mixed");
  assert.match(correctedVerdict(v)!.note, /After Holm correction for 3 tests, 1 of 3 significant findings still holds — mixed rather than supported/);
  const none = [{ findings: [fake("a", 0.04, ["H1"]), fake("c", 0.045, ["H1"])] }] as unknown as RunItem[];
  applyCorrections(none, "holm");
  assert.equal(correctedVerdict({ ...v, findings: none[0].findings })!.verdict, "not_supported");
  assert.equal(correctedVerdict({ ...v, findings: [fake("z", 0.001, ["H1"])] }), undefined, "nothing lost → no corrected verdict");
  assert.equal(correctedVerdict({ ...v, verdict: "not_supported", findings: none[0].findings }), undefined, "already not supported → unchanged");
  assert.equal(correctedVerdict({ ...v, verdict: "mixed", findings: items[0].findings }), undefined, "mixed with something still holding stays mixed → no note");
});

test("a significant ANOVA carries the pairs that differ, Holm-adjusted, in the finding's detail", () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { discover: false });
  const t3 = run.findings.find((f) => f.analysis.planned === "t3")!;
  assert.equal(t3.kind, "difference");
  assert.ok(t3.evidence.pairwise, "the pairs travel with the finding");
  assert.equal(t3.evidence.pairwise!.pairs.length, 28, "eight countries → 28 pairs");
  assert.match(t3.detail ?? "", /Pairwise \(Holm-adjusted, 28 pairs\): .+ > .+ \(\d\.\d\d vs \d\.\d\d, p = \.\d{3}\)/);
  // a non-significant ANOVA (region) carries no pairs; a two-group test carries none
  const t2 = run.findings.find((f) => f.analysis.planned === "t2")!;
  assert.equal(t2.evidence.pairwise, undefined);
  const t1 = run.findings.find((f) => f.analysis.planned === "t1")!;
  assert.equal(t1.evidence.pairwise, undefined);
  // an ANOVA planned on a two-group variable: significant, but there is only one pair — nothing to add
  const two = structuredClone(def);
  two.research!.analysisPlan!.tests = [{ id: "t9", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }];
  const r2 = runPlan(two, synthDataset(400), { discover: false });
  const t9 = r2.findings.find((f) => f.analysis.planned === "t9")!;
  assert.equal(t9.evidence.test, "anova_one_way"); assert.equal(t9.significant, true);
  assert.equal(t9.evidence.pairwise, undefined, "two groups: no pairwise");
});

test("data advice: thin cells recommend Fisher's exact on a 2×2, skewed small groups a rank test, a ceiling a top-box reading; a clean method has no advice", () => {
  assert.equal(skewness([1, 2, 3, 4, 5]), 0);
  assert.ok((skewness([1, 1, 1, 1, 1, 1, 1, 1, 10]) ?? 0) > 1, "a long right tail is skewed");
  assert.equal(skewness([1, 2]), null);
  const ds = synthDataset(400);
  // the planned t-test on the planted gender effect: nothing to flag
  const clean = adviseAnalysis(D("test", ["SAT", "GENDER"]), ds);
  assert.equal(clean.ok, true);
  assert.equal(clean.recommended, undefined);
  assert.equal(clean.summary, "The data meets the method's assumptions as far as the checks go.");
  // a 2×2 with a thin cell: gender by a rare flag
  const rows: AnalyticsRow[] = synthRows(120).map((r, i) => ({ ...r, answers: { ...r.answers, q_region: i < 4 ? 3 : (i % 2) + 1 } }));
  const thin = adviseAnalysis(D("crosstab", ["REGION", "GENDER"], { rows: ["REGION"], columns: ["GENDER"] }), buildDataset(base, rows, { spec }));
  assert.ok(thin.checks.some((c) => c.code === "expected_cells"), thin.summary);
  assert.ok(thin.checks.some((c) => c.code === "thin_category" && /East/.test(c.message)), "the thin category is named");
  assert.equal(thin.recommended?.test, "chi_square", "a 3×2 table: combine categories");
  const two: AnalyticsRow[] = synthRows(60).map((r, i) => ({ ...r, answers: { ...r.answers, q_gender: i < 3 ? 1 : 2 } }));
  const fisher = adviseAnalysis(D("crosstab", ["REGION", "GENDER"], { rows: ["REGION"], columns: ["GENDER"] }), buildDataset(base, two, { spec }));
  assert.ok(fisher.checks.some((c) => c.code === "small_group" && /Male \(n = 3\)/.test(c.message)));
  const two2: AnalyticsRow[] = synthRows(60).map((r, i) => ({ ...r, answers: { ...r.answers, q_gender: i < 3 ? 1 : 2, q_region: (i % 2) + 1 } }));
  const f2 = adviseAnalysis(D("test", ["REGION", "GENDER"]), buildDataset(base, two2, { spec }));
  assert.equal(f2.recommended?.test, "fisher_exact", f2.summary);
  // small skewed groups on a t-test: Mann–Whitney
  const skew: AnalyticsRow[] = synthRows(40).map((r, i) => ({ ...r, answers: { ...r.answers, q_gender: i < 12 ? 1 : 2, q_age: i < 12 ? (i === 0 ? 80 : 20) : 40 + (i % 5) } }));
  const mw = adviseAnalysis(D("test", ["AGE", "GENDER"]), buildDataset(base, skew, { spec }));
  assert.ok(mw.checks.some((c) => c.code === "small_group"));
  assert.ok(mw.checks.some((c) => c.code === "skew"));
  assert.equal(mw.recommended?.test, "mann_whitney");
  assert.match(mw.summary, /Recommended: Mann–Whitney — Age is skewed/);
  // a scale at its ceiling under a parametric test: a top-box reading
  const ceil: AnalyticsRow[] = synthRows(200).map((r, i) => ({ ...r, answers: { ...r.answers, q_sat: i % 10 < 7 ? 5 : 1 + (i % 4) } }));
  const top = adviseAnalysis(D("test", ["SAT", "GENDER"]), buildDataset(base, ceil, { spec }));
  assert.ok(top.checks.some((c) => c.code === "ceiling" && /70% chose the top point \(5\)/.test(c.message)), top.summary);
  assert.equal(top.recommended?.test, "top_box");
  // a regression with too few cases per predictor
  const reg = adviseAnalysis(D("regression", ["NPS", "SAT", "AGE", "REGION", "COUNTRY"]), buildDataset(base, synthRows(35), { spec }));
  assert.ok(reg.checks.some((c) => c.code === "few_per_predictor" && /35 cases for 4 predictors/.test(c.message)));
  assert.match(adviceSummary([clean, mw]), /^1 of 2 analyses has data advice: test — recommended Mann–Whitney\.$/);
  assert.match(adviceSummary([clean]), /meets the planned methods' assumptions for all 1 analyses/);
});

test("runPlan({ adapt: true }) runs the recommended method beside the planned one, and the run lists its advice", () => {
  const def = planned();
  // make the t-test's groups small and skewed so the advice recommends Mann–Whitney
  const rows: AnalyticsRow[] = synthRows(44).map((r, i) => ({ ...r, answers: { ...r.answers, q_gender: i < 12 ? 1 : 2, q_sat: i < 12 ? (i === 0 ? 5 : 1) : 3 + (i % 3) } }));
  const ds = buildDataset(def, rows, { spec });
  const plain = runPlan(def, ds, { discover: false });
  assert.ok(plain.advice?.some((a) => a.planned === "t1" && a.recommended?.test === "mann_whitney"), JSON.stringify(plain.advice?.map((a) => [a.planned, a.recommended?.test])));
  assert.equal(plain.items.length, 5, "no adapted item unless asked");
  const adapted = runPlan(def, ds, { adapt: true, discover: false });
  const extra = adapted.items.find((it) => it.adaptedFrom === "t1");
  assert.ok(extra, "the recommended method ran beside the planned one");
  assert.equal(extra!.definition.options?.test, "mann_whitney");
  assert.match(extra!.definition.name, /\(Mann–Whitney\)$/);
  assert.deepEqual(extra!.hypotheses, ["H1"], "it serves the same hypothesis");
  assert.ok(extra!.findings[0].evidence.test === "mann_whitney");
  assert.match(briefText(plain), /Data advice: \d of \d analyses ha(?:s|ve) data advice: .*recommended Mann–Whitney/);
});

test("beyond the plan: segment differences the plan did not test, corrected as one family and held to an effect; constants and system columns are never 'outcomes'", () => {
  const def = planned();
  const ds = synthDataset(400);
  const seg = discoverSegments(def, ds);
  assert.ok(!seg.outcomes.some((o) => o.startsWith("_")), `system columns are not looked at: ${seg.outcomes.join(", ")}`);
  assert.ok(seg.outcomes.includes("ALLOC_total") && !seg.findings.some((f) => f.variables[0] === "ALLOC_total"), "a constant column is looked at and never found to differ");
  assert.ok(seg.cuts.includes("GENDER") && seg.cuts.includes("REGION") && seg.cuts.includes("COUNTRY"));
  // the planned pairs are skipped: SAT by GENDER / REGION, NPS by COUNTRY
  assert.ok(!seg.findings.some((f) => f.variables.join("|") === "SAT|GENDER" || f.variables.join("|") === "NPS|COUNTRY"));
  // the planted gender effect shows on the items and on NPS, which the plan never cut by gender
  const byGender = seg.findings.filter((f) => f.variables[1] === "GENDER").map((f) => f.variables[0]);
  assert.ok(byGender.includes("NPS") && byGender.includes("ITEMS_b"), byGender.join(", "));
  for (const f of seg.findings) {
    assert.equal(f.kind, "segment");
    assert.equal(f.significant, true);
    assert.ok(f.strength === "moderate" || f.strength === "strong", `${f.id} ${f.strength}`);
    assert.equal(f.evidence.adjusted!.method, "holm");
    assert.equal(f.analysis.planned, undefined);
    assert.equal(f.hypotheses.length, 0);
  }
  const nps = seg.findings.find((f) => f.variables.join("|") === "NPS|GENDER")!;
  assert.match(nps.headline, /^Recommend\? differs by Gender: Female highest \(\d\.\d\d\), Male lowest \(\d\.\d\d\) \(ANOVA, p < \.001 Holm-adjusted, η² = 0\.\d\d\)\.$/);
  assert.ok(nps.evidence.groups?.length === 2);
  // nothing by region is planted: no region discovery
  assert.ok(!seg.findings.some((f) => f.variables[1] === "REGION"));
  assert.deepEqual(seg.findings.map((f) => f.variables.join("|")).sort(), ["ITEMS_a|GENDER", "ITEMS_b|GENDER", "NPS|GENDER"]);
  // a small planted effect: significant after correction but weak — not a discovery (it looked everywhere, so it needs an effect to show)
  const rows: AnalyticsRow[] = synthRows(400).map((r) => ({ ...r, answers: { ...r.answers, q_cheap: Number(r.answers!.q_cheap) + (r.answers!.q_gender === 2 ? 0.6 : 0) } }));
  const dsw = buildDataset(def, rows, { spec });
  assert.equal(pairwiseComparisons(dsw, "P_CHEAP", "GENDER").significant.length, 1, "the planted lift is significant");
  const segw = discoverSegments(def, dsw);
  assert.ok(!segw.findings.some((f) => f.variables[0] === "P_CHEAP"), "a weak effect is not reported as a discovery");
  // ordering: the largest effect first
  const effects = seg.findings.map((f) => Math.abs(f.evidence.effect?.value ?? 0));
  assert.deepEqual(effects, [...effects].sort((a, b) => b - a));
});

test("beyond the plan: anomalies — a scale at its ceiling, a dominant answer, thin categories, outliers, missing answers; a multi-select's option column is not 'dominant'", () => {
  const def = planned();
  assert.deepEqual(findAnomalies(def, synthDataset(20)), [], "no anomalies on a base too small to read");
  const rows: AnalyticsRow[] = synthRows(200).map((r, i) => ({ ...r, answers: { ...r.answers,
    q_sat: i % 10 < 7 ? 5 : 2,                        // ceiling
    q_region: i < 3 ? 3 : i % 20 === 0 ? 2 : 1,       // dominant North (>90%), thin East
    q_age: i % 50 === 0 ? 400 : 30 + (i % 20),        // outliers
    q_cheap: i % 2 ? undefined : r.answers!.q_cheap,  // half missing
  } }));
  const out = findAnomalies(def, buildDataset(def, rows, { spec }));
  const by = (code: string) => out.find((f) => f.id.startsWith(`anomaly:${code}:`));
  assert.match(by("ceiling")!.headline, /^Overall satisfaction is at its ceiling: 70% gave the top answer \(5\)/);
  assert.match(by("dominant")!.headline, /^Region: 9\d% answered “North”/);
  assert.match(by("thin")!.headline, /^Region: “East” \(3\) has fewer than five answers/);
  assert.match(by("outliers")!.headline, /^Age has 4 extreme values \(2%, outside \d+–\d+\) — they pull the mean; the median \(\d+\.\d\) is the safer centre\.$/);
  assert.match(by("missing")!.headline, /^Too cheap is unanswered by 50% of respondents/);
  assert.ok(out.every((f) => f.kind === "anomaly" && !f.significant && f.strength === "none"));
  // the brand awareness columns (90% aware of Alpha) are results, not anomalies
  assert.ok(!findAnomalies(def, synthDataset(400)).some((f) => f.id.startsWith("anomaly:dominant:AWARE")));
});

test("beyond the plan: trends across waves — the fieldwork month when no wave question exists; a planted move is found, a flat measure is not", () => {
  const def = planned();
  const w = waveVariable(def, synthDataset(400));
  assert.deepEqual(w, { variable: "_started_month", buckets: ["2026-06", "2026-07", "2026-08"], labels: ["2026-06", "2026-07", "2026-08"] });
  assert.equal(waveVariable(def, synthDataset(100)), null, "one month only: no waves");
  // nothing moves across months in the fixture
  const flat = waveTrends(def, synthDataset(400));
  assert.deepEqual(flat.findings, []);
  assert.deepEqual(flat.waves, { variable: "_started_month", buckets: ["2026-06", "2026-07", "2026-08"] });
  // plant a rise in satisfaction over the months (140 rows per month, by row index)
  const rows: AnalyticsRow[] = synthRows(400).map((r, i) => ({ ...r, answers: { ...r.answers, q_sat: Math.min(5, Math.max(1, Number(r.answers!.q_sat) + (i >= 280 ? 1 : 0))) } }));
  const up = waveTrends(def, buildDataset(def, rows, { spec }));
  const sat = up.findings.find((f) => f.variables[0] === "SAT")!;
  assert.ok(sat, "the planted rise is found");
  assert.equal(sat.kind, "trend");
  assert.match(sat.headline, /^Overall satisfaction rose across the waves: 2026-06 \d\.\d\d → 2026-08 \d\.\d\d \(\d\.\d\d → \d\.\d\d → \d\.\d\d\) \(ANOVA across 3 waves, p < \.001 Holm-adjusted\)\.$/);
  assert.equal(sat.evidence.groups?.length, 3);
  // a wave question wins over the calendar
  const raw = structuredClone(def) as unknown as { questions: unknown[]; flow: { questionIds: string[] }[] };
  raw.questions.push({ id: "q_wave", code: "W1", variableName: "WAVE", type: "single_select", text: "Wave", options: [{ code: 1, label: "Wave 1" }, { code: 2, label: "Wave 2" }] });
  raw.flow[0].questionIds.push("q_wave");
  const waved = SurveyDefinition.parse(raw);
  const wrows: AnalyticsRow[] = synthRows(200).map((r, i) => ({ ...r, answers: { ...r.answers, q_wave: i < 100 ? 1 : 2 } }));
  assert.deepEqual(waveVariable(waved, buildDataset(waved, wrows, { spec })), { variable: "WAVE", buckets: ["1", "2"], labels: ["Wave 1", "Wave 2"] });
});

test("the run carries its discoveries and the brief reads them; synthesize() sums them up", () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { now: "2026-10-09T00:00:00Z" });
  assert.ok(run.discoveries);
  assert.ok(run.discoveries!.segments.length >= 2);
  assert.equal(run.discoveries!.looked.waves?.buckets.length, 3);
  assert.match(run.discoveries!.summary, /^Beyond the plan: \d segment differences the plan did not test(?:, \d data anomal(?:y|ies))? \(\d+ outcome × cut pairs looked at, 3 waves; p-values Holm-adjusted\)\.$/);
  assert.equal(run.advice, undefined, "nothing to advise on the full dataset: no advice carried");
  const brief = briefText(run);
  assert.match(brief, /Corrections: Holm correction over/);
  assert.match(brief, /\n  Beyond the plan: /);
  assert.match(brief, /\n    \[segment\] Recommend\? differs by Gender/);
  // the compact run keeps the Phase 4 fields
  const compact = compactRun(run);
  assert.ok(compact.corrections && compact.discoveries);
  const none = runPlan(def, synthDataset(400), { discover: false });
  assert.equal(none.discoveries, undefined);
  const s = synthesize(def, synthDataset(40));
  assert.match(s.summary, /^Beyond the plan: nothing notable in \d+ outcome × cut pairs; no data anomalies\.$/);
});

test("data questions answered on the dataset: share and count with a CI, the average with its interval, a comparison with the test, which groups choose an option, the most common answer; population filters and bases", () => {
  const def = planned();
  const ds = synthDataset(400);
  const female = { condition: { type: "rule", source: { kind: "question", ref: "q_gender" }, operator: "eq", value: 2 }, expression: "Q1 = 2", words: "Q1 (GENDER) = “Female”" } as DataQuery["population"];
  const Q = (q: Partial<DataQuery> & { kind: DataQuery["kind"]; variable: string }): DataQuery => ({ question: "Q", words: "", ...q });
  const share = answerDataQuery(def, ds, Q({ kind: "share", variable: "CONSIDER", question: "Q7", option: { code: "1", label: "Alpha" } }));
  assert.match(share.text, /^78% of respondents chose “Alpha” \(Q7 — Brands considered, 242 of 311\), 95% CI 7\d%–8\d%\.$/);
  assert.equal(share.n, 400);
  const count = answerDataQuery(def, ds, Q({ kind: "count", variable: "CONSIDER", question: "Q7", option: { code: "1", label: "Alpha" }, population: female }));
  assert.match(count.text, /^127 of 166 respondents among Q1 \(GENDER\) = “Female” chose “Alpha” \(Q7 — Brands considered\) — 77%, 95% CI/);
  assert.equal(count.n, 208, "the base is the population");
  const byG = answerDataQuery(def, ds, Q({ kind: "share", variable: "CONSIDER", question: "Q7", option: { code: "1", label: "Alpha" }, by: ["GENDER"] }));
  assert.match(byG.text, /By Gender: highest (?:Male|Female) \(\d\d%\), lowest (?:Male|Female) \(\d\d%\) — the share does not differ significantly by Gender \(chi-square, p = \.\d{3}\)\.$/);
  assert.equal(byG.sections[0].title, "“Alpha” by Gender");
  assert.equal(byG.evidence?.test, "chi_square");
  // the groups' bases are those who considered anything, as the overall base is — 311, not every respondent
  const bases = byG.sections[0].items.map((i) => Number(/of (\d+)\)/.exec(i.detail ?? "")?.[1]));
  assert.equal(bases.reduce((a, b) => a + b, 0), 311, JSON.stringify(byG.sections[0].items));
  const mean = answerDataQuery(def, ds, Q({ kind: "mean", variable: "SAT", question: "Q4", by: ["GENDER"] }));
  assert.match(mean.text, /^The average Q4 — Overall satisfaction is 3\.48 \(median 4\.0, SD 0\.88, n = 400, 95% CI 3\.39–3\.57\)\. By Gender: Female 3\.86, Male 3\.07 — differs significantly \(Welch's t-test, p < \.001\)\.$/);
  assert.equal(mean.chart?.categories?.join(","), "Female,Male");
  const cmp = answerDataQuery(def, ds, Q({ kind: "compare", variable: "SAT", question: "Q4", by: ["REGION"] }));
  assert.match(cmp.text, /^No — Q4 — Overall satisfaction does not differ significantly by Region: South 3\.60 vs East 3\.40 \(South 3\.60, North 3\.44, East 3\.40\) \(ANOVA, p = \.171, η² = 0\.01\)\.$/);
  assert.equal(cmp.evidence?.significant, false);
  const cmp2 = answerDataQuery(def, ds, Q({ kind: "compare", variable: "SAT", question: "Q4", by: ["GENDER"] }));
  assert.match(cmp2.text, /^Yes — Q4 — Overall satisfaction differs by Gender: Female 3\.86 vs Male 3\.07 \(Welch's t-test, p < \.001, Cohen's d = -?1\.01 — a strong effect\)\.$/);
  const cmp3 = answerDataQuery(def, ds, Q({ kind: "compare", variable: "NPS", question: "Q5", by: ["COUNTRY"] }));
  assert.match(cmp3.text, /Pairwise \(Holm-adjusted, 28 pairs\): UK > France/);
  assert.equal(cmp3.sections[1].title, "Pairs that differ (Holm-adjusted)");
  const cat = answerDataQuery(def, ds, Q({ kind: "compare", variable: "GENDER", question: "Q1", by: ["REGION"] }));
  assert.match(cat.text, /^No — Q1 — Gender does not differ significantly by Region \(chi-square, p = \.680, Cramér's V = 0\.04\)\. The answer that moves most is “Female”: 54% of South vs 49% of East\.$/);
  const prefer = answerDataQuery(def, ds, Q({ kind: "prefer", variable: "CONSIDER", question: "Q7", option: { code: "1", label: "Alpha" } }));
  assert.match(prefer.text, /^78% of respondents chose “Alpha” \(Q7 — Brands considered, 242 of 311\)\. No group chooses it significantly more than the rest \(13 groups across 3 demographics, each against the rest, Holm-adjusted\)\.$/);
  assert.deepEqual(prefer.sections.map((s) => s.title), ["“Alpha” by Gender", "“Alpha” by Region", "“Alpha” by Country"]);
  // a planted preference: women consider Gamma far more
  const rows: AnalyticsRow[] = synthRows(400).map((r) => ({ ...r, answers: { ...r.answers, q_consider: r.answers!.q_gender === 2 ? [...new Set([...(r.answers!.q_consider as number[]), 3])] : (r.answers!.q_consider as number[]).filter((x) => x !== 3) } }));
  const planted = answerDataQuery(def, buildDataset(def, rows, { spec }), Q({ kind: "prefer", variable: "CONSIDER", question: "Q7", option: { code: "3", label: "Gamma" } }));
  assert.match(planted.text, /It is chosen more by Female \(Gender: 100% vs 0% of the rest, p < \.001\), and less by Male \(Gender: 0% vs 100% of the rest, p < \.001\)/);
  assert.equal(planted.evidence?.adjusted?.method, "holm");
  // a small lift (20% of women vs 12% of men): significant on its own, not once the 13 groups are corrected
  const slight: AnalyticsRow[] = synthRows(400).map((r, i) => { const g = r.answers!.q_gender; const want = g === 2 ? i % 5 === 0 : i % 7 === 0; const c = (r.answers!.q_consider as number[]).filter((x) => x !== 3); return { ...r, answers: { ...r.answers, q_consider: want ? [...c, 3] : c } }; });
  const sl = answerDataQuery(def, buildDataset(def, slight, { spec }), Q({ kind: "prefer", variable: "CONSIDER", question: "Q7", option: { code: "3", label: "Gamma" } }));
  assert.match(sl.text, /No group chooses it significantly more than the rest/);
  assert.equal(sl.evidence, undefined);
  const top = answerDataQuery(def, ds, Q({ kind: "top", variable: "CONSIDER", question: "Q7", by: ["GENDER"] }));
  assert.match(top.text, /^The most chosen answer to Q7 — Brands considered is “Alpha”: 78% \(242 of 311\), ahead of “Beta” at 47%\.$/);
  assert.equal(top.sections[1].title, "Most chosen by Gender");
  const small = answerDataQuery(def, synthDataset(12), Q({ kind: "mean", variable: "SAT", question: "Q4" }));
  assert.deepEqual(small.caveats, ["Base 12 is below 30: read with caution."]);
  const missing = answerDataQuery(def, ds, Q({ kind: "mean", variable: "NOPE", question: "Q9" }));
  assert.match(missing.text, /NOPE is not in this dataset/);
  const empty = answerDataQuery(def, ds, Q({ kind: "mean", variable: "SAT", question: "Q4", population: { ...female!, condition: { type: "rule", source: { kind: "question", ref: "q_gender" }, operator: "eq", value: 9 } } }));
  assert.match(empty.text, /^No respondents among Q1 \(GENDER\) = “Female” — nothing to read\.$/);
});
