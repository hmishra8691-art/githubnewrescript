import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { columnLetter } from "./crosstab.js";
import type { AnalysisDefinition } from "../types.js";
import { def, synthRows } from "./fixture.js";

/**
 * THE CROSSTAB'S OPTIONS, and the audit's fixes (docs/ANALYTICS-AUDIT-2026-09.md).
 * Every option defaults to the old table; each one is proved here to do what
 * its name says, on the synthetic study with planted structure.
 */
const rows = synthRows();
const dsSpec = { environment: "LIVE" as const, dataset: "all" as const };
const ds = buildDataset(def, rows, { spec: dsSpec });
const XT = (extra: Partial<AnalysisDefinition>, options: Record<string, unknown> = {}): AnalysisDefinition => ({ name: "xt", kind: "crosstab", dataset: dsSpec, variables: [], rows: ["SAT"], columns: ["GENDER"], ...extra, options: { ...(extra.options ?? {}), ...options } });
const num = (v: unknown) => v as number;

test("defaults reproduce the classic table: one table per pair, column %, base row, letters, chi-square, valid n", () => {
  const r = runAnalysis(XT({ rows: ["SAT", "REGION"], columns: ["GENDER"] }), ds);
  assert.equal(r.tables.length, 2, "one table per row × column pair");
  assert.deepEqual(r.tables[0].columns.map((c) => c.key), ["row", "__total", "1", "2"]);
  assert.equal(r.tables[0].id, "xt_SAT_GENDER");
  const kinds = r.tables[0].rows.map((x) => x.__kind);
  assert.deepEqual(kinds, ["category", "category", "category", "category", "category", "base"]);
  assert.ok(r.tables[0].rows.some((x) => x.row === "Base (n)"));
  assert.equal(r.tests[0].test, "chi_square");
  // n is the respondents the table is actually based on, filtered is the dataset after the analysis filter
  assert.equal(r.base.n, r.tables[0].base!.n);
  assert.equal(r.base.filtered, 400);
  assert.equal(r.base.total, 400);
  // percentages in a column add to 100 (single response, everyone answered)
  const cats = r.tables[0].rows.filter((x) => x.__kind === "category");
  const sum = cats.reduce((s, x) => s + num(x["1"]), 0);
  assert.ok(Math.abs(sum - 100) < 0.3, `column sums to ${sum}`);
});

test("banner: every column variable side by side, letters run across the banner, tests within each group", () => {
  const r = runAnalysis(XT({ columns: ["GENDER", "REGION"] }, { layout: "banner" }), ds);
  assert.equal(r.tables.length, 1);
  const t = r.tables[0];
  const keys = t.columns.map((c) => c.key);
  assert.ok(keys.includes("GENDER::1") && keys.includes("REGION::1"), "banner keys are qualified by variable");
  assert.equal(t.columns.find((c) => c.key === "GENDER::1")!.group, "Gender");
  assert.equal(t.columns.find((c) => c.key === "REGION::1")!.letter, "c", "letters continue after Gender's a, b");
  // a letter only ever points inside its own group
  for (const row of t.rows.filter((x) => x.__kind === "category")) {
    for (const c of t.columns) {
      const sig = row[`${c.key}__sig`] as string | undefined;
      if (!sig) continue;
      const mine = t.columns.find((x) => x.key === c.key)!;
      for (const l of sig) { const other = t.columns.find((x) => x.letter === l)!; assert.equal(other.group, mine.group, `${c.key} marked ${l} from another group`); }
    }
  }
  assert.equal(r.tests.filter((x) => x.test === "chi_square").length, 2, "one chi-square per column variable");
  assert.equal(t.columnBases!.__total, t.base!.n);
});

test("nested rows: group rows carry the outer category and its bases; inner rows are level 1", () => {
  const r = runAnalysis(XT({ rows: ["REGION", "SAT"] }, { nestRows: true }), ds);
  assert.equal(r.tables.length, 1);
  const t = r.tables[0];
  const groups = t.rows.filter((x) => x.__kind === "group");
  assert.equal(groups.length, 3, "one group per region");
  assert.match(String(groups[0].row), /^Region: /);
  const inner = t.rows.filter((x) => x.__group === groups[0].__key);
  assert.ok(inner.length >= 5 && inner.every((x) => x.__level === 1));
  // the group's Total base is the number of inner respondents
  const innerN = inner.filter((x) => x.__kind === "category").reduce((s, x) => s + num(x.__total__n), 0);
  assert.equal(groups[0].__total, innerN);
  // the table's base row is everyone
  assert.equal(t.rows.find((x) => x.__kind === "base")!.__total, t.base!.n);
});

