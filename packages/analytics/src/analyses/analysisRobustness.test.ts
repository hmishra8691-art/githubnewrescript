import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset } from "../dataset.js";
import { runAnalysis, mentionsVariable } from "./index.js";
import { lowColumnsWarning } from "./crosstab.js";
import type { AnalysisDefinition } from "../types.js";
import { def, synthRows } from "./fixture.js";

/**
 * Regressions for the Data Analytics audit (Oct 2026): a wall of per-column
 * "has a base of N" warnings stacked above the table, raw exception text on
 * screen, and a zero base drawn as 0.0%.
 */
const rows = synthRows();
const dsSpec = { environment: "LIVE" as const, dataset: "all" as const };
const ds = buildDataset(def, rows, { spec: dsSpec });
const XT = (extra: Partial<AnalysisDefinition>, options: Record<string, unknown> = {}): AnalysisDefinition => ({ name: "xt", kind: "crosstab", dataset: dsSpec, variables: [], rows: ["SAT"], columns: ["GENDER"], options, ...extra } as AnalysisDefinition);

test("lowColumnsWarning: one sentence, names the thinnest few, counts the rest", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ label: `C${i}`, group: "G", n: 10 + i }));
  const w = lowColumnsWarning(many);
  assert.match(w, /^9 columns have a base under 30: C0 \(n = 10\), C1 \(n = 11\), C2 \(n = 12\), C3 \(n = 13\) and 5 more/);
  assert.equal(lowColumnsWarning([{ label: "X", group: "G", n: 4 }]), "1 column has a base under 30: X (n = 4) — read it with caution.");
});

test("a crosstab with many thin columns raises ONE base warning, not one per column", () => {
  const thin = rows.slice(0, 80); // 80 respondents spread over the banner: every column is thin
  const small = buildDataset(def, thin, { spec: dsSpec });
  const r = runAnalysis(XT({ columns: ["REGION", "GENDER"] }, { layout: "banner" }), small);
  const baseWarnings = r.warnings.filter((w) => /base (of|under)/.test(w) && !/respondents \(fewer/.test(w));
  assert.equal(baseWarnings.length, 1, `got ${baseWarnings.length}: ${baseWarnings.join(" | ")}`);
  assert.ok(r.tables[0].rows.some((x) => x.__kind === "category"), "values are still in the table");
});

test("a column nobody is in shows no value, not 0.0%", () => {
  // everyone is male, so the "Female" column has a base of 0
  const allMale = synthRows().map((r) => ({ ...r, answers: { ...r.answers, q_gender: 1 } }));
  const one = buildDataset(def, allMale, { spec: dsSpec });
  const r = runAnalysis(XT({ rows: ["SAT"], columns: ["GENDER"] }, { measure: "pct_col" }), one);
  const t = r.tables[0];
  assert.ok(t.columns.some((c) => c.key === "2"), "the empty column is still a column");
  const cats = t.rows.filter((x) => x.__kind === "category");
  assert.ok(cats.length > 0);
  for (const row of cats) assert.equal(row["2"], null, `empty column drew ${String(row["2"])}`);
  assert.ok(cats.some((row) => typeof row["1"] === "number" && (row["1"] as number) > 0), "the populated column keeps its values");
});

test("a failing runner returns a sentence and a code — never the raw exception", () => {
  const bad = { name: "boom", kind: "descriptive", dataset: dsSpec, variables: ["SAT"], get options(): never { throw new TypeError("Cannot read properties of undefined (reading 'flatMap')"); } } as unknown as AnalysisDefinition;
  const r = runAnalysis(bad, ds);
  assert.equal(r.error?.code, "not_computable");
  assert.ok(r.warnings.length === 1 && !/flatMap|undefined|TypeError/.test(r.warnings.join(" ")), r.warnings.join(" "));
  assert.deepEqual(r.tables, []);
});

test("dataset warnings attach by whole variable name: Q1 does not pick up Q10's note", () => {
  assert.equal(mentionsVariable("Segment “S” (Q10): A n = 4", "Q1"), false);
  assert.equal(mentionsVariable("Segment “S” (Q1): A n = 4", "Q1"), true);
  assert.equal(mentionsVariable("Q1", "Q1"), true);
});

test("unweighted: weighted n equals the valid base the table used — not everyone in the dataset", () => {
  const skipped = synthRows().map((r, i) => (i < 60 ? { ...r, answers: { ...r.answers, q_sat: undefined } } : r));
  const r = runAnalysis(XT({ rows: ["SAT"], columns: ["GENDER"] }), buildDataset(def, skipped, { spec: dsSpec }));
  assert.ok(r.base.n < r.base.total, `n ${r.base.n} should be below total ${r.base.total}`);
  assert.equal(r.base.weightedN, r.base.n);
});
