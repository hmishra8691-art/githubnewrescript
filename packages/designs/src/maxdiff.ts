/**
 * MaxDiff (best-worst scaling) design generator.
 *
 * Balanced-incomplete-block style greedy construction: each task is filled
 * with the least-shown items (one-way frequency balancing), and among
 * frequency-tied candidates the item adding the least pairwise co-occurrence
 * pressure is preferred (two-way balancing). Seeded shuffles break ties.
 *
 * Deterministic given (config, seed).
 *
 * ## Two construction algorithms (MD-P1, 2026-10-17)
 *
 * `balance: "greedy"` (and an absent `balance`, which is every design stored
 * before this option existed) is the original construction above, untouched —
 * a stored config regenerates to byte-identical rows from its seed.
 *
 * `balance: "optimized"` (the Studio's default for a NEW design) builds each
 * task by a depth-first search over the same greedy ordering — so it can
 * honour prohibited pairs without dead-ending — then improves pair balance
 * with seeded item swaps BETWEEN tasks of a version. A swap moves item a from
 * task 1 to task 2 and item b the other way, so every item's show count is
 * unchanged by construction; a swap is kept when it lowers the sum of squared
 * pair counts (global and within the version), which is the same as lowering
 * the variance of the pair counts. Positions in the file are then assigned to
 * even out item × position counts.
 *
 * Neither algorithm is claimed to be statistically optimal. What the summary
 * reports is MEASURED on the generated rows (`measureMaxDiffDesign`): item
 * show counts, pair co-occurrence min/max/sd, the theoretical best for those
 * counts, positions, prohibited-pair violations. "Balanced" is said only when
 * the item and pair spreads equal the smallest the counts allow.
 *
 * ## Beyond standard MaxDiff (§17)
 *
 * Standard best-worst scaling answers "which of these matters more" and
 * cannot answer "does any of this matter at all": its utilities are purely
 * relative, so an item can top the ranking while being unimportant to
 * everybody. Two variants address the two ways that bites, and both are
 * OFF by default — an existing design regenerates to byte-identical rows.
 *
 * ANCHORED (`anchored: true`). Adds a dual-response follow-up to each task:
 * are all of these important, some, or none? Those answers place an anchor at
 * utility zero, so the analysis can say which items clear the bar rather than
 * only how they rank against each other. It changes no design row — the
 * anchor is a question asked alongside the task — which is why it lives in
 * the config rather than in the file.
 *
 * EXPRESS / SPARSE (`itemsPerVersion`). Each version draws from a subset of
 * the item list, so 60 items can be scaled without asking one respondent
 * about 60 items. Coverage is the thing to get right: subsets are chosen by
 * the same global show counts that balance the tasks, so every item appears
 * across the versions rather than the first `itemsPerVersion` of them
 * appearing everywhere. `validateConfig` refuses a configuration whose
 * versions cannot cover the list, because a never-shown item has no utility
 * and its absence from the results looks like a bug in the analysis.
 */
import type { DesignGeneratorPlugin } from "@rescript/schema";
import { mulberry32, seededShuffle, subSeed } from "@rescript/engine";

/** What the respondent picks in each task. Anchoring is orthogonal (`anchored`). */
export type MaxDiffResponseMode = "best_worst" | "best_only";
/** Construction algorithm. Absent = "greedy", the original, so stored configs regenerate identically. */
export type MaxDiffBalance = "greedy" | "optimized";
/** A pair of item labels that must never share a task. */
export type MaxDiffItemPair = [string, string] | { a: string; b: string };

export interface MaxDiffConfig {
  items: string[];
  /** Items shown per task. Default 5 (or 4 when fewer than 6 items). */
  itemsPerTask?: number;
  /** Tasks per version. Default ceil(3 * items / itemsPerTask), or from `appearancesPerItem`. */
  tasks?: number;
  /** Number of design versions (blocks). Default 1. */
  versions?: number;
  /**
   * Anchored (dual-response) MaxDiff: each task carries a follow-up that
   * places an absolute threshold at utility zero. Off by default.
   */
  anchored?: boolean;
  /** The follow-up's wording. A default is supplied when anchoring is on. */
  anchorPrompt?: string;
  /**
   * Express / sparse MaxDiff: how many of the items each VERSION draws from.
   * Unset (or >= items.length) is standard MaxDiff, where every version can
   * use the whole list.
   */
  itemsPerVersion?: number;
  /**
   * Target number of times each item is shown within ONE version (= to one
   * respondent). When `tasks` is empty it sets the task count; when `tasks`
   * is set too, a target the tasks cannot hold is refused.
   */
  appearancesPerItem?: number;
  /** Pairs of items that must never appear in the same task. */
  prohibitedPairs?: MaxDiffItemPair[];
  /** Construction algorithm; see the file header. */
  balance?: MaxDiffBalance;
  /** best-and-worst (default) or best only. */
  responseMode?: MaxDiffResponseMode;
  /** Column heading for the "best" pick. Default "Most". */
  bestLabel?: string;
  /** Column heading for the "worst" pick. Default "Least". */
  worstLabel?: string;
  /** Instructions shown above the tasks. */
  instructions?: string;
  /**
   * Add one practice task (task 0, `practice` = 1) at the start of each
   * version. It is answered like any task, exported, and excluded from the
   * balance counts and from the analysis.
   */
  practiceTask?: boolean;
}

export const DEFAULT_ANCHOR_PROMPT =
  "Thinking about the items in this set, how many of them are important to you?";
export const DEFAULT_BEST_LABEL = "Most";
export const DEFAULT_WORST_LABEL = "Least";

interface NormalizedMaxDiff {
  items: string[];
  itemsPerTask: number;
  tasks: number;
  versions: number;
  anchored: boolean;
  anchorPrompt: string;
  /** 0 = the whole list is available to every version (standard) */
  itemsPerVersion: number;
  appearancesPerItem: number | null;
  balance: MaxDiffBalance;
  responseMode: MaxDiffResponseMode;
  practiceTask: boolean;
  /** prohibited pairs as item indices, plus what could not be resolved */
  prohibited: { pairs: [number, number][]; unknown: string[]; self: string[] };
}

