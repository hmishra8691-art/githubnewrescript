import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  createResponseState, compileFlow, start, advance, flattenVariables,
  MemoryBalanceStore, pickLeastFilled, tiePreference, exactBalanceSlots, balanceSlotsDue, writeAssignment,
  claimRequestFor, designVersionFor, designRowsFor, hasExactBalance, randomizerVariable, seedWindow,
  type BalanceSlot,
} from "./index.js";

/*
 * EXACT EVEN PRESENTATION (engine item #15). The claim is the least-filled arm
 * with a deterministic tie-break, made atomically; these tests pin the
 * properties the SQL function (0073) shares with the in-memory store, and the
 * flow / design wiring around them.
 */

const spread = (counts: Record<string, number>, arms: string[]) => {
  const v = arms.map((a) => counts[a] ?? 0);
  return Math.max(...v) - Math.min(...v);
};
const tally = (store: MemoryBalanceStore, scope: string, key: string, statuses: ("active" | "completed" | "released" | "expired")[]) => {
  const c = store.counts(scope, key);
  return Object.fromEntries(Object.entries(c).map(([a, s]) => [a, statuses.reduce((n, st) => n + s[st], 0)]));
};
const req = (session: string, over: Partial<Parameters<MemoryBalanceStore["claim"]>[0]> = {}) => ({
  scope: "s:LIVE", key: "randomizer:r1", session, preference: tiePreference(["A", "B", "C", "D"], "seeded", hashOf(session), "randomizer:r1"),
  count: 1, basis: "completed" as const, holdMinutes: 120, ...over,
});
const hashOf = (s: string) => { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

test("1,000 claims, show 1 of 4: every arm within one of every other at every moment (seed-derived: 14–62)", () => {
  const store = new MemoryBalanceStore();
  for (let i = 0; i < 1000; i++) {
    store.claim(req(`sess-${i}`));
    if (i % 37 === 0) assert.ok(spread(tally(store, "s:LIVE", "randomizer:r1", ["active", "completed"]), ["A", "B", "C", "D"]) <= 1);
  }
  const c = tally(store, "s:LIVE", "randomizer:r1", ["active", "completed"]);
  assert.deepEqual(Object.values(c).sort(), [250, 250, 250, 250]);
  // the old behaviour for contrast: the seed-derived window is balanced on average only
  const old: Record<string, number> = {};
  for (let i = 0; i < 1000; i++) for (const a of seedWindow(["A", "B", "C", "D"], 1, hashOf(`sess-${i}`), "r1", true)) old[a] = (old[a] ?? 0) + 1;
  assert.ok(spread(old, ["A", "B", "C", "D"]) > 1, JSON.stringify(old));
});

test("show 2 of 5: each claim takes the two least-filled; exposures within one; never the same arm twice", () => {
  const store = new MemoryBalanceStore();
  for (let i = 0; i < 503; i++) {
    const got = store.claim(req(`s${i}`, { key: "randomizer:r2", preference: tiePreference(["a", "b", "c", "d", "e"], "seeded", i, "randomizer:r2"), count: 2 }));
    assert.equal(got.length, 2);
    assert.notEqual(got[0], got[1]);
  }
  assert.ok(spread(tally(store, "s:LIVE", "randomizer:r2", ["active"]), ["a", "b", "c", "d", "e"]) <= 1);
});

test("the claim is idempotent per session: Back, reload and a retried request get the same arm", () => {
  const store = new MemoryBalanceStore();
  const first = store.claim(req("x"));
  for (let i = 0; i < 5; i++) store.claim(req(`other${i}`));
  assert.deepEqual(store.claim(req("x")), first);
  assert.equal(Object.values(tally(store, "s:LIVE", "randomizer:r1", ["active"])).reduce((a, b) => a + b, 0), 6);
});

test("abandon / release: expired and screened-out claims stop counting (completed basis); the completes balance", () => {
  let now = 0;
  const store = new MemoryBalanceStore(() => now);
  const outcome = (i: number) => (i % 5 === 0 ? "abandon" : i % 7 === 0 ? "screen" : "complete");
  for (let i = 0; i < 400; i++) {
    now += 60_000; // a respondent a minute
    const s = `r${i}`;
    store.claim(req(s, { holdMinutes: 30 }));
    /* the guarantee: what is COUNTED (completes + live in-progress) is within one at every moment */
    const counted = store.counts("s:LIVE", "randomizer:r1");
    assert.ok(spread(Object.fromEntries(Object.entries(counted).map(([a, x]) => [a, x.active + x.completed])), ["A", "B", "C", "D"]) <= 1);
    if (outcome(i) === "complete") store.complete("s:LIVE", s);
    if (outcome(i) === "screen") store.release("s:LIVE", s);
    // abandon: nothing — the claim expires 30 minutes later
  }
  now += 31 * 60_000;
  store.claim(req("late", { holdMinutes: 30 })); // a claim expires the stale ones
  /*
   * The final COMPLETES can differ by more than one only through respondents who
   * were counted while in progress and then abandoned (at most the abandons
   * open at one time, inside the hold window) — never by herding.
   */
  const completes = tally(store, "s:LIVE", "randomizer:r1", ["completed"]);
  assert.ok(spread(completes, ["A", "B", "C", "D"]) <= 3, JSON.stringify(completes));
  const c = store.counts("s:LIVE", "randomizer:r1");
  assert.ok(Object.values(c).some((x) => x.expired > 0) && Object.values(c).some((x) => x.released > 0));
  // an expired respondent who comes back keeps their arm and counts again
  const back = store.claim(req("r5", { holdMinutes: 30 }));
  assert.equal(back.length, 1);
});

test("started basis: released and expired claims still count (exposure balance)", () => {
  const store = new MemoryBalanceStore();
  for (let i = 0; i < 40; i++) { const s = `p${i}`; store.claim(req(s, { basis: "started" })); if (i % 2) store.release("s:LIVE", s); }
  const all = tally(store, "s:LIVE", "randomizer:r1", ["active", "released"]);
  assert.deepEqual(Object.values(all).sort(), [10, 10, 10, 10]);
});

test("test and live claims never count against each other; tie-break is deterministic", () => {
  const store = new MemoryBalanceStore();
  store.claim(req("a", { scope: "s:TEST" }));
  assert.equal(Object.keys(store.counts("s:LIVE", "randomizer:r1")).length, 0);
  assert.deepEqual(tiePreference(["A", "B", "C"], "sequential", 5, "k"), ["A", "B", "C"]);
  assert.deepEqual(tiePreference(["A", "B", "C"], "seeded", 5, "k"), tiePreference(["A", "B", "C"], "seeded", 5, "k"));
  assert.deepEqual(pickLeastFilled({ A: 2, B: 1, C: 1 }, ["C", "B", "A"], 1), ["C"]);
  assert.deepEqual(pickLeastFilled({ A: 2, B: 1, C: 1 }, ["A", "B", "C"], 2), ["B", "C"]);
});

test("no herding under bursts: 25 respondents at once, atomic claims stay exact while a snapshot decision herds", () => {
  const store = new MemoryBalanceStore();
  const snapshot: Record<string, number> = {};
  for (let burst = 0; burst < 40; burst++) {
    const frozen = { ...snapshot };
    for (let i = 0; i < 25; i++) {
      const s = `b${burst}-${i}`;
      store.claim(req(s));
      const [pick] = pickLeastFilled(frozen, tiePreference(["A", "B", "C", "D"], "seeded", hashOf(s), "randomizer:r1"), 1);
      snapshot[pick] = (snapshot[pick] ?? 0) + 1;
    }
  }
  assert.ok(spread(tally(store, "s:LIVE", "randomizer:r1", ["active"]), ["A", "B", "C", "D"]) <= 1);
  assert.ok(spread(snapshot, ["A", "B", "C", "D"]) > 1, "the snapshot method herds, which is why the decision is inside the claim");
});

/* ------------------------------------------------------------ flow wiring */

const page = (id: string, q: string) => ({ type: "page", id, questionIds: [q] });
const qn = (id: string) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "open_text", text: id, settings: {} });
const def = (balance?: object, extra: object[] = []) => SurveyDefinition.parse({
  meta: { id: "eb", code: "EB", title: "Exact", version: "1" },
  questions: ["q0", "a", "b", "c", "d", "n1", "n2", "z"].map(qn),
  flow: [
    page("p0", "q0"),
    { type: "randomizer", id: "r1", show: 1, evenPresentation: true, ...(balance ? { balance } : {}), children: [
      page("pa", "a"), page("pb", "b"), page("pc", "c"),
      { type: "block", id: "blk", title: "D", children: [
        page("pd", "d"),
        { type: "randomizer", id: "inner", show: 1, ...(balance ? { balance } : {}), children: [page("pn1", "n1"), page("pn2", "n2")] },
      ] },
    ] },
    ...extra,
    page("pz", "z"),
    { type: "end", id: "end", status: "complete" },
  ],
});

