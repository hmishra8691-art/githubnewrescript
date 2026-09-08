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
  SurveyDefinition,
} from "@rescript/schema";
import { LIST_OPS_WITH_SOURCES } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition, withOption, withLegacyOptionLoop } from "./evaluate.js";
import { getQuestion, lookupAnswer, loopKeySuffix } from "./state.js";
import { resolvePiping, registerDisplayedOptionsResolver, registerEffectiveRowsResolver } from "./piping.js";
import { evaluateSetExpr, LIST_ACTIONS } from "./setExpression.js";
import { stripHtmlText } from "./html.js";
import { seededShuffle, subSeed, mulberry32 } from "./random.js";
import { hasDisplayRulesFor, ruleVerdict, visibleByRules } from "./displayRules.js";
import { hasOptionGroups, groupsFor, orderWithGroups } from "./optionGroups.js";
import { activePunchRules } from "./punchChain.js";

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

/**
 * A carried-forward item's stable identity, independent of its display
 * label: which question it came from and which code it had there. Shared
 * shape for both options and rows, since carry-forward can land in either.
 */
export interface ResolvedListItem {
  code: string | number;
  label: string;
  sourceQuestionId?: string;
  sourceCode?: string | number;
}

/* ------------------------------------------------------------ source codes */

type Which = "selected" | "not_selected" | "displayed" | "answered_rows" | "all";

/**
 * Guard against a definition whose option lists reference each other in a
 * loop. `detectLogicCycles` blocks these in Studio; this is the runtime
 * backstop that guarantees evaluation always terminates (req §31).
 */
const resolving = new Set<string>();

/**
 * Same backstop, kept separate, for `authoringQuestionView`'s and
 * `optionFromSource`'s chained-carry-forward recursion: a still-being-edited
 * definition can be cyclic for a moment before `detectLogicCycles` catches
 * it, and this recursion is keyed differently from `resolving` above (by the
 * chain being walked, not by "am I computing this question's displayed
 * list"), so sharing one set would let an unrelated in-flight resolution
 * falsely short-circuit this one.
 */
const resolvingView = new Set<string>();

export function codesFrom(
  sourceQuestionId: string,
  which: Which,
  ctx: EvalContext,
): (string | number)[] {
  const src = getQuestion(ctx.def, sourceQuestionId);
  if (!src) return [];
  const answer = lookupAnswer(ctx.state.answers, src.id, ctx.loop);
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
  const a = lookupAnswer(ctx.state.answers, q.id, ctx.loop);
  if (a === null || a === undefined || a === "") return false;
  if (Array.isArray(a)) return a.length > 0;
  if (typeof a === "object") return Object.keys(a).length > 0;
  return true;
}

function carriedOptions(cf: CarryForward, ctx: EvalContext): Option[] {
  const src = getQuestion(ctx.def, cf.sourceQuestionId);
  if (!src) return [];
  const codes = codesFrom(cf.sourceQuestionId, cf.filter, ctx);
  const pool: Option[] = codes.map((code) => optionFromSource(src, code, ctx.def));
  if (!cf.where) return pool;
  return pool.filter((o) => evaluateCondition(cf.where, withLegacyOptionLoop(ctx, o)));
}

/**
 * Build an Option for a code, borrowing the label from the source question.
 *
 * Recurses through the source's OWN carry-forward chain when the code isn't
 * found in its static lists — the source may itself be carry-forward driven
 * (Q1 -> Q2 -> Q3) — so a multi-hop chain keeps its real label instead of
 * silently degrading to the bare code. Every result is tagged with stable
 * source identity (questionId + code): a carried-forward option or row is
 * never identified by its display label alone, per the requirement that it
 * remain addressable throughout the whole programming stack, not just the
 * respondent-facing renderer.
 */
