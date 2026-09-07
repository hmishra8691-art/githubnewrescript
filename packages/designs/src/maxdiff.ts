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

export interface MaxDiffConfig {
  items: string[];
  /** Items shown per task. Default 5 (or 4 when fewer than 6 items). */
  itemsPerTask?: number;
  /** Tasks per version. Default ceil(3 * items / itemsPerTask). */
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
}

export const DEFAULT_ANCHOR_PROMPT =
  "Thinking about the items in this set, how many of them are important to you?";

interface NormalizedMaxDiff {
  items: string[];
  itemsPerTask: number;
  tasks: number;
  versions: number;
  anchored: boolean;
  anchorPrompt: string;
  /** 0 = the whole list is available to every version (standard) */
  itemsPerVersion: number;
}

function normalize(config: MaxDiffConfig): NormalizedMaxDiff {
  const items = config.items ?? [];
  const itemsPerTask =
    config.itemsPerTask ?? (items.length >= 6 ? 5 : 4);
  const tasks =
    config.tasks ?? Math.ceil((3 * items.length) / Math.max(itemsPerTask, 1));
  const versions = config.versions ?? 1;
  const perVersion = config.itemsPerVersion ?? 0;
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
    itemsPerVersion: perVersion > 0 && perVersion < items.length ? perVersion : 0,
  };
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export const maxdiffPlugin: DesignGeneratorPlugin<MaxDiffConfig> = {
  kind: "maxdiff",
  label: "MaxDiff (Best-Worst Scaling)",
  description:
    "Greedy balanced-incomplete-block MaxDiff design: balances how often each item is shown and how often each pair co-occurs.",
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
      help: "Defaults to ceil(3 x items / items per task) so each item is shown about 3 times.",
    },
    {
      name: "versions",
      label: "Versions (blocks)",
      type: "number",
      default: 1,
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
    return errors;
  },

  generate(config: MaxDiffConfig, seed: number) {
    const c = normalize(config);
    const n = c.items.length;
    const columns = ["version", "task", "position", "item_index", "item_label"];
    const rows: Record<string, unknown>[] = [];

    // Global show counts and pairwise co-occurrence counts (across versions),
    // so multi-version designs stay balanced in aggregate too.
    const showCounts = new Array<number>(n).fill(0);
    const pairCounts = new Map<string, number>();

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

    return {
      columns,
      rows,
      summary: {
        itemShowCounts,
        meanShowsPerItem:
          (c.versions * c.tasks * c.itemsPerTask) / Math.max(n, 1),
        pairCooccurrence: { min: pairMin, max: pairMax },
        versions: c.versions,
        tasksPerVersion: c.tasks,
        itemsPerTask: c.itemsPerTask,
        /* the variants, reported only when they are in play */
        ...(c.anchored ? { anchored: true, anchorPrompt: c.anchorPrompt } : {}),
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
