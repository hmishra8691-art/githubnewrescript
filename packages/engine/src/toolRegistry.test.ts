import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { SURVEY_ACTION_OPS } from "./surveyActions.js";
import { TOOLS, toolByName, dryRunTool, approvalSatisfied, toolCallRecord, inputHash, surveyOpRisk } from "./toolRegistry.js";

/* THE TOOL CONTRACT (audit P3-01 gate: "every engine action callable as a tool with an audit record") */

const def = SurveyDefinition.parse({
  meta: { id: "t", code: "T", title: "Tools", version: "1", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Do you own a car?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Which brand?" },
  ],
  flow: [{ type: "page", id: "p1", title: "Main", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
});

test("every questionnaire action is a tool, classified, with a capability and a policy; names are unique", () => {
  const names = new Set<string>();
  for (const t of TOOLS) { assert.ok(!names.has(t.name), `duplicate ${t.name}`); names.add(t.name); }
  for (const op of SURVEY_ACTION_OPS) {
    const t = toolByName(`survey.${op}`);
    assert.ok(t, `survey.${op} is a tool`);
    assert.equal(t!.executor, "survey_action");
    assert.ok(t!.risk && t!.approval && t!.capability, op);
  }
  for (const t of TOOLS) {
    assert.ok(t.summary.length > 10, t.name);
    if (t.executor === "compute") assert.deepEqual([t.risk, t.approval], ["read", "none"], `${t.name}: a calculation changes nothing`);
    if (t.executor === "route") assert.ok(t.route && /^\/api\//.test(t.route.path) && t.params.length > 0, `${t.name} declares its route and parameters`);
    if (t.risk !== "read") assert.notEqual(t.approval, "none", `${t.name}: a change never runs without a person`);
    if (["publish", "external", "spend", "data", "destructive_data", "destructive_draft"].includes(t.risk)) assert.equal(t.approval, "explicit", t.name);
  }
  assert.equal(surveyOpRisk("delete_question"), "destructive_draft");
  assert.equal(surveyOpRisk("connect_panel"), "external");
  for (const engine of ["design", "analytics", "quality", "data", "deployment", "translation", "recruitment"]) assert.ok(TOOLS.some((t) => t.engine === engine), `${engine} has tools`);
});

test("a dry run says what would happen, returns the diff, and changes nothing", () => {
  const before = JSON.stringify(def);
  const r = dryRunTool(def, "survey.update_question", { target: "Q2", text: "Which brand do you drive most?" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.approval, "confirm");
  assert.ok(r.description[0].length > 0);
  assert.equal(r.diff.changed, 1);
  assert.equal(JSON.stringify(def), before, "the survey is untouched");
  assert.equal(r.after!.questions.find((q) => q.id === "q2")!.text, "Which brand do you drive most?");
});

test("a destructive dry run raises the approval to explicit; malformed input and unknown tools are refused", () => {
  const del = dryRunTool(def, "survey.delete_question", { target: "Q1" });
  assert.equal(del.approval, "explicit");
  assert.ok(del.diff.removed >= 1);
  const bad = dryRunTool(def, "survey.set_validation", { target: "Q404", rules: "nope" });
  assert.equal(bad.ok, false); assert.ok(bad.refused);
  assert.equal(dryRunTool(def, "survey.no_such_op", {}).ok, false);
  const route = dryRunTool(def, "data.export", { format: "csv" });
  assert.equal(route.ok, false); assert.match(route.refused!, /runs through GET \/api\/surveys\/\{id\}\/responses/);
});

test("approval: read needs none; confirm needs a person; explicit needs a person who says what they acknowledged", () => {
  assert.deepEqual(approvalSatisfied("none", null), { ok: true });
  assert.equal(approvalSatisfied("confirm", null).ok, false);
  assert.equal(approvalSatisfied("confirm", { by: "u1", level: "confirm", at: "t" }).ok, true);
  assert.equal(approvalSatisfied("explicit", { by: "u1", level: "confirm", at: "t" }).ok, false);
  assert.equal(approvalSatisfied("explicit", { by: "u1", level: "explicit", at: "t" }).ok, false, "explicit without an acknowledgement");
  assert.equal(approvalSatisfied("explicit", { by: "u1", level: "explicit", at: "t", acknowledged: "Deletes Q1 and the skip that reads it" }).ok, true);
});

test("every call has a record: questionnaire input kept, route input (which may hold personal data) only hashed", () => {
  const t = toolByName("survey.update_question")!;
  const rec = toolCallRecord(t, "dry_run", { kind: "agent", userId: "u1", agent: "fieldwork" }, { target: "Q2", text: "x" }, { ok: true, description: ["Renamed"], destructive: [] }, null, "2026-11-18T00:00:00Z");
  assert.equal(rec.tool, "survey.update_question"); assert.equal(rec.phase, "dry_run"); assert.deepEqual(rec.input, { target: "Q2", text: "x" });
  const erase = toolCallRecord(toolByName("data.erase_person")!, "refused", { kind: "person", userId: "u1" }, { identifier: { kind: "email", value: "ana@example.test" } }, { ok: false, description: [], destructive: [], refused: "needs explicit approval" });
  assert.equal(erase.input, undefined);
  assert.ok(!JSON.stringify(erase).includes("ana@example.test"));
  assert.equal(inputHash({ a: 1, b: [2, 3] }), inputHash({ b: [2, 3], a: 1 }), "key order does not change the hash");
  assert.notEqual(inputHash({ a: 1 }), inputHash({ a: 2 }));
});
