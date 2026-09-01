import type {
  Question,
  Option,
  QuestionRow,
  CarryForward,
  ListLogicRule,
  ListOperation,
  ListSource,
  OptionLogic,
  OptionSourceRule,
  Randomization,
} from "@rescript/schema";
import { LIST_OPS_WITH_SOURCES } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition, withOption, withLegacyOptionLoop } from "./evaluate.js";
import { getQuestion } from "./state.js";
import { resolvePiping, registerDisplayedOptionsResolver } from "./piping.js";
import { seededShuffle, subSeed, mulberry32 } from "./random.js";

/**
 * THE OPTION PIPELINE.
 *
 * One deterministic, documented order of operations produces the option /
 * row / column list every respondent sees. The editor, the runtime,
 * validation, the debug inspector and the exporters all call the same code,
 * so what a programmer configures is exactly what ships.
 *
 *   1  source            static options, or question-level carry-forward
 *   2  always hidden     options flagged "Always Hide" leave the list
 *   3  eligibility       per-option logic: always show / show when /
 *                        hide when / eligible when / exclude when /
 *                        option carry forward + carry back, plus the
 *                        legacy `visibleIf` condition
 *   4  previous answers  `listLogic` include / exclude / prioritize /
 *                        deprioritize against an earlier question
 *   5  list operations   `optionPipeline`: intersection, union, difference,
 *                        exclude, remaining, dedupe, filter, sort, randomize
 *   6  prioritization    per-option prioritize / deprioritize conditions
 *   7  sorting           presentation sort (never mutates programmed order)
 *   8  randomization     conditional sets, N-of-M, anchors, groups, and
 *                        per-option randomization pinning
 *   9  piping            tokens resolved inside the surviving labels
 *
 * Options marked "Always Show" are protected: stages 3–5 cannot drop them.
 * The single escape hatch is an explicit `excludeWhen` on that option, which
 * is the programmer deliberately overriding their own pin (req §2).
 *
 * Nothing in stages 2–8 does anything at all unless the programmer
 * configured it, so surveys written before this pipeline existed produce
 * byte-identical option lists (req §33).
 */

export interface EffectiveQuestionView {
  options: Option[];
  rows: QuestionRow[];
  columns: Question["columns"];
}

/* ------------------------------------------------------------ source codes */

type Which = "selected" | "not_selected" | "displayed" | "answered_rows" | "all";

/**
 * Guard against a definition whose option lists reference each other in a
 * loop. `detectLogicCycles` blocks these in Studio; this is the runtime
 * backstop that guarantees evaluation always terminates (req §31).
 */
const resolving = new Set<string>();

function codesFrom(
  sourceQuestionId: string,
  which: Which,
  ctx: EvalContext,
): (string | number)[] {
  const src = getQuestion(ctx.def, sourceQuestionId);
  if (!src) return [];
  const loopKey = ctx.loop ? `${src.id}@${ctx.loop.code}` : null;
  const answer =
    (loopKey ? ctx.state.answers[loopKey] : undefined) ?? ctx.state.answers[src.id];
  const selected = Array.isArray(answer)
    ? answer
    : answer == null
      ? []
      : typeof answer === "object"
        ? Object.keys(answer)
        : [answer as string | number];

  /** options the source question actually showed — needs its own pipeline run */
  const displayed = (): (string | number)[] => {
    if (resolving.has(src.id)) return src.options.map((o) => o.code);
    resolving.add(src.id);
    try {
      return effectiveQuestion(src, ctx).options.map((o) => o.code);
    } finally {
      resolving.delete(src.id);
    }
  };

  switch (which) {
    case "selected":
      return selected as (string | number)[];
    case "not_selected":
      return displayed().filter((c) => !selected.some((s) => String(s) === String(c)));
    case "displayed":
      return displayed();
    case "answered_rows": {
      if (answer && typeof answer === "object" && !Array.isArray(answer)) {
        return Object.entries(answer as Record<string, unknown>)
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k]) => k);
      }
      return selected as (string | number)[];
    }
    case "all":
    default:
      return src.options.map((o) => o.code);
  }
}

