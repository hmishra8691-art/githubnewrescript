import test from "node:test";
import assert from "node:assert/strict";
import type { AnalysisCatalogue, CatalogueEntry } from "@rescript/analytics";
import { explorerEntries, readPanes, renderable, selectionSummary, DEFAULT_PANES, type Selection } from "./analyticsArchitect.ts";

const entry = (key: string, category: CatalogueEntry["category"], label: string, analysisId: string | null = "a"): CatalogueEntry =>
  ({ key, category, id: key.split(":").pop()!, label, description: "", hypotheses: [], status: "ready", analysisId, technical: { variables: [] } });
const cat = (entries: CatalogueEntry[]): AnalysisCatalogue => ({ all: entries, sections: [], counts: {} as never, objective: null, advice: [] });

test("pane widths are read back clamped, or fall to the defaults", () => {
  assert.deepEqual(readPanes(null), DEFAULT_PANES);
  assert.deepEqual(readPanes("{broken"), DEFAULT_PANES);
  assert.deepEqual(readPanes(JSON.stringify({ explorer: 50, properties: 5000 })), { explorer: 220, properties: 640 });
});

test("the Explorer shows one category or all, narrowed by the filter; only entries with an analysis can be shown", () => {
  const c = cat([
    entry("hypotheses:H1", "hypotheses", "H1 — Region affects satisfaction", null),
    entry("crosstabs:a", "crosstabs", "Satisfaction by Region"),
    entry("tests:b", "tests", "Satisfaction by Gender"),
    entry("reports:r", "reports", "Wave 1 report", null),
    entry("crosstabs:plan:x", "crosstabs", "Planned only", null),
  ]);
  assert.equal(explorerEntries(c, "all", "").length, 5);
  assert.deepEqual(explorerEntries(c, "crosstabs", "").map((e) => e.key), ["crosstabs:a", "crosstabs:plan:x"]);
  assert.deepEqual(explorerEntries(c, "all", "satisfaction by").map((e) => e.key), ["crosstabs:a", "tests:b"]);
  const s: Selection = { keys: c.all.map((e) => e.key), focus: null };
  assert.deepEqual(renderable(c, s).map((e) => e.key), ["crosstabs:a", "tests:b"]);
  assert.equal(selectionSummary(c, s), "5 selected · 2 can be shown");
  assert.match(selectionSummary(c, { keys: [], focus: null }), /Nothing selected/);
});
