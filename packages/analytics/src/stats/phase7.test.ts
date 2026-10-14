import { test } from "node:test";
import assert from "node:assert/strict";
import { factorAnalysis } from "./multivariate.js";
import { chiSquare, friedman, kruskalWallis, mannWhitney, wilcoxonSignedRank } from "./tests.js";
import { findingsFor } from "../findings.js";
import { npsOf, npsScaleProblem } from "../analyses/business.js";
import type { AnalysisDefinition, AnalysisResult } from "../types.js";

const near = (a: number | null, b: number, tol = 1e-9) => assert.ok(a != null && Math.abs(a - b) < tol, `${a} vs ${b}`);

test("S-7: a 2×2 table with small expected counts gets Fisher's exact p (scipy 1.17: 0.485714… and 0.034965…), not the chi-square approximation", () => {
  const a = chiSquare([[3, 1], [1, 3]]);
  near(a.p, 0.48571428571428565); assert.equal((a.detail as { pMethod: string }).pMethod, "fisher_exact");
  assert.match(a.note!, /exact \(Fisher\) p-value/);
  const b = chiSquare([[8, 2], [1, 5]]);
  near(b.p, 0.034965034965034975); assert.equal(b.statistic! > 6.1 && b.statistic! < 6.12, true, "the chi-square statistic is still reported");
});

test("S-7: a table with ample expected counts keeps the asymptotic p (scipy: 0.013425 is NOT used for the small table above)", () => {
  const r = chiSquare([[40, 20], [25, 45]]);
  const d = r.detail as { assumptionMet: boolean; pMethod: string };
  assert.equal(d.assumptionMet, true); assert.equal(d.pMethod, "asymptotic"); assert.equal(r.note, undefined);
});

test("S-7: a larger table with thin cells keeps the approximate p and says so", () => {
  const r = chiSquare([[20, 10, 1], [10, 20, 1], [1, 2, 1]]);
  const d = r.detail as { assumptionMet: boolean; pMethod: string };
  assert.equal(d.assumptionMet, false); assert.equal(d.pMethod, "asymptotic");
  assert.match(r.note!, /approximate/);
});

test("S-7: weighted (non-whole) 2×2 counts cannot use Fisher and are flagged, not silently exact", () => {
  const r = chiSquare([[3.2, 1.1], [1.4, 2.9]]);
  assert.equal((r.detail as { pMethod: string }).pMethod, "asymptotic");
  assert.equal((r.detail as { assumptionMet: boolean }).assumptionMet, false);
});

test("S-7: a 'significant' chi-square on thin cells is an inconclusive finding, not a difference; an exact or well-based one still is", () => {
  const def = { name: "x", kind: "test", dataset: { environment: "LIVE", dataset: "all" }, variables: ["A", "B"], options: { test: "chi_square" } } as unknown as AnalysisDefinition;
  const mk = (table: number[][]) => ({ kind: "test", name: "x", base: { n: 60, total: 60, filtered: 60, weightedN: 60, label: "All" }, tables: [], chart: {}, tests: [chiSquare(table)], insights: [], warnings: [], recommendedCharts: [], variablesUsed: ["A", "B"] }) as unknown as AnalysisResult;
  const thin = findingsFor(def, mk([[20, 10, 1], [10, 20, 1], [1, 2, 1]]));
  const approx = thin.find((f) => f.kind === "inconclusive");
  assert.ok(approx, "inconclusive");
  assert.equal(approx!.significant, false);
  assert.match(approx!.headline, /cannot be relied on/);
  const exact = findingsFor(def, mk([[8, 2], [1, 5]]));
  assert.ok(exact.some((f) => f.kind === "difference" && f.significant), "Fisher's exact p = .035 is a real difference");
  const big = findingsFor(def, mk([[40, 20], [20, 45]]));
  assert.ok(big.some((f) => f.kind === "difference" && f.significant));
});

/* ---------------------------------------------------------------- S-9: scipy 1.17.1 reference values */
const A = [3, 4, 4, 5, 2, 3, 4, 5, 5, 4, 3, 4], B = [2, 3, 3, 4, 2, 2, 3, 3, 4, 3, 2, 3], Cc = [1, 2, 2, 3, 1, 2, 2, 3, 2, 1, 2, 2];

