import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import type { ResponseState } from "@rescript/engine";
import { allocateListFills, countersFromRows, type ListFillStore, type CounterRow } from "./listFillAllocate.ts";

/*
 * The server half of List Fill (route: app/api/session/listfill) against a FAKE
 * store with the semantics of 0007 + 0061: an idempotent first claim, capped
 * claims in preference order, a re-allocation that keeps / releases / claims.
 * The real functions are exercised on Postgres by
 * scripts/listfill-reallocate-sql-test.sql and -concurrency.sh.
 */

function fakeStore(caps: Record<string, number> = {}) {
  const held = new Map<string, string[]>(); // session:list → codes, slot order
  const allocated: Record<string, number> = {};
  const calls: string[] = [];
  const claim = (code: string) => {
    if (caps[code] != null && (allocated[code] ?? 0) >= caps[code]) return false;
    allocated[code] = (allocated[code] ?? 0) + 1;
    return true;
  };
  const make = (session: string): ListFillStore => ({
    async allocate(a) {
      calls.push(`allocate ${a.listFillId}`);
      const k = `${session}:${a.listFillId}`;
      if (held.get(k)?.length) return { ok: true, codes: held.get(k)! };
      const won: string[] = [];
      for (let n = 0; n < a.count; n++) {
        const p = a.preference.find((x) => !won.includes(x.code) && claim(x.code));
        if (!p) break;
        won.push(p.code);
      }
      held.set(k, won);
      return { ok: true, codes: won };
    },
    async reallocate(a) {
      calls.push(`reallocate ${a.listFillId} keep=${a.keep.join(",")}`);
      const k = `${session}:${a.listFillId}`;
      const cur = held.get(k) ?? [];
      const keep = cur.filter((c) => a.keep.includes(c)).slice(0, a.count);
      for (const c of cur) if (!keep.includes(c)) allocated[c] = Math.max(0, (allocated[c] ?? 0) - 1);
      const won = [...keep];
      while (won.length < a.count) {
        const p = a.preference.find((x) => !won.includes(x.code) && claim(x.code));
        if (!p) break;
        won.push(p.code);
      }
      held.set(k, won);
      return { ok: true, codes: won };
    },
  });
  const rows = (): CounterRow[] => Object.entries(allocated).map(([code, n]) => ({ list_fill_id: "lf1", option_code: code, allocated_count: n, completed_count: 0 }));
  return { make, allocated, calls, rows, held };
}

const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "t", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Brands", options: ["A", "B", "C", "D"].map((c) => ({ code: c, label: `Brand ${c}` })) },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Rate", options: ["A", "B", "C", "D"].map((c) => ({ code: c, label: `Brand ${c}` })) },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e", status: "complete" }],
  listFills: [{
    id: "lf1", name: "LF", source: { kind: "question", questionId: "q1", take: "selected" },
    selection: { count: { kind: "fixed", n: 1 }, method: "least_filled" },
    tracking: { sampleLevel: true, respectQuotas: false },
    options: [{ code: "A", maximum: 2 }, { code: "B" }, { code: "C" }, { code: "D" }],
    destinations: [{ questionId: "q2", write: "answer" }],
  }],
});
const respondent = (session: string, q1: string[], seed = 1): ResponseState => ({
  surveyId: "s", surveyVersion: "1", sessionId: session, seed, startedAt: "", status: "in_progress",
  answers: { q1 } as never, embedded: {}, calculated: {}, flags: [], stepIndex: 1,
} as ResponseState);

test("least filled across respondents through the server path: each new respondent gets the item fewest hold", async () => {
  const f = fakeStore({ A: 2 });
  const got: string[] = [];
  for (let i = 0; i < 8; i++) {
    const st = respondent(`r${i}`, ["A", "B", "C"], i + 1);
    const out = await allocateListFills(def, st, def.listFills, countersFromRows(def, f.rows()), {}, f.make(`r${i}`));
    assert.ok(out.ok);
    got.push(String(st.calculated.LISTFILL_LF_1_CODE));
    assert.equal(st.answers.q2, got[i], "the destination holds the claimed code");
  }
  const n = (c: string) => got.filter((x) => x === c).length;
  assert.equal(n("A"), 2, "A is capped at 2");
  assert.ok(Math.abs(n("B") - n("C")) <= 1, got.join(","));
  assert.deepEqual(f.allocated, { A: 2, B: n("B"), C: n("C") }, "the counters agree with what respondents hold");
});

