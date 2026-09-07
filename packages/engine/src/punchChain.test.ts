import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  walkPunchChain, activePunchRules, lintPunchChain,
  createResponseState, setAnswer, resolvePunches,
} from "./index.js";

/**
 * IF / ELSE IF / ELSE (§8, §23).
 *
 * Auto punch already carried a full nested condition on every rule; what it
 * had no notion of was ELSE. The tests split in two: the chain walk on its
 * own (pure, no survey needed) and then the same chain driving a real punch,
 * because the second is what proves the wiring rather than the algorithm.
 */

type R = { id: string; when?: unknown; mode?: "if" | "else_if" | "else" };
const r = (id: string, mode?: R["mode"], when: unknown = true): R => ({ id, mode, when });

/** `holds` reads the rule's own `when`, which the fixtures set to a boolean. */
const applied = (rules: R[]) =>
  activePunchRules(rules, (x) => x.when !== false).map((x) => x.id);

/* --------------------------------------------------------- the chain walk */

test("INDEPENDENT RULES ARE UNCHANGED — which is every rule that exists today", () => {
  /*
   * The regression guard for the whole feature. `mode` is absent on every
   * punch rule in every survey, and absent must mean exactly what it meant
   * before: independent, in order, all of them.
   */
  assert.deepEqual(applied([r("a"), r("b"), r("c")]), ["a", "b", "c"]);
  assert.deepEqual(applied([r("a", undefined, false), r("b")]), ["b"]);
});

test("THE FIRST MATCH IN A CHAIN WINS — Heavy / Medium / Light", () => {
  const chain = (heavy: boolean, medium: boolean) => applied([
    r("heavy", "if", heavy),
    r("medium", "else_if", medium),
    r("light", "else"),
  ]);
  assert.deepEqual(chain(true, true), ["heavy"], "the first branch, and only it");
  assert.deepEqual(chain(false, true), ["medium"]);
  assert.deepEqual(chain(false, false), ["light"], "the else catches what is left");
});

test("an ELSE has no condition of its own — being reached IS its condition", () => {
  assert.deepEqual(applied([r("a", "if", false), r("z", "else", false)]), ["z"],
    "the else's own `when` is ignored");
});

test("A SKIPPED BRANCH IS NOT EVALUATED AT ALL", () => {
  /*
   * Not an optimisation — a guarantee. A condition that is expensive, or that
   * writes to a trace collector, must not run for a branch the chain has
   * already settled.
   */
  const seen: string[] = [];
  activePunchRules(
    [r("a", "if"), r("b", "else_if"), r("c", "else")],
    (x) => { seen.push(x.id); return true; },
  );
  assert.deepEqual(seen, ["a"], "b and c were never asked");
});

test("two chains are independent", () => {
  const out = applied([
    r("a1", "if", false), r("a2", "else"),
    r("b1", "if", true), r("b2", "else"),
  ]);
  assert.deepEqual(out, ["a2", "b1"], "each chain settles on its own");
});

test("an independent IF after a chain closes the chain", () => {
  const out = applied([
    r("a", "if", true), r("a2", "else_if", true),
    r("b", "if", true),
  ]);
  assert.deepEqual(out, ["a", "b"], "b is a new chain, so it runs even though a matched");
});

test("AN ORPHANED ELSE STARTS ITS OWN CHAIN, and therefore runs", () => {
  /*
   * The one judgement call. Treating it as part of a chain that does not
   * exist would make it silently never run — which is the worst outcome
   * available, because it looks configured and does nothing.
   */
  assert.deepEqual(applied([r("orphan", "else")]), ["orphan"]);
  assert.deepEqual(applied([r("orphan", "else_if", true)]), ["orphan"]);
  assert.deepEqual(applied([r("orphan", "else_if", false)]), [],
    "…on its own merits, so a false condition still fails");
});

test("the walk reports why each rule did or did not apply", () => {
  const steps = walkPunchChain(
    [r("a", "if", false), r("b", "else_if", true), r("c", "else")],
    (x) => x.when !== false,
  );
  assert.deepEqual(steps.map((s) => [s.rule.id, s.reached, s.held, s.applied]), [
    ["a", true, false, false],
    ["b", true, true, true],
    ["c", false, false, false],
  ]);
  assert.deepEqual(steps.map((s) => s.chain), [0, 0, 0], "all one chain");
});

/* ==================================================== driving a real punch */

