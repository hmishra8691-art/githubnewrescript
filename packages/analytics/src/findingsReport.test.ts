import test from "node:test";
import assert from "node:assert/strict";
import { def as base, synthDataset } from "./analyses/fixture.js";
import { runPlan } from "./findings.js";
import { reportFromRun, reportNarrative, reportAnalysisIds } from "./findingsReport.js";
import { reportPages } from "./reportPages.js";
import { buildPptx } from "./export/pptx.js";
import type { AnalysisResult, ReportBlock } from "./types.js";

/*
 * THE FINDINGS REPORT: the run written up as a report the workspace already
 * shows, publishes and exports — every sentence from the run, every chart a
 * saved analysis.
 */

function planned() {
  const def = structuredClone(base);
  def.research = {
    objective: "What drives satisfaction and recommendation", population: "adults",
    hypotheses: ["Women are more satisfied than men", "Region affects satisfaction", "Satisfaction drives recommendation", "Awareness of Gamma raises consideration of Gamma"],
    constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }, { name: "Recommendation", role: "dependent", questionIds: ["q_nps"] }],
    analysis: [], assumptions: [], sources: [],
    analysisPlan: {
      crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"], reason: "satisfaction by gender" }],
      tests: [
        { id: "t1", method: "t_test", outcome: "SAT", variables: [], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] },
        { id: "t2", method: "anova", outcome: "SAT", variables: [], groupBy: "REGION", priority: 1, hypotheses: ["H2"] },
        { id: "t3", method: "regression", outcome: "NPS", variables: ["SAT", "AGE"], priority: 1, hypotheses: ["H3"] },
        { id: "t4", method: "nps", variables: ["NPS"], priority: 2, hypotheses: [] },
        { id: "t5", method: "reliability", variables: ["ITEMS"], priority: 2, hypotheses: [] },
      ],
      derived: [], segments: [],
    },
  } as never;
  return def;
}
const by = (blocks: ReportBlock[], type: ReportBlock["type"]) => blocks.filter((b) => b.type === type);

test("the narrative is assembled from the run — the verdicts counted, the strongest findings in their own words, a small base said", () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { trigger: "target_reached", now: "2026-10-05T12:00:00Z" });
  const n = reportNarrative(def, run);
  assert.match(n.summary, /^This report reads the 6 planned analyses run on 400 live completes \(target reached, 2026-10-05\)\. Of the 4 hypotheses, 1 supported, 1 not supported, 1 mixed, 1 untested\. The strongest finding: /);
  assert.match(n.summary, /Also: .*; .*\.$/);
  assert.ok(!/conclusive yet/.test(n.summary));
  assert.match(n.hypotheses, /^\*\*H1\*\* Women are more satisfied than men — \*\*Supported\.\*\* All 2 planned tests are significant/m);
  assert.match(n.hypotheses, /\*\*H4\*\* Awareness of Gamma raises consideration of Gamma — \*\*Untested\.\*\* No analysis in the plan serves/);
  const small = reportNarrative(def, runPlan(def, synthDataset(20)));
  assert.match(small.summary, /With only 20 completes nothing here is conclusive yet\.$/);
  assert.match(small.summary, /inconclusive/);
  assert.match(small.summary, /The strongest finding: /, "a strong planted effect shows even at 20 — with the caution");
  const none = reportNarrative(def, runPlan(def, synthDataset(0)));
  assert.match(none.summary, /No planned test reached significance on this base\./, "nothing significant: no “strongest finding” is claimed");
  assert.ok(!/strongest finding/.test(none.summary));
});