test("S-9: Mann–Whitney on tied Likert data matches scipy (asymptotic, continuity, tie-corrected): p = 0.0121587", () => {
  near(mannWhitney(A, B).p, 0.012158699582601396, 1e-6);
});
test("S-9: Kruskal–Wallis with ties matches scipy: H = 18.383507, p = 0.000101876", () => {
  const r = kruskalWallis([{ label: "a", values: A }, { label: "b", values: B }, { label: "c", values: Cc }]);
  near(r.statistic, 18.38350694444445, 1e-9); near(r.p, 0.00010187607113782279, 1e-9);
});
test("S-9: Wilcoxon signed-rank with ties and zero differences matches scipy (approx, correction): p = 0.0305448", () => {
  near(wilcoxonSignedRank([3, 4, 4, 5, 2, 3, 4, 5, 5, 4, 3, 4], [2, 4, 3, 5, 2, 2, 4, 3, 5, 3, 3, 2]).p, 0.03054484997647525, 1e-6);
});
test("S-9: Friedman with ties inside subjects matches scipy: Q = 3.25, p = 0.196912", () => {
  const r = friedman([[3, 4, 4], [2, 2, 3], [5, 4, 4], [3, 3, 2], [4, 5, 5], [2, 3, 3], [4, 4, 5], [1, 2, 2]]);
  near(r.statistic, 3.25, 1e-9); near(r.p, 0.19691167520419406, 1e-6);
});
test("S-9: without ties the rank tests are unchanged where it matters, and an all-equal sample is refused rather than dividing by zero", () => {
  const r = kruskalWallis([{ label: "a", values: [5, 5, 5] }, { label: "b", values: [5, 5, 5] }]);
  assert.equal(r.p, null); assert.match(r.note!, /every value is the same/);
  assert.equal(mannWhitney([1, 2, 3], [1, 2, 3]).p, 1);
});

/* ---------------------------------------------------------------- S-10 */
test("S-10: an NPS of fewer than ten answers has no interval (a group of one used to get a zero-width one), nor does a sample where every answer is the same", () => {
  assert.equal(npsOf([10]).ci, null);
  assert.equal(npsOf([10, 9, 3, 8, 10, 6, 9, 10, 2]).ci, null, "nine answers");
  assert.ok(npsOf([10, 9, 3, 8, 10, 6, 9, 10, 2, 7]).ci, "ten answers get one");
  assert.equal(npsOf(Array(20).fill(10)).ci, null, "no variance, no interval");
});
test("S-10: the NPS runner refuses a 1–5 rating and answers outside 0–10, and accepts a real 0–10 question", () => {
  assert.match(npsScaleProblem([1, 2, 3, 4, 5, 3, 4, 2, 5, 1, 3, 4])!, /looks like a 1–5 rating/);
  assert.match(npsScaleProblem([0, 3, 11])!, /outside 0–10/);
  assert.equal(npsScaleProblem([0, 3, 7, 9, 10, 5]), null);
  assert.equal(npsScaleProblem([2, 3]), null, "a tiny sample is not judged");
});

/* ---------------------------------------------------------------- S-12: factor scores */
const FX = [[3, 4, 2, 5], [4, 5, 3, 4], [2, 2, 1, 3], [5, 5, 4, 5], [3, 3, 3, 2], [1, 2, 2, 1], [4, 4, 5, 3], [2, 3, 1, 2], [5, 4, 4, 4], [3, 2, 2, 3], [4, 5, 4, 5], [1, 1, 2, 2]];
const SCORES_NUMPY = [[-0.320709, -1.795391], [-0.757411, -0.454708], [0.922522, -1.089751], [-1.373322, -0.233013], [0.28663, 1.028249], [1.337201, 0.876251], [-0.743557, 1.880126], [0.904584, -0.603825], [-0.961088, 0.547185], [0.503758, -0.234994], [-1.153748, -0.310453], [1.35514, 0.390325]];

test("S-12: principal-component scores have unit variance and match numpy's Z·V/√λ (up to the sign of each factor)", () => {
  const cols = [0, 1, 2, 3].map((j) => ({ name: `V${j}`, values: FX.map((r) => r[j]) }));
  const r = factorAnalysis(cols, { method: "pca", factors: 2, rotation: "none" });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  for (let f = 0; f < 2; f++) {
    const col = r.scores.map((row) => row[f]);
    const mean = col.reduce((t, x) => t + x, 0) / col.length, v = col.reduce((t, x) => t + (x - mean) ** 2, 0) / (col.length - 1);
    near(mean, 0, 1e-9); near(v, 1, 1e-6);
    const sign = Math.sign(col[0] * SCORES_NUMPY[0][f]) || 1;
    col.forEach((x, i) => near(sign * x, SCORES_NUMPY[i][f], 2e-5));
  }
});

