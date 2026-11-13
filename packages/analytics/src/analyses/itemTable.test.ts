import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, type Dataset, type VariableMeta, type Case } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { isNpsFrame, transposeTable } from "./itemTable.js";
import type { AnalysisDefinition } from "../types.js";
import { def, synthRows } from "./fixture.js";

/**
 * THE ITEM TABLE and the NPS rows (2026-11-16): one row per item for a loop or a grid, the loop read by ITEM and not
 * by pass, a banner of one statistic, transposition — and NPS rows added to an ordinary crosstab on their own.
 */
const spec = { environment: "LIVE" as const, dataset: "all" as const };
const XT = (extra: Partial<AnalysisDefinition>, options: Record<string, unknown> = {}): AnalysisDefinition => ({ name: "t", kind: "crosstab", dataset: spec, variables: [], ...extra, options });

/* a hand-made loop: three brands, two passes per respondent, the brand of each pass recorded */
const SCALE = Array.from({ length: 11 }, (_, i) => ({ code: String(i), label: String(i) }));
const BRANDS = [{ code: "1", label: "Nike" }, { code: "2", label: "Adidas" }, { code: "3", label: "Puma" }];
const meta = (m: Partial<VariableMeta> & { name: string; label: string }): VariableMeta => ({ role: "scale", derived: false, hidden: false, ...m } as VariableMeta);
const variables: VariableMeta[] = [
  meta({ name: "SEG", label: "Segment", role: "categorical", categories: [{ code: "1", label: "Premium" }, { code: "2", label: "Value" }] }),
  ...[1, 2].flatMap((p) => [
    meta({ name: `REC_${p}`, label: `Q7 — Recommend (brand ${p})`, questionId: "q7", questionCode: "Q7", questionType: "nps", nps: true, categories: SCALE, loopId: "L1", loopVar: "brand", iteration: p }),
    meta({ name: `LOOP_BRAND_ITEM_${p}_CODE`, label: `Loop "brand" — item ${p} code`, role: "categorical", categories: BRANDS, loopId: "L1", loopVar: "brand", iteration: p, derived: true, hidden: true }),
  ]),
];
/* [segment, brand of pass 1, score, brand of pass 2, score] */
const RAW: [number, number, number, number, number][] = [
  [1, 1, 10, 2, 3], [1, 2, 9, 1, 9], [1, 1, 9, 3, 8], [2, 3, 2, 1, 6], [2, 2, 5, 3, 10], [2, 1, 0, 2, 9],
];
const cases: Case[] = RAW.map(([seg, b1, s1, b2, s2], i) => ({ id: `c${i}`, code: null, status: "complete", environment: "LIVE", startedAt: null, completedAt: null, durationSec: null, quality: null, weight: 1,
  vars: { SEG: seg, REC_1: s1, LOOP_BRAND_ITEM_1_CODE: String(b1), REC_2: s2, LOOP_BRAND_ITEM_2_CODE: String(b2) }, answers: {}, calculated: {} } as unknown as Case));
const loopDs = { def, variables, byName: new Map(variables.map((v) => [v.name, v])), cases, total: cases.length, weighted: false, weightInfo: null, spec } as unknown as Dataset;
const rowOf = (t: { rows: Record<string, unknown>[] }, label: string) => t.rows.find((r) => r.row === label)!;

