import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  applyQuotaEdit, filterQuotas, quotaDashboard, quotaEditDiff, quotaReferences, sortQuotas, validateQuotaEdit,
} from "./quotaDashboard.js";

/**
 * THE DASHBOARD IS A VIEW OF THE ENGINE'S OWN MODEL.
 *
 * Every number it shows must come from `def.quotas` and the counters, with the
 * same `effectiveLimit` the router uses — so a cell the dashboard calls FULL is
 * exactly a cell `checkQuotas` would turn a respondent away on.
 */

const rule = (ref: string, value: unknown) => ({ type: "rule" as const, source: { kind: "question" as const, ref }, operator: "eq" as const, value });
const and = (...children: any[]) => ({ type: "group" as const, op: "and" as const, children });

function fixture(extra: Partial<{ flow: unknown[]; listFills: unknown[]; quotas: unknown[] }> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Quotas", version: "1.0" },
    questions: [
      { id: "q_gender", code: "Q12", variableName: "GENDER", type: "single_select", text: "What is your <b>gender</b>?", options: [{ code: 1, label: "Male" }, { code: 2, label: "Female" }] },
      { id: "q_age", code: "Q13", variableName: "AGE_GROUP", type: "single_select", text: "Age group", options: [{ code: 1, label: "18–24" }, { code: 2, label: "25–34" }] },
    ],
    quotas: extra.quotas ?? [
      {
        id: "quota_gender", name: "Gender Quota", mode: "hard",
        cells: [
          { id: "male", label: "Male", when: rule("q_gender", 1), limit: 150, target: 140 },
          { id: "female", label: "Female", when: rule("q_gender", 2), limit: 150 },
        ],
      },
      {
        id: "quota_age", name: "Age Quota", mode: "hard", targetTotal: 200,
        cells: [
          { id: "young", label: "18–24", when: rule("q_age", 1), limit: 25, limitType: "percent" },
          { id: "mid", label: "25–34", when: rule("q_age", 2), limit: 75, limitType: "percent" },
        ],
      },
      {
        id: "quota_cross", name: "Gender × Age", mode: "hard",
        cells: [{ id: "m_young", label: "Male 18–24", when: and(rule("q_gender", 1), rule("q_age", 1)), limit: 30 }],
      },
      { id: "quota_idle", name: "Idle soft quota", mode: "soft", cells: [{ id: "any", label: "Everyone", when: and(), limit: 0 }] },
    ],
    flow: extra.flow ?? [
      { type: "page", id: "p1", questionIds: ["q_gender", "q_age"] },
      { type: "quota_check", id: "qc1", quotaIds: ["quota_gender", "quota_age"], onFull: { kind: "terminate" } },
      { type: "end", id: "e", status: "complete" },
    ],
    listFills: extra.listFills ?? [],
  });
}

const COUNTS = { quota_gender: { male: 123, female: 141 }, quota_age: { young: 50, mid: 100 }, quota_cross: { m_young: 5 } };

test("rows: target vs maximum vs current vs both remainings, percent limits resolved through the target total", () => {
  const dash = quotaDashboard(fixture(), COUNTS);
  const gender = dash.quotas.find((q) => q.id === "quota_gender")!;
  const male = gender.cells[0];
  assert.equal(male.maximum, 150); assert.equal(male.targetCount, 140); assert.equal(male.current, 123);
  assert.equal(male.remainingToMaximum, 27); assert.equal(male.remainingToTarget, 17); assert.equal(male.pct, 82);
  assert.equal(male.state, "ACTIVE");
  const female = gender.cells[1];
  assert.equal(female.remainingToTarget, null, "no target configured → no remaining-to-target");
  assert.equal(female.state, "NEAR_FULL", "141/150 = 94 %");
  assert.equal(gender.state, "NEAR_FULL");
  assert.equal(gender.current, 264); assert.equal(gender.maximum, 300); assert.equal(gender.remaining, 36); assert.equal(gender.pct, 88);

  const age = dash.quotas.find((q) => q.id === "quota_age")!;
  assert.equal(age.cells[0].maximum, 50, "25 % of 200"); assert.equal(age.cells[0].state, "FULL");
  assert.equal(age.cells[1].maximum, 150); assert.equal(age.cells[1].state, "ACTIVE");
  assert.equal(age.state, "NEAR_FULL", "one full cell does not make the quota full while another is open");
});