const survey = (punches: unknown[]) => SurveyDefinition.parse({
  meta: { id: "s1", code: "S1", title: "Chains", version: "1.0" },
  questions: [
    {
      id: "q_brands", code: "Q2", variableName: "BRANDS", type: "multi_select", text: "Which?",
      options: [
        { code: "a", label: "Apple" }, { code: "b", label: "Bosch" },
        { code: "c", label: "Candy" }, { code: "d", label: "Dell" },
        { code: "e", label: "Electrolux" },
      ],
    },
    {
      id: "q_seg", code: "Q10", variableName: "SEGMENT", type: "single_select", text: "Segment",
      options: [
        { code: "heavy", label: "Heavy User" },
        { code: "medium", label: "Medium User" },
        { code: "light", label: "Light User" },
      ],
      punches,
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_brands"] },
    { type: "page", id: "p2", questionIds: ["q_seg"] },
    { type: "end", id: "e1", status: "complete" },
  ],
});

const countAtLeast = (n: number) => cond.minCount("q_brands", n);

const punchFor = (brands: string[], punches: unknown[]) => {
  const def = survey(punches);
  const state = createResponseState(def, { seed: 1 });
  setAnswer(def, state, "q_brands", brands);
  return resolvePunches(def.questions[1], { def, state, loop: null } as never);
};

test("THE BRIEF'S EXAMPLE, END TO END: Heavy / Medium / Light in three rules", () => {
  /*
   * Before this, the second rule needed `COUNT >= 3 AND NOT COUNT >= 5` and
   * the third the negation of both — written by hand, and rewritten every
   * time a threshold moved.
   */
  const punches = [
    { id: "p1", mode: "if", action: "select", when: countAtLeast(5), source: { kind: "codes", codes: ["heavy"] } },
    { id: "p2", mode: "else_if", action: "select", when: countAtLeast(3), source: { kind: "codes", codes: ["medium"] } },
    { id: "p3", mode: "else", action: "select", source: { kind: "codes", codes: ["light"] } },
  ];

  assert.deepEqual(punchFor(["a", "b", "c", "d", "e"], punches).select, ["heavy"]);
  assert.deepEqual(punchFor(["a", "b", "c"], punches).select, ["medium"]);
  assert.deepEqual(punchFor(["a"], punches).select, ["light"]);
  assert.deepEqual(punchFor([], punches).select, ["light"]);
});

test("WITHOUT THE CHAIN, THE SAME THREE RULES ALL FIRE — which is why ELSE was needed", () => {
  /*
   * The counterfactual, asserted. With `mode` absent the rules are
   * independent and last-writer-wins, so a respondent with five brands is
   * punched Heavy, then Medium, then Light. That is the behaviour every
   * survey has today and it is preserved exactly — the chain is opt-in.
   */
  const independent = [
    { id: "p1", action: "select", when: countAtLeast(5), source: { kind: "codes", codes: ["heavy"] } },
    { id: "p2", action: "select", when: countAtLeast(3), source: { kind: "codes", codes: ["medium"] } },
    { id: "p3", action: "select", source: { kind: "codes", codes: ["light"] } },
  ];
  assert.deepEqual(
    punchFor(["a", "b", "c", "d", "e"], independent).select.sort(),
    ["heavy", "light", "medium"],
    "all three, because nothing said they were alternatives",
  );
});

test("a chain works with set_value as well as select", () => {
  const punches = [
    { id: "p1", mode: "if", action: "set_value", when: countAtLeast(3), source: { kind: "codes", codes: ["heavy"] } },
    { id: "p2", mode: "else", action: "set_value", source: { kind: "codes", codes: ["light"] } },
  ];
  assert.deepEqual(punchFor(["a", "b", "c"], punches).setValue, ["heavy"]);
  assert.deepEqual(punchFor(["a"], punches).setValue, ["light"]);
});

test("THE ANSWER SIDE AND THE LIST SIDE CHAIN SEPARATELY", () => {
  /*
   * A `hide` rule must not satisfy an `else` that a `select` rule was waiting
   * for. They are different lists applied at different points in the run, so
   * they are chained independently — and this asserts it rather than trusting
   * it: the `select` else still fires even though a `hide` rule matched.
   */
  const punches = [
    { id: "h", mode: "if", action: "hide", when: countAtLeast(1), source: { kind: "codes", codes: ["heavy"] } },
    { id: "s", mode: "else", action: "select", source: { kind: "codes", codes: ["light"] } },
  ];
  const res = punchFor(["a"], punches);
  assert.deepEqual(res.select, ["light"],
    "the select branch chained on its own list, where nothing had matched");
});

/* ------------------------------------------------------------------ lint */

test("an ELSE with a condition is reported — the condition is ignored", () => {
  const problems = lintPunchChain([
    { id: "a", mode: "if", when: true },
    { id: "z", mode: "else", when: true },
  ] as never);
  assert.ok(problems.some((p) => /is an ELSE but also has a condition/.test(p)), problems.join(" | "));
});

test("an ELSE IF with no condition is reported — nothing after it can run", () => {
  const problems = lintPunchChain([
    { id: "a", mode: "if", when: true },
    { id: "b", mode: "else_if" },
    { id: "c", mode: "else_if", when: true },
  ] as never);
  assert.ok(problems.some((p) => /ELSE IF with no condition/.test(p)), problems.join(" | "));
});

test("A RULE AFTER THE ELSE IS UNREACHABLE, and is said to be", () => {
  const problems = lintPunchChain([
    { id: "a", mode: "if", when: true },
    { id: "z", mode: "else" },
    { id: "late", mode: "else_if", when: true },
  ] as never);
  assert.ok(problems.some((p) => /can never run/.test(p)), problems.join(" | "));
  assert.ok(problems.some((p) => /Move it above the ELSE/.test(p)));
});

test("an orphaned ELSE is reported as starting its own chain", () => {
  const problems = lintPunchChain([{ id: "orphan", mode: "else" }] as never);
  assert.ok(problems.some((p) => /no IF above it/.test(p)), problems.join(" | "));
  assert.ok(problems.some((p) => /runs on its own merits/.test(p)));
});

test("a well-formed chain lints silently, and so does a list of independent rules", () => {
  assert.deepEqual(lintPunchChain([
    { id: "a", mode: "if", when: true },
    { id: "b", mode: "else_if", when: true },
    { id: "c", mode: "else" },
  ] as never), []);
  assert.deepEqual(lintPunchChain([{ id: "a" }, { id: "b" }] as never), []);
});
