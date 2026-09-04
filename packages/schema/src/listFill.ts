import { z } from "zod";
import { Condition } from "./conditions.js";

/**
 * ADVANCED LIST FILL — the configuration half of the allocation engine.
 *
 * A List Fill is a first-class, versioned object in the survey definition
 * (`def.listFills[]`), not a property hidden on a question. It takes a
 * CANDIDATE LIST — usually the options a respondent selected in a source
 * question, but equally a static list, a calculation, embedded data or a
 * previous List Fill — and decides which of them this respondent gets, under
 * per-option priority, targets, caps, eligibility and the survey's quotas,
 * counting against the WHOLE SAMPLE rather than the current respondent.
 *
 * Everything the engine reads lives here, so the same configuration drives
 * the builder, the simulator, preview, test and production, and travels
 * inside the version a deployment is pinned to.
 *
 * The lifecycle the engine runs (see `@rescript/engine` listFill.ts):
 *
 *   source → candidates → eligibility → priority → target/min/max
 *          → quota → remaining capacity → strategy → randomisation/fallback
 *          → final list → variables → piping / logic / destinations
 *
 * Each stage is configured independently, and the engine records what each
 * one did per option so a decision can always be explained.
 */

/* ------------------------------------------------------------ candidates */

/**
 * Where the candidate list comes from. A source question is the common case
 * (§2), but the list is deliberately not tied to one: §16 asks for dynamic,
 * calculated, imported and script-generated lists, and §22 for source
 * questions populated by anything at all — including hidden ones, which
 * execute exactly like visible ones (§21: visibility is not execution).
 */
export const ListFillSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("question"),
    questionId: z.string(),
    /**
     * `selected` — the codes this respondent chose (the default).
     * `displayed` — every option the option pipeline showed them.
     * `all` — every option programmed on the question, chosen or not.
     */
    take: z.enum(["selected", "displayed", "all"]).default("selected"),
  }),
  z.object({
    kind: z.literal("static"),
    items: z.array(z.object({ code: z.string(), label: z.string() })).default([]),
  }),
  /** a calculation or embedded field holding a list (array, or a delimited string) */
  z.object({ kind: z.literal("calculation"), ref: z.string() }),
  z.object({ kind: z.literal("embedded"), ref: z.string() }),
  /** the final items of another List Fill — chaining allocations */
  z.object({ kind: z.literal("listFill"), listFillId: z.string() }),
  /** a registered script returns the candidate codes (§16, §34) */
  z.object({ kind: z.literal("script"), scriptId: z.string() }),
]);
export type ListFillSource = z.infer<typeof ListFillSource>;

/* ------------------------------------------------------------ strategies */

/**
 * How the engine picks among options that are all eligible and all have
 * capacity. Priority is applied first in every `priority*` method; these
 * names describe what breaks the remaining tie.
 */
export const ListFillMethod = z.enum([
  "first_selected",      // the respondent's own first choice wins
  "selection_order",     // keep the respondent's order, take the first N
  "highest_priority",    // lowest priority number first
  "lowest_priority",     // highest priority number first
  "random",              // ignore priority entirely
  "weighted_random",     // by each option's weight
  "balanced_random",     // favour whichever option is furthest from its target
  "priority_random",     // priority bands, random inside a band
  "priority_quota",      // priority bands, quota- and capacity-aware inside one
  "quota_aware_random",  // random, but weighted by remaining capacity
  "custom",              // a script decides (§34)
]);
export type ListFillMethod = z.infer<typeof ListFillMethod>;

/** How options sharing one priority number are separated (§12). */
export const EqualPriorityRule = z.enum([
  "random",
  "balanced",            // the one furthest below its target goes first
  "sequential",          // programmed order — deterministic, no randomness
  "weighted",
  "quota_aware_random",
]);
export type EqualPriorityRule = z.infer<typeof EqualPriorityRule>;

/** What happens to an option once its TARGET is met but its maximum is not (§8). */
export const AfterTargetRule = z.enum([
  "continue",            // nothing changes; the cap is the only real limit
  "reduce_priority",     // drops below every option still under target
  "random_pool",         // leaves the priority order, joins the fallback pool
  "next_priority",       // skip it while anything else is under target
  "stop",                // treat the target as the cap
]);
export type AfterTargetRule = z.infer<typeof AfterTargetRule>;