test("a loop is read by item, not by pass: one row per brand, each answer under the brand it was about", () => {
  const r = runAnalysis(XT({ rows: ["REC_1", "REC_2"] }, { layout: "items" }), loopDs);
  const t = r.tables[0];
  assert.equal(r.tables.length, 1, "one table for the whole loop");
  assert.deepEqual(t.rows.map((x) => x.row), ["Nike", "Adidas", "Puma"]);
  /* Nike was rated 10, 9, 9, 6, 0 — in pass 1 by three people and in pass 2 by two */
  const nike = rowOf(t, "Nike");
  assert.equal(nike.base, 5);
  assert.equal(nike.promoters, 60); assert.equal(nike.passives, 0); assert.equal(nike.detractors, 40);
  assert.equal(nike.nps, 20, "NPS = 60 − 40");
  assert.equal(nike.mean, 6.8);
  /* Adidas: 3, 9, 5, 9 → 50 − 50 = 0; Puma: 8, 2, 10 → 33.3 − 33.3 = 0 */
  assert.equal(rowOf(t, "Adidas").base, 4); assert.equal(rowOf(t, "Adidas").nps, 0);
  assert.equal(rowOf(t, "Puma").base, 3); assert.equal(rowOf(t, "Puma").nps, 0);
  assert.deepEqual(t.columns.map((c) => c.key), ["row", "base", "promoters", "passives", "detractors", "nps", "mean"], "a 0–10 scale gets NPS and the mean without being asked");
  assert.ok(t.notes!.some((n) => /read by item/.test(n)));
  assert.ok(t.notes!.some((n) => /no significance letters/.test(n)));
});

test("with a banner the table shows one statistic per column: NPS by brand × segment", () => {
  const r = runAnalysis(XT({ rows: ["REC_1", "REC_2"], columns: ["SEG"] }, { layout: "items" }), loopDs);
  const t = r.tables[0];
  assert.deepEqual(t.columns.map((c) => c.key), ["row", "__total", "SEG::1", "SEG::2"]);
  const nike = rowOf(t, "Nike");
  assert.equal(nike.__total, 20);
  assert.equal(nike["SEG::1"], 100, "Premium rated Nike 10, 9, 9");
  assert.equal(nike["SEG::1__n"], 3);
  assert.equal(nike["SEG::2"], -100, "Value rated Nike 6 and 0");
  assert.match(t.title, /^NPS — .*by Segment/);
  const mean = runAnalysis(XT({ rows: ["REC_1", "REC_2"], columns: ["SEG"] }, { layout: "items", itemStat: "mean" }), loopDs).tables[0];
  assert.equal(rowOf(mean, "Nike")["SEG::1"], 9.33);
});

test("sorting, the minimum base and transposition", () => {
  const sorted = runAnalysis(XT({ rows: ["REC_1", "REC_2"] }, { layout: "items", sortRows: "asc", itemStats: ["mean"] }), loopDs).tables[0];
  assert.deepEqual(sorted.rows.map((x) => x.row), ["Adidas", "Puma", "Nike"], "6.5, 6.67, 6.8");
  const small = runAnalysis(XT({ rows: ["REC_1", "REC_2"] }, { layout: "items", minBase: 4 }), loopDs).tables[0];
  assert.equal(rowOf(small, "Puma").nps, null, "three respondents is under the minimum of four");
  assert.equal(rowOf(small, "Puma").base, 3, "the base is still shown");
  const flipped = runAnalysis(XT({ rows: ["REC_1", "REC_2"] }, { layout: "items", transpose: true }), loopDs).tables[0];
  assert.deepEqual(flipped.columns.map((c) => c.label), ["Item", "Nike", "Adidas", "Puma"]);
  const npsRow = flipped.rows.find((x) => x.row === "NPS: NPS")!;
  assert.deepEqual([npsRow.r0, npsRow.r1, npsRow.r2], [20, 0, 0]);
  assert.equal(flipped.rows.find((x) => x.row === "Base (n)")!.__format, "count");
  assert.equal(flipped.rows.find((x) => x.row === "NPS: Promoters (9–10)")!.__format, "pct");
});