function normalizePairs(items: string[], raw: MaxDiffConfig["prohibitedPairs"]): NormalizedMaxDiff["prohibited"] {
  const pairs: [number, number][] = [];
  const unknown: string[] = [];
  const self: string[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(raw) ? raw : []) {
    const [a, b] = Array.isArray(p) ? p : [p?.a, p?.b];
    if (a == null || b == null || String(a).trim() === "" || String(b).trim() === "") continue;
    const ia = items.indexOf(String(a)), ib = items.indexOf(String(b));
    if (ia < 0) unknown.push(String(a));
    if (ib < 0) unknown.push(String(b));
    if (ia < 0 || ib < 0) continue;
    if (ia === ib) { self.push(String(a)); continue; }
    const k = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pairs.push(ia < ib ? [ia, ib] : [ib, ia]);
  }
  return { pairs, unknown: [...new Set(unknown)], self: [...new Set(self)] };
}

function normalize(config: MaxDiffConfig): NormalizedMaxDiff {
  const items = config.items ?? [];
  const itemsPerTask =
    config.itemsPerTask ?? (items.length >= 6 ? 5 : 4);
  const perVersion = config.itemsPerVersion ?? 0;
  const itemsPerVersion = perVersion > 0 && perVersion < items.length ? perVersion : 0;
  const appearances = typeof config.appearancesPerItem === "number" && config.appearancesPerItem > 0
    ? config.appearancesPerItem : null;
  const tasks =
    config.tasks ??
    (appearances !== null
      ? Math.ceil((appearances * (itemsPerVersion || items.length)) / Math.max(itemsPerTask, 1))
      : Math.ceil((3 * items.length) / Math.max(itemsPerTask, 1)));
  const versions = config.versions ?? 1;
  return {
    items,
    itemsPerTask,
    tasks,
    versions,
    anchored: config.anchored === true,
    anchorPrompt: (config.anchorPrompt ?? "").trim() || DEFAULT_ANCHOR_PROMPT,
    /*
     * A subset as large as the list is not a subset. Normalising it to 0 here
     * means the express code path is entered only when it actually changes
     * something, so a standard design cannot be perturbed by a stray value.
     */
    itemsPerVersion,
    appearancesPerItem: appearances,
    balance: config.balance === "optimized" ? "optimized" : "greedy",
    responseMode: config.responseMode === "best_only" ? "best_only" : "best_worst",
    practiceTask: config.practiceTask === true,
    prohibited: normalizePairs(items, config.prohibitedPairs),
  };
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Is there a task of `k` items, drawn from `candidates`, with no prohibited
 * pair (optionally containing `must`)? Exact depth-first search with a node
 * budget; `null` means the budget ran out before an answer (treated as
 * "probably feasible" by validation; generation then reports a real failure).
 */
function allowedSetExists(
  candidates: number[], k: number, forbidden: (a: number, b: number) => boolean, must?: number, budget = 200_000,
): boolean | null {
  let nodes = 0;
  const start = must !== undefined ? [must] : [];
  const pool = candidates.filter((c) => c !== must && (must === undefined || !forbidden(c, must)));
  const dfs = (chosen: number[], from: number): boolean | null => {
    if (chosen.length === k) return true;
    if (++nodes > budget) return null;
    for (let i = from; i < pool.length; i++) {
      if (pool.length - i < k - chosen.length) return false;
      const c = pool[i];
      if (chosen.some((x) => forbidden(x, c))) continue;
      chosen.push(c);
      const r = dfs(chosen, i + 1);
      chosen.pop();
      if (r !== false) return r;
    }
    return false;
  };
  return dfs(start, 0);
}

const isWhole = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isInteger(v));

/* ================================================================ diagnostics */

export type BalanceStatus = "exact" | "best_possible" | "near" | "uneven";

