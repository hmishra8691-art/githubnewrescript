import type { FlowNode, RandomizerOrder } from "@rescript/schema";
import { mulberry32, subSeed } from "./random.js";

/**
 * S4c — RANDOMIZER DESIGNS (RA-05 weighted selection, RA-06 Latin square / Williams).
 *
 * WEIGHTS. `randomizer.weights` maps a child id to a positive relative weight (absent = 1). `show` N of M then
 * draws N children WITHOUT replacement in proportion to the weights (Efraimidis–Spirakis: each child gets the key
 * u^(1/w) from the respondent's seed and the N largest keys win) — seeded, so stable on Back / resume and
 * reproducible from the stored response. With `balance.exact` the claim is weighted too (`pickLeastFilled`
 * with weights: the arm furthest below its target share weight / total goes first — Sainte-Laguë's
 * (count + ½) / weight, which is the plain least-filled rule when every weight is equal).
 *
 * ORDER DESIGNS. `order`:
 *   random        a seeded shuffle (the default)
 *   rotation      today's `evenPresentation`: a seed-derived rotation offset — every child in every position about
 *                 equally often, NOT carryover-balanced (kept for old surveys; `evenPresentation: true` reads as it)
 *   latin_square  the cyclic Latin square: row r = (r, r+1, …) mod n — every child in every position exactly once
 *                 per n rows
 *   williams      the Williams design: every child in every position once AND every ordered pair (A then B)
 *                 adjacent exactly once per design — first-order carryover balanced. Even n: n rows; odd n: 2n rows
 *                 (the n rows and their mirror images).
 * The respondent's ROW is claimed exactly (least-filled over rows) when `balance.exact` is on, else drawn from the
 * seed; `show` N keeps the row's first N children (still position-balanced). Rows index the AUTHORED children; a
 * child hidden for this respondent is dropped from the row (the design is exact only when all are eligible).
 */

export type RandomizerNode = Extract<FlowNode, { type: "randomizer" }>;

/** the order kind a randomizer uses: explicit `order`, else `rotation` for `evenPresentation`, else `random` */
export function randomizerOrderKind(node: Pick<RandomizerNode, "order" | "evenPresentation">): RandomizerOrder {
  if (node.order === "random" || node.order === "rotation" || node.order === "latin_square" || node.order === "williams") return node.order;
  return node.evenPresentation ? "rotation" : "random";
}

/** a child's weight (positive and finite, else 1) */
export function childWeight(node: Pick<RandomizerNode, "weights">, id: string): number {
  const w = Number(node.weights?.[id]);
  return Number.isFinite(w) && w > 0 ? w : 1;
}

/** the weights of these children in this order — or null when they are all equal (the unweighted path, unchanged) */
export function randomizerWeights(node: Pick<RandomizerNode, "weights">, ids: readonly string[]): number[] | null {
  if (!node.weights || !ids.length) return null;
  const ws = ids.map((id) => childWeight(node, id));
  return ws.every((w) => w === ws[0]) ? null : ws;
}

/** seeded weighted sampling WITHOUT replacement (Efraimidis–Spirakis A-ES): the `k` items with the largest u^(1/w) */
export function weightedSample<T>(items: readonly T[], weights: readonly number[], k: number, seed: number): T[] {
  const rnd = mulberry32(seed >>> 0);
  const keyed = items.map((item, i) => {
    const w = weights[i] != null && weights[i]! > 0 ? weights[i]! : 1;
    const u = Math.max(rnd(), 1e-12);
    return { item, i, key: Math.log(u) / w };
  });
  keyed.sort((a, b) => b.key - a.key || a.i - b.i);
  return keyed.slice(0, Math.max(0, Math.min(items.length, Math.floor(k)))).map((x) => x.item);
}

/** the cyclic Latin square of order n: row r is (r, r+1, …, r+n−1) mod n */
export function latinSquare(n: number): number[][] {
  if (n < 1) return [];
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, i) => (r + i) % n));
}

/**
 * The Williams design of order n (first-order carryover balanced). First row 0, 1, n−1, 2, n−2, …; row r adds r
 * (mod n). Even n: those n rows. Odd n: those n rows followed by each row reversed (2n rows).
 */
export function williamsDesign(n: number): number[][] {
  if (n < 1) return [];
  if (n === 1) return [[0]];
  const first: number[] = [0];
  for (let k = 1, lo = 1, hi = n - 1; first.length < n; k++) {
    if (k % 2 === 1) first.push(lo++); else first.push(hi--);
  }
  const rows = Array.from({ length: n }, (_, r) => first.map((x) => (x + r) % n));
  return n % 2 === 0 ? rows : [...rows, ...rows.map((row) => [...row].reverse())];
}

/** the rows of a design order (null for random / rotation) */
export function designRows(order: RandomizerOrder, n: number): number[][] | null {
  if (order === "latin_square") return latinSquare(n);
  if (order === "williams") return williamsDesign(n);
  return null;
}

/** the seed-derived row (1-based, as stored) of a design randomizer for this respondent */
export function seededDesignRow(seed: number, nodeKey: string, rows: number): number {
  return rows < 1 ? 1 : (Math.abs(subSeed(seed, `design-row:${nodeKey}`)) % rows) + 1;
}
