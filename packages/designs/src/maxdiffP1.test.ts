import { test } from "node:test";
import assert from "node:assert/strict";
import { maxdiffPlugin, measureMaxDiffDesign, type MaxDiffConfig } from "./maxdiff.js";

/**
 * MD-P1 (2026-10-17): MaxDiff design quality, measured.
 *
 *   · the optimized algorithm's balance on the audit's five configurations
 *   · "balanced" is said only when the measured spreads are the smallest the
 *     counts allow, and never on a design that shows a pair 0 and 3 times
 *   · prohibited pairs never co-occur, and impossible ones are refused
 *   · infeasible counts are refused with the numbers and the fix
 *   · reproducibility, and the original algorithm regenerating unchanged
 */

const items = (n: number) => Array.from({ length: n }, (_, i) => `Item ${i + 1}`);
const gen = (cfg: Partial<MaxDiffConfig> & { items: string[] }, seed = 12345) => maxdiffPlugin.generate(cfg as MaxDiffConfig, seed);
const diag = (out: ReturnType<typeof gen>) => out.summary!.diagnostics as ReturnType<typeof measureMaxDiffDesign>;
const errs = (cfg: Partial<MaxDiffConfig> & { items: string[] }) => maxdiffPlugin.validateConfig!(cfg as MaxDiffConfig);

