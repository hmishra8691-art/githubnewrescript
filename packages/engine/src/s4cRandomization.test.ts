import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  createResponseState, compileFlow, MemoryBalanceStore, pickLeastFilled, tiePreference, exactBalanceSlots,
  claimRequestFor, writeAssignment, balanceVariableForKey,
  weightedSample, latinSquare, williamsDesign, designRows, randomizerOrderKind, randomizerWeights,
} from "./index.js";

/*
 * S4c items 1–2: the weighted randomizer (RA-05) and Latin square / Williams designs (RA-06).
 */

const page = (id: string, q: string) => ({ type: "page", id, questionIds: [q] });
const qn = (id: string) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "open_text", text: id, settings: {} });
const ids = ["a", "b", "c", "d", "e"];
const def = (rand: Record<string, unknown>, n = 4) => SurveyDefinition.parse({
  meta: { id: "s4c", code: "S4C", title: "S4c", version: "1" },
  questions: ["q0", ...ids.slice(0, n), "z"].map(qn),
  flow: [
    page("p0", "q0"),
    { type: "randomizer", id: "r1", ...rand, children: ids.slice(0, n).map((x) => page(`p${x}`, x)) },
    page("pz", "z"),
    { type: "end", id: "end", status: "complete" },
  ],
});
/** the randomizer's pages in the order this respondent sees them */
const shown = (d: SurveyDefinition, seed: number, calc: Record<string, unknown> = {}) => {
  const st = createResponseState(d, { seed });
  Object.assign(st.calculated, calc);
  return compileFlow(d, st).flatMap((s) => (s.kind === "page" && /^p[a-e]$/.test(s.pageId) ? [s.pageId.slice(1)] : []));
};

/* ------------------------------------------------------------ item 1: weights */

test("weighted sampling without replacement: seeded, distinct, k items", () => {
  const a = weightedSample(["A", "B", "C", "D"], [5, 1, 1, 1], 2, 7);
  assert.deepEqual(a, weightedSample(["A", "B", "C", "D"], [5, 1, 1, 1], 2, 7));
  assert.equal(new Set(a).size, 2);
  assert.deepEqual(weightedSample(["A"], [1], 3, 1), ["A"]);
});

test("randomizerWeights: null when every weight is equal (the unweighted path is unchanged), else aligned", () => {
  assert.equal(randomizerWeights({}, ["a", "b"]), null);
  assert.equal(randomizerWeights({ weights: { a: 2, b: 2 } }, ["a", "b"]), null);
  assert.deepEqual(randomizerWeights({ weights: { a: 3 } }, ["a", "b"]), [3, 1]);
  assert.deepEqual(randomizerWeights({ weights: { a: -1, b: 2 } }, ["a", "b"]), [1, 2]);
});

test("seeded weighted show 1 of 4, 10,000 respondents: each child's share within ±1.5 points of weight / total", () => {
  const d = def({ show: 1, weights: { pa: 4, pb: 2, pc: 1, pd: 1 } });
  const n: Record<string, number> = {};
  for (let i = 1; i <= 10_000; i++) for (const c of shown(d, i * 7919)) n[c] = (n[c] ?? 0) + 1;
  const target = { a: 0.5, b: 0.25, c: 0.125, d: 0.125 } as Record<string, number>;
  for (const k of Object.keys(target)) assert.ok(Math.abs((n[k] ?? 0) / 10_000 - target[k]!) < 0.015, `${k}: ${n[k]} ${JSON.stringify(n)}`);
});

test("seeded weighted show 2 of 4: two distinct children, stable for the respondent; heavier child shown more", () => {
  const d = def({ show: 2, weights: { pa: 6, pb: 1, pc: 1, pd: 1 } });
  let a = 0;
  for (let i = 1; i <= 2000; i++) {
    const s = shown(d, i);
    assert.equal(s.length, 2); assert.equal(new Set(s).size, 2);
    assert.deepEqual(s, shown(d, i));
    if (s.includes("a")) a++;
  }
  assert.ok(a > 1700, String(a));
});