test("stacked banner: every row variable in one table under section rows", () => {
  const r = runAnalysis(XT({ rows: ["SAT", "REGION"], columns: ["GENDER", "REGION"] }, { layout: "banner", stackRows: true }), ds);
  assert.equal(r.tables.length, 1);
  const sections = r.tables[0].rows.filter((x) => x.__kind === "section").map((x) => x.row);
  assert.deepEqual(sections, ["Overall satisfaction", "Region"]);
});

test("base 'all' adds a No answer row and bases on everyone in the column", () => {
  // AWARE_1 is a 0/1 flag most people have; TEXT is answered by some — use a variable with missing values: NPS follow-up? Use SAT with an artificial hole.
  const holes = rows.map((row, i) => (i % 10 === 0 ? { ...row, answers: { ...row.answers, q_sat: undefined } } : row));
  const hds = buildDataset(def, holes, { spec: dsSpec });
  const answered = runAnalysis(XT({}), hds).tables[0];
  const all = runAnalysis(XT({}, { base: "all" }), hds).tables[0];
  assert.ok(!answered.rows.some((x) => x.__kind === "noanswer"));
  const na = all.rows.find((x) => x.__kind === "noanswer")!;
  assert.ok(na && num(na.__total__n) >= 35, "the 40 blanked respondents show up as No answer");
  assert.ok(num(all.base!.n) > num(answered.base!.n), "the base grows to everyone in the column");
  const cats = all.rows.filter((x) => x.__kind === "category" || x.__kind === "noanswer");
  const sum = cats.reduce((s, x) => s + num(x.__total), 0);
  assert.ok(Math.abs(sum - 100) < 0.3, `with No answer the column still sums to 100 (${sum})`);
});

test("minimum base suppresses a small column's cells and marks it", () => {
  const r = runAnalysis(XT({}, { minBase: 1000 }), ds);
  const t = r.tables[0];
  const male = t.columns.find((c) => c.key === "1")!;
  assert.equal(male.suppressed, true);
  assert.match(male.label, /\*$/);
  for (const row of t.rows.filter((x) => x.__kind === "category")) assert.equal(row["1"], null);
  assert.ok(t.notes!.some((n) => /suppressed/.test(n)));
  // the Total column is never suppressed
  assert.equal(t.columns.find((c) => c.key === "__total")!.suppressed, undefined);
});

test("sorting, hidden empty rows and the total row", () => {
  const r = runAnalysis(XT({ rows: ["REGION"] }, { sortRows: "desc", totalRow: true }), ds);
  const cats = r.tables[0].rows.filter((x) => x.__kind === "category").map((x) => num(x.__total));
  assert.deepEqual(cats, [...cats].sort((a, b) => b - a));
  const total = r.tables[0].rows.find((x) => x.__kind === "total")!;
  assert.ok(Math.abs(num(total.__total) - 100) < 0.3);
  const h = runAnalysis(XT({}, { hideEmptyRows: true }), ds);
  assert.ok(h.tables[0].rows.filter((x) => x.__kind === "category").every((x) => num(x.__total__n) > 0));
});

test("summary rows for a scale: mean, boxes and net — with letters", () => {
  const r = runAnalysis(XT({}, { summaryRows: ["mean", "top2", "bottom2", "net"] }), ds);
  const t = r.tables[0];
  const names = t.rows.filter((x) => x.__kind === "summary").map((x) => String(x.row));
  assert.ok(names.some((n) => n.startsWith("Top 2 box")) && names.some((n) => n.startsWith("Bottom 2 box")) && names.includes("Mean") && names.includes("Net (top 2 − bottom 2)"));
  const t2 = t.rows.find((x) => String(x.row).startsWith("Top 2 box"))!, b2 = t.rows.find((x) => String(x.row).startsWith("Bottom 2 box"))!, net = t.rows.find((x) => x.row === "Net (top 2 − bottom 2)")!, mean = t.rows.find((x) => x.row === "Mean")!;
  assert.ok(Math.abs(num(net["2"]) - (num(t2["2"]) - num(b2["2"]))) < 0.11);
  // women are planted more satisfied: their top-2 box and mean are higher and marked against men (a)
  assert.ok(num(t2["2"]) > num(t2["1"]));
  assert.equal(t2["2__sig"], "a");
  assert.ok(num(mean["2"]) > num(mean["1"]));
  assert.equal(mean["2__sig"], "a");
  // the mean is the code-weighted average of the distribution
  const cats = t.rows.filter((x) => x.__kind === "category");
  const m = cats.reduce((s, x) => s + Number(x.__code) * num(x.__total), 0) / 100;
  assert.ok(Math.abs(m - num(mean.__total)) < 0.02);
});

