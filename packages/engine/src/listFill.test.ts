import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  decideListFill, listFillCandidates, listFillStatus, listFillVariables,
  listFillVariableNames, remainingCapacity, allocationStatus, simulateListFill,
  type ListFillCounts,
} from "./listFill.js";
import type { ResponseState } from "./state.js";

/**
 * The List Fill engine's contract.
 *
 * Two properties matter more than any single behaviour and are checked
 * throughout: the decision is DETERMINISTIC for a given respondent and set of
 * counters (so the builder's simulator, preview, test and production cannot
 * disagree), and every option's fate is EXPLAINED (so a researcher can see
 * why a respondent got what they got without reading the code).
 *
 * Nothing here hardcodes an example. The 150/75/50 numbers appear because the
 * requirement uses them, and the same tests run with different numbers,
 * different option counts and different strategies.
 */

const base = {
  meta: { id: "s", code: "S", title: "List fill", version: "1" },
  questions: [
    {
      id: "q1", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which brands?",
      options: [
        { code: "A", label: "Apple" }, { code: "B", label: "Beta" }, { code: "C", label: "Gamma" },
        { code: "D", label: "Delta" }, { code: "E", label: "Epsilon" },
      ],
    },
    { id: "q2", code: "Q2", variableName: "PICK", type: "single_select", text: "Rate this brand", options: [{ code: "x", label: "x" }] },
    { id: "gender", code: "Q3", variableName: "GENDER", type: "single_select", text: "Gender", options: [{ code: "m", label: "Male" }, { code: "f", label: "Female" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "gender"] }, { type: "end", id: "e", status: "complete" }],
};

/** A List Fill over Q1's selected brands, with whatever option settings a test needs. */
const withListFill = (listFill: Record<string, unknown>) =>
  SurveyDefinition.parse({ ...base, listFills: [listFill] });

const priorityFill = (options: Record<string, unknown>[], selection: Record<string, unknown> = {}) => ({
  id: "lf1", name: "Q1", enabled: true,
  source: { kind: "question", questionId: "q1", take: "selected" },
  selection: { count: { kind: "fixed", n: 1 }, method: "highest_priority", ...selection },
  tracking: { sampleLevel: true },
  options,
  destinations: [{ questionId: "q2", write: "answer" }],
});

const stateWith = (answers: Record<string, unknown>, seed = 42): ResponseState => ({
  surveyId: "s", surveyVersion: "1", sessionId: "sess1", seed,
  startedAt: "2026-09-01T10:00:00Z", status: "in_progress",
  answers: answers as ResponseState["answers"],
  embedded: {}, calculated: {}, flags: [], stepIndex: 0,
});

const counts = (o: Record<string, number>): ListFillCounts => ({ lf1: o });

/* ------------------------------------------------------------ candidates */

test("candidates come from what the respondent selected, in their own order", () => {
  const def = withListFill(priorityFill([{ code: "A" }, { code: "B" }]));
  const pool = listFillCandidates(def, def.listFills[0], stateWith({ q1: ["B", "A"] }));
  assert.deepEqual(pool.map((c) => c.code), ["B", "A"]);
  assert.equal(pool[0].label, "Beta", "labels come from the source question, so piping reads naturally");
});

test("a HIDDEN source question still feeds List Fill — visibility is not execution", () => {
  // the question is never shown; a URL parameter or a calculation populated it
  const def = SurveyDefinition.parse({
    ...base,
    questions: [{ ...base.questions[0], displayIf: { type: "rule", source: { kind: "question", ref: "gender" }, operator: "eq", value: "never" } }, ...base.questions.slice(1)],
    listFills: [priorityFill([{ code: "A", priority: 1 }, { code: "B", priority: 2 }])],
  });
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B"] }) });
  assert.deepEqual(res.items.map((i) => i.code), ["A"], "the allocation runs on the stored answer regardless of display logic");
});

test("`take: all` uses the whole option list, not the selection", () => {
  const def = withListFill({ ...priorityFill([]), source: { kind: "question", questionId: "q1", take: "all" } });
  const pool = listFillCandidates(def, def.listFills[0], stateWith({ q1: ["A"] }));
  assert.deepEqual(pool.map((c) => c.code), ["A", "B", "C", "D", "E"]);
});

test("a static list needs no source question at all", () => {
  const def = withListFill({
    ...priorityFill([{ code: "x", priority: 1 }]),
    source: { kind: "static", items: [{ code: "x", label: "Ex" }, { code: "y", label: "Why" }] },
  });
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({}) });
  assert.deepEqual(res.items.map((i) => i.code), ["x"]);
});

