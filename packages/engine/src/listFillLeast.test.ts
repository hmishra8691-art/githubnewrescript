import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  decideListFill, allocationPayload, confirmListFill, listFillVariables, applyListFillDestinations,
  pendingListFills, reconcileListFill, listFillRetained, listFillIsStale, countsWithout, listFillOnChange,
  listFillBalanceBasis, type ListFillCounts,
} from "./listFill.js";
import { lintListFills } from "./listFillLint.js";
import { lintSurveyLogic } from "./lintLogic.js";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { pruneHiddenSelections } from "./visibility.js";
import { flattenVariables } from "./flatten.js";
import type { ResponseState } from "./state.js";
import { mulberry32 } from "./random.js";
import "./listFillSettled.js";

/*
 * LEAST FILL (audit 2026-10-17, docs/LIST-FILL-LEAST-AUDIT-2026-10-17.md).
 *
 * "Least fill" in market research (Decipher / Forsta) = give the respondent the
 * eligible item(s) the FEWEST respondents already have, ties broken at random.
 * Before this the platform had no such method: Intelligent Mode mapped
 * "least fill" to `balanced_random`, which ranks by distance from a TARGET and
 * is exactly `random` when no target is set (measured below). These tests pin
 * `least_filled` down with real counters, plus the Back/change reconcile, the
 * circular-dependency lint and the action mapping.
 */

