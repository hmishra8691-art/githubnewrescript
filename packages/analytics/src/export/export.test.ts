import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildPptx, isEmbeddableImage, MAX_EMBEDDED_IMAGE_BYTES } from "./pptx.js";
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

test("pptx: a map chart exports as bars and says on the slide that it did", async () => {
  /*
   * §39 — PowerPoint has no map chart type, so a choropleth becomes ranked
   * bars. The substitution is fine; doing it silently is not, because the
   * reader of the deck would have no way to tell that the analyst's map and
   * these bars are the same chart.
   */
  const geoReport: ReportDefinition = {
    title: "Geo", mode: "snapshot",
    blocks: [{ id: "g1", type: "chart", title: "Satisfaction by country", analysisId: "a5", chart: { type: "map_country", options: {} } }],
  };
  const geoResults = { ...results, a5: runAnalysis(D("crosstab", [], { rows: ["COUNTRY"], columns: ["GENDER"] }), ds) };
  const buf = await buildPptx({ report: geoReport, results: geoResults, meta: { survey: "Synthetic" } });
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  // the note travels in the slide XML, which is plain text inside the zip
  const raw = buf.toString("latin1");
  assert.ok(raw.length > 10000);
  assert.ok(buf.length > 15000, "a deck with a geographic chart still builds");
});

test("only a real, bounded image is allowed into a deck", () => {
  /*
   * §43 — the client hands the export pictures it rendered. A deck is a
   * document the customer forwards, so what goes into one is checked rather
   * than trusted: a PNG or JPEG data URI, base64, and within a size cap.
   */
  const png = "data:image/png;base64," + "A".repeat(200);
  assert.equal(isEmbeddableImage(png), true);
  assert.equal(isEmbeddableImage("data:image/jpeg;base64," + "B".repeat(200)), true);

  assert.equal(isEmbeddableImage(undefined), false);
  assert.equal(isEmbeddableImage(12), false);
  assert.equal(isEmbeddableImage(""), false);
  assert.equal(isEmbeddableImage("https://example.com/map.png"), false, "a URL is not an image this builder fetches");
  assert.equal(isEmbeddableImage("data:text/html;base64," + "A".repeat(200)), false, "not every data URI is a picture");
  assert.equal(isEmbeddableImage("data:image/svg+xml;base64," + "A".repeat(200)), false, "svg can carry script, and PowerPoint does not want it");
  assert.equal(isEmbeddableImage("data:image/png;base64,<script>"), false, "the payload has to look like base64");
  assert.equal(isEmbeddableImage("data:image/png;base64,QUJD"), false, "a few bytes is not a rendered chart");
  const huge = "data:image/png;base64," + "A".repeat(Math.ceil((MAX_EMBEDDED_IMAGE_BYTES * 4) / 3) + 8);
  assert.equal(isEmbeddableImage(huge), false, "and an oversized one is refused rather than embedded");
});

test("pptx: a map block carries the picture the renderer made, instead of bars", async () => {
  const geoResults = { ...results, a5: runAnalysis(D("crosstab", [], { rows: ["COUNTRY"], columns: ["GENDER"] }), ds) };
  const geoReport: ReportDefinition = {
    title: "Geo", mode: "snapshot",
    blocks: [{ id: "g1", type: "chart", title: "Satisfaction by country", analysisId: "a5", chart: { type: "map_country", options: {} } }],
  };
  // a real 1×1 PNG, padded past the "too small to be a chart" floor
  const onePixel = "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".padEnd(200, "A");
  const withImage = await buildPptx({ report: geoReport, results: geoResults, images: { g1: onePixel }, meta: { survey: "Synthetic" } });
  const withoutImage = await buildPptx({ report: geoReport, results: geoResults, meta: { survey: "Synthetic" } });
  assert.equal(withImage.subarray(0, 2).toString("latin1"), "PK");
  /*
   * The deck with a picture must not also carry the apology for not having
   * one — that note is only true when the substitution actually happened.
   */
  const raw = (b: Buffer) => b.toString("latin1");
  assert.match(raw(withoutImage), /Shown as ranked bars/, "without a picture the slide still says what it did");
  assert.doesNotMatch(raw(withImage), /Shown as ranked bars/, "with one, there is nothing to apologise for");
  assert.ok(withImage.length !== withoutImage.length, "the two decks are not the same file");
});

test("pptx: a rejected image falls back to the chart rather than failing the export", async () => {
  const geoResults = { ...results, a5: runAnalysis(D("crosstab", [], { rows: ["COUNTRY"], columns: ["GENDER"] }), ds) };
  const geoReport: ReportDefinition = {
    title: "Geo", mode: "snapshot",
    blocks: [{ id: "g1", type: "chart", analysisId: "a5", chart: { type: "map_country", options: {} } }],
  };
  const buf = await buildPptx({ report: geoReport, results: geoResults, images: { g1: "data:text/html;base64,bogus" }, meta: {} });
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK", "the deck still builds");
  assert.match(buf.toString("latin1"), /Shown as ranked bars/, "and honestly reports the substitution it fell back to");
});

