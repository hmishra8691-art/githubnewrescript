import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reportPages, methodologyBlock, methodologyLines, STANDARD_METHODOLOGY_NOTES,
  applyTemplate, describeTemplate, unfilledBlocks, BUILT_IN_REPORT_TEMPLATES,
} from "./reportPages.js";
import type { ReportBlock, ReportDefinition } from "./types.js";

const cover: ReportBlock = { id: "c", type: "cover", title: "Study" };
const chart = (id: string, analysisId = "a1"): ReportBlock =>
  ({ id, type: "chart", analysisId, chart: { type: "bar_vertical", options: {} } });
const brk: ReportBlock = { id: "pb", type: "page_break" };

/* ------------------------------------------------------------------ pages */

test("a report with no page breaks is one page after the cover", () => {
  const pages = reportPages([cover, chart("x"), chart("y")]);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].blocks.map((b) => b.id), ["c"]);
  assert.deepEqual(pages[1].blocks.map((b) => b.id), ["x", "y"]);
});

test("a page break ends the page and is not itself rendered on one", () => {
  const pages = reportPages([chart("x"), brk, chart("y")]);
  assert.equal(pages.length, 2);
  assert.ok(!pages.flatMap((p) => p.blocks).some((b) => b.type === "page_break"));
});

test("pressing the button twice does not produce a blank page", () => {
  // a blank leaf in a client deliverable reads as a mistake
  const pages = reportPages([chart("x"), brk, { ...brk, id: "pb2" }, chart("y")]);
  assert.equal(pages.length, 2);
  assert.ok(pages.every((p) => p.blocks.length > 0));
});

test("a break at the very end does not leave an empty last page", () => {
  const pages = reportPages([chart("x"), brk]);
  assert.equal(pages.length, 1);
});

test("the cover always gets a page to itself", () => {
  const pages = reportPages([chart("before"), cover, chart("after")]);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages[1].blocks.map((b) => b.type), ["cover"]);
});

test("a section divider starts a new page, and names the pages under it", () => {
  const pages = reportPages([
    chart("intro"),
    { id: "s1", type: "section", title: "The market" },
    chart("m1"),
    { id: "s2", type: "section", title: "The brand" },
    chart("b1"),
  ]);
  assert.equal(pages.length, 3);
  assert.equal(pages[1].section, "The market");
  assert.equal(pages[2].section, "The brand");
});

test("a team that wants a dense report can turn section breaks off", () => {
  const pages = reportPages([
    chart("intro"),
    { id: "s1", type: "section", title: "The market" },
    chart("m1"),
  ], { breakOnSection: false });
  assert.equal(pages.length, 1);
});

test("pages are numbered from one, with no gaps", () => {
  const pages = reportPages([cover, chart("x"), brk, chart("y"), brk, chart("z")]);
  assert.deepEqual(pages.map((p) => p.number), [1, 2, 3, 4]);
});

test("an empty report has no pages rather than one blank one", () => {
  assert.deepEqual(reportPages([]), []);
});

/* ------------------------------------------------------------ methodology */

test("a report with no methodology block falls back to exactly the old boilerplate", () => {
  // the export has always produced this slide; it must not vanish
  const lines = methodologyLines(undefined, { survey: "Brand tracker", generatedBy: "Ada" });
  assert.match(lines[0], /^Survey: Brand tracker$/);
  assert.match(lines[1], /Generated .* by Rescript Analytics for Ada\./);
  assert.deepEqual(lines.slice(2), STANDARD_METHODOLOGY_NOTES);
});

test("the team's own words come first, and the statistical notes last", () => {
  const lines = methodologyLines({
    id: "m", type: "methodology",
    fieldwork: { from: "2026-03-02", to: "2026-03-09" },
    sampleFrame: "n = 1,004 UK adults 18+",
    weighting: "Weighted to age, gender and region",
    notes: "Q7 was added mid-field and has a smaller base.",
    items: [{ label: "Mode", value: "Online panel" }],
  });
  assert.equal(lines[0], "Fieldwork: 2026-03-02 to 2026-03-09");
  assert.equal(lines[1], "Sample: n = 1,004 UK adults 18+");
  assert.equal(lines[2], "Weighted to age, gender and region".replace(/^/, "Weighting: "));
  assert.equal(lines[3], "Mode: Online panel");
  assert.equal(lines[4], "Q7 was added mid-field and has a smaller base.");
  assert.deepEqual(lines.slice(5), STANDARD_METHODOLOGY_NOTES);
});

test("a team can decline the standard notes", () => {
  const lines = methodologyLines({ id: "m", type: "methodology", sampleFrame: "n = 500", includeStandardNotes: false });
  assert.deepEqual(lines, ["Sample: n = 500"]);
});

test("an empty methodology block still produces the fallback, not silence", () => {
  // an author who adds the block and writes nothing must not lose the slide
  const lines = methodologyLines({ id: "m", type: "methodology", includeStandardNotes: false }, { survey: "S" });
  assert.ok(lines.length > 0);
  assert.match(lines[0], /Survey: S/);
});