test("the report: cover, executive summary over the significant analyses, the hypotheses, a section per hypothesis with its analyses drawn and captioned, other findings, methodology, caveats — and the pages it makes", () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { trigger: "field_end", now: "2026-10-05T12:00:00Z" });
  const ids: Record<string, string> = { x1: "A-x1", t1: "A-t1", t2: "A-t2", t3: "A-t3", t4: "A-t4" }; // t5 (reliability) has no saved analysis: a placeholder
  const report = reportFromRun(def, run, { analysisIdFor: (planned) => (planned ? ids[planned] : undefined), client: "Acme", fieldwork: { from: "2026-09-01", to: "2026-10-04" }, sampleFrame: "Online panel, adults 18+" });
  assert.equal(report.title, "What drives satisfaction and recommendation — findings");
  assert.equal(report.mode, "live");
  const types = report.blocks.map((b) => b.type);
  assert.deepEqual(types.slice(0, 4), ["cover", "executive_summary", "text", "page_break"]);
  const cover = report.blocks[0] as Extract<ReportBlock, { type: "cover" }>;
  assert.equal(cover.subtitle, "400 completes · end of fieldwork · 2026-10-05 · prepared for Acme");
  const exec = report.blocks[1] as Extract<ReportBlock, { type: "executive_summary" }>;
  assert.ok(exec.text!.startsWith("This report reads the 6 planned analyses"));
  assert.ok(exec.analysisIds.includes("A-t1") && exec.analysisIds.includes("A-t3") && !exec.analysisIds.includes("A-t2"), `the significant analyses: ${exec.analysisIds.join(", ")}`);
  /* a section per hypothesis that has analyses — H4 has none */
  const sections = by(report.blocks, "section") as Extract<ReportBlock, { type: "section" }>[];
  assert.deepEqual(sections.map((s) => [s.title, s.subtitle]), [["H1 — Women are more satisfied than men", "Supported"], ["H2 — Region affects satisfaction", "Not supported"], ["H3 — Satisfaction drives recommendation", "Mixed"], ["Other findings", "Planned analyses outside the hypotheses"]]);
  const charts = by(report.blocks, "chart") as Extract<ReportBlock, { type: "chart" }>[];
  assert.deepEqual(charts.map((c) => c.analysisId), ["A-x1", "A-t1", "A-t2", "A-t3", "A-t4", ""], "every planned analysis drawn once, in hypothesis order, the NPS and the unsaved reliability under other findings");
  assert.ok(charts.every((c) => c.chart.type && c.chart.options.title === c.title), "each chart carries a type and its title");
  const t3 = run.items.find((it) => it.definition.options?.planned === "t3")!;
  assert.equal(charts[3].chart.type, t3.chart, "the type the run chose for that result");
  assert.ok(new Set(charts.map((c) => c.chart.type)).size > 1, "different results, different charts");
  assert.match(charts[3].caption ?? "", /^Overall satisfaction raises Recommend\?/, "a mixed result is captioned with its significant finding first");
  assert.match(charts[1].caption ?? "", /Overall satisfaction across Gender: a (strong|moderate) difference/);
  assert.match(charts[2].caption ?? "", /no significant difference \(ANOVA/, "a null result is still captioned, with its own words");
  const insights = by(report.blocks, "insights") as Extract<ReportBlock, { type: "insights" }>[];
  assert.deepEqual(insights.map((i) => i.analysisIds), [["A-x1", "A-t1"], ["A-t2"], ["A-t3"]]);
  const meth = by(report.blocks, "methodology")[0] as Extract<ReportBlock, { type: "methodology" }>;
  assert.deepEqual(meth.fieldwork, { from: "2026-09-01", to: "2026-10-04" }); assert.equal(meth.sampleFrame, "Online panel, adults 18+");
  assert.ok(meth.items!.some((i) => i.label === "Completes analysed" && i.value === "400 (live)"));
  assert.ok(meth.items!.some((i) => i.label === "Analysis run" && /end of fieldwork, 2026-10-05 12:00 UTC/.test(i.value)));
  const caveats = by(report.blocks, "text").find((b) => (b as { title?: string }).title === "Caveats");
  assert.equal(!!caveats, run.warnings.length > 0);
  assert.deepEqual(reportAnalysisIds(report).sort(), ["A-t1", "A-t2", "A-t3", "A-t4", "A-x1"]);
  assert.deepEqual(reportAnalysisIds({ title: "t", mode: "live", blocks: [{ id: "e", type: "executive_summary", analysisIds: ["only-here"] }, { id: "i", type: "insights", analysisIds: ["and-here"] }] }).sort(), ["and-here", "only-here"], "ids that appear only in a summary or insights block count too");
  /* pages: the cover and summary, then one per hypothesis, the other findings, the back matter */
  const pages = reportPages(report.blocks);
  assert.ok(pages.length >= 5, `${pages.length} pages`);
  /* no hypotheses at all: no hypotheses text block, still a report */
  const bare = structuredClone(def); bare.research!.hypotheses = [];
  const r2 = reportFromRun(bare, runPlan(bare, synthDataset(60)), { analysisIdFor: () => undefined });
  assert.ok(!by(r2.blocks, "text").some((b) => (b as { title?: string }).title === "The hypotheses"));
  assert.ok(by(r2.blocks, "chart").every((c) => (c as { analysisId: string }).analysisId === ""), "nothing saved: every chart a placeholder to fill");
});

test("the report exports through the existing PowerPoint builder with the run's results", async () => {
  const def = planned();
  const run = runPlan(def, synthDataset(300), { trigger: "manual", now: "2026-10-05T12:00:00Z" });
  const ids = new Map(run.items.map((it, i) => [String(it.definition.options?.planned ?? it.definition.name), `A${i}`]));
  const report = reportFromRun(def, run, { analysisIdFor: (planned, name) => ids.get(planned ?? name) });
  const results: Record<string, AnalysisResult> = {};
  for (const it of run.items) results[ids.get(String(it.definition.options?.planned ?? it.definition.name))!] = it.result;
  const buf = await buildPptx({ report: { title: report.title, subtitle: report.subtitle, blocks: report.blocks }, results, meta: { survey: def.meta.title, responses: run.n } });
  assert.ok(buf.length > 20_000, `a real deck: ${buf.length} bytes`);
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK", "a zip (pptx)");
});
