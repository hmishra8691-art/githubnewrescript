import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { renumberQuestionCodes, resequenceQuestionCodes } from "./renumber.js";

/*
 * R9 — the structures that hold raw codes with no condition wrapper.
 *
 * `grep -c "mask\|punch\|optionGroups\|attentionCheck"` in renumber.ts
 * returned 0. Each of these is a way for a resequence to leave a survey that
 * still renders, still resolves and is quietly wrong.
 */

const survey = (q: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t" },
    questions: [{
      id: "q1", code: "Q1", variableName: "BRAND", type: "multi_select", text: "Which?",
      options: [
        { code: "1", label: "Alpha" }, { code: "3", label: "Beta" },
        { code: "5", label: "Gamma" }, { code: "7", label: "Delta" },
      ],
      ...q,
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
    ...extra,
  });

/** 1,3,5,7 → 1,2,3,4 */
const MAP = { "3": "2", "5": "3", "7": "4" };
const run = (def: ReturnType<typeof survey>) => renumberQuestionCodes(def, "q1", "options", MAP);

test("option GROUPS move with the codes", () => {
  /*
   * Members is "these shuffle together". Left unrewritten, the block that was
   * meant to keep Beta and Gamma adjacent keeps two different brands
   * adjacent instead — on every interview, and nothing says so.
   */
  const def = survey({ optionGroups: [{ id: "g1", name: "Challengers", members: ["3", "5"] }] });
  const out = run(def);
  assert.deepEqual((out.def.questions[0] as never as { optionGroups: { members: string[] }[] }).optionGroups[0].members, ["2", "3"]);
});

test("a MASK's literal codes move with the options it filters", () => {
  const def = survey({
    mask: { expr: { kind: "codes", codes: ["5", "7"] }, action: "display" },
  });
  const out = run(def);
  const expr = (out.def.questions[0] as never as { mask: { expr: { codes: string[] } } }).mask.expr;
  assert.deepEqual(expr.codes, ["3", "4"], "a mask reading codes [5,7] must follow them to [3,4]");
});

test("a mask nested inside set operators is rewritten all the way down", () => {
  const def = survey({
    mask: {
      expr: {
        kind: "op", operator: "union",
        left: { kind: "codes", codes: ["3"] },
        right: { kind: "complement", of: { kind: "codes", codes: ["7"] } },
      },
      action: "display",
    },
  });
  const out = run(def);
  const e = (out.def.questions[0] as never as { mask: { expr: any } }).mask.expr;
  assert.deepEqual(e.left.codes, ["2"]);
  assert.deepEqual(e.right.of.codes, ["4"], "the complement's operand is not skipped");
});

test("an ATTENTION CHECK's expected codes move — otherwise it inverts", () => {
  /*
   * The nastiest of the four. Unrewritten, the respondents who DID follow the
   * instruction are marked as having failed, and their interviews are removed
   * from the dataset as low quality.
   */
  const def = survey({ attentionCheck: { kind: "instruction", expected: ["5"] } });
  const out = run(def);
  assert.deepEqual((out.def.questions[0] as never as { attentionCheck: { expected: string[] } }).attentionCheck.expected, ["3"]);
});

test("a PUNCH's target side moves, and its source side does not follow blindly", () => {
  /*
   * A punch has two namespaces. `to` writes into THIS question, so it moves
   * with this question's codes. `from` reads whatever the source expression
   * names — here another question entirely — so rewriting it would corrupt a
   * mapping that was correct.
   */
  const def = survey({
    punches: [{
      id: "p1",
      source: { kind: "ref", questionId: "q_other", selection: "selected" },
      action: "select",
      mapping: [{ from: "5", to: "5" }],
    }],
  });
  const out = run(def);
  const m = (out.def.questions[0] as never as { punches: { mapping: { from: string; to: string }[] }[] }).punches[0].mapping[0];
  assert.equal(m.to, "3", "the target side follows this question's renumber");
  assert.equal(m.from, "5", "the source side reads another question and must NOT be touched");
});

test("a punch that READS the renumbered question moves its source side too", () => {
  const def = survey({
    punches: [{
      id: "p1",
      source: { kind: "ref", questionId: "q1", selection: "selected" },
      action: "select",
      mapping: [{ from: "5", to: "1" }],
    }],
  });
  const out = run(def);
  const m = (out.def.questions[0] as never as { punches: { mapping: { from: string; to: string }[] }[] }).punches[0].mapping[0];
  assert.equal(m.from, "3", "the source side IS this question's namespace here");
});

test("a calculation that mentions the question is REPORTED, not rewritten", () => {
  /*
   * `IF(BRAND == 3, 1, 0)` and `AGE / 3` are indistinguishable to a regex.
   * Rewriting blindly corrupts the second; skipping silently is what this
   * used to do. Reporting is the only honest third option.
   */
  const def = survey({}, {
    calculations: [
      { id: "c1", label: "Is Beta", targetVariable: "IS_BETA", expression: "IF(BRAND == 3, 1, 0)" },
      { id: "c2", label: "Unrelated", targetVariable: "THIRD", expression: "AGE / 3" },
    ],
  });
  const out = run(def);
  assert.equal(out.needsReview.length, 1, `only the one that names the question: ${JSON.stringify(out.needsReview)}`);
  assert.equal(out.needsReview[0].id, "c1");
  assert.match(out.needsReview[0].expression, /BRAND == 3/);

  /* and it is genuinely left alone, not half-rewritten */
  const calc = (out.def.calculations ?? []).find((c) => c.id === "c1") as { expression: string };
  assert.equal(calc.expression, "IF(BRAND == 3, 1, 0)", "the expression must not be touched");
});

test("a survey with none of these is unchanged, and reports nothing to review", () => {
  const def = survey({});
  const out = run(def);
  assert.deepEqual(out.needsReview, []);
  assert.deepEqual(out.def.questions[0].options.map((o) => String(o.code)), ["1", "2", "3", "4"]);
});

test("resequence carries the same guarantees end to end", () => {
  const def = survey({
    optionGroups: [{ id: "g1", name: "g", members: ["3", "7"] }],
    attentionCheck: { kind: "instruction", expected: ["7"] },
  });
  const out = resequenceQuestionCodes(def, "q1", "options");
  const q = out.def.questions[0] as never as {
    optionGroups: { members: string[] }[]; attentionCheck: { expected: string[] };
  };
  assert.deepEqual(q.optionGroups[0].members, ["2", "4"]);
  assert.deepEqual(q.attentionCheck.expected, ["4"]);
});

/* ------------------------------------------------- the lint half of R9 */

import { lintSurveyLogic } from "./lintLogic.js";

test("a mask reading a code that no longer exists is an ERROR, not silence", async () => {
  /*
   * The lint half. `lintSetExpr` existed and had exactly one caller —
   * punches — so a mask was never looked at, and a mask whose codes were
   * left behind by a renumber renders the wrong options with nothing
   * objecting. With R10 now a gate, this refuses the version cut.
   */
  const def = survey({ mask: { expr: { kind: "codes", codes: ["1", "99"] }, action: "display" } });
  const issues = lintSurveyLogic(def);
  const hit = issues.find((i) => i.path === "mask");
  assert.ok(hit, `the mask was not linted at all: ${JSON.stringify(issues.map((i) => i.path))}`);
  assert.equal(hit!.level, "error");
  assert.match(hit!.message, /99/);
  assert.match(hit!.message, /do(es)? not exist/);
});

test("a mask reading codes that all exist is silent", () => {
  const def = survey({ mask: { expr: { kind: "codes", codes: ["1", "3"] }, action: "display" } });
  assert.equal(lintSurveyLogic(def).filter((i) => i.path === "mask").length, 0);
});

test("a punch writing into a code that does not exist is an ERROR", () => {
  const def = survey({
    punches: [{
      id: "p1", source: { kind: "ref", questionId: "q1", selection: "selected" },
      action: "select", mapping: [{ from: "1", to: "42" }],
    }],
  });
  const hit = lintSurveyLogic(def).find((i) => i.path === "punches[0].mapping");
  assert.ok(hit, "a punch writing into a non-existent code was not reported");
  assert.match(hit!.message, /42/);
});

test("AND THE TWO HALVES AGREE: what renumber rewrites, the lint then accepts", () => {
  /*
   * The assertion that ties R9 together. Renumber a question that carries a
   * mask and an attention check, and the result must lint clean — if the
   * rewrite missed a structure the lint now catches it, and if the lint is
   * wrong about a structure the rewrite handles, this fails too.
   */
  const def = survey({
    mask: { expr: { kind: "codes", codes: ["5", "7"] }, action: "display" },
    optionGroups: [{ id: "g1", name: "g", members: ["3", "5"] }],
    attentionCheck: { kind: "instruction", expected: ["7"] },
  });
  assert.equal(lintSurveyLogic(def).filter((i) => i.level === "error" && i.path === "mask").length, 0,
    "the fixture starts clean");

  const out = resequenceQuestionCodes(def, "q1", "options");
  const after = lintSurveyLogic(out.def).filter((i) => i.level === "error");
  assert.deepEqual(after.map((i) => `${i.path}: ${i.message}`), [],
    "after a renumber the survey must still lint clean — a leftover code list is an error now");
});
