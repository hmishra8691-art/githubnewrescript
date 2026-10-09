import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { SurveyDefinition } from "@rescript/schema";
import { def as base, synthDataset, synthRows, spec, D } from "./analyses/fixture.js";
import { buildDataset, type AnalyticsRow } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";
import { runPlan, type AnalysisRun } from "./findings.js";
import { chooseChart, purposeOf, describeChoice } from "./chartPurpose.js";
import { deckFromRun, describeDeck, type DeckSlide } from "./deck.js";
import { gateNarrative, runNumbers, sentenceProblem } from "./narrative.js";
import { buildDeckPptx } from "./export/deck.js";
import { buildProposalDocx, buildFindingsDocx } from "./export/docx.js";

/*
 * RESEARCH ENGINE PHASE 5 — automated reporting: the chart chosen for why
 * it is shown and to whom, the storytelling deck in its fixed order with
 * the engine's words, the narrative gate, the two Word documents, and the
 * PowerPoint design system. The synthetic data plants a gender effect on
 * satisfaction and no region effect.
 */

/** the text of a .docx — `word/document.xml` inflated from the zip, tags stripped */
function docxText(buf: Buffer): string {
  const name = Buffer.from("word/document.xml");
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(i + 26), extraLen = buf.readUInt16LE(i + 28);
    if (nameLen !== name.length || !buf.subarray(i + 30, i + 30 + nameLen).equals(name)) continue;
    return inflateRawSync(buf.subarray(i + 30 + nameLen + extraLen)).toString("utf8").replace(/<[^>]+>/g, " ").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  }
  return "";
}
/** how many slides a .pptx holds: its slide parts */
const slideCount = (buf: Buffer) => (buf.toString("latin1").match(/ppt\/slides\/slide\d+\.xml/g) ?? []).filter((v, i, a) => a.indexOf(v) === i).length;

function planned() {
  const def = structuredClone(base);
  def.research = {
    objective: "What drives satisfaction and recommendation", population: "Adults 18+ who bought in the last year", methodology: "Online panel, 10 minutes",
    hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region", "Awareness of Gamma raises consideration"], hypothesisDetails: [], researchQuestions: ["Which groups are most satisfied?"], kpis: [{ name: "NPS", variable: "NPS", measure: "promoters − detractors", target: "30", direction: "higher" }],
    constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }], analysis: [], assumptions: ["The panel is representative"], sources: ["Brief v2"],
    analysisPlan: {
      crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }],
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
const resultsOf = (run: AnalysisRun) => Object.fromEntries(run.items.map((it) => [it.definition.options?.planned ? String(it.definition.options.planned) : it.definition.name, it.result]));

test("the purpose is read from the analysis — comparison, significance, relationship, distribution, kpi, ranking, trend — and the chart chosen lifts the types that serve it; the audience lifts or lowers families, never past what the data can draw", () => {
  const ds = synthDataset(400);
  const xt = runAnalysis(D("crosstab", [], { rows: ["SAT"], columns: ["GENDER"] }), ds);
  assert.equal(purposeOf(D("crosstab", [], { rows: ["SAT"], columns: ["GENDER"] }), xt).purpose, "comparison");
  const t = runAnalysis(D("test", ["SAT", "GENDER"]), ds);
  assert.equal(purposeOf(D("test", ["SAT", "GENDER"]), t).purpose, "significance");
  assert.equal(purposeOf(D("correlation", ["SAT", "NPS"]), runAnalysis(D("correlation", ["SAT", "NPS"]), ds)).purpose, "relationship");
  const desc = runAnalysis(D("descriptive", ["SAT"]), ds);
  assert.equal(purposeOf(D("descriptive", ["SAT"]), desc).purpose, "distribution");
  assert.equal(purposeOf(D("nps", ["NPS"]), runAnalysis(D("nps", ["NPS"]), ds)).purpose, "kpi");
  assert.equal(purposeOf(D("ranking", ["RANK"]), runAnalysis(D("ranking", ["RANK"]), ds)).purpose, "ranking");
  assert.equal(purposeOf(D("descriptive", ["SAT"]), { ...desc, chart: { categories: ["2026-06", "2026-07", "2026-08"], series: [{ name: "x", values: [1, 2, 3] }] } }).purpose, "trend", "time-like categories are a trend whatever the kind");
  // the group comparison: a researcher gets the interval chart, an executive the bars; the reason says why
  const r = chooseChart(D("test", ["SAT", "GENDER"]), t, { audience: "researcher" });
  const e = chooseChart(D("test", ["SAT", "GENDER"]), t, { audience: "executive" });
  assert.equal(r[0].purpose, "significance");
  assert.ok(["mean_ci", "ci_plot", "diff_means"].includes(r[0].type), `researcher: ${r[0].type}`);
  assert.ok(["bar_grouped", "bar_vertical", "column_clustered"].includes(e[0].type), `executive: ${e[0].type}`);
  assert.match(r[0].reason, /show a difference with its uncertainty \(\+\d+\); researcher audience \(\+\d+\)/);
  assert.match(describeChoice(e[0]), /^(?:bar grouped|bar vertical|column clustered) — to show a difference with its uncertainty, for an executive audience$/);
  // a purpose asked for outright
  const comp = chooseChart(D("test", ["SAT", "GENDER"]), t, { purpose: "composition", audience: "client" });
  assert.equal(comp[0].purpose, "composition"); assert.equal(comp[0].purposeWhy, "as asked");
  // never a chart the data cannot draw: a descriptive with no points never gets a scatter, whatever the purpose
  const rel = chooseChart(D("descriptive", ["SAT"]), desc, { purpose: "relationship" });
  assert.ok(!rel.some((c) => c.type === "scatter" || c.type === "bubble"));
  assert.ok(rel.every((c) => c.score > 0));
});

