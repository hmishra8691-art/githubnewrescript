import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, variableMetadata } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";
import { draftReport, reportBriefFromText, resultNumbers, evidenceKind, type BuilderItem, type ReportBrief } from "./reportBuilder.js";
import { proposeFromText } from "./analyticsIntent.js";
import type { AnalysisDefinition, ReportBlock } from "./types.js";
import { def, synthRows } from "./analyses/fixture.js";

/*
 * REPORTING FROM INSTRUCTIONS (2026-10-17): a sentence becomes the builder's own brief; each section is built
 * only from executed analyses; an untested hypothesis is labelled untested; a chart that cannot be made says
 * what is missing; no number appears that the results do not contain.
 */
const PREMIUM = "Create a premium executive report with executive summary, hypothesis-wise findings, brand comparison charts, demographic segments, consistent theme, actionable recommendations";
const spec = { environment: "LIVE" as const, dataset: "all" as const };
const ds = buildDataset(def, synthRows(), { spec });
const vars = variableMetadata(def);
let n = 0;
const item = (name: string, kind: AnalysisDefinition["kind"], variables: string[], extra: Partial<AnalysisDefinition> = {}): BuilderItem => {
  const definition = { name, kind, dataset: spec, variables, ...extra } as AnalysisDefinition;
  return { id: `r${++n}`, name, definition, result: runAnalysis(definition, ds) };
};
const satByGender = item("Satisfaction by gender", "crosstab", [], { rows: ["SAT"], columns: ["GENDER"], measure: "pct_col", options: { hypotheses: ["H1"] } });
const satByRegion = item("Satisfaction across regions", "test", ["SAT", "REGION"], { options: { test: "anova_one_way", hypotheses: ["H1"] } });
const brands = item("Brands aware of", "descriptive", ["AWARE"]);
const items = [satByGender, satByRegion, brands];
const hypotheses = [{ label: "H1", text: "Satisfaction differs by region" }, { label: "H2", text: "Awareness of Alpha raises consideration" }];

test("the premium executive sentence becomes a brief: executive, formal, the five sections, a premium theme", () => {
  const r = reportBriefFromText(PREMIUM);
  assert.equal(r.brief.audience, "executive");
  assert.equal(r.brief.tone, "formal");
  assert.deepEqual(r.sections, ["executive_summary", "hypotheses", "brand_comparison", "segments", "recommendations"]);
  assert.equal(r.brief.theme, "Midnight");
  assert.ok(r.understood.includes("one theme across every block"));
  assert.deepEqual(r.unsupported, []);
  assert.match(reportBriefFromText("make a video report that proves the causal impact of ads").unsupported.join(" "), /video file cannot be produced.*Causal claims are not made/);
});

test("the Ask panel reads it into a build_report with those sections (and a plain sentence keeps its old brief)", () => {
  const p = proposeFromText(PREMIUM, { variables: vars, known: [], analyses: [], reports: [], dataset: spec });
  const op = p.items.find((i) => i.op.op === "build_report")?.op as Extract<typeof p.items[number]["op"], { op: "build_report" }> | undefined;
  assert.ok(op, JSON.stringify(p).slice(0, 300));
  assert.deepEqual(op.brief.sections, ["executive_summary", "hypotheses", "brand_comparison", "segments", "recommendations"]);
  assert.equal(op.brief.theme, "Midnight");
  const plain = proposeFromText("Prepare a management summary", { variables: vars, known: [], analyses: [], reports: [], dataset: spec }).items.find((i) => i.op.op === "build_report")?.op as { brief: ReportBrief } | undefined;
  assert.equal(plain?.brief.sections, undefined);
  assert.equal(plain?.brief.audience, "executive");
});

const brief = (b: Partial<ReportBrief> = {}): ReportBrief => ({ objective: "What drives satisfaction", keyQuestions: [], hypotheses, ...reportBriefFromText(PREMIUM).brief, ...b });
const titled = (bs: ReportBlock[]) => bs.map((b) => ("title" in b && b.title) || b.type);

test("hypothesis-wise findings come only from executed analyses; the untested hypothesis is labelled untested; evidence is labelled, never causal", () => {
  const d = draftReport(brief(), items, vars);
  const titles = titled(d.report.blocks);
  const at = titles.indexOf("Findings by hypothesis");
  assert.ok(at >= 0, titles.join(" | "));
  const h1 = d.report.blocks.find((b) => b.type === "text" && "title" in b && /^H1:/.test(b.title ?? "")) as Extract<ReportBlock, { type: "text" }>;
  assert.match(h1.markdown, /Satisfaction across regions: Statistical evidence — .*base n = \d+\. Not a causal claim\./);
  assert.match(h1.markdown, /Satisfaction by gender: (Statistical|Descriptive) evidence/);
  const h2 = d.report.blocks.find((b) => b.type === "text" && "title" in b && /^H2:/.test(b.title ?? "")) as Extract<ReportBlock, { type: "text" }>;
  assert.match(h2.markdown, /\*\*Untested\*\* — no executed analysis serves this hypothesis/);
  assert.equal(evidenceKind(brands.result), "descriptive");
});

test("brand comparison and demographic segments are drawn from the analyses that read them, each chart from the result's structure", () => {
  const d = draftReport(brief(), items, vars);
  const titles = titled(d.report.blocks);
  const b = titles.indexOf("Brand comparison"), s = titles.indexOf("Demographic segments");
  assert.ok(b >= 0 && s >= 0, titles.join(" | "));
  assert.equal(d.report.blocks[b + 1].type, "chart");
  assert.equal((d.report.blocks[b + 1] as Extract<ReportBlock, { type: "chart" }>).analysisId, brands.id);
  assert.ok(d.report.blocks.slice(s + 1).some((x) => x.type === "chart" && x.analysisId === satByGender.id));
});

test("a section the analyses cannot fill is not drawn — a note says what to add; recommendations are never invented", () => {
  const d = draftReport(brief(), [satByRegion], vars);
  const titles = titled(d.report.blocks);
  assert.ok(!titles.includes("Brand comparison"));
  assert.match(d.notes.join(" "), /Brand comparison charts: no saved analysis reads a brand question.*Add a crosstab of the brand question/);
  assert.match(d.notes.join(" "), /Recommendations: none are written.*does not invent them/);
  assert.match(d.notes.join(" "), /Theme: the Midnight preset/);
});

test("no fabricated numbers: every number in the hypothesis and section text is one the results contain", () => {
  const d = draftReport(brief(), items, vars);
  const known = resultNumbers(items);
  const texts = d.report.blocks.filter((b): b is Extract<ReportBlock, { type: "text" }> => b.type === "text" && /^H\d:/.test(("title" in b && b.title) || "")).map((b) => b.markdown);
  texts.push(...d.report.blocks.filter((b): b is Extract<ReportBlock, { type: "chart" }> => b.type === "chart").map((b) => b.caption ?? ""));
  for (const t of texts) for (const m of t.replace(/\bH\d+\b/g, "").replace(/α = 0\.05/g, "").match(/-?\d+(?:\.\d+)?/g) ?? []) {
    const norm = m.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "").replace(/^\./, "0.");
    assert.ok(known.has(norm) || known.has(norm.replace(/^0\./, ".")), `“${m}” in “${t.slice(0, 120)}” is not a number the results contain`);
  }
});