test("measure 'mean' on a scale row gives a means table (audit A4); numeric rows keep theirs", () => {
  const r = runAnalysis(XT({ measure: "mean" }), ds);
  const t = r.tables[0];
  assert.match(String(t.rows[0].row), /^Mean/);
  assert.equal(t.columns[1].type, "number");
  assert.ok(num(t.rows[0]["2"]) > num(t.rows[0]["1"]), "women's mean satisfaction is higher");
  assert.equal(t.rows[0]["2__sig"], "a", "and significantly so");
  assert.equal(r.tests[0].test, "anova_one_way");
  const a = runAnalysis(XT({ rows: ["AGE"], columns: ["REGION"] }), ds);
  assert.equal(a.tables[0].rows[0].row, "Mean");
});

test("weighted: percentages, letters and the SD all follow the weights (audit A5, A6)", () => {
  const wds = buildDataset(def, rows, { spec: dsSpec, weighting: { rim: [{ variable: "GENDER", targets: { 1: 80, 2: 20 } }] } });
  assert.ok(wds.weightInfo!.efficiency > 50 && wds.weightInfo!.efficiency <= 100, `efficiency is a percent (${wds.weightInfo!.efficiency})`);
  const r = runAnalysis(XT({}), wds);
  assert.ok(!r.warnings.some((w) => /efficiency is \d%/.test(w)), "no bogus 1% efficiency warning");
  const t = r.tables[0];
  assert.ok(t.rows.some((x) => x.row === "Weighted base"));
  // a heavily down-weighted column has a smaller effective base, so fewer letters than unweighted
  const unw = runAnalysis(XT({}), ds).tables[0];
  const letters = (tab: typeof t) => tab.rows.filter((x) => x.__kind === "category").reduce((s, x) => s + String(x["2__sig"] ?? "").length + String(x["1__sig"] ?? "").length, 0);
  assert.ok(letters(t) <= letters(unw));
  assert.ok(t.notes!.some((n) => /effective bases/.test(n)));
  const m = runAnalysis(XT({ rows: ["AGE"] }), wds).tables[0];
  assert.ok(m.rows[1].row === "Std. deviation" && m.rows[1]["1"] != null);
});

test("letters beyond z, and a factor's variance in percent (audit A2, A11)", () => {
  assert.equal(columnLetter(0), "a"); assert.equal(columnLetter(25), "z"); assert.equal(columnLetter(26), "aa"); assert.equal(columnLetter(27), "ab"); assert.equal(columnLetter(52), "ba");
  const f = runAnalysis({ name: "f", kind: "factor", dataset: dsSpec, variables: ["ITEMS_a", "ITEMS_b", "ITEMS_c", "SAT", "NPS"] }, ds);
  const eig = f.tables.find((t) => t.id === "eigen")!;
  const cum = eig.rows.map((r) => num(r.cum));
  assert.ok(cum[cum.length - 1] > 99 && cum[cum.length - 1] <= 100.5, `cumulative ends at 100% (${cum[cum.length - 1]})`);
  assert.ok(cum.every((c) => c <= 100.5));
});

test("segment profile: weighted means stay aligned with their cases when values are missing (audit A1)", () => {
  const holes = rows.map((row, i) => (i % 7 === 0 ? { ...row, answers: { ...row.answers, q_sat: undefined } } : row));
  const wds = buildDataset(def, holes, { spec: dsSpec, weighting: { rim: [{ variable: "GENDER", targets: { 1: 80, 2: 20 } }] } });
  const seg = runAnalysis({ name: "s", kind: "segmentation", dataset: dsSpec, variables: ["SAT"], segments: [{ id: "all", name: "Everyone", condition: { op: "and", rules: [] } as never }] }, wds);
  const profile = seg.tables.find((t) => t.id === "seg_SAT")!;
  const xt = runAnalysis(XT({ measure: "mean" }), wds).tables[0];
  // the weighted mean of everyone equals the crosstab's weighted total mean — before the fix the
  // weights were applied to the wrong respondents once missing values had been dropped
  assert.ok(Math.abs(num(profile.rows[0].mean) - num(xt.rows[0].__total)) < 0.02, `${profile.rows[0].mean} vs ${xt.rows[0].__total}`);
});