export interface MaxDiffDiagnostics {
  method: "item_and_pair_balance";
  /** how the rows were built */
  algorithm: "greedy" | "greedy_dfs" | "greedy_dfs+pair_swaps";
  /** kept for older readers */
  itemShowRatio: number | null;
  expectedPerPair: number;
  pairsNeverTogether: number;
  /** true only when item AND pair spreads are the smallest the counts allow, and nothing is violated */
  balanced: boolean;
  warnings: string[];
  items: { min: number; max: number; ideal: number; sd: number; status: BalanceStatus };
  pairs: { min: number; max: number; ideal: number; sd: number; never: number; counted: number; status: BalanceStatus };
  perVersion: { versions: number; itemSpreadMax: number; minItemsShown: number; pairMaxMax: number };
  positions: { min: number; max: number; ideal: number; status: BalanceStatus };
  prohibited: { pairs: number; violations: number };
  duplicatesWithinTask: number;
  practiceTasks: number;
  /** the numbers above as sentences, for the Studio's design summary */
  lines: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const sdOf = (a: number[]) => {
  if (!a.length) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};

/** spread status: exact (all equal), best_possible (spread 1 when the mean is fractional), near, uneven */
function statusOf(min: number, max: number, ideal: number): BalanceStatus {
  const spread = max - min;
  if (spread === 0) return "exact";
  const floorSpread = Math.abs(ideal - Math.round(ideal)) < 1e-9 ? 0 : 1;
  if (spread <= floorSpread) return "best_possible";
  if (spread <= 2 || (min > 0 && max / min <= 1.25)) return "near";
  return "uneven";
}

const STATUS_TEXT: Record<BalanceStatus, string> = {
  exact: "exactly balanced",
  best_possible: "as even as these counts allow",
  near: "near-balanced (not exact)",
  uneven: "uneven",
};

/**
 * MEASURE a MaxDiff design file — any design, generated or imported.
 *
 * Every number the Studio shows about balance comes from here, computed on
 * the rows themselves, so a claim like "balanced" is a measurement and not a
 * property asserted by the generator. Practice rows (`practice` = 1) are left
 * out: they are not part of the experiment.
 */
export function measureMaxDiffDesign(
  rows: Record<string, unknown>[],
  items: string[],
  opts: { prohibitedPairs?: MaxDiffItemPair[]; algorithm?: MaxDiffDiagnostics["algorithm"]; express?: boolean } = {},
): MaxDiffDiagnostics {
  const n = items.length;
  const prohibited = normalizePairs(items, opts.prohibitedPairs).pairs;
  const forbiddenKeys = new Set(prohibited.map(([a, b]) => `${a}:${b}`));
  const real = rows.filter((r) => Number(r.practice) !== 1);
  const practiceTasks = new Set(rows.filter((r) => Number(r.practice) === 1).map((r) => `${r.version ?? 1}|${r.task}`)).size;
  const tasks = new Map<string, Record<string, unknown>[]>();
  for (const r of real) {
    const k = `${r.version ?? 1}|${r.task}`;
    if (!tasks.has(k)) tasks.set(k, []);
    tasks.get(k)!.push(r);
  }
  const idx = (r: Record<string, unknown>) => Number(r.item_index) - 1;
  const show = new Array<number>(n).fill(0);
  const pairs = new Map<string, number>();
  const byVersion = new Map<string, { show: number[]; pairs: Map<string, number> }>();
  const k = Math.max(0, ...[...tasks.values()].map((t) => t.length));
  const pos = Array.from({ length: n }, () => new Array<number>(Math.max(k, 1)).fill(0));
  let duplicates = 0, violations = 0;
  for (const [key, ts] of tasks) {
    const v = key.split("|")[0];
    if (!byVersion.has(v)) byVersion.set(v, { show: new Array<number>(n).fill(0), pairs: new Map() });
    const bv = byVersion.get(v)!;
    const ids = ts.map(idx).filter((i) => i >= 0 && i < n);
    if (new Set(ids).size !== ids.length) duplicates++;
    for (const r of ts) {
      const i = idx(r);
      if (i < 0 || i >= n) continue;
      show[i]++; bv.show[i]++;
      const p = Number(r.position) - 1;
      if (p >= 0 && p < k) pos[i][p]++;
    }
    const uniq = [...new Set(ids)];
    for (let a = 0; a < uniq.length; a++) {
      for (let b = a + 1; b < uniq.length; b++) {
        const pk = pairKey(uniq[a], uniq[b]);
        pairs.set(pk, (pairs.get(pk) ?? 0) + 1);
        bv.pairs.set(pk, (bv.pairs.get(pk) ?? 0) + 1);
        if (forbiddenKeys.has(pk)) violations++;
      }
    }
  }
  const totalSlots = show.reduce((s, x) => s + x, 0);
  const itemIdeal = n ? totalSlots / n : 0;
  const itemMin = n ? Math.min(...show) : 0, itemMax = n ? Math.max(...show) : 0;
  const pairValues: number[] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    if (forbiddenKeys.has(`${a}:${b}`)) continue;
    pairValues.push(pairs.get(`${a}:${b}`) ?? 0);
  }
  const pairSlots = pairValues.reduce((s, x) => s + x, 0);
  const pairIdeal = pairValues.length ? pairSlots / pairValues.length : 0;
  const pairMin = pairValues.length ? Math.min(...pairValues) : 0, pairMax = pairValues.length ? Math.max(...pairValues) : 0;
  const never = pairValues.filter((x) => x === 0).length;
  const posAll = pos.flat();
  const posIdeal = n && k ? totalSlots / (n * k) : 0;
  const posMin = posAll.length ? Math.min(...posAll) : 0, posMax = posAll.length ? Math.max(...posAll) : 0;
  let itemSpreadMax = 0, minItemsShown = n, pairMaxMax = 0;
  for (const bv of byVersion.values()) {
    const shown = bv.show.filter((x) => x > 0);
    itemSpreadMax = Math.max(itemSpreadMax, shown.length ? Math.max(...shown) - Math.min(...shown) : 0);
    minItemsShown = Math.min(minItemsShown, shown.length);
    for (const x of bv.pairs.values()) if (x > pairMaxMax) pairMaxMax = x;
  }
  if (!byVersion.size) minItemsShown = 0;
  const itemStatus = statusOf(itemMin, itemMax, itemIdeal);
  const pairStatus = statusOf(pairMin, pairMax, pairIdeal);
  const posStatus = statusOf(posMin, posMax, posIdeal);
  const neverShown = items.filter((_, i) => show[i] === 0);
  const shownCounts = show.filter((x) => x > 0);

  const warnings: string[] = [];
  if (neverShown.length) warnings.push(`${neverShown.length} item${neverShown.length === 1 ? " is" : "s are"} never shown to anyone: ${neverShown.join(", ")}.`);
  if (!opts.express && never > 0 && pairIdeal >= 2) {
    warnings.push(`Some pairs of items never appear together although each pair is expected about ${Math.round(pairIdeal * 10) / 10} times — add tasks or versions.`);
  }
  const showRatio = shownCounts.length ? r2(Math.max(...shownCounts) / Math.min(...shownCounts)) : null;
  if (!opts.express && showRatio !== null && showRatio > 1.5 && itemMax - itemMin > 1) {
    warnings.push(`Items are shown unequally often (max/min ${showRatio}).`);
  }
  if (!opts.express && pairStatus === "uneven" && pairIdeal >= 1) {
    warnings.push(`Pair co-occurrence is uneven: pairs share a task between ${pairMin} and ${pairMax} times (ideal ${r2(pairIdeal)}). ${/pair_swaps/.test(String(opts.algorithm ?? "")) ? `${opts.prohibitedPairs?.length ? "Prohibited pairs limit how even the rest can be; " : ""}add tasks or versions` : `Use the "optimized" algorithm, or add tasks or versions`}.`);
  }
  if (violations) warnings.push(`${violations} task pair${violations === 1 ? "" : "s"} break a prohibited-pair rule.`);
  if (duplicates) warnings.push(`${duplicates} task${duplicates === 1 ? "" : "s"} show the same item twice.`);

  const balanced =
    (itemStatus === "exact" || itemStatus === "best_possible") &&
    (pairStatus === "exact" || pairStatus === "best_possible") &&
    !violations && !duplicates && !neverShown.length;

