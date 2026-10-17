/**
 * Choice-Based Conjoint (CBC) design generator.
 *
 * Two methods (`config.method`):
 *
 *   balanced   each alternative is built by picking, per attribute, among the
 *              least-used levels so far (one-way frequency balancing), with
 *              seeded-RNG tie-breaking. Measured (conjoint audit 2026-10-17):
 *              exact one-way balance and, because a level just used is no
 *              longer least-used, MINIMAL overlap — 0% of task × attribute
 *              cells repeat a level when the attribute has as many levels as
 *              the task has concepts. It was described as "balanced
 *              overlap", which is a different (Sawtooth) method that repeats
 *              levels on purpose; the description now says what it does.
 *              The default when `method` is absent, so every existing
 *              configuration regenerates exactly as before.
 *   efficient  the balanced design, then level SWAPPING (Huber & Zwerina
 *              1996) within each version to maximise main-effects
 *              D-efficiency at β = 0. Swaps keep every level's count, so the
 *              one-way balance is untouched; see conjointEfficiency.ts.
 *
 * Every design reports its D-efficiency (pooled and per version), overlap and
 * duplicate checks in `summary.efficiency`.
 *
 * Deterministic given (config, seed): all randomness flows through
 * mulberry32 / subSeed from @rescript/engine.
 */
import type { DesignGeneratorPlugin } from "@rescript/schema";
import { mulberry32, subSeed } from "@rescript/engine";
import { twoWayBalance } from "./diagnostics.js";
import { measureConjointDesign, swapImprove } from "./conjointEfficiency.js";

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
  /**
   * A forbidden COMBINATION, beyond a pair — nested AND / OR / NOT over
   * levels: "Value brand AND (Price $999 OR Warranty 3 years)". When present it
   * is the prohibition (and `a` / `b` are ignored); a concept that matches it
   * is never shown.
   */
  when?: ConjointLevelCondition;
  /**
   * The editor's form of a combination: the pair a + b, AND these levels
   * (`alsoOp: "and"`, all of them) or AND any one of them (`"or"`):
   * "never Value with $999 and (3 years or 2 years)". Read only when `when`
   * is absent; `effectiveProhibition` turns it into the tree.
   */
  also?: { attribute: string; level: string }[];
  alsoOp?: "and" | "or";
  /** why, for whoever reads the design file later */
  note?: string;
}

/** a prohibition as one level condition — `when`, else the pair (and its `also` levels) */
export function effectiveProhibition(p: ConjointProhibition): ConjointLevelCondition {
  if (p.when) return p.when;
  const extra = (p.also ?? []).filter((x) => x?.attribute && x.level != null);
  if (!extra.length) return { op: "and", children: [p.a, p.b] };
  const tail: ConjointLevelCondition[] = p.alsoOp === "or" ? [{ op: "or", children: extra }] : extra;
  return { op: "and", children: [p.a, p.b, ...tail] };
}

/** a level test, or an and / or / not group of them, nested to any depth */
export type ConjointLevelCondition =
  | { attribute: string; level: string }
  | { op: "and" | "or" | "not"; children: ConjointLevelCondition[] };

/** does a concept match a level condition? (an empty and/or/not group never forbids anything) */
export function conceptMatches(profile: Record<string, string>, c: ConjointLevelCondition, depth = 0): boolean {
  if (depth > 64) return false;
  if ("attribute" in c) return profile[c.attribute] === c.level;
  if (!c.children.length) return false;
  if (c.op === "and") return c.children.every((k) => conceptMatches(profile, k, depth + 1));
  if (c.op === "or") return c.children.some((k) => conceptMatches(profile, k, depth + 1));
  return !c.children.some((k) => conceptMatches(profile, k, depth + 1));
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
  /**
   * Design method: "balanced" (frequency-balanced, minimal overlap — the
   * default when absent, so stored configurations regenerate unchanged) or
   * "efficient" (balanced, then D-efficiency swapping within each version).
   */
  method?: "balanced" | "efficient";
  /** Text of the None alternative shown to respondents. Default "None of these". */
  noneLabel?: string;
}

/** The design-file columns a CBC design writes besides its attributes — an attribute may not be named after one. */
export const CONJOINT_RESERVED_COLUMNS = ["version", "task", "alt", "is_holdout", "none_option", "position", "item_index", "item_label"] as const;

const MAX_REDRAWS = 30;