function tasksOf(rows: Record<string, unknown>[]) {
  const m = new Map<string, number[]>();
  for (const r of rows) {
    if (Number(r.practice) === 1) continue;
    const k = `${r.version}|${r.task}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(Number(r.item_index));
  }
  return m;
}

/* ===================================================== balance bounds per configuration */

/*
 * The audit's five configurations, (items, per task, tasks, versions), with
 * the bounds the optimized algorithm MEETS — measured on the rows, not read
 * from the summary. Item counts are exact wherever the arithmetic allows it;
 * pairs are within the stated spread; no task repeats an item.
 */
const BOUNDS: { cfg: [number, number, number, number]; itemSpread: number; pairMin: number; pairMax: number; perVersionPairMax: number }[] = [
  { cfg: [8, 4, 6, 1], itemSpread: 0, pairMin: 1, pairMax: 3, perVersionPairMax: 3 },
  { cfg: [12, 4, 9, 10], itemSpread: 0, pairMin: 7, pairMax: 9, perVersionPairMax: 2 },
  { cfg: [20, 5, 12, 50], itemSpread: 0, pairMin: 30, pairMax: 33, perVersionPairMax: 2 },
  { cfg: [5, 3, 4, 1], itemSpread: 1, pairMin: 1, pairMax: 3, perVersionPairMax: 3 },
  { cfg: [30, 5, 15, 300], itemSpread: 0, pairMin: 101, pairMax: 106, perVersionPairMax: 2 },
];

for (const b of BOUNDS) {
  const [n, k, t, v] = b.cfg;
  test(`optimized (${n} items, ${k}/task, ${t} tasks, ${v} versions): items spread ≤ ${b.itemSpread}, pairs ${b.pairMin}–${b.pairMax}, every pair covered`, () => {
    const out = gen({ items: items(n), itemsPerTask: k, tasks: t, versions: v, balance: "optimized" });
    assert.equal(out.rows.length, n && k * t * v);
    const show = new Array(n).fill(0);
    const pair = new Map<string, number>();
    for (const ids of tasksOf(out.rows).values()) {
      assert.equal(ids.length, k);
      assert.equal(new Set(ids).size, k, "no item twice in a task");
      for (const i of ids) show[i - 1]++;
      for (let a = 0; a < ids.length; a++) for (let c = a + 1; c < ids.length; c++) {
        const key = [ids[a], ids[c]].sort((x, y) => x - y).join(":");
        pair.set(key, (pair.get(key) ?? 0) + 1);
      }
    }
    assert.ok(Math.max(...show) - Math.min(...show) <= b.itemSpread, `item counts ${Math.min(...show)}–${Math.max(...show)}`);
    const pv: number[] = [];
    for (let a = 1; a <= n; a++) for (let c = a + 1; c <= n; c++) pv.push(pair.get(`${a}:${c}`) ?? 0);
    assert.ok(Math.min(...pv) >= b.pairMin && Math.max(...pv) <= b.pairMax, `pairs ${Math.min(...pv)}–${Math.max(...pv)}`);
    const d = diag(out);
    /* the summary reports exactly what the rows measure */
    assert.equal(d.pairs.min, Math.min(...pv));
    assert.equal(d.pairs.max, Math.max(...pv));
    assert.equal(d.items.min, Math.min(...show));
    assert.equal(d.duplicatesWithinTask, 0);
    assert.ok(d.perVersion.pairMaxMax <= b.perVersionPairMax);
    assert.equal(d.pairs.never, 0);
  });
}

test("optimized beats the original greedy on pair spread where greedy leaves pairs uncompared", () => {
  /* the measured before/after the audit records */
  for (const [n, k, t] of [[8, 4, 6], [10, 4, 10], [5, 3, 4]] as const) {
    const g = diag(gen({ items: items(n), itemsPerTask: k, tasks: t }));
    const o = diag(gen({ items: items(n), itemsPerTask: k, tasks: t, balance: "optimized" }));
    assert.ok(g.pairs.never > 0, `greedy (${n},${k},${t}) leaves ${g.pairs.never} pairs never together`);
    assert.equal(o.pairs.never, 0, `optimized (${n},${k},${t}) covers every pair`);
  }
});

test("positions in the file are near-even under optimized (the runtime re-randomises them anyway)", () => {
  const d = diag(gen({ items: items(12), itemsPerTask: 4, tasks: 9, versions: 10, balance: "optimized" }));
  assert.ok(d.positions.max - d.positions.min <= 2, `positions ${d.positions.min}–${d.positions.max}`);
});

/* ================================================== honest claims */

test("'balanced' is claimed only when the spreads are the smallest the counts allow", () => {
  /* 10 items × 10 tasks of 4: greedy leaves 3 pairs never together and one pair 3 times */
  const greedy = diag(gen({ items: items(10), itemsPerTask: 4, tasks: 10 }));
  assert.equal(greedy.balanced, false);
  assert.equal(greedy.pairs.status, "uneven");
  assert.ok(greedy.warnings.some((w) => /Pair co-occurrence is uneven/.test(w)), greedy.warnings.join(" | "));
  const optimized = diag(gen({ items: items(10), itemsPerTask: 4, tasks: 10, balance: "optimized" }));
  assert.equal(optimized.balanced, true);
  assert.equal(optimized.pairs.status, "best_possible");
  assert.ok(optimized.lines.some((l) => /as even as these counts allow/.test(l)));
});

test("a near-balanced design says near-balanced, with the numbers", () => {
  const d = diag(gen({ items: items(12), itemsPerTask: 4, tasks: 9, versions: 10, balance: "optimized" }));
  assert.equal(d.balanced, false);
  const pairs = d.lines.find((l) => l.startsWith("Pairs:"))!;
  assert.match(pairs, /near-balanced \(not exact\)/);
  assert.match(pairs, /ideal 8\.18/);
  assert.match(pairs, /sd \d/);
  /* and never claims optimality */
  assert.ok(d.lines.some((l) => /not claimed to be optimal/.test(l)));
});

test("measureMaxDiffDesign works on any file, e.g. an imported design with a hole in it", () => {
  const rows = [
    { version: 1, task: 1, position: 1, item_index: 1 }, { version: 1, task: 1, position: 2, item_index: 2 }, { version: 1, task: 1, position: 3, item_index: 2 },
    { version: 1, task: 2, position: 1, item_index: 3 }, { version: 1, task: 2, position: 2, item_index: 1 }, { version: 1, task: 2, position: 3, item_index: 2 },
  ];
  const d = measureMaxDiffDesign(rows, ["A", "B", "C", "D"], { prohibitedPairs: [["A", "C"]] });
  assert.equal(d.duplicatesWithinTask, 1);
  assert.equal(d.prohibited.violations, 1);
  assert.ok(d.warnings.some((w) => /never shown/.test(w)));
  assert.equal(d.balanced, false);
});

/* ======================================================== reproducibility */

test("reproducible: same config + seed → identical rows; another seed → a different design", () => {
  const cfg = { items: items(12), itemsPerTask: 4, tasks: 9, versions: 3, balance: "optimized" as const, prohibitedPairs: [["Item 1", "Item 2"]] as [string, string][] };
  assert.deepEqual(gen(cfg, 99).rows, gen(cfg, 99).rows);
  assert.notDeepEqual(gen(cfg, 99).rows, gen(cfg, 100).rows);
});

test("the original algorithm is untouched: no `balance` and balance: 'greedy' give identical rows", () => {
  const base = { items: items(12), itemsPerTask: 4, tasks: 9, versions: 4 };
  assert.deepEqual(gen({ ...base, balance: "greedy" }).rows, gen(base).rows);
  assert.deepEqual(gen({ ...base, responseMode: "best_only", bestLabel: "Top", worstLabel: "Bottom", instructions: "Pick" }).rows, gen(base).rows,
    "wording and method are rendering options; they do not move the design");
});

test("versions: each version is a complete, item-balanced design of its own", () => {
  const out = gen({ items: items(12), itemsPerTask: 4, tasks: 9, versions: 10, balance: "optimized" });
  const byVersion = new Map<string, number[]>();
  for (const r of out.rows) {
    const v = String(r.version);
    if (!byVersion.has(v)) byVersion.set(v, new Array(12).fill(0));
    byVersion.get(v)![Number(r.item_index) - 1]++;
  }
  assert.equal(byVersion.size, 10);
  for (const [v, counts] of byVersion) assert.deepEqual(new Set(counts), new Set([3]), `version ${v}: ${counts}`);
});

/* ========================================================== prohibited pairs */

test("prohibited pairs never co-occur — in either algorithm, in any version", () => {
  const pp: [string, string][] = [["Item 1", "Item 2"], ["Item 1", "Item 3"], ["Item 4", "Item 5"], ["Item 6", "Item 7"], ["Item 8", "Item 9"]];
  for (const balance of ["greedy", "optimized"] as const) {
    const out = gen({ items: items(12), itemsPerTask: 4, tasks: 9, versions: 3, balance, prohibitedPairs: pp });
    for (const ids of tasksOf(out.rows).values()) {
      for (const [a, b] of pp) {
        const ia = Number(a.split(" ")[1]), ib = Number(b.split(" ")[1]);
        assert.ok(!(ids.includes(ia) && ids.includes(ib)), `${balance}: ${a} with ${b} in ${ids}`);
      }
    }
    const d = diag(out);
    assert.equal(d.prohibited.pairs, 5);
    assert.equal(d.prohibited.violations, 0);
    assert.ok(d.lines.some((l) => /never shown together/.test(l)));
  }
  /* and under optimized the items stay exactly balanced despite the constraints */
  const d = diag(gen({ items: items(12), itemsPerTask: 4, tasks: 9, versions: 3, balance: "optimized", prohibitedPairs: pp }));
  assert.equal(d.items.status, "exact");
});

test("prohibited pairs also accept {a, b} objects, and ignore duplicates", () => {
  const out = gen({ items: items(8), itemsPerTask: 4, tasks: 6, prohibitedPairs: [{ a: "Item 1", b: "Item 2" }, ["Item 2", "Item 1"]] });
  assert.equal(diag(out).prohibited.pairs, 1);
});

/* ============================================================== infeasibility */

test("infeasible: the tasks cannot hold the target appearances — refused with the numbers and the fix", () => {
  const e = errs({ items: items(12), itemsPerTask: 4, tasks: 5, appearancesPerItem: 3 });
  assert.ok(e.some((m) => /20 places per version, but 12 items × 3 appearances need 36\. Use at least 9 tasks/.test(m)), e.join(" | "));
});

test("appearancesPerItem sets the task count when tasks are not given", () => {
  const out = gen({ items: items(12), itemsPerTask: 4, appearancesPerItem: 4 });
  assert.equal(out.summary!.tasksPerVersion, 12);
  assert.equal(diag(out).items.min, 4);
  assert.deepEqual(errs({ items: items(12), itemsPerTask: 4, appearancesPerItem: 4 }), []);
});

test("infeasible: too few tasks to show every item once", () => {
  const e = errs({ items: items(20), itemsPerTask: 5, tasks: 3 });
  assert.ok(e.some((m) => /cannot show all 20 items even once\. Use at least 4 tasks/.test(m)), e.join(" | "));
});

test("invalid task sizes and counts", () => {
  assert.ok(errs({ items: items(5), itemsPerTask: 5 }).some((m) => /at least itemsPerTask \+ 1 items/.test(m)));
  assert.ok(errs({ items: items(8), itemsPerTask: 2 }).some((m) => /at least 3/.test(m)));
  assert.ok(errs({ items: items(8), itemsPerTask: 4.5 }).some((m) => /whole number/.test(m)));
  assert.ok(errs({ items: items(8), tasks: 0 }).some((m) => /tasks must be at least 1/.test(m)));
  assert.ok(errs({ items: items(8), appearancesPerItem: 0.5 }).some((m) => /whole number|at least 1/.test(m)));
  assert.ok(errs({ items: items(8), responseMode: "worst_first" as never }).some((m) => /Unknown response method/.test(m)));
});

test("conflicting restrictions: unknown items, self-pairs, no possible task, a stranded item", () => {
  assert.ok(errs({ items: items(6), prohibitedPairs: [["Item 1", "Nope"]] }).some((m) => /not in the list: Nope/.test(m)));
  assert.ok(errs({ items: items(6), prohibitedPairs: [["Item 1", "Item 1"]] }).some((m) => /paired with itself/.test(m)));
  /* 5 items, 4 per task: any 4 of them contain A–B or C–D */
  assert.ok(errs({ items: ["A", "B", "C", "D", "E"], itemsPerTask: 4, prohibitedPairs: [["A", "B"], ["C", "D"]] })
    .some((m) => /no set of 4 items that can share a task/.test(m)));
  /* A is prohibited with three of five others: it can never be in a task of 4 */
  const e = errs({ items: ["A", "B", "C", "D", "E", "F"], itemsPerTask: 4, prohibitedPairs: [["A", "B"], ["A", "C"], ["A", "D"]] });
  assert.ok(e.some((m) => /no possible task for A/.test(m)), e.join(" | "));
});

test("small item sets: items = per task + 1 works and shows everything evenly", () => {
  const out = gen({ items: items(5), itemsPerTask: 4, tasks: 5, balance: "optimized" });
  const d = diag(out);
  assert.equal(d.items.status, "exact");
  assert.equal(d.pairs.never, 0);
  assert.deepEqual(errs({ items: items(5), itemsPerTask: 4, tasks: 5 }), []);
});

/* ================================================================= practice */

test("a practice task is task 0 of every version, flagged, and counted nowhere", () => {
  const out = gen({ items: items(8), itemsPerTask: 4, tasks: 6, versions: 2, balance: "optimized", practiceTask: true });
  assert.ok(out.columns.includes("practice"));
  const practice = out.rows.filter((r) => r.practice === 1);
  assert.equal(practice.length, 2 * 4);
  assert.ok(practice.every((r) => r.task === 0));
  /* practice rows come first in each version, so the runtime shows it first */
  const v1 = out.rows.filter((r) => r.version === 1);
  assert.equal(v1[0].practice, 1);
  const d = diag(out);
  assert.equal(d.practiceTasks, 2);
  assert.equal(d.items.min, 6, "8 items × 6 tasks of 4 × 2 versions = 6 each, practice not counted");
  /* a design without practice keeps its five columns */
  assert.ok(!gen({ items: items(8), itemsPerTask: 4, tasks: 6 }).columns.includes("practice"));
});

test("the Studio is offered controls for the new options, and a NEW design defaults to optimized", () => {
  const f = (n: string) => maxdiffPlugin.configFields.find((x) => x.name === n);
  assert.equal(f("prohibitedPairs")!.type, "itemPairs");
  assert.equal(f("balance")!.default, "optimized");
  assert.deepEqual(f("responseMode")!.options, ["best_worst", "best_only"]);
  for (const n of ["appearancesPerItem", "bestLabel", "worstLabel", "instructions", "practiceTask"]) assert.ok(f(n), n);
  assert.doesNotMatch(maxdiffPlugin.description!, /\bbalanced\b(?!.*measured)/i);
});

test("the uneven-pairs warning does not tell an optimized design to use the optimized algorithm", () => {
  const items = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const rows: Record<string, unknown>[] = [];
  // a deliberately uneven design: A and B together in every task
  const base = [["A", "B", "C", "D"], ["A", "B", "E", "F"], ["A", "B", "G", "H"], ["A", "B", "C", "E"]];
  const tasks = [...base, ...base, ...base];
  tasks.forEach((t, ti) => t.forEach((it) => rows.push({ version: 1, task: ti + 1, item: it, item_index: items.indexOf(it) + 1 })));
  const plain = measureMaxDiffDesign(rows, items, {});
  const opt = measureMaxDiffDesign(rows, items, { algorithm: "greedy_dfs+pair_swaps", prohibitedPairs: [["G", "H"]] as never });
  const w = (d: { warnings: string[] }) => d.warnings.find((x) => /Pair co-occurrence is uneven/.test(x)) ?? "";
  assert.match(w(plain), /Use the "optimized" algorithm/);
  assert.doesNotMatch(w(opt), /Use the "optimized" algorithm/);
  assert.match(w(opt), /Prohibited pairs limit how even the rest can be; add tasks or versions/);
});