function optionFromSource(src: Question, code: string | number, def: SurveyDefinition): Option {
  const opt = src.options.find((o) => String(o.code) === String(code));
  if (opt) {
    return { ...opt, sourceQuestionId: opt.sourceQuestionId ?? src.id, sourceCode: opt.sourceCode ?? opt.code };
  }
  const row = src.rows.find((r) => String(r.code) === String(code));
  if (row) {
    return {
      code,
      label: row.label,
      flags: [],
      sourceQuestionId: row.sourceQuestionId ?? src.id,
      sourceCode: row.sourceCode ?? row.code,
    };
  }
  if (src.carryForward) {
    /*
     * `authoringQuestionView` guards its OWN recursion (by `src.id`,
     * internally) — this call must NOT also pre-mark `src.id` in the same
     * `resolvingView` set first, or the very first, perfectly ordinary call
     * here would see its own id "already resolving" and bail out with an
     * empty view before ever resolving anything.
     */
    const view = authoringQuestionView(src, def);
    const viaOpt = view.options.find((o) => String(o.code) === String(code));
    if (viaOpt) {
      return {
        ...viaOpt,
        sourceQuestionId: viaOpt.sourceQuestionId ?? src.id,
        sourceCode: viaOpt.sourceCode ?? viaOpt.code,
      };
    }
    const viaRow = view.rows.find((r) => String(r.code) === String(code));
    if (viaRow) {
      return {
        code,
        label: viaRow.label,
        flags: [],
        sourceQuestionId: viaRow.sourceQuestionId ?? src.id,
        sourceCode: viaRow.sourceCode ?? viaRow.code,
      };
    }
  }
  return { code, label: String(code), flags: [] };
}

/**
 * The authoring-time view of a question's rows / options: what a programmer
 * building downstream logic should see for a carry-forward question, so a
 * carried-forward item is a selectable, addressable citizen of the Condition
 * Builder, Count Editor, and every other design-time list — not only the
 * respondent-facing renderer (req: dynamic options must behave like
 * first-class options throughout the complete programming stack).
 *
 * Preference order:
 *   1. The REAL, live pipeline (`effectiveQuestion`) when `ctx` carries an
 *      answer that actually produces items — the genuine carried set.
 *   2. Otherwise (no ctx, or no answer yet — the normal state while
 *      programming), the SOURCE question's own resolved list, recursively —
 *      so a multi-hop chain (Q1 -> Q2 -> Q3) shows real labels and stable
 *      source identity instead of an empty list or bare codes.
 *
 * A question with no carry-forward, or one carrying into columns (which are
 * addressed by id/label and have their own independent per-column
 * `carryForward`), is returned unchanged.
 */
export function authoringQuestionView(
  q: Question,
  def: SurveyDefinition,
  ctx?: EvalContext,
): Question {
  const cf = q.carryForward;
  if (!cf || cf.into === "columns") return q;

  if (ctx) {
    let live: EffectiveQuestionView;
    try {
      live = effectiveQuestion(q, ctx);
    } catch {
      live = { options: [], rows: [], columns: q.columns };
    }
    if (cf.into === "rows" && live.rows.length) return { ...q, rows: live.rows };
    if (cf.into === "options" && live.options.length) return { ...q, options: live.options };
  }

  const src = getQuestion(def, cf.sourceQuestionId);
  if (!src || resolvingView.has(q.id)) return q;
  resolvingView.add(q.id);
  let srcView: Question;
  try {
    srcView = authoringQuestionView(src, def, ctx);
  } finally {
    resolvingView.delete(q.id);
  }
  const pool: ResolvedListItem[] = srcView.options.length ? srcView.options : srcView.rows;
  const tag = (i: ResolvedListItem): ResolvedListItem => ({
    code: i.code,
    label: i.label,
    sourceQuestionId: i.sourceQuestionId ?? src.id,
    sourceCode: i.sourceCode ?? i.code,
  });

  if (cf.into === "rows") {
    const rows: QuestionRow[] = pool.map((i) => ({ ...tag(i), flags: [], validation: [], required: false }));
    return { ...q, rows: cf.keepOwn ? [...rows, ...q.rows] : rows };
  }
  const options: Option[] = pool.map((i) => ({ ...tag(i), flags: [] }));
  return { ...q, options: cf.keepOwn ? [...options, ...q.options] : options };
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
  /** stable carry-forward identity (never just the display label), when this item was carried */
  sourceQuestionId?: string;
  sourceCode?: string | number;
}