test("a grid's statements make one table: one row per statement with its answers, mean and top-2 box", () => {
  const ds = buildDataset(def, synthRows(), { spec });
  const items = ds.variables.filter((v) => v.questionId === "q_items" && v.rowCode != null).map((v) => v.name);
  assert.equal(items.length, 3);
  const t = runAnalysis(XT({ rows: items }, { layout: "items" }), ds).tables[0];
  assert.deepEqual(t.rows.map((x) => x.row), ["Quality", "Value", "Service"]);
  assert.ok(t.columns.some((c) => c.key === "mean") && t.columns.some((c) => c.key === "top2"));
  const pctCols = t.columns.filter((c) => c.key.startsWith("c_"));
  assert.ok(pctCols.length >= 3);
  for (const r of t.rows) {
    const sum = pctCols.reduce((s, c) => s + (r[c.key] as number), 0);
    assert.ok(Math.abs(sum - 100) < 0.6, `the answers of ${r.row} add to 100 (${sum})`);
    /* the same mean the ordinary crosstab reports for that statement */
    const name = items[t.rows.indexOf(r)];
    const xt = runAnalysis(XT({ rows: [name], columns: ["GENDER"] }, { summaryRows: ["mean"] }), ds).tables[0];
    assert.equal(r.mean, xt.rows.find((x) => x.row === "Mean")!.__total, `mean of ${r.row} agrees with the crosstab`);
  }
  const banner = runAnalysis(XT({ rows: items, columns: ["GENDER", "REGION"] }, { layout: "items", itemStat: "top2" }), ds).tables[0];
  assert.equal(banner.columns.length, 1 + 1 + 2 + 3);
  assert.match(banner.title, /^Top 2 box % — /);
});

test("questions that share nothing are refused with the way out; unknown statistics are explained", () => {
  const ds = buildDataset(def, synthRows(), { spec });
  const r = runAnalysis(XT({ rows: ["GENDER", "REGION"] }, { layout: "items" }), ds);
  assert.equal(r.tables.length, 0);
  assert.ok(r.warnings.some((w) => /cannot be put in one item table/.test(w)));
  const asked = runAnalysis(XT({ rows: ["SAT"] }, { layout: "items", itemStats: ["nps", "mean"] }), ds);
  assert.ok(asked.warnings.some((w) => /NPS is not shown: it needs 0–10 scales/.test(w)));
  assert.deepEqual(asked.tables[0].columns.map((c) => c.key), ["row", "base", "mean"]);
});

test("an ordinary crosstab of an NPS question carries the NPS rows on its own; a 0–10 scale gets them when asked", () => {
  const ds = buildDataset(def, synthRows(), { spec });
  assert.equal(ds.byName.get("NPS")!.nps, true);
  const t = runAnalysis(XT({ rows: ["NPS"], columns: ["GENDER"] }), ds).tables[0];
  const names = t.rows.map((x) => String(x.row));
  for (const want of ["Promoters (9–10)", "Passives (7–8)", "Detractors (0–6)", "NPS (promoters − detractors)"]) assert.ok(names.includes(want), want);
  const get = (label: string, key: string) => t.rows.find((x) => x.row === label)![key] as number;
  for (const key of ["__total", "1", "2"]) {
    assert.ok(Math.abs(get("NPS (promoters − detractors)", key) - (get("Promoters (9–10)", key) - get("Detractors (0–6)", key))) < 0.11, `NPS = promoters − detractors in ${key}`);
    assert.ok(Math.abs(get("Promoters (9–10)", key) + get("Passives (7–8)", key) + get("Detractors (0–6)", key) - 100) < 0.31);
  }
  /* the same score the item table reports */
  const item = runAnalysis(XT({ rows: ["NPS"] }, { layout: "items" }), ds).tables[0];
  assert.equal(item.rows[0].nps, get("NPS (promoters − detractors)", "__total"));
  const off = runAnalysis(XT({ rows: ["NPS"], columns: ["GENDER"] }, { autoNps: false }), ds).tables[0];
  assert.ok(!off.rows.some((x) => /^NPS/.test(String(x.row))), "autoNps: false leaves the table as it was");
  const notNps = runAnalysis(XT({ rows: ["SAT"], columns: ["GENDER"] }, { summaryRows: ["nps"] }), ds);
  assert.ok(notNps.warnings.some((w) => /NPS needs a 0–10 scale/.test(w)));
  assert.ok(isNpsFrame(SCALE.map((c) => c.code)) && !isNpsFrame(["1", "2", "3", "4", "5"]));
  assert.equal(transposeTable({ id: "x", title: "x", columns: [{ key: "row", label: "Item" }, { key: "a", label: "A", type: "pct" }], rows: [{ row: "One", a: 5 }] }).rows[0].r0, 5);
});
