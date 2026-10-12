import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SurveyDefinition } from "@rescript/schema";
import { def as base, synthRows, spec } from "../analyses/fixture.js";
import { buildDataset } from "../dataset.js";
import { runPlan } from "../findings.js";
import {
  REPORT_FONTS, createMeasurer, planStoryReport, composeReport, renderFrame, outputSize, sceneTiming, fitToDuration,
  defaultDesign, interpretDesignRequest, applyDesignPatch, contrast, interpretRevision, applyOps, mergeRegenerated, chartAllowed, formatValue,
  brandTheme, PRESETS, subtitlesFor, wrapText, fitText, type StoryReport,
} from "./index.js";

const FONT_DIR = fileURLToPath(new URL("../../../../apps/studio/public/report-fonts/", import.meta.url));
const measurer = createMeasurer(REPORT_FONTS.map((f) => ({ family: f.family, weight: f.weight, data: readFileSync(FONT_DIR + f.file) })));

function study(): SurveyDefinition {
  const def = structuredClone(base);
  def.research = {
    objective: "Understand what drives satisfaction and recommendation", population: "Adults 18+", methodology: "Online panel",
    hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], hypothesisDetails: [], researchQuestions: ["Who is most satisfied?"],
    kpis: [{ name: "Satisfaction", variable: "SAT", measure: "top-2-box share", target: "60%", direction: "higher" }, { name: "NPS", variable: "NPS", measure: "NPS" }],
    constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }], analysis: [], assumptions: [], sources: [],
    brief: { client: "Acme Foods", businessQuestion: "Should we keep investing in service?", decision: "whether to fund the 2027 service programme", background: "", stakeholders: [], deliverables: [] },
    analysisPlan: {
      crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }, { id: "x2", rows: ["AWARE"], columns: ["REGION"], priority: 2, hypotheses: [] }],
      tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }, { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 1, hypotheses: ["H2"] }],
      derived: [], segments: [],
    },
  } as never;
  return def;
}

const def = study();
const ds = buildDataset(def, synthRows(400), { spec });
const run = runPlan(def, ds, { trigger: "manual", now: "2026-10-01T10:00:00Z" }) as never as Parameters<typeof planStoryReport>[1];
const plan = (o: Partial<Parameters<typeof planStoryReport>[2]> = {}): StoryReport => planStoryReport(def, run, { sample: { analysed: 400, environment: "LIVE", dataset: "all" }, date: "2026-10-01", runId: "run1", ...o });

test("the report is proposed from the plan and the run: objective, method, findings, hypotheses, conclusions, limitations, appendix — nothing invented", () => {
  const r = plan();
  const kinds = r.scenes.map((s) => s.kind);
  for (const k of ["title", "objective", "method", "summary", "finding", "hypotheses", "limitations", "closing"]) assert.ok(kinds.includes(k as never), `missing ${k}: ${kinds.join(",")}`);
  assert.ok(r.scenes.some((s) => s.section === "appendix"), "appendix");
  // every chart's numbers come from the run
  for (const s of r.scenes) if (s.visual.type === "chart") {
    assert.ok(s.notes.sources.length > 0, `${s.title} has a source`);
    assert.ok((s.visual.data.base ?? 0) > 0, "base preserved");
    assert.ok(chartAllowed(s.visual.chart, s.visual.data).ok, `${s.visual.chart} valid for ${s.title}`);
  }
  // no duplicate findings
  const titles = r.scenes.filter((s) => s.kind === "finding").map((s) => s.title);
  assert.equal(new Set(titles).size, titles.length);
  // hypotheses carry the run's verdicts only
  const hyp = r.scenes.find((s) => s.kind === "hypotheses")!;
  assert.equal(hyp.visual.type, "verdicts");
  // significance is only claimed when tested
  for (const s of r.scenes) if (s.visual.type === "chart" && !s.visual.data.significanceTested) assert.ok(s.visual.data.series.every((x) => !x.sig?.some(Boolean)), "no sig letters without a test");
});