  const algorithm = opts.algorithm ?? "greedy";
  const lines: string[] = [];
  lines.push(itemMin === itemMax
    ? `Items: every item is shown ${itemMin} time${itemMin === 1 ? "" : "s"} — ${STATUS_TEXT[itemStatus]}.`
    : `Items: each item is shown ${itemMin}–${itemMax} times (ideal ${r2(itemIdeal)}) — ${STATUS_TEXT[itemStatus]}.`);
  lines.push(`Pairs: each allowed pair shares a task ${pairMin}–${pairMax} times (ideal ${r2(pairIdeal)}, sd ${r2(sdOf(pairValues))}) — ${STATUS_TEXT[pairStatus]}${never ? `; ${never} of ${pairValues.length} pairs never appear together` : ""}.`);
  if (byVersion.size > 1) {
    lines.push(`Within each of the ${byVersion.size} versions (what one respondent sees): ${itemSpreadMax === 0 ? "every item shown equally often" : `item counts differ by at most ${itemSpreadMax}`}; at least ${minItemsShown} of ${n} items shown; no pair more than ${pairMaxMax} times.`);
  }
  if (prohibited.length) {
    lines.push(violations
      ? `Prohibited pairs: ${prohibited.length} rules, ${violations} VIOLATED.`
      : `Prohibited pairs: ${prohibited.length} rule${prohibited.length === 1 ? "" : "s"}, never shown together (checked on the generated rows).`);
  }
  lines.push(`Positions in the file: ${posMin}–${posMax} per item × position (ideal ${r2(posIdeal)}) — ${STATUS_TEXT[posStatus]}. The runtime re-randomises the order per respondent and the export's _ORDER column records it.`);
  lines.push(`Algorithm: ${algorithm === "greedy" ? "greedy frequency/pair balancing" : algorithm === "greedy_dfs" ? "greedy balancing with a search that honours prohibited pairs" : "greedy construction + pair-balancing swaps"}. These are frequency-balance measurements; no statistical-efficiency (D-error) figure is computed, so the design is not claimed to be optimal.`);
  if (practiceTasks) lines.push(`Practice: ${practiceTasks} practice task${practiceTasks === 1 ? "" : "s"} (task 0), excluded from these counts and from the analysis.`);

  return {
    method: "item_and_pair_balance",
    algorithm,
    itemShowRatio: showRatio,
    expectedPerPair: Math.round(pairIdeal * 10) / 10,
    pairsNeverTogether: never,
    balanced,
    warnings,
    items: { min: itemMin, max: itemMax, ideal: r2(itemIdeal), sd: r2(sdOf(show)), status: itemStatus },
    pairs: { min: pairMin, max: pairMax, ideal: r2(pairIdeal), sd: r2(sdOf(pairValues)), never, counted: pairValues.length, status: pairStatus },
    perVersion: { versions: byVersion.size, itemSpreadMax, minItemsShown, pairMaxMax },
    positions: { min: posMin, max: posMax, ideal: r2(posIdeal), status: posStatus },
    prohibited: { pairs: prohibited.length, violations },
    duplicatesWithinTask: duplicates,
    practiceTasks,
    lines,
  };
}

/* ================================================== optimized construction */

/**
 * Build the task lists with the search + swap algorithm. Returns, per version,
 * the tasks as item-index arrays in on-screen order, plus the practice task.
 */
