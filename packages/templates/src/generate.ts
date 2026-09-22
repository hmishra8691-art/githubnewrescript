/**
 * AN INTELLIGENT TEST POPULATION.
 *
 * `simulateRespondent` already walks a survey exactly as the runtime does —
 * display logic, skip logic, branching, loops, list fills, scripts, quotas,
 * piping, validation. It is not duplicated here and must not be: this module
 * supplies the one thing it deliberately lacks, which is a respondent who
 * answers DIFFERENTLY from the last one.
 *
 * `defaultAnswer` exists to stop a required question blocking a test path. It
 * always takes the first option, the midpoint, the same sentence. That is
 * exactly right for a regression fixture and exactly wrong for test data: a
 * study whose fifty respondents all chose option 1 exercises one path through
 * the questionnaire and proves nothing about the other five.
 *
 * So the whole design is: sample answers, hand them to the real walker as the
 * per-question functions its options already accept, and let the engine decide
 * what each respondent actually sees. Nothing here evaluates a condition,
 * resolves a mask or validates an answer — those all belong to the engine and
 * calling them twice is how a generator starts disagreeing with the runtime it
 * is meant to be testing.
 *
 * Three things make it more than a random filler:
 *
 *   · it samples from the respondent's OWN option list, after masking and
 *     carry-forward, via `effectiveQuestion` — so it can never offer an answer
 *     that respondent was not shown;
 *   · it deliberately spends some respondents on boundary values — the
 *     minimum, the maximum, the exclusive "None", the "Other" box — because
 *     those are where survey programming breaks;
 *   · it reads the display conditions of questions nobody reached and aims
 *     later respondents at them (see `targetedAnswers`), which is the
 *     difference between fifty random walks and a QA dataset.
 */
import type { LoopContext, QuotaCounts, ListFillCounts } from "@rescript/engine";
import { effectiveQuestion, flattenVariables, mulberry32, hashString } from "@rescript/engine";
import type { Condition, Option, Question, SurveyDefinition } from "@rescript/schema";
import { defaultAnswer, simulateRespondent, type AnswerContext, type SimulationResult } from "./simulate.js";

/* ------------------------------------------------------------------ options */

export interface GenerateOptions {
  /** how many respondents to produce. The caller enforces its own ceiling. */
  count: number;
  /** the whole run is reproducible from this. */
  seed?: number;
  /** answers pinned for every respondent — the caller's thumb on the scale. */
  pinned?: Record<string, unknown>;
  embedded?: Record<string, string>;
  quotaCounts?: QuotaCounts;
  listFillCounts?: ListFillCounts;
  /**
   * Share of respondents that take boundary values rather than comfortable
   * ones. 0 gives a plausible-looking population; 1 gives a population made
   * entirely of edge cases, which is useful and reads as obviously synthetic.
   */
  edgeRate?: number;
  /**
   * After this many respondents, start aiming at questions nobody has reached.
   * Set to `count` to disable targeting entirely.
   */
  exploreAfter?: number;
}

export interface GeneratedRespondent {
  index: number;
  seed: number;
  sim: SimulationResult;
  /** the export-column view, which is the shape a response row stores */
  vars: Record<string, unknown>;
  endStatus: string;
  /** questions this respondent was actually asked */
  asked: string[];
  blocked: boolean;
}

export type IssueKind =
  | "unreachable_question"
  | "blocked_validation"
  | "script_error"
  | "no_options"
  | "impossible_condition"
  | "unsupported_type";

export interface GenerationIssue {
  kind: IssueKind;
  questionId?: string;
  message: string;
  /** how many respondents hit it */
  count: number;
}

export interface Coverage {
  questions: { exercised: number; total: number; missing: { id: string; code: string; text: string }[] };
  pages: { exercised: number; total: number };
  endStatuses: Record<string, number>;
  /** distinct answer values seen per question — the anti-"everyone picked option 1" measure */
  answerVariety: { questionId: string; code: string; distinct: number; offered: number }[];
  /** display/skip conditions that were true for at least one respondent, and for none */
  conditions: { total: number; fired: number; never: string[] };
}

export interface GenerationReport {
  respondents: GeneratedRespondent[];
  coverage: Coverage;
  issues: GenerationIssue[];
  stats: {
    requested: number;
    produced: number;
    questionsDetected: number;
    conditionsDetected: number;
    seed: number;
    /** respondents thrown away because the walk hit a validation wall */
    discarded: number;
    /** respondents the survey rejected at least once and a regeneration fixed */
    corrected: number;
  };
}

/* ------------------------------------------------------------- verbatim pool */

/**
 * Open ends that read like a person wrote them.
 *
 * Not "Lorem ipsum" and not one sentence repeated fifty times — a coder
 * opening the data should be able to tell at a glance whether the open ends
 * carried through the pipeline, and identical strings hide exactly the bugs
 * (truncation, encoding, de-duplication) that open ends are used to find.
 *
 * Chosen by a hash of the question text so the register roughly fits what was
 * asked, with the rest varying per respondent.
 */
