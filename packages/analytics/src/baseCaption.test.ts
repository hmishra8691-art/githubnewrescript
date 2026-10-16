import { test } from "node:test";
import assert from "node:assert/strict";
import { baseCaption, baseCaptionParts, conditionWords, runCaption, runScopeOf, statusWord } from "./baseCaption.js";
import { buildDataset } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";
import type { AnalysisDefinition } from "./types.js";
import { def, rule, synthRows, spec } from "./analyses/fixture.js";

/*
 * THE BASE CAPTION (audit 2026-10-16, OR-03 / ANALYTICS-04 — "the base of 20").
 * A base shrinks for reasons the number does not show: environment, status,
 * quality rule, the analysis's filter, who was asked. The caption says all of
 * them, always, in one line.
 */
const base = { total: 84, filtered: 20, n: 20, weightedN: 20, label: "All respondents" };

test("the caption names the answered n, the variables, the in-scope count and the scope", () => {
  const c = baseCaption({ base, variablesUsed: ["Q5"], definition: { dataset: { environment: "LIVE", dataset: "clean" }, filter: rule("REGION", "West") } });
  assert.equal(c, "n = 20 · answered Q5 · 20 of 84 completes in scope (filter: REGION = West; LIVE; clean dataset)");
});

test("without a filter the in-scope count is one number; weighting, dates, statuses and segments are written out", () => {
  const c = baseCaption({
    base: { total: 84, filtered: 84, n: 60, weightedN: 58.4, label: "All respondents" }, variablesUsed: ["SAT", "GENDER"],
    definition: { dataset: { environment: "ALL", dataset: "all", statuses: ["complete", "in_progress"], from: "2026-01-01", to: "2026-02-01" }, weighting: { variable: "WT" } },
    segment: { name: "Women", n: 31 }, labelOf: (v) => ({ SAT: "Q4", GENDER: "Q1", WT: "Weight" }[v] ?? v),
  });
  assert.equal(c, "n = 60 (weighted n = 58.4) · answered Q4, Q1 · segment Women (n = 31) · 84 responses (complete, in progress) in scope (TEST + LIVE; all responses; from 2026-01-01 to 2026-02-01; weighted by Weight)");
  assert.equal(statusWord({ statuses: ["complete"] }), "completes");
  assert.equal(statusWord(null), "completes");
});

test("a saved filter is named by its text when given, by count when not; the parts are reusable one by one", () => {
  const p = baseCaptionParts({ base, definition: { dataset: { environment: "LIVE", dataset: "custom", qualityClasses: ["PASS", "FLAGGED"] }, filterIds: ["f1", "f2"] } });
  assert.equal(p.n, "n = 20");
  assert.equal(p.answered, null, "no variables: nothing to say who answered");
  assert.deepEqual(p.scope, ["2 saved filters applied", "LIVE", "quality: PASS, FLAGGED"]);
  assert.equal(baseCaptionParts({ base, definition: { filterIds: ["f1"] }, filterText: "Region = West" }).scope[0], "filter: Region = West");
});

test("a filter is written in the questionnaire's words when it is at hand, from its rule otherwise", () => {
  const filter = { type: "group" as const, op: "and" as const, children: [rule("q_gender", 2), rule("q_age", 30, "gte")] };
  const generic = conditionWords(filter);
  assert.equal(generic, "(q_gender = 2 and q_age ≥ 30)");
  const worded = baseCaptionParts({ base, definition: { dataset: spec, filter }, survey: def }).scope[0];
  assert.match(worded, /^filter: /);
  assert.match(worded, /Female/, `the questionnaire's option label is used: ${worded}`);
});

test("a real result captions itself from its provenance: the filtered count, the answered n and the dataset spec", () => {
  const rows = synthRows(100).map((r, i) => ({ ...r, answers: { ...r.answers, ...(i % 4 === 0 ? { q_sat: null } : {}) } }));
  const ds = buildDataset(def, rows, { spec: { environment: "LIVE", dataset: "clean" } });
  const d: AnalysisDefinition = { name: "x", kind: "descriptive", dataset: { environment: "LIVE", dataset: "clean" }, variables: ["SAT"], filter: rule("q_gender", 2) };
  const r = runAnalysis(d, ds);
  const c = baseCaption({ base: r.base, variablesUsed: r.variablesUsed, definition: r.provenance?.definition, survey: def, labelOf: (v) => ds.byName.get(v)?.questionCode ?? v });
  assert.ok(ds.cases.length < 100, "the clean rule drops some rows, which the caption's total reflects");
  assert.match(c, new RegExp(`^n = ${r.base.n} · answered Q4 · ${r.base.filtered} of ${ds.cases.length} completes in scope \\(filter: .*Female.*; LIVE; clean dataset\\)$`), c);
  assert.ok(r.base.n < r.base.filtered, "some women skipped SAT, so the answered n is under the filtered count");
});

test("a plan run records its scope and captions it, including per-item weighting and filters", () => {
  const ds = buildDataset(def, synthRows(50), { spec: { environment: "LIVE", dataset: "clean" } });
  const items = [
    { definition: { name: "A", kind: "descriptive" as const, dataset: spec, variables: ["SAT"] } },
    { definition: { name: "B", kind: "descriptive" as const, dataset: spec, variables: ["SAT"], weighting: { variable: "AGE" }, filter: rule("q_gender", 1) } },
    { definition: { name: "C", kind: "descriptive" as const, dataset: spec, variables: ["SAT"], weighting: { variable: "AGE" } } },
  ];
  const scope = runScopeOf(ds, items);
  assert.ok(ds.cases.length < 50, "the clean rule drops some rows");
  assert.deepEqual(scope, { environment: "LIVE", dataset: "clean", statuses: ["complete"], nInScope: ds.cases.length, nTotal: 50, weightings: [{ variable: "AGE" }], filteredItems: ["B"] });
  assert.equal(runCaption({ n: ds.cases.length, environment: "LIVE" }, scope), `n = ${ds.cases.length} of 50 completes in scope (LIVE; clean dataset; weighted by AGE; 1 analysis carries its own filter)`);
  assert.equal(runCaption({ n: 50, environment: "LIVE" }, { ...scope, nTotal: 80, weightings: [], filteredItems: [] }), "n = 50 of 80 completes in scope (LIVE; clean dataset)");
  assert.equal(runCaption({ n: 7, environment: "TEST" }, null), "n = 7 completes in scope (TEST)", "an older run without a recorded scope still says its environment");
});