function buildOptimized(c: NormalizedMaxDiff, seed: number): { version: number; practice: number[] | null; tasks: number[][] }[] {
  const n = c.items.length;
  const k = c.itemsPerTask;
  const forbiddenM = new Uint8Array(n * n);
  for (const [a, b] of c.prohibited.pairs) { forbiddenM[a * n + b] = 1; forbiddenM[b * n + a] = 1; }
  const forbidden = (a: number, b: number) => forbiddenM[a * n + b] === 1;
  const gShow = new Array<number>(n).fill(0);
  const gPair = new Int32Array(n * n);
  const gPos = Array.from({ length: n }, () => new Array<number>(k).fill(0));
  const out: { version: number; practice: number[] | null; tasks: number[][] }[] = [];
  /* every ordering of a task, for the position step (up to 6 items = 720) */
  const perms: number[][] | null = k <= 6 ? (function all(m: number[]): number[][] {
    if (m.length <= 1) return [m];
    return m.flatMap((x, i) => all([...m.slice(0, i), ...m.slice(i + 1)]).map((r) => [x, ...r]));
  })(Array.from({ length: k }, (_, i) => i)) : null;

  for (let version = 1; version <= c.versions; version++) {
    const pool = c.itemsPerVersion
      ? seededShuffle(Array.from({ length: n }, (_, i) => i), subSeed(seed, `maxdiff:pool:v${version}`))
          .sort((a, b) => gShow[a] - gShow[b])
          .slice(0, c.itemsPerVersion)
      : Array.from({ length: n }, (_, i) => i);
    const vShow = new Array<number>(n).fill(0);
    const vPair = new Int32Array(n * n);
    const tasks: number[][] = [];

    for (let task = 1; task <= c.tasks; task++) {
      const rng = mulberry32(subSeed(seed, `maxdiff:opt:v${version}:t${task}`));
      const tie = new Map<number, number>(pool.map((i) => [i, rng()]));
      let nodes = 0;
      const keyOf = (cand: number, chosen: number[]) => {
        let mpV = 0, mpG = 0, spG = 0;
        for (const p of chosen) {
          const v = vPair[cand * n + p], g = gPair[cand * n + p];
          if (v > mpV) mpV = v;
          if (g > mpG) mpG = g;
          spG += g;
        }
        return [vShow[cand], gShow[cand], mpV, mpG, spG, tie.get(cand)!];
      };
      const cmp = (x: number[], y: number[]) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
      const dfs = (chosen: number[]): number[] | null => {
        if (chosen.length === k) return chosen;
        if (++nodes > 100_000) return null;
        const cands = pool.filter((i) => !chosen.includes(i) && !chosen.some((p) => forbidden(i, p)));
        if (cands.length < k - chosen.length) return null;
        const keyed = cands.map((i) => ({ i, key: keyOf(i, chosen) })).sort((a, b) => cmp(a.key, b.key));
        for (const { i } of keyed) {
          const r = dfs([...chosen, i]);
          if (r) return r;
        }
        return null;
      };
      const chosen = dfs([]);
      if (!chosen) {
        throw new Error(
          `Version ${version}, task ${task}: no set of ${k} items avoids every prohibited pair` +
            (c.itemsPerVersion ? ` within this version's ${c.itemsPerVersion}-item subset` : "") +
            ". Remove some prohibited pairs or show fewer items per task.",
        );
      }
      for (const i of chosen) { vShow[i]++; gShow[i]++; }
      for (let a = 0; a < chosen.length; a++) for (let b = a + 1; b < chosen.length; b++) {
        const x = chosen[a], y = chosen[b];
        vPair[x * n + y]++; vPair[y * n + x]++; gPair[x * n + y]++; gPair[y * n + x]++;
      }
      tasks.push(chosen);
    }

    /*
     * PAIR-BALANCING SWAPS. Exchange item a (task 1) with item b (task 2):
     * item counts cannot change, so only pair counts move. Kept when the sum
     * of squared pair counts (version + global) does not rise; ties are
     * accepted sometimes so the search can walk across plateaus.
     */
    if (c.balance === "optimized" && tasks.length > 1) {
      const rng = mulberry32(subSeed(seed, `maxdiff:swap:v${version}`));
      /*
       * Budget: generous for a single version (where the respondent-level
       * balance is all there is), capped in total so a 300-version design
       * still generates in about a second in the browser.
       */
      const iterations = Math.max(150 * tasks.length, Math.min(800 * tasks.length, Math.floor(1_200_000 / c.versions)));
      /*
       * Simulated annealing: a worse swap is accepted with probability
       * exp(-Δ/T), T falling geometrically from 2 to 0.02, and the best state
       * seen is restored at the end — plain descent stalls in local minima on
       * small designs (8 items × 6 tasks of 4 kept a never-together pair).
       */
      const T0 = 6, T1 = 0.05;
      const pairsInPool = (pool.length * (pool.length - 1)) / 2;
      const pairSlotsV = tasks.length * ((k * (k - 1)) / 2);
      const zeroCostV = pairSlotsV >= pairsInPool ? 4 : 0;
      const zeroCostG = !c.itemsPerVersion && version * pairSlotsV >= (n * (n - 1)) / 2 ? 4 : 0;
      const keys: number[] = [], ds: number[] = [];
      const bump = (x: number, y: number, d: number) => {
        const key = x < y ? x * n + y : y * n + x;
        const at = keys.indexOf(key);
        if (at >= 0) ds[at] += d; else { keys.push(key); ds.push(d); }
      };
      let cur = 0, best = 0;
      let bestTasks = tasks.map((t) => [...t]);
      /*
       * A second move, REPLACE (item a in a task becomes item b, which was not
       * in it), changes show counts. It is needed only when prohibited pairs
       * forced the construction off exact item balance; item counts are then
       * weighted far above pair counts, so a replace move is only ever kept
       * when it evens out how often items are shown.
       */
      const replaceMoves = c.prohibited.pairs.length > 0;
      const W = 50;
      for (let it = 0; it < iterations; it++) {
        const T = T0 * Math.pow(T1 / T0, it / iterations);
        keys.length = 0; ds.length = 0;
        let d2 = 0;
        let apply: () => void;
        if (replaceMoves && rng() < 0.3) {
          const A = tasks[Math.floor(rng() * tasks.length)];
          const a = A[Math.floor(rng() * k)], b = pool[Math.floor(rng() * pool.length)];
          if (A.includes(b) || A.some((x) => x !== a && forbidden(b, x))) continue;
          for (const x of A) if (x !== a) { bump(a, x, -1); bump(b, x, +1); }
          d2 += W * ((-2 * vShow[a] + 1) + (2 * vShow[b] + 1) + (-2 * gShow[a] + 1) + (2 * gShow[b] + 1));
          apply = () => { A[A.indexOf(a)] = b; vShow[a]--; gShow[a]--; vShow[b]++; gShow[b]++; };
        } else {
          const t1 = Math.floor(rng() * tasks.length);
          let t2 = Math.floor(rng() * (tasks.length - 1));
          if (t2 >= t1) t2++;
          const A = tasks[t1], B = tasks[t2];
          const a = A[Math.floor(rng() * k)], b = B[Math.floor(rng() * k)];
          if (a === b || B.includes(a) || A.includes(b)) continue;
          if (A.some((x) => x !== a && forbidden(b, x)) || B.some((y) => y !== b && forbidden(a, y))) continue;
          for (const x of A) if (x !== a) { bump(a, x, -1); bump(b, x, +1); }
          for (const y of B) if (y !== b) { bump(b, y, -1); bump(a, y, +1); }
          apply = () => { A[A.indexOf(a)] = b; B[B.indexOf(b)] = a; };
        }
        for (let j = 0; j < keys.length; j++) {
          const d = ds[j];
          if (d === 0) continue;
          const g = gPair[keys[j]], v = vPair[keys[j]];
          d2 += d * (2 * g + d) + d * (2 * v + d);
          /* a pair that never shares a task cannot be compared directly: cost it when the counts could cover it */
          if (zeroCostG) d2 += zeroCostG * ((g + d === 0 ? 1 : 0) - (g === 0 ? 1 : 0));
          if (zeroCostV) d2 += zeroCostV * ((v + d === 0 ? 1 : 0) - (v === 0 ? 1 : 0));
        }
        if (d2 > 0 && rng() >= Math.exp(-d2 / T)) continue;
        for (let j = 0; j < keys.length; j++) {
          const d = ds[j];
          if (d === 0) continue;
          const x = Math.floor(keys[j] / n), y = keys[j] % n;
          gPair[x * n + y] += d; gPair[y * n + x] += d;
          vPair[x * n + y] += d; vPair[y * n + x] += d;
        }
        apply();
        cur += d2;
        if (cur < best) { best = cur; bestTasks = tasks.map((t) => [...t]); }
      }
      if (cur !== best) {
        /* restore the best state: take this version's counts out, put the best ones back */
        const countsOf = (ts: number[][], d: number) => {
          for (const t of ts) {
            for (const i of t) { vShow[i] += d; gShow[i] += d; }
            for (let x = 0; x < t.length; x++) for (let y = x + 1; y < t.length; y++) {
              const p = t[x], q = t[y];
              gPair[p * n + q] += d; gPair[q * n + p] += d; vPair[p * n + q] += d; vPair[q * n + p] += d;
            }
          }
        };
        countsOf(tasks, -1);
        countsOf(bestTasks, +1);
        tasks.splice(0, tasks.length, ...bestTasks);
      }
    }

    /*
     * On-screen order in the file: for each task, the permutation (all of
     * them up to 6 items, greedy beyond) that adds least to the item ×
     * position counts so far.
     */
    const ordered = tasks.map((chosen, ti) => {
      if (c.balance !== "optimized") return seededShuffle(chosen, subSeed(seed, `maxdiff:opt:order:v${version}:t${ti + 1}`));
      const rng = mulberry32(subSeed(seed, `maxdiff:pos:v${version}:t${ti + 1}`));
      let order: number[];
      if (perms) {
        let bestCost = Infinity, ties: number[][] = [];
        for (const perm of perms) {
          let cost = 0;
          for (let p = 0; p < k; p++) cost += gPos[chosen[perm[p]]][p];
          if (cost < bestCost) { bestCost = cost; ties = [perm]; } else if (cost === bestCost) ties.push(perm);
        }
        const perm = ties[Math.floor(rng() * ties.length)];
        order = perm.map((j) => chosen[j]);
      } else {
        const left = [...chosen];
        order = [];
        for (let p = 0; p < k; p++) {
          let best: number[] = [], bestCount = Infinity;
          for (const i of left) {
            const cnt = gPos[i][p];
            if (cnt < bestCount) { bestCount = cnt; best = [i]; } else if (cnt === bestCount) best.push(i);
          }
          const pick = best[Math.floor(rng() * best.length)];
          order.push(pick);
          left.splice(left.indexOf(pick), 1);
        }
      }
      order.forEach((i, p) => gPos[i][p]++);
      return order;
    });

    /* the practice task: any allowed set from the pool, chosen by the seed, counted nowhere */
    let practice: number[] | null = null;
    if (c.practiceTask) {
      const order = seededShuffle(pool, subSeed(seed, `maxdiff:practice:v${version}`));
      const pick: number[] = [];
      const dfs = (from: number): boolean => {
        if (pick.length === k) return true;
        for (let i = from; i < order.length; i++) {
          if (pick.some((p) => forbidden(p, order[i]))) continue;
          pick.push(order[i]);
          if (dfs(i + 1)) return true;
          pick.pop();
        }
        return false;
      };
      practice = dfs(0) ? pick : null;
    }
    out.push({ version, practice, tasks: ordered });
  }
  return out;
}

