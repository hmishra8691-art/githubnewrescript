import test from "node:test";
import assert from "node:assert/strict";
import { def as base, spec } from "./analyses/fixture.js";
import { variableMetadata } from "./dataset.js";
import { planItemViews, type SavedAnalysisRow, type SavedChartRow } from "./planWorkspace.js";
import { buildCatalogue, looksTechnical, namingContext, phraseFromQuestion, researchLabel, researchVariable, searchCatalogue } from "./catalogue.js";
import type { AnalysisDefinition } from "./types.js";

/*
 * THE ANALYSIS CATALOGUE (Architect Mode, AA1): research labels instead of question codes, the technical
 * identity kept beside them, and the Explorer's tree built from what the server already loads.
 */

function designed() {
  const def = structuredClone(base);
  def.questions.find((q) => q.id === "q_sat")!.text = "How satisfied are you with Brand Alpha overall?";
  def.questions.find((q) => q.id === "q_consider")!.text = "Which of the following brands would you consider buying?";
  def.research = {
    objective: "Understand what drives satisfaction with Brand Alpha",
    hypotheses: ["Region affects satisfaction", "Awareness of Alpha raises consideration"],
    hypothesisDetails: [], researchQuestions: [], assumptions: [], sources: [], analysis: [],
    kpis: [{ name: "Net Promoter Score", variable: "NPS", measure: "NPS" }],
    constructs: [
      { name: "Purchase Intent", role: "dependent", questionIds: ["q_consider"] },
      { name: "Brand Awareness", role: "independent", questionIds: ["q_brands"] },
      { name: "Service Quality", role: "independent", questionIds: ["q_items"] },
    ],
    analysisPlan: {
      crosstabs: [
        { id: "x1", rows: ["CONSIDER"], columns: ["AWARE"], priority: 1, hypotheses: ["H2"], reason: "consideration among the aware and the unaware" },
        { id: "x2", rows: ["SAT"], columns: ["GONE_VAR"], priority: 3, hypotheses: [] },
      ],
      tests: [{ id: "t1", method: "anova", outcome: "SAT", variables: [], groupBy: "REGION", priority: 1, hypotheses: ["H1"] }],
      derived: [], segments: [],
    },
  } as never;
  return def;
}

test("a variable is named by its KPI, then its construct, then the question's text as a phrase — the code kept beside it", () => {
  const def = designed();
  const ctx = namingContext(def, variableMetadata(def));
  assert.equal(researchVariable("NPS", ctx).researchLabel, "Net Promoter Score");
  assert.equal(researchVariable("CONSIDER", ctx).researchLabel, "Purchase Intent");
  assert.equal(researchVariable("CONSIDER", ctx).code, "Q7");
  const sat = researchVariable("SAT", ctx);
  assert.equal(sat.researchLabel, "Satisfaction with Brand Alpha overall");
  assert.equal(sat.code, "Q4");
  assert.equal(sat.label, "How satisfied are you with Brand Alpha overall?", "the dictionary label is kept as it was");
  /* a battery item under a construct: construct — item */
  const item = researchVariable("ITEMS_a", ctx);
  assert.equal(item.researchLabel, "Service Quality — Quality");
  assert.equal(researchVariable("REGION", ctx).researchLabel, "Region");
  assert.equal(researchVariable("NOT_A_VAR", ctx).researchLabel, "NOT_A_VAR");
});

test("question text becomes the thing it measures", () => {
  assert.equal(phraseFromQuestion("How likely are you to buy Brand A in the next month?"), "Likelihood to buy Brand A in the next month");
  assert.equal(phraseFromQuestion("Q18 — How important is price when you choose?"), "Importance of price when you choose");
  assert.equal(phraseFromQuestion("<p>Which of the following do you own?</p>"), "Do you own");
  assert.equal(phraseFromQuestion("To what extent do you agree that the staff were helpful?"), "Agreement: the staff were helpful");
  assert.ok(phraseFromQuestion("a".repeat(100)).length <= 65);
});