test("the deck tells the story in its fixed order, every sentence from the run; groups highest first; nothing beyond the plan means no such section; a model narrative replaces the words, never the numbers", () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { trigger: "halfway", now: "2026-10-09T09:00:00Z" });
  const deck = deckFromRun(def, run, { audience: "client", client: "Acme", results: resultsOf(run) });
  const types = deck.slides.map((s) => s.type);
  assert.deepEqual(types.slice(0, 3), ["title", "summary", "section"]);
  assert.equal(types.indexOf("implications") > types.lastIndexOf("key_finding"), true, "implications after the findings");
  assert.equal(types.indexOf("recommendations"), types.indexOf("implications") + 1);
  assert.equal(types[types.length - 1], "method", "no caveats when the run has none");
  assert.ok(!types.includes("caveats"));
  const t0 = deck.slides[0] as Extract<DeckSlide, { type: "title" }>;
  assert.equal(t0.title, "What drives satisfaction and recommendation — findings");
  assert.equal(t0.subtitle, "400 live completes · 2026-10-09 · prepared for Acme");
  assert.equal(t0.audience, "client");
  const sum = deck.slides[1] as Extract<DeckSlide, { type: "summary" }>;
  assert.equal(sum.headline, "Overall satisfaction across Gender: a strong difference", "the headline is the strongest finding, without its test parenthesis");
  assert.deepEqual(sum.bullets.slice(0, 4), ["Objective: What drives satisfaction and recommendation", "H1 supported: Women are more satisfied than men", "H2 mixed: Satisfaction differs by region", "H3 untested: Awareness of Gamma raises consideration"]);
  const keys = deck.slides.filter((s): s is Extract<DeckSlide, { type: "key_finding" }> => s.type === "key_finding" && !s.beyond);
  assert.equal(keys.length, 4);
  assert.equal(keys[0].hypothesis, "H1"); assert.equal(keys[0].analysisId, "t1"); assert.equal(keys[0].significant, true);
  assert.match(keys[0].soWhat, /^This is the evidence for H1 \(“Women are more satisfied than men”\), which is supported overall; a strong effect, so it is a difference worth acting on\.$/);
  assert.match(keys[0].evidence, /^t welch, p < \.001, Cohen's d = -?1\.01, n = 400 · Holm-adjusted p < \.001$/);
  assert.ok(["bar_grouped", "bar_vertical", "column_clustered"].includes(keys[0].chart.type), keys[0].chart.type);
  const corr = keys.find((k) => k.analysisId === "t4")!;
  assert.equal(corr.chart.type, "scatter_trendline", "a relationship gets the scatter");
  assert.match(corr.soWhat, /^A strong effect on 400 respondents — the objective was: What drives satisfaction and recommendation\.$/);
  const weak = keys.find((k) => k.analysisId === "t3")!;
  assert.match(weak.soWhat, /a small effect — real, but modest in size\.$/);
  const segs = deck.slides.filter((s): s is Extract<DeckSlide, { type: "segment_comparison" }> => s.type === "segment_comparison");
  assert.ok(segs.length >= 3);
  assert.deepEqual(segs[0].groups.map((g) => g.label), ["Female", "Male"], "highest first");
  assert.equal(segs[0].differs, "Female (3.86) vs Male (3.07) — a strong effect");
  const country = segs.find((s) => s.analysisId === "t3")!;
  assert.match(country.differs, /— a small effect\. Pairwise \(Holm-adjusted, 28 pairs\): UK > France/);
  const stat = deck.slides.filter((s): s is Extract<DeckSlide, { type: "statistical_highlight" }> => s.type === "statistical_highlight");
  assert.equal(stat.length, 2);
  assert.equal(stat[0].stat, "Cohen's d = -1.01"); assert.equal(stat[0].label, "a strong effect"); assert.equal(stat[0].context, "H1 · Holm-adjusted p < .001 — holds");
  assert.ok(types.includes("section") && deck.slides.some((s) => s.type === "section" && s.title === "Who differs"));
  const imp = deck.slides.find((s): s is Extract<DeckSlide, { type: "implications" }> => s.type === "implications")!;
  assert.equal(imp.bullets.length, 3);
  assert.match(imp.bullets[0], /^H1 \(Women are more satisfied than men\) is supported: the design's expectation holds — Overall satisfaction across Gender: a strong difference\.$/);
  assert.match(imp.bullets[2], /^H3 \(Awareness of Gamma raises consideration\) is untested: no analysis in the plan serves it, so the data says nothing about it yet\.$/);
  const rec = deck.slides.find((s): s is Extract<DeckSlide, { type: "recommendations" }> => s.type === "recommendations")!;
  assert.match(rec.items[0], /^Lead the story with the strongest finding: Overall satisfaction across Gender: a strong difference\.$/);
  assert.ok(rec.items.some((r) => /^Plan a test for H3 \(“Awareness of Gamma raises consideration”\) before the next wave/.test(r)));
  assert.ok(rec.items.some((r) => /^Add \w+ by GENDER to the analysis plan — it was found outside it and holds after correction\.$/.test(r)));
  const method = deck.slides.find((s): s is Extract<DeckSlide, { type: "method" }> => s.type === "method")!;
  assert.deepEqual(method.items.slice(0, 4).map((i) => i.value), ["400 (live)", "halfway, 2026-10-09", "5", "α = 0.05, Holm correction by hypothesis family"]);
  assert.equal(method.items.find((i) => i.label === "Population")?.value, "Adults 18+ who bought in the last year");
  assert.match(describeDeck(deck), /^\d+ slides: title, summary, 3 sections, 5 key findings, 4 segment comparisons, 2 statistical highlights, implications, recommendations, method$/, "four planned key findings and one beyond the plan");
  assert.deepEqual(deck.analysisIds.sort(), ["t1", "t3", "t4", "x1"]);
  // the executive deck chooses differently and fewer
  const exec = deckFromRun(def, run, { audience: "executive", maxFindings: 2, results: resultsOf(run) });
  assert.equal(exec.slides.filter((s) => s.type === "key_finding" && !(s as { beyond?: boolean }).beyond).length, 2);
  assert.equal((exec.slides[0] as Extract<DeckSlide, { type: "title" }>).audience, "executive");
  // a model narrative replaces the words
  const told = deckFromRun(def, run, { narrative: { headline: "Women are the more satisfied customers.", summary: ["We set out to learn what drives satisfaction.", "Women score 3.86 against 3.07 for men."], implications: ["Gender is the lever."], recommendations: ["Segment the communication by gender."] } });
  assert.equal((told.slides[1] as Extract<DeckSlide, { type: "summary" }>).headline, "Women are the more satisfied customers.");
  assert.deepEqual((told.slides[1] as Extract<DeckSlide, { type: "summary" }>).bullets, ["We set out to learn what drives satisfaction.", "Women score 3.86 against 3.07 for men."]);
  assert.deepEqual((told.slides.find((s) => s.type === "implications") as Extract<DeckSlide, { type: "implications" }>).bullets, ["Gender is the lever."]);
  assert.deepEqual((told.slides.find((s) => s.type === "recommendations") as Extract<DeckSlide, { type: "recommendations" }>).items, ["Segment the communication by gender."]);
  assert.equal((told.slides.find((s) => s.type === "key_finding") as Extract<DeckSlide, { type: "key_finding" }>).evidence, keys[0].evidence, "the numbers are untouched");
  // discoveries all shown already as segment comparisons, nothing else beyond the plan: no "Beyond the plan" section
  const shown = deckFromRun(def, { ...run, discoveries: { ...run.discoveries!, segments: [], trends: [], anomalies: [] } });
  assert.ok(!shown.slides.some((s) => s.type === "section" && s.title === "Beyond the plan"), "no section with nothing after it");
  assert.ok(deck.slides.some((s) => s.type === "section" && s.title === "Beyond the plan"), "the full run has one, with a discovery after it");
  // a single not-significant test behind a hypothesis: the verdict says so in words
  const one = structuredClone(def);
  one.research!.analysisPlan!.tests = [{ id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 1, hypotheses: ["H2"] }];
  const r1 = runPlan(one, synthDataset(400), { discover: false });
  assert.match(r1.verdicts[1].reason, /^The planned test is not significant: Overall satisfaction across Region: no significant difference/);
  // a small base: the caveat slide
  const small = deckFromRun(def, runPlan(def, synthDataset(20), { now: "2026-10-09T09:00:00Z" }));
  assert.equal(small.slides[small.slides.length - 1].type, "caveats");
  assert.ok((small.slides[small.slides.length - 1] as Extract<DeckSlide, { type: "caveats" }>).bullets.some((b) => /^Only 20 completes — nothing here is conclusive yet\.$/.test(b)));
});