test("only the first methodology block counts", () => {
  const found = methodologyBlock([
    chart("x"),
    { id: "m1", type: "methodology", sampleFrame: "first" },
    { id: "m2", type: "methodology", sampleFrame: "second" },
  ]);
  assert.equal(found?.sampleFrame, "first");
});

test("half a fieldwork range is still reported", () => {
  const lines = methodologyLines({ id: "m", type: "methodology", fieldwork: { from: "2026-03-02" }, includeStandardNotes: false });
  assert.equal(lines[0], "Fieldwork: 2026-03-02 to ?");
});

/* -------------------------------------------------------------- templates */

test("every built-in template is coherent", () => {
  for (const t of BUILT_IN_REPORT_TEMPLATES) {
    assert.ok(t.id?.startsWith("builtin:"), `${t.name} has no built-in id`);
    assert.equal(t.builtIn, true);
    assert.ok(t.blocks.length >= 4, `${t.name} is too thin to be a shape`);
    assert.ok(t.blocks.some((b) => b.type === "cover"), `${t.name} has no cover`);
    assert.ok(t.blocks.some((b) => b.type === "methodology"), `${t.name} has no methodology`);
    // a template must never carry another study's analysis ids
    for (const b of t.blocks) {
      assert.ok(!(b as { analysisId?: string }).analysisId, `${t.name} carries an analysisId`);
      assert.ok(!(b as { analysisIds?: string[] }).analysisIds?.length, `${t.name} carries analysisIds`);
    }
    assert.ok(describeTemplate(t).length > 8);
  }
});

test("applying a template to an empty report gives the shape and nothing else", () => {
  const def = applyTemplate(BUILT_IN_REPORT_TEMPLATES[0]);
  assert.equal(def.blocks.length, BUILT_IN_REPORT_TEMPLATES[0].blocks.length);
  assert.equal(def.blocks[0].type, "cover");
  assert.equal(unfilledBlocks(def.blocks).length, 2, "the placeholders should still be waiting for an analysis");
});

test("applying a template NEVER discards a block that already has an analysis", () => {
  const existing: Partial<ReportDefinition> = {
    title: "Wave 4",
    blocks: [cover, chart("mine", "analysis-1"), chart("mine2", "analysis-2")],
  };
  const def = applyTemplate(BUILT_IN_REPORT_TEMPLATES[1], existing);
  const refs = def.blocks.filter((b) => (b as { analysisId?: string }).analysisId).map((b) => (b as { analysisId: string }).analysisId);
  assert.ok(refs.includes("analysis-1"), "the first chart was lost");
  assert.ok(refs.includes("analysis-2"), "the second chart was lost");
});

test("the report keeps its own title and settings when a template is applied", () => {
  const def = applyTemplate(BUILT_IN_REPORT_TEMPLATES[0], {
    title: "Wave 4", subtitle: "March 2026", mode: "snapshot",
    viewerFilters: ["f1"], filterId: "f9",
  });
  assert.equal(def.title, "Wave 4");
  assert.equal(def.subtitle, "March 2026");
  assert.equal(def.mode, "snapshot");
  assert.deepEqual(def.viewerFilters, ["f1"]);
  assert.equal(def.filterId, "f9");
});

test("block ids are fresh, so two reports from one template do not share them", () => {
  const a = applyTemplate(BUILT_IN_REPORT_TEMPLATES[0]);
  const b = applyTemplate(BUILT_IN_REPORT_TEMPLATES[0]);
  const shared = a.blocks.map((x) => x.id).filter((id) => b.blocks.some((y) => y.id === id));
  assert.deepEqual(shared, []);
});

test("content the shape had no room for is appended, not dropped", () => {
  const many = Array.from({ length: 9 }, (_, i) => chart(`c${i}`, `analysis-${i}`));
  const def = applyTemplate(BUILT_IN_REPORT_TEMPLATES[0], { blocks: many });
  const refs = new Set(def.blocks.map((b) => (b as { analysisId?: string }).analysisId).filter(Boolean));
  for (let i = 0; i < 9; i++) assert.ok(refs.has(`analysis-${i}`), `analysis-${i} was dropped`);
});

test("a template's title wins over a placeholder's, and a real block keeps its own when the template has none", () => {
  const template = {
    name: "House",
    blocks: [
      { id: "t1", type: "chart" as const, title: "Awareness" },
      { id: "t2", type: "chart" as const },
    ],
  };
  const titled = (id: string, analysisId: string, title: string): ReportBlock =>
    ({ id, type: "chart", analysisId, title, chart: { type: "bar_vertical", options: {} } });
  const def = applyTemplate(template, {
    blocks: [titled("m1", "a1", "crosstab of Q3 by region"), titled("m2", "a2", "keep me")],
  });
  assert.equal((def.blocks[0] as { title?: string }).title, "Awareness");
  assert.equal((def.blocks[1] as { title?: string }).title, "keep me");
});

test("a template describes itself in terms a person can choose by", () => {
  const d = describeTemplate(BUILT_IN_REPORT_TEMPLATES[1]);
  assert.match(d, /pages/);
  assert.match(d, /cover/);
});