/** Has the source question been answered at all (for back references)? */
function isAnswered(questionId: string, ctx: EvalContext): boolean {
  const q = getQuestion(ctx.def, questionId);
  if (!q) return false;
  const loopKey = ctx.loop ? `${q.id}@${ctx.loop.code}` : null;
  const a = (loopKey ? ctx.state.answers[loopKey] : undefined) ?? ctx.state.answers[q.id];
  if (a === null || a === undefined || a === "") return false;
  if (Array.isArray(a)) return a.length > 0;
  if (typeof a === "object") return Object.keys(a).length > 0;
  return true;
}

function carriedOptions(cf: CarryForward, ctx: EvalContext): Option[] {
  const src = getQuestion(ctx.def, cf.sourceQuestionId);
  if (!src) return [];
  const codes = codesFrom(cf.sourceQuestionId, cf.filter, ctx);
  const pool: Option[] = codes.map((code) => optionFromSource(src, code));
  if (!cf.where) return pool;
  return pool.filter((o) => evaluateCondition(cf.where, withLegacyOptionLoop(ctx, o)));
}

/** Build an Option for a code, borrowing the label from the source question. */
function optionFromSource(src: Question, code: string | number): Option {
  const opt = src.options.find((o) => String(o.code) === String(code));
  if (opt) return opt;
  const row = src.rows.find((r) => String(r.code) === String(code));
  return { code, label: row?.label ?? String(code), flags: [] };
}

/* ------------------------------------------------------------ debug trace */

export interface PipelineStageTrace {
  key: string;
  label: string;
  /** codes entering the stage, in order */
  before: string[];
  /** codes leaving the stage, in order */
  after: string[];
  /** what the stage dropped, and why */
  removed: { code: string; reason: string }[];
  changed: boolean;
}

export interface OptionStatusTrace {
  code: string;
  label: string;
  status: "visible" | "hidden";
  /** stage that removed it (hidden options only) */
  stage?: string;
  /** human-readable rule that decided it */
  reason?: string;
  alwaysShow: boolean;
  moved?: "top" | "bottom";
  /** excluded from randomization by a `randomizeWhen` that evaluated false */
  pinned?: boolean;
  position?: number;
}

export interface OptionPipelineTrace {
  questionId: string;
  stages: PipelineStageTrace[];
  byCode: Record<string, OptionStatusTrace>;
  final: Option[];
}

interface Recorder {
  stages: PipelineStageTrace[];
  byCode: Record<string, OptionStatusTrace>;
}

function newRecorder(): Recorder {
  return { stages: [], byCode: {} };
}

function record<T extends { code: string | number; label: string }>(
  rec: Recorder | null,
  key: string,
  label: string,
  before: T[],
  after: T[],
  reasons: Map<string, string>,
): void {
  if (!rec) return;
  const afterCodes = new Set(after.map((i) => String(i.code)));
  const removed = before
    .filter((i) => !afterCodes.has(String(i.code)))
    .map((i) => ({ code: String(i.code), reason: reasons.get(String(i.code)) ?? label }));
  for (const r of removed) {
    const st = rec.byCode[r.code];
    if (st) {
      st.status = "hidden";
      st.stage = label;
      st.reason = r.reason;
    }
  }
  rec.stages.push({
    key,
    label,
    before: before.map((i) => String(i.code)),
    after: after.map((i) => String(i.code)),
    removed,
    changed:
      removed.length > 0 ||
      before.map((i) => String(i.code)).join("|") !== after.map((i) => String(i.code)).join("|"),
  });
}

/* -------------------------------------------------------- option-level logic */

type ItemWithLogic = {
  code: string | number;
  label: string;
  value?: string | number;
  logic?: OptionLogic;
  visibleIf?: any;
  flags?: string[];
};

const isAlwaysShow = (i: ItemWithLogic) => i.logic?.visibility === "always_show";
const isAlwaysHide = (i: ItemWithLogic) => i.logic?.visibility === "always_hide";

/**
 * `{ $option: "index" }` must mean the option's PROGRAMMED position, not its
 * position in whatever the list has been whittled down to — otherwise the same
 * rule means something different once an option above it is filtered out.
 * One position map is built at the top of the pipeline and threaded through
 * every per-option evaluation.
 */
type PosFn = (code: string | number, fallback: number) => number;

function makePos(items: ItemWithLogic[]): PosFn {
  const m = new Map(items.map((i, k) => [String(i.code), k]));
  return (code, fallback) => m.get(String(code)) ?? fallback;
}