test("the narrative gate: every number must be the run's, hypotheses must exist and keep their verdict, counting words and years pass; a section left empty falls back", () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { now: "2026-10-09T09:00:00Z" });
  const nums = runNumbers(run);
  for (const n of ["400", "3.86", "3.07", "3.9", "1.01", "0.86", "26.6", "0.021", "28"]) assert.ok(nums.has(n), n);
  assert.equal(sentenceProblem("Women score 3.86 against 3.07 for men.", nums, run.verdicts), null);
  assert.equal(sentenceProblem("Women score 3.9 against 3.1 for men.", nums, run.verdicts), null, "one decimal less of a printed mean");
  assert.equal(sentenceProblem("Satisfaction is 4.2 among women.", nums, run.verdicts), "the number 4.2 is not in the run");
  assert.equal(sentenceProblem("Two of the three hypotheses held, 2 of 3.", nums, run.verdicts), null, "counting words pass");
  assert.equal(sentenceProblem("Fieldwork ran in 2026.", nums, run.verdicts), null, "a year passes");
  assert.equal(sentenceProblem("A 77.7% lift.", nums, run.verdicts), "the number 77.7% is not in the run", "a percentage must be printed");
  assert.equal(sentenceProblem("H1 is supported: women are more satisfied.", nums, run.verdicts), null);
  assert.equal(sentenceProblem("H2 is supported.", nums, run.verdicts), null, "mixed may be called supported in part — only the clear contradictions are refused");
  assert.equal(sentenceProblem("H3 is confirmed by the data.", nums, run.verdicts), "H3 is untested, not supported");
  assert.equal(sentenceProblem("H1 was rejected.", nums, run.verdicts), "H1 is supported, not rejected");
  assert.equal(sentenceProblem("H9 says otherwise.", nums, run.verdicts), "H9 is not a hypothesis of this run");
  const g = gateNarrative(run, { headline: "Women are the more satisfied customers (3.86 vs 3.07).", summary: ["Of the 3 hypotheses, H1 is supported.", "Satisfaction reaches 4.5 among women in the north.", 42], implications: ["H1 holds, with a strong effect (d = 1.01)."], recommendations: ["Raise satisfaction among men by 77.7% next year.", "Plan a test for H3."] });
  assert.equal(g.offered, 6); assert.equal(g.kept, 4);
  assert.deepEqual(g.rejected.map((r) => [r.section, r.reason]), [["summary", "the number 4.5 is not in the run"], ["recommendations", "the number 77.7% is not in the run"]]);
  assert.deepEqual(g.accepted, { headline: "Women are the more satisfied customers (3.86 vs 3.07).", summary: ["Of the 3 hypotheses, H1 is supported."], implications: ["H1 holds, with a strong effect (d = 1.01)."], recommendations: ["Plan a test for H3."] });
  const empty = gateNarrative(run, { summary: ["A 77.7% lift."], headline: "" });
  assert.deepEqual(empty.accepted, {});
  assert.equal(empty.kept, 0);
  assert.deepEqual(gateNarrative(run, {}), { accepted: {}, rejected: [], offered: 0, kept: 0 });
});

