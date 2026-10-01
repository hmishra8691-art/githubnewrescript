import type { Condition, ConditionRule, Question, SurveyDefinition } from "@rescript/schema";
import { isQuestionValueRef } from "@rescript/schema";
import { getQuestionByCodeOrVar } from "./state.js";
import { mapRules, mapConditionRoots } from "./conditionWalk.js";
import { gridAxes } from "./gridAxes.js";
import { PIPE_TOKEN_RE, parsePipeBody, serializePipeToken } from "./pipingTokens.js";

/**
 * Option / row code re-sequencing, with every reference rewritten.
 *
 * Codes are the platform's join key: conditions compare against them,
 * randomization groups list them, quota cells test them, piping addresses
 * matrix rows by them, the variable dictionary names columns after them and
 * stored responses are keyed by them. Re-indexing a list on delete — the
 * obvious fix for "1, 2, 4, 5" — silently repoints all of that at the wrong
 * data unless the references move too.
 *
 * So renumbering is one atomic operation over the whole definition, and it
 * reports what it touched. The one thing it cannot rewrite is data already
 * collected, which is why the caller must refuse to run it once a survey has
 * live responses.
 */

export interface RenumberResult {
  def: SurveyDefinition;
  /** old code → new code, only for codes that actually moved */
  mapping: Record<string, string>;
  /** how many references were repointed */
  referencesUpdated: number;
  /**
   * R9 — WHAT THIS DELIBERATELY DID NOT REWRITE, AND WHO HAS TO LOOK AT IT.
   *
   * A calculation's `expression` is free text: `IF(Q7 == 3, 1, 0)`, but also
   * `AGE / 3` and `SUM(Q9_1..Q9_5) > 3`. The 3s are indistinguishable to
   * anything short of a parser that knows which operand is a code and which
   * is arithmetic, and a regex that rewrote all of them would corrupt every
   * expression that happened to contain the renumbered number.
   *
   * Silently skipping them is what this used to do. Rewriting them blindly
   * would be worse. So they are REPORTED: the caller shows the programmer
   * exactly which expressions mention the question whose codes moved, and
   * they check those by eye. One honest sentence beats a silent guess in
   * both directions.
   */
  needsReview: { kind: "calculation"; id: string; label: string; expression: string }[];
}

export type CodeScope = "options" | "rows";