export interface OptionPipelineTrace {
  questionId: string;
  stages: PipelineStageTrace[];
  byCode: Record<string, OptionStatusTrace>;
  final: Option[];
  /** the same trace, run for the question's ROWS — present whenever it has any */
  rowStages?: PipelineStageTrace[];
  rowByCode?: Record<string, OptionStatusTrace>;
  finalRows?: QuestionRow[];
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
    const o = optionFromSource(src, c, ctx.def);
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

/* ------------------------------------------------- named survey-level rules */

/**
 * The survey's named display rules, for the items inside a question (§6).
 *
 * Placed immediately after eligibility rather than at the end of the pipeline,
 * because a named rule is the same KIND of statement as `visibleIf` — "this
 * option is for these respondents" — and belongs where the other statements of
 * that kind are resolved. The consequence is deliberate: a later union or
 * carry-forward stage can reintroduce a code this stage removed, exactly as it
 * can one that eligibility removed. If that ever surprises anybody, the
 * pipeline trace names the stage that took it out and the stage that put it
 * back, which is the answer they actually need.
 *
 * A pinned option (`always_show`) survives a SHOW rule that does not hold and
 * is still removed by a HIDE rule that does — see `ruleVerdict`.
 */
function applyNamedRules<T extends ItemWithLogic>(
  q: Question,
  kind: "option" | "row",
  items: T[],
  ctx: EvalContext,
  rec: Recorder | null,
): T[] {
  if (!hasDisplayRulesFor(ctx.def, kind)) return items;
  const reasons = new Map<string, string>();
  const kept = items.filter((i) => {
    const v = ruleVerdict(ctx.def, kind, q.id, ctx, i.code);
    if (v.visible) return true;
    if (v.by === "show" && isAlwaysShow(i)) return true;
    reasons.set(
      String(i.code),
      v.by === "hide" ? "A named display rule hides it" : "A named display rule's SHOW condition is false",
    );
    return false;
  });
  record(rec, "named_rules", "Named display rules", items, kept, reasons);
  return kept;
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

const stripHtml = (s: string) => stripHtmlText(s);

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

/**
 * Stage 4b — the mask (reqs §1–§13, §29–§30).
 *
 * The set expression is evaluated against the current answers, and the result
 * is applied according to the mask's action. Two rules make it safe to use:
 *
 *   • options that are flagged Always Show, or that are special ("Other",
 *     "None of the above", "Don't know", "Prefer not to say"), survive a mask
 *     that returns nothing. Without that, a respondent can be shown a question
 *     with no answerable option at all — which is how a survey dead-ends.
 *   • the mask never invents options. It selects from the list this question
 *     already has, so an answer can never hold a code the question does not
 *     define, and every export stays readable.
 */
function applyMask<T extends ItemWithLogic & { flags?: string[]; code: string | number }>(
  q: Question,
  items: T[],
  ctx: EvalContext,
  rec: Recorder | null,
): T[] {
  const mask = q.mask;
  if (!mask) return items;
  if (mask.when && !evaluateCondition(mask.when, ctx)) return items;

  const before = items;
  const selected = new Set(
    evaluateSetExpr(mask.expr, ctx, { target: q }).map((c: string | number) => String(c)),
  );

  /** Kept whatever the mask says: explicit Always Show, or a special option. */
  const protectedItem = (i: T) =>
    mask.keepAlwaysShow &&
    (isAlwaysShow(i) ||
      !!i.flags?.some((f) =>
        ["other_specify", "none_of_above", "dont_know", "refused"].includes(f)));

  let out = items;
  switch (mask.action) {
    case "display":
    case "display_and_preselect":
      out = items.filter((i) => selected.has(String(i.code)) || protectedItem(i));
      break;
    case "remove":
      out = items.filter((i) => !selected.has(String(i.code)) || protectedItem(i));
      break;
    case "preselect":
    case "disable":
      // the list is untouched; the runtime reads the set for ticking/disabling
      out = items;
      break;
  }

  record(
    rec,
    "mask",
    mask.action === "remove" ? "Mask (remove)" : "Mask",
    before,
    out,
    new Map(
      before
        .filter((i) => !out.includes(i))
        .map((i) => [String(i.code), "removed by the mask"]),
    ),
  );
  return out;
}

/**
 * SHOW / HIDE / ENABLE / DISABLE from this question's punch rules, evaluated
 * with the same condition evaluator as everything else. HIDE removes; SHOW
 * puts a programmed option back even when an earlier stage dropped it (the
 * programmer asked for it by name); DISABLE / ENABLE set `meta.disabled`,
 * which every choice renderer honours — the option is on screen, greyed and
 * unpickable, and a disabled option that was ticked stays ticked (this stage
 * never writes answers).
 */
function applyListPunches(
  q: Question,
  items: Option[],
  ctx: EvalContext,
  rec: Recorder | null,
): Option[] {
  const hide = new Set<string>();
  const show = new Set<string>();
  const disable = new Set<string>();
  const enable = new Set<string>();
  /*
   * The LIST-side chain (§8, §23), over the list actions only — the answer
   * side chains separately in `setExpression.ts`. Two lists, two chains: a
   * `hide` rule must not satisfy an `else` that a `select` rule was waiting
   * for, and the two are not even evaluated at the same point in the run.
   */
  const listRules = (q.punches ?? []).filter((r) => LIST_ACTIONS.has(r.action));
  for (const rule of activePunchRules(listRules, (r) => evaluateCondition(r.when, ctx))) {
    const codes = evaluateSetExpr(rule.source, ctx, { target: q });
    const map = new Map(rule.mapping.map((m) => [String(m.from), m.to]));
    const bucket = { hide, show, disable, enable }[rule.action as "hide" | "show" | "disable" | "enable"];
    for (const c of codes) bucket.add(String(map.has(String(c)) ? map.get(String(c))! : c));
  }
  if (!hide.size && !show.size && !disable.size && !enable.size) return items;

  const before = items;
  const reasons = new Map<string, string>();
  let out = items.filter((o) => {
    if (hide.has(String(o.code)) && !show.has(String(o.code))) {
      reasons.set(String(o.code), "hidden by an auto punch rule");
      return false;
    }
    return true;
  });
  // SHOW restores a programmed option an earlier stage removed, in its programmed slot
  const present = new Set(out.map((o) => String(o.code)));
  const restored = q.options.filter((o) => show.has(String(o.code)) && !present.has(String(o.code)));
  if (restored.length) {
    const order = new Map(q.options.map((o, i) => [String(o.code), i]));
    out = [...out, ...restored].sort(
      (a, b) => (order.get(String(a.code)) ?? 1e9) - (order.get(String(b.code)) ?? 1e9),
    );
  }
  if (disable.size || enable.size) {
    out = out.map((o) => {
      const k = String(o.code);
      if (enable.has(k)) return o.meta?.disabled ? { ...o, meta: { ...o.meta, disabled: false } } : o;
      if (disable.has(k)) return { ...o, meta: { ...(o.meta ?? {}), disabled: true } };
      return o;
    });
  }
  record(rec, "autoPunch", "Auto punch (show / hide / enable / disable)", before, out, reasons);
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


/**
 * GROUPED ORDERING, sharing the anchor handling with flat randomization.
 *
 * Anchors are lifted out first and put back after, exactly as
 * `randomizeItems` does, because "anchor to the top" is a statement about the
 * screen and not about a group — an anchored "None of the above" belongs at
 * the bottom of the question, not at the bottom of whichever group happens to
 * hold it.
 */
function groupOrder<T extends { code: string | number; label?: string; flags?: string[] }>(
  q: Question,
  scope: "options" | "rows" | "columns",
  items: T[],
  ctx: EvalContext,
  seed: number,
): T[] {
  const top = items.filter((i) => isAnchoredTop(i.flags));
  const bottom = items.filter((i) => !isAnchoredTop(i.flags) && isAnchoredBottom(i.flags));
  const middle = items.filter((i) => !top.includes(i) && !bottom.includes(i));

  const ordering = {
    groupOrder: q.groupOrdering?.groupOrder ?? "fixed",
    itemOrder: q.groupOrdering?.itemOrder ?? "fixed",
    ungrouped: q.groupOrdering?.ungrouped ?? "last",
  } as const;

  const { items: placed } = orderWithGroups(middle, groupsFor(q, scope), ordering, seed, ctx);
  return [...top, ...placed, ...bottom];
}

/* --------------------------------------------------------------- pipeline */

interface RunOpts {
  /** collect a full stage-by-stage trace for the debugger */
  trace?: boolean;
}

/**
 * Stage 1 of the option pipeline, exposed on its own: the question's options
 * exactly as carry-forward produces them (or its static list, unchanged, for
 * an ordinary question) — BEFORE eligibility, masking, list operations,
 * prioritisation, sorting or randomisation run.
 *
 * This is the carry-forward analogue of a plain question's static `options`
 * array, and matters because some consumers (COUNT's "eligible" / "visible" /
 * "hidden", and the pool it counts "selected" / "valid" / "matching" against)
 * need the full configured universe to compare against the pipeline's final
 * output — not the final output itself, which for a carry-forward question
 * `effectiveQuestion` already applied every later stage to.
 */
export function carrySourceOptions(q: Question, ctx: EvalContext): Option[] {
  if (!q.carryForward || q.carryForward.into !== "options") return q.options;
  const carried = carriedOptions(q.carryForward, ctx);
  return q.carryForward.keepOwn ? [...carried, ...q.options] : carried;
}

/** Stage 1 of the row pipeline — see `carrySourceOptions`. */
export function carrySourceRows(q: Question, ctx: EvalContext): QuestionRow[] {
  if (!q.carryForward || q.carryForward.into !== "rows") return q.rows;
  const rows: QuestionRow[] = carriedOptions(q.carryForward, ctx).map((o) => ({
    code: o.code,
    label: o.label,
    flags: [],
    validation: [],
    required: false,
    sourceQuestionId: o.sourceQuestionId,
    sourceCode: o.sourceCode,
  }));
  return q.carryForward.keepOwn ? [...rows, ...q.rows] : rows;
}

function runOptions(
  q: Question,
  ctx: EvalContext,
  rec: Recorder | null,
): Option[] {
  const seedKey = loopKeySuffix(ctx.loop);
  const seed = subSeed(ctx.state.seed, `rand:${q.id}${seedKey}`);

  // 1 — source
  let options: Option[] = carrySourceOptions(q, ctx);
  // programmed positions, fixed before anything is filtered
  const pos = makePos(options);

  if (rec) {
    for (const o of options) {
      rec.byCode[String(o.code)] = {
        code: String(o.code),
        label: stripHtml(o.label),
        status: "visible",
        alwaysShow: isAlwaysShow(o),
        sourceQuestionId: o.sourceQuestionId,
        sourceCode: o.sourceCode,
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

  // 3b — the survey's named display rules for this question's options (§6)
  options = applyNamedRules(q, "option", options, ctx, rec);

  // 4 — previous-answer list logic
  options = applyListLogic(q.listLogic ?? [], options, ctx, rec);

  // 4b — the mask: a nested set expression over other questions' answers
  if (q.mask) {
    options = applyMask(q, options, ctx, rec);
  }

  // 4c — option-level auto punch rules that act on the LIST: SHOW / HIDE /
  //      ENABLE / DISABLE (autoPunch.ts). SELECT & co. act on the answer and
  //      are the flow interpreter's business, not the list's.
  if (q.punches?.some((r) => LIST_ACTIONS.has(r.action))) {
    options = applyListPunches(q, options, ctx, rec);
  }

  // 5 — reusable list operations
  if (q.optionPipeline?.length) {
    options = applyListOperations(
      q.optionPipeline,
      options,
      ctx,
      rec,
      (code, src) => optionFromSource(src, code, ctx.def),
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

  /*
   * 8 — ORDERING: groups first, flat randomization only when there are none.
   *
   * Groups take precedence deliberately, and `lintOptionGroups` says so on
   * screen when both are configured. A flat shuffle over a grouped list would
   * move a member out of its group, which is the one thing groups exist to
   * prevent — so the two cannot both apply, and the safe one wins.
   *
   * Grouping runs whether or not `randomization.enabled` is set, because the
   * group structure IS the presented order: "Group A then Group B" is what a
   * programmer asked for even with every order set to Fixed.
   */
  if (hasOptionGroups(q, "options")) {
    const beforeGroups = options;
    options = groupOrder(q, "options", options, ctx, seed);
    record(rec, "randomization", "Option groups", beforeGroups, options, new Map());
  } else if (q.randomization?.enabled && q.randomization.scope === "options") {
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

  // 9 — piping inside labels AND option images
  //
  // The image is as personal as the words beside it: "show each respondent
  // the pack shot for the brand they named" is an ordinary requirement, and
  // until the URL was piped there was no way to express it.
  options = options.map((o) => {
    let next = o;
    if (o.label.includes("{{")) next = { ...next, label: resolvePiping(o.label, ctx) };
    if (o.imageUrl?.includes("{{")) next = { ...next, imageUrl: resolvePiping(o.imageUrl, ctx) };
    return next;
  });

  if (rec) {
    options.forEach((o, i) => {
      // options introduced mid-pipeline (union / carry forward) are recorded here
      const st = (rec.byCode[String(o.code)] ??= {
        code: String(o.code),
        label: stripHtml(o.label),
        status: "visible",
        alwaysShow: isAlwaysShow(o),
        sourceQuestionId: o.sourceQuestionId,
        sourceCode: o.sourceCode,
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

function runRows(q: Question, ctx: EvalContext, rec: Recorder | null): QuestionRow[] {
  const seedKey = loopKeySuffix(ctx.loop);
  let rows: QuestionRow[] = carrySourceRows(q, ctx);

  if (rec) {
    for (const r of rows) {
      rec.byCode[String(r.code)] = {
        code: String(r.code),
        label: stripHtml(r.label),
        status: "visible",
        alwaysShow: isAlwaysShow(r),
        sourceQuestionId: r.sourceQuestionId,
        sourceCode: r.sourceCode,
      };
    }
    rec.stages.push({
      key: "source",
      label: q.carryForward?.into === "rows" ? "Source (carry-forward)" : "Source rows",
      before: rows.map((r) => String(r.code)),
      after: rows.map((r) => String(r.code)),
      removed: [],
      changed: false,
    });
  }

  // rows share the option-logic model, minus the list-operation stages
  const pos = makePos(rows);
  rows = applyEligibility(rows, ctx, rec, pos);
  rows = applyNamedRules(q, "row", rows, ctx, rec);
  rows = applyPrioritization(rows, ctx, rec, pos);
  if (hasOptionGroups(q, "rows")) {
    const beforeGroups = rows;
    rows = groupOrder(q, "rows", rows, ctx, subSeed(ctx.state.seed, `randrows:${q.id}${seedKey}`));
    record(rec, "randomization", "Row groups", beforeGroups, rows, new Map());
  } else if (q.randomization?.enabled && q.randomization.scope === "rows") {
    const cfg = activeRandomization(q.randomization, ctx);
    if (cfg) {
      const beforeRand = rows;
      const pinned = pinnedCodes(rows, ctx, pos);
      rows = randomizeItems(
        rows,
        cfg,
        subSeed(ctx.state.seed, `randrows:${q.id}${seedKey}`),
        pinned,
        alwaysShowCodes(rows),
      );
      const reasons = new Map<string, string>();
      for (const r of beforeRand) reasons.set(String(r.code), "Not drawn by “show only N”");
      record(rec, "randomization", `Randomization (${cfg.method})`, beforeRand, rows, reasons);
      if (rec) for (const c of pinned) if (rec.byCode[c]) rec.byCode[c].pinned = true;
    }
  }
  rows = rows.map((r) =>
    r.label.includes("{{") ? { ...r, label: resolvePiping(r.label, ctx) } : r,
  );

  if (rec) {
    rows.forEach((r, i) => {
      const st = (rec.byCode[String(r.code)] ??= {
        code: String(r.code),
        label: stripHtml(r.label),
        status: "visible",
        alwaysShow: isAlwaysShow(r),
        sourceQuestionId: r.sourceQuestionId,
        sourceCode: r.sourceCode,
      });
      st.status = "visible";
      st.stage = undefined;
      st.reason = undefined;
      st.position = i + 1;
      st.label = stripHtml(r.label);
    });
  }
  return rows;
}

/**
 * The question's own media, with piping resolved.
 *
 * Kept beside `effectiveQuestion` because it answers the same kind of
 * question — "what does this respondent actually get?" — and because the
 * renderer reads `q.settings` directly for the stimulus, so there is nowhere
 * else that every caller already passes through.
 */
export function resolveQuestionMedia(
  q: Question,
  ctx: EvalContext,
): { imageUrl?: string; mediaUrl?: string } {
  const pipe = (u?: string) => (u && u.includes("{{") ? resolvePiping(u, ctx) : u);
  return { imageUrl: pipe(q.settings.imageUrl), mediaUrl: pipe(q.settings.mediaUrl) };
}

export function effectiveQuestion(q: Question, ctx: EvalContext): EffectiveQuestionView {
  const seedKey = loopKeySuffix(ctx.loop);
  const options = runOptions(q, ctx, null);
  const rows = runRows(q, ctx, null);

  // --- columns (composite / matrix)
  let columns = q.columns.filter((c) => evaluateCondition(c.visibleIf, ctx));
  /*
   * A column is addressed by its `id`, not a code — the schema says so
   * (`subRef: option code / row code / column id`) and a composite question's
   * columns have no codes to address. There is no pinning for columns, so
   * unlike options and rows the verdict is a plain boolean.
   */
  if (hasDisplayRulesFor(ctx.def, "column")) {
    columns = columns.filter((c) => visibleByRules(ctx.def, "column", q.id, ctx, c.id));
  }
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
  if (hasOptionGroups(q, "columns")) {
    /* columns are addressed by id, so they are normalised to `code` the same
       way the flat path does it below */
    columns = groupOrder(
      q, "columns",
      columns.map((c) => ({ ...c, code: c.id })) as never,
      ctx,
      subSeed(ctx.state.seed, `randcols:${q.id}${seedKey}`),
    ) as never;
  } else if (q.randomization?.enabled && q.randomization.scope === "columns") {
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
  /*
   * Rows get their own recorder, not the options one: a row and an option
   * can share a code, and a single `stages`/`byCode` would either collide on
   * that code or interleave two unrelated pipelines into one trace. Only
   * built (and only shown by a caller) when the question actually has rows
   * to trace — a plain choice question's trace is unchanged.
   */
  const rowRec = q.rows.length || q.carryForward?.into === "rows" ? newRecorder() : null;
  const finalRows = rowRec ? runRows(q, ctx, rowRec) : undefined;
  return {
    questionId: q.id,
    stages: rec.stages,
    byCode: rec.byCode,
    final,
    ...(rowRec ? { rowStages: rowRec.stages, rowByCode: rowRec.byCode, finalRows } : {}),
  };
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

/**
 * FIRST / LAST / Nth row & option addressing (`evaluate.ts`) needs the
 * effective, carry-forward resolved list; registering here rather than
 * importing keeps the two modules acyclic (same reasoning as the piping
 * resolver just above).
 */
registerEffectiveRowsResolver((q, ctx) => {
  const view = effectiveQuestion(q, ctx);
  return { rows: view.rows, options: view.options };
});
