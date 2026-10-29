import type { Condition, FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import { SurveyDefinition as SurveyDefinitionSchema, Condition as ConditionSchema } from "@rescript/schema";
import { lintSurveyLogic, DESIGN_TASK_TYPES } from "./lintLogic.js";
import { forEachConditionRoot, isConditionGroup, conditionDepth } from "./conditionWalk.js";
import { reviewQuotas } from "./quotaActions.js";
import { validateFlowStructure } from "./flowTree.js";
import { lintCalculations, embeddedReferenceProblems, questionOrder, calculationCycles } from "./dependencies.js";
import { reviewUx } from "./ux.js";
import { flattenVariables } from "./flatten.js";
import { createResponseState } from "./state.js";
import { buildVariableDictionary } from "./variables.js";
import { listBlocks } from "./blocks.js";
import { conjointPlanReadiness, designOfQuestion } from "./conjointSuite.js";
import { NON_RESPONDENT_QUESTION_TYPES, placedQuestionIds } from "./questionCount.js";
import { stripHtmlText } from "./html.js";

/**
 * THE DELIVERABLE CHECK (durable tasks, K2 2026-10-25).
 *
 * One deterministic verdict on a generated or edited survey, reusable by the task engine's completion criteria
 * and by the generation steps' own validation. Every error is STRUCTURED — its class, the question code it is
 * about, and which kind of repair step can fix it — so a repair step is asked about exactly what is wrong (a
 * missing option list on Q137, a skip to a question that does not exist from Q212), never "please fix the survey".
 *
 * Nothing here calls a model, mutates the survey or reads anything but the definition. The checks reuse the
 * engine's own: the survey schema, the logic lint (references, operators, cycles, loops, List Fills, piping,
 * calculations), the quota review, the flow-structure check, the UX script review, the runtime's own
 * flattening, the variable dictionary, and the design readiness of every MaxDiff / conjoint question.
 */

export type DeliverableErrorKind =
  | "count" | "missing_code" | "duplicate_code" | "duplicate_variable" | "duplicate_id" | "missing_text" | "missing_options"
  | "unplaced" | "duplicate_text" | "logic" | "nested_condition" | "quota" | "randomization" | "piping" | "embedded"
  | "calculation" | "script" | "schema" | "runtime" | "design" | "assessment" | "order";

/** which kind of step can repair it: regenerate the question content, rewrite the logic, regenerate the design, or nothing automatic */
export type RepairRoute = "content" | "logic" | "design" | "none";

export interface DeliverableError { kind: DeliverableErrorKind; message: string; code?: string; questionId?: string; path?: string; repair: RepairRoute }

export interface DesignCriterion {
  /** the design question's code / variable (absent: every design question in the survey) */
  target?: string;
  /** the method the request asked for — at least one design question of it must exist */
  kind?: "maxdiff" | "conjoint" | "cbc" | "acbc" | "cva" | "menu";
  /** a CBC design's pooled D-efficiency must reach this (0..1); default 0 (reported only) */
  minEfficiency?: number;
}

export interface DeliverableCriteria {
  /** respondent-facing questions (content, hidden and calculated items excluded) */
  minQuestions?: number;
  maxQuestions?: number;
  exactQuestions?: number;
  /** these codes must exist (the skeleton's slots) */
  requiredCodes?: string[];
  /** unique ids / codes / variables (default on) */
  unique?: boolean;
  /** logic references, nested AND/OR validity, piping, embedded data, calculations (default on) */
  logic?: boolean;
  /** at least this many quotas, each valid */
  minQuotas?: number;
  /** at least this many randomizers, each valid */
  minRandomizers?: number;
  /** UX scripts must pass the sandbox's checks (default on) */
  scripts?: boolean;
  /** the survey must flatten and build a variable dictionary like the runtime does (default on) */
  runtime?: boolean;
  /** two questions may not have the same text (default on) */
  noDuplicateText?: boolean;
  /** MaxDiff / conjoint design validity */
  designs?: DesignCriterion[];
  /** an assessment: checked by `extraChecks.assessment` when given (K4's validateAssessment) */
  assessment?: { expectedCount?: number; requireExplanations?: boolean; requireTopics?: boolean };
  /** only these codes are judged for per-question checks (a batch's slice); survey-wide checks still run */
  scope?: string[];
}

export interface DeliverableValidationReport {
  ok: boolean;
  errors: DeliverableError[];
  warnings: string[];
  stats: { questions: number; respondentQuestions: number; blocks: number; quotas: number; randomizers: number; designs: number; conditions: number };
}

export interface DeliverableExtraChecks {
  /** K4's `validateAssessment(def, opts)` — passed in so the two modules do not depend on each other */
  assessment?: (def: SurveyDefinition, opts: { expectedCount?: number; requireExplanations?: boolean; requireTopics?: boolean }) => { ok: boolean; errors: { code?: string; questionCode?: string; questionId?: string; message: string }[]; warnings?: string[] };
}

const CHOICE_TYPES = new Set(["single_select", "multi_select", "dropdown", "multi_dropdown", "ranking"]);
const ROW_TYPES = new Set(["matrix_single", "matrix_multi", "matrix_numeric", "matrix_text"]);
export const normText = (s: string | undefined): string => stripHtmlText(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** respondent-facing: everything but content / hidden / calculated / embedded items */
export const isRespondentQuestion = (q: Pick<Question, "type">): boolean => !(NON_RESPONDENT_QUESTION_TYPES as readonly string[]).includes(q.type);

function flowNodes(flow: FlowNode[], out: FlowNode[] = []): FlowNode[] {
  for (const n of flow ?? []) {
    out.push(n);
    for (const v of Object.values(n as Record<string, unknown>)) if (Array.isArray(v) && v.some((x) => x && typeof x === "object" && typeof (x as { type?: unknown }).type === "string" && typeof (x as { id?: unknown }).id === "string")) flowNodes(v as FlowNode[], out);
  }
  return out;
}

/** criteria strings ("questions>=300", "unique_codes", "design_valid:CBC1") → criteria — the form a plan's `completion` list carries */
export function parseCompletionCriteria(lines: readonly string[]): DeliverableCriteria {
  /* from a plan, only what is LISTED is judged (a plan leaves out a check the survey already failed before the task) */
  const c: DeliverableCriteria = { unique: false, logic: false, scripts: false, runtime: false, noDuplicateText: false };
  for (const raw of lines ?? []) {
    const s = String(raw).trim();
    let m: RegExpExecArray | null;
    if ((m = /^questions\s*(>=|<=|=)\s*(\d+)$/i.exec(s))) {
      const n = Number(m[2]);
      if (m[1] === ">=") c.minQuestions = n; else if (m[1] === "<=") c.maxQuestions = n; else c.exactQuestions = n;
    } else if ((m = /^codes:(.+)$/i.exec(s))) c.requiredCodes = [...(c.requiredCodes ?? []), ...expandCodes(m[1])];
    else if (/^unique_(codes|ids|variables)$/i.test(s)) c.unique = true;
    else if (/^logic_refs$/i.test(s)) c.logic = true;
    else if ((m = /^quotas\s*>=\s*(\d+)$/i.exec(s))) c.minQuotas = Number(m[1]);
    else if ((m = /^randomizers\s*>=\s*(\d+)$/i.exec(s))) c.minRandomizers = Number(m[1]);
    else if (/^scripts_valid$/i.test(s)) c.scripts = true;
    else if (/^runtime_compatible$/i.test(s)) c.runtime = true;
    else if (/^no_duplicate_text$/i.test(s)) c.noDuplicateText = true;
    else if ((m = /^design_valid(?::([^@]+))?(?:@(\d*\.?\d+))?$/i.exec(s))) {
      const t = m[1]?.trim();
      const kindWord = t && /^(maxdiff|conjoint|cbc|acbc|cva|menu)$/i.test(t) ? (t.toLowerCase() as DesignCriterion["kind"]) : undefined;
      c.designs = [...(c.designs ?? []), { ...(kindWord ? { kind: kindWord } : t ? { target: t } : {}), ...(m[2] ? { minEfficiency: Number(m[2]) } : {}) }];
    } else if ((m = /^assessment(?::(\d+))?$/i.exec(s))) c.assessment = { ...(m[1] ? { expectedCount: Number(m[1]) } : {}), requireExplanations: true, requireTopics: true };
  }
  return c;
}

/** "Q1..Q300" / "Q1,Q2" → codes */
export function expandCodes(spec: string): string[] {
  const out: string[] = [];
  for (const part of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const r = /^([A-Za-z_]*)(\d+)\.\.([A-Za-z_]*)(\d+)$/.exec(part);
    if (r && r[1] === (r[3] || r[1])) { for (let i = Number(r[2]); i <= Number(r[4]) && out.length < 5000; i++) out.push(`${r[1]}${i}`); }
    else out.push(part);
  }
  return out;
}

/** compact the codes for a completion line: Q1..Q300 when contiguous */
export function compactCodes(codes: readonly string[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < codes.length) {
    const m = /^([A-Za-z_]*)(\d+)$/.exec(codes[i]);
    if (!m) { parts.push(codes[i]); i++; continue; }
    let j = i;
    while (j + 1 < codes.length) {
      const n = /^([A-Za-z_]*)(\d+)$/.exec(codes[j + 1]);
      if (!n || n[1] !== m[1] || Number(n[2]) !== Number(m[2]) + (j + 1 - i)) break;
      j++;
    }
    parts.push(j > i ? `${codes[i]}..${codes[j]}` : codes[i]);
    i = j + 1;
  }
  return parts.join(",");
}

function classifyLint(path: string, message: string, questionCode?: string): DeliverableErrorKind {
  if (/not on any page/i.test(message)) return "unplaced";
  if (/quota/i.test(path) || /\bquota\b/i.test(message)) return "quota";
  if (/random/i.test(path) || /randomi[sz]er/i.test(message)) return "randomization";
  if (questionCode === "Calc" || /^calculations/.test(path) || /\bcalculation\b/i.test(message)) return "calculation";
  if (/pip(e|ing)|\{\{/i.test(message)) return "piping";
  if (/embedded/i.test(path) || /embedded data|embedded field/i.test(message)) return "embedded";
  return "logic";
}

export function validateSurveyDeliverable(input: unknown, criteria: DeliverableCriteria = {}, extra: DeliverableExtraChecks = {}): DeliverableValidationReport {
  const errors: DeliverableError[] = [];
  const warnings: string[] = [];
  const add = (e: DeliverableError) => { if (errors.length < 400) errors.push(e); };
  const parsed = SurveyDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 10)) add({ kind: "schema", message: `The survey does not pass the schema at ${i.path.join(".")}: ${i.message}`, path: i.path.join("."), repair: "none" });
    return { ok: false, errors, warnings, stats: { questions: 0, respondentQuestions: 0, blocks: 0, quotas: 0, randomizers: 0, designs: 0, conditions: 0 } };
  }
  const def = parsed.data;
  const scope = criteria.scope ? new Set(criteria.scope.map((c) => c.toUpperCase())) : null;
  const inScope = (q: Question) => !scope || scope.has(String(q.code).toUpperCase());
  const placed = placedQuestionIds(def);
  const respondent = def.questions.filter((q) => isRespondentQuestion(q) && placed.has(q.id));
  const nodes = flowNodes(def.flow as FlowNode[]);
  const randomizers = nodes.filter((n) => n.type === "randomizer");
  let conditions = 0;

  /* ---------------------------------------------------------- count */
  const n = respondent.length;
  if (criteria.exactQuestions !== undefined && n !== criteria.exactQuestions) add({ kind: "count", message: `The survey has ${n} questions; ${criteria.exactQuestions} were requested.`, repair: n < criteria.exactQuestions ? "content" : "none" });
  if (criteria.minQuestions !== undefined && n < criteria.minQuestions) add({ kind: "count", message: `The survey has ${n} questions; at least ${criteria.minQuestions} were requested (${criteria.minQuestions - n} missing).`, repair: "content" });
  if (criteria.maxQuestions !== undefined && n > criteria.maxQuestions) add({ kind: "count", message: `The survey has ${n} questions; at most ${criteria.maxQuestions} were requested.`, repair: "none" });
  if (criteria.requiredCodes?.length) {
    const have = new Set(def.questions.map((q) => String(q.code).toUpperCase()));
    const missing = criteria.requiredCodes.filter((c) => !have.has(c.toUpperCase()));
    for (const c of missing.slice(0, 100)) add({ kind: "missing_code", code: c, message: `${c} was planned but does not exist.`, repair: "content" });
    if (missing.length > 100) warnings.push(`${missing.length - 100} more planned codes are missing.`);
    /* the planned codes in the planned order (the flow's order; codes the plan did not write are ignored) */
    const rank = new Map(criteria.requiredCodes.map((c, i) => [c.toUpperCase(), i]));
    const flowCodes = questionOrder(def).map((id) => def.questions.find((q) => q.id === id)?.code).filter((c): c is string => !!c && rank.has(String(c).toUpperCase())).map(String);
    const firstOut = flowCodes.findIndex((c, i) => i > 0 && rank.get(c.toUpperCase())! < rank.get(flowCodes[i - 1].toUpperCase())!);
    if (firstOut > 0) add({ kind: "order", code: flowCodes[firstOut], message: `${flowCodes[firstOut]} comes after ${flowCodes[firstOut - 1]} — the questions are not in the planned order.`, repair: "content" });
  }

  /* ---------------------------------------------------------- uniqueness */
  if (criteria.unique !== false) {
    const seen = (key: (q: Question) => string, kind: DeliverableErrorKind, what: string) => {
      const by = new Map<string, Question[]>();
      for (const q of def.questions) { const k = key(q).toUpperCase(); if (!k) continue; by.set(k, [...(by.get(k) ?? []), q]); }
      for (const [k, qs] of by) if (qs.length > 1 && qs.some(inScope)) add({ kind, code: String(qs[1].code), questionId: qs[1].id, message: `${what} ${k} is used by ${qs.length} questions (${qs.map((q) => q.code).join(", ")}).`, repair: "content" });
    };
    seen((q) => q.id, "duplicate_id", "Id");
    seen((q) => String(q.code), "duplicate_code", "Code");
    seen((q) => q.variableName, "duplicate_variable", "Variable");
    const calcVars = new Set((def.calculations ?? []).map((c) => c.targetVariable.toUpperCase()));
    for (const q of def.questions) if (calcVars.has(q.variableName.toUpperCase()) && inScope(q)) add({ kind: "duplicate_variable", code: q.code, questionId: q.id, message: `Variable ${q.variableName} is both a question and a calculation.`, repair: "content" });
  }

  /* ---------------------------------------------------------- per question: text, options, placement, duplicates */
  const texts = new Map<string, Question>();
  for (const q of def.questions) {
    if (!inScope(q)) { if (isRespondentQuestion(q)) texts.set(normText(q.text), texts.get(normText(q.text)) ?? q); continue; }
    if (!placed.has(q.id) && isRespondentQuestion(q)) add({ kind: "unplaced", code: q.code, questionId: q.id, message: `${q.code} is not on any page of the flow — no respondent can see it.`, repair: "content" });
    if (!isRespondentQuestion(q)) continue;
    const t = normText(q.text);
    if (!t) add({ kind: "missing_text", code: q.code, questionId: q.id, message: `${q.code} has no question text.`, repair: "content" });
    const supplied = !!q.carryForward || !!((q as { optionPipeline?: unknown[] }).optionPipeline?.length) || !!(q as { listFill?: unknown }).listFill;
    if (CHOICE_TYPES.has(q.type) && !(q.options?.length ?? 0) && !supplied) add({ kind: "missing_options", code: q.code, questionId: q.id, message: `${q.code} (${q.type}) has no options.`, repair: "content" });
    else if (CHOICE_TYPES.has(q.type) && (q.options?.length ?? 0) === 1 && !supplied) add({ kind: "missing_options", code: q.code, questionId: q.id, message: `${q.code} (${q.type}) has only one option.`, repair: "content" });
    if (ROW_TYPES.has(q.type) && !(q.rows?.length ?? 0) && !supplied) add({ kind: "missing_options", code: q.code, questionId: q.id, message: `${q.code} (${q.type}) has no rows.`, repair: "content" });
    if (q.options?.length) {
      const codes = q.options.map((o) => String(o.code));
      const dup = codes.find((c, i) => codes.indexOf(c) !== i);
      if (dup !== undefined) add({ kind: "missing_options", code: q.code, questionId: q.id, message: `${q.code} has option code ${dup} twice.`, repair: "content" });
    }
    if (criteria.noDuplicateText !== false && t && t.length > 12) {
      const other = texts.get(t);
      if (other && other.id !== q.id) add({ kind: "duplicate_text", code: q.code, questionId: q.id, message: `${q.code} asks the same question as ${other.code} (“${stripHtmlText(q.text).slice(0, 80)}”).`, repair: "content" });
      else texts.set(t, q);
    }
  }

  /* ---------------------------------------------------------- logic, piping, embedded data, calculations */
  if (criteria.logic !== false) {
    const byId = new Map(def.questions.map((q) => [q.id, q]));
    for (const i of lintSurveyLogic(def)) {
      const q = i.questionId ? byId.get(i.questionId) : undefined;
      if (q && !inScope(q) && scope) continue;
      const kind = classifyLint(i.path, i.message, i.questionCode);
      if (kind === "unplaced" && errors.some((e) => e.kind === "unplaced" && e.questionId === i.questionId)) continue;
      if (i.level === "error") add({ kind, code: i.questionCode, questionId: i.questionId, path: i.path, message: `${i.questionCode ? `${i.questionCode}: ` : ""}${i.message}`, repair: kind === "unplaced" ? "content" : "logic" });
      else if (warnings.length < 60) warnings.push(`${i.questionCode ? `${i.questionCode}: ` : ""}${i.message}`);
    }
    forEachConditionRoot(def, (c: Condition, loc) => {
      conditions++;
      const q = loc.questionId ? byId.get(loc.questionId) : undefined;
      if (q && scope && !inScope(q)) return;
      const ok = ConditionSchema.safeParse(c);
      if (!ok.success) { add({ kind: "nested_condition", code: q?.code, questionId: loc.questionId, path: loc.path, message: `${loc.where}: the condition is not a valid AND/OR tree (${ok.error.issues[0]?.message ?? "invalid"}).`, repair: "logic" }); return; }
      const walk = (x: Condition): void => {
        if (!isConditionGroup(x)) return;
        if (!x.children.length) add({ kind: "nested_condition", code: q?.code, questionId: loc.questionId, path: loc.path, message: `${loc.where}: an empty ${x.op.toUpperCase()} group.`, repair: "logic" });
        if (x.op === "not" && x.children.length !== 1) add({ kind: "nested_condition", code: q?.code, questionId: loc.questionId, path: loc.path, message: `${loc.where}: NOT must wrap exactly one condition (it wraps ${x.children.length}).`, repair: "logic" });
        x.children.forEach(walk);
      };
      walk(c);
      if (conditionDepth(c) > 8) warnings.push(`${loc.where}: the condition is nested ${conditionDepth(c)} levels deep — hard to review.`);
    });
    for (const m of lintCalculations(def)) if (!errors.some((e) => e.kind === "calculation" && e.message.includes(m))) add({ kind: "calculation", message: m, repair: "logic" });
    for (const cyc of calculationCycles(def)) add({ kind: "calculation", message: `Calculations depend on each other in a circle: ${cyc.join(" → ")}.`, repair: "logic" });
    for (const m of embeddedReferenceProblems(def)) add({ kind: "embedded", message: m, repair: "logic" });
  }

  /* ---------------------------------------------------------- quotas */
  for (const f of reviewQuotas(def)) {
    if (f.severity === "critical") add({ kind: "quota", message: f.message, ...(f.questionIds?.[0] ? { questionId: f.questionIds[0], code: def.questions.find((q) => q.id === f.questionIds![0])?.code } : {}), repair: "logic" });
    else if (warnings.length < 80) warnings.push(f.message);
  }
  if (criteria.minQuotas !== undefined && (def.quotas?.length ?? 0) < criteria.minQuotas) add({ kind: "quota", message: `${def.quotas?.length ?? 0} quota${(def.quotas?.length ?? 0) === 1 ? "" : "s"} defined; ${criteria.minQuotas} requested.`, repair: "logic" });

  /* ---------------------------------------------------------- flow: randomizers, structure */
  for (const i of validateFlowStructure(def.flow as FlowNode[])) {
    if (i.level === "error") add({ kind: /random/i.test(i.message) ? "randomization" : "logic", path: i.nodeId ? `flow:${i.nodeId}` : "flow", message: i.message, repair: "logic" });
    else if (warnings.length < 90) warnings.push(i.message);
  }
  for (const r of randomizers) {
    const kids = ((r as unknown as { children?: unknown[] }).children ?? []).length;
    const show = Number((r as unknown as { show?: number; pick?: number }).show ?? (r as unknown as { pick?: number }).pick ?? 0);
    if (kids < 2) add({ kind: "randomization", path: `flow:${r.id}`, message: `Randomizer “${(r as { title?: string }).title ?? r.id}” has ${kids} element${kids === 1 ? "" : "s"} — nothing to randomize.`, repair: "logic" });
    if (show && show > kids) add({ kind: "randomization", path: `flow:${r.id}`, message: `Randomizer “${(r as { title?: string }).title ?? r.id}” shows ${show} of ${kids} elements.`, repair: "logic" });
  }
  if (criteria.minRandomizers !== undefined && randomizers.length < criteria.minRandomizers) add({ kind: "randomization", message: `${randomizers.length} randomizer${randomizers.length === 1 ? "" : "s"} in the flow; ${criteria.minRandomizers} requested.`, repair: "logic" });

  /* ---------------------------------------------------------- scripts */
  if (criteria.scripts !== false) {
    for (const f of reviewUx(def)) {
      if (f.level === "critical") add({ kind: "script", path: f.itemId ? `ux:${f.itemId}` : "ux", message: f.message, repair: "none" });
    }
  }

  /* ---------------------------------------------------------- the runtime's own reading */
  if (criteria.runtime !== false) {
    try { buildVariableDictionary(def); } catch (e) { add({ kind: "runtime", message: `The variable dictionary cannot be built: ${(e as Error).message}`, repair: "none" }); }
    try { flattenVariables(def, createResponseState(def, { sessionId: "validate", seed: 1 })); } catch (e) { add({ kind: "runtime", message: `The survey cannot be flattened for export as the runtime does: ${(e as Error).message}`, repair: "none" }); }
  }

  /* ---------------------------------------------------------- MaxDiff / conjoint designs */
  const designQs = def.questions.filter((q) => (DESIGN_TASK_TYPES as readonly string[]).includes(q.type));
  if (criteria.designs?.length || designQs.length) {
    const wanted = criteria.designs ?? [];
    for (const w of wanted) {
      if (w.target && !designQs.some((q) => [q.code, q.variableName].some((x) => String(x).toUpperCase() === w.target!.toUpperCase()))) add({ kind: "design", code: w.target, message: `${w.target} is not a MaxDiff / conjoint question with a design.`, repair: "design" });
      if (w.kind && !designQs.some((q) => designKindOf(def, q) === w.kind || (w.kind === "conjoint" && q.type !== "maxdiff_task") || (w.kind === "cbc" && designKindOf(def, q) === "cbc"))) add({ kind: "design", message: `No ${w.kind === "maxdiff" ? "MaxDiff" : w.kind.toUpperCase()} design question exists.`, repair: "design" });
    }
    for (const q of designQs) {
      const w = wanted.find((x) => x.target && [q.code, q.variableName].some((y) => String(y).toUpperCase() === x.target!.toUpperCase())) ?? wanted.find((x) => !x.target);
      for (const e of designProblems(def, q, w?.minEfficiency ?? 0)) (e.error ? add({ kind: "design", code: q.code, questionId: q.id, message: e.message, repair: "design" }) : warnings.push(e.message));
    }
  }

  /* ---------------------------------------------------------- assessment (K4's validator, when given) */
  if (criteria.assessment && extra.assessment) {
    try {
      const r = extra.assessment(def, criteria.assessment);
      for (const e of r.errors) {
        const code = e.questionCode ?? (e.questionId ? def.questions.find((q) => q.id === e.questionId)?.code : undefined);
        if (scope && code && !scope.has(code.toUpperCase())) continue;
        add({ kind: "assessment", ...(code ? { code } : {}), ...(e.questionId ? { questionId: e.questionId } : {}), message: e.message, repair: code ? "content" : "none" });
      }
      for (const w of r.warnings ?? []) if (warnings.length < 100) warnings.push(w);
    } catch (e) { warnings.push(`The assessment check could not run: ${(e as Error).message}`); }
  }

  return {
    ok: errors.length === 0, errors, warnings,
    stats: { questions: def.questions.length, respondentQuestions: n, blocks: listBlocks(def.flow as unknown[]).length, quotas: def.quotas?.length ?? 0, randomizers: randomizers.length, designs: def.designs?.length ?? 0, conditions },
  };
}

/** "maxdiff" | "cbc" | "acbc" | "menu" | "cva" for a design question */
export function designKindOf(def: SurveyDefinition, q: Question): DesignCriterion["kind"] | null {
  if (q.type === "maxdiff_task") return "maxdiff";
  const d = designOfQuestion(def, q);
  if (q.type === "acbc_task" || d?.kind === "acbc") return "acbc";
  if (d?.kind === "menu" || d?.kind === "menu_conjoint") return "menu";
  if (d?.kind === "cva") return "cva";
  return q.type === "conjoint_task" ? "cbc" : null;
}

/** what is wrong with one design question's design (errors block; the rest are said) */
export function designProblems(def: SurveyDefinition, q: Question, minEfficiency = 0): { error: boolean; message: string }[] {
  const out: { error: boolean; message: string }[] = [];
  const d = designOfQuestion(def, q);
  if (!d) { out.push({ error: true, message: `${q.code} has no design — it renders nothing.` }); return out; }
  const cfg = (d.config ?? {}) as Record<string, unknown>;
  const rows = d.file?.rows ?? [];
  const summary = (d.file?.summary ?? {}) as Record<string, unknown>;
  if (q.type === "maxdiff_task") {
    const items = Array.isArray(cfg.items) ? (cfg.items as unknown[]).map(String) : [];
    if (items.length < 3) out.push({ error: true, message: `${q.code}: a MaxDiff needs at least 3 items (${items.length}).` });
    if (new Set(items.map((x) => x.toLowerCase().trim())).size !== items.length) out.push({ error: true, message: `${q.code}: an item is listed twice.` });
    const per = Number(cfg.itemsPerTask ?? 0);
    if (per && per >= items.length) out.push({ error: true, message: `${q.code}: ${per} items per task with ${items.length} items — every task would show everything.` });
    if (!rows.length) out.push({ error: true, message: `${q.code}'s design has no rows — generate it.` });
    const shows = summary.itemShowCounts as Record<string, number> | number[] | undefined;
    const counts = Array.isArray(shows) ? shows : shows && typeof shows === "object" ? Object.values(shows) : [];
    if (counts.length && counts.some((c) => !c)) out.push({ error: true, message: `${q.code}: ${counts.filter((c) => !c).length} item(s) are never shown.` });
    const diag = summary.diagnostics as { duplicatesWithinTask?: number; prohibited?: { violations?: number }; balanced?: boolean; lines?: string[] } | undefined;
    if (diag?.duplicatesWithinTask) out.push({ error: true, message: `${q.code}: ${diag.duplicatesWithinTask} task(s) show an item twice.` });
    if (diag?.prohibited?.violations) out.push({ error: true, message: `${q.code}: ${diag.prohibited.violations} prohibited pair(s) appear together.` });
    if (diag && diag.balanced === false) out.push({ error: false, message: `${q.code}: the MaxDiff design is not exactly balanced${diag.lines?.length ? ` — ${diag.lines[0]}` : ""}.` });
    return out;
  }
  const r = conjointPlanReadiness(def, q);
  for (const i of r.issues) out.push({ error: true, message: i });
  const attrs = Array.isArray(cfg.attributes) ? (cfg.attributes as { name?: string; levels?: unknown[] }[]) : [];
  const kind = designKindOf(def, q);
  if (kind === "cbc" || kind === "acbc" || kind === "cva") {
    if (attrs.length < 2) out.push({ error: true, message: `${q.code}: a conjoint needs at least 2 attributes (${attrs.length}).` });
    for (const a of attrs) if ((a.levels?.length ?? 0) < 2) out.push({ error: true, message: `${q.code}: attribute “${a.name ?? "?"}” has ${(a.levels?.length ?? 0)} level — at least 2 are needed.` });
  }
  if (summary.legalConcepts === 0) out.push({ error: true, message: `${q.code}: the prohibitions leave no legal concept.` });
  const eff = summary.efficiency as { pooled?: number | null; duplicateConceptTasks?: number; minVersionDegreesOfFreedom?: number; parameters?: number } | undefined;
  if (eff?.duplicateConceptTasks) out.push({ error: true, message: `${q.code}: ${eff.duplicateConceptTasks} task(s) show the same concept twice.` });
  if (eff && typeof eff.pooled === "number" && minEfficiency > 0 && eff.pooled < minEfficiency) out.push({ error: true, message: `${q.code}: the design's D-efficiency is ${eff.pooled.toFixed(2)}, below the ${minEfficiency} asked for — more tasks or versions, or fewer prohibitions, would raise it.` });
  if (eff && typeof eff.minVersionDegreesOfFreedom === "number" && typeof eff.parameters === "number" && eff.minVersionDegreesOfFreedom < eff.parameters) out.push({ error: false, message: `${q.code}: one version gives ${eff.minVersionDegreesOfFreedom} choice degrees of freedom for ${eff.parameters} parameters — fine for aggregate logit, too few for individual-level estimates.` });
  for (const w of (summary.warnings as string[] | undefined) ?? []) out.push({ error: false, message: `${q.code}: ${w}` });
  return out;
}