const BRANDS = ["A", "B", "C", "D", "E", "F"];
const def = (lf: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "least", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Brands", options: BRANDS.map((c) => ({ code: c, label: `Brand ${c}` })) },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Which?", options: BRANDS.map((c) => ({ code: c, label: `Brand ${c}` })) },
    { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Second?", options: BRANDS.map((c) => ({ code: c, label: `Brand ${c}` })) },
    { id: "gate", code: "GATE", variableName: "GATE", type: "single_select", text: "Gate", options: [{ code: "y", label: "Yes" }, { code: "n", label: "No" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "gate"] }, { type: "page", id: "p2", questionIds: ["q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
  listFills: [{
    id: "lf1", name: "LF", source: { kind: "question", questionId: "q1", take: "selected" },
    selection: { count: { kind: "fixed", n: 1 }, method: "least_filled" },
    tracking: { sampleLevel: true, respectQuotas: false },
    options: BRANDS.map((c) => ({ code: c })),
    destinations: [{ questionId: "q2", write: "answer" }],
    ...lf,
  }],
  ...extra,
});
const state = (answers: Record<string, unknown>, seed = 42, calculated: Record<string, unknown> = {}): ResponseState => ({
  surveyId: "s", surveyVersion: "1", sessionId: `s${seed}`, seed, startedAt: "", status: "in_progress",
  answers: answers as never, embedded: {}, calculated: calculated as never, flags: [], stepIndex: 1,
});
const C = (o: Record<string, number>): ListFillCounts => ({ lf1: o });
const codes = (r: { items: { code: string }[] }) => r.items.map((i) => i.code);

/* ------------------------------------------------------------ ordering */

test("least_filled: the eligible item with the LOWEST count wins; N=2 takes the two lowest", () => {
  const d = def();
  const r1 = decideListFill({ def: d, listFill: d.listFills[0], state: state({ q1: ["A", "B", "C"] }), counts: C({ A: 5, B: 2, C: 9 }) });
  assert.deepEqual(codes(r1), ["B"]);
  assert.match(r1.trace.steps.join("\n"), /Least filled \(allocated, ties random\): B=2, A=5, C=9/);
  const d2 = def({ selection: { count: { kind: "fixed", n: 2 }, method: "least_filled" } });
  const r2 = decideListFill({ def: d2, listFill: d2.listFills[0], state: state({ q1: ["A", "B", "C"] }), counts: C({ A: 5, B: 2, C: 9 }) });
  assert.deepEqual(codes(r2), ["B", "A"]);
  assert.deepEqual(r2.preference, ["B", "A", "C"], "the whole order travels to the claim, least first");
});

test("least_filled ties: random is seeded (same respondent → same pick; across respondents both win), sequential = source order, priority = lower number first", () => {
  const d = def();
  const lf = d.listFills[0];
  const pick = (seed: number, l = lf) => codes(decideListFill({ def: d, listFill: l, state: state({ q1: ["C", "A", "B"] }, seed), counts: C({ A: 1, B: 1, C: 4 }) }))[0];
  assert.equal(pick(7), pick(7), "deterministic per respondent");
  const seen = new Set(Array.from({ length: 40 }, (_, i) => pick(i + 1)));
  assert.deepEqual([...seen].sort(), ["A", "B"], "a tie is shared between the tied items, never the higher count");
  const seq = { ...lf, selection: { ...lf.selection, leastFilled: { basis: "auto" as const, tieBreak: "sequential" as const } } };
  for (let s = 1; s < 10; s++) assert.equal(pick(s, seq), "A", "source order: the respondent selected C, A, B — A is the first tied one");
  const pri = { ...lf, options: lf.options.map((o) => (o.code === "B" ? { ...o, priority: 1 } : o.code === "A" ? { ...o, priority: 2 } : o)), selection: { ...lf.selection, leastFilled: { basis: "auto" as const, tieBreak: "priority" as const } } };
  for (let s = 1; s < 10; s++) assert.equal(pick(s, pri), "B");
  // a priority never beats a LOWER count
  const r = decideListFill({ def: d, listFill: pri, state: state({ q1: ["A", "B"] }), counts: C({ A: 0, B: 3 }) });
  assert.deepEqual(codes(r), ["A"]);
});

test("least_filled honours eligibility, exclusions and caps before counting: a full or ineligible item is never 'least'", () => {
  const d = def({
    options: [
      { code: "A", maximum: 3 },
      { code: "B", eligible: false },
      { code: "C", eligibleWhen: { type: "rule", source: { kind: "question", ref: "gate" }, operator: "eq", value: "y" } },
      { code: "D" },
    ],
  });
  const lf = d.listFills[0];
  const r = decideListFill({ def: d, listFill: lf, state: state({ q1: ["A", "B", "C", "D"], gate: "n" }), counts: C({ A: 3, B: 0, C: 0, D: 7 }) });
  assert.deepEqual(codes(r), ["D"], "A is full (3/3), B switched off, C gated out — D despite the highest count");
  const why = Object.fromEntries(r.trace.options.map((o) => [o.code, o.rejectedBecause]));
  assert.deepEqual([why.A, why.B, why.C], ["maximum_reached", "option_disabled", "eligibility_condition"]);
  const r2 = decideListFill({ def: d, listFill: lf, state: state({ q1: ["A", "B", "C", "D"], gate: "y" }), counts: C({ A: 3, B: 0, C: 0, D: 7 }) });
  assert.deepEqual(codes(r2), ["C"]);
  // an item the respondent did not select is not a candidate, whatever its count
  const r3 = decideListFill({ def: d, listFill: lf, state: state({ q1: ["D"] }), counts: C({ A: 0, D: 99 }) });
  assert.deepEqual(codes(r3), ["D"]);
});

test("least_filled basis: completed counts when leastFilled.basis says so (balanceCounts), caps still on their own counter", () => {
  const d = def({ selection: { count: { kind: "fixed", n: 1 }, method: "least_filled", leastFilled: { basis: "completed", tieBreak: "sequential" } } });
  const lf = d.listFills[0];
  assert.equal(listFillBalanceBasis(lf), "completed");
  const allocated = C({ A: 1, B: 5 });
  const completed = C({ A: 1, B: 0 });
  assert.deepEqual(codes(decideListFill({ def: d, listFill: lf, state: state({ q1: ["A", "B"] }), counts: allocated, balanceCounts: completed })), ["B"]);
  assert.deepEqual(codes(decideListFill({ def: d, listFill: lf, state: state({ q1: ["A", "B"] }), counts: allocated })), ["A"], "without balanceCounts the cap counter is used");
  const auto = def({ tracking: { sampleLevel: true, respectQuotas: false, countOnCompleteOnly: true } });
  assert.equal(listFillBalanceBasis(auto.listFills[0]), "completed", "auto follows the cap's counter");
});

test("least_filled without sample-level counting: counts are ignored, only the tie-break decides — and lint says so", () => {
  const d = def({ tracking: { sampleLevel: false, respectQuotas: false }, selection: { count: { kind: "fixed", n: 1 }, method: "least_filled", leastFilled: { basis: "auto", tieBreak: "sequential" } } });
  const r = decideListFill({ def: d, listFill: d.listFills[0], state: state({ q1: ["C", "A"] }), counts: C({ C: 50, A: 0 }) });
  assert.deepEqual(codes(r), ["C"]);
  assert.ok(lintListFills(d).some((i) => i.level === "warning" && /Least filled needs/.test(i.message)));
});

/* ------------------------------------------------------------ 1,000 respondents */

/** respondents with random sources through the engine + an in-memory claim that mimics rescript_claim_listfill_slot */
function simulate(method: string, opts: { n?: number; burst?: number; option?: (c: string) => Record<string, unknown>; selection?: Record<string, unknown> } = {}) {
  const P: Record<string, number> = { A: 0.8, B: 0.6, C: 0.5, D: 0.4, E: 0.3, F: 0.2 };
  const d = def({ selection: { count: { kind: "fixed", n: opts.n ?? 1 }, method, ...(opts.selection ?? {}) }, options: BRANDS.map((c) => ({ code: c, ...(opts.option?.(c) ?? {}) })), destinations: [] });
  const lf = d.listFills[0];
  const counter: Record<string, number> = {};
  const exposure: Record<string, number> = {};
  const rnd = mulberry32(7);
  const burst = opts.burst ?? 1;
  for (let i = 0; i < 1000; i += burst) {
    const snapshot = C({ ...counter });
    for (let k = 0; k < burst; k++) {
      const sel = BRANDS.filter((b) => rnd() < P[b]);
      for (const b of sel) exposure[b] = (exposure[b] ?? 0) + 1;
      const res = decideListFill({ def: d, listFill: lf, state: state({ q1: sel }, Math.floor(rnd() * 2 ** 31)), counts: snapshot });
      const won: string[] = [];
      for (let slot = 0; slot < res.trace.requestedCount; slot++) {
        for (const p of allocationPayload(lf, res)) {
          if (won.includes(p.code)) continue;
          if (p.maximum != null && (counter[p.code] ?? 0) >= p.maximum) continue;
          counter[p.code] = (counter[p.code] ?? 0) + 1;
          won.push(p.code);
          break;
        }
      }
      confirmListFill(lf, res, won);
    }
  }
  const v = BRANDS.map((b) => counter[b] ?? 0);
  // balance that was POSSIBLE: an item chosen by fewer respondents than the others' level is capped by its exposure
  const top = Math.max(...v);
  const unbalanced = BRANDS.filter((b) => (counter[b] ?? 0) < top - 10 && (counter[b] ?? 0) < (exposure[b] ?? 0) - 3);
  return { counter, exposure, unbalanced, spread: Math.max(...v) - Math.min(...v), total: v.reduce((a, b) => a + b, 0) };
}

test("1,000 respondents, uneven random sources (A chosen 80% … F 20%): least_filled balances exposure; balanced_random without targets is just random", () => {
  const random = simulate("random");
  const balanced = simulate("balanced_random");
  const least = simulate("least_filled");
  assert.deepEqual(balanced.counter, random.counter, "balanced_random with no target = random, draw for draw (what 'least_fill' used to map to)");
  assert.ok(random.spread > 200, `random spread ${random.spread}`);
  assert.ok(least.spread <= 3, `least_filled spread ${least.spread} — ${JSON.stringify(least.counter)}`);
  assert.equal(least.total, random.total, "every respondent with a choice still gets an item");
  // N = 2
  // N = 2: 1,972 items for six brands; E and F are chosen by too few respondents to reach the others' level,
  // so least_filled gives them EVERY chance they get and balances the rest
  const least2 = simulate("least_filled", { n: 2 });
  assert.deepEqual(least2.unbalanced, [], `N=2 ${JSON.stringify(least2.counter)} exposure ${JSON.stringify(least2.exposure)}`);
  assert.ok(least2.counter.F >= least2.exposure.F - 3 && least2.counter.E >= least2.exposure.E - 3);
  assert.deepEqual(simulate("random", { n: 2 }).unbalanced.length > 0, true, "random leaves possible balance on the table");
  // concurrency: 25 respondents decided against the same snapshot herd onto the same item, bounded by the burst
  const herd = simulate("least_filled", { burst: 25 });
  assert.ok(herd.spread <= 60 && herd.spread < random.spread / 3, `burst spread ${herd.spread}`);
  // caps still cap
  const capped = simulate("least_filled", { option: (c) => (c === "A" ? { maximum: 50 } : {}) });
  assert.equal(capped.counter.A, 50);
});

test("fallback never substitutes: with no position-specific quota, every fallback rule gives the same allocation as none", () => {
  const base = simulate("random", { n: 3, selection: { fallback: "none" } });
  for (const fb of ["random_eligible", "weighted_eligible", "balanced_eligible", "next_priority"]) {
    assert.deepEqual(simulate("random", { n: 3, selection: { fallback: fb } }).counter, base.counter, fb);
  }
});

/* ------------------------------------------------------------ count, empty, duplicates, destinations */

test("N / all / allUpTo / empty source / duplicates", () => {
  const d = def({ selection: { count: { kind: "fixed", n: 3 }, method: "least_filled" } });
  const lf = d.listFills[0];
  assert.deepEqual(codes(decideListFill({ def: d, listFill: lf, state: state({ q1: ["A", "B"] }), counts: C({}) })).sort(), ["A", "B"], "fewer eligible than N → all of them");
  const empty = decideListFill({ def: d, listFill: lf, state: state({ q1: [] }), counts: C({}) });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.trace.skippedBecause, "no_candidates");
  assert.equal(listFillVariables(lf, empty).LISTFILL_LF_COUNT, 0);
  // invalid / stale source values: a code the source question does not have is never allocated, and nothing throws
  const missing = decideListFill({ def: d, listFill: lf, state: state({ q1: "ZZ;;B" }), counts: C({}) });
  assert.deepEqual(codes(missing), ["B"], "ZZ is not an option of Q1");
  for (const junk of [null, 7, { x: 1 }, [null], ""]) assert.doesNotThrow(() => decideListFill({ def: d, listFill: lf, state: state({ q1: junk }), counts: C({}) }));
  const dup = decideListFill({ def: d, listFill: lf, state: state({ q1: ["A", "A", "B", "A"] }), counts: C({}) });
  assert.equal(new Set(codes(dup)).size, codes(dup).length, "no duplicate");
  const up = def({ selection: { count: { kind: "fixed", n: 2, allUpTo: 3 }, method: "least_filled" } });
  assert.equal(decideListFill({ def: up, listFill: up.listFills[0], state: state({ q1: ["A", "B", "C"] }), counts: C({}) }).items.length, 3);
  assert.equal(decideListFill({ def: up, listFill: up.listFills[0], state: state({ q1: ["A", "B", "C", "D"] }), counts: C({}) }).items.length, 2);
});

test("destinations map positions to source codes; a SHORTER re-decision clears the answer it wrote before (U8)", () => {
  const d = def({ selection: { count: { kind: "fixed", n: 2 }, method: "least_filled", leastFilled: { basis: "auto", tieBreak: "sequential" } }, destinations: [{ questionId: "q2", write: "answer" }, { questionId: "q3", write: "answer" }] });
  const lf = d.listFills[0];
  const st = state({ q1: ["A", "B"] });
  const r = decideListFill({ def: d, listFill: lf, state: st, counts: C({}) });
  Object.assign(st.calculated, listFillVariables(lf, r));
  applyListFillDestinations(lf, r, st);
  assert.deepEqual([st.answers.q2, st.answers.q3], ["A", "B"]);
  assert.equal(st.calculated.LISTFILL_LF_2_CODE, "B");
  // Back: B de-selected → the list is A only; Q3 must not keep reporting B
  st.answers.q1 = ["A"] as never;
  const r2 = decideListFill({ def: d, listFill: lf, state: st, counts: C({}), retain: listFillRetained(d, lf, st) });
  Object.assign(st.calculated, listFillVariables(lf, r2));
  applyListFillDestinations(lf, r2, st);
  assert.equal(st.answers.q2, "A");
  assert.equal(st.answers.q3, undefined, "the stale B is cleared");
  assert.equal(st.calculated.LISTFILL_LF_2_CODE, undefined);
  // an answer the respondent gave themselves is not touched
  st.answers.q3 = "F" as never;
  applyListFillDestinations(lf, r2, st);
  assert.equal(st.answers.q3, "F");
});

/* ------------------------------------------------------------ Back + change (reconcile) */

function allocate(d: SurveyDefinition, st: ResponseState, counts: ListFillCounts) {
  const lf = d.listFills[0];
  const r = decideListFill({ def: d, listFill: lf, state: st, counts, retain: listFillRetained(d, lf, st, { counts }) });
  Object.assign(st.calculated, listFillVariables(lf, r));
  applyListFillDestinations(lf, r, st);
  return codes(r);
}

test("Back + change on a sample-counted list: keep what still qualifies, give back what does not, top up from least filled", () => {
  const d = def({ selection: { count: { kind: "fixed", n: 2 }, method: "least_filled", leastFilled: { basis: "auto", tieBreak: "sequential" } }, destinations: [{ questionId: "q2", write: "answer" }, { questionId: "q3", write: "answer" }] });
  const lf = d.listFills[0];
  assert.equal(listFillOnChange(d, lf), "keep_valid");
  const st = state({ q1: ["A", "B", "C"] });
  assert.deepEqual(allocate(d, st, C({ A: 0, B: 0, C: 5 })), ["A", "B"]);
  // a plain Back/Next with the counters moved by other respondents is NOT a change (no churn)
  assert.equal(listFillIsStale(d, lf, st, { counts: C({ A: 9, B: 9, C: 0 }) }), false);
  // the respondent de-selects A and adds D
  st.answers.q1 = ["B", "C", "D"] as never;
  const rec = reconcileListFill(d, lf, st, { counts: C({ A: 1, B: 1, C: 5, D: 3 }) });
  assert.deepEqual([rec.stale, rec.keep, rec.drop], [true, ["B"], ["A"]]);
  assert.equal(pendingListFills(d, st).length, 1, "the list is due again");
  const counts = countsWithout(C({ A: 1, B: 1, C: 5, D: 3 }), "lf1", rec.drop);
  assert.deepEqual(counts.lf1, { A: 0, B: 1, C: 5, D: 3 }, "the dropped claim does not count against the new decision");
  const r = decideListFill({ def: d, listFill: lf, state: st, counts, retain: rec.keep });
  assert.deepEqual(codes(r), ["B", "D"], "B kept in place, D (3) beats C (5)");
  assert.equal(r.trace.options.find((o) => o.code === "B")!.selectedBy, "kept from the earlier allocation");
  assert.deepEqual(allocationPayload(lf, r, ["B"]).map((p) => p.code), ["D", "C"], "the claim is asked only for the free positions");
  // a held item stays even when its cap is now reached (it holds its own slot)
  const capped = { ...lf, options: lf.options.map((o) => (o.code === "B" ? { ...o, maximum: 1 } : o)) };
  assert.deepEqual(codes(decideListFill({ def: d, listFill: capped, state: st, counts, retain: ["B"] })).slice(0, 1), ["B"]);
});

test("reconcile: count shrinks, runWhen turns false, short list with / without room, freeze, redecide", () => {
  const gate = { type: "rule", source: { kind: "question", ref: "gate" }, operator: "eq", value: "y" };
  const d = def({ runWhen: gate, selection: { count: { kind: "question", questionId: "q2" }, method: "least_filled", leastFilled: { basis: "auto", tieBreak: "sequential" } }, options: [{ code: "A" }, { code: "B" }, { code: "C", maximum: 1 }], destinations: [] });
  const lf = d.listFills[0];
  const st = state({ q1: ["A", "B"], gate: "y", q2: 2 }, 1, { LISTFILL_LF_COUNT: 2, LISTFILL_LF_CODES: "A,B" });
  assert.equal(reconcileListFill(d, lf, st).stale, false);
  st.answers.q2 = 1 as never;
  assert.deepEqual(reconcileListFill(d, lf, st), { stale: true, keep: ["A"], drop: ["B"], mode: "keep_valid", reason: "the count is now 1" });
  st.answers.q2 = 2 as never;
  st.answers.gate = "n" as never;
  assert.deepEqual(reconcileListFill(d, lf, st).drop, ["A", "B"], "runWhen false → everything goes");
  st.answers.gate = "y" as never;
  // a short list (1 of 2) and C now qualifies: stale when C has room or the counts are unknown, not when C is full
  const short = state({ q1: ["A", "C"], gate: "y", q2: 2 }, 1, { LISTFILL_LF_COUNT: 1, LISTFILL_LF_CODES: "A" });
  assert.equal(reconcileListFill(d, lf, short).stale, true);
  assert.equal(reconcileListFill(d, lf, short, { counts: C({ C: 0 }) }).stale, true);
  assert.equal(reconcileListFill(d, lf, short, { counts: C({ C: 1 }) }).stale, false);
  // freeze never changes; redecide replaces everything when something changed
  const frozen = { ...lf, selection: { ...lf.selection, onChange: "freeze" as const } };
  st.answers.q1 = ["C"] as never;
  assert.equal(reconcileListFill(d, frozen, st).stale, false);
  const re = reconcileListFill(d, { ...lf, selection: { ...lf.selection, onChange: "redecide" as const } }, st);
  assert.deepEqual([re.stale, re.keep, re.drop], [true, [], ["A", "B"]]);
});

test("a per-respondent list keeps its historical rule (redecide when a fresh decision differs)", () => {
  const d = def({ tracking: { sampleLevel: false, respectQuotas: false }, selection: { count: { kind: "fixed", n: 1 }, method: "random" } });
  const lf = d.listFills[0];
  assert.equal(listFillOnChange(d, lf), "redecide");
  const st = state({ q1: ["A", "B", "C"] });
  allocate(d, st, {});
  assert.equal(listFillIsStale(d, lf, st), false, "unchanged → the same seed reproduces it");
  st.answers.q1 = ["E"] as never;
  assert.equal(listFillIsStale(d, lf, st), true);
});

/* ------------------------------------------------------------ circular dependencies */

test("lint: a List Fill whose source is its own destination is circular", () => {
  const d = def({ source: { kind: "question", questionId: "q2", take: "selected" }, destinations: [{ questionId: "q2", write: "answer" }] });
  const issues = lintListFills(d);
  assert.ok(issues.some((i) => i.level === "error" && /Circular List Fill: LF reads Q2, which is written by this list/.test(i.message)), JSON.stringify(issues));
  assert.ok(lintSurveyLogic(d).some((i) => i.path === "listFills[0].source" && /Circular/.test(i.message)), "lintSurveyLogic reports it (Quality check → List Fill)");
});

test("lint: a mask LISTFILL(own) on the source question, an eligibleWhen on its own variables, and a two-list chain are circular; the normal setup is not", () => {
  const masked = def({ destinations: [] });
  (masked.questions[0] as unknown as Record<string, unknown>).mask = { expr: { kind: "listFill", listFillId: "lf1" }, action: "display" };
  assert.ok(lintListFills(masked).some((i) => /Circular List Fill: LF reads Q1, which is masked by this list/.test(i.message)), JSON.stringify(lintListFills(masked)));
  const selfVar = def({ options: [{ code: "A", eligibleWhen: { type: "rule", source: { kind: "variable", ref: "LISTFILL_LF_COUNT" }, operator: "lt", value: 1 } }], destinations: [] });
  assert.ok(lintListFills(selfVar).some((i) => /reads its own LISTFILL_LF_\* result/.test(i.message)));
  const chain = SurveyDefinition.parse({
    ...def(),
    listFills: [
      { id: "x", name: "X", source: { kind: "listFill", listFillId: "y" }, destinations: [] },
      { id: "y", name: "Y", source: { kind: "question", questionId: "q2", take: "selected" }, destinations: [] },
      { id: "z", name: "Z", source: { kind: "question", questionId: "q1", take: "selected" }, destinations: [{ questionId: "q2", write: "answer" }] },
    ],
  });
  assert.equal(lintListFills(chain).filter((i) => /Circular/.test(i.message)).length, 0, "X ← Y ← Q2 ← Z ← Q1 is a chain, not a cycle");
  chain.listFills[2].source = { kind: "listFill", listFillId: "x" };
  const cyc = lintListFills(chain).filter((i) => /Circular/.test(i.message));
  assert.equal(cyc.length, 1, JSON.stringify(cyc));
  assert.match(cyc[0].message, /X reads List Fill Y; Y reads Q2, which is written by List Fill Z; Z reads List Fill X/);
  // the normal setup — Q1 source, Q2 destination + a mask on Q3 — lints clean
  const normal = def({ destinations: [{ questionId: "q2", write: "answer" }] });
  (normal.questions[2] as unknown as Record<string, unknown>).mask = { expr: { kind: "listFill", listFillId: "lf1" }, action: "display" };
  assert.deepEqual(lintListFills(normal), []);
});

test("lint: dangling source / destination, the same answer written twice, two lists with one name", () => {
  const d = SurveyDefinition.parse({
    ...def(),
    listFills: [
      { id: "a", name: "DUP", source: { kind: "question", questionId: "gone", take: "selected" }, destinations: [{ questionId: "q2", write: "answer" }, { questionId: "nope", write: "answer" }] },
      { id: "b", name: "dup", source: { kind: "question", questionId: "q1", take: "selected" }, destinations: [{ questionId: "q2", write: "answer" }] },
    ],
  });
  const m = lintListFills(d).map((i) => i.message).join("\n");
  assert.match(m, /source question gone does not exist/);
  assert.match(m, /Destination nope does not exist/);
  assert.match(m, /Q2 is written by this list and by dup/);
  assert.match(m, /Another List Fill is also named dup/);
});

/* ------------------------------------------------------------ Intelligent Mode action */

test("action: least_fill now means least_filled (it used to be balanced_random = random without targets); a priority becomes the tie-break; always is refused", () => {
  const base = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "t", version: "1" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  let seq = 0;
  const ids = (p: string) => `${p}_${++seq}`;
  const run = (lf: Record<string, unknown>) => {
    const c = coerceSurveyActions([
      { op: "create_question", type: "multi_select", code: "QA", text: "Brands", options: ["Apple", "Samsung", "Nokia"] },
      { op: "create_question", type: "single_select", code: "QB", text: "Rate", options: ["Apple", "Samsung", "Nokia"], newPage: true },
      { op: "create_list_fill", name: "PICK", source: "QA", count: 1, destinations: [{ question: "QB", as: "answer" }], ...lf },
    ]);
    return applySurveyActions(base, c.actions, { ids, now: "2026-10-17T00:00:00Z" });
  };
  const a = run({ method: "least fill" });
  assert.deepEqual(a.errors, []);
  const lf = a.def.listFills[0];
  assert.equal(lf.selection.method, "least_filled");
  assert.deepEqual(lf.selection.leastFilled, { basis: "auto", tieBreak: "random" });
  assert.equal(lf.tracking.sampleLevel, true, "least fill needs the sample counts");
  assert.match(a.results[2].description ?? "", /least-filled first \(fewest respondents so far\)/);
  const b = run({ method: "least_fill", priority: { Apple: 1 } });
  assert.deepEqual(b.errors, []);
  assert.equal(b.def.listFills[0].selection.leastFilled?.tieBreak, "priority");
  const c = run({ method: "least_fill", always: ["Apple"], source: { question: "QA", take: "all" } });
  assert.match(c.results[2].error ?? "", /always puts an item first, but least_fill orders by how many/);
  const bal = run({ method: "balanced" });
  assert.equal(bal.def.listFills[0].selection.method, "balanced_random");
});

/* ------------------------------------------------------------ small defects found in the inventory */

test("an ALLOCATION (constant sum) source: an item given 0 points — or left blank — is not 'selected'", () => {
  const d = SurveyDefinition.parse({
    ...def(),
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "allocation", text: "Split 100 points", options: BRANDS.map((c) => ({ code: c, label: c })), settings: { sumTarget: 100 } }, ...def().questions.slice(1)],
  });
  const r = decideListFill({ def: d, listFill: { ...d.listFills[0], selection: { ...d.listFills[0].selection, count: { kind: "all" } } }, state: state({ q1: { A: 0, B: 60, C: 40, D: null, E: "" } }), counts: C({}) });
  assert.deepEqual(codes(r).sort(), ["B", "C"]);
});