test("a survey without the setting compiles exactly as before: no slot, no key, no variable", () => {
  const d = def();
  assert.equal(hasExactBalance(d), false);
  const st = createResponseState(d, { seed: 42 });
  const a = compileFlow(d, st), b = compileFlow(d, st, {}, { onBalance: () => assert.fail("no slot") });
  assert.deepEqual(a, b);
  assert.ok(a.every((s) => !(s.kind === "page" && "balance" in s)));
  assert.deepEqual(exactBalanceSlots(d, st), []);
});

test("an exact randomizer: the page inside says which slot it needs; once claimed, exactly the claimed child is shown", () => {
  const d = def({ exact: true });
  const st = createResponseState(d, { seed: 42 });
  const nav = start(d, st);
  assert.equal(nav.steps[nav.stepIndex].kind, "page");
  // leaving p0, the next page is inside r1 → due
  const probe = advance(d, JSON.parse(JSON.stringify(st)), {}, { fromPageId: "p0" });
  const due = balanceSlotsDue(d, st, probe.steps[probe.stepIndex]);
  assert.deepEqual(due.map((s) => s.key), ["randomizer:r1"]);
  assert.equal(due[0].variable, "RANDOMIZER_R1");
  assert.deepEqual(due[0].arms, ["pa", "pb", "pc", "blk"]);
  assert.equal(due[0].fallback.length, 1);
  writeAssignment(st, due[0], ["blk"]);
  const steps = compileFlow(d, st).filter((s) => s.kind === "page").map((s) => (s as { pageId: string }).pageId);
  assert.ok(steps.includes("pd") && !steps.includes("pa") && !steps.includes("pb") && !steps.includes("pc"), steps.join(","));
  // the NESTED randomizer is its own slot, due only now, outermost first on its pages
  const inner = compileFlow(d, st).find((s) => s.kind === "page" && /^pn/.test(s.pageId)) as { balance?: string[] };
  assert.deepEqual(inner.balance, ["randomizer:r1", "randomizer:inner"]);
  assert.deepEqual(balanceSlotsDue(d, st, inner as never).map((s) => s.key), ["randomizer:inner"]);
  writeAssignment(st, { variable: randomizerVariable("inner", null), kind: "randomizer" }, ["pn2"]);
  const final = compileFlow(d, st).filter((s) => s.kind === "page").map((s) => (s as { pageId: string }).pageId);
  assert.deepEqual(final, ["p0", "pd", "pn2", "pz"]);
  // the assignment is a variable of the response, so it reaches the export
  const flat = flattenVariables(d, st);
  assert.equal(flat.RANDOMIZER_R1, "blk");
  assert.equal(flat.RANDOMIZER_INNER, "pn2");
});