/* ------------------------------------------------------------ §10 sequence */

test("§10: prefer A, then B when A fills, then C, then the fallback pool", () => {
  const options = [
    { code: "A", priority: 1, maximum: 150, target: 150 },
    { code: "B", priority: 2, maximum: 75, target: 75 },
    { code: "C", priority: 3, maximum: 50, target: 50 },
    { code: "D" }, { code: "E" }, // no priority, no cap: the fallback pool
  ];
  const def = withListFill(priorityFill(options, { fallback: "random_eligible", fillToCount: true }));
  const lf = def.listFills[0];
  const state = stateWith({ q1: ["A", "B", "C", "D", "E"] });
  const pick = (c: Record<string, number>) =>
    decideListFill({ def, listFill: lf, state, counts: counts(c) }).items.map((i) => i.code);

  assert.deepEqual(pick({}), ["A"], "A available → prefer A");
  assert.deepEqual(pick({ A: 149 }), ["A"], "A at 149 of 150 → still A");
  assert.deepEqual(pick({ A: 150 }), ["B"], "A FULL → evaluate B");
  assert.deepEqual(pick({ A: 150, B: 75 }), ["C"], "A and B FULL → C");
  assert.deepEqual(
    pick({ A: 150, B: 75, C: 50 }).length, 1,
    "all three capped → the fallback rule supplies one from D/E",
  );
  assert.ok(["D", "E"].includes(pick({ A: 150, B: 75, C: 50 })[0]), "and it comes from the uncapped pool");

  // NOBODY touched the survey to make that happen
  const trace = decideListFill({ def, listFill: lf, state, counts: counts({ A: 150 }) }).trace;
  const a = trace.options.find((o) => o.code === "A")!;
  assert.equal(a.status, "FULL");
  assert.equal(a.rejectedBecause, "maximum_reached");
  assert.match(trace.reason, /A \(its maximum of 150 is reached/);
});

test("the same sequence works with entirely different numbers and four bands", () => {
  const options = [
    { code: "A", priority: 10, maximum: 3 }, { code: "B", priority: 20, maximum: 1 },
    { code: "C", priority: 30, maximum: 2 }, { code: "D", priority: 40 },
  ];
  const def = withListFill(priorityFill(options));
  const lf = def.listFills[0];
  const state = stateWith({ q1: ["A", "B", "C", "D"] });
  const pick = (c: Record<string, number>) => decideListFill({ def, listFill: lf, state, counts: counts(c) }).items[0]?.code;
  assert.equal(pick({}), "A");
  assert.equal(pick({ A: 3 }), "B");
  assert.equal(pick({ A: 3, B: 1 }), "C");
  assert.equal(pick({ A: 3, B: 1, C: 2 }), "D");
});

test("an option the respondent did not select is never allocated, however high its priority", () => {
  const def = withListFill(priorityFill([{ code: "A", priority: 1 }, { code: "B", priority: 2 }]));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["B"] }) });
  assert.deepEqual(res.items.map((i) => i.code), ["B"]);
  assert.equal(res.trace.options.find((o) => o.code === "A")!.rejectedBecause, "not_a_candidate");
});

test("target and maximum are different things: after target, allocation continues", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1, target: 10, maximum: 20 }, { code: "B", priority: 2 }],
    { afterTarget: "continue" },
  ));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B"] }), counts: counts({ A: 10 }) });
  assert.deepEqual(res.items.map((i) => i.code), ["A"], "target reached is not full — `continue` keeps using A");
  assert.equal(res.trace.options.find((o) => o.code === "A")!.status, "TARGET_REACHED");
});

