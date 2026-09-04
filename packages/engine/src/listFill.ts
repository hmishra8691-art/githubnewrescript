import type {
  AfterMaximumRule, AfterTargetRule, AllocationStatus, EqualPriorityRule, FallbackRule,
  ListFill, ListFillMethod, ListFillOption, RejectionReason, SurveyDefinition,
} from "@rescript/schema";
import type { ResponseState } from "./state.js";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import { effectiveQuestion } from "./carryforward.js";
import { getQuestion } from "./state.js";
import { matchingCells, effectiveLimit } from "./quotas.js";
import type { QuotaCounts } from "./quotas.js";
import { mulberry32, subSeed } from "./random.js";

/**
 * THE LIST FILL ALLOCATION ENGINE.
 *
 * One deterministic, explainable pass turns a candidate list into the items
 * this respondent gets:
 *
 *   1  candidates        the source list (selected codes, a static list, a
 *                        calculation, embedded data, another List Fill)
 *   2  eligibility       option flag + per-option condition + `runWhen`
 *   3  capacity          current count vs target / maximum, sample-wide
 *   4  quota             would allocating this option break a hard quota?
 *   5  ordering          priority bands, then the equal-priority rule
 *   6  strategy          the selection method inside what is left
 *   7  fallback          when the priority order runs out
 *   8  result            the final list, its variables, and a trace of every
 *                        option's fate at every stage
 *
 * PURE. No I/O, no clock, no `Math.random`. Randomness comes from the
 * respondent's seed, so the builder, the simulator, preview, test and
 * production all reach the same answer for the same respondent and the same
 * counters (§38) — and a bug is reproducible from the trace alone.
 *
 * It returns a PREFERENCE ORDER, not a promise. Sample-level counts are
 * shared state: between deciding and storing, another respondent may take the
 * last slot. So the caller (`apps/runtime` → `rescript_allocate_listfill`)
 * claims slots atomically in this order and the database says what was
 * actually won (§27). The engine's job is to say what *should* happen and
 * why; the database's job is to make it true exactly once.
 */

/* ------------------------------------------------------------ counts */

/** listFillId → optionCode → how many of the sample already have it. */
export type ListFillCounts = Record<string, Record<string, number>>;

export const countOf = (counts: ListFillCounts, listFillId: string, code: string): number =>
  counts[listFillId]?.[code] ?? 0;

/* ------------------------------------------------------------ trace */

/** One option's fate, stage by stage — the language of §32's decision trace. */
export interface ListFillOptionTrace {
  code: string;
  label: string;
  candidate: boolean;
  priority: number | null;
  target: number | null;
  maximum: number | null;
  minimum: number | null;
  weight: number;
  current: number;
  /** null when the option has no maximum: unlimited, not zero */
  remaining: number | null;
  status: AllocationStatus;
  eligible: boolean;
  /** the quota cells that blocked it, if any */
  quotaBlockedBy: { quotaId: string; cellId: string }[];
  /** set when the option did not make the final list */
  rejectedBecause?: RejectionReason;
  /** 1-based position in the final list */
  position?: number;
  /** which stage put it there, in words */
  selectedBy?: string;
}

export interface ListFillTrace {
  listFillId: string;
  name: string;
  ran: boolean;
  /** why nothing was allocated, when that is the answer */
  skippedBecause?: "disabled" | "run_when_false" | "no_candidates" | "count_zero";
  requestedCount: number;
  allocatedCount: number;
  method: ListFillMethod;
  equalPriority: EqualPriorityRule;
  afterTarget: AfterTargetRule;
  afterMaximum: AfterMaximumRule;
  fallback: FallbackRule;
  /** the order the engine would like the slots claimed in */
  preference: string[];
  options: ListFillOptionTrace[];
  /** one line per decision, in the order they were made */
  steps: string[];
  /** a human sentence for the final outcome */
  reason: string;
}

export interface ListFillItem {
  code: string;
  label: string;
  position: number;
}

export interface ListFillResult {
  listFillId: string;
  name: string;
  items: ListFillItem[];
  /** the full preference order, so a caller can claim the next one on a race */
  preference: string[];
  trace: ListFillTrace;
}

/* ------------------------------------------------------------ helpers */

const nameOf = (lf: ListFill): string => lf.name ?? lf.id;

/** The option settings for a code, with the defaults an absent entry implies. */
function settingsFor(lf: ListFill, code: string): ListFillOption {
  const found = lf.options.find((o) => String(o.code) === String(code));
  return found ?? { code, eligible: true };
}

/**
 * Remaining capacity: `null` means unlimited, which is NOT the same as 0 and
 * is the distinction that makes an option with no cap usable as fallback.
 */
export function remainingCapacity(opt: ListFillOption, current: number): number | null {
  if (opt.maximum == null) return null;
  return Math.max(0, opt.maximum - current);
}

/** Where an option stands against its own limits (§28's statuses). */
export function allocationStatus(opt: ListFillOption, current: number, eligible: boolean): AllocationStatus {
  if (opt.eligible === false) return "DISABLED";
  if (!eligible) return "INELIGIBLE";
  if (opt.maximum != null && current >= opt.maximum) return "FULL";
  if (opt.maximum != null && opt.maximum > 0 && current >= opt.maximum * 0.9) return "NEAR_CAP";
  if (opt.target != null && current >= opt.target) return "TARGET_REACHED";
  return "ACTIVE";
}

/**
 * How badly an option still needs allocations, as a fraction of its target.
 * 1 means "nothing yet", 0 means "target met". Drives every `balanced` rule,
 * and lifts an option that has not met its MINIMUM above everything else —
 * a minimum is urgency, not a cap (§6).
 */
