import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, reviewQuotas } from "@rescript/engine";
import { readQuotaSheet, quotaSheetActions, parseRange, parseTarget, matchQuestion } from "./quotaSheet.js";
import { readSheets } from "./sources.js";

/*
 * QUOTA SHEETS: the three layouts a client sends, read into quotas against
 * the real survey — every header a question, every value an option or a
 * range, the rest reported by row.
 */

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const survey = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Tracker", version: "1.0" },
  questions: [
    { id: "q1", code: "S1", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female", "Prefer not to say") },
    { id: "q2", code: "S2", variableName: "AGE", type: "numeric", text: "How old are you?", settings: { min: 16, max: 99 } },
    { id: "q3", code: "S3", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North East", "North West", "Midlands", "London", "South") },
    { id: "q4", code: "S4", variableName: "AGEBAND", type: "single_select", text: "Age band", options: opts("18-24", "25-34", "35-44", "45+") },
  ],
  flow: [{ type: "block", id: "b1", title: "Screening", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] }] }, { type: "end", id: "e", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s" },
});
const sheet = (name: string, rows: (string | number)[][]) => ({ name, rows: rows.map((r) => r.map(String)) });

test("ranges and targets as a sheet writes them", () => {
  assert.deepEqual(parseRange("18-24"), { min: 18, max: 24 });
  assert.deepEqual(parseRange("18 – 24 years"), { min: 18, max: 24 });
  assert.deepEqual(parseRange("25 to 34"), { min: 25, max: 34 });
  assert.deepEqual(parseRange("55+"), { min: 55 });
  assert.deepEqual(parseRange("65 and over"), { min: 65 });
  assert.deepEqual(parseRange("Over 65"), { min: 66 });
  assert.deepEqual(parseRange("Under 18"), { max: 17 });
  assert.deepEqual(parseRange("18 or younger"), { max: 18 });
  assert.equal(parseRange("Male"), null);
  assert.deepEqual(parseTarget("1,250"), { value: 1250, percent: false });
  assert.deepEqual(parseTarget("12.5%"), { value: 12.5, percent: true });
  assert.equal(parseTarget("n/a"), null);
  const def = survey();
  assert.equal(matchQuestion(def, "Gender")?.code, "S1", "by a word of the text");
  assert.equal(matchQuestion(def, "AGE")?.code, "S2", "by variable");
  assert.equal(matchQuestion(def, "S3")?.code, "S3", "by code");
  assert.equal(matchQuestion(def, "Age", ["18-24", "25-34"])?.code, "S4", "the values decide between the two age questions");
  assert.equal(matchQuestion(def, "Age", ["18-24"])?.code, "S4");
  assert.equal(matchQuestion(def, "Income"), undefined);
  assert.equal(matchQuestion(def, "you"), undefined, "a word two questions share equally is no match");
});

