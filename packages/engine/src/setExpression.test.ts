import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type SetExpr } from "@rescript/schema";
import {
  evaluateSetExpr, parseSetExpression, formatSetExpression, setExpressionSummary,
  setExprSources, validateSetExpr, pipelineToSetExpr, resolvePunches, applyPunches,
} from "./setExpression.js";
import { effectiveQuestion, explainOptions } from "./carryforward.js";
import { createResponseState, answerKey } from "./state.js";
import { detectLogicCycles } from "./dependencies.js";
import { start, advance } from "./flow.js";

/* ------------------------------------------------------------- fixtures */

/**
 * Four brand lists that line up by code, so masks and punches can be checked
 * against each other, plus a target question carrying the special options a
 * mask must never remove.
 */
const brands = (id: string, code: string) => ({
  id, code, variableName: code, type: "multi_select", text: `${code}?`,
  options: [
    { code: "a", label: "Alpha" },
    { code: "b", label: "Beta" },
    { code: "c", label: "Gamma" },
    { code: "d", label: "Delta" },
  ],
});

const def = () =>
  SurveyDefinition.parse({
    meta: { id: "sx", code: "SX", title: "Sets", version: "1.0" },
    questions: [
      brands("q5", "Q5"),
      brands("q6", "Q6"),
      brands("q7", "Q7"),
      {
        id: "q8", code: "Q8", variableName: "Q8", type: "multi_select", text: "Which?",
        options: [
          { code: "a", label: "Alpha" },
          { code: "b", label: "Beta" },
          { code: "c", label: "Gamma" },
          { code: "d", label: "Delta" },
          { code: "other", label: "Other", flags: ["other_specify"] },
          { code: "none", label: "None of these", flags: ["none_of_above"] },
        ],
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q5", "q6", "q7"] },
      { type: "page", id: "p2", questionIds: ["q8"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

/** Evaluate a set expression against a set of answers. */
const run = (expr: SetExpr, answers: Record<string, unknown>, targetId = "q8") => {
  const d = def();
  const state = createResponseState(d);
  Object.assign(state.answers, answers);
  const target = d.questions.find((q) => q.id === targetId);
  return evaluateSetExpr(expr, { def: d, state, loop: null }, { target }).map(String);
};

/** Parse text, asserting it is clean, and return the tree. */
const parsed = (src: string, d = def()): SetExpr => {
  const r = parseSetExpression(d, src);
  assert.deepEqual(r.errors, [], `${src}: ${JSON.stringify(r.errors)}`);
  assert.ok(r.expr, `a tree for ${src}`);
  return r.expr!;
};

const ref = (questionId: string, selection: any = "selected"): SetExpr =>
  ({ kind: "ref", questionId, selection });

/* ================================================== §32: the three slices */

test("§2: Selected, Unselected and Options are three different sets", () => {
  const answers = { q5: ["a", "b"] };
  assert.deepEqual(run(ref("q5", "selected"), answers), ["a", "b"]);
  assert.deepEqual(run(ref("q5", "unselected"), answers), ["c", "d"],
    "what they were shown and did not pick");
  assert.deepEqual(run(ref("q5", "all"), answers), ["a", "b", "c", "d"]);
});

test("an unanswered question has nothing selected and everything unselected", () => {
  assert.deepEqual(run(ref("q5", "selected"), {}), []);
  assert.deepEqual(run(ref("q5", "unselected"), {}), ["a", "b", "c", "d"]);
});

/* ============================================= §29: the set operations */

test("§29: UNION, INTERSECTION and DIFFERENCE on the brief's own example", () => {
  // Q5 = {A, B}, Q6 = {B, C}
  const answers = { q5: ["a", "b"], q6: ["b", "c"] };
  assert.deepEqual(run({ kind: "op", operator: "union", left: ref("q5"), right: ref("q6") }, answers),
    ["a", "b", "c"]);
  assert.deepEqual(run({ kind: "op", operator: "intersection", left: ref("q5"), right: ref("q6") }, answers),
    ["b"]);
  assert.deepEqual(run({ kind: "op", operator: "difference", left: ref("q5"), right: ref("q6") }, answers),
    ["a"]);
});

test("§6: DIFFERENCE is not symmetric, and the tree says which way round", () => {
  const answers = { q5: ["a", "b"], q6: ["b", "c"] };
  const aMinusB: SetExpr = { kind: "op", operator: "difference", left: ref("q5"), right: ref("q6") };
  const bMinusA: SetExpr = { kind: "op", operator: "difference", left: ref("q6"), right: ref("q5") };
  assert.deepEqual(run(aMinusB, answers), ["a"]);
  assert.deepEqual(run(bMinusA, answers), ["c"]);
});

test("a union keeps the order codes first appear, so a mask never reshuffles", () => {
  const answers = { q5: ["d", "b"], q6: ["a", "b"] };
  assert.deepEqual(run({ kind: "op", operator: "union", left: ref("q5"), right: ref("q6") }, answers),
    ["d", "b", "a"]);
});

test("§4: COMPLEMENT is “everything this question has that is not in the set”", () => {
  const answers = { q5: ["a", "b"] };
  assert.deepEqual(run({ kind: "complement", of: ref("q5") }, answers, "q5"),
    ["c", "d"]);
  // scoped to the TARGET question's own list, which may be longer
  assert.deepEqual(run({ kind: "complement", of: ref("q5") }, answers, "q8"),
    ["c", "d", "other", "none"]);
});

test("literal codes are a set too", () => {
  assert.deepEqual(run({ kind: "codes", codes: ["a", "c"] }, {}), ["a", "c"]);
});

/* ================================================= §7: nested set trees */

test("§7: (Q5 UNION Q6) DIFFERENCE Q7 — the brief's worked example", () => {
  const expr: SetExpr = {
    kind: "op", operator: "difference",
    left: { kind: "op", operator: "union", left: ref("q5"), right: ref("q6") },
    right: ref("q7"),
  };
  // Q5={a,b}, Q6={b,c}, Q7={c}  →  {a,b,c} \ {c} = {a,b}
  assert.deepEqual(run(expr, { q5: ["a", "b"], q6: ["b", "c"], q7: ["c"] }), ["a", "b"]);
});

test("§7: nesting on the RIGHT is the case a flat pipeline cannot express", () => {
  // A UNION (B INTERSECTION C) — a left-to-right pipeline would compute
  // (A UNION B) INTERSECTION C, which is a different set
  const nested: SetExpr = {
    kind: "op", operator: "union",
    left: ref("q5"),
    right: { kind: "op", operator: "intersection", left: ref("q6"), right: ref("q7") },
  };
  const flat: SetExpr = {
    kind: "op", operator: "intersection",
    left: { kind: "op", operator: "union", left: ref("q5"), right: ref("q6") },
    right: ref("q7"),
  };
  const answers = { q5: ["a"], q6: ["b", "c"], q7: ["c", "d"] };
  assert.deepEqual(run(nested, answers), ["a", "c"], "A ∪ (B ∩ C)");
  assert.deepEqual(run(flat, answers), ["c"], "(A ∪ B) ∩ C");
});

test("§7: Q5.Options DIFFERENCE (Q5.Selected UNION Q6.Selected)", () => {
  const expr: SetExpr = {
    kind: "op", operator: "difference",
    left: ref("q5", "all"),
    right: { kind: "op", operator: "union", left: ref("q5"), right: ref("q6") },
  };
  assert.deepEqual(run(expr, { q5: ["a"], q6: ["b"] }), ["c", "d"]);
});

/* ============================================= §12–13, §26: text round trip */

test("§13: the expression and the tree are two views of one thing", () => {
  const src = "(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected";
  const tree = parsed(src);
  assert.equal(formatSetExpression(def(), tree), src);
  // and re-parsing the printed form gives the same tree
  assert.deepEqual(parsed(formatSetExpression(def(), tree)), tree);
});

test("every construct round-trips as an identity", () => {
  const sources = [
    "Q5.Selected",
    "Q5.Unselected",
    "Q5.Options",
    "Q5.Displayed",
    "Q5.Selected UNION Q6.Selected",
    "Q5.Selected INTERSECTION Q6.Selected",
    "Q5.Selected DIFFERENCE Q6.Selected",
    "(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected",
    "(Q5.Selected INTERSECTION Q6.Selected) UNION Q7.Selected",
    "Q5.Options DIFFERENCE (Q5.Selected UNION Q6.Selected)",
    "NOT Q5.Selected",
    "[a, b]",
  ];
  for (const src of sources) {
    const first = parsed(src);
    const printed = formatSetExpression(def(), first);
    assert.deepEqual(parsed(printed), first, `${src} → ${printed}`);
    assert.equal(formatSetExpression(def(), parsed(printed)), printed, `stable: ${src}`);
  }
});

test("references resolve to stable ids, so renaming cannot break a mask (§28)", () => {
  const tree = parsed("Q5.Selected") as any;
  assert.equal(tree.questionId, "q5", "the id, not the code");

  // rename the question's CODE and the stored tree still resolves
  const renamed = def();
  renamed.questions[0].code = "QQ99";
  const answers = { q5: ["a"] };
  const state = createResponseState(renamed);
  Object.assign(state.answers, answers);
  assert.deepEqual(
    evaluateSetExpr(tree, { def: renamed, state, loop: null }).map(String),
    ["a"],
  );
  // and it prints with the new code
  assert.equal(formatSetExpression(renamed, tree), "QQ99.Selected");
});

test("EXCLUDE, MINUS and INTERSECT are accepted spellings", () => {
  for (const src of ["Q5.Selected EXCLUDE Q6.Selected", "Q5.Selected MINUS Q6.Selected"]) {
    const t = parsed(src) as any;
    assert.equal(t.operator, "difference", src);
  }
  assert.equal((parsed("Q5.Selected INTERSECT Q6.Selected") as any).operator, "intersection");
});

test("malformed set expressions are refused with a useful message", () => {
  const cases: [string, RegExp][] = [
    ["Q99.Selected", /Q99 does not exist/],
    ["Q5.Nonsense", /is not a selection/],
    ["Q5.Selected UNION", /ends with UNION/],
    ["(Q5.Selected UNION Q6.Selected", /Missing closing parenthesis/],
    ["Q5.Selected)", /Unmatched closing parenthesis/],
    ["Q5.Selected Q6.Selected", /is an operator missing/],
    ["Q5.A.B", /too many parts/],
  ];
  for (const [src, re] of cases) {
    const r = parseSetExpression(def(), src);
    assert.ok(r.errors.length > 0, `refused: ${src}`);
    assert.match(r.errors[0].message, re, src);
    assert.equal(r.expr, undefined, `no tree for ${src}`);
  }
});

test("mixing set operators without brackets is accepted but flagged", () => {
  const r = parseSetExpression(def(), "Q5.Selected UNION Q6.Selected DIFFERENCE Q7.Selected");
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].message, /left to right/);
  // left-associative, as documented
  assert.deepEqual(run(r.expr!, { q5: ["a"], q6: ["b"], q7: ["b"] }), ["a"]);

  // brackets settle it, and say nothing
  assert.equal(
    parseSetExpression(def(), "(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected").warnings.length,
    0,
  );
});

test("the plain-English summary reads as a sentence", () => {
  const s = setExpressionSummary(def(), parsed("(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected"));
  assert.match(s, /what Q5 selected/);
  assert.match(s, /but not/);
});

/* ======================================== §8–9, §30: masking a real question */

/** Effective options of Q8 given a mask and some answers. */
const maskedOptions = (mask: any, answers: Record<string, unknown>) => {
  const d = def();
  d.questions[3].mask = mask;
  const state = createResponseState(d);
  Object.assign(state.answers, answers);
  const view = effectiveQuestion(d.questions[3], { def: d, state, loop: null });
  return view.options.map((o) => String(o.code));
};

test("§1: a mask shows exactly the computed set", () => {
  const shown = maskedOptions(
    { expr: parsed("Q5.Selected UNION Q6.Selected"), action: "display", keepAlwaysShow: false },
    { q5: ["a"], q6: ["b"] },
  );
  assert.deepEqual(shown, ["a", "b"]);
});

test("§8/§30: special options survive a mask, including one that returns nothing", () => {
  const withSpecials = maskedOptions(
    { expr: parsed("Q5.Selected UNION Q6.Selected"), action: "display", keepAlwaysShow: true },
    { q5: ["a"], q6: ["b"] },
  );
  assert.deepEqual(withSpecials, ["a", "b", "other", "none"],
    "Other and None of these are still answerable");

  const emptyMask = maskedOptions(
    { expr: parsed("Q5.Selected"), action: "display", keepAlwaysShow: true },
    {},
  );
  assert.deepEqual(emptyMask, ["other", "none"],
    "a mask that matches nothing must not leave a dead-end question");

  // and with the protection off, the programmer gets exactly what they asked
  assert.deepEqual(
    maskedOptions({ expr: parsed("Q5.Selected"), action: "display", keepAlwaysShow: false }, {}),
    [],
  );
});

test("an option flagged Always Show survives a mask too", () => {
  const d = def();
  d.questions[3].options[3].logic = { visibility: "always_show" } as any;
  d.questions[3].mask = {
    expr: parsed("Q5.Selected"), action: "display", keepAlwaysShow: true,
  } as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a"];
  const view = effectiveQuestion(d.questions[3], { def: d, state, loop: null });
  assert.deepEqual(view.options.map((o) => String(o.code)), ["a", "d", "other", "none"]);
});

test("action: remove drops the computed set instead of keeping it", () => {
  // remove takes OUT what the set matched; everything else stays, including
  // the special options, which were never in the set to begin with
  const shown = maskedOptions(
    { expr: parsed("Q5.Selected"), action: "remove", keepAlwaysShow: false },
    { q5: ["a", "b"] },
  );
  assert.deepEqual(shown, ["c", "d", "other", "none"]);

  // and it is the exact inverse of `display` over the same set
  const displayed = maskedOptions(
    { expr: parsed("Q5.Selected"), action: "display", keepAlwaysShow: false },
    { q5: ["a", "b"] },
  );
  assert.deepEqual(displayed, ["a", "b"]);
});

test("a mask never invents an option the question does not define", () => {
  const d = def();
  // Q5 has a code Q8 does not
  d.questions[0].options.push({ code: "zz", label: "Zeta", flags: [] } as any);
  d.questions[3].mask = { expr: parsed("Q5.Selected"), action: "display", keepAlwaysShow: false } as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a", "zz"];
  const view = effectiveQuestion(d.questions[3], { def: d, state, loop: null });
  assert.deepEqual(view.options.map((o) => String(o.code)), ["a"]);
});

test("a mask with a `when` only applies while the condition holds", () => {
  const mask = {
    expr: parsed("Q5.Selected"),
    action: "display",
    keepAlwaysShow: false,
    when: { type: "rule", source: { kind: "question", ref: "q7" }, operator: "selected", value: "a" },
  };
  assert.deepEqual(maskedOptions(mask, { q5: ["a"], q7: ["a"] }), ["a"], "condition true — masked");
  assert.equal(maskedOptions(mask, { q5: ["a"], q7: ["b"] }).length, 6, "condition false — untouched");
});

test("the mask appears as its own stage in the option debugger", () => {
  const d = def();
  d.questions[3].mask = { expr: parsed("Q5.Selected"), action: "display", keepAlwaysShow: false } as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a"];
  const trace = explainOptions(d.questions[3], { def: d, state, loop: null });
  const stages = trace.stages.map((st: any) => st.key);
  assert.ok(stages.includes("mask"), `the mask is traced: ${stages.join(", ")}`);
  const maskStage = trace.stages.find((st: any) => st.key === "mask")!;
  assert.deepEqual(maskStage.after, ["a"], "and shows what it left");
  assert.ok(maskStage.removed.length > 0, "and what it took out");
});

/* ============================================ §14–16, §19: auto-selection */

test("§14: a punch rule ticks the matching options", () => {
  const d = def();
  d.questions[3].punches = [
    { id: "p1", source: parsed("Q5.Selected"), action: "select", mapping: [], ignoreUnmatched: true, recompute: "once" },
  ] as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a", "c"];
  const res = resolvePunches(d.questions[3], { def: d, state, loop: null });
  assert.deepEqual(res.select.map(String), ["a", "c"]);
});

test("§14: the source can be any set expression", () => {
  const d = def();
  d.questions[3].punches = [
    { id: "p1", source: parsed("Q5.Selected UNION Q6.Selected"), action: "select", mapping: [], ignoreUnmatched: true, recompute: "once" },
  ] as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a"];
  state.answers.q6 = ["b"];
  assert.deepEqual(
    resolvePunches(d.questions[3], { def: d, state, loop: null }).select.map(String),
    ["a", "b"],
  );
});

test("§16: an explicit mapping sends a source code to a different target code", () => {
  const d = def();
  d.questions[3].punches = [
    {
      id: "p1", source: parsed("Q5.Selected"), action: "select",
      mapping: [{ from: "a", to: "d" }, { from: "b", to: "a" }],
      ignoreUnmatched: true, recompute: "once",
    },
  ] as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a", "b", "c"];
  const res = resolvePunches(d.questions[3], { def: d, state, loop: null });
  assert.deepEqual(res.select.map(String), ["d", "a", "c"],
    "mapped where told, identity where not");
});

test("a source code the target question does not have is dropped, or reported", () => {
  const d = def();
  d.questions[0].options.push({ code: "zz", label: "Zeta", flags: [] } as any);
  const rule = {
    id: "p1", source: parsed("Q5.Selected"), action: "select", mapping: [],
    ignoreUnmatched: true, recompute: "once",
  };
  d.questions[3].punches = [rule] as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a", "zz"];
  assert.deepEqual(
    resolvePunches(d.questions[3], { def: d, state, loop: null }).select.map(String),
    ["a"], "never writes a code the question cannot show",
  );

  d.questions[3].punches = [{ ...rule, ignoreUnmatched: false }] as any;
  assert.deepEqual(
    resolvePunches(d.questions[3], { def: d, state, loop: null }).unmatched.map(String),
    ["zz"], "reported instead, for the editor to show",
  );
});

test("§21: a punch rule can be conditional, using the ordinary logic engine", () => {
  const d = def();
  d.questions[3].punches = [
    {
      id: "p1", source: parsed("Q5.Selected"), action: "select", mapping: [],
      ignoreUnmatched: true, recompute: "once",
      when: { type: "rule", source: { kind: "question", ref: "q7" }, operator: "selected", value: "a" },
    },
  ] as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a"];
  state.answers.q7 = ["b"];
  assert.deepEqual(resolvePunches(d.questions[3], { def: d, state, loop: null }).select, [],
    "condition false — nothing punched");
  state.answers.q7 = ["a"];
  assert.deepEqual(
    resolvePunches(d.questions[3], { def: d, state, loop: null }).select.map(String), ["a"],
  );
});

test("a punch never overwrites an answer the respondent gave", () => {
  const d = def();
  d.questions[3].punches = [
    { id: "p1", source: parsed("Q5.Selected"), action: "select", mapping: [], ignoreUnmatched: true, recompute: "once" },
  ] as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a", "b"];
  state.answers.q8 = ["d"];               // the respondent chose Delta
  const written = applyPunches(d.questions[3], { def: d, state, loop: null }, (q) => answerKey(q.id));
  assert.equal(written, null, "left alone");
  assert.deepEqual(state.answers.q8, ["d"]);
});

test("recompute: always refreshes a derived question on every visit", () => {
  const d = def();
  d.questions[3].punches = [
    { id: "p1", source: parsed("Q5.Selected"), action: "select", mapping: [], ignoreUnmatched: true, recompute: "always" },
  ] as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a", "b"];
  state.answers.q8 = ["d"];
  applyPunches(d.questions[3], { def: d, state, loop: null }, (q) => answerKey(q.id));
  assert.deepEqual((state.answers.q8 as string[]).sort(), ["a", "b", "d"],
    "adds the punched codes to what is there");
});

test("§17–19: FOR EACH is this rule with an identity mapping", () => {
  /*
   * "FOR EACH option IN Q5.Selected → punch the matching option into Q8" has
   * no separate construct because it does not need one: the rule already
   * iterates the set and maps each code. There is no expression to execute,
   * which is what keeps §20's security requirement trivially satisfied.
   */
  const d = def();
  d.questions[3].punches = [
    { id: "p1", source: parsed("Q5.Selected"), action: "select", mapping: [], ignoreUnmatched: true, recompute: "once" },
  ] as any;
  const state = createResponseState(d);
  state.answers.q5 = ["a", "b", "c", "d"];
  applyPunches(d.questions[3], { def: d, state, loop: null }, (q) => answerKey(q.id));
  assert.deepEqual(state.answers.q8, ["a", "b", "c", "d"], "every selected option punched through");
});

test("§22: the runtime punches a page's questions as the respondent reaches it", () => {
  const d = def();
  d.questions[3].punches = [
    { id: "p1", source: parsed("Q5.Selected"), action: "select", mapping: [], ignoreUnmatched: true, recompute: "once" },
  ] as any;
  const state = createResponseState(d);
  start(d, state, {});
  state.answers.q5 = ["b", "c"];
  assert.equal(state.answers.q8, undefined, "not before the page is reached");
  advance(d, state, {});                    // land on page 2, which holds Q8
  assert.deepEqual(state.answers.q8, ["b", "c"], "punched on arrival");
});

/* ============================================== §31: invalid references */

test("§31: a question cannot mask itself", () => {
  const d = def();
  const issues = validateSetExpr(d, "q8", parsed("Q8.Selected UNION Q5.Selected"));
  assert.ok(issues.some((i) => i.level === "error" && /cannot mask itself/.test(i.message)));
  // masking something else is fine
  assert.deepEqual(validateSetExpr(d, "q8", parsed("Q5.Selected")), []);
});

test("§31: two questions masking each other is a cycle the linter finds", () => {
  const d = def();
  d.questions[1].mask = { expr: parsed("Q7.Selected"), action: "display", keepAlwaysShow: true } as any;
  d.questions[2].mask = { expr: parsed("Q6.Selected"), action: "display", keepAlwaysShow: true } as any;
  const cycles = detectLogicCycles(d);
  assert.ok(cycles.length > 0, "the mask edges are in the dependency graph");
  assert.ok(
    cycles.some((c) => c.includes("q6") && c.includes("q7")),
    `Q6 ↔ Q7 reported: ${JSON.stringify(cycles)}`,
  );
});

test("a punch rule's sources are dependency edges too", () => {
  const d = def();
  d.questions[3].punches = [
    { id: "p1", source: parsed("Q5.Selected"), action: "select", mapping: [], ignoreUnmatched: true, recompute: "once" },
  ] as any;
  assert.ok(setExprSources(d.questions[3].punches![0].source).has("q5"));
  d.questions[0].mask = { expr: parsed("Q8.Selected"), action: "display", keepAlwaysShow: true } as any;
  const cycles = detectLogicCycles(d);
  assert.ok(cycles.some((c) => c.includes("q5") && c.includes("q8")),
    `Q5 masks Q8 while Q8 punches from Q5: ${JSON.stringify(cycles)}`);
});

test("a mask pointing at a deleted question is reported", () => {
  const d = def();
  const expr = parsed("Q5.Selected");
  d.questions = d.questions.filter((q) => q.id !== "q5");
  assert.ok(validateSetExpr(d, "q8", expr).some((i) => /no longer exists/.test(i.message)));
});

/* ================================ reading the older sequential pipeline */

test("an existing set-only pipeline reads as a tree, meaning the same thing", () => {
  const d = def();
  d.questions[3].optionPipeline = [
    { id: "o1", kind: "carry_forward", sources: [{ questionId: "q5", which: "selected" }], keepOwn: false },
    { id: "o2", kind: "union", sources: [{ questionId: "q6", which: "selected" }], keepOwn: false },
    { id: "o3", kind: "exclude", sources: [{ questionId: "q7", which: "selected" }], keepOwn: false },
  ] as any;
  const expr = pipelineToSetExpr(d.questions[3]);
  assert.ok(expr, "converted");
  assert.equal(formatSetExpression(d, expr),
    "(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected");

  // and it computes what the pipeline computes
  const answers = { q5: ["a", "b"], q6: ["b", "c"], q7: ["c"] };
  assert.deepEqual(run(expr!, answers), ["a", "b"]);
});

test("a pipeline with presentation steps is NOT a set expression, and says so", () => {
  const d = def();
  d.questions[3].optionPipeline = [
    { id: "o1", kind: "carry_forward", sources: [{ questionId: "q5", which: "selected" }], keepOwn: false },
    { id: "o2", kind: "randomize", sources: [], keepOwn: false, method: "shuffle" },
  ] as any;
  assert.equal(pipelineToSetExpr(d.questions[3]), null,
    "left alone rather than half-converted");
});

/* ================================================= §22: save and reload */

test("§22: a mask and its punches survive a JSON round trip", () => {
  const d = def();
  d.questions[3].mask = {
    expr: parsed("(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected"),
    action: "display", keepAlwaysShow: true,
  } as any;
  d.questions[3].punches = [
    {
      id: "p1", source: parsed("Q5.Selected"), action: "select",
      mapping: [{ from: "a", to: "d" }], ignoreUnmatched: true, recompute: "once",
    },
  ] as any;

  const reloaded = SurveyDefinition.parse(JSON.parse(JSON.stringify(d)));
  const q8 = reloaded.questions[3];
  assert.deepEqual(q8.mask, d.questions[3].mask, "the tree came back identical");
  assert.deepEqual(q8.punches, d.questions[3].punches);
  assert.equal(
    formatSetExpression(reloaded, q8.mask!.expr),
    "(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected",
  );
});

test("a survey with no mask and no punches behaves exactly as before", () => {
  const d = def();
  const state = createResponseState(d);
  state.answers.q5 = ["a"];
  const view = effectiveQuestion(d.questions[3], { def: d, state, loop: null });
  assert.deepEqual(view.options.map((o) => String(o.code)),
    ["a", "b", "c", "d", "other", "none"], "every option, untouched");
  assert.deepEqual(resolvePunches(d.questions[3], { def: d, state, loop: null }).select, []);
});
