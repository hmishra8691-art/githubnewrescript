import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition } from "@rescript/schema";
import { interpretRequest } from "./nlIntent.js";

/**
 * CONSOLIDATION PASS (Phase 7) — the audit's §F sentences that still went to
 * the model although the engine owned the answer.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const rule = (ref: string, operator: string, value: unknown): Condition => ({ type: "rule", source: { kind: "question", ref }, operator, value } as Condition);
function fixture(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "BS", title: "Brand switching" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
      { id: "q3", code: "Q3", variableName: "BRAND_PREF", type: "single_select", text: "Which brand do you prefer?", options: opts("Brand A", "Brand B") },
      { id: "q4", code: "Q4", variableName: "SAT", type: "single_select", text: "How satisfied are you?", options: opts("Low", "High"), displayLogic: rule("q9", "eq", 1) },
      { id: "q5", code: "Q5", variableName: "AGREE", type: "single_select", text: "Don't you agree that Brand A is the best?", options: opts("Yes", "No") },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3", "q4", "q5"] }, { type: "end", id: "e", status: "complete" }],
  });
}

test("a review asked for in a sentence is the engine's review — grouped, narrowed to the area named", () => {
  const def = fixture();
  const all = interpretRequest(def, "Review the entire survey and identify problems with the logic.", {});
  assert.equal(all.kind, "answer");
  if (all.kind !== "answer") return;
  assert.equal(all.category, "quality_control");
  assert.ok(all.detected.some((d) => d.what === "review" && d.value === "logic"));
  assert.ok(all.sections.length >= 1, "Q4 reads q9, which does not exist — a logic finding");
  assert.ok(all.sections.some((s) => s.items.some((i) => /Q4/.test(i.label))), JSON.stringify(all.sections));
  assert.match(all.answer, /^Reviewed the logic: \d+ finding/);
  const itemsOf = (r: typeof all) => r.kind === "answer" ? r.sections.flatMap((s) => s.items) : [];
  assert.ok(!itemsOf(all).some((i) => /Q5/.test(i.label)), "the leading question is wording, not logic — left out when the logic is asked for");

  const whole = interpretRequest(def, "Check the questionnaire", {});
  assert.equal(whole.kind, "answer");
  if (whole.kind === "answer") assert.ok(whole.detected.some((d) => d.what === "review" && d.value === "survey"));

  const wording = interpretRequest(def, "What is wrong with the wording?", {});
  assert.equal(wording.kind, "answer");
  if (wording.kind === "answer") {
    assert.match(wording.understood, /wording/);
    assert.ok(itemsOf(wording).some((i) => /Q5/.test(i.label)), JSON.stringify(wording.sections));
    assert.ok(!itemsOf(wording).some((i) => /Q4/.test(i.label)), "the dead reference is logic, not wording");
  }
  const everything = interpretRequest(def, "Review the whole survey", {});
  if (everything.kind === "answer") { assert.ok(itemsOf(everything).some((i) => /Q4/.test(i.label))); assert.ok(itemsOf(everything).some((i) => /Q5/.test(i.label))); }

  // not a review: an edit that happens to start with "check"
  const not = interpretRequest(def, "Check the gender quota after Q2", {});
  assert.notEqual(not.kind === "answer" && not.category === "quality_control", true);
});

test("'demographic groups' and 'a report showing the key findings' are read by the engine", () => {
  const def = fixture();
  const q = interpretRequest(def, "Which demographic groups are most likely to prefer Brand A?", {});
  assert.equal(q.kind, "query");
  if (q.kind === "query") { assert.equal(q.query.kind, "prefer"); assert.equal(q.query.option?.label, "Brand A"); }
  const o = interpretRequest(def, "Create a report showing the key findings.", {});
  assert.equal(o.kind, "output");
  if (o.kind === "output") assert.equal(o.output.type, "findings_docx");
  const o2 = interpretRequest(def, "Write a report of the results for the board", {});
  assert.equal(o2.kind, "output");
  if (o2.kind === "output") { assert.equal(o2.output.type, "findings_docx"); assert.equal(o2.output.audience, "executive"); }
});