test("the shapes a sheet comes in: a two-cell title row, two target-like columns, a percent header without % signs, a list with a Total row, a multi-select column, an unknown header, a clash with an existing quota, an ambiguous list label", () => {
  const def = survey();
  /* a title row with two cells is not the header */
  const titled = readQuotaSheet([sheet("Plan", [["Project ABC", "Draft 2"], ["Gender", "Target"], ["Male", 50], ["Female", 50]])]);
  assert.deepEqual(titled.quotas[0].dimensions, ["Gender"]); assert.equal(titled.quotas[0].cells.length, 2);
  /* two target-like columns: the one with numbers under it */
  const twoTargets = readQuotaSheet([sheet("Plan", [["Gender", "Max", "Target"], ["Male", "—", 50], ["Female", "—", 50]])]);
  assert.deepEqual(twoTargets.quotas[0].cells.map((c) => c.target), [50, 50]);
  assert.equal(twoTargets.quotas[0].layout, "long"); assert.deepEqual(twoTargets.quotas[0].dimensions, ["Gender"]);
  /* a Share column makes its numbers percents even without % signs */
  const share = readQuotaSheet([sheet("Region", [["Region", "Share"], ["London", "40"], ["South", "60"], ["Total", "300"]])]);
  assert.deepEqual(share.quotas[0].cells.map((c) => [c.target, c.percent]), [[40, true], [60, true]]); assert.equal(share.quotas[0].total, 300);
  /* a list with a Total row */
  const list = readQuotaSheet([sheet("Region", [["London", "40%"], ["South", "60%"], ["Total", "300"]])]);
  assert.equal(list.quotas[0].layout, "list"); assert.equal(list.quotas[0].total, 300); assert.equal(list.quotas[0].cells.length, 2);
  const lm = quotaSheetActions(def, list);
  assert.equal(lm.actions.length, 1); assert.equal((lm.actions[0] as { total: number }).total, 300);
  /* a multi-select column selects the code */
  const multi = survey();
  multi.questions.push({ id: "q5", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which brands have you used?", options: opts("Brand A", "Brand B") } as never);
  const bm = quotaSheetActions(multi, readQuotaSheet([sheet("Brands", [["Brands", "Target"], ["Brand A", 100], ["Brand A / Brand B", 50]])]));
  assert.deepEqual(bm.issues, []);
  const bc = (bm.actions[0] as { cells: { when: { operator: string; value: unknown } }[] }).cells;
  assert.deepEqual(bc.map((c) => [c.when.operator, c.when.value]), [["selected", 1], ["containsAny", [1, 2]]]);
  /* an unknown header is said */
  const unknown = quotaSheetActions(def, readQuotaSheet([sheet("Plan", [["Income", "Target"], ["Low", 50], ["High", 50]])]));
  assert.equal(unknown.actions.length, 0);
  assert.ok(unknown.issues.some((i) => /no question matches the column “Income”/.test(i)), unknown.issues.join("\n"));
  /* a sheet quota named like an existing one does not collide */
  const withQuota = survey();
  withQuota.quotas.push({ id: "qx", name: "Region", mode: "hard", cells: [], onFull: { kind: "terminate" }, countStatus: ["complete"] } as never);
  const clash = quotaSheetActions(withQuota, readQuotaSheet([sheet("Region", [["Region", "Target"], ["London", 50], ["South", 50]])]));
  assert.equal((clash.actions[0] as { name: string }).name, "Region (imported)");
  /* a list label that two questions could own is reported, not guessed */
  const amb = survey();
  amb.questions.push({ id: "q6", code: "S6", variableName: "GREW_UP", type: "single_select", text: "Where did you grow up?", options: opts("North", "South", "Abroad") } as never);
  const am = quotaSheetActions(amb, readQuotaSheet([sheet("Region", [["South", 50], ["London", 50], ["Total", 100]])]));
  assert.ok(am.issues.some((i) => /“South” matches more than one question/.test(i)), am.issues.join("\n"));
  assert.equal((am.actions[0] as { cells: unknown[] }).cells.length, 1, "London resolves, South does not");
});

test("a LONG sheet: dimension columns, a target column, a Total row, two quota groups — to quotas with the right conditions and limits", () => {
  const sh = readQuotaSheet([sheet("Quotas", [
    ["Quota", "Gender", "Age", "Target", "Notes"],
    ["Gender x Age", "Male", "18-24", 60, "boost"],
    ["Gender x Age", "Male", "25-34", 65, ""],
    ["Gender x Age", "Female", "18-24", 60, ""],
    ["Gender x Age", "Female", "25-34", 65, ""],
    ["Region", "", "", "", ""],
    ["Region", "London", "", "80", ""],
    ["Region", "Northern", "", "70", ""],
    ["Region", "Midlands", "", "x", ""],
    ["Total", "", "", 250, ""],
  ])]);
  assert.equal(sh.confidence, 0.9);
  assert.deepEqual(sh.quotas.map((q) => [q.name, q.layout, q.cells.length, q.total]), [["Gender x Age", "long", 4, 250], ["Region", "long", 2, 250]]);
  assert.deepEqual(sh.quotas[0].cells[0], { label: "Male × 18-24", dims: [{ header: "Gender", value: "Male" }, { header: "Age", value: "18-24" }], target: 60, percent: false, row: 2 });
  assert.ok(sh.issues.some((i) => /row 9: “x” is not a number/.test(i)), sh.issues.join("\n"));
  assert.ok(sh.issues.some((i) => /row 6: “—” is not a number/.test(i)), "an empty target row is reported, not silently skipped");
  const def = survey();
  const m = quotaSheetActions(def, sh);
  assert.deepEqual(m.matched, { Gender: "S1", Age: "S4" }, "Age → the band question, whose options ARE the sheet's values (18-24, 25-34) — not the numeric age that merely shares the name");
  assert.equal(m.actions.length, 1, "the Region rows put region names under the Gender column: nothing resolves, so no Region quota");
  const a0 = m.actions[0] as { name: string; total: number; cells: { label: string; when: { type: string; children: { source: { ref: string }; operator: string; value: unknown; value2?: unknown }[] }; limit: number }[] };
  assert.equal(a0.name, "Gender x Age"); assert.equal(a0.total, 250);
  assert.deepEqual(a0.cells[1].when.children.map((r) => [r.source.ref, r.operator, r.value, r.value2]), [["q1", "eq", 1, undefined], ["q4", "eq", 2, undefined]]);
  /* with no band question, the same sheet reads the ranges against the numeric age */
  const numericOnly = survey(); numericOnly.questions = numericOnly.questions.filter((q) => q.id !== "q4"); (numericOnly.flow[0] as { children: { questionIds: string[] }[] }).children[0].questionIds = ["q1", "q2", "q3"];
  const mn = quotaSheetActions(numericOnly, sh);
  assert.equal(mn.matched.Age, "S2");
  assert.deepEqual((mn.actions[0] as typeof a0).cells[1].when.children[1], { type: "rule", source: { kind: "question", ref: "q2" }, operator: "between", value: 25, value2: 34 });
  /* the Region sheet column is “Gender” for London… the value “London” is no gender: said by row, left out; the quota keeps the one cell that resolved */
  assert.ok(m.issues.some((i) => /row 7: S1 has no option “London”/.test(i)), m.issues.join("\n"));
  assert.ok(m.issues.some((i) => /none of the 2 cells of “Region” could be matched/.test(i)), m.issues.join("\n"));
  /* through the engine: real quotas, a clean review */
  const out = applySurveyActions(def, coerceSurveyActions(m.actions).actions);
  assert.deepEqual(out.errors, []);
  assert.equal(out.def.quotas[0].cells.length, 4);
  assert.equal(out.def.quotas[0].targetTotal, 250);
  assert.ok(!reviewQuotas(out.def).some((f) => f.kind === "sum_under" || f.kind === "sum_over"), "60+65+60+65 = 250, the sheet's total");
  assert.ok(reviewQuotas(out.def).some((f) => f.kind === "uncovered"), "but the sheet has no cells for 35+ or “Prefer not to say” — the review says so");
});

test("a MATRIX sheet (Age down, Gender across, a Total row and column) and a LIST sheet; percentages need a total", () => {
  const sh = readQuotaSheet([
    sheet("Age by Gender", [
      ["Age / Gender", "Male", "Female", "Total"],
      ["18-24", 50, 50, 100],
      ["25-34", 75, 75, 150],
      ["35-44", 60, 70, 130],
      ["45+", 60, 60, 120],
      ["Total", 245, 255, 500],
    ]),
    sheet("Region", [["London", "40%"], ["South", "35%"], ["Midlands", "25%"]]),
  ]);
  assert.deepEqual(sh.quotas.map((q) => [q.name, q.layout, q.cells.length, q.total, q.dimensions]), [["Age by Gender", "matrix", 8, 500, ["Age", "Gender"]], ["Region", "list", 3, undefined, []]]);
  assert.deepEqual(sh.quotas[0].cells[2], { label: "25-34 × Male", dims: [{ header: "Age", value: "25-34" }, { header: "Gender", value: "Male" }], target: 75, percent: false, row: 3 });
  const def = survey();
  const m = quotaSheetActions(def, sh);
  assert.deepEqual(m.matched, { Age: "S4", Gender: "S1" }, "the matrix's row values are the band question's labels, so Age is S4 here");
  assert.equal(m.actions.length, 1, "the percent list has no total");
  assert.ok(m.issues.some((i) => /“Region” gives percentages but no total/.test(i)), m.issues.join("\n"));
  const a0 = m.actions[0] as { cells: { when: { children: { source: { ref: string }; operator: string; value: unknown }[] } }[]; total: number };
  assert.equal(a0.total, 500); assert.equal(a0.cells.length, 8);
  assert.deepEqual(a0.cells[0].when.children.map((r) => [r.source.ref, r.operator, r.value]), [["q4", "eq", 1], ["q1", "eq", 1]]);
  const out = applySurveyActions(def, coerceSurveyActions(m.actions).actions);
  assert.deepEqual(out.errors, []);
  assert.equal(out.def.quotas[0].cells.reduce((s, c) => s + c.limit, 0), 500);
  assert.ok(reviewQuotas(out.def).some((f) => f.kind === "uncovered" && /Prefer not to say/.test(f.message)), "the sheet has no cells for the third gender option — said");
  /* the list WITH a total: labels resolve to the one question that has them */
  const withTotal = readQuotaSheet([sheet("Region", [["Region", "Share"], ["London", "40%"], ["South", "35%"], ["Midlands", "25%"], ["Total", 400]])]);
  assert.equal(withTotal.quotas[0].layout, "long"); assert.equal(withTotal.quotas[0].total, 400);
  const m2 = quotaSheetActions(def, withTotal);
  assert.equal(m2.actions.length, 1);
  const a1 = m2.actions[0] as { total: number; cells: { percent: number; when: { source: { ref: string }; value: unknown } }[] };
  assert.equal(a1.total, 400); assert.deepEqual(a1.cells.map((c) => [c.percent, c.when.value]), [[40, 4], [35, 5], [25, 3]]);
  const out2 = applySurveyActions(def, coerceSurveyActions(m2.actions).actions);
  assert.deepEqual(out2.errors, []);
  assert.deepEqual(out2.def.quotas[0].cells.map((c) => [c.limitType, c.limit]), [["percent", 40], ["percent", 35], ["percent", 25]]);
  /* a sheet that is not a quota sheet */
  const not = readQuotaSheet([sheet("Notes", [["Hello"], ["This is a memo about the study"], ["Nothing to count here"]])]);
  assert.equal(not.confidence, 0); assert.equal(not.quotas.length, 0); assert.equal(not.issues.length, 1);
});

test("a real workbook: two sheets through exceljs, headers below a title row, numbers as numbers", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sample plan");
  ws.addRow(["Project ABC — sample plan"]);
  ws.addRow([]);
  ws.addRow(["Gender", "Age", "N"]);
  ws.addRow(["Male", "18–34", 100]);
  ws.addRow(["Male", "35+", 150]);
  ws.addRow(["Female", "18–34", 100]);
  ws.addRow(["Female", "35+", 150]);
  ws.addRow(["Total", "", 500]);
  const ws2 = wb.addWorksheet("Region");
  ws2.addRow(["Region", "Target"]);
  ws2.addRow(["London", 200]); ws2.addRow(["South", 150]); ws2.addRow(["North East / North West", 150]);
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer);
  const sheets = await readSheets(bytes, "plan.xlsx");
  assert.equal(sheets.length, 2);
  const sh = readQuotaSheet(sheets);
  assert.deepEqual(sh.quotas.map((q) => [q.name, q.cells.length, q.total]), [["Sample plan", 4, 500], ["Region", 3, undefined]]);
  const def = survey();
  const m = quotaSheetActions(def, sh, { mode: "soft" });
  assert.deepEqual(m.issues, []);
  assert.equal(m.actions.length, 2);
  const region = m.actions[1] as { cells: { when: { operator: string; value: unknown } }[]; total: number; mode: string };
  assert.deepEqual(region.cells[2].when, { type: "rule", source: { kind: "question", ref: "q3" }, operator: "in", value: [1, 2] }, "two options joined with / become one cell");
  assert.equal(region.total, 500, "no Total row: the sum of the targets");
  assert.equal(region.mode, "soft");
  const out = applySurveyActions(def, coerceSurveyActions(m.actions).actions);
  assert.deepEqual(out.errors, []);
  assert.equal(out.def.quotas.length, 2);
  /* a CSV goes the same way */
  const csv = new TextEncoder().encode("Gender,Target\nMale,250\nFemale,250\n");
  const c = readQuotaSheet(await readSheets(csv, "quotas.csv"));
  assert.equal(c.quotas[0].cells.length, 2);
  assert.equal(quotaSheetActions(def, c).actions.length, 1);
});