test("afterTarget `stop` removes an option at its target; `reduce_priority` demotes it instead", () => {
  const stop = withListFill(priorityFill([{ code: "A", priority: 1, target: 10, afterTarget: "stop" }, { code: "B", priority: 2 }]));
  assert.deepEqual(
    decideListFill({ def: stop, listFill: stop.listFills[0], state: stateWith({ q1: ["A", "B"] }), counts: counts({ A: 10 }) }).items.map((i) => i.code),
    ["B"], "stop → A is out",
  );

  const demote = withListFill(priorityFill([{ code: "A", priority: 1, target: 10, afterTarget: "reduce_priority" }, { code: "B", priority: 2 }]));
  const res = decideListFill({ def: demote, listFill: demote.listFills[0], state: stateWith({ q1: ["A", "B"] }), counts: counts({ A: 10 }) });
  assert.deepEqual(res.items.map((i) => i.code), ["B"], "demoted → B goes first");
  assert.deepEqual(res.trace.preference, ["B", "A"], "but A stays available behind B");
});

test("a minimum is urgency, not a cap: an option under its minimum is served first", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1, target: 100 }, { code: "B", priority: 1, minimum: 20, target: 100 }],
    { method: "highest_priority", equalPriority: "balanced" },
  ));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B"] }), counts: counts({ A: 5, B: 3 }) });
  assert.deepEqual(res.items.map((i) => i.code), ["B"], "B is below its minimum of 20, so it outranks its equal-priority peer");
});

/* ------------------------------------------------------------ eligibility */

test("a per-option condition uses the ordinary logic engine", () => {
  const def = withListFill(priorityFill([
    { code: "A", priority: 1, eligibleWhen: { type: "rule", source: { kind: "question", ref: "gender" }, operator: "eq", value: "f" } },
    { code: "B", priority: 2 },
  ]));
  const lf = def.listFills[0];
  assert.deepEqual(
    decideListFill({ def, listFill: lf, state: stateWith({ q1: ["A", "B"], gender: "f" }) }).items.map((i) => i.code),
    ["A"], "condition met → A",
  );
  const male = decideListFill({ def, listFill: lf, state: stateWith({ q1: ["A", "B"], gender: "m" }) });
  assert.deepEqual(male.items.map((i) => i.code), ["B"], "condition not met → A is skipped");
  assert.equal(male.trace.options.find((o) => o.code === "A")!.rejectedBecause, "eligibility_condition");
});

test("`eligible: false` disables an option without deleting its history", () => {
  const def = withListFill(priorityFill([{ code: "A", priority: 1, eligible: false }, { code: "B", priority: 2 }]));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B"] }), counts: counts({ A: 40 }) });
  assert.deepEqual(res.items.map((i) => i.code), ["B"]);
  const a = res.trace.options.find((o) => o.code === "A")!;
  assert.equal(a.status, "DISABLED");
  assert.equal(a.current, 40, "its 40 existing allocations are still reported");
});

test("`runWhen` false allocates nothing, and says so", () => {
  const def = withListFill({
    ...priorityFill([{ code: "A", priority: 1 }]),
    runWhen: { type: "rule", source: { kind: "question", ref: "gender" }, operator: "eq", value: "f" },
  });
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A"], gender: "m" }) });
  assert.deepEqual(res.items, []);
  assert.equal(res.trace.skippedBecause, "run_when_false");
  assert.equal(res.trace.ran, false);
});

test("a disabled List Fill is inert", () => {
  const def = withListFill({ ...priorityFill([{ code: "A", priority: 1 }]), enabled: false });
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A"] }) });
  assert.deepEqual(res.items, []);
  assert.equal(res.trace.skippedBecause, "disabled");
});

/* ------------------------------------------------------------ strategies */

test("equal priority + `random` is deterministic per respondent and spreads across respondents", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1 }, { code: "B", priority: 1 }, { code: "C", priority: 1 }],
    { equalPriority: "random" },
  ));
  const lf = def.listFills[0];
  const pickFor = (seed: number) => decideListFill({ def, listFill: lf, state: stateWith({ q1: ["A", "B", "C"] }, seed) }).items[0].code;

  // same respondent, same answer → same result, every time
  assert.equal(pickFor(7), pickFor(7));
  assert.equal(pickFor(7), pickFor(7));
  // across respondents, all three do get used
  const spread = new Set(Array.from({ length: 60 }, (_, i) => pickFor(i + 1)));
  assert.deepEqual([...spread].sort(), ["A", "B", "C"], "no option is starved by the tiebreak");
});