test("D-1: Cochran–Armitage trend matches Agresti's alcohol and malformation example (z² = 6.57, p = 0.0104) and N·r²", async () => {
  const { trendProportions } = await import("./tests.js");
  const present = [48, 38, 5, 1, 1], absent = [17066, 14464, 788, 126, 37];
  const r = trendProportions(present, present.map((x, i) => x + absent[i]), [0, 0.5, 1.5, 4, 7]);
  assert.ok(Math.abs((r.statistic as number) ** 2 - 6.570134) < 1e-5, `z² = ${(r.statistic as number) ** 2}`);
  assert.ok(Math.abs((r.p as number) - 0.01037041) < 1e-6);
  assert.equal((r.detail as { direction: string }).direction, "rising");
  // reversing the scores reverses the direction, not the p-value
  const rev = trendProportions(present, present.map((x, i) => x + absent[i]), [7, 6.5, 5.5, 3, 0]);
  assert.ok((rev.statistic as number) < 0); assert.ok(Math.abs((rev.p as number) - (r.p as number)) < 1e-12);
  // too few groups or a constant outcome has no test
  assert.equal(trendProportions([1, 2], [10, 10]).statistic, null);
  assert.equal(trendProportions([0, 0, 0], [10, 10, 10]).statistic, null);
});

test("D-2: the interval on r — Pearson matches scipy; Spearman matches Bonett–Wright; undefined cases are null", async () => {
  const { correlate, correlationInterval } = await import("./correlation.js");
  const x = [2.0409191213851825, -2.5556650313141818, 0.41809884672577885, -0.5677696061279298, -0.45264929211044586, -0.2155971630897659, -2.019986129147251, -0.23193237764418947, -0.8652130762749417, 3.3229995166448827, 0.22578661322792176, -0.3526307943415954, -0.2812874181513504, -0.6680463461089501, -1.0551505512051214, -0.39080097723465473, 0.48194538850678587, -0.2385536065733667, 0.9577587029597641, -0.19980212906658, 0.024259565076664623, 1.545820851212812, 0.5451055226876446, -0.505228735614018, -0.1828389745977349, 0.5405251317548021, 1.9350880340988528, -0.2696203273419135, -0.24355867907910456, 1.0023136012756912, -0.8864599431605871, -0.291720232439864, 0.8825389674564839, 0.5803500161908991, 0.09151670328235219, 0.6701043548284794, -2.8281623068437627, 1.02130681750008, -0.9596447598081417, -1.6686198426559695, 0.27644575952099965, 0.7005448853493901, -0.4447674556827841, -1.0764058401008076, 0.026124833534033623, -0.05274730824287927, 1.4055981660180925, 0.7474079874793504, 0.19381564626462, 1.1116332052239921, -0.20552304990579248, -0.9258995736483681, 0.584058311025248, 0.5825384186556901, -0.2148289111268558, -0.7828085779639662, 0.22915390521326254, -2.4938942784579905, 0.690124770162812, 0.4913682607449912];
  const y = [-0.6183975831978972, -1.2164790058189192, -0.755050240178351, 0.47333624169418553, -2.260491919498651, -1.0222931195394716, -0.30041307683155793, 1.0404348596100623, -2.590611918263679, 1.1634599135711379, 0.4409133991565378, -0.7855315351206683, 1.4499965222474687, -1.5252498546722557, -0.17304332931563465, -1.2438060071618384, 1.6469356373882782, -0.14092803234224172, 0.10662878747926613, -1.8180860142659065, 1.693955327605013, 1.5256890183037934, 1.0261165988531842, 0.8852668911107724, 0.25780709082416187, -0.36898404469902013, 0.16730279001932458, -0.9350101430319617, 1.2482930017941594, -0.9592244005575671, -1.0395994833510822, -0.46710403550612756, 0.6658885090773361, 0.8655243966032584, -1.2033386574543665, -1.3949612738582824, -1.4184953860438487, 1.7242172340361215, 0.2772356793924534, -0.6186591376280244, -0.17893276425685536, 0.6435061384749197, -0.4657188135835677, 0.27900366044219116, -0.7813849221198651, 0.10786629296489919, 0.5920189468974522, 0.9170633832698276, 0.3215463467816869, 3.105851238919902, 1.3958932331825868, 1.0337873786943266, -1.7474746820820184, -0.04904741537453222, -0.7160250714763577, 0.14131731090705613, -2.1644495364486955, -0.07244846021980766, 1.4120456959767202, -1.0563867278732992];
  const p = correlate(x, y, "pearson");
  assert.ok(Math.abs(p.ci![0] - 0.08158612226123958) < 1e-9 && Math.abs(p.ci![1] - 0.5377430007854995) < 1e-9, `pearson ${p.ci}`);
  const s = correlate(x, y, "spearman");
  assert.ok(Math.abs(s.ci![0] - 0.06476949764246416) < 1e-9 && Math.abs(s.ci![1] - 0.535015928694599) < 1e-9, `spearman ${s.ci}`);
  assert.equal(correlationInterval(1, 50), null);
  assert.equal(correlationInterval(0.4, 3), null);
  assert.equal(correlationInterval(null, 50), null);
  assert.ok(correlate(x, y, "kendall").ci);
});