function urgency(opt: ListFillOption, current: number): number {
  if (opt.minimum != null && current < opt.minimum) return 2 + (opt.minimum - current) / Math.max(1, opt.minimum);
  const target = opt.target ?? opt.maximum;
  if (target == null || target <= 0) return 0.5;
  return Math.max(0, (target - current) / target);
}

/** Priority bands, lowest number first; options without a priority go last. */
function priorityOf(opt: ListFillOption): number {
  return opt.priority == null ? Number.MAX_SAFE_INTEGER : opt.priority;
}

/** A weighted draw from `items`; deterministic for a given rng. */
function weightedPick<T>(items: T[], weightOf: (t: T) => number, rng: () => number): T | undefined {
  const weights = items.map((i) => Math.max(0, weightOf(i)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/* ------------------------------------------------------------ candidates */

/**
 * The candidate list, before anything is judged.
 *
 * A source question contributes what the respondent SELECTED by default, and
 * it does not matter in the slightest whether that question was visible: a
 * hidden question populated by a URL parameter, a calculation or a script
 * feeds List Fill exactly like one the respondent answered (§21, §22).
 */
export function listFillCandidates(
  def: SurveyDefinition,
  lf: ListFill,
  state: ResponseState,
  ctx?: EvalContext,
): { code: string; label: string }[] {
  const src = lf.source;
  const labelFor = (questionId: string, code: string): string => {
    const q = getQuestion(def, questionId);
    const opt = q?.options.find((o) => String(o.code) === String(code));
    return opt?.label ?? String(code);
  };
  const asList = (v: unknown): string[] => {
    if (v == null || v === "") return [];
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "object") return Object.keys(v as Record<string, unknown>);
    // a delimited string, which is how imported and URL-supplied lists arrive
    return String(v).split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
  };

  switch (src.kind) {
    case "question": {
      const q = getQuestion(def, src.questionId);
      if (!q) return [];
      if (src.take === "all") {
        return q.options.map((o) => ({ code: String(o.code), label: o.label }));
      }
      if (src.take === "displayed") {
        const view = effectiveQuestion(q, ctx ?? { def, state });
        return view.options.map((o) => ({ code: String(o.code), label: o.label }));
      }
      return asList(state.answers[src.questionId]).map((c) => ({ code: c, label: labelFor(src.questionId, c) }));
    }
    case "static":
      return src.items.map((i) => ({ code: String(i.code), label: i.label }));
    case "calculation":
      return asList(state.calculated[src.ref]).map((c) => ({ code: c, label: c }));
    case "embedded":
      return asList(state.embedded[src.ref]).map((c) => ({ code: c, label: c }));
    case "listFill": {
      const other = def.listFills.find((x) => x.id === src.listFillId);
      const key = other ? `LISTFILL_${(other.name ?? other.id).toUpperCase()}` : null;
      if (!key) return [];
      const n = Number(state.calculated[`${key}_COUNT`] ?? 0);
      const out: { code: string; label: string }[] = [];
      for (let i = 1; i <= n; i++) {
        const code = state.calculated[`${key}_${i}_CODE`];
        if (code == null || code === "") continue;
        out.push({ code: String(code), label: String(state.calculated[`${key}_${i}`] ?? code) });
      }
      return out;
    }
    case "script": {
      // the script writes its list into a calculated variable of the same name;
      // scripts run in the runtime's sandbox, never here
      return asList(state.calculated[src.scriptId]).map((c) => ({ code: c, label: c }));
    }
    default:
      return [];
  }
}

/** How many items this respondent should get (§4). */
export function resolveListFillCount(
  def: SurveyDefinition,
  lf: ListFill,
  state: ResponseState,
  candidateCount: number,
): number {
  const c = lf.selection.count;
  switch (c.kind) {
    case "all": return candidateCount;
    case "fixed": return Math.max(0, c.n);
    case "question": {
      const v = state.answers[c.questionId];
      const n = Array.isArray(v) ? v.length : Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    }
    case "calculation": {
      const n = Number(state.calculated[c.ref]);
      return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    }
    case "expression": {
      // the calc engine evaluates expressions; a List Fill count expression is
      // stored as a calculation and read from there, so nothing is evaluated
      // twice with two different parsers
      const n = Number(state.calculated[c.expression]);
      return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    }
    default: return 0;
  }
}

/* ------------------------------------------------------------ quota */

/**
 * Would allocating `code` put this respondent in a FULL hard quota cell?
 *
 * The candidate is provisionally bound as the List Fill result and the
 * survey's OWN quota code is asked. That is what makes §26 multi-dimensional
 * for free: a cell may say "Apple AND male AND 25–34 AND North" and it is
 * evaluated as one ordinary condition, because gender, age and region are
 * already in the state and the candidate has just been put beside them.
 * Nothing about the quota structure is hardcoded here.
 */
function quotaBlocks(
  def: SurveyDefinition,
  lf: ListFill,
  state: ResponseState,
  code: string,
  position: number,
  quotaCounts: QuotaCounts,
): { quotaId: string; cellId: string }[] {
  if (!lf.tracking.respectQuotas) return [];
  const quotas = def.quotas.filter((q) => q.mode === "hard" && (!lf.tracking.quotaIds.length || lf.tracking.quotaIds.includes(q.id)));
  if (!quotas.length) return [];
  const provisional: ResponseState = {
    ...state,
    calculated: { ...state.calculated, ...provisionalVars(lf, code, position) },
  };
  const blocked: { quotaId: string; cellId: string }[] = [];
  for (const quota of quotas) {
    for (const cellId of matchingCells(def, provisional, quota)) {
      const cell = quota.cells.find((c) => c.id === cellId);
      if (!cell) continue;
      const limit = effectiveLimit(quota, cell.limit, cell.limitType);
      const count = quotaCounts[quota.id]?.[cellId] ?? 0;
      if (limit > 0 && count >= limit) blocked.push({ quotaId: quota.id, cellId });
    }
  }
  return blocked;
}

/** The variables a candidate would set, used for the provisional quota check. */
function provisionalVars(lf: ListFill, code: string, position: number): Record<string, string | number> {
  const key = `LISTFILL_${nameOf(lf).toUpperCase()}`;
  return { [`${key}_${position}`]: code, [`${key}_${position}_CODE`]: code, [`${key}_CANDIDATE`]: code };
}

/* ------------------------------------------------------------ the engine */

export interface ListFillInput {
  def: SurveyDefinition;
  listFill: ListFill;
  state: ResponseState;
  /** sample-level counts per option; empty when tracking is off */
  counts?: ListFillCounts;
  quotaCounts?: QuotaCounts;
  /** overrides the respondent's seed — the simulator varies it per draw */
  seed?: number;
}

/**
 * Decide this respondent's list. See the file header for the stages; the
 * returned trace records what happened at each one, for every option.
 */
export function decideListFill(input: ListFillInput): ListFillResult {
  const { def, listFill: lf, state } = input;
  const counts = input.counts ?? {};
  const quotaCounts = input.quotaCounts ?? {};
  const sel = lf.selection;
  const rng = mulberry32(subSeed(input.seed ?? state.seed ?? 0, `listfill:${lf.id}`));
  const steps: string[] = [];
  const ctx: EvalContext = { def, state };

  const base = (): ListFillTrace => ({
    listFillId: lf.id, name: nameOf(lf), ran: false,
    requestedCount: 0, allocatedCount: 0,
    method: sel.method, equalPriority: sel.equalPriority,
    afterTarget: sel.afterTarget, afterMaximum: sel.afterMaximum, fallback: sel.fallback,
    preference: [], options: [], steps, reason: "",
  });

  if (!lf.enabled) {
    const t = base();
    t.skippedBecause = "disabled";
    t.reason = "This List Fill is switched off.";
    return { listFillId: lf.id, name: nameOf(lf), items: [], preference: [], trace: t };
  }
  if (lf.runWhen && !evaluateCondition(lf.runWhen, ctx)) {
    const t = base();
    t.skippedBecause = "run_when_false";
    t.reason = "The condition on this List Fill is not met for this respondent, so nothing was allocated.";
    return { listFillId: lf.id, name: nameOf(lf), items: [], preference: [], trace: t };
  }

  /* -- 1. candidates ---------------------------------------------------- */
  const candidates = listFillCandidates(def, lf, state, ctx);
  const seen = new Set<string>();
  const pool = candidates.filter((c) => (seen.has(c.code) ? false : (seen.add(c.code), true)));
  steps.push(`Candidates from ${describeSource(lf)}: ${pool.length ? pool.map((c) => c.code).join(", ") : "none"}.`);

  const requested = resolveListFillCount(def, lf, state, pool.length);
  steps.push(`Count required: ${describeCount(lf)} → ${requested}.`);

  /* -- 2-4. judge every candidate --------------------------------------- */
  const traces: ListFillOptionTrace[] = [];
  for (const c of pool) {
    const opt = settingsFor(lf, c.code);
    const current = lf.tracking.sampleLevel ? countOf(counts, lf.id, c.code) : 0;
    const remaining = remainingCapacity(opt, current);
    let eligible = opt.eligible !== false;
    let rejected: RejectionReason | undefined;
    if (!eligible) rejected = "option_disabled";
    if (eligible && opt.eligibleWhen && !evaluateCondition(opt.eligibleWhen, ctx)) {
      eligible = false;
      rejected = "eligibility_condition";
    }
    const quotaBlockedBy = eligible ? quotaBlocks(def, lf, state, c.code, 1, quotaCounts) : [];
    if (eligible && quotaBlockedBy.length) rejected = "quota_full";
    if (eligible && !rejected && remaining !== null && remaining <= 0) rejected = "maximum_reached";
    const afterTarget = opt.afterTarget ?? sel.afterTarget;
    if (eligible && !rejected && afterTarget === "stop" && opt.target != null && current >= opt.target) {
      rejected = "target_reached_and_stopped";
    }
    traces.push({
      code: c.code,
      label: opt.label ?? c.label,
      candidate: true,
      priority: opt.priority ?? null,
      target: opt.target ?? null,
      maximum: opt.maximum ?? null,
      minimum: opt.minimum ?? null,
      weight: opt.weight ?? 1,
      current,
      remaining,
      status: allocationStatus(opt, current, eligible && !quotaBlockedBy.length),
      eligible: eligible && !rejected,
      quotaBlockedBy,
      rejectedBecause: rejected,
    });
  }
  // options configured but not offered to this respondent, so the grid and the
  // trace show the whole picture rather than only what was chosen
  for (const opt of lf.options) {
    if (traces.some((t) => t.code === String(opt.code))) continue;
    const current = lf.tracking.sampleLevel ? countOf(counts, lf.id, String(opt.code)) : 0;
    traces.push({
      code: String(opt.code), label: opt.label ?? String(opt.code), candidate: false,
      priority: opt.priority ?? null, target: opt.target ?? null, maximum: opt.maximum ?? null,
      minimum: opt.minimum ?? null, weight: opt.weight ?? 1, current,
      remaining: remainingCapacity(opt, current),
      status: allocationStatus(opt, current, true), eligible: false,
      quotaBlockedBy: [], rejectedBecause: "not_a_candidate",
    });
  }

  const usable = traces.filter((t) => t.candidate && t.eligible);
  for (const t of traces) {
    if (t.candidate && !t.eligible) steps.push(`${t.code}: rejected — ${explainRejection(t)}.`);
  }
  steps.push(`Eligible with capacity: ${usable.length ? usable.map((t) => t.code).join(", ") : "none"}.`);

  if (!pool.length || requested <= 0 || !usable.length) {
    const t = base();
    t.ran = true;
    t.requestedCount = requested;
    t.options = traces;
    t.skippedBecause = !pool.length ? "no_candidates" : requested <= 0 ? "count_zero" : undefined;
    t.reason = !pool.length
      ? "The source produced no candidates."
      : requested <= 0
        ? "The required count is zero."
        : "Every candidate was rejected — no eligible option has remaining capacity.";
    steps.push(t.reason);
    return { listFillId: lf.id, name: nameOf(lf), items: [], preference: [], trace: t };
  }

  /* -- 5-7. order, select, fall back ------------------------------------ */
  const order = orderCandidates(usable, lf, sel.method, rng, steps);
  const items: ListFillItem[] = [];
  const preference: string[] = order.map((t) => t.code);
  const takenCapacity: Record<string, number> = {};

  for (const t of order) {
    if (items.length >= requested) {
      if (!t.rejectedBecause) t.rejectedBecause = "count_satisfied";
      continue;
    }
    if (!sel.allowDuplicates && items.some((i) => i.code === t.code)) {
      t.rejectedBecause = "already_selected";
      continue;
    }
    // capacity again, now accounting for what THIS respondent already took
    const used = takenCapacity[t.code] ?? 0;
    if (t.remaining !== null && t.remaining - used <= 0) {
      t.rejectedBecause = "no_remaining_capacity";
      steps.push(`${t.code}: no capacity left after this respondent's earlier items.`);
      continue;
    }
    const position = items.length + 1;
    // the quota check is position-sensitive, so ask again for this position
    const blocked = quotaBlocks(def, lf, state, t.code, position, quotaCounts);
    if (blocked.length) {
      t.quotaBlockedBy = blocked;
      t.rejectedBecause = "quota_full";
      t.status = "FULL";
      steps.push(`${t.code}: rejected at position ${position} — quota ${blocked.map((b) => `${b.quotaId}/${b.cellId}`).join(", ")} is full.`);
      continue;
    }
    items.push({ code: t.code, label: t.label, position });
    takenCapacity[t.code] = used + 1;
    t.position = position;
    t.selectedBy = t.selectedBy ?? "priority order";
    steps.push(`${t.code}: SELECTED at position ${position} (priority ${t.priority ?? "—"}, ${t.remaining === null ? "unlimited" : `${t.remaining - used} left`}).`);
  }

  // still short: the fallback pool, when one is configured
  if (items.length < requested && sel.fillToCount && sel.fallback !== "none") {
    const rest = usable.filter((t) => !items.some((i) => i.code === t.code) && (t.remaining === null || (t.remaining - (takenCapacity[t.code] ?? 0)) > 0));
    if (rest.length) {
      steps.push(`Short of ${requested} — fallback (${sel.fallback}) over ${rest.map((t) => t.code).join(", ")}.`);
      const fb = fallbackOrder(rest, sel.fallback, lf, rng);
      for (const t of fb) {
        if (items.length >= requested) break;
        if (!sel.allowDuplicates && items.some((i) => i.code === t.code)) continue;
        const position = items.length + 1;
        const blocked = quotaBlocks(def, lf, state, t.code, position, quotaCounts);
        if (blocked.length) { t.quotaBlockedBy = blocked; t.rejectedBecause = "quota_full"; continue; }
        items.push({ code: t.code, label: t.label, position });
        t.position = position;
        t.rejectedBecause = undefined;
        t.selectedBy = `fallback (${sel.fallback})`;
        if (!preference.includes(t.code)) preference.push(t.code);
        steps.push(`${t.code}: SELECTED at position ${position} by fallback.`);
      }
    }
  }

  for (const t of order) {
    if (t.position == null && !t.rejectedBecause) t.rejectedBecause = "not_reached_by_strategy";
  }

  const trace: ListFillTrace = {
    ...base(),
    ran: true,
    requestedCount: requested,
    allocatedCount: items.length,
    preference,
    options: traces,
    reason: items.length === 0
      ? "No option could be allocated."
      : items.length < requested
        ? `Allocated ${items.length} of ${requested} — nothing eligible was left for the remaining ${requested - items.length}.`
        : `Allocated ${items.length}: ${items.map((i) => i.code).join(", ")}. ${describeWhy(traces, items)}`,
  };
  steps.push(trace.reason);

  return { listFillId: lf.id, name: nameOf(lf), items, preference, trace };
}

/* ------------------------------------------------------------ ordering */

/**
 * Put the usable candidates in the order the engine wants to try them.
 *
 * Priority is a BAND, not a tiebreak: every `priority*` method sorts by
 * priority number first and then separates equals with the equal-priority
 * rule (§12), which is what makes §10's "prefer A until it is full, then B,
 * then C, then random D/E" fall out of configuration rather than code.
 */
function orderCandidates(
  usable: ListFillOptionTrace[],
  lf: ListFill,
  method: ListFillMethod,
  rng: () => number,
  steps: string[],
): ListFillOptionTrace[] {
  const sel = lf.selection;
  const opt = (t: ListFillOptionTrace) => settingsFor(lf, t.code);
  const byUrgency = (a: ListFillOptionTrace, b: ListFillOptionTrace) => urgency(opt(b), b.current) - urgency(opt(a), a.current);
  const shuffled = (list: ListFillOptionTrace[]) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const weightedOrder = (list: ListFillOptionTrace[]) => {
    const remaining = [...list];
    const out: ListFillOptionTrace[] = [];
    while (remaining.length) {
      const pick = weightedPick(remaining, (t) => t.weight, rng)!;
      out.push(pick);
      remaining.splice(remaining.indexOf(pick), 1);
    }
    return out;
  };
  const capacityOrder = (list: ListFillOptionTrace[]) =>
    weightedOrder(list).sort((a, b) => {
      const ra = a.remaining === null ? Number.MAX_SAFE_INTEGER : a.remaining;
      const rb = b.remaining === null ? Number.MAX_SAFE_INTEGER : b.remaining;
      return rb - ra;
    });

  /** separate options that share a priority number */
  const withinBand = (band: ListFillOptionTrace[]): ListFillOptionTrace[] => {
    if (band.length < 2) return band;
    switch (sel.equalPriority) {
      case "sequential": return band;
      case "balanced": return [...band].sort(byUrgency);
      case "weighted": return weightedOrder(band);
      case "quota_aware_random": return capacityOrder(band);
      case "random":
      default: return shuffled(band);
    }
  };

  /** priority bands, each internally separated, in ascending priority */
  const byPriorityBands = (list: ListFillOptionTrace[], descending = false): ListFillOptionTrace[] => {
    const bands = new Map<number, ListFillOptionTrace[]>();
    for (const t of list) {
      const p = priorityOf(opt(t));
      (bands.get(p) ?? bands.set(p, []).get(p)!).push(t);
    }
    const keys = [...bands.keys()].sort((a, b) => (descending ? b - a : a - b));
    const out: ListFillOptionTrace[] = [];
    for (const k of keys) {
      const band = withinBand(bands.get(k)!);
      if (band.length > 1) steps.push(`Priority ${k === Number.MAX_SAFE_INTEGER ? "—" : k}: ${band.map((t) => t.code).join(" > ")} (${sel.equalPriority}).`);
      out.push(...band);
    }
    return out;
  };

  /**
   * After-target demotion: an option that has met its target steps behind
   * everything still under target, without leaving the list (§8). Applied
   * after ordering so it can never promote anything.
   */
  const demoteSatisfied = (list: ListFillOptionTrace[]): ListFillOptionTrace[] => {
    const rule = (t: ListFillOptionTrace) => opt(t).afterTarget ?? sel.afterTarget;
    const met = (t: ListFillOptionTrace) => t.target != null && t.current >= t.target;
    const demoted = list.filter((t) => met(t) && (rule(t) === "reduce_priority" || rule(t) === "random_pool" || rule(t) === "next_priority"));
    if (!demoted.length) return list;
    const kept = list.filter((t) => !demoted.includes(t));
    for (const t of demoted) {
      steps.push(`${t.code}: target ${t.target} reached (${t.current}) → ${rule(t)}, so it yields to options still under target.`);
    }
    const tail = demoted.some((t) => rule(t) === "random_pool") ? shuffled(demoted) : demoted;
    return [...kept, ...tail];
  };

  let ordered: ListFillOptionTrace[];
  switch (method) {
    case "first_selected":
    case "selection_order":
      ordered = usable; // already in the respondent's own order
      break;
    case "highest_priority":
      ordered = byPriorityBands(usable);
      break;
    case "lowest_priority":
      ordered = byPriorityBands(usable, true);
      break;
    case "random":
      ordered = shuffled(usable);
      break;
    case "weighted_random":
      ordered = weightedOrder(usable);
      break;
    case "balanced_random":
      ordered = shuffled(usable).sort(byUrgency);
      break;
    case "quota_aware_random":
      ordered = capacityOrder(usable);
      break;
    case "custom":
      // a custom script supplies the order via the runtime; without it the
      // engine falls back to its most conservative documented behaviour
      // rather than inventing one
      steps.push("Method is `custom` and no script order was supplied — using priority + quota.");
      ordered = byPriorityBands(usable);
      break;
    case "priority_random":
    case "priority_quota":
    default:
      ordered = byPriorityBands(usable);
      break;
  }
  steps.push(`Order (${method}): ${ordered.map((t) => t.code).join(" > ")}.`);
  const final = demoteSatisfied(ordered);
  if (final.map((t) => t.code).join() !== ordered.map((t) => t.code).join()) {
    steps.push(`After target demotion: ${final.map((t) => t.code).join(" > ")}.`);
  }
  return final;
}

function fallbackOrder(
  rest: ListFillOptionTrace[],
  rule: FallbackRule,
  lf: ListFill,
  rng: () => number,
): ListFillOptionTrace[] {
  const opt = (t: ListFillOptionTrace) => settingsFor(lf, t.code);
  switch (rule) {
    case "weighted_eligible": {
      const remaining = [...rest];
      const out: ListFillOptionTrace[] = [];
      while (remaining.length) {
        const pick = weightedPick(remaining, (t) => t.weight, rng)!;
        out.push(pick);
        remaining.splice(remaining.indexOf(pick), 1);
      }
      return out;
    }
    case "balanced_eligible":
      return [...rest].sort((a, b) => urgency(opt(b), b.current) - urgency(opt(a), a.current));
    case "next_priority":
      return [...rest].sort((a, b) => priorityOf(opt(a)) - priorityOf(opt(b)));
    case "random_eligible":
    default: {
      const out = [...rest];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }
  }
}

/* ------------------------------------------------------------ the allocator handoff */

/**
 * The preference order as `rescript_allocate_listfill` wants it:
 * `[{code, maximum}, …]`, most-preferred first.
 *
 * Only the CAP travels, never the decision. The database's job is to refuse a
 * claim once an option is at its maximum; every other rule — eligibility,
 * conditions, priority bands, targets, quotas, the strategy — was already
 * applied by the engine in producing this order. Keeping the split that sharp
 * is what stops a second, divergent copy of the rules growing in SQL.
 */
export function allocationPayload(lf: ListFill, result: ListFillResult): { code: string; maximum?: number }[] {
  return result.preference.map((code) => {
    const opt = settingsFor(lf, code);
    return opt.maximum == null ? { code } : { code, maximum: opt.maximum };
  });
}

/** Is sample-level tracking on, i.e. does this list need the atomic allocator at all? */
export function needsAllocation(lf: ListFill): boolean {
  return lf.enabled && lf.tracking.sampleLevel;
}

/**
 * Reconcile the engine's decision with what the database actually granted.
 *
 * The confirmed codes are the truth: under load a respondent can lose the
 * last slot of their preferred option between the decision and the claim, and
 * the allocator will have given them the next one down. This rewrites the
 * items, positions and trace to describe WHAT HAPPENED rather than what was
 * hoped for, so the stored variables, the destinations and the trace a
 * researcher reads all agree with the counters.
 */
export function confirmListFill(lf: ListFill, decided: ListFillResult, confirmed: string[]): ListFillResult {
  const traces = decided.trace.options.map((t) => ({ ...t, position: undefined as number | undefined }));
  const items: ListFillItem[] = confirmed.map((code, i) => {
    const t = traces.find((x) => x.code === code);
    if (t) { t.position = i + 1; t.rejectedBecause = undefined; }
    return { code, label: t?.label ?? code, position: i + 1 };
  });
  const lost = decided.items.filter((i) => !confirmed.includes(i.code));
  for (const l of lost) {
    const t = traces.find((x) => x.code === l.code);
    if (t && t.position == null) {
      t.rejectedBecause = "no_remaining_capacity";
      t.status = "FULL";
    }
  }
  const steps = [...decided.trace.steps];
  if (lost.length) {
    steps.push(
      `Lost to another respondent between deciding and claiming: ${lost.map((l) => l.code).join(", ")} — `
      + `the allocator granted ${confirmed.length ? confirmed.join(", ") : "nothing"} instead.`,
    );
  }
  return {
    ...decided,
    items,
    trace: {
      ...decided.trace,
      options: traces,
      allocatedCount: items.length,
      steps,
      reason: items.length === 0
        ? "Nothing could be allocated — every option in the preference order was full when the claim was made."
        : lost.length
          ? `Allocated ${items.map((i) => i.code).join(", ")} after ${lost.map((l) => l.code).join(", ")} filled up between deciding and claiming.`
          : decided.trace.reason,
    },
  };
}

/* ------------------------------------------------------------ variables */

/**
 * The variables one List Fill contributes (§23). Written into
 * `state.calculated`, which is what makes them work in display logic, skip
 * logic, branches, validation, piping, calculations, quotas and scripts
 * without any of those learning about List Fill (§24).
 */
export function listFillVariables(lf: ListFill, result: ListFillResult): Record<string, string | number | boolean | null> {
  const key = `LISTFILL_${nameOf(lf).toUpperCase()}`;
  const out: Record<string, string | number | boolean | null> = {
    [`${key}_COUNT`]: result.items.length,
  };
  result.items.forEach((item, i) => {
    const n = i + 1;
    out[`${key}_${n}`] = item.label;
    out[`${key}_${n}_CODE`] = item.code;
    out[`${key}_${n}_POSITION`] = n;
  });
  // a compact, exportable summary of the whole list
  out[`${key}_CODES`] = result.items.map((i) => i.code).join(",");
  out[`${key}_LABELS`] = result.items.map((i) => i.label).join(", ");
  return out;
}

/** The variable NAMES a List Fill will produce, for the dictionary and exports. */
export function listFillVariableNames(lf: ListFill): { name: string; kind: "count" | "label" | "code" | "position" | "summary"; position?: number }[] {
  const key = `LISTFILL_${nameOf(lf).toUpperCase()}`;
  const max = maxItems(lf);
  const out: { name: string; kind: "count" | "label" | "code" | "position" | "summary"; position?: number }[] = [
    { name: `${key}_COUNT`, kind: "count" },
  ];
  for (let n = 1; n <= max; n++) {
    out.push({ name: `${key}_${n}`, kind: "label", position: n });
    out.push({ name: `${key}_${n}_CODE`, kind: "code", position: n });
    out.push({ name: `${key}_${n}_POSITION`, kind: "position", position: n });
  }
  out.push({ name: `${key}_CODES`, kind: "summary" });
  out.push({ name: `${key}_LABELS`, kind: "summary" });
  return out;
}

/**
 * The most items this List Fill can ever produce — the number of variable
 * columns the dictionary and the exports need. A dynamic count is bounded by
 * the option list, and by the destinations when those are the only outlet.
 */
export function maxItems(lf: ListFill): number {
  const c = lf.selection.count;
  const configured = lf.options.length || lf.destinations.length || 1;
  if (c.kind === "fixed") return Math.max(1, Math.min(c.n, Math.max(configured, c.n)));
  return Math.max(1, configured);
}

/* ------------------------------------------------------------ destinations */

/**
 * Write an allocation into its destination questions (§16–§18).
 *
 * A destination with `write: "answer"` receives the code as its answer, so
 * everything downstream — display logic, piping, validation, exports — sees
 * an ordinary answer and needs to know nothing about List Fill. A
 * `piping_only` destination is left untouched: the item reaches it through
 * `{{LISTFILL_…}}` in its text.
 *
 * Positions map in order unless a destination pins one, which is how "the
 * second allocated brand goes in Q7" is expressed without reordering the
 * list.
 */
export function applyListFillDestinations(lf: ListFill, result: ListFillResult, state: ResponseState): string[] {
  const written: string[] = [];
  let next = 0;
  for (const dest of lf.destinations) {
    const item = dest.position != null
      ? result.items.find((i) => i.position === dest.position)
      : result.items[next];
    if (dest.position == null && item) next++;
    if (!item) {
      // an unused destination: `blank` clears any earlier value so a
      // re-decided allocation cannot leave a stale answer behind
      if (dest.whenUnused === "blank") delete state.answers[dest.questionId];
      continue;
    }
    if (dest.write === "answer") {
      state.answers[dest.questionId] = item.code as never;
      written.push(dest.questionId);
    }
  }
  return written;
}

/**
 * The destinations an allocation did NOT fill, with what to do about each.
 *
 * Computed from the stored variables rather than a fresh decision, so it
 * agrees with what the respondent actually got and stays stable when the flow
 * is recompiled. `visibleQuestions` consults this to hide the ones configured
 * to disappear; a renderer reads it for `disable`.
 */
export function unusedListFillDestinations(
  def: SurveyDefinition,
  state: ResponseState,
): Map<string, "hide" | "skip" | "disable" | "blank" | "do_not_instantiate" | "terminate_block"> {
  const out = new Map<string, "hide" | "skip" | "disable" | "blank" | "do_not_instantiate" | "terminate_block">();
  for (const lf of def.listFills) {
    if (!lf.enabled) continue;
    const key = `LISTFILL_${nameOf(lf).toUpperCase()}_COUNT`;
    // not allocated yet: nothing is "unused", it simply has not run
    if (state.calculated[key] == null) continue;
    const n = Number(state.calculated[key] ?? 0);
    let next = 0;
    for (const dest of lf.destinations) {
      const filled = dest.position != null ? dest.position <= n : next < n;
      if (dest.position == null && filled) next++;
      if (!filled && dest.whenUnused) out.set(dest.questionId, dest.whenUnused);
    }
  }
  return out;
}

/** Destination questions an unused rule removes from the page entirely. */
export function listFillHiddenDestinations(def: SurveyDefinition, state: ResponseState): Set<string> {
  const hidden = new Set<string>();
  for (const [questionId, rule] of unusedListFillDestinations(def, state)) {
    if (rule === "hide" || rule === "skip" || rule === "do_not_instantiate") hidden.add(questionId);
  }
  return hidden;
}

/* ------------------------------------------------------------ readiness */

/**
 * The List Fills that should run now: enabled, their condition met, their
 * source has something to offer, and they have not already allocated for this
 * respondent.
 *
 * "Already allocated" is decided by the presence of the count variable, so a
 * resumed session, a page revisit or a recompiled flow never re-runs an
 * allocation — the atomic allocator would refuse to double-claim anyway, but
 * not asking is better than being refused.
 */
export function pendingListFills(def: SurveyDefinition, state: ResponseState): ListFill[] {
  const ctx: EvalContext = { def, state };
  return def.listFills.filter((lf) => {
    if (!lf.enabled) return false;
    if (state.calculated[`LISTFILL_${nameOf(lf).toUpperCase()}_COUNT`] != null) return false;
    if (lf.runWhen && !evaluateCondition(lf.runWhen, ctx)) return false;
    return listFillCandidates(def, lf, state, ctx).length > 0;
  });
}

/* ------------------------------------------------------------ words */

function describeSource(lf: ListFill): string {
  const s = lf.source;
  switch (s.kind) {
    case "question": return `${s.questionId} (${s.take})`;
    case "static": return `a static list of ${s.items.length}`;
    case "calculation": return `calculation ${s.ref}`;
    case "embedded": return `embedded field ${s.ref}`;
    case "listFill": return `List Fill ${s.listFillId}`;
    case "script": return `script ${s.scriptId}`;
    default: return "an unknown source";
  }
}

function describeCount(lf: ListFill): string {
  const c = lf.selection.count;
  switch (c.kind) {
    case "fixed": return String(c.n);
    case "all": return "all eligible";
    case "question": return `from ${c.questionId}`;
    case "calculation": return `from ${c.ref}`;
    case "expression": return `from \`${c.expression}\``;
    default: return "?";
  }
}

export function explainRejection(t: ListFillOptionTrace): string {
  switch (t.rejectedBecause) {
    case "not_a_candidate": return "not offered to this respondent";
    case "option_disabled": return "the option is switched off for List Fill";
    case "ineligible":
    case "eligibility_condition": return "its eligibility condition is not met";
    case "maximum_reached": return `its maximum of ${t.maximum} is reached (${t.current} allocated)`;
    case "target_reached_and_stopped": return `its target of ${t.target} is reached and the rule is Stop`;
    case "quota_full": return `quota ${t.quotaBlockedBy.map((q) => `${q.quotaId}/${q.cellId}`).join(", ")} is full`;
    case "no_remaining_capacity": return "no capacity left";
    case "already_selected": return "already in this respondent's list";
    case "count_satisfied": return "the required count was already met";
    case "not_reached_by_strategy": return "the strategy did not reach it";
    default: return "eligible";
  }
}

/**
 * Why the winner won, in one sentence.
 *
 * It reads EVERY candidate, not only the ones that survived to the ordering
 * stage: an option knocked out earlier for being full, ineligible or
 * quota-blocked is exactly the one a researcher is asking about when they
 * wonder why this respondent did not get it.
 */
function describeWhy(traces: ListFillOptionTrace[], items: ListFillItem[]): string {
  const winner = traces.find((t) => t.code === items[0]?.code);
  if (!winner) return "";
  const winnerPriority = winner.priority ?? Number.MAX_SAFE_INTEGER;
  const passedOver = traces.filter((t) =>
    t.candidate
    && t.code !== winner.code
    && t.rejectedBecause
    && t.rejectedBecause !== "count_satisfied"
    && t.rejectedBecause !== "not_reached_by_strategy"
    && (t.priority ?? Number.MAX_SAFE_INTEGER) <= winnerPriority);
  if (!passedOver.length) return "Highest-priority eligible option with remaining capacity.";
  return `${passedOver.map((t) => `${t.code} (${explainRejection(t)})`).join(", ")} came first but could not be used.`;
}

/* ------------------------------------------------------------ dashboard */

/** One row of the live allocation dashboard (§28) / the option grid (§30). */
export interface ListFillStatusRow {
  code: string;
  label: string;
  priority: number | null;
  target: number | null;
  maximum: number | null;
  minimum: number | null;
  weight: number;
  current: number;
  remaining: number | null;
  status: AllocationStatus;
  strategy: string;
  /** percent of the maximum used, when there is one */
  fill: number | null;
}

export function listFillStatus(lf: ListFill, counts: ListFillCounts): { listFillId: string; name: string; total: number; rows: ListFillStatusRow[] } {
  const rows = lf.options.map((opt) => {
    const current = countOf(counts, lf.id, String(opt.code));
    const remaining = remainingCapacity(opt, current);
    return {
      code: String(opt.code),
      label: opt.label ?? String(opt.code),
      priority: opt.priority ?? null,
      target: opt.target ?? null,
      maximum: opt.maximum ?? null,
      minimum: opt.minimum ?? null,
      weight: opt.weight ?? 1,
      current,
      remaining,
      status: allocationStatus(opt, current, opt.eligible !== false),
      strategy: opt.priority == null ? String(lf.selection.fallback) : "priority",
      fill: opt.maximum != null && opt.maximum > 0 ? Math.round((current / opt.maximum) * 100) : null,
    };
  });
  // options that have counts but are no longer configured still show, so a
  // renamed or removed option cannot hide allocations already made
  for (const [code, current] of Object.entries(counts[lf.id] ?? {})) {
    if (rows.some((r) => r.code === code)) continue;
    rows.push({
      code, label: code, priority: null, target: null, maximum: null, minimum: null, weight: 1,
      current, remaining: null, status: "DISABLED", strategy: "no longer configured", fill: null,
    });
  }
  rows.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) || a.code.localeCompare(b.code));
  return {
    listFillId: lf.id,
    name: nameOf(lf),
    total: rows.reduce((n, r) => n + r.current, 0),
    rows,
  };
}