test("nested randomizers claimed through the memory store stay exact at both levels", () => {
  const d = def({ exact: true });
  const store = new MemoryBalanceStore();
  for (let i = 0; i < 160; i++) {
    const st = createResponseState(d, { seed: 1000 + i, sessionId: `n${i}` });
    for (let guard = 0; guard < 4; guard++) {
      const slots = exactBalanceSlots(d, st).filter((s) => !s.assigned);
      if (!slots.length) break;
      const s = slots[0];
      writeAssignment(st, s, store.claim(claimRequestFor(s, "eb:LIVE", st.sessionId, st.seed)));
    }
  }
  const outer = tally(store, "eb:LIVE", "randomizer:r1", ["active"]);
  assert.deepEqual(Object.values(outer).sort(), [40, 40, 40, 40]);
  const inner = tally(store, "eb:LIVE", "randomizer:inner", ["active"]);
  assert.deepEqual(Object.values(inner).sort(), [20, 20]);
});

test("byQuota: each cell is balanced on its own", () => {
  const d = SurveyDefinition.parse({
    ...def({ exact: true, byQuota: "qg" }),
    questions: [...def().questions.filter((q) => q.id !== "q0"), { id: "q0", code: "Q0", variableName: "GENDER", type: "single_select", text: "Gender", options: [{ code: "1", label: "M" }, { code: "2", label: "F" }], settings: {} }],
    quotas: [{ id: "qg", name: "Gender", cells: [{ id: "m", label: "M", limit: 100, when: { type: "rule", source: { kind: "question", ref: "GENDER" }, operator: "eq", value: "1" } }, { id: "f", label: "F", limit: 100, when: { type: "rule", source: { kind: "question", ref: "GENDER" }, operator: "eq", value: "2" } }] }],
  });
  const st = createResponseState(d, { seed: 3 });
  st.answers.q0 = "2";
  const [slot] = exactBalanceSlots(d, st);
  assert.equal(slot.key, "randomizer:r1|cell:f");
  assert.equal(slot.cell, "f");
});

