import type { Condition, ConditionRule, FlowNode, Question, SurveyDefinition, ValidationRule } from "@rescript/schema";
import { effectiveResponseModel, isOptionValueRef, isQuestionValueRef } from "@rescript/schema";
import type { SurveyAction } from "./surveyActions.js";
import { forEachConditionRoot, forEachRule, forEachRuleInSurvey, isConditionGroup, mapRules, type ConditionLocation, type RuleVisit } from "./conditionWalk.js";
import { conditionRefs, describeCycle, detectLogicCycles, orderIndex, questionDependencies } from "./dependencies.js";
import { bareNameResolves, operatorsForQuestion, sourceKindForQuestion } from "./lintLogic.js";
import { formatCondition } from "./logicExpression.js";
import { describeOptions, resolveOptionValue, type OptionList } from "./optionCodes.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { pipeTokensIn } from "./pipingTokens.js";
import { setExprSources } from "./setExpression.js";
import { listPages } from "./blocks.js";
import { findNode } from "./flowTree.js";

/**
 * WHAT AN ACTION LEFT BEHIND — checked before it is accepted.
 *
 * `applySurveyActions` applies each action to a clone and refuses the ones
 * that do not RESOLVE: a question that is not there, a condition that does not
 * parse, an option value naming no option. What it could not see is an action
 * that resolves perfectly and still leaves the survey wrong: display logic on
 * Q5 reading Q8, which is asked three pages later; `>` on a Yes/No; a removed
 * option that a quota cell still compares against; a move that puts a
 * question before the one its logic reads. The GRAMMAR path has always run
 * these checks (`validateProposal` in logicProposal.ts); the model path
 * skipped them, so the copilot could promise logic the runtime would never
 * fire.
 *
 * This module is that check, for the model path: `validateActionOutcome` is
 * given the survey BEFORE one action, the survey AFTER it, the action and the
 * ids it touched, and answers with issues. An ERROR means the action is rolled
 * back and refused with the message; a WARNING travels with the result. Every
 * message is written for the researcher, in the brief's style — what was
 * asked, what was found, why it fails, what to do instead — and names objects
 * by code. Where a corrected action is safe and obvious it is attached as a
 * `suggestion`, so the Studio can offer "Apply suggested fix".
 *
 * Nothing here mutates either survey, and nothing here throws: a check that
 * trips over a half-formed definition reports nothing rather than taking the
 * action layer down with it.
 */

export interface ActionIssue {
  level: "error" | "warning";
  /** stable machine code: forward_reference | operator_mismatch | literal_type | stale_option | cycle | validation_fit | move_order | dangling_reference | type_change_breaks | contradiction | self_reference */
  code: string;
  /** the researcher-facing diagnosis: what was requested, what was detected, why it fails, what to do instead — one or two sentences, objects named by code */
  message: string;
  /** ids of the objects involved (question ids, rule ids) */
  objects: string[];
  /** a corrected action the Studio can offer as "Apply suggested fix", when one is safe and obvious */
  suggestion?: SurveyAction;
}

/**
 * The checks run on the clone AFTER one action was applied and BEFORE it is
 * accepted: errors mean the action is rolled back and refused with the
 * message; warnings travel with the result.
 *
 * `touched` is the action result's `touched` list — the question and flow
 * node ids the action created or changed (for a question action its question
 * id; for a block-level display condition the block id). Checks that look at
 * ONE question's logic look at these; checks about the whole survey (stale
 * option codes, new cycles, dangling pipes) look everywhere.
 */