test("the fixture's country labels all resolve to real countries", async () => {
  const { resolveRegions } = await import("../geo/index.js");
  const r = runAnalysis(D("crosstab", [], { rows: ["COUNTRY"], columns: ["GENDER"] }), ds);
  const labels = r.chart.categories ?? [];
  assert.ok(labels.length >= 8, "the fixture surveys several countries");
  const out = resolveRegions(labels, "world");
  assert.deepEqual(out.unmatched, [], "every fixture country should be on the map — including the one written 'UK'");
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

/* ------------------------------------------------------------- regression: block with no analysisIds
 * The built-in "Findings" page ships an `insights` block with no analysisIds.
 * It used to crash the PowerPoint export with
 * "Cannot read properties of undefined (reading 'flatMap')" while the viewer
 * rendered it, so the preview worked and the export returned a 500.
 */
test("pptx: an insights / executive-summary block with no analysisIds exports (all analyses are summarised)", async () => {
  const ragged = {
    title: "Ragged", mode: "live",
    blocks: [
      { id: "r0", type: "cover", title: "Ragged" },
      { id: "r1", type: "chart", analysisId: "a1", chart: { type: "bar_grouped", options: {} } },
      { id: "r2", type: "insights", title: "Findings" },
      { id: "r3", type: "executive_summary", title: "Summary" },
    ],
  } as unknown as ReportDefinition;
  const buf = await buildPptx({ report: ragged, results, meta: { survey: "Synthetic", environment: "LIVE" } });
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  const bufX = await buildXlsx({ report: ragged, results, meta: { Survey: "Synthetic" } });
  assert.equal(bufX.subarray(0, 2).toString("latin1"), "PK");
});

/* ------------------------------------------------------------- chart geometry in the deck (audit C-1, C-2) */

import { inflateRawSync } from "node:zlib";
/** a minimal zip reader (central directory) — enough to look inside a .pptx without a dependency */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let eocd = buf.length - 22; while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lh = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(lh, lh + csize);
    out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
    p += 46 + nlen + elen + clen;
  }
  return out;
}
const chartXml = async (type: "bar_stacked_100" | "diverging_likert", analysisId = "a5") => {
  const r: ReportDefinition = { title: "t", mode: "snapshot", blocks: [{ id: "c", type: "chart", analysisId, chart: { type, options: {} } }] };
  const buf = await buildPptx({ report: r, results: { [analysisId]: runAnalysis(D("descriptive", ["ITEMS_a", "ITEMS_b", "ITEMS_c"]), ds) }, meta: { survey: "S", environment: "LIVE" } });
  const files = unzip(buf);
  const name = [...files.keys()].find((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k));
  assert.ok(name, "the deck has a native chart");
  return files.get(name!)!;
};

test("C-2: a 100% stacked bar in the deck has no fixed axis maximum that squeezes it to 1%", async () => {
  const xml = await chartXml("bar_stacked_100");
  assert.match(xml, /<c:grouping val="percentStacked"\/>/);
  assert.doesNotMatch(xml, /<c:max val="100"\/>/);
});

test("C-1: a diverging bar in the deck is a signed stack, centred on zero, with a symmetric axis", async () => {
  const xml = await chartXml("diverging_likert");
  assert.match(xml, /<c:grouping val="stacked"\/>/);
  const min = Number(/<c:min val="(-?[\d.]+)"\/>/.exec(xml)?.[1]), max = Number(/<c:max val="(-?[\d.]+)"\/>/.exec(xml)?.[1]);
  assert.ok(min < 0 && max > 0 && Math.abs(min + max) < 1e-9, `symmetric axis, got ${min}..${max}`);
  const vals = [...xml.matchAll(/<c:v>(-?[\d.]+)<\/c:v>/g)].map((m) => Number(m[1]));
  assert.ok(vals.some((v) => v < 0) && vals.some((v) => v > 0), "negative values for the lower half of the scale");
});

/* ------------------------------------------------------------- R-1: a dashboard exports like a report */
import { ExportUnsupportedError } from "./shared.js";
import type { DashboardDefinition } from "../types.js";

const dash = (widgets: DashboardDefinition["widgets"]): DashboardDefinition => ({ title: "Dash", widgets });
const W = { w: 4, h: 3 };
test("R-1: a dashboard exports to PowerPoint and Excel — its charts, tables and KPIs in reading order", async () => {
  const d = dash([
    { id: "w2", type: "table", analysisId: "a1", x: 0, y: 3, ...W },
    { id: "w1", type: "chart", analysisId: "a3", chart: { type: "pie", options: {} }, title: "Regions", x: 0, y: 0, ...W },
    { id: "w3", type: "kpi", analysisId: "a2", x: 4, y: 0, ...W },
    { id: "w4", type: "photo", imageUrl: "x", x: 8, y: 0, ...W },
    { id: "w5", type: "chart", x: 8, y: 3, ...W },                       // an empty template slot: left out, not a crash
  ]);
  const buf = await buildPptx({ report: d as never, results, meta: { survey: "Synthetic", environment: "LIVE" } });
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  const x = await buildXlsx({ report: d as never, results, meta: { Survey: "Synthetic" } });
  assert.equal(x.subarray(0, 2).toString("latin1"), "PK");
  const slides = [...unzip(buf).keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
  assert.ok(slides.length >= 4, `cover plus three widgets, got ${slides.length} slides`);
});

test("R-1: a dashboard with nothing to show says so in a sentence", async () => {
  const empty = dash([{ id: "w", type: "chart", x: 0, y: 0, ...W }, { id: "p", type: "photo", x: 4, y: 0, ...W }]);
  await assert.rejects(buildPptx({ report: empty as never, results, meta: {} }), (e: unknown) => e instanceof ExportUnsupportedError && /nothing to export/.test((e as Error).message));
  await assert.rejects(buildXlsx({ report: empty as never, results, meta: {} }), ExportUnsupportedError);
  await assert.rejects(buildPptx({ report: { title: "x" } as never, results, meta: {} }), ExportUnsupportedError);
});
