import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { answeredN } from "./common.js";
import type { AnalysisDefinition } from "../types.js";
import { def, rule, synthRows } from "./fixture.js";

/*
 * ONE BASE PER SCREEN (audit 2026-10-16, ANALYTICS-02 / -03 / -13).
 *
 * The result header prints the answered base; the topbox / CSAT / ranking /
 * allocation table footers printed the number of cases, and a segment's n
 * was the cases in the segment. Same screen, two bases. Every number below
 * is checked against the one the header shows.
 */
const spec = { environment: "LIVE" as const, dataset: "all" as const };
const D = (kind: AnalysisDefinition["kind"], variables: string[], extra: Partial<AnalysisDefinition> = {}): AnalysisDefinition => ({ name: kind, kind, dataset: spec, variables, ...extra });
/** every fourth respondent skips SAT, every fifth skips the ranking and the allocation */
const rows = synthRows(200).map((r, i) => ({ ...r, answers: { ...r.answers, ...(i % 4 === 0 ? { q_sat: null } : {}), ...(i % 5 === 0 ? { q_rank: null, q_alloc: null } : {}) } }));
const ds = buildDataset(def, rows, { spec });

test("ANALYTICS-02: topbox, CSAT, ranking and allocation tables carry the answered base the header shows", () => {
  const top = runAnalysis(D("topbox", ["SAT"]), ds);
  assert.equal(top.base.n, 150, "header: 150 of 200 answered SAT");
  assert.equal(top.tables[0].base?.n, top.base.n, "topbox footer = header");
  assert.equal(top.tables[0].rows[0].n, 150, "the item's own n agrees");

  const cs = runAnalysis(D("csat", ["SAT"]), ds);
  assert.equal(cs.tables[0].base?.n, cs.base.n);
  assert.equal(cs.base.n, 150);

  const rk = runAnalysis(D("ranking", ["RANK"]), ds);
  assert.equal(rk.base.n, 160, "header: 160 of 200 ranked");
  assert.equal(rk.tables[0].base?.n, rk.base.n, "ranking footer = header");

  const al = runAnalysis(D("allocation", ["ALLOC"]), ds);
  assert.equal(al.base.n, 160);
  assert.equal(al.tables[0].base?.n, al.base.n, "allocation footer = header");
});

test("ANALYTICS-02: a weighted table footer carries the answered weighted n, not the dataset's", () => {
  const w = buildDataset(def, rows, { spec, weighting: { variable: "AGE" } });
  const top = runAnalysis(D("topbox", ["SAT"]), w);
  assert.equal(top.tables[0].base?.n, top.base.n);
  assert.equal(top.tables[0].base?.weightedN, top.base.weightedN, "weighted footer = weighted header");
  const a = answeredN(w, ["SAT"]);
  assert.equal(a.n, 150);
  assert.ok(a.weightedN !== w.cases.reduce((t, c) => t + c.weight, 0), "the answered weighted n is not the whole dataset's");
});

test("ANALYTICS-03: a segment's n is the respondents in the segment who answered, and the thin-base warning uses it", () => {
  const segs = [{ id: "w", name: "Women", condition: rule("q_gender", 2) }];
  const women = ds.cases.filter((c) => String(c.vars.GENDER) === "2");
  const answered = women.filter((c) => c.vars.SAT != null).length;
  assert.ok(answered < women.length, "the fixture has women who skipped SAT");
  const d = runAnalysis(D("descriptive", ["SAT"], { segments: segs }), ds);
  assert.equal(d.segments?.[0].n, answered, "descriptive segment n = answered, not cases");
  const t = runAnalysis(D("topbox", ["SAT"], { segments: segs }), ds);
  assert.equal(t.segments?.[0].n, answered, "topbox segment n = answered");
  const small = buildDataset(def, rows.slice(0, 60), { spec });
  const thin = runAnalysis(D("descriptive", ["SAT"], { segments: segs }), small);
  const n = thin.segments![0].n;
  assert.ok(n < 30);
  assert.ok(thin.warnings.some((w) => w.includes(`Women (n = ${n})`)), `the warning names the answered n: ${thin.warnings.join(" | ")}`);
});

test("ANALYTICS-13: a layered crosstab's header n is the respondents in some layer's Total column, not anyone who answered any variable", () => {
  const plain = runAnalysis(D("crosstab", ["SAT", "GENDER"], { rows: ["SAT"], columns: ["GENDER"] }), ds);
  assert.equal(plain.base.n, plain.tables[0].base?.n, "no layer: header = Total column");
  const layered = runAnalysis(D("crosstab", ["SAT", "GENDER"], { rows: ["SAT"], columns: ["GENDER"], layers: ["REGION"] }), ds);
  const layerTotals = layered.tables.reduce((t, x) => t + (x.base?.n ?? 0), 0);
  assert.equal(layered.tables.length, 3, "one table per region");
  assert.equal(layered.base.n, layerTotals, "header = the layer tables' Total columns together (single-select layer)");
  assert.equal(layered.base.n, 150, "which is the 150 who answered SAT (everyone answered GENDER and REGION)");
  /* a respondent who skipped the row variable is in no Total column, so not in the header — the old header counted them (answered GENDER) */
  assert.ok(layered.base.n < ds.cases.length);
});