export function validateActionOutcome(before: SurveyDefinition, after: SurveyDefinition, action: SurveyAction, touched: string[]): ActionIssue[] {
  let ctx: Ctx;
  try { ctx = { before, after, action, touched: [...new Set(touched)], orderAfter: orderIndex(after), orderBefore: orderIndex(before) }; } catch { return []; }
  const out: ActionIssue[] = [];
  const checks: ((c: Ctx) => ActionIssue[])[] = [
    checkForwardReferences, checkSelfReferences, checkOperatorMismatch, checkLiteralTypes, checkStaleOptions,
    checkCycles, checkValidationFit, checkMoveOrder, checkDanglingPipes, checkTypeChange, checkContradictions,
  ];
  for (const check of checks) {
    try { out.push(...check(ctx)); } catch { /* a check must never take the action layer down — see the header */ }
  }
  const seen = new Set<string>();
  return out.filter((i) => { const k = `${i.code}|${i.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

interface Ctx {
  before: SurveyDefinition;
  after: SurveyDefinition;
  action: SurveyAction;
  touched: string[];
  orderAfter: Record<string, number>;
  orderBefore: Record<string, number>;
}

/* ------------------------------------------------------------ walkers (shared with the impact module) */

/** Every root condition in a definition, with where it sits — `conditionWalk`'s structural walk, under the name the impact module reaches for. */
export function forEachConditionIn(def: SurveyDefinition, cb: (c: Condition, loc: ConditionLocation) => void): void {
  forEachConditionRoot(def, cb);
}

/** Every rule in a definition, count `where`s included. */
export function forEachRuleIn(def: SurveyDefinition, cb: (rule: ConditionRule, loc: ConditionLocation, at: RuleVisit) => void): void {
  forEachRuleInSurvey(def, cb);
}

export type OwnConditionKind = "display" | "display_rule" | "skip" | "validation" | "option" | "mask" | "punch";

export interface OwnCondition {
  /** the tree */
  c: Condition;
  kind: OwnConditionKind;
  /** "display logic", "skip rule 2", "validation rule min_value", "option 3 visibility", "punch rule" */
  where: string;
  /** the id of the rule / option it belongs to, when it has one */
  id?: string;
  /** a skip reads its own answer, and a validation rule checks it: a self-reference is not a mistake there */
  selfOk: boolean;
}

/**
 * THE CONDITIONS ONE QUESTION OWNS — the logic an action on that question can
 * have written: its display logic, the survey-level display rules that target
 * it, its skip rules, its validation gates and checks, its options' visibility
 * and option logic, its masks' guards and its punch rules' criteria.
 */
export function questionConditions(def: SurveyDefinition, q: Question): OwnCondition[] {
  const out: OwnCondition[] = [];
  if (q.displayLogic) out.push({ c: q.displayLogic, kind: "display", where: "display logic", selfOk: false });
  for (const r of def.displayRules ?? []) {
    if (r.target.ref !== q.id && r.target.ref !== q.code && r.target.ref !== q.variableName) continue;
    out.push({ c: r.when, kind: r.target.kind === "question" ? "display_rule" : "option", where: r.target.kind === "question" ? `display rule${r.label ? ` “${r.label}”` : ""}` : `${r.target.kind} ${r.target.subRef ?? ""} display rule`.replace(/\s+/g, " "), id: r.id, selfOk: r.target.kind !== "question" });
  }
  (q.skipLogic ?? []).forEach((s, i) => out.push({ c: s.when, kind: "skip", where: `skip rule${q.skipLogic!.length > 1 ? ` ${i + 1}` : ""}`, id: s.id, selfOk: true }));
  for (const v of q.validation ?? []) {
    if (v.when) out.push({ c: v.when, kind: "validation", where: `validation rule ${v.kind.replace(/_/g, " ")} (only when)`, id: v.id, selfOk: true });
    if (v.check) out.push({ c: v.check, kind: "validation", where: `validation rule ${v.kind.replace(/_/g, " ")}`, id: v.id, selfOk: true });
  }
  for (const o of q.options ?? []) {
    if (o.visibleIf) out.push({ c: o.visibleIf, kind: "option", where: `option ${o.code} visibility`, selfOk: true });
    const l = o.logic;
    for (const [name, c] of [["show/hide", l?.when], ["eligibility", l?.eligibleWhen], ["exclusion", l?.excludeWhen], ["priority", l?.prioritizeWhen], ["priority", l?.deprioritizeWhen], ["randomization", l?.randomizeWhen]] as const) {
      if (c) out.push({ c, kind: "option", where: `option ${o.code} ${name} logic`, selfOk: true });
    }
  }
  for (const r of q.rows ?? []) if (r.visibleIf) out.push({ c: r.visibleIf, kind: "option", where: `row ${r.code} visibility`, selfOk: true });
  for (const [name, m] of [["mask", q.mask], ["row mask", q.rowMask], ["column mask", q.columnMask]] as const) if (m?.when) out.push({ c: m.when, kind: "mask", where: `${name} guard`, selfOk: false });
  (q.punches ?? []).forEach((p, i) => { if (p.when) out.push({ c: p.when, kind: "punch", where: `punch rule${(q.punches?.length ?? 0) > 1 ? ` ${i + 1}` : ""}${p.label ? ` “${p.label}”` : ""}`, id: p.id, selfOk: true }); });
  return out;
}

/** The questions a question's masks and punch sources READ (set expressions, not conditions) — the other half of its own logic. */
export function questionSetSources(def: SurveyDefinition, q: Question): { ids: Set<string>; where: string }[] {
  const out: { ids: Set<string>; where: string }[] = [];
  for (const [name, m] of [["mask", q.mask], ["row mask", q.rowMask], ["column mask", q.columnMask]] as const) if (m) out.push({ ids: setExprSources(m.expr, undefined, def), where: name });
  for (const p of q.punches ?? []) out.push({ ids: setExprSources(p.source, undefined, def), where: `punch rule${p.label ? ` “${p.label}”` : ""}` });
  return out;
}

/* ------------------------------------------------------------ words */

const byId = (def: SurveyDefinition, id: string): Question | undefined => def.questions.find((q) => q.id === id);
const code = (def: SurveyDefinition, id: string): string => byId(def, id)?.code ?? id;
/** the touched ids that are questions in `after` */
const touchedQuestions = (ctx: Ctx): Question[] => ctx.touched.map((id) => byId(ctx.after, id)).filter((q): q is Question => !!q);

/** "single-select", "multi-select", "numeric", "text", "date", "ranking" — the kind of answer a question holds, in the researcher's words */
export function kindWords(q: Question): string {
  switch (sourceKindForQuestion(q)) {
    case "choice": return effectiveResponseModel(q) === "per_row" ? "grid" : "single-select";
    case "list": return "multi-select";
    case "ranking": return "ranking";
    case "numeric": return effectiveResponseModel(q) === "allocation" ? "constant-sum" : "numeric";
    case "text": return "text";
    case "date": return q.type === "time" ? "time" : "date";
    default: return q.type.replace(/_/g, " ");
  }
}

/** what a comparison operator READS its source as — the mismatch half of the diagnosis */
function operatorReads(op: ConditionRule["operator"]): string {
  if (["gt", "gte", "lt", "lte", "between", "notBetween"].includes(op)) return "a number";
  if (["startsWith", "endsWith", "matches"].includes(op)) return "text";
  if (["selected", "notSelected", "containsAny", "containsAll", "containsNone"].includes(op)) return "a list of options";
  if (op.startsWith("rank") || op === "notRanked") return "a ranking";
  if (op.startsWith("date")) return "a date";
  if (op === "contains" || op === "notContains") return "text or a list";
  return "a value";
}

/** what a condition on this kind of question must compare */
function mustCompare(q: Question): string {
  switch (sourceKindForQuestion(q)) {
    case "choice": return "compare one option value (=, !=, in)";
    case "list": return "test which options are selected (selected, contains any / all / none)";
    case "ranking": return "test ranks (ranked first / last / top N)";
    case "numeric": return "compare a number (=, >, <, between)";
    case "text": return "compare text (=, contains, starts with, matches)";
    case "date": return "compare a date (before, after, on)";
    default: return "use = or answered";
  }
}

const OPERATOR_SIGN: Partial<Record<ConditionRule["operator"], string>> = { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const sign = (op: ConditionRule["operator"]): string => OPERATOR_SIGN[op] ?? op;

/** the rule as the researcher would write it, for a message */
const ruleWords = (def: SurveyDefinition, r: ConditionRule): string => { try { return formatCondition(def, r, { width: 400 }); } catch { return `${r.source.ref} ${r.operator} ${String(r.value)}`; } };

/* ------------------------------------------------------------ 1. forward references */

/**
 * A condition can only read what has been ANSWERED. Display logic on Q5
 * reading Q8 — asked after it — is a question that is hidden at the moment it
 * would be shown and never re-asked; the lint warns about it in the editor,
 * the grammar path refuses it, and here it is refused for the model path.
 */
function checkForwardReferences(ctx: Ctx): ActionIssue[] {
  const { after, orderAfter: order } = ctx;
  const out: ActionIssue[] = [];
  // a move changes WHEN, not what is read: `move_order` names both questions and both directions
  if (ctx.action.op === "move_question") return out;
  for (const q of touchedQuestions(ctx)) {
    const here = order[q.id] ?? 0;
    const seen = new Set<string>();
    const report = (readId: string, where: string, kind: OwnConditionKind) => {
      if (readId === q.id || seen.has(`${readId}|${where}`)) return;
      seen.add(`${readId}|${where}`);
      const r = code(after, readId);
      const message = kind === "display" || kind === "display_rule"
        ? `${r} is asked after ${q.code}, so ${q.code} cannot be shown on ${r}'s answer — move ${r} before ${q.code}, or put the condition on ${r} instead.`
        : `${r} is asked after ${q.code}, so ${q.code}'s ${where} cannot read ${r}'s answer (it is still unanswered when the rule runs) — move ${r} before ${q.code}, or put the condition on ${r} instead.`;
      out.push({ level: "error", code: "forward_reference", message, objects: [q.id, readId] });
    };
    for (const own of questionConditions(after, q)) {
      for (const readId of conditionRefs(after, own.c)) if ((order[readId] ?? -1) > here) report(readId, own.where, own.kind);
    }
    for (const src of questionSetSources(after, q)) {
      for (const readId of src.ids) if ((order[readId] ?? -1) > here) report(readId, src.where, "mask");
    }
  }
  /*
   * A display condition on a BLOCK (or page) may only read questions asked
   * before the first question inside it: anything inside or after is not
   * answered when the block is reached.
   */
  for (const id of ctx.touched) {
    if (byId(after, id)) continue;
    const node = findNode(after.flow as FlowNode[], id) as (FlowNode & { visibleIf?: Condition; title?: string }) | null;
    if (!node?.visibleIf) continue;
    const inside = listPages([node]).flatMap((p) => p.node.questionIds);
    const first = Math.min(...inside.map((x) => order[x] ?? Infinity));
    const label = `${node.type === "page" ? "page" : node.type} “${node.title ?? id}”`;
    for (const readId of conditionRefs(after, node.visibleIf)) {
      if ((order[readId] ?? -1) < first) continue;
      const r = code(after, readId);
      out.push({ level: "error", code: "forward_reference", message: inside.includes(readId)
        ? `${r} is inside ${label}, so the ${node.type} cannot be shown on ${r}'s answer — it is not answered until the ${node.type} is shown. Put the condition on the questions after ${r}, or read a question asked before the ${node.type}.`
        : `${r} is asked after ${label}, so the ${node.type} cannot be shown on ${r}'s answer — move ${r} before it, or read a question asked earlier.`, objects: [id, readId] });
    }
  }
  return out;
}