/* ------------------------------------------------------------ design versions */

const rows = (versions: number) => {
  const out: Record<string, unknown>[] = [];
  for (let v = 1; v <= versions; v++) for (let t = 1; t <= 2; t++) for (let a = 1; a <= 2; a++) out.push({ version: v, task: t, alt: a, is_holdout: 0, Price: `$${a}`, none_option: 0 });
  return out;
};
const designDef = (exact: boolean) => SurveyDefinition.parse({
  meta: { id: "dv", code: "DV", title: "D", version: "1" },
  questions: [qn("q0"), { id: "q_cj", code: "Q1", variableName: "CJ", type: "conjoint_task", text: "Choose", settings: { designRef: "d1", ...(exact ? { versionBalance: { exact: true } } : {}) } }],
  flow: [page("p0", "q0"), page("p1", "q_cj"), { type: "end", id: "e", status: "complete" }],
  designs: [{ id: "d1", kind: "conjoint", name: "p", version: 1, seed: 1, config: {}, file: { format: "json", columns: ["version", "task", "alt", "is_holdout", "Price", "none_option"], rows: rows(3) } }],
});

test("design versions: the page holding the question needs the claim; the claimed version is what every reader uses", () => {
  const d = designDef(true);
  const st = createResponseState(d, { seed: 77 });
  const pages = compileFlow(d, st).filter((s) => s.kind === "page") as { pageId: string; balance?: string[] }[];
  assert.deepEqual(pages.find((p) => p.pageId === "p1")?.balance, ["design:q_cj"]);
  const [slot] = balanceSlotsDue(d, st, pages[1] as never) as BalanceSlot[];
  assert.deepEqual(slot.arms, ["1", "2", "3"]);
  const q = d.questions[1];
  const seedVersion = designVersionFor(q, rows(3), 77);
  const other = ["1", "2", "3"].find((v) => v !== seedVersion)!;
  writeAssignment(st, slot, [other]);
  assert.equal(designVersionFor(q, rows(3), 77, st.calculated), other);
  assert.ok(designRowsFor(q, rows(3), 77, st.calculated).every((r) => String(r.version) === other));
  assert.equal(flattenVariables(d, st).CJ_VERSION, other);
  // without the setting there is no slot and the seed decides as before
  assert.equal(compileFlow(designDef(false), createResponseState(designDef(false), { seed: 77 })).some((s) => s.kind === "page" && !!s.balance), false);
});

test("design versions through the store: 301 respondents over 3 versions → 101/100/100", () => {
  const d = designDef(true);
  const store = new MemoryBalanceStore();
  const counts: Record<string, number> = {};
  for (let i = 0; i < 301; i++) {
    const st = createResponseState(d, { seed: 5000 + i, sessionId: `d${i}` });
    const [slot] = exactBalanceSlots(d, st);
    const [v] = store.claim(claimRequestFor(slot, "dv:LIVE", st.sessionId, st.seed));
    writeAssignment(st, slot, [v]);
    const used = designVersionFor(d.questions[1], rows(3), st.seed, st.calculated);
    counts[used] = (counts[used] ?? 0) + 1;
  }
  assert.deepEqual(Object.values(counts).sort(), [100, 100, 101]);
});