test("a survey without weights draws exactly as before (same windows as the unweighted path)", () => {
  const plain = def({ show: 2, evenPresentation: true });
  const eq = def({ show: 2, evenPresentation: true, weights: { pa: 1, pb: 1, pc: 1, pd: 1 } });
  for (let i = 0; i < 50; i++) assert.deepEqual(shown(eq, i), shown(plain, i));
});

test("weighted EXACT claim, 10,000 respondents, show 1 of 3 weights 2:1:1: exactly 5,000 / 2,500 / 2,500 and every prefix within one claim of target", () => {
  const store = new MemoryBalanceStore();
  const arms = ["A", "B", "C"], w = [2, 1, 1];
  const c: Record<string, number> = {};
  let worst = 0;
  for (let i = 1; i <= 10_000; i++) {
    const pref = tiePreference(arms, "seeded", i * 31, "randomizer:r1");
    const [got] = store.claim({ scope: "s", key: "randomizer:r1", session: `s${i}`, preference: pref, weights: pref.map((a) => w[arms.indexOf(a)]!), count: 1, basis: "completed", holdMinutes: 120 });
    c[got!] = (c[got!] ?? 0) + 1;
    worst = Math.max(worst, ...arms.map((a, k) => Math.abs((c[a] ?? 0) - i * w[k]! / 4)));
  }
  assert.deepEqual(c, { A: 5000, B: 2500, C: 2500 });
  assert.ok(worst <= 1, String(worst));
});

test("pickLeastFilled with weights = (n + ½) / weight, ties in preference order — the order 0079 uses (ABCA)", () => {
  const counts: Record<string, number> = {};
  const seq: string[] = [];
  for (let i = 0; i < 4; i++) { const [p] = pickLeastFilled(counts, ["A", "B", "C"], 1, [2, 1, 1]); seq.push(p!); counts[p!] = (counts[p!] ?? 0) + 1; }
  assert.equal(seq.join(""), "ABCA");
  // equal weights = the unweighted rule
  assert.deepEqual(pickLeastFilled({ A: 2, B: 1 }, ["A", "B"], 1, [1, 1]), pickLeastFilled({ A: 2, B: 1 }, ["A", "B"], 1));
});

test("an exact weighted randomizer's slot carries the weights; claimRequestFor aligns them with the preference", () => {
  const d = def({ show: 1, weights: { pa: 3 }, balance: { exact: true } });
  const st = createResponseState(d, { seed: 5 });
  const [slot] = exactBalanceSlots(d, st);
  assert.deepEqual(slot!.arms, ["pa", "pb", "pc", "pd"]);
  assert.deepEqual(slot!.weights, [3, 1, 1, 1]);
  const r = claimRequestFor(slot!, "x", "sess-000000001", 5);
  assert.deepEqual(r.preference.map((a) => r.weights![r.preference.indexOf(a)]), r.preference.map((a) => (a === "pa" ? 3 : 1)));
  // an unweighted exact randomizer sends no weights (the 0073 call, unchanged)
  const u = exactBalanceSlots(def({ show: 1, balance: { exact: true } }), createResponseState(def({ show: 1, balance: { exact: true } }), { seed: 5 }))[0]!;
  assert.equal(u.weights, undefined);
  assert.equal("weights" in claimRequestFor(u, "x", "sess-000000001", 5), false);
});

/* ------------------------------------------------------------ item 2: designs */

const positionsBalanced = (rows: number[][], n: number) => {
  for (let pos = 0; pos < n; pos++) {
    const c = new Array(n).fill(0);
    for (const r of rows) c[r[pos]!]++;
    if (new Set(c).size !== 1) return false;
  }
  return true;
};
const pairCounts = (rows: number[][], n: number) => {
  const c: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const r of rows) for (let i = 0; i + 1 < r.length; i++) c[r[i]!]![r[i + 1]!]++;
  return c;
};

test("Latin square: every child in every position exactly once, each row a permutation", () => {
  for (let n = 1; n <= 9; n++) {
    const L = latinSquare(n);
    assert.equal(L.length, n);
    for (const r of L) assert.deepEqual([...r].sort((x, y) => x - y), Array.from({ length: n }, (_, i) => i));
    assert.ok(positionsBalanced(L, n));
  }
});

