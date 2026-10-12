import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, variableMetadata } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";
import { isSignificant, draftReport, usability, rankItems, regenerateScene, gateInterpretation, resultNumbers, sampleSentence, testLine, type BuilderItem, type ReportBrief } from "./reportBuilder.js";
import { reportAnalysisIds, checkSnapshot } from "./blockRefs.js";
import type { AnalysisDefinition } from "./types.js";
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
const consider = item("Brands considered", "descriptive", ["CONSIDER"]);
const region = item("Region", "descriptive", ["REGION"]);
const satGender = item("Satisfaction by gender", "crosstab", [], { rows: ["SAT"], columns: ["GENDER"], measure: "pct_col" });
const tGender = item("Satisfaction gap by gender", "test", ["SAT", "GENDER"], { options: { test: "auto" } });
const all = [sat, consider, region, satGender, tGender];
const brief = (b: Partial<ReportBrief> = {}): ReportBrief => ({ objective: "Understand satisfaction and which brands people consider", audience: "client", tone: "plain", keyQuestions: [], ...b });
const blocksOf = (d: ReturnType<typeof draftReport>, type: string) => d.report.blocks.filter((b) => b.type === type);

test("every sentence and number in the draft comes from the results", () => {
  const d = draftReport(brief({ keyQuestions: ["How satisfied are customers?"] }), all, vars);
  const numbers = resultNumbers(all);
  const exec = blocksOf(d, "executive_summary")[0] as { text?: string };
  for (const m of (exec.text ?? "").match(/-?\d+(?:\.\d+)?/g) ?? []) assert.ok(numbers.has(m.replace(/(\.\d*?)0+$/, "$1")) || Number(m) <= 10, `${m} is in no result`);
  for (const c of blocksOf(d, "chart") as { caption?: string }[]) for (const m of (c.caption ?? "").match(/-?\d+(?:\.\d+)?/g) ?? []) assert.ok(numbers.has(m) || Number(m) <= 10, `caption number ${m} is in no result`);
  assert.match(exec.text ?? "", /400 respondents/);
});

test("the key question lifts the analysis that answers it, and the question nothing answers is reported", () => {
  const d = draftReport(brief({ keyQuestions: ["How satisfied are customers overall?", "What is the average delivery time?"] }), all, vars);
  const keyed = d.included.filter((i) => i.role === "key").map((i) => i.name).sort();
  assert.deepEqual(keyed, ["Overall satisfaction", "Satisfaction by gender", "Satisfaction gap by gender"], "everything that reads satisfaction answers the question");
  assert.ok(d.included.slice(0, 3).every((i) => i.role === "key"), "and they come first");
  assert.ok(!d.included.find((i) => i.name === "Region")!.answers.length);
  assert.deepEqual(d.uncovered, ["What is the average delivery time?"]);
  assert.ok(d.notes.some((x) => /No saved analysis answers/.test(x) && /delivery time/.test(x)));
});

test("charts follow the question: multiple-choice is horizontal bars with its denominator, never a pie", () => {
  const d = draftReport(brief(), all, vars);
  const c = d.included.find((i) => i.name === "Brands considered")!;
  assert.equal(c.chart, "bar_horizontal");
  assert.match(c.denominator, /several answers were allowed/);
  const chart = (blocksOf(d, "chart") as { title?: string; caption?: string; chart: { type: string } }[]).find((b) => b.title === "Brands considered")!;
  assert.match(chart.caption ?? "", /more than 100%/);
});

