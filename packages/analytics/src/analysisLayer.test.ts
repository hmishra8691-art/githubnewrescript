import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildDataset, type AnalyticsRow } from "./dataset.js";
import { applyLayer, layerName, normalizeLayer, parseBands, nonSubstantiveCodes, DEFAULT_AGE_BANDS, type LayerVariable } from "./analysisLayer.js";
import { runAnalysis } from "./analyses/index.js";

import { kdef, krows, kds } from "./analyses/knownFixture.js";

test("bands: a number into groups, every respondent counted once, out-of-band answers reported, the input untouched", () => {
  const ds = kds();
  const v: LayerVariable = { label: "Age group", kind: "group_numeric", from: ["AGE"], bins: DEFAULT_AGE_BANDS };
  const r = applyLayer(ds, [v]);
  const name = layerName(v);
  const rep = r.reports[0]!;
  assert.equal(rep.refused, false);
  assert.equal(rep.eligible, 12);
  assert.equal(rep.missing, 1, "one respondent has no age");
  assert.deepEqual(rep.invalid, [{ value: "17", n: 1 }], "17 fits no default band — reported, not forced");
  assert.equal(rep.populated, 10);
  const n = (label: string) => rep.categories!.find((c) => c.label === label)!.n;
  assert.deepEqual([n("18–24"), n("25–34"), n("35–44"), n("45–54"), n("55–64"), n("65+")], [2, 2, 2, 2, 1, 1]);
  assert.ok(rep.checks.some((c) => /add up to the 10/.test(c)) && rep.checks.some((c) => /10 populated \+ 1 without an answer \+ 1 not covered = 12/.test(c)));
  assert.equal(r.dataset.cases[0]!.vars[name], "1");
  assert.equal(ds.byName.has(name), false, "the source dataset gains nothing");
  assert.equal(ds.cases[0]!.vars[name], undefined, "and its cases are not mutated");
});

test("codes into groups: single to single; a multi-select maps to a multi-select; a code in two groups of a single is refused", () => {
  const ds = kds();
  const reg: LayerVariable = { label: "North vs rest", kind: "map_codes", from: ["REGION"], groups: [{ label: "North", codes: ["1"] }, { label: "South & East", codes: ["2", "3"] }] };
  const r = applyLayer(ds, [reg]);
  assert.deepEqual(r.reports[0]!.categories!.map((c) => c.n), [4, 8]);
  const aw: LayerVariable = { label: "Aware of Alpha or Beta", kind: "map_codes", from: ["AWARE"], groups: [{ label: "Alpha/Beta", codes: ["1", "2"] }, { label: "Gamma", codes: ["3"] }] };
  const ra = applyLayer(ds, [aw]);
  const rep = ra.reports[0]!;
  assert.equal(rep.role, "multi");
  assert.deepEqual(rep.categories!.map((c) => c.n), [9, 4], "Alpha or Beta: 9 respondents (counted once each); Gamma: 4");
  assert.equal(rep.populated, 10, "the two with no brand stay without a value");
  assert.deepEqual(ra.dataset.cases[6]!.vars[layerName(aw)], ["1", "2"]);
  const clash = applyLayer(ds, [{ label: "x", kind: "map_codes", from: ["REGION"], groups: [{ label: "A", codes: ["1"] }, { label: "B", codes: ["1", "2"] }] }]);
  assert.equal(clash.reports[0]!.refused, true);
  assert.match(clash.problems[0]!, /mapped to two groups/);
});

test("NPS classes: 0–6 / 7–8 / 9–10 for every respondent, a 1–5 scale refused", () => {
  const ds = kds();
  const v: LayerVariable = { label: "NPS group", kind: "nps_class", from: ["NPS"] };
  const rep = applyLayer(ds, [v]).reports[0]!;
  assert.deepEqual(rep.categories!.map((c) => [c.label, c.n]), [["Detractors (0–6)", 3], ["Passives (7–8)", 3], ["Promoters (9–10)", 5]]);
  assert.equal(rep.missing, 1);
  const bad = applyLayer(ds, [{ label: "x", kind: "nps_class", from: ["AGE"] }]);
  assert.equal(bad.reports[0]!.refused, true, "ages are outside 0–10");
});

test("top-2 box: on the ordered scale only — “Don't know” (9) is not part of the scale", () => {
  const ds = kds();
  /* SAT's code frame includes 9 = Don't know; a box must be computed on 1–5, so the frame is first cleaned by the planner — here, by mapping */
  const t2b: LayerVariable = { label: "Satisfied (T2B)", kind: "map_codes", from: ["SAT"], groups: [{ label: "Top 2 box", codes: ["4", "5"] }, { label: "Other", codes: ["1", "2", "3"] }] };
  const rep = applyLayer(ds, [t2b]).reports[0]!;
  assert.deepEqual(rep.categories!.map((c) => c.n), [5, 4]);
  assert.deepEqual(rep.invalid, [{ value: "9", n: 2 }], "the two Don't knows fit no group and are reported");
  assert.deepEqual(nonSubstantiveCodes([{ code: "9", label: "Don't know" }, { code: "1", label: "1" }, { code: "8", label: "Prefer not to say" }]), ["9", "8"]);
});