test("source questions, dimensions and readable conditions come from the cell rules — HTML stripped", () => {
  const dash = quotaDashboard(fixture(), COUNTS);
  const gender = dash.quotas.find((q) => q.id === "quota_gender")!;
  assert.deepEqual(gender.sources.map((s) => [s.code, s.text, s.variableName, s.type]), [["Q12", "What is your gender?", "GENDER", "single_select"]]);
  assert.equal(gender.dimensions, 1);
  assert.match(gender.cells[0].condition, /^Q12 is .Male.$/);
  const cross = dash.quotas.find((q) => q.id === "quota_cross")!;
  assert.deepEqual(cross.sources.map((s) => s.code), ["Q12", "Q13"]);
  assert.equal(cross.dimensions, 2);
  assert.match(cross.cells[0].condition, /Q12 is .Male. AND Q13 is .18–24./);
});

test("INACTIVE = configured and counted but enforced nowhere; UNLIMITED = no effective maximum", () => {
  const dash = quotaDashboard(fixture(), COUNTS);
  const cross = dash.quotas.find((q) => q.id === "quota_cross")!;
  assert.equal(cross.enforced, false); assert.equal(cross.state, "INACTIVE");
  assert.equal(cross.current, 5, "…but its counts are still shown");
  const idle = dash.quotas.find((q) => q.id === "quota_idle")!;
  assert.equal(idle.cells[0].state, "UNLIMITED"); assert.equal(idle.cells[0].pct, null);
  // a List Fill that respects every hard quota enforces the hard ones implicitly
  const withLf = quotaDashboard(fixture({ listFills: [{ id: "lf1", name: "LF_001", source: { kind: "static", items: [] }, tracking: { respectQuotas: true } }] }), COUNTS);
  assert.equal(withLf.quotas.find((q) => q.id === "quota_cross")!.state, "ACTIVE");
  assert.deepEqual(withLf.quotas.find((q) => q.id === "quota_cross")!.references.listFills, [{ id: "lf1", name: "LF_001", explicit: false }]);
  assert.equal(withLf.quotas.find((q) => q.id === "quota_idle")!.state, "INACTIVE", "a soft quota is not consulted by List Fill");
});

test("summary: counts by state, remaining capacity and a WEIGHTED utilization", () => {
  const { summary } = quotaDashboard(fixture(), COUNTS);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.byState, { FULL: 0, NEAR_FULL: 2, ACTIVE: 0, UNLIMITED: 0, INACTIVE: 2 });
  // male 27 + female 9 + young 0 + mid 50 + m_young 25
  assert.equal(summary.remainingCapacity, 111);
  assert.equal(summary.currentTotal, 123 + 141 + 50 + 100 + 5);
  assert.equal(summary.maximumTotal, 150 + 150 + 50 + 150 + 30);
  assert.equal(summary.utilization, 79.1);
  const none = quotaDashboard(fixture({ quotas: [{ id: "x", name: "x", cells: [{ id: "c", label: "c", when: and(), limit: 0 }] }] }), {});
  assert.equal(none.summary.utilization, null, "no maximum anywhere → no percentage invented");
});

test("references: quota_check nodes, List Fills (explicit and implicit) and quota.<id> rules anywhere", () => {
  const def = fixture({
    listFills: [{ id: "lf_explicit", name: "LF_003", source: { kind: "static", items: [] }, tracking: { respectQuotas: true, quotaIds: ["quota_gender"] } }],
  });
  (def.questions[1] as any).displayLogic = { type: "rule", source: { kind: "quota", ref: "quota_gender" }, operator: "lt", value: 300 };
  const refs = quotaReferences(def, "quota_gender");
  assert.deepEqual(refs.quotaChecks, [{ nodeId: "qc1", onFull: "terminate" }]);
  assert.deepEqual(refs.listFills, [{ id: "lf_explicit", name: "LF_003", explicit: true }]);
  assert.deepEqual(refs.conditions, [{ where: "Q13 display logic" }]);
  assert.deepEqual(quotaReferences(def, "quota_age").listFills, [], "an explicit list does not implicitly include the others");
});

