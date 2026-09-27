import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { diagnoseQuestion } from "./diagnose.js";

/**
 * "WHY IS Q25 NOT SHOWING?" — every reason, in the order the runtime meets
 * them, and which of them are certain.
 */
const yn = [{ code: 1, label: "Yes" }, { code: 2, label: "No" }];
const rule = (ref: string, operator: string, value?: unknown) => ({ type: "rule", source: { kind: "question", ref }, operator, ...(value !== undefined ? { value } : {}) });
const make = (over: { questions?: object[]; flow?: object[]; displayRules?: object[] } = {}) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: over.questions ?? [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Own a car?", options: yn },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Like it?", options: yn },
    { id: "q3", code: "Q3", variableName: "Q3", type: "text", text: "Why?" },
    { id: "q4", code: "Q4", variableName: "Q4", type: "text", text: "Anything else?" },
  ],
  flow: over.flow ?? [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "page", id: "p3", questionIds: ["q3"] },
    { type: "page", id: "p4", questionIds: ["q4"] },
    { type: "end", id: "e", status: "complete" },
  ],
  displayRules: over.displayRules ?? [],
  deployment: { clientSlug: "c", studySlug: "s" },
});

test("a plain question: always shown", () => {
  const d = diagnoseQuestion(make(), "Q3")!;
  assert.equal(d.verdict, "always");
  assert.match(d.summary, /Nothing in the survey stops Q3/);
  assert.equal(diagnoseQuestion(make(), "Q99"), null);
});

test("display logic: sometimes; on a later answer or itself: never", () => {
  const def = make();
  def.questions[2].displayLogic = rule("q1", "selected", 1) as never;
  let d = diagnoseQuestion(def, "q3")!;
  assert.equal(d.verdict, "sometimes");
  assert.ok(d.findings.some((f) => f.kind === "display_logic" && /shown only when Q1/.test(f.message)));
  def.questions[2].displayLogic = rule("q4", "answered") as never;
  d = diagnoseQuestion(def, "q3")!;
  assert.equal(d.verdict, "never");
  assert.match(d.summary, /reads Q4, which comes after it/);
  def.questions[2].displayLogic = rule("q4", "unanswered") as never;
  assert.equal(diagnoseQuestion(def, "q3")!.verdict, "sometimes", "unanswered is TRUE of a later question — not a never");
  def.questions[2].displayLogic = { type: "group", op: "and", children: [rule("q1", "eq", 1), rule("q1", "eq", 2)] } as never;
  assert.match(diagnoseQuestion(def, "q3")!.summary, /Q1 is a single choice and cannot be both 1 and 2/);
  def.questions[2].displayLogic = { type: "group", op: "or", children: [rule("q1", "eq", 1), rule("q4", "answered")] } as never;
  assert.equal(diagnoseQuestion(def, "q3")!.verdict, "sometimes", "one possible side of an OR is enough");
  def.questions[2].displayLogic = { type: "group", op: "not", children: [{ type: "group", op: "and", children: [] }] } as never;
  assert.match(diagnoseQuestion(def, "q3")!.summary, /constant false/);
});

test("not placed, hidden types and settings", () => {
  const def = make({ flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q4"] }, { type: "end", id: "e", status: "complete" }] });
  assert.match(diagnoseQuestion(def, "q3")!.summary, /not on any page/);
  const h = make(); (h.questions[2] as { type: string }).type = "hidden";
  assert.match(diagnoseQuestion(h, "q3")!.summary, /hidden question — the engine fills it/);
});

test("skip rules before it: an unconditional skip past it is certain; a conditional one is not", () => {
  const def = make();
  def.questions[1].skipLogic = [{ id: "s1", when: rule("q2", "selected", 2), target: { kind: "question", ref: "q4" } }] as never;
  let d = diagnoseQuestion(def, "q3")!;
  assert.equal(d.verdict, "sometimes");
  assert.ok(d.findings.some((f) => f.kind === "skipped_by" && /Q2 skips to Q4, past Q3, when/.test(f.message)));
  const onto = make(); onto.questions[0].skipLogic = [{ id: "s0", when: { type: "group", op: "and", children: [] }, target: { kind: "question", ref: "q3" } }] as never;
  assert.equal(diagnoseQuestion(onto, "q3")!.verdict, "always", "a skip that lands ON it is how it is reached, not a way round it");
  def.questions[0].skipLogic = [{ id: "s2", when: { type: "group", op: "and", children: [] }, target: { kind: "end", status: "complete" } }] as never;
  d = diagnoseQuestion(def, "q3")!;
  assert.equal(d.verdict, "never");
  assert.ok(d.findings.some((f) => f.kind === "skipped_by" && f.severity === "blocking" && /Q1 always skips to the end/.test(f.message)));
  assert.equal(diagnoseQuestion(def, "q1")!.verdict, "always", "a skip rule does not affect its own question");
});

test("the path to it: branches, the paths that win before it, otherwise, randomizers, loops, page conditions", () => {
  const def = make({
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "branch", id: "br", title: "Owners", branches: [
        { id: "b1", when: rule("q1", "selected", 2), children: [{ type: "page", id: "p2", questionIds: ["q2"] }] },
        { id: "b2", when: rule("q1", "selected", 1), children: [{ type: "page", id: "p3", questionIds: ["q3"], visibleIf: rule("q1", "answered") }] },
      ], otherwise: [{ type: "randomizer", id: "rz", show: 1, children: [{ type: "page", id: "p4", questionIds: ["q4"] }, { type: "page", id: "p5", questionIds: [] }] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
  const d3 = diagnoseQuestion(def, "q3")!;
  assert.equal(d3.verdict, "sometimes");
  assert.deepEqual(d3.findings.map((f) => f.kind), ["branch_shadowed", "branch", "container_logic"]);
  assert.match(d3.findings[1].message, /inside branch “Owners” taken only when Q1/);
  const d4 = diagnoseQuestion(def, "q4")!;
  assert.deepEqual(d4.findings.map((f) => f.kind), ["otherwise", "randomizer"]);
  assert.match(d4.findings[1].message, /shows 1 of 2 elements/);
  // a branch condition that can never be true makes everything inside it unreachable
  (def.flow[1] as { branches: { when: unknown }[] }).branches[1].when = rule("q4", "answered");
  assert.equal(diagnoseQuestion(def, "q3")!.verdict, "never");
});

test("display rules on the question or its page", () => {
  const def = make({ displayRules: [{ id: "r1", label: "Owners only", target: { kind: "page", ref: "p3" }, action: "show", when: rule("q1", "selected", 1) }] });
  const d = diagnoseQuestion(def, "q3")!;
  assert.ok(d.findings.some((f) => f.kind === "display_rule" && /“Owners only”/.test(f.message) && /on its page/.test(f.message)));
  assert.equal(diagnoseQuestion(def, "q4")!.verdict, "always", "a rule on another page does not touch it");
});