test("equal priority + `balanced` picks whichever equal peer is furthest from its target", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1, target: 100 }, { code: "B", priority: 1, target: 100 }, { code: "C", priority: 1, target: 100 }],
    { equalPriority: "balanced" },
  ));
  const lf = def.listFills[0];
  const state = stateWith({ q1: ["A", "B", "C"] });
  assert.equal(decideListFill({ def, listFill: lf, state, counts: counts({ A: 50, B: 10, C: 30 }) }).items[0].code, "B");
  assert.equal(decideListFill({ def, listFill: lf, state, counts: counts({ A: 50, B: 60, C: 30 }) }).items[0].code, "C");
  assert.equal(decideListFill({ def, listFill: lf, state, counts: counts({ A: 5, B: 60, C: 30 }) }).items[0].code, "A");
});

test("equal priority + `sequential` keeps the configured order", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1 }, { code: "B", priority: 1 }],
    { equalPriority: "sequential" },
  ));
  const lf = def.listFills[0];
  for (const seed of [1, 2, 3, 99]) {
    assert.equal(decideListFill({ def, listFill: lf, state: stateWith({ q1: ["A", "B"] }, seed) }).items[0].code, "A");
  }
});

test("weighted randomisation honours the weights over many respondents", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", weight: 8 }, { code: "B", weight: 1 }, { code: "C", weight: 1 }],
    { method: "weighted_random" },
  ));
  const lf = def.listFills[0];
  const tally: Record<string, number> = { A: 0, B: 0, C: 0 };
  for (let i = 1; i <= 1200; i++) {
    tally[decideListFill({ def, listFill: lf, state: stateWith({ q1: ["A", "B", "C"] }, i) }).items[0].code]++;
  }
  // 8:1:1 — generous bounds, because the point is the direction, not the exact draw
  assert.ok(tally.A > 800 && tally.A < 1050, `A ≈ 80% of 1200, got ${tally.A}`);
  assert.ok(tally.B > 40 && tally.C > 40, `B and C still appear, got ${tally.B}/${tally.C}`);
});

test("`quota_aware_random` prefers whichever option has the most room left", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", maximum: 100 }, { code: "B", maximum: 100 }, { code: "C", maximum: 100 }],
    { method: "quota_aware_random" },
  ));
  const lf = def.listFills[0];
  const state = stateWith({ q1: ["A", "B", "C"] });
  assert.equal(decideListFill({ def, listFill: lf, state, counts: counts({ A: 95, B: 10, C: 90 }) }).items[0].code, "B");
});

test("`selection_order` respects the respondent's own order of selection", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1 }, { code: "B", priority: 2 }, { code: "C", priority: 3 }],
    { method: "selection_order" },
  ));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["C", "A", "B"] }) });
  assert.deepEqual(res.items.map((i) => i.code), ["C"], "priority is ignored by this method, as configured");
});

/* ------------------------------------------------------------ count */

test("a count above one allocates several distinct items, in preference order", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1 }, { code: "B", priority: 2 }, { code: "C", priority: 3 }],
    { count: { kind: "fixed", n: 2 } },
  ));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B", "C"] }) });
  assert.deepEqual(res.items.map((i) => i.code), ["A", "B"]);
  assert.deepEqual(res.items.map((i) => i.position), [1, 2]);
  assert.equal(res.trace.options.find((o) => o.code === "C")!.rejectedBecause, "count_satisfied");
});

test("`count: all` takes every eligible candidate", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1 }, { code: "B", priority: 2, maximum: 5 }, { code: "C", priority: 3 }],
    { count: { kind: "all" } },
  ));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B", "C"] }), counts: counts({ B: 5 }) });
  assert.deepEqual(res.items.map((i) => i.code), ["A", "C"], "B is full, so `all` means all that are usable");
  assert.equal(res.trace.allocatedCount, 2);
  assert.equal(res.trace.requestedCount, 3);
});

