/**
 * DELETING A QUESTION IS A CHANGE TO THE WHOLE SURVEY.
 *
 * Every test here starts from a survey where Q1 is genuinely wired into
 * everything — display logic, a skip rule, a carry-forward, a mask, an auto
 * punch, a quota, a flow branch, an option's own visibility — and deletes it.
 * What must hold afterwards is not merely "the references are gone": it is
 * that nothing was left saying something different from what it said before.
 * A punch that ran "when Q1 >= 5" must not survive as a punch that runs
 * always, and an option must not disappear because the question its
 * visibility rule named did.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond as C } from "@rescript/schema";
import { referencesTo, pruneReferencesTo, pruneReferencesToMany } from "./references.js";

const cond = (qid: string) => ({ all: [{ questionId: qid, operator: "eq", value: "1" }] });

function survey(): any {
  return {
    id: "s", code: "S", title: "T", meta: {}, variables: [],
    flow: [
      { id: "p1", type: "page", questionIds: ["q1", "q2"] },
      {
        id: "br", type: "branch",
        branches: [{ id: "b1", when: cond("q1"), children: [{ id: "p3", type: "page", questionIds: ["q3"] }] }],
        otherwise: [{ id: "p4", type: "page", questionIds: [] }],
      },
    ],
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "", options: [], rows: [], columns: [], validation: [], required: false, settings: {}, skipLogic: [] },
      {
        id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "", rows: [], columns: [],
        validation: [], required: false, settings: {}, skipLogic: [],
        options: [
          { code: "1", label: "Kept", flags: [] },
          { code: "2", label: "Conditional", flags: [], visibleIf: cond("q1") },
          { code: "3", label: "Carried", flags: [], sourceQuestionId: "q1", sourceCode: "9" },
        ],
        displayLogic: cond("q1"),
        carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options", keepOwn: false },
        mask: { expr: { kind: "ref", questionId: "q1", selection: "selected" }, action: "display", keepAlwaysShow: true },
        listLogic: [
          { id: "ll1", sourceQuestionId: "q1", action: "include", which: "selected" },
          { id: "ll2", sourceQuestionId: "q3", action: "exclude", which: "selected" },
        ],
        punches: [
          { id: "pu1", source: { kind: "ref", questionId: "q1", selection: "selected" }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "once" },
          { id: "pu2", source: { kind: "codes", codes: ["1"] }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "once", when: cond("q1") },
          { id: "pu3", source: { kind: "codes", codes: ["2"] }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "once" },
        ],
      },
      {
        id: "q3", code: "Q3", variableName: "Q3", type: "open_text", text: "", options: [], rows: [], columns: [],
        validation: [], required: false, settings: {}, skipLogic: [
          { id: "sk1", when: cond("q1"), target: { kind: "end", status: "screened" } },
          { id: "sk2", when: cond("q2"), target: { kind: "question", ref: "q1" } },
          { id: "sk3", when: cond("q2"), target: { kind: "end", status: "complete" } },
        ],
        displayLogic: { all: [{ questionId: "q1", operator: "eq", value: "1" }, { questionId: "q2", operator: "eq", value: "1" }] },
      },
    ],
    quotas: [
      { id: "qu1", name: "Age", cells: [{ id: "c1", when: cond("q1"), limit: 100 }] },
      { id: "qu2", name: "Region", cells: [{ id: "c2", when: cond("q2"), limit: 50 }] },
    ],
  };
}

test("the preview and the pruning are the same thing", () => {
  const a = referencesTo(survey(), "q1");
  const def = survey();
  const b = pruneReferencesTo(def, "q1");
  assert.deepEqual(a, b, "one function, run twice — a preview cannot drift from what it previews");
  assert.ok(a.length > 0);
});

test("referencesTo does not touch the survey it is asked about", () => {
  const def = survey();
  const before = JSON.stringify(def);
  referencesTo(def, "q1");
  assert.equal(JSON.stringify(def), before, "nothing is decided until somebody says so");
});

test("a rule that named the question is REMOVED, never left running unconditionally", () => {
  const def = survey();
  pruneReferencesTo(def, "q1");
  const q2 = def.questions.find((q: any) => q.id === "q2");

  assert.deepEqual(q2.punches.map((p: any) => p.id), ["pu3"],
    "the punch sourced from Q1 and the punch CONDITIONED on Q1 both go; the unrelated one stays");
  assert.deepEqual(q2.listLogic.map((r: any) => r.id), ["ll2"]);

  const q3 = def.questions.find((q: any) => q.id === "q3");
  assert.deepEqual(q3.skipLogic.map((r: any) => r.id), ["sk3"],
    "a skip whose condition named Q1 goes, and so does one that jumped TO Q1");
});

test("a field the question cannot do without is cleared, and the consequence is stated", () => {
  const def = survey();
  const found = pruneReferencesTo(def, "q1");
  const q2 = def.questions.find((q: any) => q.id === "q2");

  assert.equal(q2.displayLogic, undefined);
  assert.equal(q2.carryForward, undefined);
  assert.equal(q2.mask, undefined);

  const display = found.find((r) => r.path.endsWith("displayLogic") && r.where.startsWith("Q2"));
  assert.ok(display, "the report names it");
  assert.match(display!.effect, /always be shown/,
    "and says what the survey now does, which is the part that matters: " + display!.effect);
  assert.ok(found.some((r) => /every option is shown/.test(r.effect)), "the mask says it too");
});

test("a condition keeps the rules that still resolve", () => {
  const def = survey();
  pruneReferencesTo(def, "q1");
  const q3 = def.questions.find((q: any) => q.id === "q3");
  assert.equal(q3.displayLogic.all.length, 1, "only the leaf naming Q1 goes");
  assert.equal(q3.displayLogic.all[0].questionId, "q2");
});

test("an option is not destroyed by a rule that mentioned the question", () => {
  const def = survey();
  pruneReferencesTo(def, "q1");
  const q2 = def.questions.find((q: any) => q.id === "q2");
  const codes = q2.options.map((o: any) => o.code);
  assert.ok(codes.includes("1"), "an unrelated option is untouched");
  assert.ok(codes.includes("2"), "and so is one whose visibility rule named Q1");
  assert.equal(q2.options.find((o: any) => o.code === "2").visibleIf, undefined,
    "— the rule goes, the option stays");
  assert.ok(!codes.includes("3"), "an option CARRIED from Q1 is not an option any more");
});

test("the question comes off its page, and a flow branch that tested it goes", () => {
  const def = survey();
  const found = pruneReferencesTo(def, "q1");
  assert.deepEqual(def.flow[0].questionIds, ["q2"]);
  assert.equal(def.flow[1].branches.length, 0,
    "a branch cannot be repaired by making it unconditional — everyone would take it");
  assert.ok(def.flow[1].otherwise.length === 1, "the default path it falls through to is untouched");
  assert.ok(found.some((r) => r.kind === "unplaced"));
});

test("a quota whose cell counted the question loses that cell, not the quota beside it", () => {
  const def = survey();
  pruneReferencesTo(def, "q1");
  assert.equal(def.quotas[0].cells.length, 0);
  assert.equal(def.quotas[1].cells.length, 1, "an unrelated quota is not collateral");
});

test("deleting a question nothing points at reports nothing", () => {
  const def = survey();
  /* q3 is referenced only by one list-logic rule; strip it and q3 is inert */
  def.questions[1].listLogic = [];
  assert.deepEqual(
    referencesTo(def, "q3").filter((r) => r.kind !== "unplaced"),
    [],
    "no dialog should appear for a question with no dependants",
  );
});

