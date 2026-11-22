import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { runAnalysis } from "./analyses/index.js";
import { kds } from "./analyses/knownFixture.js";
import { autoTabPlan, runTabPlan, type TabPlan } from "./tabPlan.js";
import { buildTabBook } from "./export/tabBook.js";

const spec = { environment: "LIVE" as const, dataset: "all" as const };
const plan = (): TabPlan => ({
  name: "Wave 1 tabs", dataset: spec, banner: { columns: ["GENDER", "REGION"] }, alpha: 0.05,
  stubs: [
    { variable: "REGION", nets: [{ variable: "REGION", label: "North or South", codes: ["1", "2"] }] },
    { variable: "AWARE", title: "Brand awareness" },
    { kind: "summary", title: "Awareness by brand, ranked", variables: ["AWARE_1", "AWARE_2", "AWARE_3"], statistic: { code: "1" }, rank: true },
    { variable: "NPS", summaryRows: ["nps"] },
  ],
});

test("every stub is the crosstab engine's own table: same cells as running the crosstab directly", () => {
  const ds = kds();
  const run = runTabPlan(plan(), ds);
  assert.deepEqual(run.problems, []);
  assert.equal(run.tables.length, 4);
  const direct = runAnalysis({ name: "AWARE", kind: "crosstab", dataset: spec, variables: [], rows: ["AWARE"], columns: ["GENDER", "REGION"], filter: null, weighting: null, options: { nets: [], layout: "banner", significance: true, alpha: 0.05, hideEmptyRows: false } }, ds);
  const t = run.tables[1]!;
  assert.equal(t.title, "Brand awareness");
  assert.deepEqual(t.table.rows, direct.tables[0]!.rows);
  assert.ok(run.tables[0]!.table.rows.some((r) => String(r.row) === "North or South (net)"), "the stub's net is in its table");
});

test("a summary stub lifts each question's own row, with its own figures, and ranks by the Total", () => {
  const ds = kds();
  const run = runTabPlan(plan(), ds);
  const s = run.tables[2]!;
  assert.equal(s.kind, "summary");
  assert.equal(s.table.rows.length, 3);
  const totals = s.table.rows.map((r) => r.__total as number);
  assert.deepEqual([...totals].sort((a, b) => b - a), totals, "ranked high to low");
  assert.match(String(s.table.rows[0]!.row), /^1\. /);
  for (const row of s.table.rows) {
    const own = s.results.find((r) => r.variablesUsed.includes(String(row.__variable)))!.tables[0]!.rows.find((x) => x.__code === "1")!;
    assert.equal(row.__total, own.__total, `${row.__variable}: the summary shows the question's own figure`);
  }
  assert.ok(run.tables[3]!.table.rows.some((r) => /^NPS/.test(String(r.row))), "NPS rows on the NPS stub");
});

test("problems are reported, not dropped silently; a broken banner stops the run", () => {
  const ds = kds();
  const p = plan();
  p.stubs.push({ variable: "NOPE" }, { kind: "summary", title: "Ghost", variables: ["SAT"], statistic: "top2" });
  const run = runTabPlan(p, ds);
  assert.ok(run.problems.some((x) => /NOPE is not in the data/.test(x)));
  assert.ok(run.problems.some((x) => /has no top2/.test(x) || /nothing to show/.test(x)), "top-2 box on an unordered scale (it has Don't know) is refused and said so");
  const bad = runTabPlan({ ...plan(), banner: { columns: ["AGE"] } }, ds);
  assert.equal(bad.tables.length, 0);
  assert.ok(bad.problems.some((x) => /AGE is numeric/.test(x)));
});

test("the automatic draft covers every question with categories, never the banner or system columns", () => {
  const ds = kds();
  const auto = autoTabPlan(ds, { columns: ["GENDER"] });
  const vars = auto.stubs.flatMap((s) => (s.kind === "summary" ? [] : [s.variable]));
  assert.ok(!vars.includes("GENDER") && !vars.some((v) => v.startsWith("_")));
  assert.ok(vars.includes("REGION") && vars.includes("AWARE"));
  const nps = auto.stubs.find((s) => s.kind !== "summary" && s.variable === "NPS");
  assert.deepEqual(nps && "summaryRows" in nps ? nps.summaryRows : null, ["nps"]);
});

test("the tab book: a linked contents sheet, one formatted sheet per table, letters in their own column", async () => {
  const ds = kds();
  const run = runTabPlan(plan(), ds);
  const buf = await buildTabBook(run);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Contents", "T1", "T2", "T3", "T4"]);
  const toc = wb.getWorksheet("Contents")!;
  const links: string[] = [];
  toc.eachRow((r) => r.eachCell((c) => { const v = c.value as { hyperlink?: string } | null; if (v && typeof v === "object" && v.hyperlink) links.push(v.hyperlink); }));
  assert.deepEqual(links, ["#'T1'!A1", "#'T2'!A1", "#'T3'!A1", "#'T4'!A1"]);
  const t1 = wb.getWorksheet("T1")!;
  assert.match(String(t1.getCell(2, 1).value), /^T1\. /);
  assert.match(String(t1.getCell(3, 1).value), /^Base: n = /);
  const header = (t1.getRow(4).values as unknown[]).slice(1).map(String);
  assert.equal(header[1], "Total");
  const pctCell = t1.getCell(5, 2);
  assert.equal(pctCell.numFmt, "0.0%", "percentages are real percentages");
});
