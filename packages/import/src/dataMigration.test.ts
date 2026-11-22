import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { planDataMigration, migrateResponses, type LegacyTable } from "./dataMigration.js";

const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S", version: "1.0" }, questions: [
  { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Brand used", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }] },
  { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Aware", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }] },
  { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "Your age" },
  { id: "q4", code: "Q4", variableName: "Q4", type: "matrix_single", text: "Rate", rows: [{ code: "r1", label: "Taste" }, { code: "r2", label: "Price" }], options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: String(c) })) },
  { id: "q5", code: "Q5", variableName: "Q5", type: "open_text", text: "Why" },
], flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5"] }] });

const table: LegacyTable = {
  header: ["RespID", "q1", "Q2_1", "Q2_2", "Q2_3", "AGE", "Q4_r1", "Q4_r2", "Q5", "Weight", "OLD_EXTRA"],
  labels: { AGE: "Your age" },
  rows: [
    ["A1", "1", "1", "0", "1", "34", "5", "4", "Good coffee", "1.2", "x"],
    ["A2", "Beta", "0", "1", "0", "51", "3", "", "", "0.8", "y"],
    ["A3", "3", "1", "1", "1", "", "2", "2", "Too dear", "1.0", ""],
    ["A4", "7", "", "", "", "29", "9", "1", "", "1.0", ""],
  ],
};

test("the variable map: by name, by name folded, by label; weight and id found; extra columns and unknown values listed", () => {
  const p = planDataMigration(def, table);
  const by = Object.fromEntries(p.columns.map((c) => [c.column, c]));
  assert.equal(by.q1!.target, "Q1"); assert.equal(by.q1!.how, "name_folded");
  assert.equal(by.AGE!.target, "Q3"); assert.equal(by.AGE!.how, "label");
  assert.equal(by.Q2_2!.kind, "option_flag"); assert.equal(by.Q2_2!.optionCode, "2");
  assert.equal(by.Q4_r2!.kind, "row");
  assert.deepEqual(by.q1!.recode, { Beta: "2" }, "a label is recoded to its code");
  assert.deepEqual(by.q1!.unmappedValues, ["7"], "a code the survey does not have is listed, not guessed");
  assert.deepEqual(by.Q4_r1!.unmappedValues, ["9"]);
  assert.equal(p.weight, "Weight"); assert.equal(p.idColumn, "RespID");
  assert.deepEqual(p.unmatchedColumns, ["OLD_EXTRA"]);
  assert.deepEqual(p.unfilledQuestions, []);
});

test("migrated answers are in the runtime's shape, weights go to embedded data, lost values are reported per row", () => {
  const p = planDataMigration(def, table);
  const r = migrateResponses(def, table, p);
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows[0]!.answers, { q1: 1, q2: [1, 3], q3: 34, q4: { r1: 5, r2: 4 }, q5: "Good coffee" });
  assert.deepEqual(r.rows[1]!.answers, { q1: 2, q2: [2], q3: 51, q4: { r1: 3 } });
  assert.equal(r.rows[0]!.embedded.WEIGHT, 1.2);
  assert.equal(r.rows[0]!.externalId, "A1");
  assert.deepEqual(r.rows[3]!.lost.sort(), ["Q4_r1=9", "q1=7"]);
  assert.equal(r.summary.valuesLost, 2);
  assert.ok(r.summary.weighted);
});

test("reconciliation: every mapped variable's legacy counts equal what the engine reads back from the migrated answers", () => {
  const p = planDataMigration(def, table);
  const r = migrateResponses(def, table, p);
  const bad = r.reconciliation.filter((x) => !x.matches);
  assert.deepEqual(bad, [], JSON.stringify(bad));
  const q1 = r.reconciliation.find((x) => x.variable === "Q1")!;
  assert.deepEqual(q1.migrated, { "1": 1, "2": 1, "3": 1 });
  assert.equal(r.summary.variablesMatching, p.columns.length);
});

test("reconciliation catches an answer that differs from the legacy file", async () => {
  const { reconcile } = await import("./dataMigration.js");
  const p = planDataMigration(def, table);
  const r = migrateResponses(def, table, p);
  const tampered = r.rows.map((x, i) => (i === 0 ? { ...x, answers: { ...x.answers, q1: 2 } } : x));
  const rec = reconcile(def, table, p, tampered);
  const q1 = rec.find((x) => x.variable === "Q1")!;
  assert.equal(q1.matches, false);
  assert.ok(rec.filter((x) => x.variable !== "Q1").every((x) => x.matches));
});

test("a CSV with a codebook-free header reads as a legacy table; a .sav is refused with what to do", async () => {
  const { legacyTableFrom } = await import("./dataMigration.js");
  const csv = new TextEncoder().encode("RespID,Q1,Q3\nA1,1,34\nA2,2,51\n");
  const t = await legacyTableFrom(csv, "legacy.csv");
  assert.ok(!("error" in t));
  if (!("error" in t)) { assert.deepEqual(t.header, ["RespID", "Q1", "Q3"]); assert.equal(t.rows.length, 2); }
  const sav = new Uint8Array([0x24, 0x46, 0x4c, 0x32, 0, 0, 0, 0]);
  const s = await legacyTableFrom(sav, "x.sav");
  assert.ok("error" in s && /export the data as CSV or Excel/.test(s.error));
});
