import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, variableMetadata } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";
import { draftReport, type BuilderItem } from "./reportBuilder.js";
import { storyHtml, storyChart, esc } from "./storyHtml.js";
import type { AnalysisDefinition, StoryDefinition } from "./types.js";
import { def, synthRows } from "./analyses/fixture.js";

const spec = { environment: "LIVE" as const, dataset: "all" as const };
const ds = buildDataset(def, synthRows(), { spec });
const vars = variableMetadata(def);
let n = 0;
const item = (name: string, kind: AnalysisDefinition["kind"], variables: string[], extra: Partial<AnalysisDefinition> = {}): BuilderItem => {
  const definition = { name, kind, dataset: spec, variables, ...extra } as AnalysisDefinition;
  return { id: `a${++n}`, name, definition, result: runAnalysis(definition, ds) };
};
const sat = item("Overall satisfaction", "descriptive", ["SAT"]);
const battery = item("Quality, value, service", "descriptive", ["ITEMS_a", "ITEMS_b", "ITEMS_c"]);
const xt = item("Satisfaction by gender", "crosstab", [], { rows: ["SAT"], columns: ["GENDER"], measure: "pct_col" });
const items = [sat, battery, xt];
const results = Object.fromEntries(items.map((i) => [i.id, i.result]));
const story = () => draftReport({ objective: "Understand satisfaction", audience: "client", tone: "plain", keyQuestions: [] }, items, vars, { story: true }).story!;
const bars = (svg: string) => [...svg.matchAll(/<rect class="bar v"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));

test("every visible scene is on the page, in order, and hidden ones are not", () => {
  const s = story();
  const html = storyHtml({ ...s, scenes: s.scenes.map((x, i) => (i === 3 ? { ...x, hidden: true } : x)) }, { results });
  const ids = [...html.matchAll(/data-scene="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, s.scenes.filter((_, i) => i !== 3).map((x) => x.id));
  assert.match(html, /<!doctype html>/);
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), "no network references");
  assert.ok(!/<script[^>]+src=/.test(html), "no external script");
});

test("charts are drawn from the results: bar heights are proportional to the values", () => {
  const c = storyChart(sat.result, "bar_vertical").svg;
  const values = sat.result.chart.series![0].values.map((v) => v ?? 0), hs = bars(c);
  assert.equal(hs.length, values.length);
  const max = Math.max(...values);
  hs.forEach((h, i) => assert.ok(Math.abs(h / (hs[values.indexOf(max)]) - values[i] / max) < 0.02, `bar ${i}`));
  assert.match(c, new RegExp(`>${values[3]}%<`), "labels carry the printed percentage");
  /* change the result and the drawing changes — it is not a picture of the scene's text */
  const other = { ...sat.result, chart: { ...sat.result.chart, series: [{ name: "x", values: [10, 10, 10, 10, 10] }] } };
  const flat = bars(storyChart(other, "bar_vertical").svg);
  assert.equal(flat.length, 5); assert.ok(flat.every((h) => Math.abs(h - flat[0]) < 0.01), "equal values draw equal bars");
});

test("a battery of scale items is drawn as a diverging bar around the midpoint, and a pie of it is a table with the reason", () => {
  const d = storyChart(battery.result, "diverging_likert");
  assert.match(d.svg, /stroke-dasharray="3 3"/, "midpoint line");
  assert.equal(d.note, undefined);
  const hbars = [...d.svg.matchAll(/<rect class="bar h"/g)].length;
  assert.equal(hbars, battery.result.chart.categories!.length * battery.result.chart.series!.length);
  const unsupported = storyChart(sat.result, "box_plot");
  assert.match(unsupported.note ?? "", /box plot chart is not drawn in the animated story, so the result is shown as a table/);
  const noSeries = storyChart({ ...sat.result, chart: { points: [{ x: 1, y: 2 }] } }, "bar_vertical");
  assert.match(noSeries.note ?? "", /no series to draw as a bar vertical chart/);
  assert.match(unsupported.svg, /<text[^>]*class="th"/);
});

test("the chart a scene chose is used, and one the data cannot draw falls back with a note", () => {
  const s = story();
  const sc = s.scenes.find((x) => x.analysisId === xt.id)!;
  const html = storyHtml({ ...s, scenes: s.scenes.map((x) => (x.id === sc.id ? { ...x, chart: { type: "scatter" as const } } : x)) }, { results });
  assert.match(html, /scatter chart is not drawn in the animated story, so the result is shown as a table/);
});

test("text from people and models is escaped; unsafe colours, logos and audio are refused", () => {
  const s = story();
  const evil: StoryDefinition = { ...s, title: `<img src=x onerror=alert(1)>`, accent: `red;}</style><script>alert(1)</script>`, logoUrl: `javascript:alert(1)`, scenes: s.scenes.map((x, i) => (i === 1 ? { ...x, text: `</div><script>alert(2)</script>"'` } : x)) };
  const html = storyHtml(evil, { results, audio: { [s.scenes[0].id]: `data:audio/mpeg;base64,AAAA" onerror="alert(3)` } });
  assert.ok(!/<img src=x/.test(html) && !/<script>alert/.test(html) && !/javascript:/.test(html) && !/onerror="alert/.test(html));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /--accent:#2563eb/, "a bad colour falls back to the default");
  assert.ok(!html.includes("<audio"), "a malformed audio URL is not embedded");
  assert.equal(esc(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
});

test("narration audio is embedded only where it exists, and the player advances by audio when there is some", () => {
  const s = story();
  const html = storyHtml(s, { results, audio: { [s.scenes[2].id]: "data:audio/mpeg;base64,AAAA" } });
  assert.equal([...html.matchAll(/<audio /g)].length, 1);
  assert.match(html, /A=true/);
  assert.match(storyHtml(s, { results }), /A=false/);
});

test("interpretation scenes are labelled as not findings, and a scene whose analysis has no result says so", () => {
  const s: StoryDefinition = { ...story(), scenes: [...story().scenes, { id: "i1", type: "interpretation", title: "What this may mean", text: "Satisfaction may differ by gender.", narration: "x", nature: "interpretation", source: "model", durationMs: 5000 }, { id: "g1", type: "finding", title: "Gone", text: "t", narration: "t", nature: "finding", source: "engine", durationMs: 5000, analysisId: "deleted", chart: { type: "bar_vertical" } }] };
  const html = storyHtml(s, { results });
  assert.match(html, /Interpretation<span class="tag">not a finding<\/span>/);
  assert.match(html, /This analysis has no results to draw \(it was not computed\)/);
});

test("durations are bounded and autoplay is opt-in", () => {
  const s = story();
  const html = storyHtml({ ...s, scenes: s.scenes.map((x, i) => (i === 0 ? { ...x, durationMs: 1 } : i === 1 ? { ...x, durationMs: 9e9 } : x)) }, { results });
  const d = JSON.parse(/D=(\[[^\]]*\])/.exec(html)![1]) as number[];
  assert.equal(d[0], 2000); assert.equal(d[1], 60000);
  assert.ok(!/show\(0\);toggle\(\)/.test(html));
  assert.match(storyHtml(s, { results, autoplay: true }), /show\(0\);toggle\(\)/);
});