test("an analysis is labelled in research terms: 'Purchase Intent by Brand Awareness', never 'Q7 × Q6'", () => {
  const def = designed();
  const ctx = namingContext(def, variableMetadata(def));
  const xt: AnalysisDefinition = { name: "Q7 × Q6", kind: "crosstab", dataset: spec, variables: ["CONSIDER", "AWARE"], rows: ["CONSIDER"], columns: ["AWARE"] };
  assert.equal(researchLabel(xt, ctx).label, "Purchase Intent by Brand Awareness");
  const t: AnalysisDefinition = { name: "t1", kind: "test", dataset: spec, variables: ["SAT", "REGION"], options: { test: "anova_one_way" } };
  assert.equal(researchLabel(t, ctx).label, "Satisfaction with Brand Alpha overall by Region");
  const reg: AnalysisDefinition = { name: "reg", kind: "regression", dataset: spec, variables: ["NPS", "SAT", "AGE"] };
  assert.equal(researchLabel(reg, ctx).label, "Drivers of Net Promoter Score");
  const corr: AnalysisDefinition = { name: "corr", kind: "correlation", dataset: spec, variables: ["NPS", "AGE"] };
  assert.equal(researchLabel(corr, ctx).label, "Net Promoter Score and Age");
  /* a name a person wrote is kept for the other kinds */
  const desc: AnalysisDefinition = { name: "Who answered", kind: "descriptive", dataset: spec, variables: ["GENDER", "AGE"] };
  assert.equal(researchLabel(desc, ctx).label, "Who answered");
  const desc2: AnalysisDefinition = { name: "Q1, Q2", kind: "descriptive", dataset: spec, variables: ["GENDER", "AGE"] };
  assert.equal(researchLabel(desc2, ctx).label, "Gender and Age");
  assert.ok(looksTechnical("Q18 × Q14")); assert.ok(looksTechnical("crosstab Q3 by Q7")); assert.ok(!looksTechnical("Satisfaction by region"));
});