/* ------------------------------------------------------------ 2. self references */

/**
 * Display logic that reads its own question can never show it: the answer is
 * empty until the question is shown, and the question is not shown until the
 * answer is right. The parser refuses the text form; this covers a structured
 * condition, a display rule and a mask built from the question's own answer.
 */
function checkSelfReferences(ctx: Ctx): ActionIssue[] {
  const { after } = ctx;
  const out: ActionIssue[] = [];
  for (const q of touchedQuestions(ctx)) {
    for (const own of questionConditions(after, q)) {
      if (own.selfOk || !conditionRefs(after, own.c).has(q.id)) continue;
      out.push({ level: "error", code: "self_reference", message: `${q.code}'s ${own.where} reads ${q.code} itself — the answer is empty until the question is shown, so it would never be shown. Put the condition on a question asked before ${q.code}, or on the question that should depend on ${q.code}.`, objects: [q.id, ...(own.id ? [own.id] : [])] });
    }
    for (const src of questionSetSources(after, q)) {
      if (!src.ids.has(q.id)) continue;
      out.push({ level: "error", code: "self_reference", message: `${q.code}'s ${src.where} reads ${q.code}'s own answer — the options would depend on an answer that cannot be given until they are shown. Read a question asked before ${q.code} instead.`, objects: [q.id] });
    }
  }
  return out;
}

/* ------------------------------------------------------------ 3. operator fits the source */

/** the question a rule reads, when it reads one (not a count — a count is a number whatever it counts) */
function ruleSource(def: SurveyDefinition, r: ConditionRule): Question | undefined {
  if ((r.source.kind !== "question" && r.source.kind !== "variable") || r.source.count) return undefined;
  return getQuestionByCodeOrVar(def, r.source.ref);
}

/** every literal a rule compares with: value, value2 and list members — never a question or option reference, never empty */
function ruleLiterals(r: ConditionRule): unknown[] {
  const out: unknown[] = [];
  for (const v of [r.value, r.value2]) {
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x === undefined || x === null || x === "" || typeof x === "boolean" || isOptionValueRef(x) || isQuestionValueRef(x) || typeof x === "object") continue;
      out.push(x);
    }
  }
  return out;
}