test("a count driven by another answer is read from the state", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1 }, { code: "B", priority: 2 }, { code: "C", priority: 3 }],
    { count: { kind: "question", questionId: "q1" } },
  ));
  // three selected → three items
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B", "C"] }) });
  assert.equal(res.items.length, 3);
});

test("short of the required count, the engine allocates what it can and says how many are missing", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1, maximum: 1 }, { code: "B", priority: 2, maximum: 1 }],
    { count: { kind: "fixed", n: 3 } },
  ));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B"] }) });
  assert.equal(res.items.length, 2);
  assert.match(res.trace.reason, /Allocated 2 of 3/);
});

test("no eligible option leaves an empty, explained result rather than an exception", () => {
  const def = withListFill(priorityFill([{ code: "A", priority: 1, maximum: 10 }]));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A"] }), counts: counts({ A: 10 }) });
  assert.deepEqual(res.items, []);
  assert.match(res.trace.reason, /Every candidate was rejected/);
  assert.equal(res.trace.options.find((o) => o.code === "A")!.rejectedBecause, "maximum_reached");
});

/* ------------------------------------------------------------ quota */

test("a hard quota on the allocated brand blocks it, and the next option is used", () => {
  // the quota cell combines the list-fill result WITH gender — multi-dimensional,
  // expressed as an ordinary condition, with nothing hardcoded about List Fill
  const def = SurveyDefinition.parse({
    ...base,
    quotas: [{
      id: "qa", name: "Apple males", mode: "hard", targetTotal: 100,
      cells: [{
        id: "c1", label: "A + male", limit: 20, limitType: "count",
        when: {
          type: "group", op: "and", children: [
            { type: "rule", source: { kind: "calculation", ref: "LISTFILL_Q1_1_CODE" }, operator: "eq", value: "A" },
            { type: "rule", source: { kind: "question", ref: "gender" }, operator: "eq", value: "m" },
          ],
        },
      }],
    }],
    listFills: [{
      ...priorityFill([{ code: "A", priority: 1 }, { code: "B", priority: 2 }]),
      tracking: { sampleLevel: true, respectQuotas: true },
    }],
  });
  const lf = def.listFills[0];

  const male = decideListFill({
    def, listFill: lf, state: stateWith({ q1: ["A", "B"], gender: "m" }),
    quotaCounts: { qa: { c1: 20 } },
  });
  assert.deepEqual(male.items.map((i) => i.code), ["B"], "the A+male cell is full, so this male gets B");
  const a = male.trace.options.find((o) => o.code === "A")!;
  assert.equal(a.rejectedBecause, "quota_full");
  assert.deepEqual(a.quotaBlockedBy, [{ quotaId: "qa", cellId: "c1" }]);

  const female = decideListFill({
    def, listFill: lf, state: stateWith({ q1: ["A", "B"], gender: "f" }),
    quotaCounts: { qa: { c1: 20 } },
  });
  assert.deepEqual(female.items.map((i) => i.code), ["A"], "the same full cell does not affect a female respondent");
});

test("a soft quota never blocks an allocation", () => {
  const def = SurveyDefinition.parse({
    ...base,
    quotas: [{
      id: "qs", name: "soft", mode: "soft", targetTotal: 100,
      cells: [{ id: "c1", label: "A", limit: 1, limitType: "count", when: { type: "rule", source: { kind: "calculation", ref: "LISTFILL_Q1_1_CODE" }, operator: "eq", value: "A" } }],
    }],
    listFills: [{ ...priorityFill([{ code: "A", priority: 1 }, { code: "B", priority: 2 }]), tracking: { sampleLevel: true, respectQuotas: true } }],
  });
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B"] }), quotaCounts: { qs: { c1: 99 } } });
  assert.deepEqual(res.items.map((i) => i.code), ["A"], "soft quotas flag, they do not allocate");
});