test("both outputs compose with the real fonts and pass QA: no overflow, collisions, contrast failures, and every printed number matches its source", () => {
  const r = plan();
  for (const target of ["video", "pptx"] as const) {
    const c = composeReport(r, measurer, target);
    assert.equal(c.qa.critical.length, 0, `${target}: ${JSON.stringify(c.qa.critical.slice(0, 4))}`);
    assert.ok(c.qa.valuesVerified > 5, `${target} values verified ${c.qa.valuesVerified}`);
    assert.ok(c.qa.ok);
    for (const p of c.pages) for (const e of p.elements) if (e.kind === "text") {
      assert.ok(e.box.x >= -0.5 && e.box.y >= -0.5 && e.box.x + e.box.w <= p.canvas.w + 0.5 && e.box.y + e.box.h <= p.canvas.h + 0.5, `in bounds ${e.lines.join(" ")}`);
    }
  }
  const pp = composeReport(r, measurer, "pptx");
  const vv = composeReport(r, measurer, "video");
  assert.ok(pp.pages.length > vv.pages.length, "the deck has the appendix, the video does not");
});

test("every aspect ratio composes cleanly; frames render to SVG of the output size, the final frame equals the settled state", () => {
  for (const aspect of ["16:9", "9:16", "1:1"] as const) {
    const r = plan();
    r.design = { ...r.design, video: { ...r.design.video, aspect } };
    const c = composeReport(r, measurer, "video");
    assert.equal(c.qa.critical.length, 0, `${aspect}: ${JSON.stringify(c.qa.critical.slice(0, 3))}`);
    const size = outputSize(aspect, 1080);
    const p = c.pages.find((x) => x.elements.some((e) => e.kind === "rect" && e.role !== "background")) ?? c.pages[0];
    const t = sceneTiming(p, r.scenes[p.sceneIndex], r);
    const svg0 = renderFrame(p, 0, { total: t.total, fadeIn: 0.4, fadeOut: 0.4, ...size, measure: measurer });
    const svgEnd = renderFrame(p, t.enter + 0.01, { total: t.total, fadeIn: 0, fadeOut: 0, ...size, measure: measurer });
    const svgFinal = renderFrame(p, 0, { total: t.total, fadeIn: 0, fadeOut: 0, ...size, measure: measurer, final: true });
    assert.match(svg0, new RegExp(`width="${size.width}" height="${size.height}"`));
    assert.equal(svgEnd, svgFinal, `${aspect}: settled frame is the final state`);
    assert.notEqual(svg0, svgFinal);
  }
});

test("durations: reading time is never cut; a five-minute request is met by stretching holds or explained when impossible", () => {
  const r = plan();
  const c = composeReport(r, measurer, "video");
  const timings = c.pages.map((p) => sceneTiming(p, r.scenes[p.sceneIndex], r));
  for (const t of timings) assert.ok(t.total >= t.minimum - 0.01);
  const long = fitToDuration(timings, 300);
  assert.ok(Math.abs(long.total - 300) < 30 || long.note, `${long.total}`);
  const tiny = fitToDuration(timings, 10);
  assert.ok(tiny.total > 10 && tiny.note, "cannot squeeze below reading time");
  tiny.timings.forEach((t, i) => assert.ok(t.total >= timings[i].minimum - 0.01));
  const srt = subtitlesFor(c.pages.map((p, i) => ({ start: timings.slice(0, i).reduce((a, x) => a + x.total, 0), duration: timings[i].total, text: r.scenes[p.sceneIndex].title })));
  assert.match(srt, /^1\n00:00:00,000 --> /);
});

