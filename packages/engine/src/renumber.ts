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
    return { def, mapping, referencesUpdated: 0 };
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

  return { def: next, mapping, referencesUpdated: ctx.count };
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
    return { def, mapping: {}, referencesUpdated: 0 };
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
