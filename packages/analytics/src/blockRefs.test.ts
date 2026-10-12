import test from "node:test";
import assert from "node:assert/strict";
import { reportAnalysisIds, summaryAnalysisIds, normalizeBlocks, explicitAnalysisIds } from "./blockRefs.js";
import type { ReportBlock } from "./types.js";

const B = (x: unknown) => x as ReportBlock;

test("reportAnalysisIds reads every kind of block, tolerating absent analysisIds", () => {
  const blocks = [
    B({ id: "1", type: "chart", analysisId: "a" }),
    B({ id: "2", type: "insights" }),
    B({ id: "3", type: "executive_summary", analysisIds: ["b", "a"] }),
    B({ id: "4", type: "panel_grid", panels: [{ id: "p", analysisId: "c" }, { id: "q", analysisId: "" }] }),
    B({ id: "5", type: "kpi", analysisId: "" }),
  ];
  assert.deepEqual(reportAnalysisIds({ blocks }).sort(), ["a", "b", "c"]);
  assert.deepEqual(reportAnalysisIds({ widgets: [{ analysisId: "w" }, {}] }), ["w"]);
  assert.deepEqual(reportAnalysisIds({}), []);
});

test("summaryAnalysisIds: explicit choice wins; none chosen means every analysis the report shows", () => {
  const blocks = [B({ id: "1", type: "chart", analysisId: "a" }), B({ id: "2", type: "table", analysisId: "b" }), B({ id: "3", type: "insights" }), B({ id: "4", type: "insights", analysisIds: ["z"] })];
  assert.deepEqual(summaryAnalysisIds(blocks[2], { blocks }), ["a", "b"]);
  assert.deepEqual(summaryAnalysisIds(blocks[3], { blocks }), ["z"]);
  assert.deepEqual(explicitAnalysisIds(blocks[2]), []);
});

test("normalizeBlocks makes the optional ids explicit and leaves other blocks alone", () => {
  const blocks = [B({ id: "1", type: "insights" }), B({ id: "2", type: "text", markdown: "x" })];
  const out = normalizeBlocks(blocks);
  assert.deepEqual((out[0] as { analysisIds?: string[] }).analysisIds, []);
  assert.equal(out[1], blocks[1]);
});

import { checkSnapshot } from "./blockRefs.js";

test("checkSnapshot: responses is the largest base, not whichever analysis came first", () => {
  const blocks = [B({ id: "1", type: "chart", analysisId: "a" }), B({ id: "2", type: "chart", analysisId: "b" })];
  const c = checkSnapshot({ blocks }, { a: { base: { total: 0, n: 0 } }, b: { base: { total: 33, n: 33 } } });
  assert.equal(c.responses, 33);
  assert.equal(c.ok, true);
});

test("checkSnapshot flags a report that would freeze blank: all-zero bases, deleted and failed analyses", () => {
  const blocks = [B({ id: "1", type: "chart", analysisId: "a" }), B({ id: "2", type: "chart", analysisId: "gone" }), B({ id: "3", type: "kpi", analysisId: "bad" })];
  const c = checkSnapshot({ blocks }, { a: { base: { total: 0, n: 0 } }, bad: { name: "NPS", base: { total: 40, n: 40 }, error: { code: "not_computable" } } });
  assert.deepEqual(c.missing, ["gone"]);
  assert.deepEqual(c.failed, ["bad"]);
  assert.equal(c.ok, false);
  const empty = checkSnapshot({ blocks: [blocks[0]] }, { a: { base: { total: 0, n: 0 } } });
  assert.equal(empty.empty, true);
  assert.match(empty.problems[0], /every chart and number would read 0/);
  assert.equal(checkSnapshot({ blocks: [B({ id: "t", type: "text", markdown: "x" })] }, {}).ok, true, "a text-only report has nothing to be blank");
});

import { normalizeReportDefinition } from "./blockRefs.js";

test("normalizeReportDefinition heals stored blocks and leaves dashboards alone", () => {
  const d = normalizeReportDefinition({ title: "t", blocks: [B({ id: "1", type: "executive_summary" })] }) as unknown as { blocks: { analysisIds: string[] }[] };
  assert.deepEqual(d.blocks[0].analysisIds, []);
  const dash = { title: "d", widgets: [{ id: "w" }] };
  assert.equal(normalizeReportDefinition(dash), dash);
  assert.equal(normalizeReportDefinition(null), null);
});
