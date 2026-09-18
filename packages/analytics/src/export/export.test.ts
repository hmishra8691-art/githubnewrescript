import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildPptx } from "./pptx.js";
import { buildXlsx } from "./xlsx.js";
import { synthDataset, D } from "../analyses/fixture.js";
import { runAnalysis } from "../analyses/index.js";
import type { ReportDefinition } from "../types.js";

const ds = synthDataset();
const results = {
  a1: runAnalysis(D("crosstab", [], { rows: ["SAT"], columns: ["GENDER"] }), ds),
  a2: runAnalysis(D("nps", ["NPS"], { options: { by: "GENDER" } }), ds),
  a3: runAnalysis(D("descriptive", ["REGION"]), ds),
  a4: runAnalysis(D("correlation", ["SAT", "NPS", "AGE"]), ds),
};
const report: ReportDefinition = {
  title: "Synthetic study", subtitle: "Wave 1", mode: "snapshot",
  blocks: [
    { id: "b0", type: "cover", title: "Synthetic study" },
    { id: "b1", type: "section", title: "Satisfaction" },
    { id: "b2", type: "chart", title: "Satisfaction by gender", analysisId: "a1", chart: { type: "bar_grouped", options: { dataLabels: true } } },
    { id: "b3", type: "table", analysisId: "a1" },
    { id: "b4", type: "kpi", analysisId: "a2" },
    { id: "b5", type: "chart", analysisId: "a3", chart: { type: "pie", options: {} } },
    { id: "b6", type: "chart", analysisId: "a4", chart: { type: "heatmap_correlation", options: {} } },
    { id: "b7", type: "insights", analysisIds: ["a1", "a2"] },
  ],
};

test("pptx: builds a valid deck with native charts", async () => {
  const buf = await buildPptx({ report, results, meta: { survey: "Synthetic", environment: "LIVE" } });
  assert.ok(buf.length > 20000);
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
});

/* ------------------------------------------------------------- panel_grid (§37) */

const trackerReport: ReportDefinition = {
  title: "Tracker wave 4", mode: "live",
  blocks: [
    { id: "g0", type: "cover", title: "Tracker" },
    {
      id: "g1", type: "panel_grid", title: "Innovation snapshot", headline: "A one-line takeaway.", columns: 2,
      panels: [
        { id: "g1p1", analysisId: "a1", title: "Satisfaction by gender", chart: { type: "bar_grouped", options: {} } },
        { id: "g1p2", analysisId: "a3", title: "Region", chart: { type: "pie", options: {} } },
        { id: "g1p3", analysisId: "", title: "Not chosen yet" },
        { id: "g1p4", analysisId: "deleted-analysis", title: "An analysis that no longer exists" },
      ],
    },
    { id: "g2", type: "panel_grid", title: "Monthly trend", columns: 4, panels: [{ id: "g2p1", analysisId: "a4", title: "Correlates" }] },
  ],
};

test("pptx: a panel grid draws every filled panel and a placeholder for the rest, without throwing", async () => {
  const buf = await buildPptx({ report: trackerReport, results, meta: { survey: "Synthetic" } });
  assert.ok(buf.length > 15000);
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
});

test("xlsx: panels inside a panel_grid still get their own sheet and chart-data rows", async () => {
  const buf = await buildXlsx({ report: trackerReport, results });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(names.includes("Satisfaction by gender"), "panel g1p1's analysis was dropped");
  assert.ok(names.includes("Region"), "panel g1p2's analysis was dropped");
  // a panel with no analysis, or one pointing at an analysis outside the results bag, contributes no sheet
  assert.ok(!names.includes("Not chosen yet"));
  assert.ok(!names.includes("An analysis that no longer exists"));
  const cs = wb.getWorksheet("Chart data")!;
  const titles: string[] = [];
  cs.eachRow((r) => { const v = r.getCell(1).value; if (typeof v === "string") titles.push(v); });
  assert.ok(titles.includes("Satisfaction by gender"));
  assert.ok(titles.includes("Region"));
});

test("xlsx: summary + one sheet per analysis + chart data + metadata; percents stored as numbers", async () => {
  const buf = await buildXlsx({ report, results, settings: { xlsx: { sheetNames: { summary: "Overview" } } } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const names = wb.worksheets.map((w) => w.name);
  assert.equal(names[0], "Overview");
  assert.ok(names.includes("Satisfaction by gender"));
  assert.ok(names.includes("Chart data"));
  assert.ok(names.includes("Metadata"));
  const xt = wb.getWorksheet("Satisfaction by gender")!;
  let pctCell = null as ExcelJS.Cell | null;
  xt.eachRow((r) => r.eachCell((c) => { if (!pctCell && typeof c.value === "number" && c.numFmt?.includes("%")) pctCell = c; }));
  assert.ok(pctCell, "percent cells are numeric with a % format");
  assert.ok(((pctCell as unknown as ExcelJS.Cell).value as number) <= 1);
});