test("search matches name, question code/text/variable, cell label and condition; filters and sorts work on real state", () => {
  const rows = quotaDashboard(fixture(), COUNTS).quotas;
  assert.deepEqual(filterQuotas(rows, "gender", "all").map((r) => r.id), ["quota_gender", "quota_cross"]);
  assert.deepEqual(filterQuotas(rows, "AGE_GROUP", "all").map((r) => r.id), ["quota_age", "quota_cross"]);
  assert.deepEqual(filterQuotas(rows, "female", "all").map((r) => r.id), ["quota_gender"]);
  assert.deepEqual(filterQuotas(rows, "", "inactive").map((r) => r.id), ["quota_cross", "quota_idle"]);
  assert.deepEqual(filterQuotas(rows, "", "near_full").map((r) => r.id), ["quota_gender", "quota_age"]);
  assert.deepEqual(sortQuotas(rows, "status").map((r) => r.id), ["quota_gender", "quota_age", "quota_cross", "quota_idle"], "needs-attention first: the fuller NEAR_FULL (88 %) before the other (75 %), then INACTIVE");
  const byName = sortQuotas(rows, "name").map((r) => r.name);
  assert.deepEqual(byName, [...byName].sort((a, b) => a.localeCompare(b)));
  assert.equal(byName[0], "Age Quota");
  assert.deepEqual(sortQuotas(rows, "current", "desc").map((r) => r.id), ["quota_gender", "quota_age", "quota_cross", "quota_idle"]);
});

test("edits: validation blocks impossible values, warns on over-cap, and applyQuotaEdit changes nothing else", () => {
  const def = fixture();
  const gender = def.quotas[0];
  // Maximum below Target
  let check = validateQuotaEdit(gender, { cells: [{ cellId: "male", limit: 100 }] }, COUNTS);
  assert.ok(check.errors.some((e) => /Maximum \(100\) must be greater than or equal to Target \(140\)/.test(e.message)));
  // over-cap: 123 collected, new maximum 100 (after dropping the target too)
  check = validateQuotaEdit(gender, { cells: [{ cellId: "male", limit: 100, target: null }] }, COUNTS);
  assert.deepEqual(check.errors, []);
  assert.equal(check.warnings.length, 1);
  assert.match(check.warnings[0].message, /current response count \(123\) already exceeds the new maximum \(100\)/);
  // negatives, decimals, percent > 100, percent without a base
  assert.ok(validateQuotaEdit(gender, { cells: [{ cellId: "female", limit: -1 }] }, COUNTS).errors.length);
  assert.ok(validateQuotaEdit(gender, { cells: [{ cellId: "female", limit: 10.5 }] }, COUNTS).errors.length);
  assert.ok(validateQuotaEdit(gender, { cells: [{ cellId: "female", limit: 120, limitType: "percent" }] }, COUNTS).errors.some((e) => /cannot exceed 100%/.test(e.message)));
  assert.ok(validateQuotaEdit(gender, { cells: [{ cellId: "female", limit: 50, limitType: "percent" }] }, COUNTS).errors.some((e) => /target total/.test(e.message)));
  assert.ok(validateQuotaEdit(gender, { name: "  " }, COUNTS).errors.some((e) => e.field === "name"));
  // a clean edit
  check = validateQuotaEdit(gender, { name: "Gender", cells: [{ cellId: "male", limit: 175 }, { cellId: "female", target: 120 }] }, COUNTS);
  assert.deepEqual(check.errors, []); assert.deepEqual(check.warnings, []);
  assert.equal(check.next.cells[0].limit, 175); assert.equal(check.next.cells[1].target, 120);
  assert.deepEqual(check.next.cells[0].when, gender.cells[0].when, "conditions untouched");
  assert.equal(gender.cells[0].limit, 150, "the original is not mutated");
  assert.deepEqual(quotaEditDiff(gender, check.next), {
    name: { before: "Gender Quota", after: "Gender" },
    "cell.male.limit": { before: 150, after: 175 },
    "cell.female.target": { before: null, after: 120 },
  });
  // raising a maximum that is ALREADY exceeded is not a new over-cap
  const over = applyQuotaEdit(gender, { cells: [{ cellId: "male", limit: 100, target: null }] });
  assert.deepEqual(validateQuotaEdit(over, { cells: [{ cellId: "male", limit: 110 }] }, COUNTS).warnings, []);
});