test("flags, filters and dependencies: a layer variable can read another; a filter can keep by a layer variable", () => {
  const ds = kds();
  const awareAlpha: LayerVariable = { label: "Aware of Alpha", kind: "flag", from: ["AWARE"], codes: ["1"] };
  const nameA = layerName(awareAlpha);
  const r = applyLayer(ds, [awareAlpha], [{ variable: nameA, keep: ["1"], label: "Aware of Alpha" }]);
  assert.equal(r.reports[0]!.categories!.find((c) => c.code === "1")!.n, 6);
  assert.deepEqual(r.filtered, [{ label: "Aware of Alpha", before: 12, after: 6 }]);
  const dk = applyLayer(ds, [], [{ variable: "SAT", drop: ["9"], label: "excluding Don't know" }]);
  assert.equal(dk.dataset.cases.length, 10);
  /* a chain: age bands, then the bands grouped again */
  const bands: LayerVariable = { label: "Age group", kind: "group_numeric", from: ["AGE"], bins: [{ label: "Under 35", max: 34 }, { label: "35+", min: 35 }] };
  const chain: LayerVariable = { label: "Under 35 flag", kind: "flag", from: [layerName(bands)], codes: ["1"] };
  const rc = applyLayer(ds, [chain, bands]);
  assert.deepEqual(rc.reports.map((x) => x.label), ["Age group", "Under 35 flag"], "computed in dependency order whatever the order given");
  assert.equal(rc.reports[1]!.categories!.find((c) => c.code === "1")!.n, 5);
});

test("one definition, one variable: the same instruction twice does not make two; the name is stable", () => {
  const a: LayerVariable = { label: "Age group", kind: "group_numeric", from: ["AGE"], bins: DEFAULT_AGE_BANDS };
  const b: LayerVariable = { label: "Age bands (again)", kind: "group_numeric", from: ["AGE"], bins: DEFAULT_AGE_BANDS };
  assert.equal(layerName(a), layerName(b), "the label does not change what is computed");
  assert.equal(normalizeLayer([a, b]).length, 1);
  assert.notEqual(layerName(a), layerName({ ...a, bins: DEFAULT_AGE_BANDS.slice(1) }));
  assert.match(layerName(a), /^_L_group_numeric_AGE_[0-9a-z]{6}$/);
});

test("refusals: unknown source, overlapping bands, a box on too short a scale — each with the reason", () => {
  const ds = kds();
  const r = applyLayer(ds, [
    { label: "x", kind: "group_numeric", from: ["NOPE"], bins: DEFAULT_AGE_BANDS },
    { label: "y", kind: "group_numeric", from: ["AGE"], bins: [{ label: "a", min: 18, max: 40 }, { label: "b", min: 35, max: 60 }] },
    { label: "z", kind: "box", from: ["GENDER"], side: "top", size: 2 },
  ]);
  assert.match(r.problems.join("\n"), /NOPE is not a variable/);
  assert.match(r.problems.join("\n"), /overlap/);
  assert.match(r.problems.join("\n"), /ordered scale of at least three points/);
  assert.equal(r.reports.every((x) => x.refused), true);
});

test("bands from words", () => {
  assert.deepEqual(parseBands("age groups 18-34, 35–54 and 55+"), [{ label: "18–34", min: 18, max: 34 }, { label: "35–54", min: 35, max: 54 }, { label: "55+", min: 55 }]);
  assert.deepEqual(parseBands("under 25, 25 to 44, 45 and over"), [{ label: "Under 25", max: 24 }, { label: "25–44", min: 25, max: 44 }, { label: "45+", min: 45 }]);
  assert.equal(parseBands("by age group"), null);
});

test("an analysis carries its layer: computed on the run, reported on the result, raw data untouched", () => {
  const ds = kds();
  const bands: LayerVariable = { label: "Age group", kind: "group_numeric", from: ["AGE"], bins: [{ label: "Under 35", max: 34 }, { label: "35+", min: 35 }] };
  const col = layerName(bands);
  const res = runAnalysis({ name: "SAT by age group", kind: "crosstab", dataset: { environment: "LIVE", dataset: "all" }, variables: ["GENDER", col], rows: ["GENDER"], columns: [col], measure: "pct_col", options: { layer: [bands] } }, ds);
  assert.equal(res.error, undefined, res.warnings.join(" "));
  assert.equal(res.layer?.reports[0]?.populated, 11);
  assert.ok(res.tables.length > 0);
  assert.equal(ds.byName.has(col), false);
});