test("analyses that cannot be shown are left out with the reason — failed, empty, repeated", () => {
  const failed: BuilderItem = { id: "f1", name: "Broken", definition: { name: "Broken", kind: "descriptive", dataset: spec, variables: ["NOPE"] } as AnalysisDefinition, result: { ...sat.result, name: "Broken", error: { code: "not_computable", message: "NOPE is not in this survey's data." } } };
  const empty: BuilderItem = { id: "e1", name: "Nobody", definition: { ...region.definition, name: "Nobody", variables: ["COUNTRY"] }, result: { ...region.result, base: { total: 400, filtered: 0, n: 0, weightedN: 0, label: "x" } } };
  const dupe: BuilderItem = { ...sat, id: "d1", name: "Satisfaction again", definition: { ...sat.definition, name: "Satisfaction again" } };
  const { usable, skipped } = usability([sat, failed, empty, dupe]);
  assert.deepEqual(usable.map((u) => u.id), [sat.id]);
  assert.equal(skipped.length, 3);
  assert.match(skipped.find((s) => s.id === "f1")!.reason, /NOPE/);
  assert.match(skipped.find((s) => s.id === "e1")!.reason, /No respondent/);
  assert.match(skipped.find((s) => s.id === "d1")!.reason, /exactly what “Overall satisfaction”/);
});

test("scope: tests and crosstabs can be left out, an analysis list restricts, the audience caps the length", () => {
  const noTests = draftReport(brief({ includeTests: false }), all, vars);
  assert.ok(!noTests.included.some((i) => i.name === "Satisfaction gap by gender"));
  assert.ok(noTests.skipped.some((s) => /Significance tests were left out/.test(s.reason)));
  const only = draftReport(brief({ analysisIds: [sat.id, region.id] }), all, vars);
  assert.deepEqual(only.included.map((i) => i.id).sort(), [sat.id, region.id].sort());
  const capped = draftReport(brief({ maxItems: 2 }), all, vars);
  assert.equal(capped.included.length, 2);
  assert.equal(capped.skipped.filter((s) => /Left out to keep the report to 2/.test(s.reason)).length, 3);
});

test("the report only points at analyses that exist, and its story reads the same ones", () => {
  const d = draftReport(brief({ keyQuestions: ["How satisfied?"] }), all, vars, { story: true });
  const ids = new Set(all.map((a) => a.id));
  for (const id of reportAnalysisIds(d.report)) assert.ok(ids.has(id), `${id} is not a saved analysis`);
  assert.ok(d.story && d.report.story === d.story);
  for (const s of d.story!.scenes) if (s.analysisId) assert.ok(ids.has(s.analysisId));
  /* a snapshot missing an analysis the story reads is caught by the publish check */
  const only = reportAnalysisIds({ story: { scenes: [{ analysisId: "x1" }] } });
  assert.deepEqual(only, ["x1"]);
  assert.equal(checkSnapshot({ story: { scenes: [{ analysisId: "x1" }] } }, {}).ok, false);
});

test("the story is ordered title → objective → sample → findings → summary, and findings are never mixed with interpretation", () => {
  const d = draftReport(brief({ keyQuestions: ["How satisfied?"] }), all, vars, { story: true });
  const types = d.story!.scenes.map((s) => s.type);
  assert.equal(types[0], "title"); assert.equal(types[1], "objective"); assert.equal(types[2], "sample"); assert.equal(types[types.length - 1], "summary");
  assert.ok(types.includes("finding") && types.includes("comparison") && types.includes("difference"));
  assert.ok(!types.includes("interpretation"), "no model, no interpretation — nothing is invented to fill the slot");
  for (const s of d.story!.scenes) assert.ok(s.nature !== "interpretation" || s.source === "model");
  const diff = d.story!.scenes.find((s) => s.type === "difference")!;
  assert.match(diff.text, /Welch|χ²|p < \.001|p = /);
});