test("the catalogue: every category, with saved analyses, planned-but-unsaved items, charts, hypotheses, outputs and themes", () => {
  const def = designed();
  const dictionary = variableMetadata(def);
  const saved: SavedAnalysisRow[] = [
    { id: "a1", name: "Q7 × Q6", kind: "crosstab", version: 1, updated_at: "2026-11-06T00:00:00Z", definition: { name: "Q7 × Q6", kind: "crosstab", dataset: spec, variables: ["CONSIDER", "AWARE"], rows: ["CONSIDER"], columns: ["AWARE"], options: { planned: "x1" } } },
    { id: "a2", name: "Drivers", kind: "regression", version: 1, definition: { name: "Drivers", kind: "regression", dataset: spec, variables: ["NPS", "SAT", "AGE"] } },
    { id: "a3", name: "corr", kind: "correlation", version: 1, definition: { name: "corr", kind: "correlation", dataset: spec, variables: ["NPS", "AGE"] } },
  ];
  const charts: SavedChartRow[] = [{ id: "c1", analysis_id: "a1", name: "Q7 × Q6", spec: { type: "bar_stacked_100", options: {} } }];
  const planItems = planItemViews(def, spec, { dictionary, analyses: saved, charts });
  const c = buildCatalogue({
    def, dictionary, analyses: saved, charts, planItems,
    hypotheses: [
      { label: "H1", text: "Region affects satisfaction", status: "testable", items: ["t1"], verdict: null },
      { label: "H2", text: "Awareness of Alpha raises consideration", status: "testable", items: ["x1"], verdict: { label: "H2", text: "", verdict: "supported", reason: "Consideration is higher among the aware.", findings: [], analyses: 1 } },
    ],
    findings: [{ id: "f1", kind: "difference", strength: "moderate", significant: true, headline: "x", evidence: { test: "chi" } as never, variables: ["CONSIDER", "AWARE"], hypotheses: ["H2"], analysis: { name: "Q7 × Q6", kind: "crosstab", hash: "h", id: "a1", planned: "x1" } }],
    outputs: [
      { id: "r1", kind: "report", name: "Wave 1 report", definition: { title: "Wave 1", mode: "live", blocks: [{ id: "b1", type: "cover", title: "Wave 1" }, { id: "plan:x1", type: "chart", analysisId: "a1", chart: { type: "bar_vertical", options: {} } }] } },
      { id: "d1", kind: "dashboard", name: "Stakeholder view", published_version: 2, definition: { title: "Stakeholders", widgets: [{ id: "w1", type: "kpi", analysisId: "a2", x: 0, y: 0, w: 4, h: 2 }] } },
    ],
    qualThemes: [{ id: "th1", name: "Price anxiety", status: "reviewed" as never }, { id: "th2", name: "sub", parentId: "th1", status: "reviewed" as never }, { id: "th3", name: "Rejected", status: "rejected" }],
    discoveries: [{ kind: "segment", headline: "The South is less satisfied" }],
  });

  assert.deepEqual(c.sections.map((s) => s.category), ["hypotheses", "crosstabs", "tests", "models", "correlations", "charts", "themes", "reports", "dashboards"]);
  assert.deepEqual(c.counts, { hypotheses: 2, crosstabs: 2, tests: 1, models: 1, correlations: 1, charts: 1, themes: 2, reports: 1, dashboards: 1 });
  assert.equal(c.all.length, 12);
  assert.equal(c.objective, "Understand what drives satisfaction with Brand Alpha");

  const x1 = c.all.find((e) => e.key === "crosstabs:a1")!;
  assert.equal(x1.label, "Purchase Intent by Brand Awareness");
  assert.equal(x1.technical.name, "Q7 × Q6", "the technical name is kept");
  assert.deepEqual(x1.technical.variables.map((v) => v.code), ["Q7", "Q6"]);
  assert.match(x1.description, /breaks down by Brand Awareness/);
  assert.match(x1.description, /consideration among the aware and the unaware/, "the plan's reason is the why");
  assert.match(x1.description, /Serves H2/);
  assert.equal(x1.status, "ready"); assert.equal(x1.findings, 1); assert.equal(x1.planned, "x1");

  const x2 = c.all.find((e) => e.key === "crosstabs:plan:x2")!;
  assert.equal(x2.status, "blocked"); assert.deepEqual(x2.technical.missing, ["GONE_VAR"]); assert.equal(x2.analysisId, null);
  const t1 = c.all.find((e) => e.key === "tests:plan:t1")!;
  assert.equal(t1.status, "planned"); assert.equal(t1.label, "Satisfaction with Brand Alpha overall by Region"); assert.match(t1.description, /one-way ANOVA|test that fits/);
  assert.match(t1.description, /Serves H1/);

  const reg = c.all.find((e) => e.key === "models:a2")!;
  assert.equal(reg.label, "Drivers of Net Promoter Score");
  assert.match(reg.description, /Which of .* predict Net Promoter Score/);
  assert.match(reg.description, /Part of: Understand what drives/, "with no plan reason, the objective is the why");

  const h2 = c.all.find((e) => e.key === "hypotheses:H2")!;
  assert.equal(h2.verdict, "supported"); assert.equal(h2.status, "ready"); assert.equal(h2.description, "Consideration is higher among the aware.");
  const h1 = c.all.find((e) => e.key === "hypotheses:H1")!;
  assert.equal(h1.verdict, "untested"); assert.equal(h1.status, "planned"); assert.match(h1.description, /not run yet/);

  const ch = c.all.find((e) => e.key === "charts:c1")!;
  assert.equal(ch.label, "Purchase Intent by Brand Awareness"); assert.equal(ch.description, "Bar chart of Purchase Intent by Brand Awareness."); assert.equal(ch.analysisId, "a1");

  const themes = c.sections.find((s) => s.category === "themes")!.entries;
  assert.deepEqual(themes.map((e) => e.label), ["Price anxiety", "The South is less satisfied"], "subthemes and rejected themes are not listed");

  const rep = c.all.find((e) => e.key === "reports:r1")!;
  assert.match(rep.description, /2 blocks, 1 on analyses, 1 from the plan · not published/);
  const dash = c.all.find((e) => e.key === "dashboards:d1")!;
  assert.match(dash.description, /1 widget, 1 on analyses · published v2/);

  /* search reads labels, codes and variable names */
  assert.deepEqual(searchCatalogue(c, "Q7").map((e) => e.key).sort(), ["charts:c1", "crosstabs:a1"]);
  assert.ok(searchCatalogue(c, "purchase intent").length >= 2);
  assert.equal(searchCatalogue(c, "").length, 12);
});
