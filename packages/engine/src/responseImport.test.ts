import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { parseDelimited, suggestMapping, validateImportRows } from "./responseImport.js";

/**
 * Import validation exists so a bad file is refused BEFORE anything is
 * written. Every test here is about that: the mapping is guessed from the
 * file's own headers, a value the survey would reject is an error with a row
 * number, and a row carrying an error never reaches the prepared set.
 */

const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "s", version: "1" },
  embeddedData: [{ name: "panel", dataType: "string" }],
  questions: [
    { id: "gender", code: "Q1", variableName: "GENDER", type: "single_select", text: "Your gender", options: [{ code: "m", label: "Male" }, { code: "f", label: "Female" }] },
    { id: "age", code: "Q2", variableName: "AGE", type: "numeric", text: "Age", validation: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }] },
    { id: "brands", code: "Q3", variableName: "BRANDS", type: "multi_select", text: "Brands", options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }] },
    { id: "grid", code: "Q4", variableName: "GRID", type: "matrix_single", text: "Agree?", rows: [{ code: "r1", label: "One" }, { code: "r2", label: "Two" }], options: [{ code: "1", label: "No" }, { code: "2", label: "Yes" }] },
    { id: "why", code: "Q5", variableName: "WHY", type: "long_text", text: "Why?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["gender", "age", "brands", "grid", "why"] }, { type: "end", id: "e", status: "complete" }],
});

test("a file exported by this platform maps itself", () => {
  const m = suggestMapping(def, ["respondent_id", "session_id", "survey_version", "started_at", "status", "GENDER", "AGE", "BRANDS", "GRID_r1", "GRID_r2", "WHY", "panel"]);
  assert.deepEqual(m["session_id"], { kind: "session_id" });
  assert.deepEqual(m["status"], { kind: "status" });
  assert.deepEqual(m["survey_version"], { kind: "ignore" }, "the version column is informational");
  assert.deepEqual(m["GENDER"], { kind: "question", questionId: "gender" });
  assert.deepEqual(m["GRID_r2"], { kind: "question", questionId: "grid", rowCode: "r2" });
  assert.deepEqual(m["panel"], { kind: "embedded", name: "panel" });
});

test("a hand-made file maps by question code, question text and respondent-id spellings", () => {
  const m = suggestMapping(def, ["Respondent ID", "Q1", "Your gender", "q2", "Q4_r1", "unknown column"]);
  assert.deepEqual(m["Respondent ID"], { kind: "respondent_code" });
  assert.deepEqual(m["Q1"], { kind: "question", questionId: "gender" });
  assert.deepEqual(m["Your gender"], { kind: "question", questionId: "gender" });
  assert.deepEqual(m["q2"], { kind: "question", questionId: "age" }, "case and spacing do not matter");
  assert.deepEqual(m["Q4_r1"], { kind: "question", questionId: "grid", rowCode: "r1" });
  assert.deepEqual(m["unknown column"], { kind: "ignore" }, "a column that matches nothing is never guessed at");
});

test("codes and labels are both accepted; a grid becomes one answer per row", () => {
  const headers = ["respondent_code", "GENDER", "AGE", "BRANDS", "GRID_r1", "GRID_r2", "WHY"];
  const p = validateImportRows(def, suggestMapping(def, headers), [
    { respondent_code: "TEST_000001", GENDER: "m", AGE: "25", BRANDS: "a,b", GRID_r1: "2", GRID_r2: "1", WHY: "Because" },
    { respondent_code: "TEST_000002", GENDER: "Female", AGE: "31", BRANDS: "Alpha; Beta", GRID_r1: "Yes", GRID_r2: "No", WHY: "" },
  ], "upsert");
  assert.equal(p.summary.errors, 0, JSON.stringify(p.issues));
  assert.equal(p.summary.valid, 2);
  assert.deepEqual(p.rows[0].answers, { gender: "m", age: 25, brands: ["a", "b"], grid: { r1: "2", r2: "1" }, why: "Because" });
  assert.deepEqual(p.rows[1].answers.gender, "f", "a label resolves to its code");
  assert.deepEqual(p.rows[1].answers.brands, ["a", "b"], "labels in a list resolve too");
  assert.deepEqual(p.rows[1].answers.grid, { r1: "2", r2: "1" });
  assert.equal("why" in p.rows[1].answers, false, "an empty cell is not an answer of empty string");
  assert.equal(p.rows[0].respondentCode, "TEST_000001");
});

