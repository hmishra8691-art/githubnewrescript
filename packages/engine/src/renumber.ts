import type { Condition, Question, SurveyDefinition } from "@rescript/schema";
import { getQuestionByCodeOrVar } from "./state.js";
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

function rewriteCondition(c: Condition | undefined, ctx: Ctx): Condition | undefined {
  if (!c) return c;
  if (c.type === "group") {
    return { ...c, children: c.children.map((ch) => rewriteCondition(ch, ctx)!) };
  }
  const src = c.source.kind === "question" || c.source.kind === "variable"
    ? getQuestionByCodeOrVar(ctx.def, c.source.ref)
    : undefined;
  if (src?.id !== ctx.targetId) return c;

  let out = c;
  if (ctx.scope === "rows") {
    if (out.source.rowCode != null && String(out.source.rowCode) in ctx.mapping) {
      ctx.count++;
      out = { ...out, source: { ...out.source, rowCode: ctx.mapping[String(out.source.rowCode)] } };
    }
    return out;
  }
  // options: the comparison value carries the code(s)
  if (Array.isArray(out.value)) {
    out = { ...out, value: out.value.map((v) => mapOne(v, ctx)) };
  } else if (out.value !== undefined && out.value !== null && typeof out.value !== "object") {
    out = { ...out, value: mapOne(out.value, ctx) };
  }
  if (out.value2 !== undefined && out.value2 !== null && typeof out.value2 !== "object") {
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
  const cond = (c: Condition | undefined) => rewriteCondition(c, ctx);
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
        when: rewriteCondition(b.when, ctx),
        children: rewriteFlow(b.children, ctx),
      }));
    }
    if (n.when) out.when = rewriteCondition(n.when, ctx);
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
      when: rewriteCondition(r.when, ctx)!,
      target:
        scope === "rows" && r.target.ref === questionId && r.target.subRef &&
        String(r.target.subRef) in mapping
          ? { ...r.target, subRef: mapping[String(r.target.subRef)] }
          : scope === "options" && r.target.ref === questionId && r.target.subRef &&
            String(r.target.subRef) in mapping
            ? { ...r.target, subRef: mapping[String(r.target.subRef)] }
            : r.target,
    })),
    calculations: (def.calculations ?? []).map((c) =>
      c.when ? { ...c, when: rewriteCondition(c.when, ctx) } : c,
    ),
    quotas: (def.quotas ?? []).map((qt) => ({
      ...qt,
      cells: qt.cells.map((cell) => ({ ...cell, when: rewriteCondition(cell.when, ctx)! })),
    })),
    flow: rewriteFlow(def.flow as any[], ctx) as SurveyDefinition["flow"],
  };

  return { def: next, mapping, referencesUpdated: ctx.count, needsReview: reviewable(def, questionId) };
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