/** The one place an option evaluation context is built, so code / label /
 *  value / index never drift between stages. */
function optionCtx(
  ctx: EvalContext,
  item: ItemWithLogic,
  fallbackIndex: number,
  pos: PosFn,
): EvalContext {
  return withOption(ctx, {
    code: item.code,
    label: item.label,
    value: item.value,
    index: pos(item.code, fallbackIndex),
  });
}

/**
 * Does an option-level carry forward / carry back rule hold for this item?
 * Returns null when the rule is inapplicable (an unanswered back reference),
 * which means "don't judge this option on it".
 */
function sourceRuleHolds(
  rule: OptionSourceRule,
  item: ItemWithLogic,
  ctx: EvalContext,
): boolean | null {
  if (rule.direction === "back" && !isAnswered(rule.sourceQuestionId, ctx)) return null;
  const src = getQuestion(ctx.def, rule.sourceQuestionId);
  if (!src) return null;
  const codes = codesFrom(rule.sourceQuestionId, rule.which, ctx);
  const needle =
    rule.match === "label"
      ? String(item.label)
      : rule.match === "value"
        ? String((item as Option).value ?? item.code)
        : String(item.code);
  return codes.some((c) => {
    if (rule.match === "code") return String(c) === needle;
    const o = optionFromSource(src, c);
    const cmp = rule.match === "label" ? o.label : String(o.value ?? o.code);
    return String(cmp) === needle;
  });
}

interface Verdict {
  keep: boolean;
  reason: string;
}

/**
 * Stage 3 for a single item. Pure — the same inputs always give the same
 * verdict, and the reason string is what the debugger shows the programmer.
 */
function eligibilityVerdict(
  item: ItemWithLogic,
  index: number,
  ctx: EvalContext,
  pos: PosFn,
): Verdict {
  const octx = optionCtx(ctx, item, index, pos);
  const l = item.logic;

  // an explicit exclusion always wins — including over "Always Show"
  if (l?.excludeWhen && evaluateCondition(l.excludeWhen, octx)) {
    return { keep: false, reason: "Exclude When condition is true" };
  }
  if (isAlwaysShow(item)) return { keep: true, reason: "Always Show" };

  if (item.visibleIf && !evaluateCondition(item.visibleIf, octx)) {
    return { keep: false, reason: "Show-only-when condition is false" };
  }
  if (l) {
    if (l.visibility === "show_when" && !evaluateCondition(l.when, octx)) {
      return { keep: false, reason: "Show When condition is false" };
    }
    if (l.visibility === "hide_when" && l.when && evaluateCondition(l.when, octx)) {
      return { keep: false, reason: "Hide When condition is true" };
    }
    if (l.eligibleWhen && !evaluateCondition(l.eligibleWhen, octx)) {
      return { keep: false, reason: "Eligible When condition is false" };
    }
    for (const [name, rule] of [
      ["Carry Forward", l.carryForward],
      ["Carry Back", l.carryBack],
    ] as const) {
      if (!rule) continue;
      const holds = sourceRuleHolds(rule, item, ctx);
      if (holds === false) {
        const src = getQuestion(ctx.def, rule.sourceQuestionId);
        return {
          keep: false,
          reason: `${name}: not ${rule.which.replace("_", " ")} in ${src?.code ?? rule.sourceQuestionId}`,
        };
      }
    }
  }
  return { keep: true, reason: "eligible" };
}

function applyEligibility<T extends ItemWithLogic>(
  items: T[],
  ctx: EvalContext,
  rec: Recorder | null,
  posOverride?: PosFn,
): T[] {
  const pos = posOverride ?? makePos(items);
  const reasons = new Map<string, string>();

  // 2 — always hidden
  const afterHide = items.filter((i) => {
    if (!isAlwaysHide(i)) return true;
    reasons.set(String(i.code), "Always Hide");
    return false;
  });
  record(rec, "always_hidden", "Always hidden", items, afterHide, reasons);

  // 3 — eligibility
  reasons.clear();
  const afterEligible = afterHide.filter((i, idx) => {
    const v = eligibilityVerdict(i, idx, ctx, pos);
    if (!v.keep) reasons.set(String(i.code), v.reason);
    return v.keep;
  });
  record(rec, "eligibility", "Eligibility rules", afterHide, afterEligible, reasons);
  return afterEligible;
}

