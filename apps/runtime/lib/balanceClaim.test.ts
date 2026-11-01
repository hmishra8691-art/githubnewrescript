import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, MemoryBalanceStore, compileFlow } from "@rescript/engine";
import { claimBalances, isBalanceVariable, type BalanceStore } from "./balanceClaim.ts";

/*
 * The server half of exact balance (route: app/api/session/balance) against the
 * in-memory store, which has the semantics of 0073 (exercised on Postgres by
 * scripts/exact-balance-sql-test.sql and -concurrency.sh).
 */

const page = (id: string, q: string) => ({ type: "page", id, questionIds: [q] });
const qn = (id: string) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "open_text", text: id, settings: {} });
const def = SurveyDefinition.parse({
  meta: { id: "rb", code: "RB", title: "Runtime balance", version: "1" },
  questions: ["q0", "a", "b", "c", "n1", "n2", "z"].map(qn),
  flow: [
    page("p0", "q0"),
    { type: "randomizer", id: "r1", show: 1, evenPresentation: true, balance: { exact: true }, children: [
      page("pa", "a"), page("pb", "b"),
      { type: "block", id: "blk", children: [page("pc", "c"), { type: "randomizer", id: "inner", show: 1, balance: { exact: true }, children: [page("pn1", "n1"), page("pn2", "n2")] }] },
    ] },
    page("pz", "z"),
    { type: "end", id: "end", status: "complete" },
  ],
});
const memory = (m: MemoryBalanceStore): BalanceStore => ({ claim: async (r) => ({ ok: true, arms: m.claim(r) }) });

test("120 respondents through the server path: exact at both levels of a nested randomizer", async () => {
  const m = new MemoryBalanceStore();
  for (let i = 0; i < 120; i++) {
    const st = createResponseState(def, { seed: 900 + i, sessionId: `rt-session-${i}` });
    await claimBalances(def, st, ["randomizer:r1"], "rb:LIVE", memory(m));
    if (st.calculated.RANDOMIZER_R1 === "blk") await claimBalances(def, st, ["randomizer:inner"], "rb:LIVE", memory(m));
  }
  const outer = Object.values(m.counts("rb:LIVE", "randomizer:r1")).map((x) => x.active);
  assert.deepEqual(outer.sort(), [40, 40, 40]);
  assert.deepEqual(Object.values(m.counts("rb:LIVE", "randomizer:inner")).map((x) => x.active).sort(), [20, 20]);
});

test("a forged assignment in the client's variables is not believed: the store decides", async () => {
  const m = new MemoryBalanceStore();
  for (let i = 0; i < 3; i++) await claimBalances(def, createResponseState(def, { seed: i, sessionId: `other-session-${i}` }), ["randomizer:r1"], "rb:LIVE", memory(m));
  const st = createResponseState(def, { seed: 1, sessionId: "forger-session-000" });
  st.calculated.RANDOMIZER_R1 = "pa"; // pa already has its one
  const r = await claimBalances(def, st, ["randomizer:r1"], "rb:LIVE", memory(m));
  assert.equal(r.assignments[0].source, "claim");
  assert.equal(Object.values(m.counts("rb:LIVE", "randomizer:r1")).reduce((n, x) => n + x.active, 0), 4);
  assert.ok(isBalanceVariable(def, "RANDOMIZER_R1") && !isBalanceVariable(def, "Q0"));
});

test("the same session asking again (Back, reload, a retried request) gets the same arms and makes no new claim", async () => {
  const m = new MemoryBalanceStore();
  const st = createResponseState(def, { seed: 5, sessionId: "repeat-session-01" });
  const first = await claimBalances(def, st, ["randomizer:r1"], "rb:LIVE", memory(m));
  const again = await claimBalances(def, { ...st, calculated: { ...st.calculated } }, ["randomizer:r1"], "rb:LIVE", memory(m));
  assert.deepEqual(again.assignments[0].arms, first.assignments[0].arms);
  assert.equal(Object.values(m.counts("rb:LIVE", "randomizer:r1")).reduce((n, x) => n + x.active, 0), 1);
});

test("a failed claim (database without 0073) stores the seed-derived arm and says so — never left unassigned", async () => {
  const st = createResponseState(def, { seed: 77, sessionId: "nodb-session-0001" });
  const before = compileFlow(def, st).filter((s) => s.kind === "page").map((s) => (s as { pageId: string }).pageId);
  const r = await claimBalances(def, st, ["randomizer:r1"], "rb:LIVE", { claim: async () => ({ ok: false, error: "function public.rescript_claim_balance does not exist" }) });
  assert.equal(r.assignments[0].source, "fallback");
  assert.match(r.assignments[0].reason ?? "", /does not exist/);
  const after = compileFlow(def, st).filter((s) => s.kind === "page").map((s) => (s as { pageId: string }).pageId);
  // exactly what the respondent would have seen before #15
  assert.deepEqual(after.filter((p) => !/^pn/.test(p)), before.filter((p) => !/^pn/.test(p)));
});

/* S4c (RA-05 / RA-06): the server path carries the weights to the store, and claims a design ROW */
test("S4c: a weighted exact randomizer sends its weights; 400 respondents at 3:1 → 300 / 100", async () => {
  const d = SurveyDefinition.parse({
    meta: { id: "rw", code: "RW", title: "Weighted", version: "1" },
    questions: ["q0", "a", "b"].map(qn),
    flow: [page("p0", "q0"), { type: "randomizer", id: "rw", show: 1, weights: { pa: 3, pb: 1 }, balance: { exact: true }, children: [page("pa", "a"), page("pb", "b")] }, { type: "end", id: "end", status: "complete" }],
  });
  const m = new MemoryBalanceStore();
  const seen: (readonly number[] | undefined)[] = [];
  const store: BalanceStore = { claim: async (r) => { seen.push(r.weights); return { ok: true, arms: m.claim(r) }; } };
  for (let i = 0; i < 400; i++) await claimBalances(d, createResponseState(d, { seed: 50 + i, sessionId: `rw-session-${i}` }), ["randomizer:rw"], "rw:LIVE", store);
  assert.ok(seen.every((w) => Array.isArray(w) && w.length === 2 && [...w].sort().join() === "1,3"));
  const c = m.counts("rw:LIVE", "randomizer:rw");
  assert.equal(c.pa!.active, 300); assert.equal(c.pb!.active, 100);
});

test("S4c: an exact Williams randomizer's row is claimed through the server path (latin:<id> → RANDOMIZER_<ID>_ROW)", async () => {
  const d = SurveyDefinition.parse({
    meta: { id: "rl", code: "RL", title: "Latin", version: "1" },
    questions: ["q0", "a", "b", "c", "n1"].map(qn),
    flow: [page("p0", "q0"), { type: "randomizer", id: "wl", order: "williams", balance: { exact: true }, children: [page("pa", "a"), page("pb", "b"), page("pc", "c"), page("pd", "n1")] }, { type: "end", id: "end", status: "complete" }],
  });
  const m = new MemoryBalanceStore();
  for (let i = 0; i < 8; i++) {
    const st = createResponseState(d, { seed: 7 + i, sessionId: `rl-session-${i}` });
    const out = await claimBalances(d, st, ["latin:wl"], "rl:LIVE", memory(m));
    assert.equal(out.assignments[0]!.variable, "RANDOMIZER_WL_ROW");
    assert.ok(isBalanceVariable(d, "RANDOMIZER_WL_ROW"));
  }
  assert.deepEqual(Object.values(m.counts("rl:LIVE", "latin:wl")).map((x) => x.active), [2, 2, 2, 2]);
});