test("U7: a list whose runWhen is false still runs (to nothing) once its source is settled, so its destinations' whenUnused applies; it re-decides when the condition turns true", () => {
  const gate = { type: "rule", source: { kind: "question", ref: "gate" }, operator: "eq", value: "y" };
  const d = def({ runWhen: gate, tracking: { sampleLevel: false, respectQuotas: false }, selection: { count: { kind: "fixed", n: 1 }, method: "random" }, destinations: [{ questionId: "q2", write: "piping_only", whenUnused: "hide" }] });
  const lf = d.listFills[0];
  const st = state({ q1: ["A"], gate: "n" });
  assert.deepEqual(pendingListFills(d, st).map((l) => l.id), ["lf1"], "runs although the gate is closed");
  const r = decideListFill({ def: d, listFill: lf, state: st });
  Object.assign(st.calculated, listFillVariables(lf, r));
  assert.equal(st.calculated.LISTFILL_LF_COUNT, 0);
  st.answers.gate = "y" as never;
  assert.equal(listFillIsStale(d, lf, st), true, "the gate opened → re-decided");
});

test("U9: a RANKING of the List Fill's items loses the items a changed answer took away (pruned like a multi-select)", () => {
  const d = SurveyDefinition.parse({
    ...def({ tracking: { sampleLevel: false, respectQuotas: false }, selection: { count: { kind: "all" }, method: "selection_order" }, destinations: [] }),
    questions: [
      def().questions[0],
      { id: "q2", code: "Q2", variableName: "Q2", type: "ranking", text: "Rank them", options: BRANDS.map((c) => ({ code: c, label: c })), mask: { expr: { kind: "listFill", listFillId: "lf1" }, action: "display" } },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e", status: "complete" }],
  });
  const lf = d.listFills[0];
  const st = state({ q1: ["A", "B", "C"] });
  const run = () => { const r = decideListFill({ def: d, listFill: lf, state: st }); Object.assign(st.calculated, listFillVariables(lf, r)); applyListFillDestinations(lf, r, st); };
  run();
  st.answers.q2 = ["C", "A", "B"] as never;
  st.answers.q1 = ["B", "D"] as never; // Back: A and C gone, D new
  assert.equal(listFillIsStale(d, lf, st), true);
  run();
  const removed = pruneHiddenSelections(d, [d.questions[1]], { def: d, state: st });
  assert.deepEqual(st.answers.q2, ["B"], "only the still-offered item keeps its (relative) rank");
  assert.deepEqual(removed, [{ questionId: "q2", scope: "option", removed: ["C", "A"] }]);
});

test("export: after Back + change the flat row carries the FINAL allocation — variables and the answer destination agree, nothing stale", () => {
  const d = def({ selection: { count: { kind: "fixed", n: 2 }, method: "least_filled", leastFilled: { basis: "auto", tieBreak: "sequential" } }, destinations: [{ questionId: "q2", write: "answer" }, { questionId: "q3", write: "answer" }] });
  const st = state({ q1: ["A", "B", "C"] });
  allocate(d, st, C({}));
  st.answers.q1 = ["C"] as never; // A and B gone
  allocate(d, st, C({ A: 1, B: 1 }));
  const row = flattenVariables(d, st);
  assert.equal(row.LISTFILL_LF_COUNT, 1);
  assert.equal(row.LISTFILL_LF_CODES, "C");
  assert.equal(row.LISTFILL_LF_1_CODE, "C");
  assert.equal(row.LISTFILL_LF_2_CODE, undefined, "no stale second item");
  assert.equal(row.Q2, "C");
  assert.ok(row.Q3 === undefined || row.Q3 === null || row.Q3 === "", `Q3 is empty, not the stale B: ${String(row.Q3)}`);
});
