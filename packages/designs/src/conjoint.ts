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

/**
 * A pair of levels that may never appear together in one concept.
 *
 * Prohibitions are the feature every commercial conjoint tool has and this
 * generator did not: without them a design cheerfully offers "Value brand at
 * $999 with a 3-year warranty", the respondent stops believing the exercise,
 * and the utilities that come back are measuring disbelief. The word
 * "prohibit" did not appear anywhere in the codebase.
 *
 * They are expensive to over-use — every prohibition removes concepts from
 * the space and unbalances what is left — so the generator reports how much
 * of the space each one costs, and `validateConfig` refuses a set that leaves
 * too few legal concepts to fill a task.
 */
export interface ConjointProhibition {
  /** one side of the forbidden pair */
  a: { attribute: string; level: string };
  /** the other side */
  b: { attribute: string; level: string };
  /** why, for whoever reads the design file later */
  note?: string;
}

export interface ConjointConfig {
  attributes: ConjointAttribute[];
  /** level pairs that may not appear together in one concept */
  prohibitions?: ConjointProhibition[];
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

/**
 * The separator that joins a concept's levels into its uniqueness key.
 *
 * It must be a character no level label can contain, because an EMPTY
 * separator makes two different concepts collide: levels "AB","C" and
 * "A","BC" both join to "ABC", so one of them would be discarded as a
 * duplicate of the other. U+0001 was already doing this job — as a literal,
 * invisible control character typed straight into the source since the first
 * commit, which greps strangely, survives copy-paste badly and reads as a
 * mistake. Same behaviour, said out loud.
 */
const CONCEPT_KEY_SEP = "\u0001";

interface NormalizedConjoint {
  attributes: ConjointAttribute[];
  prohibitions: ConjointProhibition[];
  tasks: number;
  alternativesPerTask: number;
  noneOption: boolean;
  holdoutTasks: number;
  versions: number;
}

function normalize(config: ConjointConfig): NormalizedConjoint {
  return {
    attributes: config.attributes ?? [],
    prohibitions: config.prohibitions ?? [],
    tasks: config.tasks ?? 10,
    alternativesPerTask: config.alternativesPerTask ?? 3,
    noneOption: config.noneOption ?? false,
    holdoutTasks: config.holdoutTasks ?? 0,
    versions: config.versions ?? 1,
  };
}

/** Whether a finished concept breaks any prohibition. */
function violates(profile: Record<string, string>, prohibitions: ConjointProhibition[]): boolean {
  for (const p of prohibitions) {
    if (profile[p.a.attribute] === p.a.level && profile[p.b.attribute] === p.b.level) return true;
    // a prohibition is symmetric: saying "not X with Y" is saying "not Y with X"
    if (profile[p.b.attribute] === p.b.level && profile[p.a.attribute] === p.a.level) return true;
  }
  return false;
}

/**
 * Every legal concept, when the space is small enough to enumerate.
 *
 * Used for two things: refusing an infeasible prohibition set before a single
 * task is generated, and as the last-resort fallback when random redraws
 * cannot find a legal concept the task has not already used. Bounded, because
 * a full factorial of six five-level attributes is 15 625 and of twelve is
 * millions — beyond the cap the generator falls back to redrawing, which is
 * what it did before prohibitions existed.
 */
const ENUMERATION_CAP = 200_000;

function enumerateLegal(c: NormalizedConjoint): Record<string, string>[] | null {
  const size = c.attributes.reduce((n, a) => n * Math.max(1, a.levels.length), 1);
  if (size > ENUMERATION_CAP) return null;
  let out: Record<string, string>[] = [{}];
  for (const attr of c.attributes) {
    const next: Record<string, string>[] = [];
    for (const partial of out) {
      for (const level of attr.levels) next.push({ ...partial, [attr.name]: level });
    }
    out = next;
  }
  return out.filter((p) => !violates(p, c.prohibitions));
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
    {
      name: "prohibitions",
      label: "Prohibitions",
      type: "prohibitions",
      help: "Level pairs that must never appear together in one concept — e.g. a value brand at the top price.",
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

    /* --- prohibitions: real levels, and enough concepts left to field --- */
    const levelsOf = new Map(c.attributes.map((a) => [a.name, new Set(a.levels)]));
    for (const p of c.prohibitions) {
      for (const side of [p.a, p.b]) {
        const known = levelsOf.get(side.attribute);
        if (!known) {
          errors.push(`Prohibition names attribute "${side.attribute}", which is not in this design.`);
        } else if (!known.has(side.level)) {
          errors.push(`Prohibition names level "${side.level}" of "${side.attribute}", which is not one of its levels.`);
        }
      }
      if (p.a.attribute === p.b.attribute) {
        errors.push(
          `A prohibition cannot pair two levels of the same attribute ("${p.a.attribute}") — a concept only ever has one of them.`,
        );
      }
    }
    if (errors.length === 0 && c.prohibitions.length > 0) {
      const legal = enumerateLegal(c);
      if (legal) {
        if (legal.length === 0) {
          errors.push("These prohibitions rule out every possible concept — no design can be generated.");
        } else if (legal.length < c.alternativesPerTask) {
          errors.push(
            `These prohibitions leave only ${legal.length} legal concept${legal.length === 1 ? "" : "s"}, and each task needs ${c.alternativesPerTask} different ones.`,
          );
        }
        /* a level that survives in no legal concept cannot be estimated */
        for (const attr of c.attributes) {
          for (const level of attr.levels) {
            if (!legal.some((p) => p[attr.name] === level)) {
              errors.push(
                `"${level}" (${attr.name}) appears in no legal concept, so its utility could never be estimated. Relax a prohibition or remove the level.`,
              );
            }
          }
        }
      }
    }
    return errors;
  },

  generate(config: ConjointConfig, seed: number) {
    const c = normalize(config);
    /*
     * A generator that quietly emits an illegal concept is worse than one
     * that refuses: the design file looks fine, the survey fields it, and the
     * prohibition the client asked for is violated in front of a respondent.
     * So the configuration is validated here too, not only in the editor.
     */
    if (c.prohibitions.length) {
      const problems = conjointPlugin.validateConfig!(config);
      if (problems.length) throw new Error(problems[0]);
    }
    /* the legal space, for the fallback when redraws cannot find a concept */
    const legalPool = c.prohibitions.length ? enumerateLegal(c) : null;
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
            key = c.attributes.map((a) => profile[a.name]).join(CONCEPT_KEY_SEP);
            // a concept must be new to this task AND legal under every
            // prohibition; with none configured the second test is free and
            // the behaviour is exactly what it was before they existed
            if (!seen.has(key) && !violates(profile, c.prohibitions)) {
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
                  .join(CONCEPT_KEY_SEP);
                if (!seen.has(trialKey) && !violates(trial, c.prohibitions)) {
                  profile = trial;
                  key = trialKey;
                  accepted = true;
                  break;
                }
              }
              if (accepted) break;
            }
          }
          if (!accepted && legalPool) {
            /*
             * Last resort, and the reason prohibitions can be trusted: walk
             * the enumerated legal space for a concept this task has not
             * used yet. Deterministic, so the design stays reproducible from
             * (config, seed).
             */
            const start = Math.floor(rng() * legalPool.length);
            for (let k = 0; k < legalPool.length; k++) {
              const cand = legalPool[(start + k) % legalPool.length];
              const candKey = c.attributes.map((a) => cand[a.name]).join(CONCEPT_KEY_SEP);
              if (!seen.has(candKey)) {
                profile = { ...cand };
                key = candKey;
                accepted = true;
                break;
              }
            }
          }
          if (!accepted && c.prohibitions.length) {
            throw new Error(
              `Task ${task} of version ${version} needs ${c.alternativesPerTask} different legal concepts, and these prohibitions do not allow that many. Relax a prohibition, or show fewer alternatives per task.`,
            );
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
      /*
       * What the prohibitions cost, in the summary rather than in a comment:
       * a programmer who prohibits eight pairs should be able to see that
       * they have removed a third of the design space before they wonder why
       * their standard errors grew.
       */
      summary: {
        levelFrequencies,
        balanceScores,
        ...(c.prohibitions.length
          ? {
            prohibitions: c.prohibitions.length,
            legalConcepts: legalPool?.length ?? null,
            totalConcepts: c.attributes.reduce((n, a) => n * Math.max(1, a.levels.length), 1),
            spaceRemaining: legalPool
              ? Math.round((legalPool.length / c.attributes.reduce((n, a) => n * Math.max(1, a.levels.length), 1)) * 1000) / 10
              : null,
          }
          : {}),
        versions: c.versions,
        tasksPerVersion: c.tasks,
        holdoutTasksPerVersion: c.holdoutTasks,
        alternativesPerTask: c.alternativesPerTask,
        noneOption: c.noneOption,
      },
    };
  },
};