/* -------------------------------------------------------------- list logic */

function applyListLogic<T extends ItemWithLogic>(
  rules: ListLogicRule[],
  items: T[],
  ctx: EvalContext,
  rec: Recorder | null,
): T[] {
  let out = items;
  for (const rule of rules) {
    if (rule.when && !evaluateCondition(rule.when, ctx)) continue;
    const before = out;
    const codes = codesFrom(rule.sourceQuestionId, rule.which, ctx).map(String);
    const src = getQuestion(ctx.def, rule.sourceQuestionId);
    const matches = (i: T) => codes.includes(String(i.code));
    const protectedItem = (i: T) => isAlwaysShow(i);
    switch (rule.action) {
      case "include":
        out = out.filter((i) => matches(i) || protectedItem(i));
        break;
      case "exclude":
        out = out.filter((i) => !matches(i) || protectedItem(i));
        break;
      case "prioritize":
        out = [...out.filter(matches), ...out.filter((i) => !matches(i))];
        break;
      case "deprioritize":
        out = [...out.filter((i) => !matches(i)), ...out.filter(matches)];
        break;
    }
    const label = `List logic: ${rule.action} ${rule.which.replace("_", " ")} in ${src?.code ?? rule.sourceQuestionId}`;
    const reasons = new Map<string, string>();
    for (const i of before) reasons.set(String(i.code), label);
    record(rec, `list_logic:${rule.id}`, label, before, out, reasons);
  }
  return out;
}

/* --------------------------------------------------------- list operations */

/** Sources whose question still exists — a deleted reference is ignored
 *  rather than silently evaluating as "the empty list", which would wipe
 *  every option at runtime. */
function liveSources(sources: ListSource[] | undefined, ctx: EvalContext): ListSource[] {
  return (sources ?? []).filter((s) => !!getQuestion(ctx.def, s.questionId));
}

function sourceCodeSets(sources: ListSource[], ctx: EvalContext): string[][] {
  return sources.map((s) => codesFrom(s.questionId, s.which, ctx).map(String));
}

function sourceLabel(sources: ListSource[], ctx: EvalContext): string {
  return sources
    .map((s) => {
      const q = getQuestion(ctx.def, s.questionId);
      return `${q?.code ?? s.questionId} (${s.which.replace("_", " ")})`;
    })
    .join(" , ");
}

