/**
 * Choice-Based Conjoint (CBC) design generator.
 *
 * Balanced-overlap style: each alternative is built by picking, per attribute,
 * among the least-used levels so far (one-way frequency balancing), with
 * seeded-RNG tie-breaking. Duplicate alternatives inside a task are avoided
 * by re-drawing a bounded number of times.
 *
 * Deterministic given (config, seed): all randomness flows through
 * mulberry32 / subSeed from @rescript/engine.
 */
import type { DesignGeneratorPlugin } from "@rescript/schema";
import { mulberry32, subSeed } from "@rescript/engine";

export interface ConjointAttribute {
  name: string;
  levels: string[];
}

export interface ConjointConfig {
  attributes: ConjointAttribute[];
  /** Number of choice tasks per version (excluding holdouts). Default 10. */
  tasks?: number;
  /** Alternatives (concepts) shown per task. Default 3. */
  alternativesPerTask?: number;
  /** Whether a "None of these" option is appended to each task. */
  noneOption?: boolean;
  /** Holdout tasks appended after the main tasks and flagged. Default 0. */
  holdoutTasks?: number;
  /** Number of design versions (blocks). Default 1. */
  versions?: number;
}

const MAX_REDRAWS = 30;

interface NormalizedConjoint {
  attributes: ConjointAttribute[];
  tasks: number;
  alternativesPerTask: number;
  noneOption: boolean;
  holdoutTasks: number;
  versions: number;
}

function normalize(config: ConjointConfig): NormalizedConjoint {
  return {
    attributes: config.attributes ?? [],
    tasks: config.tasks ?? 10,
    alternativesPerTask: config.alternativesPerTask ?? 3,
    noneOption: config.noneOption ?? false,
    holdoutTasks: config.holdoutTasks ?? 0,
    versions: config.versions ?? 1,
  };
}

/** Pick one level for an attribute, preferring the least-used level so far. */
function pickBalancedLevel(
  levels: string[],
  counts: Map<string, number>,
  rng: () => number,
): string {
  let min = Infinity;
  for (const level of levels) {
    const c = counts.get(level) ?? 0;
    if (c < min) min = c;
  }
  const candidates = levels.filter((l) => (counts.get(l) ?? 0) === min);
  return candidates[Math.floor(rng() * candidates.length)];
}

