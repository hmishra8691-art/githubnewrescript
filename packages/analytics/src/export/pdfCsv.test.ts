import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPdf, checkPdf } from "./pdf.js";
import { buildCsv, tableCsv } from "./csv.js";
import { synthDataset, D } from "../analyses/fixture.js";
import { runAnalysis } from "../analyses/index.js";
import type { ReportDefinition } from "../types.js";

/* THE PDF AND CSV EXPORTS (M6): a real document from real results, every chart kind drawn, tables paginated; CSV every table once */
const ds = synthDataset();
const results = {
  a1: runAnalysis(D("crosstab", [], { rows: ["SAT"], columns: ["GENDER"] }), ds),
  a2: runAnalysis(D("nps", ["NPS"], { options: { by: "GENDER" } }), ds),
  a3: runAnalysis(D("descriptive", ["REGION"]), ds),
  a4: runAnalysis(D("correlation", ["SAT", "NPS", "AGE"]), ds),
  a5: runAnalysis(D("descriptive", ["AGE"]), ds),
};
const report: ReportDefinition = {
  title: "Synthetic study", subtitle: "Wave 1", mode: "snapshot",
  blocks: [
    { id: "b0", type: "cover", title: "Synthetic study", author: "A researcher" },
    { id: "b1", type: "section", title: "Satisfaction", subtitle: "by who answered" },
    { id: "b2", type: "chart", title: "Satisfaction by gender", analysisId: "a1", chart: { type: "bar_grouped", options: { dataLabels: true } }, caption: "A caption." },
    { id: "b2h", type: "chart", analysisId: "a1", chart: { type: "bar_horizontal", options: {} } },
    { id: "b2s", type: "chart", analysisId: "a1", chart: { type: "bar_stacked_100", options: {} } },
    { id: "b2m", type: "chart", analysisId: "a1", chart: { type: "heatmap_crosstab", options: {} } },
    { id: "b3", type: "table", analysisId: "a1" },
    { id: "b4", type: "kpi", analysisId: "a2" },
    { id: "b5", type: "chart", analysisId: "a3", chart: { type: "pie", options: {} } },
    { id: "b6", type: "chart", analysisId: "a4", chart: { type: "heatmap_correlation", options: {} } },
    { id: "b6l", type: "chart", analysisId: "a5", chart: { type: "line", options: {} } },
    { id: "b7", type: "insights", analysisIds: ["a1", "a2"] },
    { id: "b8", type: "text", title: "A note", markdown: "Some **words** here." },
    { id: "b9", type: "executive_summary", analysisIds: ["a1", "a2"] },
    { id: "b10", type: "chart", analysisId: "missing", chart: { type: "bar_vertical", options: {} } },
  ],
};

test("the PDF: a valid document with pages, every block drawn, notes printed under their block", async () => {
  const buf = await buildPdf({ report, results, meta: { survey: "Synthetic", generatedBy: "tests" }, notes: { b2: ["In plain language: the groups differ.", "Statistics: chi-square, p < 0.001."] } });
  const check = checkPdf(buf);
  assert.ok(check.ok, check.problems.join("; "));
  assert.ok(buf.length > 5000, `too small: ${buf.length}`);
  const text = buf.toString("latin1");
  assert.ok(/\/Type\s*\/Pages/.test(text));
  /* at least cover + section + methodology pages */
  assert.ok((text.match(/\/Type\s*\/Page[^s]/g) ?? []).length >= 3);
  assert.ok(!checkPdf(Buffer.from("not a pdf")).ok);
});

test("the CSV: every table once, a # line per table, significance letters in their own column, quoting", () => {
  const csv = buildCsv({ report, results });
  assert.ok(csv.startsWith("# Synthetic study\n"));
  const headers = csv.split("\n").filter((l) => l.startsWith("# ") && l.includes(" — "));
  assert.ok(headers.length >= 4, headers.join(" | "));
  assert.equal(new Set(headers).size, headers.length, "no table twice");
  const t = tableCsv("x", { id: "t", title: "T", columns: [{ key: "row", label: "Row" }, { key: "a", label: "A", type: "pct" }], rows: [{ row: "Yes, \"really\"", a: 12.5, a__sig: "B" }, { row: "No", a: 87.5 }] });
  assert.equal(t.split("\n")[1], "Row,A (%),A sig.");
  assert.equal(t.split("\n")[2], '"Yes, ""really""",12.5,B');
  assert.equal(t.split("\n")[3], "No,87.5,");
});
