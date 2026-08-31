/**
 * MaxDiff (best-worst scaling) design generator.
 *
 * Balanced-incomplete-block style greedy construction: each task is filled
 * with the least-shown items (one-way frequency balancing), and among
 * frequency-tied candidates the item adding the least pairwise co-occurrence
 * pressure is preferred (two-way balancing). Seeded shuffles break ties.
 *
 * Deterministic given (config, seed).
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
}

interface NormalizedMaxDiff {
  items: string[];
  itemsPerTask: number;
  tasks: number;
  versions: number;
}

function normalize(config: MaxDiffConfig): NormalizedMaxDiff {
  const items = config.items ?? [];
  const itemsPerTask =
    config.itemsPerTask ?? (items.length >= 6 ? 5 : 4);
  const tasks =
    config.tasks ?? Math.ceil((3 * items.length) / Math.max(itemsPerTask, 1));
  return {
    items,
    itemsPerTask,
    tasks,
    versions: config.versions ?? 1,
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
      for (let task = 1; task <= c.tasks; task++) {
        const taskSeed = subSeed(seed, `maxdiff:v${version}:t${task}`);
        const rng = mulberry32(taskSeed);
        const chosen: number[] = [];

        while (chosen.length < c.itemsPerTask) {
          // Candidates = items not already in this task, sorted by show count.
          const remaining: number[] = [];
          for (let i = 0; i < n; i++) {
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
      },
    };
  },
};