/** What happens once an option's MAXIMUM is reached (§10). Always terminal. */
export const AfterMaximumRule = z.enum([
  "next_priority",       // move down the priority order (the default)
  "random_fallback",     // pick randomly among whatever is still open
  "stop",                // allocate nothing rather than substitute
]);
export type AfterMaximumRule = z.infer<typeof AfterMaximumRule>;

/** How the pool is chosen once the priority order is exhausted (§11). */
export const FallbackRule = z.enum([
  "none",                // return fewer items rather than substitute
  "random_eligible",     // random among eligible options with capacity
  "weighted_eligible",
  "balanced_eligible",   // furthest-from-target first
  "next_priority",       // simply keep walking the priority order
]);
export type FallbackRule = z.infer<typeof FallbackRule>;

/* ------------------------------------------------------------ how many */

/**
 * How many items to return (§4). A fixed number, everything eligible, or a
 * count read from the survey itself — another question's answer, a
 * calculation, or an expression — so the size of the list can depend on the
 * respondent.
 */
export const ListFillCount = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), n: z.number().int().min(0).default(1) }),
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("question"), questionId: z.string() }),
  z.object({ kind: z.literal("calculation"), ref: z.string() }),
  /** calc-engine expression, e.g. `min(3, Q1_COUNT)` */
  z.object({ kind: z.literal("expression"), expression: z.string() }),
]);
export type ListFillCount = z.infer<typeof ListFillCount>;

/* ------------------------------------------------------------ per option */

/**
 * One option's allocation settings. Priority and capacity are INDEPENDENT
 * properties (§5): priority is the order the engine tries options in, and
 * target/maximum are how much of the sample each may take. An option with no
 * maximum is unlimited; one with no priority sits after every option that has
 * one, which is how §10's "D/E are random fallback" is expressed without a
 * special case.
 */
export const ListFillOption = z.object({
  /** the option code in the source list */
  code: z.string(),
  /** label override; otherwise the source question's own label is used */
  label: z.string().optional(),
  /** lower runs first; absent = after every prioritised option */
  priority: z.number().int().optional(),
  /** desired allocations across the sample */
  target: z.number().int().min(0).optional(),
  /** absolute cap; once reached the option is unavailable, always */
  maximum: z.number().int().min(0).optional(),
  /**
   * Allocate at least this many before the engine is allowed to treat the
   * option as optional. A minimum still yields to a hard cap and to quotas —
   * it raises urgency, it does not override capacity.
   */
  minimum: z.number().int().min(0).optional(),
  /** relative chance under any weighted method (default 1) */
  weight: z.number().min(0).optional(),
  /** a flat no: never allocate this option, whatever the respondent chose */
  eligible: z.boolean().default(true),
  /** and a conditional one, evaluated per respondent before allocation (§15) */
  eligibleWhen: Condition.optional(),
  /** per-option override of the survey-level rules */
  afterTarget: AfterTargetRule.optional(),
  afterMaximum: AfterMaximumRule.optional(),
  /** informational: shown in the grid and the dashboard */
  notes: z.string().optional(),
});
export type ListFillOption = z.infer<typeof ListFillOption>;

/* ------------------------------------------------------------ destinations */

/** What to do with a destination that got no item (§18). */
export const UnusedDestinationRule = z.enum([
  "hide",
  "skip",
  "disable",
  "blank",
  "do_not_instantiate",
  "terminate_block",
]);
export type UnusedDestinationRule = z.infer<typeof UnusedDestinationRule>;

/**
 * Where the result goes (§17). Position 1 of the result populates the first
 * destination, and so on; a destination beyond the number of items allocated
 * follows `whenUnused`.
 */
export const ListFillDestination = z.object({
  /** the question that receives this position's item */
  questionId: z.string(),
  /** 1-based position in the final list; absent = this entry's own index */
  position: z.number().int().min(1).optional(),
  /**
   * What the question receives: the code as its answer, or the item merely
   * bound for piping while the question stays unanswered.
   */
  write: z.enum(["answer", "piping_only"]).default("answer"),
  whenUnused: UnusedDestinationRule.optional(),
});
export type ListFillDestination = z.infer<typeof ListFillDestination>;

