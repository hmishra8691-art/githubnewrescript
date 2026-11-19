import { test } from "node:test";
import assert from "node:assert/strict";
import { def as base, synthDataset } from "./analyses/fixture.js";
import { runPlan, type AnalysisRun } from "./findings.js";
import { deckFromRun } from "./deck.js";
import { buildLineage, explainClaim, lineageCoverage } from "./lineage.js";

/* P3-02 gate: "any claim opens its table and data" — and, for an imported survey, the questionnaire line it came from */

function planned() {
  const def = structuredClone(base);
  def.research = {
    objective: "What drives satisfaction", population: "Adults", methodology: "Online",
    hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [],
    analysisPlan: { crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }], tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }, { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 1, hypotheses: ["H2"] }], derived: [], segments: [] },
  } as never;
  /* as the importer leaves it: the file, source id → question, and the instruction a behaviour came from */
  const sat = def.questions.find((q) => q.variableName === "SAT")!;
  (def as { imports?: unknown[] }).imports = [{ id: "imp1", platform: "word", format: "docx", fileName: "Brief v3.docx", fingerprint: "abc", importedAt: "2026-11-01T10:00:00Z", mode: "new", map: [{ kind: "question", source: "Q7", rescript: sat.id }], review: [] }];
  (sat as { notes?: string }).notes = "behaviour: answers must total 100% (“MUST ADD TO 100%”)";
  return def;
}
const resultsOf = (run: AnalysisRun) => Object.fromEntries(run.items.map((it) => [it.definition.options?.planned ? String(it.definition.options.planned) : it.definition.name, it.result]));

test("every claim in the deck opens its table, the analysis, the variables, the questions and the data", () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { now: "2026-10-09T09:00:00Z" });
  const results = resultsOf(run);
  const deck = deckFromRun(def, run, { results });
  const g = buildLineage({ def, results, deck, dataset: { n: run.n, environment: run.environment, dataVersion: "d1", surveyVersion: "1.0" } });
  const cov = lineageCoverage(g);
  assert.ok(cov.claims >= 5, JSON.stringify(cov));
  assert.deepEqual(cov.orphaned, [], "no claim without a table");
  assert.equal(cov.reachData, cov.claims, "every claim reaches the data it was computed on");
  /* a key finding about satisfaction by gender, walked back */
  const claim = g.nodes.find((n) => n.kind === "claim" && /satisfaction/i.test(n.label) && n.detail?.slideType === "key_finding")!;
  const e = explainClaim(g, claim.id)!;
  assert.ok(e.tables.length && e.analyses.length);
  assert.ok(e.variables.some((v) => v.id === "v:SAT") && e.variables.some((v) => v.id === "v:GENDER"), e.variables.map((v) => v.id).join(","));
  assert.ok(e.questions.some((q) => /^Q\d|SAT|satisf/i.test(q.label)));
  assert.equal(e.dataset?.detail?.n, run.n);
  assert.ok(e.analyses[0].detail?.inputHash, "the analysis carries the hash of everything that decided its numbers");
  /* …and on to the questionnaire line it was imported from, with the behaviour that line set */
  assert.deepEqual(e.files.map((f) => f.label), ["Brief v3.docx (word, 2026-11-01)"]);
  assert.ok(e.sources.some((s) => s.label === "Q7 in Brief v3.docx"));
  assert.ok(e.settings.some((s) => /answers must total 100%/.test(s.label)));
});

test("a claim the graph cannot back is reported as orphaned; an unknown claim id explains nothing", () => {
  const def = planned();
  const run = runPlan(def, synthDataset(200), { now: "2026-10-09T09:00:00Z" });
  const results = resultsOf(run);
  const deck = deckFromRun(def, run, { results });
  const broken = { ...deck, sources: (deck.sources ?? []).filter((s) => s.ref !== "T1") };
  const cov = lineageCoverage(buildLineage({ def, results, deck: broken }));
  assert.ok(cov.orphaned.length > 0, "dropping T1 leaves the claims that cited it with no table");
  assert.equal(explainClaim(buildLineage({ def }), "c:99:0"), null);
});
