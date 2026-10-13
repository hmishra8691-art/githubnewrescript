import { test } from "node:test";
import assert from "node:assert/strict";
import { runAnalysis, hashDefinition } from "./analyses/index.js";
import { D, def, synthDataset, spec } from "./analyses/fixture.js";
import { ANALYTICS_ENGINE_VERSION, inputHashOf, isCurrent } from "./provenance.js";
import { canonicalJson, hash64 } from "./canonical.js";
import { runPlan, compactRun, runTiming } from "./findings.js";
import { buildDataset } from "./dataset.js";
import { synthRows } from "./analyses/fixture.js";

/**
 * S-14 — every result records what it was computed from. Each test fails on the code before the change: the hash
 * depended on key order, and a result carried no definition, dataset, data version, engine version or timing.
 */

test("S-14: the definition hash does not depend on key order or on the label", () => {
  const a = D("crosstab", ["SAT", "GENDER"], { rows: ["SAT"], columns: ["GENDER"], options: { layout: "stacked", decimals: 1 }, weighting: { rim: [{ variable: "GENDER", targets: { "1": 50, "2": 50 } }] } });
  const b = { weighting: { rim: [{ targets: { "2": 50, "1": 50 }, variable: "GENDER" }] }, options: { decimals: 1, layout: "stacked" }, columns: ["GENDER"], rows: ["SAT"], variables: ["SAT", "GENDER"], dataset: { dataset: "all", environment: "LIVE" }, kind: "crosstab", name: "another name", notes: "n" } as typeof a;
  assert.equal(hashDefinition(a), hashDefinition(b));
  assert.notEqual(hashDefinition(a), hashDefinition({ ...a, measure: "count" }));
  assert.notEqual(hashDefinition(a), hashDefinition({ ...a, weighting: null }));
  assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: 2 } }), '{"a":{"c":2},"b":1}');
  assert.equal(hash64("x").length, 16);
});

test("S-14: a result carries its definition, dataset, data and engine version, an input hash and how long it took", () => {
  const ds = synthDataset(200); ds.dataVersion = "200:2026-10-12T10:00:00Z"; ds.surveyVersion = "1.0:r7";
  const d = D("descriptive", ["SAT"]);
  const r = runAnalysis(d, ds);
  const p = r.provenance!;
  assert.ok(p, "provenance is set");
  assert.deepEqual(p.definition, JSON.parse(canonicalJson(d)));
  assert.deepEqual(p.dataset, spec); assert.equal(p.dataVersion, "200:2026-10-12T10:00:00Z"); assert.equal(p.surveyVersion, "1.0:r7");
  assert.equal(p.engineVersion, ANALYTICS_ENGINE_VERSION); assert.equal(p.definitionHash, hashDefinition(d)); assert.equal(p.inputHash, inputHashOf(d, { dataVersion: ds.dataVersion, surveyVersion: ds.surveyVersion }));
  assert.ok(p.durationMs >= 0 && Number.isFinite(p.durationMs)); assert.equal(p.computedAt, r.computedAt);
  /* run twice: the same inputs, the same hash */
  assert.equal(runAnalysis(d, ds).provenance!.inputHash, p.inputHash);
  /* a failed result says where it came from too */
  const bad = runAnalysis({ ...d, kind: "nope" as never }, ds);
  assert.ok(bad.error && bad.provenance, "a failure is traceable as well");
});

test("S-14: the input hash moves with anything that changes a number, and with nothing else", () => {
  const d = D("crosstab", ["SAT", "GENDER"], { rows: ["SAT"], columns: ["GENDER"] });
  const inputs = { dataVersion: "400:t1", surveyVersion: "1.0:r1" };
  const base = inputHashOf(d, inputs);
  assert.equal(inputHashOf({ ...d, name: "renamed", notes: "x" }, inputs), base, "a label is not an input");
  assert.notEqual(inputHashOf({ ...d, filter: { type: "rule", source: { kind: "question", ref: "GENDER" }, operator: "eq", value: 1 } as never }, inputs), base, "a filter");
  assert.notEqual(inputHashOf({ ...d, dataset: { environment: "TEST", dataset: "all" } }, inputs), base, "the dataset");
  assert.notEqual(inputHashOf(d, { ...inputs, dataVersion: "401:t2" }), base, "a new response");
  assert.notEqual(inputHashOf(d, { ...inputs, surveyVersion: "1.0:r2" }), base, "the questionnaire changed");
  assert.notEqual(inputHashOf(d, inputs, "2026.09.0"), base, "another engine version");
  /* a stored result is current only while its inputs are */
  const ds = synthDataset(100); ds.dataVersion = "400:t1"; ds.surveyVersion = "1.0:r1";
  const stored = runAnalysis(d, ds);
  assert.equal(isCurrent(stored, d, inputs), true);
  assert.equal(isCurrent(stored, d, { ...inputs, dataVersion: "999:t9" }), false);
  assert.equal(isCurrent({ provenance: { ...stored.provenance!, engineVersion: "old" } }, d, inputs), false);
  assert.equal(isCurrent({}, d, inputs), false, "a result with no record is not known to be current");
});

test("S-14: a run keeps each analysis's provenance and timing after its results are dropped, and says how long it took", () => {
  const ds = buildDataset(def, synthRows(300), { spec }); ds.dataVersion = "300:t";
  const run = runPlan(def, ds, { trigger: "manual", primaries: true, discover: false });
  assert.ok(run.items.length >= 3);
  assert.ok(run.items.every((i) => i.provenance && i.provenance.dataVersion === "300:t" && i.provenance.inputHash.length === 16 && !("definition" in i.provenance)));
  const compact = compactRun(run);
  assert.ok(compact.items.every((i) => !("result" in i) && i.provenance), "the stored run keeps provenance though not the result");
  const t = runTiming(compact);
  assert.equal(t.measured, run.items.length); assert.ok(t.totalMs >= 0); assert.ok(t.slowest.length <= 5);
  assert.deepEqual(t.slowest.map((x) => x.ms), [...t.slowest.map((x) => x.ms)].sort((a, b) => b - a));
});
