import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { programmingAuditRows } from "./programmingAudit.js";

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const rule = (ref: string, value: unknown) => ({ type: "rule", source: { kind: "question", ref }, operator: "eq", value });

test("one row per finding, in QA-sheet columns, worst first", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "a", code: "A", title: "Audit", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Own a car?", options: opts("Yes", "No"), displayLogic: rule("ghost", 1) },
      { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "You said {{Q3}}", options: opts("A", "B"), displayLogic: rule("q1", 9) },
      { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Later", options: opts("X", "Y") },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3"] }],
  });
  const rows = programmingAuditRows(def);
  assert.ok(rows.length >= 3, JSON.stringify(rows.map((r) => r.issue)));
  const ref = rows.find((r) => r.location === "Q1" && r.category === "Invalid reference");
  assert.ok(ref, "the reference to a question that does not exist");
  assert.equal(ref!.severity, "Critical");
  assert.ok(rows.some((r) => r.location === "Q2" && /option coded/.test(r.issue)), "a value no option has");
  assert.ok(rows.some((r) => r.location === "Q2" && (r.category === "Order dependency" || r.category === "Piping")), "piping a later question");
  for (const r of rows) for (const k of ["severity", "category", "location", "object", "issue", "expected", "actual", "correction"] as const) assert.ok(r[k], `${k} filled`);
  const rank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  for (let i = 1; i < rows.length; i++) assert.ok(rank[rows[i - 1]!.severity] <= rank[rows[i]!.severity]);
});

test("a clean survey has no rows", () => {
  const def = SurveyDefinition.parse({ meta: { id: "b", code: "B", title: "Clean", version: "1" }, questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Hi", options: opts("A", "B") }], flow: [{ type: "page", id: "p", questionIds: ["q1"] }] });
  assert.deepEqual(programmingAuditRows(def), []);
});
