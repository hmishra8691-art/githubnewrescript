import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport, REPORT_MIME } from "./render.js";
import { checkDocx } from "./docxCheck.js";
import { buildCsv } from "./csv.js";
import { ExportUnsupportedError } from "./shared.js";
import { synthDataset, D } from "../analyses/fixture.js";
import { runAnalysis } from "../analyses/index.js";
import { BLOCK_RENDERING, REPORT_BLOCK_TYPES, REPORT_FORMATS, checkReportModel, expandPanels, reportCoverage } from "../reportModel.js";
import type { DashboardDefinition, ReportDefinition } from "../types.js";

/* R1 — ONE MODEL, EVERY FORMAT: the same report rendered as each format, a panel grid in every one, coverage before building */
const ds = synthDataset();
const results = {
  a1: runAnalysis(D("crosstab", [], { rows: ["SAT"], columns: ["GENDER"] }), ds),
  a2: runAnalysis(D("nps", ["NPS"], { options: { by: "GENDER" } }), ds),
  a3: runAnalysis(D("descriptive", ["REGION"]), ds),
};
const report: ReportDefinition = {
  title: "One model", subtitle: "Wave 1", mode: "snapshot",
  blocks: [
    { id: "cv", type: "cover", title: "One model", author: "A researcher" },
    { id: "es", type: "executive_summary", analysisIds: ["a1", "a2"], text: "What we found." },
    { id: "s1", type: "section", title: "Satisfaction" },
    { id: "c1", type: "chart", title: "Satisfaction by gender", analysisId: "a1", chart: { type: "bar_grouped", options: {} }, caption: "Caption one." },
    { id: "t1", type: "table", analysisId: "a1" },
    { id: "k1", type: "kpi", analysisId: "a2" },
    { id: "pg", type: "panel_grid", title: "Region at a glance", headline: "The regions differ.", panels: [
      { id: "p1", analysisId: "a3", title: "Region chart", chart: { type: "bar_horizontal", options: {} } },
      { id: "p2", analysisId: "a3", title: "Region table" },
      { id: "p3", analysisId: "" },
    ] },
    { id: "in", type: "insights", analysisIds: ["a1"] },
    { id: "tx", type: "text", title: "A note", markdown: "Some **words** here.\n\n- one\n- two" },
    { id: "pb", type: "page_break" },
    { id: "mt", type: "methodology", items: [{ label: "Fieldwork", value: "1–14 November" }] },
    { id: "gone", type: "chart", analysisId: "missing", chart: { type: "bar_vertical", options: {} } },
  ],
};

test("every format has a rendering for every block type", () => {
  for (const f of REPORT_FORMATS) for (const t of REPORT_BLOCK_TYPES) assert.ok(BLOCK_RENDERING[f][t], `${f}/${t}`);
});

test("a panel grid in a linear document is its headline, then each filled panel; empty panels are left out", () => {
  const ex = expandPanels(report.blocks).filter((b) => b.id.startsWith("pg"));
  assert.deepEqual(ex.map((b) => `${b.id}:${b.type}`), ["pg__head:text", "pg__p1:chart", "pg__p2:table"]);
});

test("coverage names how each block comes out and which have no data, before anything is built", () => {
  const docx = reportCoverage(report, "docx", results);
  assert.equal(docx.lines.find((l) => l.blockId === "c1")!.rendering, "data");
  assert.equal(docx.lines.find((l) => l.blockId === "pg")!.rendering, "expanded");
  assert.match(docx.lines.find((l) => l.blockId === "gone")!.problem!, /no data: analysis not computed/);
  assert.ok(docx.notes.some((n) => /chart: given as its data table/.test(n)));
  assert.ok(docx.renderable);
  const xlsx = reportCoverage(report, "xlsx", results);
  assert.ok(xlsx.notes.some((n) => /executive summary.*not included/.test(n)));
  assert.equal(reportCoverage({ blocks: [{ id: "x", type: "chart", analysisId: "missing", chart: { type: "bar_vertical", options: {} } }] }, "pptx", results).renderable, false);
  assert.deepEqual(checkReportModel({ blocks: [{ id: "a", type: "text", markdown: "" }, { id: "a", type: "table", analysisId: "" }] }), ["Two blocks share the id “a”.", "“table” has no analysis chosen."]);
});

test("the same report renders as PowerPoint, PDF, Word, Excel and CSV through one entry point", async () => {
  for (const f of REPORT_FORMATS) {
    const r = await renderReport(f, { report, results, meta: { survey: "Synthetic", generatedBy: "tests" } });
    assert.equal(r.mime, REPORT_MIME[f]);
    assert.equal(r.fileName, `One_model.${f}`);
    assert.ok(r.bytes.length > 100, `${f} has bytes`);
    assert.ok(r.coverage.lines.length === report.blocks.length);
  }
});

test("the Word document carries every block: cover, summary, chart data, table, KPI, both panels, methodology", async () => {
  const r = await renderReport("docx", { report, results, meta: { survey: "Synthetic" }, notes: { c1: ["In plain language: the groups differ."] } });
  const c = checkDocx(r.bytes);
  assert.ok(c.ok, c.problems.join("; "));
  for (const s of ["One model", "Executive summary", "What we found.", "Satisfaction by gender", "Caption one.", "In plain language: the groups differ.", "Region at a glance", "The regions differ.", "Region chart", "Region table", "Methodology", "Fieldwork", "This analysis is not available."]) assert.ok(c.text.includes(s), `docx contains “${s}”`);
  assert.ok(c.tables >= 3, `tables: ${c.tables}`);
  assert.ok(!c.text.includes("**"), "markdown marks are removed");
  /* the KPI's number is the analysis's own */
  const k = results.a2.chart.kpis![0];
  assert.ok(c.text.includes(String(Math.round(Number(k.value)))), "the KPI value is printed");
});

test("CSV and PDF include the panel grid's analysis (both used to skip it)", async () => {
  const csv = buildCsv({ report: { title: "x", blocks: [report.blocks[6]] }, results });
  assert.match(csv, new RegExp(results.a3.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const pdf = await renderReport("pdf", { report: { ...report, blocks: [report.blocks[0], report.blocks[6]] }, results });
  assert.ok(pdf.bytes.length > 2000);
});

test("a dashboard renders through the same entry point; one with nothing chosen is refused in a sentence", async () => {
  const dash: DashboardDefinition = { title: "Board", widgets: [{ id: "w1", type: "chart", analysisId: "a1", chart: { type: "bar_grouped", options: {} }, w: 6, h: 4, x: 0, y: 0 }, { id: "w2", type: "kpi", analysisId: "a2", w: 3, h: 2, x: 6, y: 0 }] };
  const r = await renderReport("docx", { report: dash, results });
  assert.ok(checkDocx(r.bytes).ok);
  await assert.rejects(renderReport("pdf", { report: { title: "Empty", widgets: [{ id: "w", type: "photo", w: 1, h: 1, x: 0, y: 0 }] } as DashboardDefinition, results }), ExportUnsupportedError);
});
