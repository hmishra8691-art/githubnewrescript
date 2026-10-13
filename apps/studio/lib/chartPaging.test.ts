import test from "node:test";
import assert from "node:assert/strict";
import { CHART_PAGE, visibleCharts, analysisIdsFor, hiddenCount } from "../components/analytics/chartPaging.ts";

const charts = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, analysis_id: `a${i % 20}` }));

test("only the first page is visible, and only its analyses are needed", () => {
  const v = visibleCharts(charts, 1);
  assert.equal(v.length, CHART_PAGE);
  assert.equal(analysisIdsFor(v).length, CHART_PAGE);
  assert.ok(!analysisIdsFor(v).includes("a19"));
});

test("a further page reveals the next charts; shared analyses are counted once", () => {
  const v = visibleCharts(charts, 3);
  assert.equal(v.length, 30);
  assert.equal(analysisIdsFor(v).length, 20);
  assert.equal(hiddenCount(30, 1), 18);
  assert.equal(hiddenCount(30, 3), 0);
});

test("a non-positive page count still shows the first page", () => {
  assert.equal(visibleCharts(charts, 0).length, CHART_PAGE);
  assert.equal(hiddenCount(5, 0), 0);
});