test("interpretation from a model passes the number gate or is dropped with the reason", () => {
  const g = gateInterpretation(all, { implications: ["Satisfaction may differ by gender (Cohen's d = -1.01), which suggests gender-specific follow-up.", "Satisfaction rose by 37% last quarter.", "Brand Alpha may be the strongest in consideration, at 77.8%."], recommendations: ["Follow up with the 400 respondents on the drivers of the gap."] });
  assert.equal(g.implications.length, 2);
  assert.equal(g.rejected.length, 1);
  assert.match(g.rejected[0].reason, /37%.*not in the run/);
  assert.equal(g.recommendations.length, 1);
  const d = draftReport(brief(), all, vars, { story: true, interpretation: g });
  const interp = d.story!.scenes.filter((s) => s.type === "interpretation");
  assert.ok(interp.length >= 2 && interp.every((s) => s.nature === "interpretation" && s.source === "model"));
  assert.ok(d.report.blocks.some((b) => b.type === "section" && (b as { title: string }).title === "Interpretation"));
  assert.ok(!JSON.stringify(d.report.blocks).includes("37%"));
});

test("regenerating a scene rebuilds it from the analysis as it is now, and keeps a still-valid chart choice", () => {
  const d = draftReport(brief({ keyQuestions: ["How satisfied?"] }), all, vars, { story: true });
  const sc = d.story!.scenes.find((s) => s.analysisId === sat.id)!;
  const edited = { ...d.story!, scenes: d.story!.scenes.map((s) => (s.id === sc.id ? { ...s, text: "Somebody typed this", chart: { type: "bar_horizontal" as const } } : s)) };
  const r = regenerateScene(edited, sc.id, all, vars);
  assert.ok("scene" in r);
  if ("scene" in r) { assert.equal(r.scene.id, sc.id); assert.notEqual(r.scene.text, "Somebody typed this"); assert.match(r.scene.text, /Overall satisfaction/); assert.equal(r.scene.chart?.type, "bar_horizontal"); }
  const gone = regenerateScene(edited, sc.id, all.filter((a) => a.id !== sat.id), vars);
  assert.ok("error" in gone && /deleted/.test(gone.error));
  assert.ok("error" in regenerateScene(edited, "nope", all, vars));
});

test("a small base is flagged, not hidden", () => {
  const small: BuilderItem = { ...sat, id: "s1", name: "Tiny", result: { ...sat.result, base: { ...sat.result.base, n: 12 } } };
  const d = draftReport(brief(), [small], vars);
  assert.ok(d.included[0].notes.some((x) => /Only 12 respondents/.test(x)));
  assert.ok(JSON.stringify(d.report.blocks).includes("only 12 respondents"));
});

test("with nothing usable the report says so instead of showing zeros", () => {
  const d = draftReport(brief({ keyQuestions: ["Anything?"] }), [], vars);
  assert.equal(d.included.length, 0);
  assert.deepEqual(d.report.blocks.map((b) => b.type), ["cover"]);
  assert.ok(d.notes.some((x) => /None of the saved analyses/.test(x)));
  assert.deepEqual(d.uncovered, ["Anything?"]);
});

test("sample sentence and test line are built from the printed numbers", () => {
  assert.equal(sampleSentence([sat]), "400 respondents in the selected data; 400 answered the questions shown.");
  assert.match(testLine(tGender.result) ?? "", /p < \.001/);
  assert.equal(rankItems([], vars, brief()).ranked.length, 0);
});

test("the story is told findings → comparisons → differences, but an audience's limit keeps the best-ranked analyses, and the summary only cites scenes that are in it", () => {
  const many = [sat, consider, region, satGender, tGender, item("Gender", "descriptive", ["GENDER"]), item("Age", "descriptive", ["AGE"]), item("Country", "descriptive", ["COUNTRY"]), item("NPS", "descriptive", ["NPS"])];
  const d = draftReport(brief({ audience: "executive", keyQuestions: ["How satisfied are customers?"] }), many, vars, { story: true });
  const sc = d.story!.scenes;
  assert.ok(sc.length <= 9, `an executive story is short: ${sc.length}`);
  const kinds = sc.filter((s) => s.analysisId).map((s) => s.type);
  const order = { finding: 0, comparison: 1, difference: 2 } as Record<string, number>;
  assert.deepEqual(kinds, [...kinds].sort((a, b) => order[a] - order[b]), "told in story order");
  const names = sc.filter((s) => s.analysisId).map((s) => s.title);
  for (const keyed of ["Overall satisfaction", "Satisfaction by gender", "Satisfaction gap by gender"]) assert.ok(names.includes(keyed), `${keyed} answers the key question, so it survives the limit`);
  const summary = sc[sc.length - 1];
  assert.equal(summary.type, "summary");
  for (const m of many) if (!names.includes(m.name) && m.result.insights[0]) assert.ok(!summary.text.includes(m.result.insights[0]), `“${m.name}” is not in the story, so the summary must not cite it`);
  assert.ok(summary.text.includes(sat.result.insights[0]), "and it does cite one that is");
});