test("the deck as PowerPoint: one slide per story slide, the design system's words on them, the significance badge, the statistic callout, the native charts", async () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { trigger: "halfway", now: "2026-10-09T09:00:00Z" });
  const results = resultsOf(run);
  const deck = deckFromRun(def, run, { audience: "client", client: "Acme", results });
  const buf = await buildDeckPptx({ deck, results, footer: "Prepared for Acme" });
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  assert.ok(buf.length > 40_000, `${buf.length} bytes`);
  assert.equal(slideCount(buf), deck.slides.length, "one slide per story slide");
  const raw = buf.toString("latin1");
  for (const w of ["SIGNIFICANT", "So what", "Who differs", "STATISTICAL HIGHLIGHT", "Cohen", "What it means", "What to do next", "How this was done", "Prepared for Acme", "client edition"]) assert.ok(raw.includes(w), w);
  assert.ok(/<c:barChart>|<c:scatterChart>/.test(raw), "native charts");
  // the executive deck is shorter
  const exec = await buildDeckPptx({ deck: deckFromRun(def, run, { audience: "executive", maxFindings: 1, results }), results });
  assert.ok(slideCount(exec) < slideCount(buf));
  // a slide whose analysis is not in the results says so instead of drawing nothing
  const noRes = await buildDeckPptx({ deck, results: {} });
  assert.ok(noRes.toString("latin1").includes("Chart data not available in this export"));
  // a hand-built deck: the badge says NOT SIGNIFICANT when the finding is not, the statistic callout carries the statistic
  const hand = await buildDeckPptx({ deck: { title: "T", subtitle: "S", audience: "client", analysisIds: [], slides: [
    { type: "key_finding", title: "No difference by region", chart: { type: "bar_vertical", options: {} }, evidence: "ANOVA, p = .171", soWhat: "Nothing to act on.", significant: false },
    { type: "statistical_highlight", title: "Big", stat: "η² = 0.42", label: "a strong effect", test: "ANOVA", p: "p < .001", n: 400, context: "H1" },
  ] }, results: {} });
  const hr = hand.toString("latin1");
  assert.ok(hr.includes("NOT SIGNIFICANT"), "the badge says not significant");
  assert.ok(hr.includes("η² = 0.42") || hr.includes("&#951;") || /0\.42/.test(hr), "the statistic is on the callout");
});