export const maxdiffPlugin: DesignGeneratorPlugin<MaxDiffConfig> = {
  kind: "maxdiff",
  label: "MaxDiff (Best-Worst Scaling)",
  description:
    "MaxDiff design: aims to balance how often each item is shown and how often each pair shares a task, honours prohibited pairs, and reports the measured balance.",
  configFields: [
    {
      name: "items",
      label: "Items",
      type: "list",
      help: "The full list of items to be scaled.",
    },
    {
      name: "itemsPerTask",
      label: "Items per task",
      type: "number",
      default: 5,
      help: "Typically 4 or 5.",
    },
    {
      name: "tasks",
      label: "Tasks per version",
      type: "number",
      help: "Defaults to ceil(target appearances x items / items per task), or ceil(3 x items / items per task) when no target is set.",
    },
    {
      name: "appearancesPerItem",
      label: "Target appearances per item",
      type: "number",
      help: "How often each item should be shown to one respondent (typically 3). Sets the task count when Tasks is empty; a target the tasks cannot hold is refused.",
    },
    {
      name: "versions",
      label: "Versions (blocks)",
      type: "number",
      default: 1,
    },
    {
      name: "balance",
      label: "Construction algorithm",
      type: "select",
      options: ["greedy", "optimized"],
      default: "optimized",
      help: "optimized = greedy construction + pair-balancing swaps (recommended). greedy = the original algorithm; designs saved before this option regenerate with it unchanged.",
    },
    {
      name: "prohibitedPairs",
      label: "Prohibited pairs",
      type: "itemPairs",
      help: "Items that must never appear in the same task.",
    },
    {
      name: "responseMode",
      label: "Response method",
      type: "select",
      options: ["best_worst", "best_only"],
      default: "best_worst",
      help: "best_worst asks for the most and the least; best_only asks only for the most. Turn on Anchored for the dual-response follow-up.",
    },
    {
      name: "bestLabel",
      label: "Best column label",
      type: "text",
      help: `Default "${DEFAULT_BEST_LABEL}".`,
    },
    {
      name: "worstLabel",
      label: "Worst column label",
      type: "text",
      help: `Default "${DEFAULT_WORST_LABEL}".`,
    },
    {
      name: "instructions",
      label: "Instructions",
      type: "text",
      help: "Shown above the tasks.",
    },
    {
      name: "practiceTask",
      label: "Practice task",
      type: "boolean",
      default: false,
      help: "Start each version with one practice task (task 0). It is exported but not analysed or counted in the balance.",
    },
    {
      name: "anchored",
      label: "Anchored (dual-response)",
      type: "boolean",
      default: false,
      help: "Ask after each set how many of its items are important. Lets the analysis say which items clear an absolute bar, not only how they rank.",
    },
    {
      name: "anchorPrompt",
      label: "Anchor question wording",
      type: "text",
      help: "Only used when anchoring is on.",
    },
    {
      name: "itemsPerVersion",
      label: "Items per version (express)",
      type: "number",
      help: "For long lists: each version draws from this many items instead of all of them. Leave empty for standard MaxDiff.",
    },
  ],

  validateConfig(config: MaxDiffConfig): string[] {
    const errors: string[] = [];
    const c = normalize(config);
    for (const f of ["itemsPerTask", "tasks", "versions", "itemsPerVersion", "appearancesPerItem"] as const) {
      if (!isWhole(config[f])) errors.push(`${f} must be a whole number (got ${String(config[f])}).`);
    }
    if (c.itemsPerTask < 3) errors.push("itemsPerTask must be at least 3.");
    if (c.items.length < c.itemsPerTask + 1) {
      errors.push(
        `MaxDiff requires at least itemsPerTask + 1 items (need ${c.itemsPerTask + 1}, got ${c.items.length}).`,
      );
    }
    if (c.tasks < 1) errors.push("tasks must be at least 1.");
    if (c.versions < 1) errors.push("versions must be at least 1.");
    if (new Set(c.items).size !== c.items.length) {
      errors.push("Items must be unique.");
    }
    if (config.appearancesPerItem !== undefined && config.appearancesPerItem !== null && !(config.appearancesPerItem >= 1)) {
      errors.push("Target appearances per item must be at least 1.");
    }

    /*
     * FEASIBILITY OF THE COUNTS. A version has tasks × itemsPerTask places;
     * a target of `a` appearances for each of the version's items needs
     * items × a of them. And across all versions there must be at least one
     * place per item, or some item is never shown to anyone.
     */
    const poolSize = c.itemsPerVersion || c.items.length;
    if (c.appearancesPerItem !== null && config.tasks != null && c.tasks >= 1 && c.itemsPerTask >= 1) {
      const places = c.tasks * c.itemsPerTask;
      const need = poolSize * c.appearancesPerItem;
      if (places < need) {
        errors.push(
          `${c.tasks} tasks × ${c.itemsPerTask} items = ${places} places per version, but ${poolSize} items × ${c.appearancesPerItem} appearances need ${need}. ` +
            `Use at least ${Math.ceil(need / c.itemsPerTask)} tasks, or lower the target.`,
        );
      }
    }
    if (!c.itemsPerVersion && c.tasks >= 1 && c.versions >= 1 && c.items.length > 0 &&
        c.versions * c.tasks * c.itemsPerTask < c.items.length) {
      errors.push(
        `${c.versions * c.tasks} task${c.versions * c.tasks === 1 ? "" : "s"} of ${c.itemsPerTask} items cannot show all ${c.items.length} items even once. ` +
          `Use at least ${Math.ceil(c.items.length / (c.itemsPerTask * c.versions))} tasks per version.`,
      );
    }

    /* PROHIBITED PAIRS: name what is wrong, and refuse what cannot be built */
    const ph = c.prohibited;
    if (ph.unknown.length) errors.push(`Prohibited pairs name items that are not in the list: ${ph.unknown.join(", ")}.`);
    if (ph.self.length) errors.push(`A prohibited pair needs two different items (${ph.self.join(", ")} is paired with itself).`);
    if (ph.pairs.length && c.items.length >= c.itemsPerTask + 1 && c.itemsPerTask >= 3) {
      const n = c.items.length;
      const fm = new Set(ph.pairs.map(([a, b]) => a * n + b));
      const forbidden = (a: number, b: number) => fm.has(a < b ? a * n + b : b * n + a);
      const all = Array.from({ length: n }, (_, i) => i);
      const any = allowedSetExists(all, c.itemsPerTask, forbidden);
      if (any === false) {
        errors.push(
          `The prohibited pairs leave no set of ${c.itemsPerTask} items that can share a task. Remove some pairs or show fewer items per task.`,
        );
      } else {
        const stranded = all.filter((i) => allowedSetExists(all, c.itemsPerTask, forbidden, i, 20_000) === false);
        if (stranded.length) {
          errors.push(
            `The prohibited pairs leave no possible task for ${stranded.map((i) => c.items[i]).join(", ")} — ${stranded.length === 1 ? "it" : "they"} could never be shown.`,
          );
        }
        const maxDegree = Math.max(...all.map((i) => ph.pairs.filter(([a, b]) => a === i || b === i).length));
        if (maxDegree > n - c.itemsPerTask) {
          errors.push(
            `An item is prohibited with ${maxDegree} of the other ${n - 1} items, so it can only ever appear with the same few — show fewer items per task or relax its pairs.`,
          );
        }
      }
    }

    /*
     * Express MaxDiff: the failure worth refusing is a configuration that can
     * never show some items. An item nobody sees has no utility, and its
     * absence from the results reads as a bug in the analysis rather than as
     * a design that was asked for.
     */
    if (c.itemsPerVersion) {
      if (c.itemsPerVersion < c.itemsPerTask + 1) {
        errors.push(
          `Items per version must leave a task something to vary (need at least itemsPerTask + 1 = ${c.itemsPerTask + 1}, got ${c.itemsPerVersion}).`,
        );
      }
      if (c.versions * c.itemsPerVersion < c.items.length) {
        errors.push(
          `${c.versions} version${c.versions === 1 ? "" : "s"} of ${c.itemsPerVersion} items cannot cover ${c.items.length} items — ` +
            `some items would never be shown. Use at least ${Math.ceil(c.items.length / c.itemsPerVersion)} versions.`,
        );
      }
      if (c.versions === 1) {
        errors.push("Express MaxDiff needs more than one version — with one, the items left out are left out of the study.");
      }
    }
    if (c.anchored && !c.anchorPrompt.trim()) {
      errors.push("An anchored design needs a question to ask.");
    }
    if (config.responseMode !== undefined && config.responseMode !== "best_worst" && config.responseMode !== "best_only") {
      errors.push(`Unknown response method "${String(config.responseMode)}" — use best_worst or best_only.`);
    }
    return errors;
  },

  generate(config: MaxDiffConfig, seed: number) {
    const c = normalize(config);
    const n = c.items.length;
    /* `practice` is a column only when practice tasks exist, so a standard file keeps its five columns */
    const columns = ["version", "task", "position", "item_index", "item_label", ...(c.practiceTask ? ["practice"] : [])];
    const rows: Record<string, unknown>[] = [];

    // Global show counts and pairwise co-occurrence counts (across versions),
    // so multi-version designs stay balanced in aggregate too.
    const showCounts = new Array<number>(n).fill(0);
    const pairCounts = new Map<string, number>();
    let algorithm: MaxDiffDiagnostics["algorithm"] = "greedy";

    if (c.balance === "greedy" && !c.prohibited.pairs.length && !c.practiceTask) {
      /* THE ORIGINAL CONSTRUCTION — unchanged, so stored configs regenerate byte-identically */
      for (let version = 1; version <= c.versions; version++) {
        /*
         * EXPRESS: the pool this version may draw from.
         *
         * Chosen by the same global show counts that balance the tasks, so the
         * versions between them cover the list instead of every version
         * reaching for the same head of it. Ties are broken by a seeded
         * shuffle, which keeps the whole design reproducible from (config,
         * seed) exactly as the standard path is.
         */
        const pool = c.itemsPerVersion
          ? seededShuffle(
              Array.from({ length: n }, (_, i) => i),
              subSeed(seed, `maxdiff:pool:v${version}`),
            )
              .sort((a, b) => showCounts[a] - showCounts[b])
              .slice(0, c.itemsPerVersion)
          : null;

        for (let task = 1; task <= c.tasks; task++) {
          const taskSeed = subSeed(seed, `maxdiff:v${version}:t${task}`);
          const rng = mulberry32(taskSeed);
          const chosen: number[] = [];

          while (chosen.length < c.itemsPerTask) {
            // Candidates = items not already in this task, sorted by show count.
            const remaining: number[] = [];
            for (const i of pool ?? Array.from({ length: n }, (_, k) => k)) {
              if (!chosen.includes(i)) remaining.push(i);
            }
            const minShown = Math.min(...remaining.map((i) => showCounts[i]));
            let tied = remaining.filter((i) => showCounts[i] === minShown);

            if (chosen.length > 0 && tied.length > 1) {
              // Among frequency-tied candidates prefer the one whose worst
              // (max) pair count with the already-chosen items is smallest,
              // then whose total added pair count is smallest.
              let best: number[] = [];
              let bestMax = Infinity;
              let bestSum = Infinity;
              for (const cand of tied) {
                let maxPair = 0;
                let sumPair = 0;
                for (const prev of chosen) {
                  const pc = pairCounts.get(pairKey(cand, prev)) ?? 0;
                  if (pc > maxPair) maxPair = pc;
                  sumPair += pc;
                }
                if (
                  maxPair < bestMax ||
                  (maxPair === bestMax && sumPair < bestSum)
                ) {
                  bestMax = maxPair;
                  bestSum = sumPair;
                  best = [cand];
                } else if (maxPair === bestMax && sumPair === bestSum) {
                  best.push(cand);
                }
              }
              tied = best;
            }

            const pick = tied[Math.floor(rng() * tied.length)];
            chosen.push(pick);
          }

          // Update global counters.
          for (const i of chosen) showCounts[i]++;
          for (let a = 0; a < chosen.length; a++) {
            for (let b = a + 1; b < chosen.length; b++) {
              const k = pairKey(chosen[a], chosen[b]);
              pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
            }
          }

          // Seeded shuffle of on-screen order so position is randomized too.
          const ordered = seededShuffle(chosen, subSeed(taskSeed, "order"));
          ordered.forEach((itemIndex, posIdx) => {
            rows.push({
              version,
              task,
              position: posIdx + 1,
              item_index: itemIndex + 1,
              item_label: c.items[itemIndex],
            });
          });
        }
      }
    } else {
      algorithm = c.balance === "optimized" ? "greedy_dfs+pair_swaps" : "greedy_dfs";
      const extra = c.practiceTask ? { practice: 0 } : {};
      for (const v of buildOptimized(c, seed)) {
        if (v.practice) {
          v.practice.forEach((itemIndex, posIdx) => {
            rows.push({ version: v.version, task: 0, position: posIdx + 1, item_index: itemIndex + 1, item_label: c.items[itemIndex], practice: 1 });
          });
        }
        v.tasks.forEach((ordered, ti) => {
          for (const i of ordered) showCounts[i]++;
          for (let a = 0; a < ordered.length; a++) {
            for (let b = a + 1; b < ordered.length; b++) {
              const k = pairKey(ordered[a], ordered[b]);
              pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
            }
          }
          ordered.forEach((itemIndex, posIdx) => {
            rows.push({ version: v.version, task: ti + 1, position: posIdx + 1, item_index: itemIndex + 1, item_label: c.items[itemIndex], ...extra });
          });
        });
      }
    }

    const itemShowCounts: Record<string, number> = {};
    c.items.forEach((label, i) => {
      itemShowCounts[label] = showCounts[i];
    });
    const pairValues = [...pairCounts.values()];
    // Pairs never shown together count as 0.
    const totalPairs = (n * (n - 1)) / 2;
    const pairMin = pairCounts.size < totalPairs ? 0 : Math.min(...pairValues);
    const pairMax = pairValues.length > 0 ? Math.max(...pairValues) : 0;

    /*
     * How many items were never shown at all. Zero on every standard design;
     * the number to look at on an express one, which is why it is reported
     * rather than left to be noticed in the analysis.
     */
    const neverShown = c.items.filter((_, i) => showCounts[i] === 0);

    /*
     * METHOD-05 / MD-P1: how evenly the items were shown and paired, MEASURED
     * on the rows (measureMaxDiffDesign). "balanced" is true only when the
     * item and pair spreads are the smallest these counts allow.
     */
    const diagnostics = measureMaxDiffDesign(rows, c.items, {
      prohibitedPairs: config.prohibitedPairs,
      algorithm,
      express: !!c.itemsPerVersion,
    });
    /* a version that cannot show every item once: allowed across versions, but say it */
    if (!c.itemsPerVersion && c.tasks * c.itemsPerTask < n && c.versions > 1) {
      diagnostics.warnings.push(
        `One version has ${c.tasks * c.itemsPerTask} places for ${n} items, so each respondent sees only part of the list; ` +
          `per-respondent estimates will be weak.`,
      );
    }
    const warnings = diagnostics.warnings;

    return {
      columns,
      rows,
      summary: {
        diagnostics,
        ...(warnings.length ? { warnings } : {}),
        itemShowCounts,
        meanShowsPerItem:
          (c.versions * c.tasks * c.itemsPerTask) / Math.max(n, 1),
        pairCooccurrence: { min: pairMin, max: pairMax },
        versions: c.versions,
        tasksPerVersion: c.tasks,
        itemsPerTask: c.itemsPerTask,
        /* the variants, reported only when they are in play */
        ...(c.anchored ? { anchored: true, anchorPrompt: c.anchorPrompt } : {}),
        ...(c.responseMode !== "best_worst" ? { responseMode: c.responseMode } : {}),
        ...(c.appearancesPerItem !== null ? { appearancesPerItem: c.appearancesPerItem } : {}),
        ...(c.prohibited.pairs.length ? { prohibitedPairs: c.prohibited.pairs.map(([a, b]) => [c.items[a], c.items[b]]) } : {}),
        ...(c.practiceTask ? { practiceTask: true } : {}),
        ...(c.itemsPerVersion
          ? {
              itemsPerVersion: c.itemsPerVersion,
              itemsCovered: n - neverShown.length,
              neverShown,
            }
          : {}),
      },
    };
  },
};