const VERBATIMS = {
  positive: [
    "It does what I need without any fuss, which is all I really wanted.",
    "Good value for the price. I'd recommend it to a colleague.",
    "The support team actually answered, which surprised me.",
    "Easy to set up — I was running in about ten minutes.",
    "Reliable. It hasn't let me down in the six months I've used it.",
  ],
  negative: [
    "Too expensive for what you get, and the billing is confusing.",
    "It crashed twice last week and I lost the work I'd done.",
    "Support took four days to reply and then asked me to reinstall.",
    "The interface is cluttered — I can never find the setting I want.",
    "It's slow on older machines, which is what most of our team has.",
  ],
  neutral: [
    "It's fine. Does the job, nothing remarkable either way.",
    "No strong feelings — I use it because it came with the package.",
    "Mixed. Some parts are excellent, others feel unfinished.",
    "Haven't used it enough to have a real opinion yet.",
    "About what I expected for something in this category.",
  ],
  reason: [
    "Mainly convenience — it was the first one I found that worked.",
    "A colleague recommended it and I never looked for an alternative.",
    "Price, mostly. The others were roughly twice as much.",
    "It was already approved by our procurement team.",
    "I tried three and this was the least frustrating.",
  ],
  suggestion: [
    "Better documentation would help more than any new feature.",
    "Let me export the data without going through three menus.",
    "A dark mode, honestly. I work late.",
    "Faster load times on the dashboard.",
    "Make the mobile version usable — right now it isn't.",
  ],
} as const;

type Register = keyof typeof VERBATIMS;

/** Pick a register from what the question asks, so the answer is on topic. */
function registerFor(text: string): Register {
  const t = text.toLowerCase();
  if (/\b(why|reason|because|what made|led you)\b/.test(t)) return "reason";
  if (/\b(improve|suggest|better|change|wish|would you like)\b/.test(t)) return "suggestion";
  if (/\b(dislike|problem|issue|frustrat|worst|poor|complain)\b/.test(t)) return "negative";
  if (/\b(like|love|best|benefit|advantage|favou?rite)\b/.test(t)) return "positive";
  return "neutral";
}

const FIRST = ["alex", "sam", "jordan", "riley", "casey", "morgan", "taylor", "jamie", "avery", "quinn"];
const LAST = ["bennett", "carter", "diaz", "ellis", "flores", "grant", "hayes", "irwin", "jensen", "kumar"];

/* ------------------------------------------------------------------ sampling */

interface Rng { (): number }

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] ?? xs[0];
const intBetween = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