test("Williams: positions balanced AND every ordered pair adjacent equally often (n rows even, 2n rows odd)", () => {
  for (let n = 2; n <= 10; n++) {
    const W = williamsDesign(n);
    assert.equal(W.length, n % 2 === 0 ? n : 2 * n, `n=${n}`);
    for (const r of W) assert.deepEqual([...r].sort((x, y) => x - y), Array.from({ length: n }, (_, i) => i));
    assert.ok(positionsBalanced(W, n), `positions n=${n}`);
    const pc = pairCounts(W, n);
    const want = n % 2 === 0 ? 1 : 2;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) assert.equal(pc[i]![j], want, `n=${n} pair ${i}->${j}`);
  }
  assert.deepEqual(williamsDesign(4)[0], [0, 1, 3, 2]);
  // the plain cyclic square is NOT carryover-balanced (that is why Williams exists)
  const pc = pairCounts(latinSquare(4), 4);
  assert.equal(pc[0]![2], 0);
});

test("order kind: explicit order wins; evenPresentation reads as rotation; default random", () => {
  assert.equal(randomizerOrderKind({}), "random");
  assert.equal(randomizerOrderKind({ evenPresentation: true }), "rotation");
  assert.equal(randomizerOrderKind({ evenPresentation: true, order: "williams" }), "williams");
  assert.equal(designRows("random", 3), null);
  assert.equal(designRows("rotation", 3), null);
});

test("seeded Williams randomizer (n = 4): the respondent sees one design row; rows used about equally over 4,000 respondents", () => {
  const d = def({ order: "williams" });
  const W = williamsDesign(4).map((r) => r.map((i) => ids[i]).join(""));
  const seen: Record<string, number> = {};
  for (let i = 1; i <= 4000; i++) {
    const s = shown(d, i).join("");
    assert.ok(W.includes(s), s);
    seen[s] = (seen[s] ?? 0) + 1;
  }
  for (const r of W) assert.ok(Math.abs((seen[r] ?? 0) - 1000) < 120, JSON.stringify(seen));
});

test("exact Latin square / Williams: the ROW is claimed (latin:<id>, RANDOMIZER_<ID>_ROW); 30 respondents → each of the 6 rows (odd n = 3) exactly 5 times; every position balanced", () => {
  const d = def({ order: "williams", balance: { exact: true } }, 3);
  const store = new MemoryBalanceStore();
  const pos: Record<string, number[]> = { a: [0, 0, 0], b: [0, 0, 0], c: [0, 0, 0] };
  const pairs: Record<string, number> = {};
  const rowsSeen: Record<string, number> = {};
  for (let i = 1; i <= 30; i++) {
    const st = createResponseState(d, { seed: i * 13 });
    const [slot] = exactBalanceSlots(d, st);
    assert.equal(slot!.key, "latin:r1");
    assert.equal(slot!.variable, "RANDOMIZER_R1_ROW");
    assert.deepEqual(slot!.arms, ["1", "2", "3", "4", "5", "6"]);
    assert.equal(balanceVariableForKey(d, slot!.key), "RANDOMIZER_R1_ROW");
    const arms = store.claim(claimRequestFor(slot!, "s", `sess-${i}-000000`, st.seed));
    writeAssignment(st, slot!, arms);
    rowsSeen[arms[0]!] = (rowsSeen[arms[0]!] ?? 0) + 1;
    const order = compileFlow(d, st).flatMap((s) => (s.kind === "page" && /^p[a-c]$/.test(s.pageId) ? [s.pageId.slice(1)] : []));
    assert.deepEqual(order, williamsDesign(3)[Number(arms[0]) - 1]!.map((k) => ids[k]));
    order.forEach((c, p) => pos[c]![p]++);
    for (let k = 0; k + 1 < order.length; k++) pairs[`${order[k]}${order[k + 1]}`] = (pairs[`${order[k]}${order[k + 1]}`] ?? 0) + 1;
  }
  assert.deepEqual(Object.values(rowsSeen), [5, 5, 5, 5, 5, 5]);
  for (const c of ["a", "b", "c"]) assert.deepEqual(pos[c], [10, 10, 10]);
  for (const p of ["ab", "ba", "ac", "ca", "bc", "cb"]) assert.equal(pairs[p], 10, JSON.stringify(pairs));
});