test("the survey itself always survives", () => {
  const def = survey();
  pruneReferencesTo(def, "q1");
  assert.ok(Array.isArray(def.questions) && def.questions.length === 3,
    "pruning removes references; removing the question is the caller's job");
  assert.ok(Array.isArray(def.flow));
  assert.ok(Array.isArray(def.quotas));
});

/* --------------------------------- references that are not object-shaped ids */

/**
 * Two blind spots, both of which made the delete dialog say "Nothing else in
 * this survey refers to it" about a question that three other things needed.
 */
const codeRefDef = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "t", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "BRAND", type: "single_select", text: "Brand?",
      options: [{ code: "1", label: "Alpha" }, { code: "2", label: "Beta" }] },
    /* the expression editor writes `kind: "variable"`, and the runtime resolves
       it through the same id/code/variableName lookup a picker reference uses */
    { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Why {{Q1}}?",
      displayLogic: C.rule("BRAND", "eq", "1", undefined, { kind: "variable" }) },
    { id: "q3", code: "Q3", variableName: "Q3", type: "open_text", text: "Anything else?" },
  ],
  flow: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3"] }],
});

test("a condition that names the question by VARIABLE is a reference, whatever its kind says", () => {
  const found = referencesTo(codeRefDef(), "q1");
  assert.ok(found.some((r) => r.path.includes("displayLogic")),
    `the display rule on Q2 tests BRAND: ${JSON.stringify(found)}`);

  const def = codeRefDef();
  pruneReferencesTo(def, "q1");
  assert.equal(def.questions[1].displayLogic, undefined,
    "and it is pruned, rather than surviving as a rule that can never resolve");
});

test("a pipe is a reference — the respondent is the one who sees it break", () => {
  const found = referencesTo(codeRefDef(), "q1");
  const pipe = found.find((r) => r.effect.includes("{{Q1}}"));
  assert.ok(pipe, `Q2's text pipes Q1: ${JSON.stringify(found)}`);
  assert.ok(pipe!.where.includes("Q2"));

  /* reported, not rewritten: the sentence is somebody's work */
  const def = codeRefDef();
  pruneReferencesTo(def, "q1");
  assert.equal(def.questions[1].text, "Why {{Q1}}?");
});

test("a question nothing points at reports only its own page slot", () => {
  /* the guard against the opposite failure: a reference check that sees a
     reference everywhere is as useless as one that sees none */
  const found = referencesTo(codeRefDef(), "q3");
  assert.deepEqual(found.map((r) => r.kind), ["unplaced"]);
});

test("deleting a block still sees the codes of the questions inside it", () => {
  const def = codeRefDef();
  /* Q1 goes with the block; Q2 stays and names it by variable and by pipe */
  const found = pruneReferencesToMany(def, ["q1"]);
  assert.ok(found.some((r) => r.path.includes("displayLogic")));
  assert.ok(found.some((r) => r.effect.includes("{{Q1}}")));
});