const NUMERIC_COMPARISONS = new Set<ConditionRule["operator"]>(["gt", "gte", "lt", "lte", "between", "notBetween"]);

/**
 * Why an operator does not fit its source, or null. `operatorsForQuestion` is
 * the platform's table; one case is added on top of it: an ordered comparison
 * on a SINGLE-SELECT whose codes are not a numeric scale. The table allows
 * `>` on a choice because a 5-point scale's codes are ordered — but on a
 * Yes/No, or on options coded `brandA`, `Q12 > 1` compares nothing anyone
 * meant, and it is the mistake a model makes when it means `Q12 = 2`.
 */
function operatorMisfit(src: Question, r: ConditionRule): string | null {
  const allowed = operatorsForQuestion(src);
  if (!allowed.includes(r.operator)) return `${src.code} is a ${kindWords(src)} question, so a condition on it must ${mustCompare(src)}; the requested condition reads ${src.code} as ${operatorReads(r.operator)} (${sign(r.operator)}).`;
  if (sourceKindForQuestion(src) === "choice" && NUMERIC_COMPARISONS.has(r.operator) && !r.source.count) {
    const options = codeDomain(src, r);
    const numeric = options.length >= 3 && options.every((o) => Number.isFinite(Number(o.code)));
    if (options.length && !numeric) return `${src.code} is a ${kindWords(src)} question whose options are ${describeOptions(options)}, so a condition on it must compare one option value; the requested condition reads ${src.code} as a number (${sign(r.operator)}).`;
  }
  return null;
}

/**
 * The options a rule's value is compared against — a column's on a composite
 * cell, the question's otherwise. A grid read WITHOUT its row is compared
 * the same way: the evaluator reads it as the set of its cells, true when any
 * row holds the value (evaluate.ts, CELL_SETS), so `GRID = 7` on a 5-point
 * grid is as dead as `GRID.r1 = 7` — and `checkStaleOptions` already treats
 * it so.
 */
function codeDomain(q: Question, r: ConditionRule): OptionList {
  const kind = sourceKindForQuestion(q);
  if (kind !== "choice" && kind !== "list" && kind !== "ranking") return [];
  const column = r.source.columnId ? q.columns?.find((c) => c.id === r.source.columnId) : undefined;
  return (column?.options?.length ? column.options : q.options?.length ? q.options : q.columns?.[0]?.options ?? []) as OptionList;
}

/**
 * The corrected condition for an operator mismatch: `>` / `<` / `>=` / `<=`
 * against one option code becomes `=` on that code. Built only for the two
 * actions whose condition is the action's whole payload — set_display_logic
 * and add_skip — because for anything else "the same action with this rule
 * changed" cannot be reconstructed without guessing.
 */
function eqSuggestion(ctx: Ctx, q: Question, fixedRules: Set<ConditionRule> = new Set()): SurveyAction | undefined {
  const a = ctx.action;
  const stored = a.op === "set_display_logic" ? q.displayLogic : a.op === "add_skip" ? q.skipLogic?.at(-1)?.when : undefined;
  if (!stored) return undefined;
  let fixed = 0;
  const next = mapRules(stored, (r) => {
    const src = ruleSource(ctx.after, r);
    if (!src || !NUMERIC_COMPARISONS.has(r.operator) || !operatorMisfit(src, r)) return r;
    const kind = sourceKindForQuestion(src);
    if (kind !== "choice" && kind !== "list") return r;
    const lits = ruleLiterals(r);
    if (lits.length !== 1 || Array.isArray(r.value) || r.value2 !== undefined) return r;
    if (resolveOptionValue(codeDomain(src, r), lits[0]).kind !== "code") return r;
    fixed++;
    fixedRules.add(r);
    return { type: "rule", source: r.source, operator: "eq", value: r.value };
  });
  if (!fixed) return undefined;
  if (a.op === "set_display_logic") return { ...a, expression: next };
  if (a.op === "add_skip") return { ...a, when: next };
  return undefined;
}