test("Back + change: the dropped item's slot is released, the destination and variables follow, the counters agree", async () => {
  const f = fakeStore();
  const st = respondent("s1", ["A", "B"], 3);
  const counters = () => countersFromRows(def, f.rows());
  let out = await allocateListFills(def, st, def.listFills, counters(), {}, f.make("s1"));
  assert.ok(out.ok);
  const first = String(st.calculated.LISTFILL_LF_1_CODE);
  // plain revisit: nothing changed → no database call at all
  const callsBefore = f.calls.length;
  out = await allocateListFills(def, st, def.listFills, counters(), {}, f.make("s1"));
  assert.ok(out.ok && out.allocations.length === 0);
  assert.equal(f.calls.length, callsBefore);
  // the respondent goes Back and de-selects the allocated item
  st.answers.q1 = (first === "A" ? ["B", "D"] : ["A", "D"]) as never;
  out = await allocateListFills(def, st, def.listFills, counters(), {}, f.make("s1"));
  assert.ok(out.ok);
  assert.match(f.calls.at(-1)!, /^reallocate lf1 keep=$/);
  const now = String(st.calculated.LISTFILL_LF_1_CODE);
  assert.notEqual(now, first);
  assert.ok((st.answers.q1 as unknown as string[]).includes(now));
  assert.equal(st.answers.q2, now, "the destination answer follows");
  assert.equal(f.allocated[first], 0, "the old slot is given back");
  assert.equal(f.allocated[now], 1);
  assert.deepEqual(out.ok && out.allocations[0].change, { kept: [], dropped: [first], added: [now], reason: `no longer eligible: ${first}` });
});

test("a kept item is not re-claimed when the respondent changes something else; a store without 0061 keeps the old items", async () => {
  const two = SurveyDefinition.parse({ ...def, listFills: [{ ...def.listFills[0], selection: { count: { kind: "fixed", n: 2 }, method: "least_filled", leastFilled: { basis: "auto", tieBreak: "sequential" } } }] });
  const f = fakeStore();
  const st = respondent("s2", ["A", "B", "C"]);
  await allocateListFills(two, st, two.listFills, countersFromRows(two, f.rows()), {}, f.make("s2"));
  assert.equal(st.calculated.LISTFILL_LF_CODES, "A,B");
  st.answers.q1 = ["B", "C"] as never; // A dropped, B kept, C added
  await allocateListFills(two, st, two.listFills, countersFromRows(two, f.rows()), {}, f.make("s2"));
  assert.match(f.calls.at(-1)!, /keep=B$/);
  assert.equal(st.calculated.LISTFILL_LF_CODES, "B,C");
  assert.deepEqual(f.allocated, { A: 0, B: 1, C: 1 });
  // a database without the re-allocation function: the route answers `held` → the respondent keeps what they hold
  const legacy: ListFillStore = { allocate: async () => ({ ok: true, codes: [] }), reallocate: async (a) => ({ ok: true, codes: a.held }) };
  st.answers.q1 = ["C", "D"] as never;
  const out = await allocateListFills(two, st, two.listFills, countersFromRows(two, f.rows()), {}, legacy);
  assert.ok(out.ok);
  assert.equal(st.calculated.LISTFILL_LF_CODES, "B,C");
});

test("a failed claim is reported, never replaced by the optimistic decision", async () => {
  const broken: ListFillStore = { allocate: async () => ({ ok: false, error: "boom" }), reallocate: async () => ({ ok: false, error: "boom" }) };
  const st = respondent("s3", ["A"]);
  const out = await allocateListFills(def, st, def.listFills, countersFromRows(def, []), {}, broken);
  assert.deepEqual(out, { ok: false, error: "boom", listFillId: "lf1" });
  assert.equal(st.calculated.LISTFILL_LF_COUNT, undefined);
});

test("countersFromRows: a list capped on completes is judged on completes", () => {
  const c = SurveyDefinition.parse({ ...def, listFills: [{ ...def.listFills[0], tracking: { sampleLevel: true, respectQuotas: false, countOnCompleteOnly: true } }] });
  const k = countersFromRows(c, [{ list_fill_id: "lf1", option_code: "A", allocated_count: 9, completed_count: 2 }]);
  assert.deepEqual([k.counts.lf1.A, k.allocated.lf1.A, k.completed.lf1.A], [2, 9, 2]);
});