/* ------------------------------------------------------------ simulation */

export interface SimulationResult {
  draws: number;
  /** counts after the run, per option */
  counts: Record<string, number>;
  /** how many draws allocated nothing at all */
  empty: number;
  /** each draw's chosen codes, in order */
  picks: string[][];
  /** the trace of the first draw and of the last, for inspection */
  firstTrace: ListFillTrace;
  lastTrace: ListFillTrace;
}

/**
 * Run the engine N times against its own evolving counters (§31).
 *
 * The same pure function the runtime uses, so a simulation is a prediction
 * rather than a model of one: the only thing missing is other respondents
 * competing for slots, which is exactly what the atomic allocator handles.
 */
export function simulateListFill(input: ListFillInput & { draws: number }): SimulationResult {
  const { def, listFill: lf, state } = input;
  const counts: ListFillCounts = { [lf.id]: { ...(input.counts?.[lf.id] ?? {}) } };
  const picks: string[][] = [];
  let empty = 0;
  let firstTrace: ListFillTrace | null = null;
  let lastTrace: ListFillTrace | null = null;
  const draws = Math.max(1, Math.min(input.draws, 10000));
  for (let i = 0; i < draws; i++) {
    const res = decideListFill({
      def, listFill: lf, state, counts,
      quotaCounts: input.quotaCounts,
      // a different draw for each simulated respondent
      seed: subSeed(input.seed ?? state.seed ?? 0, `sim:${i}`),
    });
    if (!firstTrace) firstTrace = res.trace;
    lastTrace = res.trace;
    if (!res.items.length) empty++;
    picks.push(res.items.map((it) => it.code));
    for (const it of res.items) {
      counts[lf.id][it.code] = (counts[lf.id][it.code] ?? 0) + 1;
    }
  }
  return {
    draws,
    counts: counts[lf.id],
    empty,
    picks,
    firstTrace: firstTrace!,
    lastTrace: lastTrace!,
  };
}