function applyListOperations<T extends ItemWithLogic & { flags?: string[] }>(
  ops: ListOperation[],
  items: T[],
  ctx: EvalContext,
  rec: Recorder | null,
  makeItem: (code: string | number, src: Question) => T,
  seed: number,
  sortFn: (order: any, list: T[]) => T[],
  pos: PosFn,
): T[] {
  let out = items;
  for (const op of ops) {
    if (op.when && !evaluateCondition(op.when, ctx)) continue;
    const sources = liveSources(op.sources, ctx);

    // an operation with nothing to read from is a no-op, never a wipe
    if (LIST_OPS_WITH_SOURCES.includes(op.kind) && sources.length === 0) continue;
    if (op.kind === "difference" && sources.length < 2) continue;

    const before = out;
    const sets = sourceCodeSets(sources, ctx);
    const inAny = (i: T) => sets.some((s) => s.includes(String(i.code)));
    const inAll = (i: T) => sets.length > 0 && sets.every((s) => s.includes(String(i.code)));
    const keep = (i: T, verdict: boolean) => verdict || isAlwaysShow(i);
    /** imported options must still obey their own logic (§2–3) */
    const admit = (list: T[]) => applyEligibility(list, ctx, null, pos);
    let reason = op.label ?? "";

    switch (op.kind) {
      case "carry_forward": {
        const collected: T[] = [];
        const seen = new Set<string>();
        for (const s of sources) {
          const src = getQuestion(ctx.def, s.questionId)!;
          for (const code of codesFrom(s.questionId, s.which, ctx)) {
            if (seen.has(String(code))) continue;
            seen.add(String(code));
            collected.push(makeItem(code, src));
          }
        }
        const admitted = admit(collected);
        const pinned = out.filter((i) => isAlwaysShow(i) && !seen.has(String(i.code)));
        out = op.keepOwn
          ? [...admitted, ...out.filter((i) => !seen.has(String(i.code)))]
          : [...admitted, ...pinned];
        reason ||= `Carry forward from ${sourceLabel(sources, ctx)}`;
        break;
      }
      case "union": {
        const present = new Set(out.map((i) => String(i.code)));
        const added: T[] = [];
        for (const s of sources) {
          const src = getQuestion(ctx.def, s.questionId)!;
          for (const code of codesFrom(s.questionId, s.which, ctx)) {
            if (present.has(String(code))) continue;
            present.add(String(code));
            added.push(makeItem(code, src));
          }
        }
        out = [...out, ...admit(added)];
        reason ||= `Union with ${sourceLabel(sources, ctx)}`;
        break;
      }
      case "intersect":
        out = out.filter((i) => keep(i, inAll(i)));
        reason ||= `Not present in all of ${sourceLabel(sources, ctx)}`;
        break;
      case "difference": {
        const [first, ...rest] = sets;
        out = out.filter((i) =>
          keep(
            i,
            (first ?? []).includes(String(i.code)) &&
              !rest.some((s) => s.includes(String(i.code))),
          ),
        );
        reason ||= `Difference against ${sourceLabel(sources, ctx)}`;
        break;
      }
      case "exclude":
        out = out.filter((i) => keep(i, !inAny(i)));
        reason ||= `Excluded by ${sourceLabel(sources, ctx)}`;
        break;
      case "remaining":
        out = out.filter((i) => keep(i, !inAny(i)));
        reason ||= `Already seen in ${sourceLabel(sources, ctx)}`;
        break;
      case "prioritize":
        out = [...out.filter(inAny), ...out.filter((i) => !inAny(i))];
        break;
      case "deprioritize":
        out = [...out.filter((i) => !inAny(i)), ...out.filter(inAny)];
        break;
      case "dedupe": {
        const seen = new Set<string>();
        out = out.filter((i) => {
          const k = String(i.code);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        reason ||= "Duplicate code";
        break;
      }
      case "filter":
        out = out.filter((i, idx) =>
          keep(i, !op.where || evaluateCondition(op.where, optionCtx(ctx, i, idx, pos))),
        );
        reason ||= "Filter condition is false";
        break;
      case "sort":
        out = sortFn(op.order ?? "az", out);
        break;
      case "randomize":
        out = randomizeItems(
          out,
          { method: op.method ?? "shuffle", pick: op.pick },
          subSeed(seed, `op:${op.id}`),
          pinnedCodes(out, ctx, pos),
          alwaysShowCodes(out),
        );
        reason ||= "Not selected by randomize N";
        break;
    }

    const label = `${op.label ?? op.kind.replace("_", " ")}`;
    const reasons = new Map<string, string>();
    for (const i of before) reasons.set(String(i.code), reason || label);
    record(rec, `list_op:${op.id}`, label, before, out, reasons);
    if (rec) {
      for (const i of out) {
        // options introduced by this step start their life visible
        rec.byCode[String(i.code)] ??= {
          code: String(i.code),
          label: stripHtml(i.label),
          status: "visible",
          alwaysShow: isAlwaysShow(i),
        };
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ prioritizing */

function applyPrioritization<T extends ItemWithLogic>(
  items: T[],
  ctx: EvalContext,
  rec: Recorder | null,
  pos: PosFn,
): T[] {
  const hasAny = items.some((i) => i.logic?.prioritizeWhen || i.logic?.deprioritizeWhen);
  if (!hasAny) return items;
  const top: T[] = [];
  const mid: T[] = [];
  const bottom: T[] = [];
  items.forEach((i, idx) => {
    const octx = optionCtx(ctx, i, idx, pos);
    if (i.logic?.prioritizeWhen && evaluateCondition(i.logic.prioritizeWhen, octx)) {
      top.push(i);
      if (rec?.byCode[String(i.code)]) rec.byCode[String(i.code)].moved = "top";
    } else if (i.logic?.deprioritizeWhen && evaluateCondition(i.logic.deprioritizeWhen, octx)) {
      bottom.push(i);
      if (rec?.byCode[String(i.code)]) rec.byCode[String(i.code)].moved = "bottom";
    } else {
      mid.push(i);
    }
  });
  const out = [...top, ...mid, ...bottom];
  record(rec, "prioritization", "Prioritization", items, out, new Map());
  return out;
}

/* ----------------------------------------------------------------- sorting */

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "");

function sortItems<T extends { code: string | number; label: string }>(
  order: NonNullable<Question["settings"]["optionOrder"]> | undefined,
  items: T[],
): T[] {
  if (!order || order === "original") return items;
  const byLabel = (a: T, b: T) =>
    stripHtml(a.label).localeCompare(stripHtml(b.label), undefined, { sensitivity: "base" });
  const num = (x: T) => {
    const n = Number(x.code);
    return Number.isFinite(n) ? n : Number(stripHtml(x.label));
  };
  const sorted = [...items];
  switch (order) {
    case "az": sorted.sort(byLabel); break;
    case "za": sorted.sort((a, b) => byLabel(b, a)); break;
    case "numeric_asc": sorted.sort((a, b) => (num(a) || 0) - (num(b) || 0)); break;
    case "numeric_desc": sorted.sort((a, b) => (num(b) || 0) - (num(a) || 0)); break;
  }
  return sorted;
}

/* ----------------------------------------------------------- randomization */

interface ActiveRandomization {
  method: "shuffle" | "rotate" | "reverse_half" | "none";
  pick?: number;
  groups?: (string | number)[][];
}

/** Resolve the randomization config for this respondent: the first
 *  conditional rule that matches overrides the base settings (req §7–8). */
export function activeRandomization(
  r: Randomization | undefined,
  ctx: EvalContext,
): ActiveRandomization | null {
  if (!r?.enabled) return null;
  let cfg: ActiveRandomization = { method: r.method, pick: r.pick, groups: r.groups };
  for (const rule of r.rules ?? []) {
    if (evaluateCondition(rule.when, ctx)) {
      cfg = {
        method: rule.method ?? cfg.method,
        pick: rule.pick ?? cfg.pick,
        groups: rule.groups ?? cfg.groups,
      };
      break;
    }
  }
  return cfg;
}

/** Codes held out of randomization by a `randomizeWhen` that is false. */
function pinnedCodes<T extends ItemWithLogic>(
  items: T[],
  ctx: EvalContext,
  pos: PosFn,
): Set<string> {
  const out = new Set<string>();
  items.forEach((i, idx) => {
    const c = i.logic?.randomizeWhen;
    if (!c) return;
    if (!evaluateCondition(c, optionCtx(ctx, i, idx, pos))) out.add(String(i.code));
  });
  return out;
}

/** "Always Show" options may be shuffled, but never dropped by "show only N". */
function alwaysShowCodes<T extends ItemWithLogic>(items: T[]): Set<string> {
  return new Set(items.filter(isAlwaysShow).map((i) => String(i.code)));
}

const isAnchoredTop = (f?: string[]) => !!f?.includes("anchor_top");
const isAnchoredBottom = (f?: string[]) =>
  !!f?.some((x) => ["anchor_bottom", "none_of_above", "dont_know", "refused"].includes(x));

function randomizeItems<T extends { code: string | number; flags?: string[] }>(
  items: T[],
  cfg: ActiveRandomization,
  seed: number,
  pinned?: Set<string>,
  /** codes that "show only N" may never drop */
  undroppable?: Set<string>,
): T[] {
  const top = items.filter((i) => isAnchoredTop(i.flags));
  const bottom = items.filter((i) => !isAnchoredTop(i.flags) && isAnchoredBottom(i.flags));
  let middle = items.filter((i) => !top.includes(i) && !bottom.includes(i));

  // options pinned by `randomizeWhen` keep their programmed slot: lift them
  // out, shuffle the rest, then slot them back where they started.
  const held: { item: T; at: number }[] = [];
  if (pinned?.size) {
    const kept: T[] = [];
    middle.forEach((i, idx) => {
      if (pinned.has(String(i.code))) held.push({ item: i, at: idx });
      else kept.push(i);
    });
    middle = kept;
  }

  const originalIndex = new Map(middle.map((i, idx) => [i, idx]));

  if (cfg.groups?.length) {
    const shuffled: T[] = [];
    const used = new Set<T>();
    cfg.groups.forEach((group, gi) => {
      const members = middle.filter((i) => group.some((c) => String(c) === String(i.code)));
      members.forEach((m) => used.add(m));
      shuffled.push(...seededShuffle(members, subSeed(seed, `g${gi}`)));
    });
    shuffled.push(...middle.filter((i) => !used.has(i)));
    middle = shuffled;
  } else if (cfg.method === "shuffle") {
    middle = seededShuffle(middle, seed);
  } else if (cfg.method === "rotate") {
    const k = middle.length ? subSeed(seed, "rot") % middle.length : 0;
    middle = [...middle.slice(k), ...middle.slice(0, k)];
  } else if (cfg.method === "reverse_half") {
    if (mulberry32(subSeed(seed, "rh"))() < 0.5) middle = [...middle].reverse();
  }
  // method "none": keep order (pick below may still subset)

  if (cfg.pick != null && cfg.pick >= 0 && cfg.pick < middle.length) {
    // choose a seeded subset; when not shuffling, keep original relative order
    const drawn = seededShuffle(middle, subSeed(seed, "pick")).slice(0, cfg.pick);
    const chosen = undroppable?.size
      ? [...drawn, ...middle.filter((i) => undroppable.has(String(i.code)) && !drawn.includes(i))]
      : drawn;
    middle =
      cfg.method === "none"
        ? [...chosen].sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))
        : middle.filter((i) => chosen.includes(i));
  }

  for (const { item, at } of held) {
    middle.splice(Math.min(at, middle.length), 0, item);
  }

  return [...top, ...middle, ...bottom];
}

/* --------------------------------------------------------------- pipeline */

interface RunOpts {
  /** collect a full stage-by-stage trace for the debugger */
  trace?: boolean;
}

function runOptions(
  q: Question,
  ctx: EvalContext,
  rec: Recorder | null,
): Option[] {
  const seedKey = ctx.loop ? `@${ctx.loop.code}` : "";
  const seed = subSeed(ctx.state.seed, `rand:${q.id}${seedKey}`);

  // 1 — source
  let options: Option[] = [];
  if (q.carryForward && q.carryForward.into === "options") {
    options = carriedOptions(q.carryForward, ctx);
    if (q.carryForward.keepOwn) options = [...options, ...q.options];
  } else {
    options = [...q.options];
  }
  // programmed positions, fixed before anything is filtered
  const pos = makePos(options);

  if (rec) {
    for (const o of options) {
      rec.byCode[String(o.code)] = {
        code: String(o.code),
        label: stripHtml(o.label),
        status: "visible",
        alwaysShow: isAlwaysShow(o),
      };
    }
    rec.stages.push({
      key: "source",
      label: q.carryForward?.into === "options" ? "Source (carry-forward)" : "Source options",
      before: options.map((o) => String(o.code)),
      after: options.map((o) => String(o.code)),
      removed: [],
      changed: false,
    });
  }

  // 2 + 3 — always hidden, then eligibility
  options = applyEligibility(options, ctx, rec, pos);

  // 4 — previous-answer list logic
  options = applyListLogic(q.listLogic ?? [], options, ctx, rec);

  // 5 — reusable list operations
  if (q.optionPipeline?.length) {
    options = applyListOperations(
      q.optionPipeline,
      options,
      ctx,
      rec,
      (code, src) => optionFromSource(src, code),
      seed,
      (order, list) => sortItems(order, list),
      pos,
    );
  }

  // 6 — per-option prioritization
  options = applyPrioritization(options, ctx, rec, pos);

  // 7 — presentation sort
  const beforeSort = options;
  options = sortItems(q.settings.optionOrder, options);
  if (q.settings.optionOrder && q.settings.optionOrder !== "original") {
    record(rec, "sort", `Sort (${q.settings.optionOrder})`, beforeSort, options, new Map());
  }

  // 8 — randomization
  if (q.randomization?.enabled && q.randomization.scope === "options") {
    const cfg = activeRandomization(q.randomization, ctx);
    if (cfg) {
      const beforeRand = options;
      const pinned = pinnedCodes(options, ctx, pos);
      options = randomizeItems(options, cfg, seed, pinned, alwaysShowCodes(options));
      const reasons = new Map<string, string>();
      for (const o of beforeRand) reasons.set(String(o.code), "Not drawn by “show only N”");
      record(rec, "randomization", `Randomization (${cfg.method})`, beforeRand, options, reasons);
      if (rec) for (const c of pinned) if (rec.byCode[c]) rec.byCode[c].pinned = true;
    }
  }

  // 9 — piping inside labels
  options = options.map((o) =>
    o.label.includes("{{") ? { ...o, label: resolvePiping(o.label, ctx) } : o,
  );

  if (rec) {
    options.forEach((o, i) => {
      // options introduced mid-pipeline (union / carry forward) are recorded here
      const st = (rec.byCode[String(o.code)] ??= {
        code: String(o.code),
        label: stripHtml(o.label),
        status: "visible",
        alwaysShow: isAlwaysShow(o),
      });
      st.status = "visible";
      st.stage = undefined;
      st.reason = undefined;
      st.position = i + 1;
      st.label = stripHtml(o.label);
    });
  }
  return options;
}

function runRows(q: Question, ctx: EvalContext): QuestionRow[] {
  const seedKey = ctx.loop ? `@${ctx.loop.code}` : "";
  let rows: QuestionRow[] = [];
  if (q.carryForward && q.carryForward.into === "rows") {
    rows = carriedOptions(q.carryForward, ctx).map((o) => ({
      code: o.code,
      label: o.label,
      flags: [],
      validation: [],
      required: false,
    }));
    if (q.carryForward.keepOwn) rows = [...rows, ...q.rows];
  } else {
    rows = [...q.rows];
  }
  // rows share the option-logic model, minus the list-operation stages
  const pos = makePos(rows);
  rows = applyEligibility(rows, ctx, null, pos);
  rows = applyPrioritization(rows, ctx, null, pos);
  if (q.randomization?.enabled && q.randomization.scope === "rows") {
    const cfg = activeRandomization(q.randomization, ctx);
    if (cfg)
      rows = randomizeItems(
        rows,
        cfg,
        subSeed(ctx.state.seed, `randrows:${q.id}${seedKey}`),
        pinnedCodes(rows, ctx, pos),
        alwaysShowCodes(rows),
      );
  }
  return rows.map((r) =>
    r.label.includes("{{") ? { ...r, label: resolvePiping(r.label, ctx) } : r,
  );
}

export function effectiveQuestion(q: Question, ctx: EvalContext): EffectiveQuestionView {
  const seedKey = ctx.loop ? `@${ctx.loop.code}` : "";
  const options = runOptions(q, ctx, null);
  const rows = runRows(q, ctx);

  // --- columns (composite / matrix)
  let columns = q.columns.filter((c) => evaluateCondition(c.visibleIf, ctx));
  columns = columns.map((c) => {
    let col = c;
    if (c.carryForward) {
      const carried = carriedOptions(c.carryForward, ctx);
      col = { ...c, options: c.carryForward.keepOwn ? [...carried, ...c.options] : carried };
    }
    if (col.options.some((o) => o.visibleIf || o.logic)) {
      col = { ...col, options: applyEligibility(col.options, ctx, null) };
    }
    if (col.label.includes("{{")) col = { ...col, label: resolvePiping(col.label, ctx) };
    return col;
  });
  if (q.randomization?.enabled && q.randomization.scope === "columns") {
    const cfg = activeRandomization(q.randomization, ctx);
    if (cfg) {
      columns = randomizeItems(
        columns.map((c) => ({ ...c, code: c.id })) as any,
        cfg,
        subSeed(ctx.state.seed, `randcols:${q.id}${seedKey}`),
      ) as any;
    }
  }

  return { options, rows, columns };
}

/**
 * Same pipeline, with the reasoning kept: why each option is visible,
 * hidden, moved or pinned, stage by stage (reqs §15, §29).
 */
export function explainOptions(q: Question, ctx: EvalContext): OptionPipelineTrace {
  const rec = newRecorder();
  const final = runOptions(q, ctx, rec);
  return { questionId: q.id, stages: rec.stages, byCode: rec.byCode, final };
}

/**
 * `{{Q1.displayed}}` / `{{Q1.remaining}}` need the pipeline; the pipeline
 * needs piping for labels. Registering here rather than importing keeps the
 * two modules acyclic.
 */
registerDisplayedOptionsResolver((q, ctx) => {
  if (resolving.has(q.id)) return q.options;
  resolving.add(q.id);
  try {
    return runOptions(q, ctx, null);
  } finally {
    resolving.delete(q.id);
  }
});