test("the research proposal (Word): cover, objective, research questions and KPIs, hypotheses with their readings and the questions that measure them, the questionnaire by section, sample and the plan's base, the analysis plan with its reasons, deliverables, assumptions and sources", async () => {
  const def = planned();
  const buf = await buildProposalDocx(def, { client: "Acme", author: "R. Smith", date: "2026-10-09", fieldwork: { from: "2026-11-01", to: "2026-11-21" } });
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  const t = docxText(buf);
  assert.match(t, /RESEARCH PROPOSAL What drives satisfaction and recommendation Prepared for Acme 2026-10-09 · R\. Smith Survey: Synthetic v1\.0/);
  assert.match(t, /1\. Background and objective What drives satisfaction and recommendation POPULATION Adults 18\+ who bought in the last year METHODOLOGY Online panel, 10 minutes/);
  assert.match(t, /2\. Research questions and KPIs Which groups are most satisfied\? KPIS KPI Variable Measure Target NPS NPS promoters − detractors 30 \(higher is better\)/);
  assert.match(t, /3\. Hypotheses Hypothesis Reading Measured by Effect H1 Women are more satisfied than men difference · women > men on satisfied Q4 — H2 Satisfaction differs by region difference · region ↔ Satisfaction Q4 — H3/);
  assert.match(t, /Constructs Construct Role Definition Questions Satisfaction dependent Q4/);
  assert.match(t, /4\. Questionnaire 18 questions in 1 sections — about 5 minutes at four questions a minute\. SECTION · 18 QUESTIONS Code Question Type Role Q1 Gender single select \(nominal\) segmentation/);
  assert.match(t, /5\. Sample and fieldwork Population: Adults 18\+ who bought in the last year\. The analysis plan needs at least \d+ completes/);
  assert.match(t, /Fieldwork: 2026-11-01 to 2026-11-21\./);
  assert.match(t, /6\. Analysis plan Analysis Serves Why this method Output Base/);
  assert.match(t, /t-test[^]*H1[^]*/);
  assert.match(t, /7\. Deliverables Topline findings at the first readable base/);
  assert.match(t, /8\. Assumptions and sources The panel is representative SOURCES Brief v2/);
  // a bare survey: the proposal still builds, and says what is missing
  const bare = SurveyDefinition.parse({ meta: { id: "b", code: "B", title: "Bare" }, questions: [{ id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "A?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] }], flow: [{ type: "page", id: "p1", questionIds: ["q1"] }] });
  const bt = docxText(await buildProposalDocx(bare));
  assert.match(bt, /RESEARCH PROPOSAL Bare/);
  assert.match(bt, /No research objective is recorded yet/);
  assert.match(bt, /2\. Hypotheses No hypotheses are recorded\./);
  assert.match(bt, /No sample size is recorded\.|The analysis plan needs/);
});

test("the findings report (Word): the executive summary, the verdicts, each key finding with its so-what, evidence and groups, who differs, beyond the plan, what it means, what to do next, the method, every finding, the caveats; a narrative replaces the summary", async () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { trigger: "halfway", now: "2026-10-09T09:00:00Z" });
  const buf = await buildFindingsDocx(def, run, { client: "Acme", results: resultsOf(run) });
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  const t = docxText(buf);
  assert.match(t, /FINDINGS REPORT What drives satisfaction and recommendation — findings Prepared for Acme 400 live completes · halfway · 2026-10-09/);
  assert.match(t, /Executive summary Overall satisfaction across Gender: a strong difference This report reads the 5 planned analyses run on 400 live completes/);
  assert.match(t, /The hypotheses Hypothesis Verdict Why H1 Women are more satisfied than men supported All 2 planned tests are significant/);
  assert.match(t, /H3 Awareness of Gamma raises consideration untested No analysis in the plan serves this hypothesis\./);
  assert.match(t, /Key findings Overall satisfaction across Gender: a strong difference This is the evidence for H1 .* t welch, p < \.001, Cohen's d = -?1\.01, n = 400 · Holm-adjusted p < \.001 Gender n Mean SD Median 95% CI low 95% CI high (?:Male|Female) \d+ 3\.\d\d/);
  assert.match(t, /Who differs Overall satisfaction across Gender: a strong difference Female \(3\.86\) vs Male \(3\.07\) — a strong effect Group SAT n Female 3\.86 208 Male 3\.07 192/);
  assert.match(t, /Beyond the plan: \d segment differences the plan did not test/);
  assert.match(t, /What it means H1 \(Women are more satisfied than men\) is supported/);
  assert.match(t, /What to do next Lead the story with the strongest finding/);
  assert.match(t, /Method Completes analysed 400 \(live\) Run halfway, 2026-10-09 Planned analyses 5 Significance α = 0\.05, Holm correction by hypothesis family Population Adults 18\+/);
  assert.match(t, /Every finding Finding Test p Adjusted Effect n/);
  assert.match(t, /Generated by Rescript from the analysis run of 2026-10-09\. Every number in this document is from that run\./);
  const told = docxText(await buildFindingsDocx(def, run, { narrative: { headline: "Women are the more satisfied customers.", summary: ["We set out to learn what drives satisfaction.", "Women score 3.86 against 3.07 for men."] } }));
  assert.match(told, /Executive summary Women are the more satisfied customers\. We set out to learn what drives satisfaction\. Women score 3\.86 against 3\.07 for men\. The hypotheses/);
  // a run with data advice carries the method table
  const rows: AnalyticsRow[] = synthRows(44).map((r, i) => ({ ...r, answers: { ...r.answers, q_gender: i < 12 ? 1 : 2, q_sat: i < 12 ? (i === 0 ? 5 : 1) : 3 + (i % 3) } }));
  const adv = docxText(await buildFindingsDocx(def, runPlan(def, buildDataset(def, rows, { spec }), { discover: false })));
  assert.match(adv, /What the data says about the methods Analysis Checks Recommended .*Mann–Whitney/);
});