test("Latin square with show 2 of 4: the row's first two, so each child is still shown equally often over the rows", () => {
  const d = def({ order: "latin_square", show: 2, balance: { exact: true } });
  const n: Record<string, number> = {};
  for (let row = 1; row <= 4; row++) for (const c of shown(d, 1, { RANDOMIZER_R1_ROW: String(row) })) n[c] = (n[c] ?? 0) + 1;
  assert.deepEqual(n, { a: 2, b: 2, c: 2, d: 2 });
  assert.deepEqual(shown(d, 1, { RANDOMIZER_R1_ROW: "2" }), ["b", "c"]);
});

test("a hidden child is dropped from the row; the rest keep the design's order", () => {
  const d = SurveyDefinition.parse({
    ...def({ order: "latin_square" }),
    flow: [page("p0", "q0"), { type: "randomizer", id: "r1", order: "latin_square", children: [page("pa", "a"), { ...page("pb", "b"), visibleIf: { type: "rule", source: { kind: "question", ref: "Q0" }, operator: "eq", value: "show" } }, page("pc", "c"), page("pd", "d")] }, page("pz", "z"), { type: "end", id: "end", status: "complete" }],
  });
  assert.deepEqual(shown(d, 1, { RANDOMIZER_R1_ROW: "1" }).length, 3);
});

/* ------------------------------------------------------------ IM: create_randomizer / set_randomizer */

import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";

test("IM: create_randomizer with weights + order; set_randomizer changes weights, order, exact, recordOrder", () => {
  let k = 0;
  const idf = (p: string) => `${p}_${++k}`;
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
  const base = applySurveyActions(empty, [
    { op: "create_block", title: "A" }, { op: "create_question", type: "text", text: "a?" },
    { op: "create_block", title: "B" }, { op: "create_question", type: "text", text: "b?" },
    { op: "create_block", title: "C" }, { op: "create_question", type: "text", text: "c?" },
  ], { ids: idf }).def;
  const c = coerceSurveyActions([{ op: "create_randomizer", blocks: ["A", "B", "C"], show: 1, weights: { A: 2 }, order: "Latin square" }]);
  assert.deepEqual(c.rejected, []);
  const made = applySurveyActions(base, c.actions, { ids: idf });
  assert.equal(made.results[0]!.ok, true, made.results[0]!.error);
  const r = made.def.flow.find((n) => n.type === "randomizer") as Extract<SurveyDefinition["flow"][number], { type: "randomizer" }>;
  assert.equal(r.order, "latin_square");
  assert.equal(r.balance?.exact, true);
  assert.equal(Object.values(r.weights ?? {})[0], 2);
  const set = applySurveyActions(made.def, coerceSurveyActions([{ op: "set_randomizer", randomizer: "B", order: "williams", weights: null, exact: false, recordOrder: false }]).actions, { ids: idf });
  assert.equal(set.results[0]!.ok, true, set.results[0]!.error);
  const r2 = set.def.flow.find((n) => n.type === "randomizer") as typeof r;
  assert.equal(r2.order, "williams"); assert.equal(r2.weights, undefined); assert.equal(r2.balance, undefined); assert.equal(r2.recordOrder, false);
  const bad = applySurveyActions(made.def, [{ op: "set_randomizer", weights: { Nowhere: 3 } }], { ids: idf });
  assert.match(bad.results[0]!.error ?? "", /no child “Nowhere”/);
  assert.match(String(coerceSurveyActions([{ op: "set_randomizer", order: "zigzag" }]).rejected[0]?.reason), /order is random, rotation/);
  assert.match(String(coerceSurveyActions([{ op: "set_randomizer" }]).rejected[0]?.reason), /changes nothing/);
});