/* the direct (pre-F-3) clustering, kept as the reference the faster one is checked against */
const dist2 = (a: number[], b: number[]) => a.reduce((t, v, i) => t + (v - b[i]) ** 2, 0);
function hierarchicalReference(rows: number[][], k: number, linkage: "ward" | "average" = "ward"): { merges: { left: number; right: number; height: number; size: number }[]; assignments: number[]; k: number } {
  const n = rows.length;
  let clusters = rows.map((r, i) => ({ id: i, members: [i], centroid: r.slice() }));
  const merges: { left: number; right: number; height: number; size: number }[] = [];
  let nextId = n;
  const assignmentsAt = (target: number) => {
    // replay merges until `target` clusters remain
    const groups = rows.map((_, i) => [i]);
    const alive = new Map<number, number[]>(groups.map((g, i) => [i, g]));
    for (const m of merges) {
      if (alive.size <= target) break;
      const merged = [...(alive.get(m.left) ?? []), ...(alive.get(m.right) ?? [])];
      alive.delete(m.left); alive.delete(m.right);
      alive.set(n + merges.indexOf(m), merged);
    }
    const out = new Array(n).fill(0);
    let c = 0;
    for (const members of alive.values()) { for (const i of members) out[i] = c; c++; }
    return out;
  };
  const linkDist = (a: typeof clusters[number], b: typeof clusters[number]) => {
    if (linkage === "ward") return (a.members.length * b.members.length) / (a.members.length + b.members.length) * dist2(a.centroid, b.centroid);
    let s = 0;
    for (const i of a.members) for (const j of b.members) s += Math.sqrt(dist2(rows[i], rows[j]));
    return s / (a.members.length * b.members.length);
  };
  while (clusters.length > 1) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const d = linkDist(clusters[i], clusters[j]);
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
    const a = clusters[bi], b = clusters[bj];
    const members = [...a.members, ...b.members];
    const centroid = rows[0].map((_, col) => members.reduce((t, i) => t + rows[i][col], 0) / members.length);
    merges.push({ left: a.id, right: b.id, height: Math.sqrt(Math.max(0, bd)), size: members.length });
    clusters = clusters.filter((_, i) => i !== bi && i !== bj);
    clusters.push({ id: nextId++, members, centroid });
  }
  return { merges, assignments: assignmentsAt(Math.max(1, Math.min(k, n))), k };
}


test("F-3: the faster hierarchical clustering gives the same merges, heights and cuts as the direct computation, on both linkages", async () => {
  const { hierarchical } = await import("./multivariate.js");
  let seed = 5; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const rows = Array.from({ length: 140 }, (_, i) => [rnd() * 3 + (i % 3) * 2, rnd() * 3 - (i % 4), rnd()]);
  for (const linkage of ["ward", "average"] as const) {
    const a = hierarchical(rows, 4, linkage), b = hierarchicalReference(rows, 4, linkage);
    assert.equal(a.merges.length, b.merges.length);
    a.merges.forEach((m, i) => {
      assert.ok(Math.abs(m.height - b.merges[i].height) < 1e-7, `${linkage} merge ${i}: ${m.height} vs ${b.merges[i].height}`);
      assert.equal(m.size, b.merges[i].size);
      assert.deepEqual([m.left, m.right].sort(), [b.merges[i].left, b.merges[i].right].sort());
    });
    assert.deepEqual(a.assignments, b.assignments, `${linkage}: same cut`);
  }
  // the speed that motivated it: 800 rows used to take 17 s
  const big = Array.from({ length: 800 }, () => [rnd(), rnd(), rnd(), rnd()]);
  const t0 = Date.now(); hierarchical(big, 5, "average"); hierarchical(big, 5, "ward");
  assert.ok(Date.now() - t0 < 8000, `800 rows, both linkages: ${Date.now() - t0} ms`);
});