export const conjointPlugin: DesignGeneratorPlugin<ConjointConfig> = {
  kind: "conjoint",
  label: "Choice-Based Conjoint (CBC)",
  description:
    "Balanced-overlap CBC design: frequency-balanced level assignment per attribute, no duplicate concepts within a task, optional None option and holdout tasks.",
  configFields: [
    {
      name: "attributes",
      label: "Attributes & levels",
      type: "attributes",
      help: "Each attribute needs at least 2 levels.",
    },
    { name: "tasks", label: "Tasks per version", type: "number", default: 10 },
    {
      name: "alternativesPerTask",
      label: "Alternatives per task",
      type: "number",
      default: 3,
    },
    {
      name: "noneOption",
      label: "Include a None option",
      type: "boolean",
      default: false,
    },
    {
      name: "holdoutTasks",
      label: "Holdout tasks",
      type: "number",
      default: 0,
      help: "Appended after the main tasks and flagged is_holdout = 1.",
    },
    {
      name: "versions",
      label: "Versions (blocks)",
      type: "number",
      default: 1,
    },
  ],

  validateConfig(config: ConjointConfig): string[] {
    const errors: string[] = [];
    const c = normalize(config);
    if (c.attributes.length < 2) {
      errors.push("Conjoint requires at least 2 attributes.");
    }
    for (const attr of c.attributes) {
      if (!attr.name) errors.push("Every attribute needs a name.");
      if (!attr.levels || attr.levels.length < 2) {
        errors.push(
          `Attribute "${attr.name ?? "?"}" needs at least 2 levels.`,
        );
      }
    }
    const names = c.attributes.map((a) => a.name);
    if (new Set(names).size !== names.length) {
      errors.push("Attribute names must be unique.");
    }
    if (c.alternativesPerTask < 2) {
      errors.push("alternativesPerTask must be at least 2.");
    }
    if (c.tasks < 1) errors.push("tasks must be at least 1.");
    if (c.holdoutTasks < 0) errors.push("holdoutTasks cannot be negative.");
    if (c.versions < 1) errors.push("versions must be at least 1.");
    return errors;
  },

  generate(config: ConjointConfig, seed: number) {
    const c = normalize(config);
    const columns = [
      "version",
      "task",
      "alt",
      "is_holdout",
      ...c.attributes.map((a) => a.name),
      "none_option",
    ];
    const rows: Record<string, unknown>[] = [];

    // Global level-usage counts across the whole design (for balance + summary).
    const levelCounts = new Map<string, Map<string, number>>();
    for (const attr of c.attributes) {
      levelCounts.set(attr.name, new Map(attr.levels.map((l) => [l, 0])));
    }

    const totalTasks = c.tasks + c.holdoutTasks;

    for (let version = 1; version <= c.versions; version++) {
      for (let task = 1; task <= totalTasks; task++) {
        const isHoldout = task > c.tasks;
        const rng = mulberry32(
          subSeed(seed, `conjoint:v${version}:t${task}`),
        );
        const seen = new Set<string>();
        for (let alt = 1; alt <= c.alternativesPerTask; alt++) {
          let profile: Record<string, string> = {};
          let key = "";
          let accepted = false;
          for (let attempt = 0; attempt <= MAX_REDRAWS; attempt++) {
            profile = {};
            for (const attr of c.attributes) {
              profile[attr.name] = pickBalancedLevel(
                attr.levels,
                levelCounts.get(attr.name)!,
                rng,
              );
            }
            key = c.attributes.map((a) => profile[a.name]).join("");
            if (!seen.has(key)) {
              accepted = true;
              break;
            }
            // Re-draw: perturb by consuming RNG (pickBalancedLevel already
            // advances the stream), so the next attempt differs.
          }
          if (!accepted) {
            // Fall back: mutate one attribute to a different level to force
            // uniqueness (only reachable when the level space is tiny).
            for (const attr of c.attributes) {
              for (const level of attr.levels) {
                if (level === profile[attr.name]) continue;
                const trial = { ...profile, [attr.name]: level };
                const trialKey = c.attributes
                  .map((a) => trial[a.name])
                  .join("");
                if (!seen.has(trialKey)) {
                  profile = trial;
                  key = trialKey;
                  accepted = true;
                  break;
                }
              }
              if (accepted) break;
            }
          }
          seen.add(key);
          for (const attr of c.attributes) {
            const counts = levelCounts.get(attr.name)!;
            counts.set(
              profile[attr.name],
              (counts.get(profile[attr.name]) ?? 0) + 1,
            );
          }
          rows.push({
            version,
            task,
            alt,
            is_holdout: isHoldout ? 1 : 0,
            ...profile,
            none_option: 0,
          });
        }
        if (c.noneOption) {
          const noneRow: Record<string, unknown> = {
            version,
            task,
            alt: c.alternativesPerTask + 1,
            is_holdout: isHoldout ? 1 : 0,
            none_option: 1,
          };
          for (const attr of c.attributes) noneRow[attr.name] = "";
          rows.push(noneRow);
        }
      }
    }

    // Summary: level frequencies and one-way balance score per attribute.
    const levelFrequencies: Record<string, Record<string, number>> = {};
    const balanceScores: Record<string, number> = {};
    for (const attr of c.attributes) {
      const counts = levelCounts.get(attr.name)!;
      levelFrequencies[attr.name] = Object.fromEntries(counts);
      const values = [...counts.values()];
      const max = Math.max(...values);
      const min = Math.min(...values);
      balanceScores[attr.name] = min === 0 ? Infinity : max / min;
    }

    return {
      columns,
      rows,
      summary: {
        levelFrequencies,
        balanceScores,
        versions: c.versions,
        tasksPerVersion: c.tasks,
        holdoutTasksPerVersion: c.holdoutTasks,
        alternativesPerTask: c.alternativesPerTask,
        noneOption: c.noneOption,
      },
    };
  },
};