test("quotas are ignored entirely when the List Fill does not respect them", () => {
  const def = SurveyDefinition.parse({
    ...base,
    quotas: [{
      id: "qa", name: "q", mode: "hard", targetTotal: 100,
      cells: [{ id: "c1", label: "A", limit: 1, limitType: "count", when: { type: "rule", source: { kind: "calculation", ref: "LISTFILL_Q1_1_CODE" }, operator: "eq", value: "A" } }],
    }],
    listFills: [{ ...priorityFill([{ code: "A", priority: 1 }, { code: "B", priority: 2 }]), tracking: { sampleLevel: true, respectQuotas: false } }],
  });
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B"] }), quotaCounts: { qa: { c1: 99 } } });
  assert.deepEqual(res.items.map((i) => i.code), ["A"]);
});

/* ------------------------------------------------------------ tracking off */

test("with sample-level tracking off, caps are irrelevant and every respondent sees the same preference", () => {
  const def = withListFill({
    ...priorityFill([{ code: "A", priority: 1, maximum: 1 }, { code: "B", priority: 2 }]),
    tracking: { sampleLevel: false },
  });
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B"] }), counts: counts({ A: 9999 }) });
  assert.deepEqual(res.items.map((i) => i.code), ["A"], "counts are not consulted when allocation is not sample-level");
});

/* ------------------------------------------------------------ variables */

test("the LISTFILL_* variables carry the code, the label and the position", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", priority: 1 }, { code: "B", priority: 2 }],
    { count: { kind: "fixed", n: 2 } },
  ));
  const lf = def.listFills[0];
  const res = decideListFill({ def, listFill: lf, state: stateWith({ q1: ["A", "B"] }) });
  const vars = listFillVariables(lf, res);
  assert.equal(vars.LISTFILL_Q1_COUNT, 2);
  assert.equal(vars.LISTFILL_Q1_1_CODE, "A");
  assert.equal(vars.LISTFILL_Q1_1, "Apple", "the label pipes into question text");
  assert.equal(vars.LISTFILL_Q1_2_CODE, "B");
  assert.equal(vars.LISTFILL_Q1_CODES, "A,B", "one exportable column for the whole list");
  assert.equal(vars.LISTFILL_Q1_LABELS, "Apple, Beta");
});

test("the variable NAMES are known before any respondent runs, for the dictionary and exports", () => {
  const def = withListFill(priorityFill([{ code: "A" }, { code: "B" }, { code: "C" }], { count: { kind: "fixed", n: 2 } }));
  const names = listFillVariableNames(def.listFills[0]).map((v) => v.name);
  assert.ok(names.includes("LISTFILL_Q1_COUNT"));
  assert.ok(names.includes("LISTFILL_Q1_1_CODE"));
  assert.ok(names.includes("LISTFILL_Q1_2_CODE"));
  assert.ok(names.includes("LISTFILL_Q1_CODES"));
});

/* ------------------------------------------------------------ trace */

test("the trace explains every option, including ones never offered", () => {
  const def = withListFill(priorityFill([
    { code: "A", priority: 1, maximum: 10 }, { code: "B", priority: 2 }, { code: "Z", priority: 3 },
  ]));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B"] }), counts: counts({ A: 10 }) });
  const codes = res.trace.options.map((o) => o.code).sort();
  assert.deepEqual(codes, ["A", "B", "Z"]);
  assert.equal(res.trace.options.find((o) => o.code === "Z")!.candidate, false);
  assert.ok(res.trace.steps.length > 3, "the steps read as a sequence of decisions");
  assert.ok(res.trace.steps.some((s) => /SELECTED at position 1/.test(s)));
});

test("the preference order is the whole ordered list, so a lost race can fall to the next option", () => {
  const def = withListFill(priorityFill([{ code: "A", priority: 1 }, { code: "B", priority: 2 }, { code: "C", priority: 3 }]));
  const res = decideListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B", "C"] }) });
  assert.deepEqual(res.items.map((i) => i.code), ["A"], "one item is requested");
  assert.deepEqual(res.preference, ["A", "B", "C"], "but the allocator is told what to try if A is taken");
});

/* ------------------------------------------------------------ status */

