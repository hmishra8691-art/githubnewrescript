import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, categoricalColumn } from "../dataset.js";
import { runAnalysis } from "./index.js";
import type { AnalysisDefinition } from "../types.js";
import { def, synthRows } from "./fixture.js";

/* NESTED COLUMN BANNERS (audit 2026-11-17, P2-05): Gender › Region as one two-level header */
const rows = synthRows();
const dsSpec = { environment: "LIVE" as const, dataset: "all" as const };
const ds = buildDataset(def, rows, { spec: dsSpec });
const D = (options: Record<string, unknown>): AnalysisDefinition => ({ name: "xt", kind: "crosstab", dataset: dsSpec, variables: [], rows: ["SAT"], columns: ["GENDER", "REGION"], options });

test("nestCols: every region within each gender, grouped under the gender, with the counts a hand count gives", () => {
  const r = runAnalysis({ ...D({ nestCols: true }), measure: "count" }, ds);
  const t = r.tables[0];
  const cols = t.columns.filter((c) => c.key !== "row" && c.key !== "__total");
  assert.equal(cols.length, 6, cols.map((c) => c.label).join(","));
  assert.deepEqual([...new Set(cols.map((c) => c.group))], ["Male", "Female"], "outer categories are the header groups");
  assert.deepEqual(cols.slice(0, 3).map((c) => c.label.replace(/ \(\w+\)$/, "")), ["North", "South", "East"]);
  /* the base of Male › South is the respondents who are both, counted by hand */
  const g = categoricalColumn(ds, "GENDER"), rg = categoricalColumn(ds, "REGION"), sat = categoricalColumn(ds, "SAT");
  const hand = ds.cases.filter((c, i) => g[i] === "1" && rg[i] === "2" && sat[i] != null && (c.weight ?? 1) > 0).length;
  assert.equal(t.columnBases![cols[1].key], hand);
  assert.ok(t.notes!.some((n) => /letters compare the columns under the same outer category/.test(n)));
  assert.deepEqual(r.variablesUsed, ["SAT", "GENDER", "REGION"], "the variables asked for, not the derived one");
});

test("nestCols letters stay within one outer category", () => {
  const r = runAnalysis(D({ nestCols: true, sigMinBase: 0, alpha: 0.5, correction: "none" }), ds);
  const t = r.tables[0];
  const cols = t.columns.filter((c) => c.key !== "row" && c.key !== "__total");
  const maleLetters = new Set(cols.slice(0, 3).map((c) => (c as { letter?: string }).letter));
  for (const row of t.rows.filter((x) => x.__kind === "category")) {
    for (const c of cols.slice(0, 3)) {
      const marks = String(row[`${c.key}__sig`] ?? "");
      for (const ch of marks) assert.ok(maleLetters.has(ch), `a Male column is only compared with Male columns (${marks})`);
    }
  }
});

test("without nestCols the banner is unchanged; too many combinations fall back with a warning", () => {
  const flat = runAnalysis(D({ layout: "banner" }), ds);
  assert.ok(flat.tables[0].columns.some((c) => c.group === "Gender") && flat.tables[0].columns.some((c) => c.group === "Region"));
  const four = runAnalysis({ ...D({ nestCols: true }), columns: ["GENDER", "REGION", "GENDER", "REGION"] }, ds);
  assert.ok(four.warnings.some((w) => /three levels deep/.test(w)));
});
