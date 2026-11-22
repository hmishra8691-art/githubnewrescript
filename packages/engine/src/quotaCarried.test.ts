import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  coerceSurveyActions, applySurveyActions, withCarriedCounts, carriedCount, quotaDashboard, applyQuotaEdit, validateQuotaEdit, quotaEditDiff,
} from "./index.js";

/*
 * I5 — CARRIED-OVER QUOTA COUNTS: completes a cell reached on another platform, kept on the definition, added to
 * the LIVE counters wherever fullness is decided, shown apart on the dashboard, editable, never a test counter's.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const survey = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Tracker", version: "1.0" },
  questions: [{ id: "q1", code: "S1", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female") }],
  flow: [{ type: "block", id: "b1", title: "S", children: [{ type: "page", id: "p1", questionIds: ["q1"] }] }, { type: "end", id: "e", status: "complete" }],
});

test("create_quota and update_quota carry, change and clear a cell's carried-over completes", () => {
  const made = applySurveyActions(survey(), coerceSurveyActions([{ op: "create_quota", name: "Gender", cells: [
    { label: "Male", when: "GENDER = 1", limit: 50, carried: 50, carriedSource: "quota report (q.xlsx)" },
    { label: "Female", when: "GENDER = 2", limit: 50, carried: 12 },
  ] }]).actions);
  assert.deepEqual(made.errors, []);
  const q = made.def.quotas[0];
  assert.deepEqual(q.cells.map((c) => c.carried), [{ count: 50, source: "quota report (q.xlsx)" }, { count: 12, source: "entered by hand" }]);
  assert.match(made.results[0].description, /62 completes carried over from earlier fieldwork/);
  assert.ok(made.warnings.some((w) => /“Male” is already full from the completes carried over \(50 of 50\)/.test(w)), made.warnings.join(" | "));

  assert.match(coerceSurveyActions([{ op: "create_quota", name: "X", cells: [{ when: "GENDER = 1", limit: 5, carried: -2 }] }]).rejected[0].reason, /whole number, 0 or more/);
  assert.match(coerceSurveyActions([{ op: "create_quota", name: "X", cells: [{ when: "GENDER = 1", limit: 5, carried: 2.5 }] }]).rejected[0].reason, /whole number/);

  const up = applySurveyActions(made.def, coerceSurveyActions([{ op: "update_quota", quota: "Gender", cells: [{ cell: "Female", carried: 20, carriedSource: "Decipher report" }, { cell: "Male", carried: null }] }]).actions);
  assert.deepEqual(up.errors, []);
  assert.deepEqual(up.def.quotas[0].cells.map((c) => c.carried ?? null), [null, { count: 20, source: "Decipher report" }]);
  assert.match(up.results[0].description, /Female: 20 completes carried over \(Decipher report\).*Male: carried-over completes cleared/);
});

test("live counters plus carried decide fullness; the dashboard shows the carried part; the test counters stay as stored", () => {
  const def = applySurveyActions(survey(), coerceSurveyActions([{ op: "create_quota", name: "Gender", cells: [
    { label: "Male", when: "GENDER = 1", limit: 50, carried: 45, carriedSource: "Qualtrics export" }, { label: "Female", when: "GENDER = 2", limit: 50 },
  ] }]).actions).def;
  const q = def.quotas[0];
  const stored = { [q.id]: { [q.cells[0].id]: 5, [q.cells[1].id]: 7 } };
  const live = withCarriedCounts(def, stored);
  assert.equal(live[q.id][q.cells[0].id], 50);
  assert.equal(live[q.id][q.cells[1].id], 7);
  assert.equal(stored[q.id][q.cells[0].id], 5, "the stored counters are not changed");
  assert.equal(withCarriedCounts(def, {})[q.id][q.cells[0].id], 45, "a cell with no completes here yet still has its carried ones");
  const row = quotaDashboard(def, live).quotas[0].cells[0];
  assert.equal(row.current, 50); assert.equal(row.carried, 45); assert.equal(row.carriedSource, "Qualtrics export"); assert.equal(row.state, "FULL");
  assert.equal(quotaDashboard(def, stored).quotas[0].cells[0].state, "ACTIVE", "the test view: stored counters alone");
  assert.equal(carriedCount(q.cells[1]), 0);
});

test("the dashboard edit sets and clears the carried count, validates it, and the change history names it", () => {
  const def = applySurveyActions(survey(), coerceSurveyActions([{ op: "create_quota", name: "Gender", cells: [{ label: "Male", when: "GENDER = 1", limit: 50 }, { label: "Female", when: "GENDER = 2", limit: 50 }] }]).actions).def;
  const q = def.quotas[0];
  const next = applyQuotaEdit(q, { cells: [{ cellId: q.cells[0].id, carried: 30 }] });
  assert.deepEqual(next.cells[0].carried, { count: 30, source: "entered by hand" });
  assert.deepEqual(quotaEditDiff(q, next), { [`cell.${q.cells[0].id}.carried`]: { before: 0, after: 30 } });
  assert.equal(applyQuotaEdit(next, { cells: [{ cellId: q.cells[0].id, carried: null }] }).cells[0].carried, undefined);
  const bad = validateQuotaEdit(q, { cells: [{ cellId: q.cells[0].id, carried: 2.5 }] }, {});
  assert.ok(bad.errors.some((e) => e.field === "carried"));
});