/** The 1..N mapping a list would have if it were re-sequenced. */
export function sequentialCodeMap(
  items: { code: string | number }[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  items.forEach((item, i) => {
    const from = String(item.code);
    const to = String(i + 1);
    if (from !== to) mapping[from] = to;
  });
  return mapping;
}

/**
 * Are these codes safe to re-sequence? Purely-numeric lists are; a list using
 * meaningful codes (`apple`, `NPS_9`, `98`, `99`) is not — renumbering those
 * would destroy information the programmer put there deliberately.
 */
export function codesAreSequenceable(items: { code: string | number }[]): boolean {
  return items.every((i) => /^\d+$/.test(String(i.code)));
}

/* ------------------------------------------------------------- conditions */

interface Ctx {
  def: SurveyDefinition;
  targetId: string;
  scope: CodeScope;
  mapping: Record<string, string>;
  count: number;
}

const mapOne = (v: unknown, ctx: Ctx): unknown => {
  const k = String(v);
  if (!(k in ctx.mapping)) return v;
  ctx.count++;
  // keep the original JS type: a numeric code stays a number
  return typeof v === "number" ? Number(ctx.mapping[k]) : ctx.mapping[k];
};

/**
 * One condition tree, with every reference to the renumbered codes moved.
 *
 * Walks groups of any depth AND every COUNT `where` (mapRules), and knows the
 * four places a code can sit in a rule:
 *
 *   · the VALUE of a rule on the question (`Q7 = 3`, `Q7 in [1, 4]`) — options;
 *   · the ROW it addresses (`Q7.R2 > 3`) — rows, and the row named on the
 *     RIGHT-HAND side of a cross-question comparison (`Q5 > Q7.R2`);
 *   · the SCALE POINT a Likert grid's `columnId` holds ("any row rated 5") —
 *     options, because a per-row grid's columns ARE its option codes;
 *   · a COUNT's subset (`only [1, 3]`, `answering [4, 5]`) and the `@option`
 *     comparisons inside its `where`, which name the counted question's own
 *     items.
 *
 * A count's threshold (`COUNT(Q7) >= 2`) is a NUMBER, not a code, and is
 * never rewritten — remapping it was how a "2 or more" became a "20 or more".
 */
function rewriteCondition(c: Condition | undefined, ctx: Ctx): Condition | undefined {
  if (!c) return c;
  return mapRules(c, (rule, at) => rewriteRule(rule, ctx, at.inCountWhere ? at.countOwner : undefined));
}

const isTargetRef = (ref: string | undefined, ctx: Ctx): boolean =>
  !!ref && getQuestionByCodeOrVar(ctx.def, ref)?.id === ctx.targetId;

function rewriteRule(c: ConditionRule, ctx: Ctx, countOwner?: ConditionRule): ConditionRule {
  let out = c;
  /* the right-hand side: a row of the renumbered question named in a cross-question comparison */
  if (ctx.scope === "rows") {
    const fixRef = (v: unknown): unknown => {
      if (!isQuestionValueRef(v) || !isTargetRef(v.$question, ctx) || v.rowCode == null || !(String(v.rowCode) in ctx.mapping)) return v;
      ctx.count++;
      return { ...v, rowCode: ctx.mapping[String(v.rowCode)] };
    };
    const value = Array.isArray(out.value) ? out.value.map(fixRef) : fixRef(out.value);
    if (value !== out.value) out = { ...out, value };
  }

  /* `@option` inside a COUNT's where: the counted question's own items */
  if (countOwner && isTargetRef(countOwner.source.ref, ctx) && out.source.kind === "option" && (out.source.ref ?? "code") === "code") {
    const counted = countOwner.source.count!.scope === "rows" ? "rows" : "options";
    if (counted === ctx.scope) out = rewriteValues(out, ctx);
    return out;
  }

  const src = out.source.kind === "question" || out.source.kind === "variable"
    ? getQuestionByCodeOrVar(ctx.def, out.source.ref)
    : undefined;
  if (src?.id !== ctx.targetId) return out;

  const spec = out.source.count;
  if (spec) {
    /* a count: its subset lists name items; its threshold is a number and stays */
    const next = { ...spec };
    let moved = false;
    const remap = (xs: (string | number)[] | undefined) => xs?.map((x) => { const y = mapOne(x, ctx) as string | number; if (y !== x) moved = true; return y; });
    if ((spec.scope === "rows") === (ctx.scope === "rows") && spec.scope !== "columns") next.only = remap(spec.only);
    // a per-row grid's answers are its option codes: `answering [4, 5]` moves with the options
    if (ctx.scope === "options" && spec.responseIn) next.responseIn = remap(spec.responseIn);
    return moved ? { ...out, source: { ...out.source, count: next } } : out;
  }

  if (ctx.scope === "rows") {
    if (out.source.rowCode != null && String(out.source.rowCode) in ctx.mapping) {
      ctx.count++;
      out = { ...out, source: { ...out.source, rowCode: ctx.mapping[String(out.source.rowCode)] } };
    }
    return out;
  }
  /* options: a Likert grid's columnId IS an option code ("any row rated 5") */
  if (out.source.columnId != null && gridAxes(src).columnMeaning === "option_code" && String(out.source.columnId) in ctx.mapping) {
    ctx.count++;
    out = { ...out, source: { ...out.source, columnId: ctx.mapping[String(out.source.columnId)] } };
  }
  /* a constant sum addresses its options as rows */
  if (out.source.rowCode != null && src.type === "allocation" && String(out.source.rowCode) in ctx.mapping) {
    ctx.count++;
    out = { ...out, source: { ...out.source, rowCode: ctx.mapping[String(out.source.rowCode)] } };
    return out;
  }
  if (src.type === "allocation") return out;
  return rewriteValues(out, ctx);
}

/** the comparison value(s) of a rule, as codes of the renumbered dimension */
function rewriteValues(out: ConditionRule, ctx: Ctx): ConditionRule {
  if (Array.isArray(out.value)) {
    out = { ...out, value: out.value.map((v) => (typeof v === "object" && v !== null ? v : mapOne(v, ctx))) };
  } else if (out.value !== undefined && out.value !== null && typeof out.value !== "object") {
    out = { ...out, value: mapOne(out.value, ctx) };
  }
  // ranking operators keep a RANK in value2, which is a number, not a code
  if (out.value2 !== undefined && out.value2 !== null && typeof out.value2 !== "object" && !String(out.operator).startsWith("rank")) {
    out = { ...out, value2: mapOne(out.value2, ctx) };
  }
  return out;
}

/* ----------------------------------------------------------------- piping */

/** `{{Q1[r2].label}}` — the row code inside a pipe is a reference too. */
function rewritePiping(text: string | undefined, ctx: Ctx): string | undefined {
  if (!text || !text.includes("{{") || ctx.scope !== "rows") return text;
  return text.replace(PIPE_TOKEN_RE, (m, body: string) => {
    const t = parsePipeBody(body, m);
    if (!t || t.kind !== "question" || !t.rowCode) return m;
    const src = getQuestionByCodeOrVar(ctx.def, t.ref);
    if (src?.id !== ctx.targetId) return m;
    const next = ctx.mapping[String(t.rowCode)];
    if (!next) return m;
    ctx.count++;
    return serializePipeToken({ ...t, rowCode: next });
  });
}

/* --------------------------------------------------------------- question */

/* --------------------------------------------------- set expressions (R9) */

/**
 * R9 — MASKS, PUNCHES, OPTION GROUPS AND ATTENTION CHECKS HOLD RAW CODES.
 *
 * Everything above rewrites CONDITIONS, and for a long time that was taken to
 * be the whole job. It is not. Four other structures store bare code lists
 * with no condition wrapper anywhere near them, and `grep -c` for any of them
 * in this file returned zero:
 *
 *   · `optionGroups[].members`  — which options move together when shuffled
 *   · `mask` / `rowMask` / `columnMask` — a set expression, whose `codes`
 *     nodes are literal option codes
 *   · `punches[]` — a source expression, a from→to mapping, a target row
 *   · `attentionCheck.expected` — the codes that count as passing
 *
 * A mask reading `codes: [4, 5]` after a resequence shows two entirely
 * different options, and nothing anywhere reports it: the survey still
 * renders, the mask still resolves, and the wrong two options appear. An
 * attention check whose `expected` moved now fails every honest respondent
 * and passes the ones who were not paying attention.
 */

/** Does this expression read the question being renumbered? */
function exprReadsTarget(e: unknown, targetId: string): boolean {
  if (!e || typeof e !== "object") return false;
  const n = e as Record<string, unknown>;
  if (n.kind === "ref") return n.questionId === targetId;
  if (n.kind === "complement") return exprReadsTarget(n.of, targetId);
  if (n.kind === "op") return exprReadsTarget(n.left, targetId) || exprReadsTarget(n.right, targetId);
  return false;
}

/**
 * Rewrite the literal `codes` nodes of a set expression.
 *
 * `inTargetNamespace` is the caller's answer to the one question this cannot
 * work out for itself: are these literals the renumbered question's codes?
 * For a mask ON the renumbered question they are — the mask filters that
 * question's own options. For a punch they are whichever side reads the
 * renumbered question, which is why the caller checks `exprReadsTarget`
 * first. Guessing either way would be worse than not rewriting: rewriting
 * the wrong literals corrupts a mask that was correct.
 */
function rewriteSetExpr<T>(e: T, ctx: Ctx, inTargetNamespace: boolean): T {
  if (!e || typeof e !== "object") return e;
  const n = e as Record<string, unknown>;
  if (n.kind === "codes") {
    if (!inTargetNamespace) return e;
    const codes = (n.codes as (string | number)[] | undefined) ?? [];
    return { ...n, codes: codes.map((c) => mapOne(c, ctx) as string | number) } as T;
  }
  if (n.kind === "complement") {
    return { ...n, of: rewriteSetExpr(n.of, ctx, inTargetNamespace) } as T;
  }
  if (n.kind === "op") {
    return {
      ...n,
      left: rewriteSetExpr(n.left, ctx, inTargetNamespace),
      right: rewriteSetExpr(n.right, ctx, inTargetNamespace),
    } as T;
  }
  return e;
}

/** A mask, with its expression's literals rewritten when they are the target's. */
function rewriteMask<T>(mask: T | undefined, ctx: Ctx, isTargetDimension: boolean): T | undefined {
  if (!mask || typeof mask !== "object") return mask;
  const m = mask as Record<string, unknown>;
  const before = ctx.count;
  const expr = rewriteSetExpr(m.expr, ctx, isTargetDimension);
  if (ctx.count === before && expr === m.expr) return mask;
  return { ...m, expr } as T;
}

function rewriteQuestion(q: Question, ctx: Ctx): Question {
  /* conditions are rewritten by the one structural pass in renumberQuestionCodes — every field, none twice */
  const cond = (c: Condition | undefined) => c;
  const out: Question = {
    ...q,
    displayLogic: cond(q.displayLogic),
    skipLogic: (q.skipLogic ?? []).map((r) => ({ ...r, when: cond(r.when)! })),
    validation: (q.validation ?? []).map((v) => (v.when ? { ...v, when: cond(v.when) } : v)),
    text: rewritePiping(q.text, ctx) ?? q.text,
    instruction: rewritePiping(q.instruction, ctx),
    description: rewritePiping(q.description, ctx),
  };

  if (q.randomization) {
    out.randomization = {
      ...q.randomization,
      rules: q.randomization.rules?.map((r) => ({ ...r, when: cond(r.when)! })),
    };
    // groups are literal code lists — only meaningful on the question itself
    if (q.id === ctx.targetId && ctx.scope === "options") {
      const mapGroups = (g?: (string | number)[][]) =>
        g?.map((grp) => grp.map((c) => mapOne(c, ctx) as string | number));
      out.randomization.groups = mapGroups(q.randomization.groups);
      out.randomization.rules = out.randomization.rules?.map((r) => ({
        ...r,
        groups: mapGroups(r.groups),
      }));
    }
  }
  if (q.carryForward?.where) {
    out.carryForward = { ...q.carryForward, where: cond(q.carryForward.where) };
  }
  /* "rows where these SCALE points were chosen" names the source grid's option codes */
  if (q.carryForward?.columns?.length && q.carryForward.sourceQuestionId === ctx.targetId && ctx.scope === "options") {
    out.carryForward = { ...(out.carryForward ?? q.carryForward), columns: q.carryForward.columns.map((c) => mapOne(c, ctx) as string | number) };
  }
  out.listLogic = (q.listLogic ?? []).map((r) => (r.when ? { ...r, when: cond(r.when) } : r));
  out.optionPipeline = (q.optionPipeline ?? []).map((op) => ({
    ...op,
    when: cond(op.when),
    where: cond(op.where),
  }));

  const rewriteItemLogic = <T extends { visibleIf?: Condition; logic?: any; label: string }>(item: T): T => {
    const l = item.logic;
    return {
      ...item,
      visibleIf: cond(item.visibleIf),
      label: rewritePiping(item.label, ctx) ?? item.label,
      logic: l
        ? {
            ...l,
            when: cond(l.when),
            eligibleWhen: cond(l.eligibleWhen),
            excludeWhen: cond(l.excludeWhen),
            prioritizeWhen: cond(l.prioritizeWhen),
            deprioritizeWhen: cond(l.deprioritizeWhen),
            randomizeWhen: cond(l.randomizeWhen),
          }
        : l,
    };
  };

  out.options = (q.options ?? []).map(rewriteItemLogic);
  out.rows = (q.rows ?? []).map((r) => ({
    ...rewriteItemLogic(r),
    validation: (r.validation ?? []).map((v) => (v.when ? { ...v, when: cond(v.when) } : v)),
  }));
  out.columns = (q.columns ?? []).map((c) => ({
    ...c,
    visibleIf: cond(c.visibleIf),
    options: (c.options ?? []).map(rewriteItemLogic),
    validation: (c.validation ?? []).map((v) => (v.when ? { ...v, when: cond(v.when) } : v)),
    carryForward: c.carryForward?.where
      ? { ...c.carryForward, where: cond(c.carryForward.where) }
      : c.carryForward,
  }));

  /* ------------------------------------------------------------- R9 */

  const isTarget = q.id === ctx.targetId;
  const optionsMoved = isTarget && ctx.scope === "options";
  const rowsMoved = isTarget && ctx.scope === "rows";

  /*
   * OPTION GROUPS. `members` is a bare list of this question's own option
   * codes — "these three shuffle together". After a resequence an unrewritten
   * group holds codes that now belong to different options, so the block that
   * was meant to keep three brands adjacent keeps three unrelated ones
   * adjacent instead, on every interview, silently.
   */
  if (optionsMoved && (q as any).optionGroups?.length) {
    (out as any).optionGroups = (q as any).optionGroups.map((g: any) => ({
      ...g,
      members: (g.members ?? []).map((c: string | number) => mapOne(c, ctx) as string | number),
    }));
  }

  /*
   * MASKS. A mask's literals are the masked question's own codes, so they
   * move with the dimension being renumbered: `mask` with the options,
   * `rowMask` with the rows. `columnMask` is left alone — columns are a
   * third dimension this function does not renumber.
   */
  if (isTarget) {
    const mask = rewriteMask((q as any).mask, ctx, optionsMoved);
    if (mask !== (q as any).mask) (out as any).mask = mask;
    const rowMask = rewriteMask((q as any).rowMask, ctx, rowsMoved);
    if (rowMask !== (q as any).rowMask) (out as any).rowMask = rowMask;
  }

  /*
   * PUNCHES, which have two sides and must not be treated as one.
   *
   * The TARGET side — what the punch writes into this question — moves when
   * this question's codes move: `mapping[].to` with the options,
   * `targetRow` with the rows.
   *
   * The SOURCE side — `source` and `mapping[].from` — is in the namespace of
   * whatever question the punch READS. Those move only when the punch reads
   * the question being renumbered, which `exprReadsTarget` answers from the
   * expression rather than from a guess.
   */
  if ((q as any).punches?.length) {
    (out as any).punches = (q as any).punches.map((p: any) => {
      const readsTarget = exprReadsTarget(p.source, ctx.targetId);
      const sourceInTarget = readsTarget && ctx.scope === "options";
      const next = { ...p, source: rewriteSetExpr(p.source, ctx, sourceInTarget) };
      if (p.mapping?.length) {
        next.mapping = p.mapping.map((m: any) => ({
          ...m,
          from: sourceInTarget ? (mapOne(m.from, ctx) as string | number) : m.from,
          to: optionsMoved ? (mapOne(m.to, ctx) as string | number) : m.to,
        }));
      }
      if (rowsMoved && p.targetRow != null) next.targetRow = mapOne(p.targetRow, ctx) as string | number;
      return next;
    });
  }

  /*
   * ATTENTION CHECKS. `expected` is the set of codes that count as passing —
   * or, for a `trap`, the ones that fail. Either way an unrewritten list
   * after a resequence inverts the check: the respondents who read the
   * instruction are marked as having failed it, and their interviews are
   * removed from the dataset as low quality.
   */
  if (optionsMoved && (q as any).attentionCheck?.expected?.length) {
    (out as any).attentionCheck = {
      ...(q as any).attentionCheck,
      expected: (q as any).attentionCheck.expected.map((c: string | number) => mapOne(c, ctx) as string | number),
    };
  }

  // finally, the codes themselves — only on the question being renumbered
  if (q.id === ctx.targetId) {
    const remap = <T extends { code: string | number }>(items: T[]): T[] =>
      items.map((i) =>
        String(i.code) in ctx.mapping ? { ...i, code: ctx.mapping[String(i.code)] } : i,
      );
    if (ctx.scope === "options") out.options = remap(out.options);
    else out.rows = remap(out.rows);
  }
  return out;
}

/* ------------------------------------------------------------------- flow */

function rewriteFlow(nodes: any[], ctx: Ctx): any[] {
  return (nodes ?? []).map((n) => {
    const out = { ...n };
    if (n.children) out.children = rewriteFlow(n.children, ctx);
    if (n.otherwise) out.otherwise = rewriteFlow(n.otherwise, ctx);
    if (n.branches) {
      out.branches = n.branches.map((b: any) => ({
        ...b,
        children: rewriteFlow(b.children, ctx),
      }));
    }
    return out;
  });
}

/* ------------------------------------------------------------------ entry */

/**
 * Re-sequence one question's option or row codes and repoint every reference
 * to them across the whole definition. Returns a new definition — the input
 * is never mutated.
 */
export function renumberQuestionCodes(
  def: SurveyDefinition,
  questionId: string,
  scope: CodeScope,
  mapping: Record<string, string>,
): RenumberResult {
  if (Object.keys(mapping).length === 0) {
    return { def, mapping, referencesUpdated: 0, needsReview: [] };
  }
  const ctx: Ctx = { def, targetId: questionId, scope, mapping, count: 0 };

  const next: SurveyDefinition = {
    ...def,
    questions: def.questions.map((q) => rewriteQuestion(q, ctx)),
    displayRules: (def.displayRules ?? []).map((r) => ({
      ...r,
      target:
        scope === "rows" && r.target.ref === questionId && r.target.subRef &&
        String(r.target.subRef) in mapping
          ? { ...r.target, subRef: mapping[String(r.target.subRef)] }
          : scope === "options" && r.target.ref === questionId && r.target.subRef &&
            String(r.target.subRef) in mapping
            ? { ...r.target, subRef: mapping[String(r.target.subRef)] }
            : r.target,
    })),
    flow: rewriteFlow(def.flow as any[], ctx) as SurveyDefinition["flow"],
  };

  /*
   * EVERY CONDITION, WHEREVER IT SITS. This used to be a list of fields, and
   * the list missed punch `when`s, mask `when`s, validation checks, flow-node
   * visibility, loop conditions, named expressions, list fills and option
   * groups — all of which kept pointing at whichever option now held the old
   * code. The structural walk finds them all, including ones added later.
   */
  const rewritten = mapConditionRoots(next, (c) => rewriteCondition(c, ctx)!);

  return { def: rewritten, mapping, referencesUpdated: ctx.count, needsReview: reviewable(def, questionId) };
}

/**
 * Calculations whose expression names the question being renumbered.
 *
 * Matched on the question's CODE and its VARIABLE NAME as whole words, which
 * is how an expression addresses a question. A calculation that does not
 * mention it cannot be reading its codes, so a survey with fifty
 * calculations and one that touches Q7 reports one — a list short enough to
 * actually be read.
 */
function reviewable(def: SurveyDefinition, questionId: string): RenumberResult["needsReview"] {
  const q = def.questions.find((x) => x.id === questionId);
  if (!q) return [];
  const names = [q.code, q.variableName].filter(Boolean).map((n) => String(n));
  if (!names.length) return [];
  const re = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);
  const out: RenumberResult["needsReview"] = [];
  for (const c of def.calculations ?? []) {
    const expression = String((c as { expression?: unknown }).expression ?? "");
    if (expression && re.test(expression)) {
      out.push({ kind: "calculation", id: c.id, label: c.label ?? c.targetVariable ?? c.id, expression });
    }
  }
  return out;
}

/**
 * The common case: a list was edited (usually an option deleted) and its
 * numeric codes should read 1..N again. No-op unless every code is numeric
 * and at least one of them actually moves.
 */
export function resequenceQuestionCodes(
  def: SurveyDefinition,
  questionId: string,
  scope: CodeScope,
): RenumberResult {
  const q = def.questions.find((x) => x.id === questionId);
  const items = (scope === "options" ? q?.options : q?.rows) ?? [];
  if (!q || items.length === 0 || !codesAreSequenceable(items)) {
    return { def, mapping: {}, referencesUpdated: 0, needsReview: [] };
  }
  return renumberQuestionCodes(def, questionId, scope, sequentialCodeMap(items));
}

/**
 * The next free numeric code for a list — `max + 1`, never `length + 1`.
 * Using the length produces duplicates the moment anything has been deleted,
 * and duplicates silently corrupt code-keyed lookups.
 */
export function nextCode(items: { code: string | number }[]): string {
  let max = 0;
  for (const i of items) {
    const n = Number(i.code);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}