test("capacity and status describe an option without deciding anything", () => {
  assert.equal(remainingCapacity({ code: "A", eligible: true }, 500), null, "no maximum means unlimited, not zero");
  assert.equal(remainingCapacity({ code: "A", eligible: true, maximum: 150 }, 149), 1);
  assert.equal(remainingCapacity({ code: "A", eligible: true, maximum: 150 }, 150), 0);
  assert.equal(allocationStatus({ code: "A", eligible: true, maximum: 100 }, 100, true), "FULL");
  assert.equal(allocationStatus({ code: "A", eligible: true, maximum: 100 }, 95, true), "NEAR_CAP");
  assert.equal(allocationStatus({ code: "A", eligible: true, target: 10, maximum: 100 }, 10, true), "TARGET_REACHED");
  assert.equal(allocationStatus({ code: "A", eligible: true, maximum: 100 }, 5, true), "ACTIVE");
  assert.equal(allocationStatus({ code: "A", eligible: false }, 5, true), "DISABLED");
  assert.equal(allocationStatus({ code: "A", eligible: true }, 5, false), "INELIGIBLE");
});

test("the dashboard reports fill and still shows an option that has been removed from the config", () => {
  const def = withListFill(priorityFill([
    { code: "A", priority: 1, maximum: 150, target: 150 }, { code: "B", priority: 2, maximum: 75 },
  ]));
  const status = listFillStatus(def.listFills[0], counts({ A: 150, B: 30, GONE: 4 }));
  assert.equal(status.total, 184);
  const a = status.rows.find((r) => r.code === "A")!;
  assert.equal(a.status, "FULL");
  assert.equal(a.fill, 100);
  assert.equal(a.remaining, 0);
  const gone = status.rows.find((r) => r.code === "GONE")!;
  assert.equal(gone.current, 4, "allocations already made cannot be hidden by editing the option list");
  assert.equal(gone.strategy, "no longer configured");
});

/* ------------------------------------------------------------ §31 simulator */

test("§31: the simulator runs the real engine against its own counters", () => {
  const def = withListFill(priorityFill([
    { code: "A", priority: 1, maximum: 150, target: 150 },
    { code: "B", priority: 2, maximum: 75, target: 75 },
    { code: "C", priority: 3, maximum: 50, target: 50 },
  ]));
  const lf = def.listFills[0];
  const sim = simulateListFill({
    def, listFill: lf, state: stateWith({ q1: ["A", "B", "C"] }),
    counts: counts({ A: 149, B: 75, C: 20 }), draws: 40,
  });
  // A has one slot, B is full, C has thirty
  assert.equal(sim.counts.A, 150, "A takes its last slot and then stops");
  assert.equal(sim.counts.B, 75, "B was already full and gains nothing");
  assert.equal(sim.counts.C, 50, "C absorbs the next thirty");
  assert.equal(sim.empty, 40 - 1 - 30, "the remaining draws have nowhere to go, and are reported");
  assert.equal(sim.picks[0][0], "A", "the first draw still prefers A");
  assert.match(sim.lastTrace.reason, /No option could be allocated|Every candidate was rejected/);
});

test("a simulation fills to the configured targets without exceeding a single maximum", () => {
  const def = withListFill(priorityFill(
    [{ code: "A", maximum: 40, weight: 3 }, { code: "B", maximum: 40, weight: 1 }, { code: "C", maximum: 40, weight: 1 }],
    { method: "weighted_random" },
  ));
  const sim = simulateListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B", "C"] }), draws: 130 });
  for (const code of ["A", "B", "C"]) {
    assert.ok((sim.counts[code] ?? 0) <= 40, `${code} never exceeds its maximum (${sim.counts[code]})`);
  }
  assert.equal(Object.values(sim.counts).reduce((a, b) => a + b, 0), 120, "all 120 slots are used before anything is refused");
  assert.equal(sim.empty, 10);
});

test("a simulation is reproducible: same configuration and seed, same outcome", () => {
  const def = withListFill(priorityFill([{ code: "A" }, { code: "B" }, { code: "C" }], { method: "random" }));
  const run = () => simulateListFill({ def, listFill: def.listFills[0], state: stateWith({ q1: ["A", "B", "C"] }), draws: 50, seed: 5 }).picks.flat().join(",");
  assert.equal(run(), run(), "a researcher can rerun a simulation and get the same answer");
});