/* ------------------------------------------------------------ the object */

export const ListFillTracking = z.object({
  /**
   * Count against the whole sample (§9). With this off, caps and targets are
   * meaningless and the engine is a per-respondent selector only — useful for
   * randomised assignment where no sample balance is wanted.
   */
  sampleLevel: z.boolean().default(true),
  /** never allocate an option that would break a hard quota (§25) */
  respectQuotas: z.boolean().default(true),
  /** which quotas to consult; empty = all of them */
  quotaIds: z.array(z.string()).default([]),
  /**
   * Test and live counters are separate, exactly as response data is: a test
   * run must never fill a live cap. Off only for a deliberate dry run against
   * the live counters.
   */
  separateTestCounts: z.boolean().default(true),
  /**
   * Count this allocation only once the respondent finishes. Off by default:
   * a slot claimed at allocation time is what makes a cap truthful while
   * fieldwork runs, and abandoned sessions are released by the reconcile
   * job rather than by hoping.
   */
  countOnCompleteOnly: z.boolean().default(false),
  /** informational sample size, for percent targets and the dashboard */
  sampleSize: z.number().int().min(0).optional(),
});
export type ListFillTracking = z.infer<typeof ListFillTracking>;

export const ListFillSelection = z.object({
  count: ListFillCount.default({ kind: "fixed", n: 1 }),
  method: ListFillMethod.default("priority_quota"),
  equalPriority: EqualPriorityRule.default("random"),
  afterTarget: AfterTargetRule.default("continue"),
  afterMaximum: AfterMaximumRule.default("next_priority"),
  fallback: FallbackRule.default("random_eligible"),
  /** enable the weighted forms of the methods above */
  weighted: z.boolean().default(false),
  /** allow the same option twice in one respondent's list (rarely wanted) */
  allowDuplicates: z.boolean().default(false),
  /**
   * Fill up to `count` even when doing so means going outside the priority
   * order; off means "return fewer rather than reach".
   */
  fillToCount: z.boolean().default(true),
  /** a registered script implementing `method: "custom"` (§34) */
  scriptId: z.string().optional(),
});
export type ListFillSelection = z.infer<typeof ListFillSelection>;

export const ListFill = z.object({
  id: z.string(),
  /** used in variable names: LISTFILL_<name>_1 … (defaults to the id) */
  name: z.string().optional(),
  label: z.string().optional(),
  enabled: z.boolean().default(true),
  source: ListFillSource,
  selection: ListFillSelection.default({}),
  tracking: ListFillTracking.default({}),
  /** per-option settings, keyed by code; an option absent here is unlimited */
  options: z.array(ListFillOption).default([]),
  /** respondent-level gate: allocate nothing at all unless this holds */
  runWhen: Condition.optional(),
  destinations: z.array(ListFillDestination).default([]),
  /**
   * Repeat a flow block once per allocated item (§19). The flow's own `loop`
   * node does the repeating — this only names the block, so a List Fill can
   * drive it without the programmer wiring a loop by hand.
   */
  repeatBlockId: z.string().optional(),
  /** keep the full decision trace on the response (§32) */
  storeTrace: z.boolean().default(true),
  notes: z.string().optional(),
});
export type ListFill = z.infer<typeof ListFill>;

/* ------------------------------------------------------------ status */

/** Where an option stands against its own limits — the dashboard's language (§28). */
export const AllocationStatus = z.enum([
  "ACTIVE",
  "NEAR_CAP",         // ≥ 90% of the maximum
  "TARGET_REACHED",
  "FULL",
  "INELIGIBLE",
  "DISABLED",
]);
export type AllocationStatus = z.infer<typeof AllocationStatus>;

/** Why an option was rejected — the trace's vocabulary (§32). */
export const RejectionReason = z.enum([
  "not_a_candidate",
  "option_disabled",
  "ineligible",
  "eligibility_condition",
  "maximum_reached",
  "target_reached_and_stopped",
  "quota_full",
  "no_remaining_capacity",
  "already_selected",
  "count_satisfied",
  "not_reached_by_strategy",
]);
export type RejectionReason = z.infer<typeof RejectionReason>;
