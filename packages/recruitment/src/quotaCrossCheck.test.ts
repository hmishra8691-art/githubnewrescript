import test from "node:test";
import assert from "node:assert/strict";
import { crossCheckQuotas, normaliseQuotaLabel } from "./quotaCrossCheck.js";

const survey = [{ name: "Gender", targetTotal: 1000, cells: [
  { label: "Female", limit: 50, limitType: "percent" as const },
  { label: "Male", limit: 500, limitType: "count" as const },
] }, { name: "Age", cells: [{ label: "18–24", limit: 200 }] }];

test("labels compare loosely: case, dashes, 'to', whitespace", () => {
  assert.equal(normaliseQuotaLabel(" Female "), normaliseQuotaLabel("FEMALE"));
  assert.equal(normaliseQuotaLabel("18–24"), normaliseQuotaLabel("18-24"));
  assert.equal(normaliseQuotaLabel("18 to 24"), normaliseQuotaLabel("18-24"));
});

test("a target set in both places with the same number agrees; a different number is a conflict", () => {
  const r = crossCheckQuotas(survey, [
    { label: "Female", criteria: { gender: "female" }, targetCompletes: 500 },
    { label: "Male", criteria: { gender: "male" }, targetCompletes: 600 },
  ], 1000);
  assert.equal(r.notes.length, 2);
  assert.equal(r.notes.find((n) => n.surveyCell === "Female")?.kind, "agree");
  const male = r.notes.find((n) => n.surveyCell === "Male")!;
  assert.equal(male.kind, "disagree");
  assert.equal(male.surveyCompletes, 500);
  assert.equal(male.recruitmentCompletes, 600);
  assert.match(male.statement, /turned away mid-interview/);
  assert.equal(r.conflicts, 1);
  assert.match(r.statement!, /different numbers/);
});

test("a recruitment cell matches on a criterion value as well as its label", () => {
  const r = crossCheckQuotas(survey, [{ label: "Young adults", criteria: { ageBand: "18-24" }, targetCompletes: 150 }], 1000);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].kind, "disagree");
  assert.match(r.notes[0].statement, /never be reached/);
});

test("a percentage cap with no base to resolve is reported, not guessed", () => {
  const r = crossCheckQuotas([{ name: "Gender", cells: [{ label: "Female", limit: 50, limitType: "percent" }] }], [{ label: "Female", targetCompletes: 500 }], null);
  assert.equal(r.notes[0].surveyCompletes, null);
  assert.equal(r.notes[0].kind, "disagree");
  assert.match(r.notes[0].statement, /no base/);
});

test("nothing in common, nothing said", () => {
  const r = crossCheckQuotas(survey, [{ label: "London", criteria: { region: "london" }, targetCompletes: 100 }], 1000);
  assert.equal(r.notes.length, 0);
  assert.equal(r.statement, null);
});