/** Fisher–Yates on a copy, driven by the seeded stream so a run is reproducible. */
function shuffled<T>(rng: Rng, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const isExclusive = (o: Option) => !!o.flags?.includes("exclusive");
const isOther = (o: Option) => !!o.flags?.includes("other_specify");

/**
 * The bounds a question actually enforces.
 *
 * `settings.minValue` is the authoring convenience; `validation` is the list
 * the engine checks against, and the two do not always agree — a text question
 * carries its length limit only in `validation`, which is how the first run of
 * this generator produced sixty-one-character verbatims for a sixty-character
 * box and had every one of them rejected. Reading both, and taking the
 * tighter, is the difference between a sampler that proposes legal answers and
 * one that relies on the retry loop to clean up after it.
 */
interface Bounds { min?: number; max?: number; minLen?: number; maxLen?: number; integer: boolean }
function boundsOf(q: Question): Bounds {
  const s = (q.settings ?? {}) as Record<string, unknown>;
  const b: Bounds = {
    min: typeof s.minValue === "number" ? s.minValue : undefined,
    max: typeof s.maxValue === "number" ? s.maxValue : undefined,
    integer: false,
  };
  for (const r of (q.validation ?? []) as { kind: string; value?: unknown }[]) {
    const n = Number(r.value);
    switch (r.kind) {
      case "min_value": if (Number.isFinite(n)) b.min = b.min == null ? n : Math.max(b.min, n); break;
      case "max_value": if (Number.isFinite(n)) b.max = b.max == null ? n : Math.min(b.max, n); break;
      case "min_length": if (Number.isFinite(n)) b.minLen = n; break;
      case "max_length": if (Number.isFinite(n)) b.maxLen = n; break;
      case "integer": b.integer = true; break;
      default: break;
    }
  }
  return b;
}

/** Trim a verbatim to the box it has to fit, on a word boundary where possible. */
function fitText(text: string, b: Bounds): string {
  let out = text;
  if (b.maxLen != null && out.length > b.maxLen) {
    out = out.slice(0, b.maxLen);
    const sp = out.lastIndexOf(" ");
    if (sp > b.maxLen * 0.6) out = out.slice(0, sp);
    out = out.trimEnd().replace(/[,;:—-]$/, "");
  }
  if (b.minLen != null && out.length < b.minLen) out = out.padEnd(b.minLen, " ").slice(0, Math.max(b.minLen, out.length));
  return out;
}

/**
 * An answer for one question, for one respondent.
 *
 * `edge` means this respondent has been chosen to probe a boundary on this
 * question. It is not "be random" — it is "take the value most likely to break
 * something": the minimum, the maximum, the exclusive option, the Other box,
 * the shortest legal selection.
 *
 * Anything this does not know how to sample falls through to `defaultAnswer`,
 * which already covers every type the platform has. That is the rule that
 * keeps the generator correct as new question types are added: an unknown type
 * produces the engine's own plausible default rather than nothing.
 */
export function sampleAnswer(q: Question, ctx: AnswerContext, rng: Rng, edge: boolean, attempt = 0): unknown {
  const view = effectiveQuestion(q, ctx);
  const s = q.settings ?? {};
  const b = boundsOf(q);
  /*
   * Each retry draws from a narrower, lower slice of the numeric range.
   *
   * Cross-question rules are overwhelmingly of the form "this must be at most
   * that" — children under the household size, subscription spend under total
   * spend. Nothing here reads those rules (that would be a second evaluator),
   * but a smaller number satisfies more of them, so a blocked respondent
   * regenerated with a tighter draw usually passes. It is a heuristic, and the
   * walk still has the final say.
   */
  const shrink = attempt > 0 ? 1 / (attempt + 1) : 1;
  const narrow = (lo: number, hi: number) => (attempt === 0 ? hi : lo + Math.max(0, Math.floor((hi - lo) * shrink)));
  const opts = view.options ?? [];
  const plain = opts.filter((o) => !isExclusive(o) && !isOther(o));
  const rows = (view.rows ?? []).map((r) => String(r.code));

  switch (q.type) {
    case "single_select":
    case "dropdown":
    case "experiment": {
      if (!opts.length) return defaultAnswer(ctx.def, q, ctx);
      // an edge respondent reaches for the exclusive or Other option when one exists
      if (edge) {
        const special = opts.filter((o) => isExclusive(o) || isOther(o));
        if (special.length) return pick(rng, special).code;
      }
      return pick(rng, plain.length ? plain : opts).code;
    }

    case "multi_select":
    case "multi_dropdown":
    case "image_select": {
      if (!opts.length) return defaultAnswer(ctx.def, q, ctx);
      const min = Math.max(1, (s.minSelections as number) ?? 1);
      const max = Math.min((s.maxSelections as number) ?? plain.length, plain.length) || 1;
      if (edge) {
        // an exclusive option must travel alone, which is the rule most often broken
        const excl = opts.filter(isExclusive);
        if (excl.length && rng() < 0.5) return [pick(rng, excl).code];
        // otherwise sit exactly on a selection bound
        const n = rng() < 0.5 ? min : max;
        return shuffled(rng, plain).slice(0, Math.max(1, n)).map((o) => o.code);
      }
      const n = intBetween(rng, min, Math.max(min, max));
      return shuffled(rng, plain).slice(0, n).map((o) => o.code);
    }

    case "numeric": {
      const lo = b.min ?? 0;
      const hi = b.max ?? Math.max(lo + 100, 100);
      if (edge && attempt === 0) return rng() < 0.5 ? lo : hi;
      return intBetween(rng, lo, Math.max(lo, narrow(lo, hi)));
    }

    case "slider":
    case "nps": {
      const lo = b.min ?? 0;
      const hi = b.max ?? 10;
      if (edge) return rng() < 0.5 ? lo : hi;
      /*
       * Rating scales are not uniform in real data — they lean high, with a
       * detractor tail. A flat draw makes every NPS come out near the middle
       * and hides the segment logic that keys off promoters and detractors.
       */
      const r = rng();
      const t = r < 0.55 ? 0.75 + rng() * 0.25 : r < 0.8 ? 0.45 + rng() * 0.3 : rng() * 0.45;
      return Math.round(lo + t * (hi - lo));
    }

    case "open_text": {
      if (q.variant === "text.email") return `${pick(rng, FIRST)}.${pick(rng, LAST)}${intBetween(rng, 1, 99)}@example.com`;
      if (q.variant === "text.zip") return String(intBetween(rng, 10000, 99999));
      if (q.variant === "text.phone") return `555${String(intBetween(rng, 1000000, 9999999))}`;
      if (q.variant === "text.url") return `https://example.com/${pick(rng, LAST)}`;
      if (edge) return fitText(b.minLen ? "x".repeat(b.minLen) : "x", b); // shortest thing that is still an answer
      return fitText(pick(rng, VERBATIMS[registerFor(q.text ?? "")]), b);
    }

    case "long_text": {
      if (edge) return fitText(b.minLen ? "No. ".repeat(Math.ceil(b.minLen / 4)) : "No.", b);
      const reg = registerFor(q.text ?? "");
      const one = pick(rng, VERBATIMS[reg]);
      const two = pick(rng, VERBATIMS.neutral);
      return fitText(rng() < 0.4 ? `${one} ${two}` : one, b);
    }

    case "ranking":
    case "image_ranking": {
      if (!plain.length) return defaultAnswer(ctx.def, q, ctx);
      const n = Math.min((s.maxSelections as number) ?? plain.length, plain.length);
      return shuffled(rng, plain).slice(0, n).map((o) => o.code);
    }

    case "matrix_single":
    case "matrix_dropdown": {
      if (!rows.length || !opts.length) return defaultAnswer(ctx.def, q, ctx);
      /*
       * Straight-lining is a real respondent behaviour and a real thing to
       * test for, so a minority of respondents do it deliberately. The rest
       * vary per row, which is what stops a grid's row-level logic from
       * looking untested.
       */
      if (rng() < 0.15) { const one = pick(rng, plain.length ? plain : opts).code; return Object.fromEntries(rows.map((r) => [r, one])); }
      return Object.fromEntries(rows.map((r) => [r, pick(rng, plain.length ? plain : opts).code]));
    }

    case "matrix_multi": {
      if (!rows.length || !opts.length) return defaultAnswer(ctx.def, q, ctx);
      return Object.fromEntries(rows.map((r) => {
        const n = intBetween(rng, 1, Math.max(1, Math.min(3, plain.length)));
        return [r, shuffled(rng, plain.length ? plain : opts).slice(0, n).map((o) => o.code)];
      }));
    }

    case "matrix_numeric": {
      if (!rows.length) return defaultAnswer(ctx.def, q, ctx);
      const lo = b.min ?? 0;
      const hi = b.max ?? 10;
      return Object.fromEntries(rows.map((r) => [r, edge ? (rng() < 0.5 ? lo : hi) : intBetween(rng, lo, Math.max(lo, narrow(lo, hi)))]));
    }

    case "allocation": {
      const codes = (plain.length ? plain : opts).map((o) => String(o.code));
      if (!codes.length) return defaultAnswer(ctx.def, q, ctx);
      const target = (s.sumTarget as number) ?? 100;
      if (edge) { // everything on one option — the degenerate split
        const winner = pick(rng, codes);
        return Object.fromEntries(codes.map((c) => [c, c === winner ? target : 0]));
      }
      /*
       * Must land on the target exactly or the survey's own sum validation
       * rejects it. Random weights, normalised, with the rounding remainder
       * pushed onto the largest share so the total is exact.
       */
      const w = codes.map(() => rng() + 0.05);
      const total = w.reduce((a, b) => a + b, 0);
      const raw = w.map((x) => Math.floor((x / total) * target));
      let short = target - raw.reduce((a, b) => a + b, 0);
      let biggest = 0;
      for (let i = 1; i < raw.length; i++) if (raw[i] > raw[biggest]) biggest = i;
      raw[biggest] += short;
      return Object.fromEntries(codes.map((c, i) => [c, raw[i]]));
    }

    case "date": {
      const days = edge ? (rng() < 0.5 ? 0 : 364) : intBetween(rng, 0, 364);
      const d = new Date(Date.UTC(2025, 0, 1) + days * 86400000);
      return d.toISOString().slice(0, 10);
    }

    case "time": return `${String(intBetween(rng, 0, 23)).padStart(2, "0")}:${String(intBetween(rng, 0, 59)).padStart(2, "0")}`;

    case "numeric_list": {
      if (!rows.length) return defaultAnswer(ctx.def, q, ctx);
      const lo = b.min ?? 0, hi = b.max ?? 100;
      return Object.fromEntries(rows.map((r) => [r, intBetween(rng, lo, Math.max(lo, narrow(lo, hi)))]));
    }

    case "text_list": {
      if (!rows.length) return defaultAnswer(ctx.def, q, ctx);
      return Object.fromEntries(rows.map((r) => [r, pick(rng, VERBATIMS.neutral)]));
    }

    /*
     * Everything else — composite, custom_table, conjoint, maxdiff, geo,
     * hotspot, annotation, repeating_group, upload, media_timeline — goes to
     * the engine's own default. Those answers are structural (a design file's
     * task ids, a column layout) rather than a value to vary, and getting them
     * subtly wrong would block the walk rather than test anything. This is
     * also the clause that keeps the generator working when a new question
     * type is added: it produces the platform's plausible default instead of
     * nothing at all.
     */
    default: return defaultAnswer(ctx.def, q, ctx);
  }
}

/* ------------------------------------------------- reading a display condition */

/**
 * Widen what gets resampled when the survey keeps rejecting the same page.
 *
 * `validatePage` reports the rule that fired, not every question involved in
 * it. A cross-field rule like "subscriptions plus hardware cannot exceed your
 * total" names the hardware box, so resampling only that box can never satisfy
 * it when the subscriptions figure is the one that is too large — the search
 * then retries the same impossible position until it runs out of attempts.
 *
 * So the first failure resamples the question the survey named, and a repeat
 * failure on the same page resamples the whole page. That is the smallest
 * escalation that can actually move a multi-question constraint.
 */
function widenRejected(rejected: Set<string>, walked: SimulationResult, seenPages: Map<string, number>): void {
  const blocked = walked.blocked;
  if (!blocked) return;
  for (const e of blocked.errors) if (e.questionId) rejected.add(e.questionId);
  const hits = (seenPages.get(blocked.pageId) ?? 0) + 1;
  seenPages.set(blocked.pageId, hits);
  if (hits >= 2) {
    const page = walked.pages.find((p) => p.pageId === blocked.pageId) ?? walked.pages[walked.pages.length - 1];
    for (const qid of page?.questionIds ?? []) rejected.add(qid);
  }
}

/**
 * Can a respondent be asked this at all?
 *
 * The same test `visibleQuestions` applies (`packages/engine/src/flow.ts:274`).
 * A calculated or hidden question has a value but never a respondent, so
 * counting one as "never exercised" is noise.
 */
function isAnswerable(q: Question): boolean {
  return q.type !== "html" && q.type !== "hidden" && q.type !== "calculated"
    && (q.type as string) !== "embedded_data" && !(q.settings as { hidden?: boolean } | undefined)?.hidden;
}

/**
 * The display rules that gate a question.
 *
 * Display logic is not a field on the question — it is `def.displayRules`,
 * a separate list of named rules each targeting something by kind and ref
 * (§6 of the survey requirements). A question can therefore be gated by
 * several rules, and the same rule can gate a page or a whole section, which
 * is why a question with no rule of its own can still go unasked.
 */
function rulesFor(def: SurveyDefinition, questionId: string) {
  return (def.displayRules ?? []).filter((r) => r.target.kind === "question" && r.target.ref === questionId && r.action === "show");
}

/** Every `{kind:"question"}` leaf in a condition, with the value it wants. */
function questionLeaves(c: Condition | null | undefined, out: { ref: string; operator: string; value: unknown }[] = []): { ref: string; operator: string; value: unknown }[] {
  if (!c) return out;
  if (c.type === "group") { for (const child of c.children ?? []) questionLeaves(child, out); return out; }
  if (c.type === "rule" && c.source?.kind === "question" && c.source.ref) {
    out.push({ ref: c.source.ref, operator: c.operator, value: c.value });
  }
  return out;
}

/**
 * What would a respondent have to answer for this question to appear?
 *
 * A deliberately shallow reading, and the shallowness is the point. Solving a
 * survey's conditions in general is constraint satisfaction with piping,
 * masking and calculations in the loop — a solver would be a second logic
 * implementation and would drift from the engine. This reads the common
 * shapes — `Q1 = Yes`, `Q1 in [a,b]`, `Q1 selected a` — proposes an answer,
 * and then lets the real walk decide whether it worked. If the proposal is
 * wrong, the respondent simply does not reach the question and the coverage
 * report still says so, which is the honest outcome.
 */
export function targetedAnswers(def: SurveyDefinition, q: Question): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const leaf of rulesFor(def, q.id).flatMap((r) => questionLeaves(r.when))) {
    const src = def.questions.find((x) => x.id === leaf.ref);
    if (!src) continue;
    const v = leaf.value;
    switch (leaf.operator) {
      case "eq": case "selected": case "contains":
        if (v != null) out[src.id] = Array.isArray(v) ? v : ["multi_select", "multi_dropdown", "image_select"].includes(src.type) ? [v] : v;
        break;
      case "in": case "containsAny": case "containsAll":
        if (Array.isArray(v) && v.length) out[src.id] = ["multi_select", "multi_dropdown", "image_select"].includes(src.type) ? v : v[0];
        break;
      case "gte": case "gt": if (typeof v === "number") out[src.id] = leaf.operator === "gt" ? v + 1 : v; break;
      case "lte": case "lt": if (typeof v === "number") out[src.id] = leaf.operator === "lt" ? v - 1 : v; break;
      default: break;   // ne/notIn/answered and friends: leave it to ordinary sampling
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the driver */

/** Every condition attached to a question, for the coverage denominator. */
function conditionsOf(def: SurveyDefinition): { id: string; label: string }[] {
  return (def.displayRules ?? []).map((r) => ({
    id: r.id,
    label: r.label || `${r.action} ${r.target.kind} ${r.target.ref}`,
  }));
}

export function generatePopulation(def: SurveyDefinition, opts: GenerateOptions): GenerationReport {
  const baseSeed = opts.seed ?? 20260922;
  const count = Math.max(1, opts.count);
  const edgeRate = opts.edgeRate ?? 0.2;
  const exploreAfter = opts.exploreAfter ?? Math.min(10, Math.ceil(count / 2));

  const respondents: GeneratedRespondent[] = [];
  const issueTally = new Map<string, GenerationIssue>();
  const addIssue = (kind: IssueKind, message: string, questionId?: string) => {
    const key = `${kind}:${questionId ?? ""}:${message}`;
    const cur = issueTally.get(key);
    if (cur) cur.count++; else issueTally.set(key, { kind, questionId, message, count: 1 });
  };

  const asked = new Set<string>();
  const pagesSeen = new Set<string>();
  const endStatuses: Record<string, number> = {};
  const valuesSeen = new Map<string, Set<string>>();
  let discarded = 0;
  let corrected = 0;   // respondents the survey rejected once and a retry fixed

  /*
   * The quota counters EVOLVE across the population, exactly as they would in
   * field. Without this every respondent sees an empty quota and the
   * quota-full path is never taken, so the one piece of logic most likely to
   * be misprogrammed is also the one the test data never touches.
   */
  const quotaCounts: QuotaCounts = JSON.parse(JSON.stringify(opts.quotaCounts ?? {}));
  const listFillCounts: ListFillCounts = JSON.parse(JSON.stringify(opts.listFillCounts ?? {}));

  /*
   * THE GENERATOR LEARNS WHICH ANSWERS GET PAST A SCREENER.
   *
   * Uniform sampling on a survey that screens is a population of screen-outs:
   * the first run of this module produced nineteen respondents who all
   * terminated on page one, which is a technically valid dataset that tests
   * nothing. Reading the termination conditions to avoid them would mean a
   * second evaluator, so instead the walk is allowed to discover them.
   *
   * `gateQuestions` collects the questions that were on screen when somebody
   * terminated — the gates. `exemplar` remembers what the first respondent who
   * got through answered. Later respondents who are meant to qualify reuse the
   * exemplar's answers AT THE GATES ONLY and sample everything else freely, so
   * they get into the survey without becoming copies of each other.
   *
   * A deliberate minority is left to sample freely, because the screen-out and
   * quota-full paths are part of the survey too and a dataset without them
   * has not tested the thing most likely to be misprogrammed.
   */
  const baseId = (key: string) => key.split("@")[0].split("__")[0];

  /*
   * The reference walk is the platform's own answer to "what keeps a
   * respondent alive": `defaultAnswer` exists precisely so a required question
   * never blocks a path, and on a screening survey its first-option choices
   * are what get through the screener. Sampling uniformly instead produced a
   * population of nineteen page-one screen-outs.
   *
   * So the reference walk supplies the prior, and each respondent decides
   * per question whether to follow it or strike out. `stick` rises with every
   * failed attempt, so a respondent who must qualify converges on the known
   * good path rather than rerolling the same dice; one who is free to screen
   * out never consults it at all.
   */
  let exemplar: Record<string, unknown> | null = null;

  /*
   * WARM-UP: find one path through the survey before generating anybody.
   *
   * `defaultAnswer` alone is not enough — on the Master Demo its spend figures
   * break a cross-field rule, so the reference walk is blocked and every
   * respondent generated from it inherits the same broken answer. Learning the
   * good path from the population instead worked, but cost the first dozen
   * respondents, who all screened out while the generator was still looking.
   *
   * So the search happens once, here, using the same correction the population
   * uses: walk, read which question the survey rejected, resample that one
   * with a narrower draw, walk again. Whatever it finds — a completion, or
   * failing that the furthest walk — becomes the prior everyone else varies
   * around.
   */
  {
    const rejected = new Set<string>();
    const seenPages = new Map<string, number>();
    let furthest: SimulationResult | null = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const rng = mulberry32(hashString(`${baseSeed}:warmup:${attempt}`));
      const answers: Record<string, unknown> = {};
      for (const q of def.questions) {
        if (!isAnswerable(q)) continue;
        if (opts.pinned?.[q.id] !== undefined) { answers[q.id] = opts.pinned[q.id]; continue; }
        // only the questions the survey has complained about are resampled;
        // everything else keeps the engine's own plausible default
        if (!rejected.has(q.id)) continue;
        answers[q.id] = (_l: LoopContext | null, qq: Question, ctx: AnswerContext) =>
          sampleAnswer(qq, ctx, rng, false, attempt);
      }
      let walked: SimulationResult;
      try {
        walked = simulateRespondent(def, { answers, seed: baseSeed + attempt, embedded: opts.embedded, quotaCounts: {}, listFillCounts: {} });
      } catch { break; }
      if (walked.blocked) {
        widenRejected(rejected, walked, seenPages);
        if (!furthest || walked.pages.length > furthest.pages.length) furthest = walked;
        continue;
      }
      furthest = walked;
      if ((walked.endStatus ?? walked.state.status) === "complete") break;
    }
    if (furthest) exemplar = Object.fromEntries(Object.entries(furthest.state.answers).map(([k, v]) => [baseId(k), v]));
  }

  for (let i = 0; i < count; i++) {
    const seed = baseSeed + i * 7919;          // a prime stride: adjacent respondents do not correlate
    const rng = mulberry32(seed ^ hashString(def.meta.id));
    const edgeRespondent = rng() < edgeRate;

    /*
     * Once the population is past `exploreAfter`, spend respondents on the
     * questions nobody has reached rather than on more of the same. One target
     * at a time, because two display conditions can easily contradict and a
     * respondent forced to satisfy both reaches neither.
     */
    let targets: Record<string, unknown> = {};
    if (i >= exploreAfter) {
      const missing = def.questions.filter((q) => isAnswerable(q) && !asked.has(q.id) && rulesFor(def, q.id).length);
      if (missing.length) targets = targetedAnswers(def, missing[(i - exploreAfter) % missing.length]);
    }

    /*
     * GENERATE → VALIDATE → CORRECT → REGENERATE.
     *
     * A survey's cross-question rules — "children fewer than household size",
     * "subscriptions under total spend" — cannot be satisfied by looking at
     * one question at a time, and reading them here would mean writing a
     * second constraint solver that would drift from the engine's. So the
     * sampler proposes, the real walk disposes, and a rejected respondent is
     * regenerated with a tighter draw rather than saved or silently dropped.
     *
     * Only a walk that survives every one of the survey's own rules becomes a
     * record, because a test dataset containing responses the live survey
     * could never have collected is worse than no test dataset.
     */
    /*
     * Roughly three in four respondents are asked to get through the survey;
     * the rest take whatever outcome their answers earn them, which is what
     * populates the screened and quota-full paths.
     */
    const wantComplete = rng() < 0.75;
    const MAX_ATTEMPTS = wantComplete ? 8 : 3;
    let sim: SimulationResult | null = null;
    let lastBlock: SimulationResult["blocked"] | undefined;
    let best: SimulationResult | null = null;   // the furthest walk, if none qualifies
    /*
     * The questions the survey has already rejected for this respondent.
     *
     * Without this the two correction mechanisms fight each other. The
     * exemplar is a known-good path, so a respondent who must qualify follows
     * it closely — but `defaultAnswer` is not guaranteed to satisfy a survey's
     * CROSS-FIELD rules, and on the Master Demo it does not: its default spend
     * figures break "subscriptions plus hardware cannot exceed total". So a
     * high-stick attempt inherited the bad numbers and was blocked, a low-stick
     * attempt answered the consent question freely and was screened out, and
     * no respondent ever completed.
     *
     * The engine says which question it rejected. That question stops being
     * inherited and is resampled — with the attempt's narrower draw — while
     * the rest of the known-good path is kept.
     */
    const rejected = new Set<string>();
    const seenPages = new Map<string, number>();

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !sim; attempt++) {
      const attemptRng = mulberry32((seed ^ hashString(def.meta.id)) + attempt * 104729);
      /* follow the known-good path more closely each time the survey says no */
      const stick = wantComplete ? Math.min(0.92, 0.3 + attempt * 0.18) : 0;
      const answers: Record<string, unknown> = {};
      for (const q of def.questions) {
        if (!isAnswerable(q)) continue;
        const pin = opts.pinned?.[q.id];
        const target = targets[q.id];
        if (pin !== undefined) { answers[q.id] = pin; continue; }
        if (target !== undefined) { answers[q.id] = target; continue; }
        const exemplarValue = wantComplete && exemplar && !rejected.has(q.id) ? exemplar[q.id] : undefined;
        answers[q.id] = (loop: LoopContext | null, qq: Question, ctx: AnswerContext) => {
          try {
            if (exemplarValue !== undefined && attemptRng() < stick) return exemplarValue;
            return sampleAnswer(qq, ctx, attemptRng, edgeRespondent && attempt === 0, attempt);
          } catch (e) {
            addIssue("unsupported_type", `Could not generate an answer for ${qq.code ?? qq.id} (${qq.type}): ${(e as Error).message}`, qq.id);
            return defaultAnswer(ctx.def, qq, ctx);
          }
        };
      }

      let walked: SimulationResult;
      try {
        walked = simulateRespondent(def, { answers, seed, embedded: opts.embedded, quotaCounts, listFillCounts });
      } catch (e) {
        addIssue("script_error", `The walk threw on respondent ${i + 1}: ${(e as Error).message}`);
        break;
      }
      if (walked.blocked) {
        lastBlock = walked.blocked;
        if (attempt === 0) corrected++;
        widenRejected(rejected, walked, seenPages);
        continue;
      }

      const end = walked.endStatus ?? walked.state.status;
      if (end === "complete" && walked.pages.length > 1) {
        exemplar = Object.fromEntries(Object.entries(walked.state.answers).map(([k, v]) => [baseId(k), v]));
      }
      if (!best || walked.pages.length > best.pages.length) best = walked;
      if (!wantComplete || end === "complete") sim = walked;
    }

    /*
     * A respondent that was meant to qualify and never did is still saved —
     * as the furthest walk it managed. Discarding it would quietly shrink the
     * dataset, and a survey where qualifying is genuinely hard is a finding
     * the coverage report should show rather than hide.
     */
    if (!sim && best) sim = best;

    if (!sim) {
      /*
       * Four tries and the survey still rejected it. That is a finding about
       * the questionnaire, not a record — reported with the rule that blocked
       * it so the programmer can see which constraint is unsatisfiable.
       */
      for (const err of (lastBlock?.errors ?? []).slice(0, 3)) {
        addIssue("blocked_validation", `${err.message} (page ${lastBlock?.pageId})`, err.questionId || undefined);
      }
      discarded++;
      continue;
    }
    for (const se of sim.scriptErrors) for (const e of se.errors) addIssue("script_error", e.message, e.questionRef);

    for (const p of sim.pages) {
      pagesSeen.add(p.pageId.split("@")[0]);
      for (const qid of p.questionIds) asked.add(qid);
    }
    const end = sim.endStatus ?? sim.state.status;
    endStatuses[end] = (endStatuses[end] ?? 0) + 1;

    const vars = flattenVariables(def, sim.state) as Record<string, unknown>;
    for (const [k, v] of Object.entries(sim.state.answers)) {
      const qid = k.split("@")[0].split("__")[0];
      if (!valuesSeen.has(qid)) valuesSeen.set(qid, new Set());
      valuesSeen.get(qid)!.add(JSON.stringify(v));
    }

    respondents.push({
      index: i, seed, sim, vars, endStatus: end,
      asked: [...new Set(sim.pages.flatMap((p) => p.questionIds))],
      blocked: false,
    });
  }

  /* ------------------------------------------------------------- coverage */

  /*
   * The denominator is what a RESPONDENT can be asked.
   *
   * `flow.ts:274` already draws this line for the runtime — hidden,
   * calculated and embedded_data questions are filtered out of
   * `visibleQuestions`, and `settings.hidden` removes the rest. Counting them
   * as uncovered reported a calculated NPS group as a question nobody reached,
   * which is true and useless: nobody can ever reach it. Same predicate,
   * quoted rather than reinvented, so the two cannot drift.
   */
  const answerable = def.questions.filter(isAnswerable);
  const missing = answerable.filter((q) => !asked.has(q.id));
  for (const q of missing) {
    addIssue(
      "unreachable_question",
      rulesFor(def, q.id).length
        ? `No generated respondent satisfied the display condition on ${q.code ?? q.id}, so it was never answered. Its condition may be unsatisfiable, or it may need a pinned answer.`
        : `${q.code ?? q.id} was never asked although it has no display condition — check that its page is reachable.`,
      q.id,
    );
  }

  const conds = conditionsOf(def);
  /*
   * A rule counts as fired when the question it shows was reached by someone.
   * Rules that gate a page or a section are counted by whether any question on
   * that target was reached, which is approximate — but an honest denominator
   * beats a precise one that needs a second evaluator to compute.
   */
  const firedRules = new Set<string>();
  for (const r of def.displayRules ?? []) {
    if (r.target.kind === "question" && asked.has(r.target.ref)) firedRules.add(r.id);
    else if (r.target.kind !== "question" && pagesSeen.has(r.target.ref)) firedRules.add(r.id);
  }
  const neverFired = (def.displayRules ?? []).filter((r) => !firedRules.has(r.id)).map((r) => r.label || r.id);

  const variety = answerable
    .map((q) => ({
      questionId: q.id,
      code: q.code ?? q.id,
      distinct: valuesSeen.get(q.id)?.size ?? 0,
      offered: (q.options ?? []).length,
    }))
    .filter((v) => v.distinct > 0);

  /*
   * Pages live in `def.flow`, which is a tree of nodes rather than a flat
   * list. Counting the page nodes anywhere in it gives the denominator without
   * re-implementing the flow compiler.
   */
  const pageIds = new Set<string>();
  const walkFlow = (nodes: unknown[]): void => {
    for (const n of nodes ?? []) {
      const node = n as { kind?: string; id?: string; children?: unknown[]; branches?: { children?: unknown[] }[] };
      if (node.kind === "page" && node.id) pageIds.add(node.id);
      if (Array.isArray(node.children)) walkFlow(node.children);
      for (const b of node.branches ?? []) if (Array.isArray(b.children)) walkFlow(b.children);
    }
  };
  walkFlow((def.flow ?? []) as unknown[]);

  return {
    respondents,
    coverage: {
      questions: {
        exercised: answerable.length - missing.length,
        total: answerable.length,
        missing: missing.map((q) => ({ id: q.id, code: q.code ?? q.id, text: (q.text ?? "").slice(0, 120) })),
      },
      pages: { exercised: pagesSeen.size, total: pageIds.size || pagesSeen.size },
      endStatuses,
      answerVariety: variety,
      conditions: { total: conds.length, fired: firedRules.size, never: neverFired },
    },
    issues: [...issueTally.values()].sort((a, b) => b.count - a.count),
    stats: {
      requested: count,
      produced: respondents.length,
      questionsDetected: answerable.length,
      conditionsDetected: conds.length,
      seed: baseSeed,
      discarded,
      corrected,
    },
  };
}