/**
 * The efficient method's work budget: swap evaluations over the whole design,
 * shared equally by the versions, never fewer than SWAP_MIN_PER_VERSION each.
 * A count, not a clock, so the design is reproducible from (config, seed).
 * Measured (conjoint audit 2026-10-17): a 12-task version of 4 three-level
 * attributes converges in about 5 000 evaluations, so up to ~40 versions run
 * to convergence; beyond that each version stops at its share.
 */
const SWAP_EVALUATION_BUDGET = 200_000;
const SWAP_MIN_PER_VERSION = 600;

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
  method: "balanced" | "efficient";
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
    method: config.method === "efficient" ? "efficient" : "balanced",
  };
}

/** Whether a finished concept breaks any prohibition. */
function violates(profile: Record<string, string>, prohibitions: ConjointProhibition[]): boolean {
  for (const p of prohibitions) {
    if (p.when || p.also?.length) { if (conceptMatches(profile, effectiveProhibition(p))) return true; continue; }
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
    "CBC design: level-balanced, minimal-overlap concepts (optionally improved for D-efficiency by level swapping), prohibitions honoured, no duplicate concept within a task, optional None option, holdout tasks and versions. The summary reports measured D-efficiency, balance and overlap.",
  configFields: [
    {
      name: "method",
      label: "Design method",
      type: "select",
      // "balanced" first: a stored configuration with no method shows (and generates) balanced
      options: ["balanced", "efficient"],
      default: "efficient",
      help: "efficient — level-balanced, then levels are swapped between concepts to maximise D-efficiency (Huber–Zwerina); level counts do not change. balanced — level-balanced, minimal overlap, no optimisation (faster, slightly less efficient per version).",
    },
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
      name: "noneLabel",
      label: "None option text",
      type: "text",
      help: "What respondents read for the opt-out, e.g. \"I would not buy any of these\". Blank = \"None of these\".",
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
    /*
     * Conjoint audit 2026-10-17. Each of these produced a design that looked
     * fine and was not: an attribute called "task" overwrote the task number
     * of every concept; a level listed twice made two codes for one label; a
     * blank level rendered as an empty cell; 2.5 tasks generated 2.
     */
    for (const attr of c.attributes) {
      if (attr.name && (CONJOINT_RESERVED_COLUMNS as readonly string[]).includes(attr.name.trim().toLowerCase())) {
        errors.push(`"${attr.name}" cannot be an attribute name — the design file uses that column. Rename the attribute.`);
      }
      const levels = (attr.levels ?? []).map((l) => String(l));
      if (levels.some((l) => !l.trim())) errors.push(`Attribute "${attr.name}" has a blank level.`);
      const dupes = levels.filter((l, i) => levels.indexOf(l) !== i);
      if (dupes.length) errors.push(`Attribute "${attr.name}" lists "${dupes[0]}" more than once — every level must be different.`);
    }
    if (c.alternativesPerTask < 2) {
      errors.push("alternativesPerTask must be at least 2.");
    }
    if (c.tasks < 1) errors.push("tasks must be at least 1.");
    if (c.holdoutTasks < 0) errors.push("holdoutTasks cannot be negative.");
    if (c.versions < 1) errors.push("versions must be at least 1.");
    for (const [k, v] of [["tasks", c.tasks], ["alternativesPerTask", c.alternativesPerTask], ["holdoutTasks", c.holdoutTasks], ["versions", c.versions]] as const) {
      if (!Number.isInteger(v)) errors.push(`${k} must be a whole number (got ${v}).`);
    }
    if (config.method != null && config.method !== "balanced" && config.method !== "efficient") {
      errors.push(`Unknown design method "${String(config.method)}" — use "efficient" or "balanced".`);
    }
    /*
     * The concept space must hold a task's worth of DIFFERENT concepts even
     * with no prohibition at all: two attributes of two levels have four
     * concepts, and a task of five used to be generated with a duplicate.
     */
    if (errors.length === 0 && c.prohibitions.length === 0) {
      const space = c.attributes.reduce((n, a) => n * Math.max(1, a.levels.length), 1);
      if (space < c.alternativesPerTask) {
        errors.push(`These attributes make only ${space} different concepts, and each task needs ${c.alternativesPerTask}. Add levels or attributes, or show fewer alternatives per task.`);
      }
    }

    /* --- prohibitions: real levels, and enough concepts left to field --- */
    const levelsOf = new Map(c.attributes.map((a) => [a.name, new Set(a.levels)]));
    for (const p of c.prohibitions) {
      /* a combination prohibition: every level it names must be real */
      if (p.when || p.also?.length) {
        const leaves: { attribute: string; level: string }[] = [];
        const walk = (x: ConjointLevelCondition, d = 0) => { if (d > 64) return; if ("attribute" in x) leaves.push(x); else x.children.forEach((k) => walk(k, d + 1)); };
        walk(effectiveProhibition(p));
        for (const side of leaves) {
          const known = levelsOf.get(side.attribute);
          if (!known) errors.push(`Prohibition names attribute "${side.attribute}", which is not in this design.`);
          else if (!known.has(side.level)) errors.push(`Prohibition names level "${side.level}" of "${side.attribute}", which is not one of its levels.`);
        }
        continue;
      }
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
     * So the configuration is validated here too, not only in the editor —
     * every configuration now, not only one with prohibitions (a too-small
     * concept space produced duplicate concepts with none configured).
     */
    {
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
          if (!accepted) {
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

    /*
     * EFFICIENT: level swapping within each version (Huber & Zwerina). The
     * level counts — and with them `levelCounts` and the one-way balance —
     * are unchanged by construction. A work budget, not a clock, bounds it so
     * the result is reproducible: about 3·10⁸ multiply-adds over the design.
     */
    let optimisation: Record<string, unknown> | undefined;
    if (c.method === "efficient") {
      const budget = Math.max(SWAP_MIN_PER_VERSION, Math.floor(SWAP_EVALUATION_BUDGET / c.versions));
      let swaps = 0, evaluations = 0, exhausted = 0;
      const legal = c.prohibitions.length ? (pr: Record<string, string>) => !violates(pr, c.prohibitions) : null;
      const byVersionTask = new Map<string, Record<string, unknown>[]>();
      for (const r of rows) {
        if (Number(r.none_option) === 1) continue;
        const k = `${r.version}:${r.task}`;
        (byVersionTask.get(k) ?? byVersionTask.set(k, []).get(k)!).push(r);
      }
      for (let version = 1; version <= c.versions; version++) {
        const taskRows: Record<string, unknown>[][] = [];
        for (let task = 1; task <= c.tasks; task++) taskRows.push(byVersionTask.get(`${version}:${task}`) ?? []);
        const profiles = taskRows.map((ts) => ts.map((r) => Object.fromEntries(c.attributes.map((a) => [a.name, String(r[a.name])]))));
        const res = swapImprove(c.attributes, profiles, legal, mulberry32(subSeed(seed, `conjoint:swap:v${version}`)), { maxEvaluations: budget });
        swaps += res.swaps; evaluations += res.evaluations; if (res.exhausted) exhausted++;
        taskRows.forEach((ts, t) => ts.forEach((r, j) => Object.assign(r, profiles[t][j])));
      }
      optimisation = { algorithm: "level swapping (Huber & Zwerina 1996)", swaps, evaluations, versionsStoppedAtBudget: exhausted };
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

    /*
     * METHOD-05: two-way balance over the concepts respondents are estimated
     * from (holdouts and the None row are not). A cell a prohibition makes
     * impossible is not counted as unbalanced.
     */
    const estimationProfiles = rows
      .filter((r) => Number(r.is_holdout) !== 1 && Number(r.none_option) !== 1)
      .map((r) => Object.fromEntries(c.attributes.map((a) => [a.name, String(r[a.name])])));
    const possible = legalPool
      ? (a: string, la: string, b: string, lb: string) => legalPool.some((p) => p[a] === la && p[b] === lb)
      : undefined;
    const diagnostics = twoWayBalance(c.attributes, estimationProfiles, possible);
    const efficiency = measureConjointDesign(c.attributes, rows);
    /*
     * One version too short to identify the model on its own: fine for the
     * aggregate model (versions are pooled), not for individual-level (HB)
     * estimation — say so rather than show a per-version efficiency of 0.
     */
    const designWarnings = [...diagnostics.warnings];
    if (efficiency.minVersionDegreesOfFreedom < efficiency.parameters) {
      designWarnings.push(
        `One version gives ${efficiency.minVersionDegreesOfFreedom} choice degrees of freedom for ${efficiency.parameters} part-worths, so a single respondent's answers cannot identify the model (per-version D-efficiency is 0). The aggregate model pools versions and is unaffected; for individual-level (HB) estimation use at least ${Math.ceil(efficiency.parameters / Math.max(1, c.alternativesPerTask - 1))} tasks.`,
      );
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
        method: c.method,
        levelFrequencies,
        balanceScores,
        diagnostics,
        efficiency,
        ...(optimisation ? { optimisation } : {}),
        ...(designWarnings.length ? { warnings: designWarnings } : {}),
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