function checkOperatorMismatch(ctx: Ctx): ActionIssue[] {
  const { after } = ctx;
  const out: ActionIssue[] = [];
  for (const q of touchedQuestions(ctx)) {
    // the rules the suggestion rewrote: only those say "Suggested:" and carry it — another misfit in the same condition is still in it
    const fixedRules = new Set<ConditionRule>();
    const suggestion = eqSuggestion(ctx, q, fixedRules);
    for (const own of questionConditions(after, q)) {
      forEachRule(own.c, (r) => {
        const src = ruleSource(after, r);
        if (!src) return;
        const why = operatorMisfit(src, r);
        if (!why) return;
        const lits = ruleLiterals(r);
        const suggested = suggestion && fixedRules.has(r) && lits.length === 1 && NUMERIC_COMPARISONS.has(r.operator) ? ` Suggested: ${src.code} = ${String(lits[0])}.` : "";
        out.push({ level: "error", code: "operator_mismatch", message: `${why}${suggested}`, objects: [q.id, src.id, ...(own.id ? [own.id] : [])], ...(suggestion && suggested ? { suggestion } : {}) });
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------ 4. the literal fits the source */

/** why a literal cannot be what the source holds, or null */
function literalMisfit(src: Question, r: ConditionRule): string | null {
  const lits = ruleLiterals(r);
  if (!lits.length) return null;
  const kind = sourceKindForQuestion(src);
  if (kind === "numeric") {
    const bad = lits.find((v) => typeof v !== "number" && !Number.isFinite(Number(String(v).trim())));
    if (bad !== undefined) return `${src.code} is a ${kindWords(src)} question, so it is compared with a number — “${String(bad)}” is not one. Write the number itself, or compare a text question instead.`;
    return null;
  }
  if (kind === "choice" || kind === "list" || kind === "ranking") {
    if (!["eq", "ne", "in", "notIn", "contains", "notContains", "selected", "notSelected", "containsAny", "containsAll", "containsNone", "rankedFirst", "rankedLast", "rankedTopN", "rankEquals", "rankGreaterThan", "rankLessThan", "notRanked"].includes(r.operator)) return null;
    const options = codeDomain(src, r);
    if (!options.length) return null;
    // ranking operators compare a code (value) and a rank (value2): only the code is an option
    const codes = r.operator.startsWith("rank") ? (Array.isArray(r.value) ? r.value : [r.value]).filter((v) => v !== undefined && v !== null && v !== "" && typeof v !== "object") : lits;
    const bad = codes.find((v) => !options.some((o) => String(o.code) === String(v).trim()));
    if (bad !== undefined) return `${src.code} is a ${kindWords(src)} question whose options are ${describeOptions(options)} — “${String(bad)}” is none of them, so the condition could never be true. Compare one of those codes.`;
  }
  return null;
}

function checkLiteralTypes(ctx: Ctx): ActionIssue[] {
  const { after } = ctx;
  const out: ActionIssue[] = [];
  for (const q of touchedQuestions(ctx)) {
    for (const own of questionConditions(after, q)) {
      forEachRule(own.c, (r) => {
        const src = ruleSource(after, r);
        if (!src) return;
        const why = literalMisfit(src, r);
        if (why) out.push({ level: "error", code: "literal_type", message: why, objects: [q.id, src.id, ...(own.id ? [own.id] : [])] });
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------ 5. codes removed from under their logic */

/** the codes a question's answer can hold: its options, a grid's scale, a composite's column options */
function answerCodes(q: Question): Set<string> {
  const s = new Set<string>();
  for (const o of q.options ?? []) s.add(String(o.code));
  for (const c of q.columns ?? []) for (const o of c.options ?? []) s.add(String(o.code));
  return s;
}

/** "Q9 display logic", "quota “Region” cell “Canada”" — a condition's place, with a quota cell named by its label */
function placeWords(def: SurveyDefinition, loc: ConditionLocation): string {
  const m = /^quotas\[(\d+)\]\.cells\[(\d+)\]/.exec(loc.path);
  if (m) {
    const quota = (def.quotas ?? [])[Number(m[1])];
    const cell = quota?.cells[Number(m[2])];
    if (quota && cell) return `quota “${quota.name}” cell “${cell.label}”`;
  }
  return loc.where;
}

/**
 * An option removed or recoded on a touched question, while a rule somewhere
 * still compares that question with the old code: the rule stays, parses and
 * is simply never true again. Every condition in the survey is walked —
 * display and skip logic, validation, branches, display rules, punches and
 * quota cells — and the dependents are named, so the researcher changes that
 * logic first or removes the option together with it.
 */
function checkStaleOptions(ctx: Ctx): ActionIssue[] {
  const { before, after } = ctx;
  const out: ActionIssue[] = [];
  for (const q of touchedQuestions(ctx)) {
    const prev = byId(before, q.id);
    if (!prev) continue;
    // a type change drops the options with the type: `type_change_breaks` reports what that leaves behind, once
    if (ctx.action.op === "update_question" && ctx.action.type && (prev.type !== q.type || prev.variant !== q.variant)) continue;
    const now = answerCodes(q);
    const dead = [...answerCodes(prev)].filter((c) => !now.has(c));
    if (!dead.length) continue;
    const hits = new Map<string, { place: string; objects: string[] }>();
    const codesIn = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined && x !== null && x !== "" && typeof x !== "object" && typeof x !== "boolean").map((x) => String(x).trim());
    forEachRuleInSurvey(after, (r, loc) => {
      if (r.source.kind !== "question" && r.source.kind !== "variable") return;
      if (getQuestionByCodeOrVar(after, r.source.ref)?.id !== q.id) return;
      const compared = r.source.count
        ? [...(r.source.count.only ?? []), ...(r.source.count.responseIn ?? [])].map(String)
        : [...codesIn(r.value), ...(r.operator.startsWith("rank") ? [] : codesIn(r.value2))];
      const stale = compared.filter((c) => dead.includes(c));
      if (!stale.length) return;
      const place = placeWords(after, loc);
      const quota = /^quotas\[(\d+)\]/.exec(loc.path);
      const objectId = loc.questionId ?? (quota ? (after.quotas ?? [])[Number(quota[1])]?.id : undefined) ?? loc.path;
      for (const c of stale) {
        const k = `${c}|${place}`;
        if (!hits.has(k)) hits.set(k, { place, objects: [objectId] });
      }
    });
    if (!hits.size) continue;
    // in the order the options had, not the order their dependents were found in
    const byCode = new Map<string, string[]>();
    for (const c of dead) for (const [k, h] of hits) if (k.split("|")[0] === c) byCode.set(c, [...(byCode.get(c) ?? []), h.place]);
    const objects = [...new Set([...hits.values()].flatMap((h) => h.objects))];
    const label = (c: string) => { const o = (prev.options ?? []).find((x) => String(x.code) === c) ?? prev.columns?.flatMap((x) => x.options ?? []).find((x) => String(x.code) === c); return o ? `option ${c} “${String(o.label).replace(/<[^>]*>/g, "").trim()}”` : `option ${c}`; };
    const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
    const removed = [...byCode.keys()].map(label);
    const places = [...new Set([...byCode.values()].flat())];
    const recoded = [...byCode.keys()].some((c) => (q.options ?? []).length >= (prev.options ?? []).length);
    out.push({ level: "error", code: "stale_option", message: `${recoded ? "Recoding" : "Removing"} ${list(removed)} from ${q.code} leaves ${list(places)} comparing ${q.code} with a value that no longer exists — change that logic first, or remove the option with its logic.`, objects: [q.id, ...objects] });
  }
  return out;
}

/* ------------------------------------------------------------ 6. new cycles */

function checkCycles(ctx: Ctx): ActionIssue[] {
  const { before, after } = ctx;
  const key = (c: string[]) => [...c].sort().join("|");
  const had = new Set(detectLogicCycles(before).map(key));
  const out: ActionIssue[] = [];
  for (const cycle of detectLogicCycles(after)) {
    if (had.has(key(cycle))) continue;
    out.push({ level: "error", code: "cycle", message: `${describeCycle(after, cycle)} Each depends on the next, so none of them can be shown — the condition must read a question that does not read back.`, objects: cycle });
  }
  return out;
}

/* ------------------------------------------------------------ 7. validation rules that fit the question */

const NUMERIC_RULE_VALUE = new Set<string>(["min_value", "max_value", "min_length", "max_length", "min_selections", "max_selections", "sum_equals", "sum_max", "sum_min"]);

const RULE_WORDS: Record<string, string> = {
  min_value: "a minimum value", max_value: "a maximum value", integer: "a whole-number rule", min_length: "a minimum length", max_length: "a maximum length",
  pattern: "a pattern", email: "an email format", phone: "a phone-number format", url: "a web-address format", zip: "a postal-code format",
  min_selections: "a minimum number of selections", max_selections: "a maximum number of selections", sum_equals: "a required total", sum_max: "a maximum total", sum_min: "a minimum total",
  date_min: "an earliest date", date_max: "a latest date",
};
const ruleWord = (k: string): string => RULE_WORDS[k] ?? `a ${k.replace(/_/g, " ")} rule`;

/** what validation DOES apply to a question of this kind */
function validationThatApplies(q: Question): string {
  switch (sourceKindForQuestion(q)) {
    case "numeric": return effectiveResponseModel(q) === "allocation" ? "a required, minimum or maximum total applies to a constant sum" : "a minimum value, a maximum value or a whole-number rule applies to a numeric question";
    case "text": return "a minimum or maximum length, a pattern, or an email / phone / web-address / postal-code format applies to a text question";
    case "list": return "a minimum or maximum number of selections applies to a multi-select";
    case "ranking": return "a minimum or maximum number of selections applies to a ranking";
    case "date": return "an earliest or latest date applies to a date question";
    case "choice": return "a single-select takes only “required” and a condition rule";
    default: return "only “required” and a condition rule apply to it";
  }
}

/**
 * Why a rule kind makes no sense on this question, or null — the grammar
 * path's `ruleFits` (logicProposal.ts), read from the response model rather
 * than from a type regex, so a slider, an NPS, a numeric grid and a
 * constant sum are numeric because they hold numbers, not because their
 * names happen to say so.
 */
export function validationRuleMisfit(q: Question, kind: ValidationRule["kind"]): string | null {
  const k = sourceKindForQuestion(q);
  const model = effectiveResponseModel(q);
  const say = (what: string) => `${q.code} is a ${kindWords(q)} question, so ${what} does not apply — ${validationThatApplies(q)}.`;
  if ((kind === "min_value" || kind === "max_value" || kind === "integer") && k !== "numeric") return say(ruleWord(kind));
  if (["min_length", "max_length", "pattern", "email", "phone", "url", "zip"].includes(kind) && k !== "text") return say(ruleWord(kind));
  if ((kind === "min_selections" || kind === "max_selections") && k !== "list" && k !== "ranking") return say(ruleWord(kind));
  if ((kind === "sum_equals" || kind === "sum_max" || kind === "sum_min") && model !== "allocation" && q.type !== "matrix_numeric" && q.type !== "numeric_list") return say(ruleWord(kind));
  if ((kind === "date_min" || kind === "date_max") && k !== "date") return say(ruleWord(kind));
  return null;
}

function checkValidationFit(ctx: Ctx): ActionIssue[] {
  const a = ctx.action;
  if (a.op !== "set_validation" && !(a.op === "create_question" && a.validation?.length)) return [];
  const out: ActionIssue[] = [];
  for (const q of touchedQuestions(ctx)) {
    const rules = q.validation ?? [];
    if (!rules.length) continue;
    const bad = new Set<string>();
    const num = (k: string) => { const r = rules.find((v) => v.kind === k); return r && typeof r.value === "number" ? r.value : undefined; };
    for (const r of rules) {
      const why = validationRuleMisfit(q, r.kind);
      if (why) { bad.add(r.kind); out.push({ level: "error", code: "validation_fit", message: why, objects: [q.id, ...(r.id ? [r.id] : [])] }); continue; }
      if (NUMERIC_RULE_VALUE.has(r.kind) && (typeof r.value !== "number" || !Number.isFinite(r.value))) {
        bad.add(r.kind);
        out.push({ level: "error", code: "validation_fit", message: `${q.code}'s ${ruleWord(r.kind).replace(/^an? /, "")} needs a number — “${String(r.value ?? "")}” is not one.`, objects: [q.id, ...(r.id ? [r.id] : [])] });
      }
    }
    const pair = (lo: string, hi: string, what: string) => { const l = num(lo), h = num(hi); if (l !== undefined && h !== undefined && l > h) { bad.add(lo); out.push({ level: "error", code: "validation_fit", message: `${q.code}'s minimum ${what} (${l}) is above its maximum (${h}) — no answer can satisfy both.`, objects: [q.id] }); } };
    pair("min_value", "max_value", "value"); pair("min_length", "max_length", "length"); pair("min_selections", "max_selections", "number of selections"); pair("sum_min", "sum_max", "total");
    const maxSel = num("max_selections"), minSel = num("min_selections"), n = q.options?.length ?? 0;
    if (n && maxSel !== undefined && maxSel > n) { bad.add("max_selections"); out.push({ level: "error", code: "validation_fit", message: `${q.code} has only ${n} options, so at most ${maxSel} cannot be selected — a maximum of ${n} or fewer is the most it can check.`, objects: [q.id] }); }
    if (n && minSel !== undefined && minSel > n) { bad.add("min_selections"); out.push({ level: "error", code: "validation_fit", message: `${q.code} has only ${n} options, so at least ${minSel} can never be selected — a minimum of ${n} or fewer is the most it can require.`, objects: [q.id] }); }
    if (!bad.size) continue;
    // the same action without the rules that do not fit — when something is left to set
    const specs = a.op === "set_validation" ? a.rules : a.op === "create_question" ? a.validation ?? [] : [];
    const kept = specs.filter((r) => !bad.has(r.kind));
    if (kept.length && kept.length < specs.length) {
      const suggestion: SurveyAction = a.op === "set_validation" ? { ...a, rules: kept } : { ...(a as Extract<SurveyAction, { op: "create_question" }>), validation: kept };
      for (const issue of out) if (issue.objects[0] === q.id && !issue.suggestion) issue.suggestion = suggestion;
    }
  }
  return out;
}

/* ------------------------------------------------------------ 8. a move that breaks an order */

/**
 * A moved question still reads what it read, and is still read by what read
 * it; what changes is WHEN. If it now sits after a question that reads it, or
 * before one it reads, the logic stays valid and stops working — so the move
 * is refused, naming both questions. Only orders the move itself broke are
 * reported: a forward reference that was already there is not this action's.
 */
function checkMoveOrder(ctx: Ctx): ActionIssue[] {
  if (ctx.action.op !== "move_question") return [];
  const { before, after, orderAfter, orderBefore } = ctx;
  const out: ActionIssue[] = [];
  for (const q of touchedQuestions(ctx)) {
    const here = orderAfter[q.id] ?? 0;
    for (const d of questionDependencies(after, q)) {
      if ((orderAfter[d] ?? -1) <= here) continue;
      if (byId(before, q.id) && byId(before, d) && (orderBefore[d] ?? -1) > (orderBefore[q.id] ?? 0)) continue;
      out.push({ level: "error", code: "move_order", message: `Moving ${q.code} here puts it before ${code(after, d)}, whose answer ${q.code}'s logic reads — ${code(after, d)} is still unanswered when ${q.code} is shown. Move ${q.code} after ${code(after, d)}, or move ${code(after, d)} up with it.`, objects: [q.id, d] });
    }
    for (const x of after.questions) {
      if (x.id === q.id || (orderAfter[x.id] ?? 0) >= here) continue;
      if (!questionDependencies(after, x).has(q.id)) continue;
      if (byId(before, x.id) && (orderBefore[x.id] ?? 0) < (orderBefore[q.id] ?? 0)) continue;
      out.push({ level: "error", code: "move_order", message: `Moving ${q.code} here puts it after ${x.code}, whose logic reads ${q.code}'s answer — ${q.code} is still unanswered when ${x.code} is shown. Move ${q.code} before ${x.code}, or move ${x.code} down with it.`, objects: [q.id, x.id] });
    }
  }
  return out;
}

/* ------------------------------------------------------------ 9. pipes that name nothing */

/**
 * `{{NAME}}` in a question text resolves against questions (code or
 * variable), calculations, embedded fields, list-fill and loop variables. A
 * rename or a deletion that was not propagated leaves a pipe that renders
 * blank. A warning, not an error: the engine may legitimately prune, and a
 * blank pipe is a flaw in a question that otherwise works.
 */
function checkDanglingPipes(ctx: Ctx): ActionIssue[] {
  const { before, after, touched } = ctx;
  const resolves = (def: SurveyDefinition, q: Question | undefined, name: string) => !!getQuestionByCodeOrVar(def, name) || bareNameResolves(def, q, name);
  const carriers = new Map<string, string[]>();
  for (const q of after.questions) {
    const text = [q.text, q.instruction, q.description, ...(q.options ?? []).map((o) => o.label), ...(q.rows ?? []).map((r) => r.label)].filter((s): s is string => typeof s === "string" && s.includes("{{")).join("\n");
    if (!text) continue;
    for (const t of pipeTokensIn(text)) {
      if (t.kind !== "question" || resolves(after, q, t.ref)) continue;
      const prev = byId(before, q.id);
      // a name that resolved before this action, or a pipe this action wrote
      if (!resolves(before, prev, t.ref) && !touched.includes(q.id)) continue;
      carriers.set(t.ref, [...new Set([...(carriers.get(t.ref) ?? []), q.id])]);
    }
  }
  const out: ActionIssue[] = [];
  const a = ctx.action;
  const renamed = a.op === "update_question" && a.variable ? touchedQuestions(ctx)[0] : undefined;
  for (const [name, ids] of carriers) {
    const codes = ids.map((id) => code(after, id));
    const hint = renamed ? ` ${renamed.code}'s variable is now ${renamed.variableName}; write {{${renamed.variableName}}}, or keep the old name.` : " Point the pipe at a question, calculation or embedded field that exists, or remove it.";
    out.push({ level: "warning", code: "dangling_reference", message: `{{${name}}} in ${codes.join(", ")} no longer names anything in this survey, so it would show as blank.${hint}`, objects: ids });
  }
  return out;
}

/* ------------------------------------------------------------ 10. a type change under existing logic */

/**
 * Changing a question's type keeps the rules that read it and changes what
 * they read: `Q7 selected 2` on a question that is now numeric selects
 * nothing; `Q7 > 3` on one that is now a text box compares text with a
 * number. The same fit checks as 3 and 4, run over every rule in the survey
 * that reads the changed question.
 */
function checkTypeChange(ctx: Ctx): ActionIssue[] {
  const a = ctx.action;
  if (a.op !== "update_question" || !a.type) return [];
  const { before, after } = ctx;
  const out: ActionIssue[] = [];
  for (const q of touchedQuestions(ctx)) {
    const prev = byId(before, q.id);
    if (!prev || (prev.type === q.type && prev.variant === q.variant)) continue;
    forEachRuleInSurvey(after, (r, loc) => {
      const src = ruleSource(after, r);
      if (!src || src.id !== q.id) return;
      const why = operatorMisfit(src, r) ?? literalMisfit(src, r);
      if (!why) return;
      out.push({ level: "error", code: "type_change_breaks", message: `Changing ${q.code} from ${kindWords(prev)} to ${kindWords(q)} breaks ${placeWords(after, loc)} (${ruleWords(after, r)}): ${why.replace(/^.*?, so /, "").replace(/^./, (c) => c.toLowerCase())} Rewrite that logic for the new type first, or keep the type.`, objects: [q.id, ...(loc.questionId && loc.questionId !== q.id ? [loc.questionId] : [])] });
    });
  }
  return out;
}

/* ------------------------------------------------------------ 11. conditions that can never hold */

interface Bound { value: number; inclusive: boolean; rule: ConditionRule }

/**
 * An AND of two rules on the same source that cannot both be true: `AGE > 65
 * AND AGE < 18`, `Q3 = 1 AND Q3 = 2` on a single-select, `Q5 between 1 and 3
 * AND Q5 >= 7`. A warning: the survey runs, the question simply never shows,
 * which is the kind of flaw that is found in fieldwork.
 */
function checkContradictions(ctx: Ctx): ActionIssue[] {
  const { after } = ctx;
  const out: ActionIssue[] = [];
  // the whole address: two counts of different things, or two rows by position, are two different numbers
  const sourceKey = (r: ConditionRule) => `${r.source.kind}|${r.source.ref}|${r.source.rowCode ?? ""}|${r.source.columnId ?? ""}|${r.source.rowPosition ?? ""}|${r.source.optionPosition ?? ""}|${r.source.scope ?? ""}|${r.source.count ? JSON.stringify(r.source.count) : ""}`;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  /** the rules directly ANDed together at this node — through nested ANDs, never through an OR or a NOT */
  const andedRules = (c: Condition): ConditionRule[] => {
    if (!isConditionGroup(c)) return c.type === "rule" ? [c] : [];
    if (c.op !== "and") return [];
    return c.children.flatMap(andedRules);
  };
  const visit = (c: Condition, report: (why: string, rules: ConditionRule[]) => void) => {
    if (isConditionGroup(c)) {
      if (c.op === "and") {
        const groups = new Map<string, ConditionRule[]>();
        for (const r of andedRules(c)) groups.set(sourceKey(r), [...(groups.get(sourceKey(r)) ?? []), r]);
        for (const rules of groups.values()) {
          if (rules.length < 2) continue;
          const src = ruleSource(after, rules[0]);
          const numericSource = !!rules[0].source.count || (src ? sourceKindForQuestion(src) === "numeric" : false) || rules[0].source.kind === "expr" || rules[0].source.kind === "calculation";
          const singleChoice = src ? sourceKindForQuestion(src) === "choice" : false;
          // two different equalities on one single-valued source
          const eqs = rules.filter((r) => r.operator === "eq" && !Array.isArray(r.value) && ruleLiterals(r).length === 1);
          if ((numericSource || singleChoice) && eqs.length >= 2) {
            const distinct = new Set(eqs.map((r) => String(r.value).trim()));
            if (distinct.size > 1) { report("one answer cannot equal two different values", eqs.slice(0, 2)); continue; }
          }
          if (!numericSource && !(singleChoice && rules.some((r) => NUMERIC_COMPARISONS.has(r.operator)))) continue;
          const b: { lower: Bound | null; upper: Bound | null } = { lower: null, upper: null };
          const tighten = (lo: Bound | null, hi: Bound | null) => {
            if (lo && (!b.lower || lo.value > b.lower.value || (lo.value === b.lower.value && !lo.inclusive))) b.lower = lo;
            if (hi && (!b.upper || hi.value < b.upper.value || (hi.value === b.upper.value && !hi.inclusive))) b.upper = hi;
          };
          for (const r of rules) {
            const v = num(r.value), v2 = num(r.value2);
            if (r.operator === "gt" && v !== null) tighten({ value: v, inclusive: false, rule: r }, null);
            else if (r.operator === "gte" && v !== null) tighten({ value: v, inclusive: true, rule: r }, null);
            else if (r.operator === "lt" && v !== null) tighten(null, { value: v, inclusive: false, rule: r });
            else if (r.operator === "lte" && v !== null) tighten(null, { value: v, inclusive: true, rule: r });
            else if (r.operator === "eq" && v !== null) tighten({ value: v, inclusive: true, rule: r }, { value: v, inclusive: true, rule: r });
            else if (r.operator === "between" && v !== null && v2 !== null) tighten({ value: Math.min(v, v2), inclusive: true, rule: r }, { value: Math.max(v, v2), inclusive: true, rule: r });
          }
          const { lower: lo, upper: hi } = b;
          if (lo && hi && lo.rule !== hi.rule && (lo.value > hi.value || (lo.value === hi.value && !(lo.inclusive && hi.inclusive)))) report("no number satisfies both", [lo.rule, hi.rule]);
        }
      }
      for (const k of c.children) visit(k, report);
      return;
    }
    if (c.source?.count?.where) visit(c.source.count.where, report);
  };
  for (const q of touchedQuestions(ctx)) {
    for (const own of questionConditions(after, q)) {
      if (own.kind !== "display" && own.kind !== "display_rule" && own.kind !== "skip") continue;
      visit(own.c, (why, rules) => {
        out.push({ level: "warning", code: "contradiction", message: `${q.code}'s ${own.where} can never be true: ${rules.map((r) => ruleWords(after, r)).join(" AND ")} — ${why}. ${own.kind === "skip" ? "The skip would never fire" : `${q.code} would never be shown`}; check whether OR was meant, or the bounds.`, objects: [q.id, ...(own.id ? [own.id] : [])] });
      });
    }
  }
  return out;
}