test("key-question matching: variable names and shared content words match; a generic word alone does not", () => {
  const match = (q: string) => rankItems(all, vars, brief({ keyQuestions: [q] })).ranked.filter((r) => r.answers.length).map((r) => r.item.name).sort();
  assert.deepEqual(match("How satisfied are customers?"), ["Overall satisfaction", "Satisfaction by gender", "Satisfaction gap by gender"]);
  assert.deepEqual(match("Which brands do people consider?"), ["Brands considered"]);
  assert.deepEqual(match("What does REGION look like?"), ["Region"], "a variable named in the question matches by name");
  assert.deepEqual(match("How do customers feel about us?"), [], "'customers' alone is not about anything saved");
  assert.deepEqual(match("How do customers rate our brand awareness and loyalty?"), [], "one shared word out of five content words is not enough");
  assert.deepEqual(match("What is the average delivery time?"), []);
});

test("a keyed analysis outranks a significant one that nothing asked for, and the scope switches really exclude", () => {
  const d = draftReport(brief({ keyQuestions: ["Which brands do people consider?"] }), all, vars);
  const order = d.included.map((i) => i.name);
  assert.ok(order.indexOf("Brands considered") < order.indexOf("Satisfaction by gender"), `the question's own analysis comes first: ${order.join(" > ")}`);
  const noX = draftReport(brief({ includeCrosstabs: false }), all, vars);
  assert.ok(!noX.included.some((i) => i.name === "Satisfaction by gender"));
  assert.ok(noX.skipped.some((s) => /Cross-tabulations were left out/.test(s.reason)));
  assert.ok(noX.included.some((i) => i.name === "Satisfaction gap by gender"), "tests stay when only cross-tabs are excluded");
});

test("the story's summary cites only analyses that are in the story", () => {
  const sig = item("Satisfaction by country", "crosstab", [], { rows: ["SAT"], columns: ["COUNTRY"], measure: "pct_col" });
  const pool = [consider, satGender, tGender, sig, sat];
  /* three interpretation scenes leave room for only two analyses in an executive story */
  const interp = gateInterpretation(pool, { implications: ["Brand consideration may be uneven.", "Satisfaction may vary by country.", "Gender may matter for satisfaction."] });
  assert.equal(interp.implications.length, 3);
  const d = draftReport(brief({ audience: "executive", keyQuestions: ["Which brands do people consider?"] }), pool, vars, { story: true, interpretation: interp });
  const inStory = new Set(d.story!.scenes.filter((s) => s.analysisId).map((s) => s.title));
  const summary = d.story!.scenes[d.story!.scenes.length - 1].text;
  assert.equal(inStory.size, 2, `room for two: ${[...inStory]}`);
  assert.ok(inStory.has("Brands considered"), "the key question's analysis is one of them");
  const left = pool.filter((m) => !inStory.has(m.name) && (isSignificant(m.result) || false));
  assert.ok(left.length >= 1, "a significant analysis was left out of the story");
  for (const m of left) assert.ok(!summary.includes(m.result.insights[0]), `${m.name} is not in the story, so the summary must not cite it`);
});