/* ------------------------------------------------------------ lookup */

/**
 * The items a List Fill has already allocated to this respondent, read back
 * out of `state.calculated` — what a `listFill` loop source iterates (§20).
 *
 * Read, never decided: the flow compiler runs after every answer, so
 * re-deciding here would give the respondent a different list each time and
 * consume sample capacity repeatedly. Allocation happens once.
 */
export function listFillLoopItems(
  def: SurveyDefinition,
  state: ResponseState,
  listFillId: string,
): { code: string; label: string }[] {
  const lf = def.listFills.find((x) => x.id === listFillId);
  if (!lf) return [];
  const key = `LISTFILL_${nameOf(lf).toUpperCase()}`;
  const n = Number(state.calculated[`${key}_COUNT`] ?? 0);
  const out: { code: string; label: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const code = state.calculated[`${key}_${i}_CODE`];
    if (code == null || code === "") continue;
    out.push({ code: String(code), label: String(state.calculated[`${key}_${i}`] ?? code) });
  }
  return out;
}

/** The List Fills whose source is this question — what the question panel edits. */
export function listFillsForQuestion(def: SurveyDefinition, questionId: string): ListFill[] {
  return def.listFills.filter((lf) => lf.source.kind === "question" && lf.source.questionId === questionId);
}

/** Every List Fill that can run once this question has been answered. */
export function listFillsReadyAfter(def: SurveyDefinition, answeredQuestionIds: string[]): ListFill[] {
  return def.listFills.filter((lf) => lf.enabled && lf.source.kind === "question" && answeredQuestionIds.includes(lf.source.questionId));
}