test("design in words: brand colours, healthcare, dark mode, larger labels, five minutes, vertical, narration — with contrast enforced", () => {
  const brand = { colors: ["#0A2A66", "#D4A017"], name: "Acme" };
  const a = interpretDesignRequest("Use our brand colors, make it a five-minute vertical video with narration and larger labels", { brand, current: defaultDesign() });
  assert.ok(a.understood.length >= 4, a.understood.join("; "));
  const { design } = applyDesignPatch(defaultDesign(), a.patch, { brand });
  assert.equal(design.video.aspect, "9:16");
  assert.equal(design.video.targetDurationSec, 300);
  assert.equal(design.video.narration, true);
  assert.ok(design.typography.scale.label > defaultDesign().typography.scale.label);
  const dark = applyDesignPatch(defaultDesign(), interpretDesignRequest("dark background, white text and teal accents", { current: defaultDesign() }).patch, {}).design;
  assert.ok(contrast(dark.colors.text, dark.colors.background) >= 7);
  // an unreadable request is fixed and said so
  const bad = applyDesignPatch(defaultDesign(), { colors: { text: "#FFFFFF", background: "#FAFAFA" } } as never, {});
  assert.ok(contrast(bad.design.colors.text, bad.design.colors.background) >= 7);
  assert.ok(bad.adjustments.length > 0);
  for (const id of Object.keys(PRESETS)) { const t = brandTheme(id as never, brand); assert.ok(contrast(t.design.colors.text, t.design.colors.background) >= 7, id); }
});

test("revisions in words become explicit operations; distortions are refused with an alternative; person's edits survive regeneration", () => {
  const r = plan();
  const findings = r.scenes.filter((s) => s.kind === "finding" && s.visual.type === "chart");
  assert.ok(findings.length);
  const sel = findings[0];
  const rv = interpretRevision("Move the methodology to the appendix and replace this chart with a horizontal bar chart", r, { selected: sel.id });
  assert.ok(rv.ops.some((o) => o.op === "set_section"), JSON.stringify(rv));
  assert.ok(rv.ops.some((o) => o.op === "set_chart" && o.chart === "hbar"), JSON.stringify(rv));
  const out = applyOps(r, rv.ops);
  assert.equal(out.report.scenes.find((s) => s.kind === "method")!.section, "appendix");
  const changed = out.report.scenes.find((s) => s.id === sel.id)!;
  assert.ok(changed.visual.type === "chart" && changed.visual.chart === "hbar");
  assert.ok(changed.locked.includes("chart"));
  // numbers unchanged by the revision
  assert.deepEqual(changed.visual.type === "chart" && changed.visual.data, sel.visual.type === "chart" && sel.visual.data);
  // refusals
  const bad = interpretRevision("start the y-axis at 40 and hide the base sizes", r, { selected: sel.id });
  assert.equal(bad.refused.length, 2);
  assert.ok(bad.refused.every((x) => x.why));
  // regenerate keeps the person's choice
  const merged = mergeRegenerated(out.report, plan());
  const m = merged.scenes.find((s) => s.id === sel.id)!;
  assert.ok(m.visual.type === "chart" && m.visual.chart === "hbar");
  assert.equal(merged.scenes.find((s) => s.kind === "method")!.section, "appendix");
});

test("charts: invalid types are refused, values are formatted from the source, missing is not zero", () => {
  const share = { categories: ["A", "B", "C"], series: [{ name: "All", values: [40, 35, 25] }], valueFormat: "pct" as const, decimals: 0, base: 100, significanceTested: false, measure: "%" };
  assert.ok(chartAllowed("donut", share).ok);
  assert.ok(!chartAllowed("donut", { ...share, series: [{ name: "All", values: [80, 70, 60] }] }).ok, "multi-response shares do not make a donut");
  assert.ok(!chartAllowed("donut", { ...share, valueFormat: "mean" }).ok);
  assert.ok(!chartAllowed("line", share).ok, "unordered categories are not a line");
  assert.equal(formatValue(null, share), "—");
  assert.equal(formatValue(0, share), "0%");
});

test("text: wrapping and fitting never truncate; overlong words are reported", () => {
  const w = wrapText(measurer, "Supercalifragilisticexpialidocious", "Inter", 400, 40, 200);
  assert.ok(w.brokeWord);
  const f = fitText(measurer, "A long finding title that has to wrap onto more than one line in a narrow box", { family: "Inter", weight: 700, size: 56, minSize: 36, maxWidth: 600, maxHeight: 140, lineHeight: 1.15 });
  assert.equal(f.lines.join(" "), "A long finding title that has to wrap onto more than one line in a narrow box");
  assert.ok(measurer.missing("Hello", "Inter", 400).length === 0);
});