test("a value the survey would reject is an error naming the row, the column and what was expected", () => {
  const headers = ["respondent_code", "GENDER", "AGE"];
  const p = validateImportRows(def, suggestMapping(def, headers), [
    { respondent_code: "TEST_000001", GENDER: "m", AGE: "25" },
    { respondent_code: "TEST_000002", GENDER: "x", AGE: "abc" },
    { respondent_code: "TEST_000003", GENDER: "m", AGE: "7" },
  ], "upsert");
  assert.equal(p.summary.detected, 3);
  assert.equal(p.summary.valid, 1, "only the good row is prepared");
  assert.equal(p.summary.errors, 3);
  const age = p.issues.find((i) => i.row === 2 && i.column === "AGE")!;
  assert.match(age.message, /“abc” is not a number/);
  assert.equal(age.expected, "a number");
  const gender = p.issues.find((i) => i.row === 2 && i.column === "GENDER")!;
  assert.match(gender.message, /“x” is not an option of Q1/);
  assert.match(gender.expected, /m, f/);
  const min = p.issues.find((i) => i.row === 3)!;
  assert.match(min.message, /18/, `the survey's own min_value rule is enforced: ${min.message}`);
  assert.equal(p.rows[0].row, 1, "row numbers are the file's, header excluded");
});

test("a key repeated inside the file is a warning, not a silent overwrite", () => {
  const p = validateImportRows(def, suggestMapping(def, ["respondent_code", "AGE"]), [
    { respondent_code: "TEST_000001", AGE: "30" },
    { respondent_code: "TEST_000001", AGE: "40" },
  ], "upsert");
  assert.equal(p.summary.duplicates, 1);
  assert.equal(p.summary.warnings, 1);
  assert.match(p.issues[0].message, /also appears on row 1/);
  assert.equal(p.rows[1].duplicateOf, 1);
});

test("update mode requires a key on every row; create mode does not", () => {
  const rows = [{ AGE: "30" }];
  const upd = validateImportRows(def, suggestMapping(def, ["AGE"]), rows, "update");
  assert.equal(upd.summary.errors, 1);
  assert.match(upd.issues[0].message, /nothing to update/);
  assert.equal(upd.summary.valid, 0);
  const cre = validateImportRows(def, suggestMapping(def, ["AGE"]), rows, "create");
  assert.equal(cre.summary.errors, 0);
  assert.equal(cre.summary.unkeyed, 1);
});

test("status and timestamps are validated; an unusable date warns rather than failing the row", () => {
  const p = validateImportRows(def, suggestMapping(def, ["respondent_code", "status", "started_at"]), [
    { respondent_code: "A", status: "complete", started_at: "2026-09-01T10:00:00Z" },
    { respondent_code: "B", status: "finished", started_at: "not a date" },
  ], "upsert");
  assert.equal(p.rows[0].status, "complete");
  assert.match(p.rows[0].startedAt!, /^2026-09-01T10:00:00/);
  const bad = p.issues.find((i) => i.column === "status")!;
  assert.equal(bad.severity, "error");
  assert.match(bad.message, /is not a response status/);
  assert.equal(p.issues.find((i) => i.column === "started_at")!.severity, "warning");
  assert.equal(p.summary.valid, 1);
});

test("columns mapped to nothing are reported so the researcher can remap them", () => {
  const p = validateImportRows(def, suggestMapping(def, ["GENDER", "favourite colour"]), [{ GENDER: "m", "favourite colour": "blue" }], "create");
  assert.deepEqual(p.unmapped, ["favourite colour"]);
  assert.deepEqual(p.rows[0].answers, { gender: "m" }, "an unmapped column contributes nothing");
});

test("CSV parsing handles quotes, embedded commas and newlines, a BOM and tabs", () => {
  const csv = '﻿respondent_code,WHY\r\nTEST_1,"He said ""yes"", then left"\r\nTEST_2,"line one\nline two"\r\n';
  const { headers, rows } = parseDelimited(csv);
  assert.deepEqual(headers, ["respondent_code", "WHY"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].WHY, 'He said "yes", then left');
  assert.equal(rows[1].WHY, "line one\nline two");
  const tsv = parseDelimited("a\tb\n1\t2\n");
  assert.deepEqual(tsv.headers, ["a", "b"]);
  assert.equal(tsv.rows[0].b, "2");
  assert.deepEqual(parseDelimited("").rows, [], "an empty file is not an error");
  assert.deepEqual(parseDelimited("a,b\n\n").rows, [], "blank lines are skipped");
});
