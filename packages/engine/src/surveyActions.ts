import type { AnalysisPlan, Condition, FlowNode, OptionMask, Question, SurveyDefinition, ValidationRule } from "@rescript/schema";
import { SurveyDefinition as SurveyDefinitionSchema, variantRegistry, Condition as ConditionSchema } from "@rescript/schema";
import { forEachRule, isConditionNode } from "./conditionWalk.js";
import { canonicalizeCondition } from "./optionCodes.js";
import { createQuestionFromVariant } from "./questionCreate.js";
import { defaultIds, removeQuestion, type IdMinter } from "./questionOps.js";
import { listBlocks, listPages } from "./blocks.js";
import { splitPageAfter, joinPageAfter } from "./pageBreaks.js";
import { addEmbeddedField, wrapInLoop } from "./structureOps.js";
import { parseLogicExpression, formatCondition } from "./logicExpression.js";
import { migrateQuestionType } from "./questionShape.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { runQualityCheck } from "./qualityCheck.js";
import { questionOrder, conditionRefs } from "./dependencies.js";
import { applyUxAction, coerceUxAction, isUxOp, UX_ACTION_OPS, type UxAction } from "./uxActions.js";
import { applyAnalysisAction, coerceAnalysisAction, describeAnalysisAction, isAnalysisOp, ANALYSIS_ACTION_OPS, type AnalysisAction } from "./analysisActions.js";
import { describeAnalysisImpact, reviewAnalysisPlan } from "./analysisFramework.js";
import { newResearchBlockers, researchStrict } from "./researchBlockers.js";
import { applyLocalizationAction, coerceLocalizationAction, describeLocalizationAction, isLocalizationOp, localizationRank, outdateTranslations, LOCALIZATION_ACTION_OPS, type LocalizationAction } from "./localizationActions.js";
import { languageName, pruneOrphanedTranslations, movedTranslationKeys } from "./localization.js";
import { applyQuotaAction, coerceQuotaAction, describeQuotaAction, isQuotaOp, quotaDiff, containsQuestion, endIndex, QUOTA_ACTION_OPS, type QuotaAction } from "./quotaActions.js";
import { parsePunchExpression, formatPunchExpression } from "./autoPunch.js";
import { authoringQuestionView } from "./carryforward.js";
import { resolveOptionValue, describeOptions, type OptionList } from "./optionCodes.js";
import { diffUx, type UxDiff } from "./ux.js";
import { applyOptionAction, coerceOptionAction, describeOptionAction, isOptionOp, OPTION_ACTION_OPS, type OptionAction } from "./optionActions.js";
import { validateActionOutcome, type ActionIssue } from "./actionValidation.js";
import { impactOfAction, type ImpactReport } from "./impact.js";
import { applyRename } from "./variableUsage.js";
import { parseSetExpression, formatSetExpression } from "./setExpression.js";
import { withoutPresentation, diffTheme } from "./theme.js";

/**
 * THE COPILOT'S HANDS — a controlled action layer over the survey.
 *
 * The Intelligent copilot's model never writes the survey. It writes ACTIONS
 * in this small vocabulary — create a block, create a question, set this
 * question's display logic to this expression, add a skip, randomize these
 * blocks — and this module is the only thing that turns them into changes:
 *
 *   coerceSurveyActions(raw)        the gate: an object from the wire becomes
 *                                   an action only in a shape listed here
 *   applySurveyActions(def, acts)   each action on a clone, in order; every
 *                                   reference resolved against the REAL survey
 *                                   (codes, variables, ids, block titles, and
 *                                   refs created earlier in the same batch);
 *                                   every condition through the expression
 *                                   editor's own parser; a question made by the
 *                                   picker's own maker. An action that does not
 *                                   resolve is refused with its reason and the
 *                                   rest still apply. The result must pass the
 *                                   schema, and the quality check says what the
 *                                   batch newly broke.
 *   diffSurveys(before, after)      exactly what changed, for the preview
 *
 * Anything that removes or rewrites existing content — deleting, replacing
 * logic, changing a type, replacing options — is reported as DESTRUCTIVE, so
 * the Studio asks before applying it. Nothing here publishes, deploys, or
 * touches response data: those actions do not exist.
 */

/* ------------------------------------------------------------ vocabulary */

export type OptionSpec = string | { label: string; code?: string | number; exclusive?: boolean; other?: boolean; anchor?: boolean };
export interface ScaleSpec { points: number; start?: number; low?: string; high?: string; mid?: string; labels?: string[] }
export interface ValidationSpec {
  kind: string;
  value?: number | string;
  /** the rule applies only while this holds (any nesting) */
  when?: CondInput;
  /** kind "condition": what a valid answer must satisfy (stored negated: the engine's `check` is the invalid case) */
  check?: CondInput;
  message?: string;
}

/**
 * A condition from the model: expression text (`Q3 = 1 AND (Q5 > 2 OR NOT Q7.O4)`)
 * or the structured tree itself. Both go through the same gate — the schema,
 * then option-code canonicalisation — so neither can store what the other
 * would refuse.
 */
export type CondInput = string | Condition;

export type SurveyAction =
  | { op: "create_block"; ref?: string; title: string; after?: string }
  | { op: "rename_block"; target: string; title: string }
  | { op: "delete_block"; target: string }
  | { op: "create_question"; ref?: string; block?: string; after?: string; newPage?: boolean; type: string; text: string; code?: string; variable?: string; options?: OptionSpec[]; rows?: string[]; scale?: ScaleSpec; required?: boolean; randomize?: boolean; instruction?: string; validation?: ValidationSpec[] }
  | { op: "update_question"; target: string; text?: string; type?: string; code?: string; variable?: string; required?: boolean; instruction?: string; options?: OptionSpec[]; addOptions?: OptionSpec[]; removeOptions?: (string | number)[]; rows?: string[]; scale?: ScaleSpec; randomize?: boolean }
  | { op: "delete_question"; target: string }
  | { op: "move_question"; target: string; block?: string; after?: string }
  | { op: "set_display_logic"; target: string; expression: CondInput | null }
  | { op: "add_skip"; from: string; when: CondInput; to: string }
  | { op: "clear_skips"; target: string }
  | { op: "set_validation"; target: string; rules: ValidationSpec[] }
  | { op: "page_break"; after: string; remove?: boolean }
  | { op: "create_embedded"; name: string; source?: "url" | "static" | "panel" | "expression"; value?: string }
  | { op: "create_calculation"; name: string; expression: string; label?: string; dataType?: "numeric" | "text" | "boolean" }
  | { op: "create_randomizer"; blocks: string[]; show?: number; title?: string }
  | { op: "create_branch"; blocks: string[]; when: CondInput; title?: string; arms?: { blocks: string[]; when: CondInput; label?: string }[]; otherwise?: string[] }
  | { op: "create_loop"; from: string; to: string; over?: string; items?: string[]; loopVar?: string; title?: string }
  | { op: "set_research"; strict?: boolean; objective?: string; hypotheses?: string[]; population?: string; sampleSize?: number; methodology?: string; constructs?: { name: string; role?: string; definition?: string; questions?: string[] }[]; analysis?: string[]; assumptions?: string[]; sources?: string[];
      /** Phase 3: the questions the research answers, the KPIs it reports, who it is written for */
      researchQuestions?: string[]; kpis?: { name: string; variable?: string; measure?: string; target?: string; direction?: "higher" | "lower" }[]; audience?: { description: string; characteristics?: string[]; literacy?: "plain" | "general" | "expert"; tone?: string; language?: string } }
  /* criteria-based coding (punching): IF <when> THEN code <target> — on the target question's punch rules */
  | { op: "add_punch"; target: string; when?: CondInput; action?: "select" | "deselect" | "set_value" | "clear"; codes?: (string | number)[]; value?: string | number; expression?: string; label?: string; mode?: "if" | "else_if" | "else"; recompute?: "once" | "always" }
  | { op: "remove_punches"; target: string; id?: string }
  /* the survey's look and behaviour — see uxActions.ts; they write def.ux and nothing else */
  | UxAction
  /* the analysis framework — see analysisActions.ts; they write question.analysis and research.analysisPlan and nothing else */
  | AnalysisAction
  /* languages, translations, glossary and language routing — see localizationActions.ts; they write def.localization and nothing else */
  | LocalizationAction
  | QuotaAction
  /* options one at a time, masks, duplication, survey settings, embedded fields, hypotheses, custom code — see optionActions.ts */
  | OptionAction;

export const SURVEY_ACTION_OPS = [
  "create_block", "rename_block", "delete_block", "create_question", "update_question", "delete_question", "move_question",
  "set_display_logic", "add_skip", "clear_skips", "set_validation", "page_break", "create_embedded", "create_calculation",
  "create_randomizer", "create_branch", "create_loop", "set_research", "add_punch", "remove_punches",
  ...UX_ACTION_OPS,
  ...ANALYSIS_ACTION_OPS,
  ...LOCALIZATION_ACTION_OPS, ...QUOTA_ACTION_OPS,
  ...OPTION_ACTION_OPS,
] as const;

/** Friendly question types → the Studio variant that makes them. */
export const ACTION_TYPES: Record<string, string> = {
  single: "single_select.radio", single_select: "single_select.radio", radio: "single_select.radio", single_choice: "single_select.radio",
  yes_no: "single_select.radio", rating: "single_select.radio", scale: "single_select.radio", likert: "single_select.radio",
  multi: "multi_select.checkbox", multi_select: "multi_select.checkbox", checkbox: "multi_select.checkbox", multiple_choice: "multi_select.checkbox",
  dropdown: "single_select.dropdown", select: "single_select.dropdown",
  text: "text.single_line", short_text: "text.single_line", open_text: "text.single_line",
  long_text: "text.multi_line", open_end: "text.multi_line", open_ended: "text.multi_line", textarea: "text.multi_line", essay: "text.multi_line", comment: "text.multi_line",
  email: "text.email", phone: "text.phone", zip: "text.zip", url: "text.url",
  numeric: "numeric.open", number: "numeric.open", integer: "numeric.integer", currency: "numeric.currency", percentage: "numeric.percentage",
  date: "datetime.date", time: "datetime.time",
  nps: "single_select.nps", stars: "single_select.stars", star_rating: "single_select.stars",
  matrix: "matrix.single", matrix_single: "matrix.single", grid: "matrix.single", likert_matrix: "matrix.likert", matrix_likert: "matrix.likert",
  matrix_multi: "matrix.multi", matrix_text: "matrix.text", matrix_numeric: "matrix.numeric",
  ranking: "ranking.drag", rank: "ranking.drag",
  slider: "slider.single",
  constant_sum: "allocation.constant_sum", allocation: "allocation.constant_sum",
  descriptive: "content.html", text_block: "content.html", info: "content.html", instructions: "content.html", intro: "content.html",
  hidden: "calculated.hidden", hidden_variable: "calculated.hidden",
  file_upload: "upload.file", upload: "upload.file",
  maxdiff: "maxdiff.best_worst",
};
export function variantForActionType(type: string): string | null {
  const t = type.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (ACTION_TYPES[t]) return ACTION_TYPES[t];
  return variantRegistry.get(type.trim()) ? type.trim() : null;
}

/** "exactly N selections" is said as one rule and stored as the two the engine checks */
const EXACT_SELECTIONS = "exact_selections";
const VALIDATION_KINDS = new Set([EXACT_SELECTIONS, "required", "min_value", "max_value", "min_length", "max_length", "min_selections", "max_selections", "sum_equals", "sum_max", "sum_min", "pattern", "email", "phone", "url", "zip", "date_min", "date_max", "integer", "condition"]);

/* ------------------------------------------------------------ the gate */

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** expression text, or a structured condition tree (cloned — nothing of the model's object is kept by reference) */
const condIn = (v: unknown): CondInput | undefined =>
  typeof v === "string" ? str(v) : isConditionNode(v) ? (JSON.parse(JSON.stringify(v)) as Condition) : undefined;
const strOrNum = (v: unknown): string | number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : str(v));
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const strs = (v: unknown, max = 200): string[] | undefined => (Array.isArray(v) ? v.map(str).filter((x): x is string => !!x).slice(0, max) : undefined);
const optionSpec = (v: unknown): OptionSpec | null => {
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, 300);
  if (typeof v === "number") return String(v);
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const label = str(o.label) ?? str(o.text);
  if (!label) return null;
  return { label: label.slice(0, 300), ...(strOrNum(o.code) !== undefined ? { code: strOrNum(o.code) } : {}), ...(bool(o.exclusive) ? { exclusive: true } : {}), ...(bool(o.other) || bool(o.otherSpecify) ? { other: true } : {}), ...(bool(o.anchor) ? { anchor: true } : {}) };
};
const options = (v: unknown): OptionSpec[] | undefined => (Array.isArray(v) ? v.map(optionSpec).filter((x): x is OptionSpec => !!x).slice(0, 200) : undefined);
const scale = (v: unknown): ScaleSpec | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const points = Number(o.points);
  if (!Number.isInteger(points) || points < 2 || points > 11) return undefined;
  return { points, ...(Number.isInteger(Number(o.start)) && o.start !== undefined && o.start !== null ? { start: Number(o.start) } : {}), ...(str(o.low) ? { low: str(o.low) } : {}), ...(str(o.high) ? { high: str(o.high) } : {}), ...(str(o.mid) ? { mid: str(o.mid) } : {}), ...(strs(o.labels, 11) ? { labels: strs(o.labels, 11) } : {}) };
};
const validations = (v: unknown): ValidationSpec[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const kind = str(o.kind) ?? (o.check !== undefined || o.condition !== undefined ? "condition" : undefined);
    if (!kind || !VALIDATION_KINDS.has(kind)) return [];
    const value = strOrNum(o.value);
    const when = condIn(o.when);
    const check = condIn(o.check ?? o.condition);
    if (kind === "condition" && !check) return [];
    const rest = { ...(when ? { when } : {}), ...(check ? { check } : {}), ...(str(o.message) ? { message: str(o.message)!.slice(0, 300) } : {}) };
    if (kind === EXACT_SELECTIONS) return value === undefined ? [] : [{ kind: "min_selections", value, ...rest }, { kind: "max_selections", value, ...rest }];
    return [{ kind, ...(value !== undefined ? { value } : {}), ...rest }];
  });
};

export interface CoercedActions { actions: SurveyAction[]; rejected: { index: number; reason: string }[] }

/** The gate on the model's actions: known ops only, strings where strings belong, nothing extra carried. */
export function coerceSurveyActions(raw: unknown, max = 400): CoercedActions {
  const actions: SurveyAction[] = [];
  const rejected: { index: number; reason: string }[] = [];
  const list = Array.isArray(raw) ? raw.slice(0, max) : [];
  list.forEach((item, index) => {
    const a = coerceOne(item);
    if (typeof a === "string") rejected.push({ index, reason: a }); else actions.push(a);
  });
  if (Array.isArray(raw) && raw.length > max) rejected.push({ index: max, reason: `only the first ${max} actions are read` });
  return { actions, rejected };
}

function coerceOne(item: unknown): SurveyAction | string {
  if (!item || typeof item !== "object") return "not an object";
  const o = item as Record<string, unknown>;
  const op = str(o.op) ?? str(o.action);
  switch (op) {
    case "create_block": {
      const title = str(o.title); if (!title) return "create_block needs a title";
      return { op, title: title.slice(0, 160), ...(str(o.ref) ? { ref: str(o.ref) } : {}), ...(str(o.after) ? { after: str(o.after) } : {}) };
    }
    case "rename_block": { const target = str(o.target), title = str(o.title); return target && title ? { op, target, title: title.slice(0, 160) } : "rename_block needs target and title"; }
    case "delete_block": { const target = str(o.target); return target ? { op, target } : "delete_block needs a target"; }
    case "create_question": {
      const type = str(o.type), text = str(o.text);
      if (!type || !text) return "create_question needs type and text";
      return {
        op, type, text: text.slice(0, 4000),
        ...(str(o.ref) ? { ref: str(o.ref) } : {}), ...(str(o.block) ? { block: str(o.block) } : {}), ...(str(o.after) ? { after: str(o.after) } : {}),
        ...(bool(o.newPage) ? { newPage: true } : {}), ...(str(o.code) ? { code: str(o.code) } : {}), ...(str(o.variable) ? { variable: str(o.variable) } : {}),
        ...(options(o.options) ? { options: options(o.options) } : {}), ...(strs(o.rows) ? { rows: strs(o.rows) } : {}), ...(scale(o.scale) ? { scale: scale(o.scale) } : {}),
        ...(bool(o.required) !== undefined ? { required: bool(o.required) } : {}), ...(bool(o.randomize) ? { randomize: true } : {}),
        ...(str(o.instruction) ? { instruction: str(o.instruction)!.slice(0, 600) } : {}), ...(validations(o.validation)?.length ? { validation: validations(o.validation) } : {}),
      };
    }
    case "update_question": {
      const target = str(o.target); if (!target) return "update_question needs a target";
      const a: Extract<SurveyAction, { op: "update_question" }> = { op, target };
      if (str(o.text)) a.text = str(o.text)!.slice(0, 4000);
      if (str(o.type)) a.type = str(o.type);
      if (str(o.code)) a.code = str(o.code);
      if (str(o.variable)) a.variable = str(o.variable);
      if (bool(o.required) !== undefined) a.required = bool(o.required);
      if (typeof o.instruction === "string") a.instruction = o.instruction.slice(0, 600);
      if (options(o.options)) a.options = options(o.options);
      if (options(o.addOptions)) a.addOptions = options(o.addOptions);
      if (Array.isArray(o.removeOptions)) a.removeOptions = o.removeOptions.map(strOrNum).filter((x): x is string | number => x !== undefined);
      if (strs(o.rows)) a.rows = strs(o.rows);
      if (scale(o.scale)) a.scale = scale(o.scale);
      if (bool(o.randomize) !== undefined) a.randomize = bool(o.randomize);
      return Object.keys(a).length > 2 ? a : "update_question changes nothing";
    }
    case "delete_question": { const target = str(o.target); return target ? { op, target } : "delete_question needs a target"; }
    case "move_question": { const target = str(o.target); if (!target || (!str(o.block) && !str(o.after))) return "move_question needs a target and a block or after"; return { op, target, ...(str(o.block) ? { block: str(o.block) } : {}), ...(str(o.after) ? { after: str(o.after) } : {}) }; }
    case "set_display_logic": { const target = str(o.target); if (!target) return "set_display_logic needs a target"; const raw = o.expression !== undefined ? o.expression : o.condition !== undefined ? o.condition : o.when; const e = raw === null ? null : condIn(raw); if (e === undefined) return "set_display_logic needs an expression or a condition (or null to remove it)"; return { op, target, expression: e }; }
    case "add_skip": { const from = str(o.from), when = condIn(o.when ?? o.condition), to = str(o.to); return from && when && to ? { op, from, when, to } : "add_skip needs from, when and to"; }
    case "clear_skips": { const target = str(o.target); return target ? { op, target } : "clear_skips needs a target"; }
    case "set_validation": { const target = str(o.target); const rules = validations(o.rules); return target && rules ? { op, target, rules } : "set_validation needs a target and rules"; }
    case "add_punch": case "punch": case "code_response": {
      const expression = str(o.expression) ?? str(o.rule);
      const target = str(o.target) ?? str(o.question);
      if (!expression && !target) return "add_punch needs a target (the question to code) or an expression “IF … THEN SET Q = …”";
      const action = ["select", "deselect", "set_value", "clear"].includes(String(o.action)) ? (o.action as "select" | "deselect" | "set_value" | "clear") : undefined;
      const codes = Array.isArray(o.codes) ? o.codes.map((c) => strOrNum(c)).filter((c): c is string | number => c !== undefined).slice(0, 50) : o.code !== undefined && strOrNum(o.code) !== undefined ? [strOrNum(o.code)!] : undefined;
      const value = strOrNum(o.value);
      const pWhen = condIn(o.when ?? o.condition);
      if (!expression && !pWhen && o.mode !== "else") return "add_punch needs when (the criteria) — e.g. “Q3 = 1”";
      if (!expression && !codes?.length && value === undefined && action !== "clear") return "add_punch needs codes or a value to code the response as";
      return { op: "add_punch", ...(target ? { target } : { target: "" }), ...(pWhen ? { when: pWhen } : {}), ...(action ? { action } : {}), ...(codes?.length ? { codes } : {}), ...(value !== undefined ? { value } : {}), ...(expression ? { expression } : {}), ...(str(o.label) ? { label: str(o.label)!.slice(0, 120) } : {}), ...(["if", "else_if", "else"].includes(String(o.mode)) ? { mode: o.mode as "if" } : {}), ...(o.recompute === "once" || o.recompute === "always" ? { recompute: o.recompute } : {}) };
    }
    case "remove_punches": case "clear_punches": { const target = str(o.target); return target ? { op: "remove_punches", target, ...(str(o.id) ? { id: str(o.id) } : {}) } : "remove_punches needs a target"; }
    case "page_break": { const after = str(o.after); return after ? { op, after, ...(bool(o.remove) ? { remove: true } : {}) } : "page_break needs after"; }
    case "create_embedded": {
      const name = str(o.name); if (!name) return "create_embedded needs a name";
      const source = ["url", "static", "panel", "expression"].includes(String(o.source)) ? (o.source as "url") : (str(o.value) ? "static" : "url");
      return { op, name, source, ...(str(o.value) ? { value: str(o.value) } : {}) };
    }
    case "create_calculation": { const name = str(o.name), expression = str(o.expression); return name && expression ? { op, name, expression, ...(str(o.label) ? { label: str(o.label) } : {}), ...(["numeric", "text", "boolean"].includes(String(o.dataType)) ? { dataType: o.dataType as "numeric" } : {}) } : "create_calculation needs name and expression"; }
    case "create_randomizer": { const blocks = strs(o.blocks); if (!blocks || blocks.length < 2) return "create_randomizer needs two or more blocks"; const show = Number(o.show); return { op, blocks, ...(Number.isInteger(show) && show > 0 ? { show } : {}), ...(str(o.title) ? { title: str(o.title) } : {}) }; }
    case "create_branch": {
      /* one arm (blocks + when), or several (arms) — first match wins — and an optional otherwise */
      const arms = Array.isArray(o.arms) ? o.arms.map((x) => { const r = (x ?? {}) as Record<string, unknown>; const blocks = strs(r.blocks), when = condIn(r.when ?? r.condition); return blocks?.length && when ? { blocks, when, ...(str(r.label) ? { label: str(r.label) } : {}) } : null; }).filter((x): x is { blocks: string[]; when: CondInput; label?: string } => !!x) : [];
      const blocks = strs(o.blocks), when = condIn(o.when ?? o.condition);
      const otherwise = strs(o.otherwise);
      if (!arms.length && !(blocks?.length && when)) return "create_branch needs blocks and when (or arms: [{ blocks, when }])";
      const first = arms[0] ?? { blocks: blocks!, when: when! };
      return { op, blocks: first.blocks, when: first.when, ...(str(o.title) ? { title: str(o.title) } : {}), ...(arms.length > 1 ? { arms: arms.slice(1) } : {}), ...(otherwise?.length ? { otherwise } : {}) };
    }
    case "create_loop": {
      const from = str(o.from), to = str(o.to) ?? str(o.from);
      if (!from || !to) return "create_loop needs from (and to)";
      const items = strs(o.items, 100);
      if (!str(o.over) && !items?.length) return "create_loop needs over (a question) or items";
      return { op, from, to, ...(str(o.over) ? { over: str(o.over) } : {}), ...(items?.length ? { items } : {}), ...(str(o.loopVar) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(str(o.loopVar)!) ? { loopVar: str(o.loopVar) } : {}), ...(str(o.title) ? { title: str(o.title) } : {}) };
    }
    case "set_research": {
      const constructs = Array.isArray(o.constructs) ? o.constructs.map((c) => { const x = (c ?? {}) as Record<string, unknown>; const name = str(x.name); return name ? { name, ...(str(x.role) ? { role: str(x.role) } : {}), ...(str(x.definition) ? { definition: str(x.definition) } : {}), ...(strs(x.questions) ? { questions: strs(x.questions) } : {}) } : null; }).filter((x): x is NonNullable<typeof x> => !!x) : undefined;
      const kpis = Array.isArray(o.kpis) ? o.kpis.map((k) => { const x = (k ?? {}) as Record<string, unknown>; const name = str(x.name); return name ? { name, ...(str(x.variable) ? { variable: str(x.variable) } : {}), ...(str(x.measure) ? { measure: str(x.measure) } : {}), ...(str(x.target) ? { target: str(x.target) } : {}), ...(x.direction === "higher" || x.direction === "lower" ? { direction: x.direction as "higher" | "lower" } : {}) } : null; }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 20) : undefined;
      const au = o.audience && typeof o.audience === "object" ? (o.audience as Record<string, unknown>) : typeof o.audience === "string" ? { description: o.audience } : null;
      const audience = au && str(au.description) ? { description: str(au.description)!, ...(strs(au.characteristics) ? { characteristics: strs(au.characteristics) } : {}), ...(au.literacy === "plain" || au.literacy === "general" || au.literacy === "expert" ? { literacy: au.literacy as "plain" | "general" | "expert" } : {}), ...(str(au.tone) ? { tone: str(au.tone) } : {}), ...(str(au.language) ? { language: str(au.language) } : {}) } : undefined;
      return { op, ...(typeof o.strict === "boolean" ? { strict: o.strict } : {}), ...(str(o.objective) ? { objective: str(o.objective) } : {}), ...(strs(o.hypotheses) ? { hypotheses: strs(o.hypotheses) } : {}), ...(str(o.population) ? { population: str(o.population) } : {}), ...(Number.isInteger(Number(o.sampleSize)) && Number(o.sampleSize) > 0 ? { sampleSize: Number(o.sampleSize) } : {}), ...(str(o.methodology) ? { methodology: str(o.methodology) } : {}), ...(constructs ? { constructs } : {}), ...(strs(o.analysis) ? { analysis: strs(o.analysis) } : {}), ...(strs(o.assumptions) ? { assumptions: strs(o.assumptions) } : {}), ...(strs(o.sources) ? { sources: strs(o.sources) } : {}), ...(strs(o.researchQuestions) ? { researchQuestions: strs(o.researchQuestions) } : {}), ...(kpis ? { kpis } : {}), ...(audience ? { audience } : {}) };
    }
    default: {
      const ux = op ? coerceUxAction(op, o) : null;
      if (ux !== null) return ux;
      const an = op ? coerceAnalysisAction(op, o) : null;
      if (an !== null) return an;
      const lc = op ? coerceLocalizationAction(op, o) : null;
      if (lc !== null) return lc;
      const qa = op ? coerceQuotaAction(op, o) : null;
      if (qa !== null) return qa;
      const oa = op ? coerceOptionAction(op, o) : null;
      if (oa !== null) return oa;
      return op ? `unknown action “${op}”` : "an action needs an op";
    }
  }
}

/* ------------------------------------------------------------ applying */

export interface ActionResult {
  index: number;
  op: string;
  ok: boolean;
  /** what it did, in words: "Created Q5 (single choice) in Screening" */
  description: string;
  error?: string;
  /** set when the action removes or rewrites existing content */
  destructive?: string;
  /** the question / block ids it touched */
  touched: string[];
  /** what the pre-apply validation found: errors refused the action (then `ok` is false), warnings travel with it */
  issues?: ActionIssue[];
  /** a corrected action the Studio can offer as "Apply suggested fix" when the validation refused this one */
  suggestion?: SurveyAction;
  /** what else this action touches — dependents by kind, for the review (only for actions that remove, recode, retype, move or rename) */
  impact?: ImpactReport;
}
export interface ApplyActionsOutcome {
  /** the survey after every action that could be applied (the input is never mutated) */
  def: SurveyDefinition;
  results: ActionResult[];
  /** actions that were refused */
  errors: string[];
  /** survey problems the batch introduced (the quality check, before vs after) */
  warnings: string[];
  destructive: string[];
  /** batch refs → the ids they became */
  refs: Record<string, string>;
  /** false when the result did not pass the schema — then `def` is the input, unchanged */
  valid: boolean;
  /** every applied action was a look-and-behaviour change */
  uxOnly: boolean;
  /** questions, options, codes, logic, validation, flow: identical before and after (only `ux` may differ) */
  structureUnchanged: boolean;
}

interface Ctx { def: SurveyDefinition; ids: IdMinter; refs: Map<string, string>; blockRefs: Map<string, string>; uxRefs: Map<string, string>; lastBlock: string | null; now: string; uxWarnings: string[] }

type PageNode = Extract<FlowNode, { type: "page" }>;

/**
 * `uxOnly`: the request was about the look and behaviour only ("don't change
 * the logic, only improve the UI") — every structural action is refused, and
 * the outcome proves the structure did not change.
 */
export function applySurveyActions(input: SurveyDefinition, actions: SurveyAction[], opts: { ids?: IdMinter; now?: string; uxOnly?: boolean } = {}): ApplyActionsOutcome {
  const before = input;
  let def = structuredClone(input) as SurveyDefinition;
  const ctx: Ctx = { def, ids: opts.ids ?? defaultIds, refs: new Map(), blockRefs: new Map(), uxRefs: new Map(), lastBlock: null, now: opts.now ?? new Date().toISOString(), uxWarnings: [] };
  const results: ActionResult[] = [];
  // the research design names the questions that measure each construct, and UX targets name questions: both after the questions exist
  // …and the analysis framework names questions and constructs: after both
  // …and translations name the question texts as they will be: last of all
  const rank = (a: SurveyAction) => (isLocalizationOp(a.op) ? 4 + localizationRank(a.op) / 10 : isAnalysisOp(a.op) ? 3 : a.op === "set_research" ? 2 : isUxOp(a.op) ? 1 : isQuotaOp(a.op) ? 0.5 : 0);
  const order = actions.map((a, index) => ({ a, index })).sort((x, y) => rank(x.a) - rank(y.a));
  order.forEach(({ a, index }) => {
    const snapshot = structuredClone(def) as SurveyDefinition;
    ctx.def = def;
    if (opts.uxOnly && !isUxOp(a.op)) {
      results.push({ index, op: a.op, ok: false, description: describeAction(a), error: "this request is about the look and behaviour only, so structural changes are refused — ask for them separately if you want them", touched: [] });
      return;
    }
    try {
      const r = apply(ctx, a);
      /*
       * VALIDATED BEFORE IT IS ACCEPTED, not linted afterwards: a forward
       * reference, an operator the source cannot answer, a comparison with an
       * option that no longer exists, a cycle, a validation rule that does not
       * fit the type — each is refused here with the object named and, where
       * one is obvious, the corrected action to offer instead. The quality
       * check below still reports what a batch newly broke; it is no longer
       * the only line of defence.
       */
      const issues = validateActionOutcome(snapshot, ctx.def, a, r.touched ?? []);
      const blocking = issues.filter((i) => i.level === "error");
      if (blocking.length) {
        def = snapshot; ctx.def = def;
        results.push({ index, op: a.op, ok: false, description: describeAction(a), error: blocking.map((i) => i.message).join(" "), touched: [], issues, ...(blocking.find((i) => i.suggestion)?.suggestion ? { suggestion: blocking.find((i) => i.suggestion)!.suggestion } : {}) });
        return;
      }
      const impact = IMPACT_OPS.has(a.op) ? impactOfAction(snapshot, ctx.def, a, r.touched ?? []) : undefined;
      results.push({ index, op: a.op, ok: true, description: r.description, touched: r.touched ?? [], ...(r.destructive ? { destructive: r.destructive } : {}), ...(issues.length ? { issues } : {}), ...(impact && impact.count ? { impact } : {}) });
    } catch (e) {
      def = snapshot; ctx.def = def;
      results.push({ index, op: a.op, ok: false, description: describeAction(a), error: (e as Error).message, touched: [] });
    }
    def = ctx.def;
  });
  /*
   * TRANSLATIONS WHOSE SOURCE THIS BATCH CHANGED are marked outdated now, not
   * discovered later in the Localization panel — and reported, so the
   * researcher is asked whether to re-translate rather than finding German
   * respondents reading last week's question.
   */
  const stale = outdateTranslations(def);
  if (stale.outdated) ctx.uxWarnings.push(`${stale.outdated} translation${stale.outdated === 1 ? " is" : "s are"} now outdated (${stale.languages.join(", ")}) — the source text changed; ask to re-translate them, or confirm them in Localization.`);
  /*
   * …and TRANSLATIONS WHOSE ELEMENT THIS BATCH REMOVED are dropped, not left
   * as orphans that no screen shows and every count includes. A recode moved
   * its option's translations already (update_option); an option list rebuilt
   * from labels is rescued by its source hash. What is dropped is said.
   */
  const orphans = pruneOrphanedTranslations(def);
  if (orphans.dropped) ctx.uxWarnings.push(`${orphans.dropped} translation${orphans.dropped === 1 ? "" : "s"} (${orphans.languages.join(", ")}) of removed elements ${orphans.dropped === 1 ? "was" : "were"} dropped.`);
  const parsed = SurveyDefinitionSchema.safeParse(def);
  results.sort((x, y) => x.index - y.index);
  const errors = results.filter((r) => !r.ok).map((r) => `${describeAction(actions[r.index])}: ${r.error}`);
  if (!parsed.success) {
    return { def: before, results, errors: [...errors, ...parsed.error.issues.slice(0, 5).map((i) => `The result does not pass the survey schema at ${i.path.join(".")}: ${i.message}`)], warnings: [], destructive: [], refs: Object.fromEntries(ctx.refs), valid: false, uxOnly: false, structureUnchanged: false };
  }
  const after = parsed.data;
  /*
   * THE RESEARCH DESIGN ENFORCED (Phase 7). When the researcher asked for
   * it, a batch that opens a research-level gap — a construct left with no
   * question, a planned analysis reading a variable this batch removed, a
   * KPI pointing at nothing, a hypothesis nothing tests — is refused whole,
   * with each gap named and the way to close it. Only gaps the batch OPENS
   * block: the ones the design had already are the review's to list, and
   * turning enforcement on with gaps present is allowed (it is how they
   * become visible as blockers).
   */
  if (researchStrict(after) || researchStrict(before)) {
    const opened = newResearchBlockers(before, after);
    if (opened.length) {
      const said = opened.map((b) => `${b.message}${b.suggestion ? ` ${b.suggestion}` : ""}`).join(" ");
      const blockedBy = `Blocked by the research design (enforced): ${said} Ask “stop enforcing the research design” to make this a warning instead.`;
      return { def: before, results: results.map((r) => (r.ok ? { ...r, ok: false, error: blockedBy } : r)), errors: [...errors, blockedBy], warnings: [], destructive: [], refs: Object.fromEntries(ctx.refs), valid: false, uxOnly: false, structureUnchanged: false };
    }
  }
  const baseline = SurveyDefinitionSchema.safeParse(before);
  const structureUnchanged = JSON.stringify(withoutPresentation(baseline.success ? baseline.data : before)) === JSON.stringify(withoutPresentation(after));
  const applied = results.filter((r) => r.ok);
  const uxOnly = applied.length > 0 && applied.every((r) => isUxOp(r.op));
  const beforeIssues = new Set(runQualityCheck(before).areas.flatMap((x) => x.issues).filter((i) => i.level === "error").map((i) => i.message));
  const warnings = runQualityCheck(after).areas.flatMap((x) => x.issues).filter((i) => i.level === "error" && !beforeIssues.has(i.message)).map((i) => `${i.questionCode ? `${i.questionCode}: ` : ""}${i.message}`);
  const validationWarnings = results.flatMap((r) => (r.issues ?? []).filter((i) => i.level === "warning").map((i) => i.message));
  /*
   * WHAT THE BATCH DID TO THE ANALYSIS PLAN. A type change, a removed option,
   * a deleted question can leave a planned test grouping by an open text or
   * an ANOVA with two groups; the plan's own review says so, and what it says
   * now that it did not say before is reported with the batch — at the change,
   * not discovered later in the Analysis tab.
   */
  const planWarnings: string[] = [];
  if (before.research?.analysisPlan || after.research?.analysisPlan) {
    try {
      // every level: only what the batch newly caused is said, so a suggestion it caused ("two groups now — a t-test") is news too
      const had = new Set(reviewAnalysisPlan(before).map((i) => i.message));
      for (const i of reviewAnalysisPlan(after)) if (!had.has(i.message)) planWarnings.push(`Analysis plan: ${i.message}${i.suggestion ? ` ${i.suggestion}` : ""}`);
    } catch { /* a half-formed plan must not take the batch down */ }
  }
  return { def: after, results, errors, warnings: [...new Set([...warnings, ...validationWarnings, ...planWarnings, ...ctx.uxWarnings])].slice(0, 40), destructive: results.filter((r) => r.ok && r.destructive).map((r) => r.destructive!), refs: Object.fromEntries([...ctx.refs, ...ctx.uxRefs]), valid: true, uxOnly, structureUnchanged };
}

class ActionError extends Error {}
const fail = (m: string): never => { throw new ActionError(m); };
/** the actions whose dependents are worth listing before applying */
const IMPACT_OPS = new Set(["delete_question", "delete_block", "update_question", "update_option", "move_question", "set_display_logic", "update_embedded", "remove_embedded"]);

function apply(ctx: Ctx, a: SurveyAction): { description: string; destructive?: string; touched?: string[] } {
  const def = ctx.def;
  switch (a.op) {
    case "create_block": {
      const id = ctx.ids("block");
      const node = { type: "block", id, title: a.title, children: [{ type: "page", id: ctx.ids("page"), questionIds: [] }] } as unknown as FlowNode;
      const flow = def.flow as FlowNode[];
      let at: number;
      if (a.after && a.after.toLowerCase() === "start") at = leadingSetupEnd(flow);
      else if (a.after && a.after.toLowerCase() !== "end") at = topIndexOf(flow, resolveBlock(ctx, a.after)) + 1;
      else at = endIndex(flow);
      flow.splice(at, 0, node);
      if (a.ref) ctx.blockRefs.set(a.ref.toLowerCase(), id);
      ctx.lastBlock = id;
      return { description: `Created block “${a.title}”`, touched: [id] };
    }
    case "rename_block": {
      const id = resolveBlock(ctx, a.target);
      const node = findFlow(def.flow as FlowNode[], id) as { title?: string };
      const old = node.title;
      node.title = a.title;
      return { description: `Renamed block ${old ? `“${old}” ` : ""}to “${a.title}”`, touched: [id] };
    }
    case "delete_block": {
      const id = resolveBlock(ctx, a.target);
      const block = listBlocks(def.flow as unknown[]).find((b) => b.id === id)!;
      const qids = block.pages.flatMap((p) => p.node.questionIds);
      const codes = qids.map((q) => def.questions.find((x) => x.id === q)?.code ?? q);
      for (const q of qids) removeQuestion(def, q);
      const removed = removeFlow(def.flow as FlowNode[], id);
      if (!removed) fail(`block ${a.target} is not where it can be removed`);
      return { description: `Deleted block “${block.title ?? id}”${codes.length ? ` and its ${codes.length} question${codes.length === 1 ? "" : "s"} (${codes.join(", ")})` : ""}`, destructive: `Deletes block “${block.title ?? id}”${codes.length ? ` with ${codes.join(", ")}` : ""}`, touched: [id, ...qids] };
    }
    case "create_question": {
      const variantId = variantForActionType(a.type) ?? fail(`“${a.type}” is not a question type the Studio knows`);
      const v = variantRegistry.get(variantId)!;
      // a batch ref that reads as a variable name ("AGE", "BUY") becomes the variable, so the
      // model's own conditions and piping ("AGE < 18", "{{BUY}}") name the question natively
      const naming = namingFor(def, a.code, a.variable ?? (a.ref && /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(a.ref) ? a.ref.toUpperCase() : undefined));
      const q = createQuestionFromVariant(v, naming, ctx.ids);
      q.text = pipeRefs(ctx, a.text);
      if (a.instruction) q.instruction = a.instruction;
      if (a.required !== undefined) q.required = a.required;
      shapeQuestion(def, q, a);
      // place it
      const { pageId, index } = placement(ctx, a.block, a.after);
      def.questions.push(q);
      const page = listPages(def.flow as unknown[]).find((p) => p.node.id === pageId)!.node as PageNode;
      page.questionIds.splice(index, 0, q.id);
      if (a.newPage && index > 0) {
        const prev = page.questionIds[index - 1];
        const r = splitPageAfter(def, prev, ctx.ids);
        if (!r.ok) fail(r.reason);
      }
      if (a.ref) ctx.refs.set(a.ref.toLowerCase(), q.id);
      ctx.refs.set(q.code.toLowerCase(), q.id);
      /*
       * A rule with a condition ("only when", or a kind:"condition" check) is
       * built only now, when the question — and its batch ref — exists, so
       * the condition can name it. `shapeQuestion` kept just kind and value,
       * which dropped the gate silently: a conditional rule became an
       * unconditional one, and a condition rule became one that checks nothing.
       */
      if (a.validation?.some((r) => r.when || r.check)) {
        q.validation = validationFromSpecs(ctx, a.validation, (i) => `${q.id}_v${i + 1}`);
      }
      const block = listBlocks(def.flow as unknown[]).find((b) => b.pages.some((p) => p.node.questionIds.includes(q.id)));
      if (block) ctx.lastBlock = block.id;
      return { description: `Created ${q.code} (${typeLabel(q)})${block?.title ? ` in “${block.title}”` : ""}: ${plain(q.text, 70)}`, touched: [q.id] };
    }
    case "update_question": {
      let q = resolveQuestion(ctx, a.target);
      const what: string[] = [];
      const lossy: string[] = [];
      if (a.type) {
        const variantId = variantForActionType(a.type) ?? fail(`“${a.type}” is not a question type the Studio knows`);
        const v = variantRegistry.get(variantId)!;
        if (v.id !== q.variant || v.baseType !== q.type) {
          const from = typeLabel(q);
          const m = migrateQuestionType(q, v);
          replaceQuestion(def, q.id, m.q);
          q = m.q;
          what.push(`${from} → ${typeLabel(q)}`);
          const dropped = m.changes.filter((c) => c.kind === "removed" || c.kind === "reset").map((c) => c.detail);
          if (dropped.length) lossy.push(`changing ${q.code} to ${typeLabel(q)} ${dropped.join("; ")}`);
          else lossy.push(`changes ${q.code} from ${from} to ${typeLabel(q)}`);
        }
      }
      if (a.text !== undefined && a.text !== q.text) { q.text = pipeRefs(ctx, a.text); what.push("text"); }
      if (a.instruction !== undefined) { q.instruction = a.instruction || undefined; what.push("instruction"); }
      if (a.required !== undefined && a.required !== q.required) { q.required = a.required; what.push(a.required ? "required" : "optional"); }
      /*
       * A RENAME FOLLOWS ITS REFERENCES. The code and the variable are how
       * conditions, calculations, pipes, quota cells and the analysis plan
       * name a question; changing one and leaving the references pointing at
       * the old name was a delayed break that the quality check reported as a
       * warning after the fact. `applyRename` is the Studio's own rename —
       * the same walk the Variables panel runs — so what is rewritten here is
       * exactly what the preview says will change.
       */
      const renames: { from: string; to: string; alsoCode: boolean }[] = [];
      if (a.code && a.code !== q.code) {
        if (def.questions.some((x) => x.id !== q.id && String(x.code).toLowerCase() === a.code!.toLowerCase())) fail(`code ${a.code} is already used`);
        what.push(`code ${q.code} → ${a.code}`);
        // the variable that was only the code follows it, as the Studio's rename does
        if (q.variableName === String(q.code) && !a.variable) renames.push({ from: String(q.code), to: a.code, alsoCode: true });
        else { rewriteCodeRefs(def, q, String(q.code), a.code); q = def.questions.find((x) => x.id === q.id)!; }
      }
      if (a.variable && a.variable !== q.variableName) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.variable)) fail(`${a.variable} is not a valid variable name`);
        if (def.questions.some((x) => x.id !== q.id && x.variableName.toLowerCase() === a.variable!.toLowerCase())) fail(`variable ${a.variable} is already used`);
        if ((def.calculations ?? []).some((c) => c.targetVariable.toLowerCase() === a.variable!.toLowerCase())) fail(`${a.variable} is already a calculation`);
        lossy.push(`renames variable ${q.variableName} to ${a.variable} (export columns change; logic, calculations and piping that name it are rewritten)`);
        what.push(`variable ${q.variableName} → ${a.variable}`);
        renames.push({ from: q.variableName, to: a.variable, alsoCode: false });
      }
      if (a.options || a.scale) {
        const had = q.options?.length ?? 0;
        q.options = a.scale ? scaleOptions(a.scale) : buildOptions(a.options!, []);
        what.push(`${q.options.length} options${a.scale ? ` (${a.scale.points}-point scale)` : ""}`);
        if (had) lossy.push(`replaces the ${had} options of ${q.code}`);
      }
      if (a.addOptions?.length) {
        const added = buildOptions(a.addOptions, q.options ?? []);
        // keep anchored "none" / "other" at the bottom: new options go before them
        const anchorAt = (q.options ?? []).findIndex((o) => o.flags?.includes("anchor_bottom"));
        const list = [...(q.options ?? [])];
        list.splice(anchorAt >= 0 && !added.some((o) => o.flags?.includes("anchor_bottom")) ? anchorAt : list.length, 0, ...added);
        q.options = list;
        what.push(`added ${added.map((o) => `“${o.label}”`).join(", ")}`);
      }
      if (a.removeOptions?.length) {
        const drop = new Set(a.removeOptions.map((x) => String(x).toLowerCase()));
        const gone = (q.options ?? []).filter((o) => drop.has(String(o.code).toLowerCase()) || drop.has(o.label.toLowerCase()));
        if (!gone.length) fail(`none of ${a.removeOptions.join(", ")} is an option of ${q.code}`);
        q.options = (q.options ?? []).filter((o) => !gone.includes(o));
        what.push(`removed ${gone.map((o) => `“${o.label}”`).join(", ")}`);
        lossy.push(`removes option${gone.length === 1 ? "" : "s"} ${gone.map((o) => `“${o.label}”`).join(", ")} from ${q.code}`);
      }
      if (a.rows) {
        const had = q.rows?.length ?? 0;
        q.rows = a.rows.map((label, i) => ({ code: `r${i + 1}`, label, flags: [], validation: [], required: false })) as never;
        what.push(`${a.rows.length} rows`);
        if (had) lossy.push(`replaces the ${had} rows of ${q.code}`);
      }
      if (a.randomize !== undefined) {
        q.randomization = { ...(q.randomization ?? {}), enabled: a.randomize, scope: q.rows?.length && /matrix/.test(q.type) ? "rows" : "options", method: "shuffle" } as never;
        what.push(a.randomize ? "randomized" : "not randomized");
      }
      if (!what.length) fail(`nothing to change on ${q.code}`);
      for (const r of renames) {
        // applyRename works on a copy; the copy's contents become this definition's, so every reference the batch holds stays valid
        const renamed = applyRename(def, r.from, r.to, { alsoCode: r.alsoCode });
        Object.assign(def, renamed);
        q = def.questions.find((x) => x.id === q.id)!;
      }
      return { description: `Changed ${q.code}: ${what.join(", ")}`, touched: [q.id], ...(lossy.length ? { destructive: lossy.join("; ") } : {}) };
    }
    case "delete_question": {
      const q = resolveQuestion(ctx, a.target);
      const analysisImpact = describeAnalysisImpact(def, q.id);
      const placedBefore = placedIds(def);
      const refs = removeQuestion(def, q.id);
      // removing a question also removes logic that named it — a branch arm among them, and with it whatever it held
      const stranded = def.questions.filter((x) => placedBefore.has(x.id) && !placedIds(def).has(x.id)).map((x) => x.code);
      return { description: `Deleted ${q.code}: ${plain(q.text, 60)}`, destructive: `Deletes ${q.code}${refs.length ? ` and ${refs.length} reference${refs.length === 1 ? "" : "s"} to it` : ""}${stranded.length ? ` — which leaves ${stranded.join(", ")} on no page` : ""}${analysisImpact.length ? ` — in the analysis, ${analysisImpact.join("; ")}` : ""}`, touched: [q.id] };
    }
    case "move_question": {
      const q = resolveQuestion(ctx, a.target);
      const { pageId, index } = placement(ctx, a.block, a.after, q.id);
      for (const p of listPages(def.flow as unknown[])) (p.node as PageNode).questionIds = (p.node as PageNode).questionIds.filter((x) => x !== q.id);
      const page = listPages(def.flow as unknown[]).find((p) => p.node.id === pageId)!.node as PageNode;
      page.questionIds.splice(Math.min(index, page.questionIds.length), 0, q.id);
      const block = listBlocks(def.flow as unknown[]).find((b) => b.pages.some((p) => p.node.questionIds.includes(q.id)));
      return { description: `Moved ${q.code}${block?.title ? ` to “${block.title}”` : ""}${a.after ? ` after ${a.after}` : ""}`, touched: [q.id] };
    }
    case "set_display_logic": {
      const blockId = tryBlock(ctx, a.target);
      if (blockId && !tryQuestion(ctx, a.target)) {
        const node = findFlow(def.flow as FlowNode[], blockId) as { visibleIf?: Condition; title?: string };
        const had = node.visibleIf;
        if (a.expression === null) { delete node.visibleIf; return { description: `Removed the display condition of block “${node.title ?? blockId}”`, destructive: had ? `Removes the display condition of block “${node.title ?? blockId}”` : undefined, touched: [blockId] }; }
        node.visibleIf = parseCondition(def, withRefs(ctx, a.expression));
        return { description: `Block “${node.title ?? blockId}” shown only when ${formatCondition(def, node.visibleIf)}`, destructive: had ? `Replaces the display condition of block “${node.title ?? blockId}”` : undefined, touched: [blockId] };
      }
      const q = resolveQuestion(ctx, a.target);
      const had = q.displayLogic;
      if (a.expression === null) {
        delete (q as { displayLogic?: Condition }).displayLogic;
        return { description: `Removed the display logic of ${q.code}`, destructive: had ? `Removes the display logic of ${q.code} (${formatCondition(def, had)})` : undefined, touched: [q.id] };
      }
      const c = parseCondition(def, withRefs(ctx, a.expression), q.id);
      q.displayLogic = c;
      return { description: `${q.code} shown only when ${formatCondition(def, c)}`, destructive: had ? `Replaces the display logic of ${q.code} (was ${formatCondition(def, had)})` : undefined, touched: [q.id] };
    }
    case "add_skip": {
      const from = resolveQuestion(ctx, a.from);
      const when = parseCondition(def, withRefs(ctx, a.when));
      const target = skipTarget(ctx, a.to, from.id);
      from.skipLogic = [...(from.skipLogic ?? []), { id: ctx.ids("skip"), when, target } as never];
      return { description: `After ${from.code}, when ${formatCondition(def, when)}, go to ${targetLabel(def, target)}`, touched: [from.id] };
    }
    case "clear_skips": {
      const q = resolveQuestion(ctx, a.target);
      const n = q.skipLogic?.length ?? 0;
      if (!n) fail(`${q.code} has no skip rules`);
      q.skipLogic = [];
      return { description: `Removed ${n} skip rule${n === 1 ? "" : "s"} from ${q.code}`, destructive: `Removes ${n} skip rule${n === 1 ? "" : "s"} from ${q.code}`, touched: [q.id] };
    }
    case "set_validation": {
      const q = resolveQuestion(ctx, a.target);
      const had = q.validation?.length ?? 0;
      q.validation = validationFromSpecs(ctx, a.rules, () => ctx.ids("val"));
      return { description: `${q.code} validation: ${a.rules.map((r) => `${r.kind.replace(/_/g, " ")}${r.value !== undefined ? ` ${r.value}` : ""}`).join(", ") || "none"}`, destructive: had ? `Replaces the ${had} validation rule${had === 1 ? "" : "s"} of ${q.code}` : undefined, touched: [q.id] };
    }
    case "page_break": {
      const q = resolveQuestion(ctx, a.after);
      const r = a.remove ? joinPageAfter(def, q.id) : splitPageAfter(def, q.id, ctx.ids);
      if (!r.ok) fail(r.reason);
      return { description: a.remove ? `Removed the page break after ${q.code}` : `Page break after ${q.code}`, touched: [q.id] };
    }
    case "create_embedded": {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.name)) fail(`${a.name} is not a valid variable name`);
      const r = addEmbeddedField(def, { name: a.name, source: a.source ?? "url", ...(a.value !== undefined ? { value: a.value } : {}) } as never, ctx.ids);
      if (!r.ok) fail(r.reason);
      return { description: `Embedded variable ${a.name} (${a.source ?? "url"}${a.value ? ` = ${a.value}` : ""})`, touched: [] };
    }
    case "create_calculation": {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.name)) fail(`${a.name} is not a valid variable name`);
      if ((def.calculations ?? []).some((c) => c.targetVariable.toLowerCase() === a.name.toLowerCase()) || def.questions.some((q) => q.variableName.toLowerCase() === a.name.toLowerCase())) fail(`${a.name} is already a variable`);
      // the names it reads must exist: a calculation over a question that is not there computes nothing
      const expression = withRefs(ctx, a.expression);
      const unknown = identifiers(expression).filter((n) => !getQuestionByCodeOrVar(def, n) && !(def.calculations ?? []).some((c) => c.targetVariable === n) && !KNOWN_FUNCTIONS.has(n.toUpperCase()));
      if (unknown.length) fail(`the expression reads ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not in the survey`);
      def.calculations = [...(def.calculations ?? []), { id: ctx.ids("calc"), targetVariable: a.name, expression, ...(a.label ? { label: a.label } : {}), trigger: "on_page_submit", dataType: a.dataType ?? "numeric" } as never];
      return { description: `Calculation ${a.name} = ${expression}`, touched: [] };
    }
    case "create_randomizer": {
      const ids = a.blocks.map((b) => resolveTop(ctx, b));
      const flow = def.flow as FlowNode[];
      const idx = ids.map((id) => flow.findIndex((n) => n.id === id));
      if (idx.some((i) => i < 0)) fail("only blocks at the top level of the survey flow can be randomized together");
      const sorted = [...idx].sort((x, y) => x - y);
      if (sorted.some((v, k) => k > 0 && v !== sorted[k - 1] + 1)) fail("the blocks to randomize must sit next to each other in the flow");
      const nodes = sorted.map((i) => flow[i]);
      const node = { type: "randomizer", id: ctx.ids("rand"), ...(a.title ? { title: a.title } : {}), ...(a.show ? { show: a.show } : {}), evenPresentation: true, children: nodes } as unknown as FlowNode;
      flow.splice(sorted[0], nodes.length, node);
      const titles = nodes.map((n) => (n as { title?: string }).title ?? n.id);
      return { description: `Randomized the order of ${titles.map((t) => `“${t}”`).join(", ")}${a.show ? ` (each respondent sees ${a.show})` : ""}`, touched: ids };
    }
    case "create_branch": {
      /*
       * One or more ARMS — first match wins — and an optional OTHERWISE, each a
       * run of top-level blocks. All of them must sit next to each other in the
       * flow, because they become one branch node in that place.
       */
      const flow = def.flow as FlowNode[];
      const armSpecs = [{ blocks: a.blocks, when: a.when, label: a.title }, ...(a.arms ?? [])];
      const allIds = [...armSpecs.flatMap((arm) => arm.blocks), ...(a.otherwise ?? [])].map((b) => resolveTop(ctx, b));
      if (new Set(allIds).size !== allIds.length) fail("a block can only be in one arm of a branch");
      const idx = allIds.map((id) => flow.findIndex((n) => n.id === id));
      if (idx.some((i) => i < 0)) fail("only blocks at the top level of the survey flow can go into a branch");
      const sorted = [...idx].sort((x, y) => x - y);
      if (sorted.some((v, k) => k > 0 && v !== sorted[k - 1] + 1)) fail("the blocks of a branch must sit next to each other in the flow");
      // the conditions may only read questions asked before the branch
      const order = questionOrder(def);
      const firstInside = Math.min(...sorted.flatMap((i) => listPages([flow[i]]).flatMap((p) => p.node.questionIds)).map((q) => order.indexOf(q)).filter((x) => x >= 0));
      const byId = new Map(sorted.map((i) => [flow[i].id, flow[i]]));
      const branches = armSpecs.map((arm) => {
        const when = parseCondition(def, withRefs(ctx, arm.when));
        const reads = new Set<string>(); collectRefs(when, reads, def);
        if ([...reads].some((q) => order.indexOf(q) >= firstInside)) fail("a branch condition can only read questions asked before the branch");
        return { id: ctx.ids("arm"), ...(arm.label ? { label: arm.label } : {}), when, children: arm.blocks.map((b) => byId.get(resolveTop(ctx, b))!) };
      });
      const otherwise = (a.otherwise ?? []).map((b) => byId.get(resolveTop(ctx, b))!);
      const node = { type: "branch", id: ctx.ids("branch"), ...(a.title ? { title: a.title } : {}), branches, ...(otherwise.length ? { otherwise } : {}) } as unknown as FlowNode;
      flow.splice(sorted[0], sorted.length, node);
      const text = branches.map((b) => `${b.children.map((n) => `“${(n as { title?: string }).title ?? n.id}”`).join(", ")} when ${formatCondition(def, b.when)}`).join("; else ");
      return { description: `Branch: ${text}${otherwise.length ? `; otherwise ${otherwise.map((n) => `“${(n as { title?: string }).title ?? n.id}”`).join(", ")}` : ""}`, touched: allIds };
    }
    case "create_loop": {
      const from = resolveQuestion(ctx, a.from), to = resolveQuestion(ctx, a.to);
      let source: unknown;
      if (a.over) {
        const src = resolveQuestion(ctx, a.over);
        const order = questionOrder(def);
        if (order.indexOf(src.id) >= Math.min(order.indexOf(from.id), order.indexOf(to.id))) fail(`the loop repeats over ${src.code}'s answers, so ${src.code} must be asked before the loop`);
        if (!(src.options?.length)) fail(`${src.code} has no options to repeat over`);
        source = { kind: "question", questionId: src.id, filter: src.type === "multi_select" ? "selected" : "all" };
      } else source = { kind: "static", items: a.items!.map((label, i) => ({ code: String(i + 1), label })) };
      const holder = listBlocks(def.flow as unknown[]).find((b) => b.pages.some((p) => p.node.questionIds.includes(from.id)));
      const r = wrapInLoop(def, from.id, to.id, { loopVar: a.loopVar ?? "item", ...(a.title ? { title: a.title } : {}) }, ctx.ids);
      if (!r.ok) return fail(r.reason);
      const node = findFlow(def.flow as FlowNode[], r.id) as { source: unknown; title?: string };
      node.source = source;
      // a loop that took a whole block's place carries the block's name, so "the Owners block" still means it
      if (!node.title && holder?.title && !listBlocks(def.flow as unknown[]).some((b) => b.id === holder.id)) node.title = holder.title;
      return { description: `Loop over ${a.over ? `the answers to ${resolveQuestion(ctx, a.over).code}` : `${a.items!.length} items`}: ${from.code}${to.id !== from.id ? `–${to.code}` : ""} asked once per item`, touched: [from.id, to.id] };
    }
    case "set_research": {
      const map = (xs: string[] | undefined) => (xs ?? []).map((r) => tryQuestion(ctx, r)?.id).filter((x): x is string => !!x);
      const prev = def.research;
      def.research = {
        objective: a.objective ?? prev?.objective,
        hypotheses: a.hypotheses ?? prev?.hypotheses ?? [],
        population: a.population ?? prev?.population,
        // the planned sample bounds the analysis plan (analysisFramework.expectedSample)
        ...((a.sampleSize ?? prev?.sampleSize) ? { sampleSize: a.sampleSize ?? prev?.sampleSize } : {}),
        methodology: a.methodology ?? prev?.methodology,
        constructs: a.constructs ? a.constructs.map((c) => ({ name: c.name, role: (ROLES.has(String(c.role)) ? c.role : "descriptive") as never, ...(c.definition ? { definition: c.definition } : {}), questionIds: map(c.questions) })) : prev?.constructs ?? [],
        analysis: a.analysis ?? prev?.analysis ?? [],
        assumptions: a.assumptions ?? prev?.assumptions ?? [],
        sources: a.sources ?? prev?.sources ?? [],
        /*
         * The analysis plan is not the research design's words: an edit of the
         * objective or the hypotheses keeps it. It was rebuilt without it, so
         * "set the objective" silently deleted a saved plan.
         */
        ...(prev?.analysisPlan ? { analysisPlan: prev.analysisPlan } : {}),
        /* Phase 3: the structured readings follow their statements (by text, when the list is replaced); the questions, KPIs and audience are kept unless given */
        hypothesisDetails: a.hypotheses ? a.hypotheses.map((h) => { const k = (prev?.hypotheses ?? []).findIndex((x) => x.trim().toLowerCase() === h.trim().toLowerCase()); return k >= 0 ? prev?.hypothesisDetails?.[k] ?? {} : {}; }) : prev?.hypothesisDetails ?? [],
        researchQuestions: a.researchQuestions ?? prev?.researchQuestions ?? [],
        kpis: a.kpis ?? prev?.kpis ?? [],
        ...((a.audience ?? prev?.audience) ? { audience: a.audience ? { characteristics: [], ...a.audience } : prev?.audience } : {}),
        /* Phase 7: whether the design is enforced is kept unless the action says */
        ...((a.strict ?? prev?.strict) !== undefined ? { strict: a.strict ?? prev?.strict } : {}),
        updatedAt: ctx.now,
      } as never;
      return { description: `Research design: ${[a.strict === true ? "enforced (research gaps are blockers)" : a.strict === false ? "no longer enforced" : "", a.objective ? "objective" : "", a.hypotheses?.length ? `${a.hypotheses.length} hypothes${a.hypotheses.length === 1 ? "is" : "es"}` : "", a.constructs?.length ? `${a.constructs.length} constructs` : "", a.researchQuestions?.length ? `${a.researchQuestions.length} research question${a.researchQuestions.length === 1 ? "" : "s"}` : "", a.kpis?.length ? `${a.kpis.length} KPI${a.kpis.length === 1 ? "" : "s"}` : "", a.audience ? "audience" : "", a.population ? "population" : ""].filter(Boolean).join(", ") || "updated"}`, touched: [] };
    }
    case "add_punch": {
      /*
       * "IF Q3 = 1 THEN code SEGMENT as 2". The criteria go through the
       * expression parser (option values as CODES, labels read as their
       * codes); what the response is coded as goes through the same option
       * resolution against the TARGET's options — a choice target takes an
       * option code, a text / numeric / hidden value takes its value.
       */
      if (a.expression) {
        const parsed = parsePunchExpression(def, withRefs(ctx, a.expression));
        if (parsed.errors.length || !parsed.rules.length) fail(`the rule “${a.expression}” does not parse: ${parsed.errors[0]?.message ?? "empty"}`);
        const touched: string[] = [];
        for (const r of parsed.rules) {
          const q = def.questions.find((x) => x.id === r.targetQuestionId)!;
          q.punches = [...(q.punches ?? []), { ...r.rule, id: ctx.ids("punch"), ...(a.label ? { label: a.label } : {}), ...(a.mode ? { mode: a.mode } : {}), ...(a.recompute ? { recompute: a.recompute } : {}) }] as never;
          touched.push(q.id);
        }
        const target = def.questions.find((x) => x.id === touched[0])!;
        return { description: `Punch ${target.code}: ${formatPunchExpression(def, target, target.punches!.at(-1)! as never)}`, touched };
      }
      const q = resolveQuestion(ctx, a.target);
      const when = a.mode === "else" && !a.when ? undefined : parseCondition(def, withRefs(ctx, a.when ?? ""));
      const view = authoringQuestionView(q, def);
      const choice = view.options.length > 0;
      let action = a.action ?? (choice ? "select" : "set_value");
      let codes: (string | number)[] = [];
      if (action !== "clear") {
        const wanted = a.codes?.length ? a.codes : a.value !== undefined ? [a.value] : [];
        if (choice) {
          for (const w of wanted) {
            const r = resolveOptionValue(view.options as OptionList, w);
            if (r.kind === "none") fail(`${q.code} has no option “${w}” to code the response as — its options are ${describeOptions(view.options as OptionList)}`);
            codes.push((r as { code: string | number }).code);
          }
          if (action === "set_value") action = "select";
        } else {
          if (action === "select" || action === "deselect") fail(`${q.code} has no options — code it with action set_value and a value`);
          codes = wanted.slice(0, 1);
        }
        if (!codes.length) fail("nothing to code the response as");
      }
      const rule = { id: ctx.ids("punch"), ...(a.label ? { label: a.label } : {}), source: { kind: "codes", codes }, action, mapping: [], ignoreUnmatched: true, recompute: a.recompute ?? "always", ...(when ? { when } : {}), ...(a.mode ? { mode: a.mode } : {}) };
      q.punches = [...(q.punches ?? []), rule] as never;
      return { description: `Punch ${q.code}: ${formatPunchExpression(def, q, rule as never)}`, touched: [q.id] };
    }
    case "remove_punches": {
      const q = resolveQuestion(ctx, a.target);
      const had = q.punches ?? [];
      const keep = a.id ? had.filter((r) => r.id !== a.id && (r.label ?? "") !== a.id) : [];
      if (had.length === keep.length) fail(a.id ? `${q.code} has no punch rule “${a.id}”` : `${q.code} has no punch rules`);
      q.punches = keep as never;
      const n = had.length - keep.length;
      return { description: `Remove ${n} punch rule${n === 1 ? "" : "s"} from ${q.code}`, destructive: `Removes ${n} punch rule${n === 1 ? "" : "s"} from ${q.code}`, touched: [q.id] };
    }
    default: {
      // options one at a time, masks, duplicates, survey settings, embedded fields, hypotheses, custom code: every target through the same resolvers and gates
      if (isOptionOp(a.op)) {
        const r = applyOptionAction(def, a as OptionAction, { question: (x) => tryQuestion(ctx, x), condition: (c) => parseCondition(def, withRefs(ctx, c)), setExpression: (t) => { const p = parseSetExpression(def, withRefs(ctx, t)); if (p.errors.length || !p.expr) fail(`the set expression “${t}” does not parse: ${p.errors[0]?.message ?? "empty"}`); return p.expr!; }, ids: ctx.ids, now: ctx.now });
        ctx.uxWarnings.push(...r.warnings);
        return r;
      }
      // the analysis framework: question.analysis and research.analysisPlan only, every variable resolved
      if (isAnalysisOp(a.op)) return applyAnalysisAction(def, a as AnalysisAction, { question: (x) => tryQuestion(ctx, x), ids: ctx.ids, now: ctx.now });
      // the quotas: def.quotas and the quota_check nodes; every condition through the gate, the check placed after what it reads
      if (isQuotaOp(a.op)) {
        const r = applyQuotaAction(def, a as QuotaAction, { question: (x) => tryQuestion(ctx, x), condition: (c) => parseCondition(def, withRefs(ctx, c)), ids: ctx.ids });
        ctx.uxWarnings.push(...r.warnings);
        return r;
      }
      // the languages: def.localization only; every target resolved, every translation checked against its source
      if (isLocalizationOp(a.op)) {
        const r = applyLocalizationAction(def, a as LocalizationAction, { question: (x) => tryQuestion(ctx, x), condition: (c) => parseCondition(def, withRefs(ctx, c)), ids: ctx.ids, now: ctx.now });
        ctx.uxWarnings.push(...r.warnings);
        return r;
      }
      // the look and behaviour: def.ux only, through the UX gate
      const r = applyUxAction(def, a as UxAction, { lookups: { question: (x) => tryQuestion(ctx, x), block: (x) => tryBlock(ctx, x) }, ids: ctx.ids, now: ctx.now, refs: ctx.uxRefs });
      ctx.uxWarnings.push(...r.warnings);
      return r;
    }
  }
}

const ROLES = new Set(["independent", "dependent", "mediator", "moderator", "control", "screening", "descriptive"]);
const KNOWN_FUNCTIONS = new Set(["SUM", "COUNT", "AVG", "MEAN", "MIN", "MAX", "IF", "ROUND", "ABS", "LEN", "CONTAINS", "AND", "OR", "NOT", "TRUE", "FALSE", "NULL", "ANSWERED", "SELECTED", "FLOOR", "CEIL", "NUMBER", "TEXT", "DATE", "TODAY", "NOW", "DAYS"]);
const identifiers = (expr: string): string[] => [...new Set((expr.replace(/"[^"]*"|'[^']*'/g, " ").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []))];

/* ------------------------------------------------------------ resolution */

function resolveQuestion(ctx: Ctx, ref: string): Question {
  return tryQuestion(ctx, ref) ?? fail(`there is no question “${ref}”`);
}
function tryQuestion(ctx: Ctx, ref: string): Question | undefined {
  const r = ref.trim().replace(/^\{\{|\}\}$/g, "");
  const viaRef = ctx.refs.get(r.toLowerCase());
  if (viaRef) return ctx.def.questions.find((q) => q.id === viaRef);
  return getQuestionByCodeOrVar(ctx.def, r) ?? ctx.def.questions.find((q) => String(q.code).toLowerCase() === r.toLowerCase() || q.variableName.toLowerCase() === r.toLowerCase());
}
function resolveBlock(ctx: Ctx, ref: string): string {
  return tryBlock(ctx, ref) ?? fail(`there is no block “${ref}”`);
}
function tryBlock(ctx: Ctx, ref: string): string | undefined {
  const r = ref.trim().toLowerCase();
  const viaRef = ctx.blockRefs.get(r);
  if (viaRef) return viaRef;
  const blocks = listBlocks(ctx.def.flow as unknown[]);
  const byId = blocks.find((b) => b.id.toLowerCase() === r);
  if (byId) return byId.id;
  const byTitle = blocks.find((b) => (b.title ?? "").trim().toLowerCase() === r) ?? blocks.find((b) => (b.title ?? "").trim().toLowerCase().replace(/^(?:block|section)\s*\d*\s*[:.–-]\s*/, "") === r.replace(/^(?:block|section)\s*\d*\s*[:.–-]\s*/, ""));
  if (byTitle) return byTitle.id;
  const n = /^(?:block|section)\s*(\d+)$/.exec(r);
  if (n && blocks[Number(n[1]) - 1]) return blocks[Number(n[1]) - 1].id;
  return undefined;
}

/** a block — or any top-level flow element with that title (a loop that replaced a block, a page) */
function resolveTop(ctx: Ctx, ref: string): string {
  const b = tryBlock(ctx, ref);
  const flow = ctx.def.flow as FlowNode[];
  if (b && flow.some((n) => n.id === b)) return b;
  const r = ref.trim().toLowerCase();
  const top = flow.find((n) => ((n as { title?: string }).title ?? "").trim().toLowerCase() === r);
  if (top) return top.id;
  if (b) return b; // nested: the caller refuses it as not top-level
  return fail(`there is no block “${ref}”`);
}

/** where a new or moved question goes: after a question, at the end of a block, or at the end of the last block */
function placement(ctx: Ctx, block: string | undefined, after: string | undefined, moving?: string): { pageId: string; index: number } {
  const def = ctx.def;
  if (after) {
    const q = resolveQuestion(ctx, after);
    if (q.id === moving) fail("a question cannot be moved after itself");
    const page = listPages(def.flow as unknown[]).find((p) => p.node.questionIds.includes(q.id)) ?? fail(`${q.code} is not on a page`);
    const ids = page.node.questionIds.filter((x: string) => x !== moving);
    return { pageId: page.node.id, index: ids.indexOf(q.id) + 1 };
  }
  const blockId = block ? resolveBlock(ctx, block) : ctx.lastBlock ?? lastBlockId(def) ?? ensureBlock(ctx);
  const b = listBlocks(def.flow as unknown[]).find((x) => x.id === blockId) ?? fail(`there is no block “${block}”`);
  const page = b.pages[b.pages.length - 1] ?? fail(`block “${b.title ?? b.id}” has no page`);
  return { pageId: page.node.id, index: page.node.questionIds.filter((x: string) => x !== moving).length };
}
function lastBlockId(def: SurveyDefinition): string | null {
  const bs = listBlocks(def.flow as unknown[]);
  return bs.length ? bs[bs.length - 1].id : null;
}
function ensureBlock(ctx: Ctx): string {
  const id = ctx.ids("block");
  const flow = ctx.def.flow as FlowNode[];
  flow.splice(endIndex(flow), 0, { type: "block", id, title: "Questions", children: [{ type: "page", id: ctx.ids("page"), questionIds: [] }] } as unknown as FlowNode);
  ctx.lastBlock = id;
  return id;
}

function skipTarget(ctx: Ctx, to: string, fromId: string): { kind: string; ref?: string; status?: string } {
  const t = to.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["end", "end_of_survey", "the_end", "complete", "finish"].includes(t)) return { kind: "end", status: "complete" };
  if (["screen_out", "screened", "screened_out", "screenout", "disqualify", "disqualified"].includes(t)) return { kind: "terminate", status: "screened" };
  if (["terminate", "terminated", "exit"].includes(t)) return { kind: "terminate", status: "terminated" };
  if (["quota_full", "overquota", "over_quota"].includes(t)) return { kind: "terminate", status: "quota_full" };
  const q = tryQuestion(ctx, to);
  if (q) {
    const order = questionOrder(ctx.def);
    if (order.indexOf(q.id) <= order.indexOf(fromId)) fail(`a skip can only jump forward; ${q.code} is not after the question it skips from`);
    return { kind: "question", ref: q.id };
  }
  const b = tryBlock(ctx, to);
  if (b) return { kind: "block", ref: b };
  return fail(`the skip target “${to}” is not a question, a block, the end or a screen-out`);
}
function targetLabel(def: SurveyDefinition, t: { kind: string; ref?: string; status?: string }): string {
  if (t.kind === "question") return def.questions.find((q) => q.id === t.ref)?.code ?? String(t.ref);
  if (t.kind === "block") return `block “${listBlocks(def.flow as unknown[]).find((b) => b.id === t.ref)?.title ?? t.ref}”`;
  if (t.kind === "end") return "the end";
  return `out of the survey (${String(t.status ?? "terminated").replace(/_/g, " ")})`;
}

/**
 * Batch refs in expression text → the codes they became. A ref normally IS
 * the variable (see create_question), so this only matters when that name
 * was already taken; quoted strings are left alone.
 */
/** piping written with batch refs — {{BUY}} — as the Studio's own piping */
function pipeRefs(ctx: Ctx, text: string): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_]+)?)\s*\}\}/g, (m, name: string, rest: string) => {
    const id = ctx.refs.get(name.toLowerCase());
    const q = id ? ctx.def.questions.find((x) => x.id === id) : undefined;
    return q ? `{{${q.variableName}${rest}}}` : m;
  });
}

function withRefs<T extends CondInput>(ctx: Ctx, text: T): T {
  if (typeof text !== "string") return text;
  if (!ctx.refs.size) return text;
  return text.split(/("[^"]*"|'[^']*')/).map((part, i) => i % 2 ? part : part.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (w) => {
    const id = ctx.refs.get(w.toLowerCase());
    if (!id) return w;
    const q = ctx.def.questions.find((x) => x.id === id);
    if (!q || q.variableName.toLowerCase() === w.toLowerCase() || String(q.code).toLowerCase() === w.toLowerCase()) return w;
    return String(q.code);
  })).join("") as T;
}

function parseCondition(def: SurveyDefinition, input: CondInput, selfId?: string): Condition {
  // strict: a numeric question compared with a word is refused here, not stored as a rule that is never true
  const r = typeof input === "string" ? parseLogicExpression(def, input, { strict: true }) : structuredCondition(def, input);
  const shown = typeof input === "string" ? input : "(structured)";
  if (r.errors.length || !r.condition) fail(`the condition “${shown}” does not parse: ${r.errors[0]?.message ?? "empty"}`);
  if (selfId) {
    const refs = new Set<string>(); collectRefs(r.condition!, refs, def);
    if (refs.has(selfId)) fail(`a question's display logic cannot read the question itself`);
  }
  return r.condition!;
}
/**
 * Every question a condition reads — the dependency graph's own answer, so a
 * right-hand question (`Q5 > Q6`), a calc expression, a COUNT's `where`, a
 * named expression and a calculated variable all count. This used to see
 * only left-hand question sources, so a quota check could be placed before a
 * question its cells read, and a display rule could read its own question
 * through a named expression without being refused.
 */
/**
 * A condition the model sent as a tree: checked against the schema (shape,
 * operators, any nesting), then through the same option-code canonicaliser
 * the parser uses — so `{ value: "Yes" }` on a choice question is stored as
 * its code, and a value naming no option is refused with the codes listed.
 */
function structuredCondition(def: SurveyDefinition, c: Condition): { condition?: Condition; errors: { message: string }[] } {
  const parsed = ConditionSchema.safeParse(c);
  if (!parsed.success) return { errors: [{ message: parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".") || "condition"}: ${i.message}`).join("; ") }] };
  const tree = parsed.data as Condition;
  const missing: string[] = [];
  forEachRule(tree, (r) => {
    if ((r.source.kind === "question" || r.source.kind === "variable") && !getQuestionByCodeOrVar(def, r.source.ref)
      && !(def.calculations ?? []).some((x) => x.targetVariable === r.source.ref)) missing.push(r.source.ref);
  });
  if (missing.length) return { errors: [{ message: `${[...new Set(missing)].join(", ")} ${missing.length === 1 ? "is" : "are"} not in the survey` }] };
  const canon = canonicalizeCondition(def, tree);
  if (canon.errors.length) return { errors: canon.errors.map((message) => ({ message })) };
  return { condition: canon.condition, errors: [] };
}

function collectRefs(c: Condition, into: Set<string>, def: SurveyDefinition): void {
  conditionRefs(def, c, into);
}

/**
 * A question code that changes while its variable stays: the pipes and the
 * conditions written against the CODE ({{Q7}}, `Q7 = 2`) follow it. The
 * variable-keyed references are untouched — they still resolve.
 */
function rewriteCodeRefs(def: SurveyDefinition, q: Question, from: string, to: string): void {
  if (q.variableName === from) return; // applyRename handles a variable that is also the code
  const renamed = applyRename(def, from, to, { alsoCode: false });
  // applyRename also moves the variable when it equals `from`; here it does not, so only the walked references changed
  const self = renamed.questions.find((x) => x.id === q.id)!;
  self.variableName = q.variableName;
  self.code = to;
  Object.assign(def, renamed);
}

/* ------------------------------------------------------------ building */

function namingFor(def: SurveyDefinition, code?: string, variable?: string): { code: string; variableName: string } {
  const taken = new Set<string>();
  for (const q of def.questions) { taken.add(String(q.code).toUpperCase()); taken.add(q.variableName.toUpperCase()); }
  for (const c of def.calculations ?? []) taken.add(c.targetVariable.toUpperCase());
  let n = def.questions.length + 1;
  while (taken.has(`Q${n}`)) n++;
  const auto = `Q${n}`;
  const c = code && !taken.has(code.toUpperCase()) ? code : auto;
  const v = variable && /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) && !taken.has(variable.toUpperCase()) ? variable : /^[A-Za-z_][A-Za-z0-9_]*$/.test(c) && !taken.has(c.toUpperCase()) ? c : auto;
  return { code: c, variableName: v };
}

/** Validation rules from the action's specs — the gate and the check through the same condition gate as everything else. */
function validationFromSpecs(ctx: Ctx, specs: ValidationSpec[], idFor: (i: number) => string): ValidationRule[] {
  const def = ctx.def;
  return specs.map((r, i) => ({
    id: idFor(i), kind: r.kind,
    ...(r.value !== undefined ? { value: r.value } : {}),
    ...(r.when ? { when: parseCondition(def, withRefs(ctx, r.when)) } : {}),
    /*
     * The stored `check` is the INVALID condition (the engine fails the answer
     * when it holds — validate.ts). The action takes what the answer must
     * SATISFY, which is how anyone states a rule ("Q5 must be at least Q4"),
     * so it is negated here, once, rather than asking the model to write
     * every rule backwards.
     */
    ...(r.check ? { check: { type: "group", op: "not", children: [parseCondition(def, withRefs(ctx, r.check))] } } : {}),
    ...(r.message ? { message: r.message } : {}),
  })) as ValidationRule[];
}

function shapeQuestion(def: SurveyDefinition, q: Question, a: Extract<SurveyAction, { op: "create_question" }>): void {
  void def;
  const matrix = /^matrix/.test(q.type);
  if (a.scale) q.options = scaleOptions(a.scale) as never;
  else if (a.options?.length) q.options = buildOptions(a.options, []) as never;
  else if (/^(?:yes_no)$/i.test(a.type.replace(/[\s-]+/g, "_")) && !q.options?.length) q.options = buildOptions(["Yes", "No"], []) as never;
  if (a.rows?.length) q.rows = a.rows.map((label, i) => ({ code: `r${i + 1}`, label, flags: [], validation: [], required: false })) as never;
  if (matrix && !a.rows?.length) fail(`a matrix question needs rows (the statements or items it rates)`);
  if (a.randomize) q.randomization = { enabled: true, scope: matrix ? "rows" : "options", method: "shuffle" } as never;
  if (a.validation?.length) q.validation = a.validation.map((r, i) => ({ id: `${q.id}_v${i + 1}`, kind: r.kind, ...(r.value !== undefined ? { value: r.value } : {}) })) as never;
  const choice = /select|dropdown|matrix|ranking/.test(q.type) && q.type !== "nps";
  if (choice && !q.options?.length) fail(`${a.type} question “${plain(a.text, 40)}” needs options`);
}

function buildOptions(specs: OptionSpec[], existing: { code: string | number; label: string }[]): Question["options"] {
  const used = new Set(existing.map((o) => String(o.code)));
  const numeric = existing.every((o) => typeof o.code === "number" || /^\d+$/.test(String(o.code)));
  let next = Math.max(0, ...existing.map((o) => Number(o.code)).filter(Number.isFinite)) + 1;
  const out: Question["options"] = [];
  for (const s of specs) {
    const o = typeof s === "string" ? { label: s } : s;
    let code: string | number | undefined = o.code;
    if (code === undefined || used.has(String(code))) {
      if (/^(?:none|none of (?:the above|these)|don'?t know|prefer not to (?:say|answer))/i.test(o.label) && !used.has("99") && numeric) code = 99;
      else { while (used.has(String(next))) next++; code = next++; }
    }
    used.add(String(code));
    const flags: string[] = [];
    const exclusive = o.exclusive ?? /^(?:none|none of (?:the above|these)|don'?t know|prefer not to (?:say|answer)|not applicable|n\/a)\b/i.test(o.label);
    const other = o.other ?? /^other\b.*\b(?:specify|please)|^other\s*\(/i.test(o.label);
    if (exclusive) flags.push("exclusive");
    if (other) flags.push("other_specify");
    if (o.anchor || exclusive || other) flags.push("anchor_bottom");
    out.push({ code, label: o.label, flags } as never);
  }
  return out;
}

function scaleOptions(s: ScaleSpec): Question["options"] {
  const start = s.start ?? (s.points === 11 ? 0 : 1);
  return Array.from({ length: s.points }, (_, i) => {
    const code = start + i;
    const label = s.labels?.[i] ?? (i === 0 && s.low ? s.low : i === s.points - 1 && s.high ? s.high : s.mid && s.points % 2 === 1 && i === (s.points - 1) / 2 ? s.mid : String(code));
    return { code, label, flags: [] };
  }) as never;
}

function replaceQuestion(def: SurveyDefinition, id: string, next: Question): void {
  def.questions = def.questions.map((q) => (q.id === id ? next : q));
}

const plain = (s: string | undefined, n: number): string => { const t = (s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export function typeLabel(q: Pick<Question, "type" | "variant">): string {
  const v = q.variant ? variantRegistry.get(q.variant) : undefined;
  return (v as { label?: string } | undefined)?.label ?? q.type.replace(/_/g, " ");
}

/* ------------------------------------------------------------ flow helpers */

function placedIds(def: SurveyDefinition): Set<string> {
  return new Set(listPages(def.flow as unknown[]).flatMap((p) => p.node.questionIds));
}

function findFlow(flow: FlowNode[], id: string): FlowNode | null {
  for (const n of flow) {
    if (n.id === id) return n;
    const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
    for (const list of [k.children, ...(k.branches ?? []).map((b) => b.children), k.otherwise]) if (list) { const f = findFlow(list, id); if (f) return f; }
  }
  return null;
}
function removeFlow(flow: FlowNode[], id: string): boolean {
  const i = flow.findIndex((n) => n.id === id);
  if (i >= 0) { flow.splice(i, 1); return true; }
  for (const n of flow) {
    const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
    for (const list of [k.children, ...(k.branches ?? []).map((b) => b.children), k.otherwise]) if (list && removeFlow(list, id)) return true;
  }
  return false;
}
/** the top-level index of the node that holds `id` */
function topIndexOf(flow: FlowNode[], id: string): number {
  const i = flow.findIndex((n) => n.id === id || !!findFlow([n], id));
  return i >= 0 ? i : endIndex(flow) - 1;
}
/** after the embedded-data setup at the top of the flow */
function leadingSetupEnd(flow: FlowNode[]): number {
  let i = 0;
  while (i < flow.length && flow[i].type === "embedded_data") i++;
  return i;
}

/* ------------------------------------------------------------ words */

/** a condition input, in a few words, before it has been parsed */
const condWords = (c: CondInput): string => (typeof c === "string" ? c : "a structured condition");

export function describeAction(a: SurveyAction): string {
  switch (a.op) {
    case "create_block": return `Create block “${a.title}”`;
    case "rename_block": return `Rename block ${a.target} to “${a.title}”`;
    case "delete_block": return `Delete block ${a.target}`;
    case "create_question": return `Create ${a.type} question “${plain(a.text, 50)}”`;
    case "update_question": return `Change ${a.target}`;
    case "delete_question": return `Delete ${a.target}`;
    case "move_question": return `Move ${a.target}`;
    case "set_display_logic": return a.expression === null ? `Remove the display logic of ${a.target}` : `Show ${a.target} only when ${condWords(a.expression)}`;
    case "add_skip": return `After ${a.from}, when ${condWords(a.when)}, go to ${a.to}`;
    case "clear_skips": return `Remove the skip rules of ${a.target}`;
    case "set_validation": return `Set the validation of ${a.target}`;
    case "page_break": return a.remove ? `Remove the page break after ${a.after}` : `Page break after ${a.after}`;
    case "create_embedded": return `Create embedded variable ${a.name}`;
    case "create_calculation": return `Create calculation ${a.name}`;
    case "create_randomizer": return `Randomize ${a.blocks.join(", ")}`;
    case "create_branch": return `Show ${a.blocks.join(", ")} only when ${condWords(a.when)}${a.arms?.length ? ` (+${a.arms.length} more arm${a.arms.length === 1 ? "" : "s"})` : ""}`;
    case "create_loop": return `Loop ${a.from}${a.to !== a.from ? `–${a.to}` : ""}`;
    case "set_research": return a.strict === true && Object.keys(a).length === 2 ? "Enforce the research design" : a.strict === false && Object.keys(a).length === 2 ? "Stop enforcing the research design" : "Record the research design";
    case "add_punch": return a.expression ? `Punch rule ${a.expression}` : `Punch ${a.target} when ${a.when ? condWords(a.when) : "otherwise"}`;
    case "remove_punches": return `Remove the punch rules of ${a.target}`;
    case "create_style": return `Style “${a.label}”`;
    case "update_style": return `Change style ${a.id}`;
    case "remove_style": return `Remove style ${a.id}`;
    case "create_animation": return `Animation “${a.label}” (${a.preset})`;
    case "update_animation": return `Change animation ${a.id}`;
    case "remove_animation": return `Remove animation ${a.id}`;
    case "create_behavior": return `Behaviour “${a.label}”`;
    case "update_behavior": return `Change behaviour ${a.id}`;
    case "remove_behavior": return `Remove behaviour ${a.id}`;
    case "set_theme": return a.label ? `Theme “${a.label}”` : "Change the theme";
    case "set_custom_html": return a.html === null ? `Remove the custom HTML of ${a.target}` : `Custom HTML on ${a.target}`;
    case "set_default_value": return a.value === null ? `Remove the default value of ${a.target}` : `Default value of ${a.target}: ${Array.isArray(a.value) ? a.value.join(", ") : a.value}`;
    default: return isOptionOp(a.op) ? describeOptionAction(a as OptionAction) : isQuotaOp(a.op) ? describeQuotaAction(a as QuotaAction) : isLocalizationOp(a.op) ? describeLocalizationAction(a as LocalizationAction) : describeAnalysisAction(a as AnalysisAction);
  }
}

/* ------------------------------------------------------------ the diff */

export interface QuestionChange { id: string; code: string; changes: { field: string; from: string; to: string }[] }
export interface SurveyDiff {
  blocksAdded: { id: string; title: string; questions: number }[];
  blocksRemoved: { id: string; title: string }[];
  blocksRenamed: { id: string; from: string; to: string }[];
  questionsAdded: { id: string; code: string; type: string; text: string; block?: string }[];
  questionsRemoved: { id: string; code: string; text: string }[];
  questionsModified: QuestionChange[];
  /** questions that changed place in the flow (block or position), with the question now before them */
  questionsMoved: { id: string; code: string; from: string; to: string }[];
  pages: { before: number; after: number };
  displayLogic: { added: number; changed: number; removed: number };
  skips: { added: number; removed: number };
  randomizers: number;
  embeddedAdded: string[];
  calculationsAdded: string[];
  quotasAdded: string[];
  researchChanged: boolean;
  /** styles, animations and behaviours added, changed, removed */
  ux: UxDiff;
  /** the theme's changed settings, field by field */
  theme: string[];
  /** "5 blocks, 28 questions, 2 skip conditions …" — the review line for a proposal */
  summary: string[];
  empty: boolean;
}

export function diffSurveys(before: SurveyDefinition, after: SurveyDefinition): SurveyDiff {
  const bq = new Map(before.questions.map((q) => [q.id, q]));
  const aq = new Map(after.questions.map((q) => [q.id, q]));
  const blocksB = listBlocks(before.flow as unknown[]), blocksA = listBlocks(after.flow as unknown[]);
  const bIds = new Map(blocksB.map((b) => [b.id, b]));
  const aIds = new Map(blocksA.map((b) => [b.id, b]));
  const blockOf = (def: SurveyDefinition, qid: string) => listBlocks(def.flow as unknown[]).find((b) => b.pages.some((p) => p.node.questionIds.includes(qid)));
  /*
   * A BLOCK'S IDENTITY ACROSS THE TWO SIDES. A bare page is listed as a block
   * of its own (its id is the page's); a page break wraps it in a real block
   * with a new id, and removing the break unwraps it again. Matched by id, that
   * read as "Add 1 block" and every question on the page "moved". A wrapped
   * block that holds a page which is a bare page on the other side is that
   * page's block — the same block, split or joined.
   */
  const keyOf = (b: { id: string; wrapped: boolean; pages: { node: { id: string } }[] } | undefined, other: Map<string, { wrapped: boolean }>) =>
    !b ? undefined : other.has(b.id) || !b.wrapped ? b.id : (b.pages.find((p) => other.get(p.node.id)?.wrapped === false)?.node.id ?? b.id);
  const cond = (def: SurveyDefinition, c: Condition | undefined) => (c ? formatCondition(def, c, { width: 400 }).replace(/\s+/g, " ") : "");
  const questionsAdded = after.questions.filter((q) => !bq.has(q.id)).map((q) => ({ id: q.id, code: q.code, type: typeLabel(q), text: plain(q.text, 90), block: blockOf(after, q.id)?.title }));
  const questionsRemoved = before.questions.filter((q) => !aq.has(q.id)).map((q) => ({ id: q.id, code: q.code, text: plain(q.text, 90) }));
  /*
   * MOVES ARE CHANGES. A question moved after another inside its block left
   * no trace here (only block changes were compared), so the review said
   * "nothing changed" about a reorder. Each kept question's predecessor in
   * flow order is compared instead — the pair (block, question before) names
   * a place.
   */
  const placeOf = (def: SurveyDefinition, order: string[], qid: string) => { const i = order.indexOf(qid); const prev = i > 0 ? def.questions.find((q) => q.id === order[i - 1]) : undefined; const b = blockOf(def, qid); return `${b?.title ?? "(no block)"}${i < 0 ? " · unplaced" : prev ? ` · after ${prev.code}` : " · first"}`; };
  const orderB = questionOrder(before), orderA = questionOrder(after);
  const kept = after.questions.filter((q) => bq.has(q.id));
  const keptB = orderB.filter((id) => aq.has(id)), keptA = orderA.filter((id) => bq.has(id));
  // the questions that moved are those outside the longest run both orders share — a swap names one question, not two
  const stayed = longestCommonSubsequence(keptB, keptA);
  const questionsMoved = kept.filter((q) => !stayed.has(q.id) || keyOf(blockOf(before, q.id), aIds) !== keyOf(blockOf(after, q.id), bIds)).map((q) => ({ id: q.id, code: q.code, from: placeOf(before, orderB, q.id), to: placeOf(after, orderA, q.id) }));
  const questionsModified: QuestionChange[] = [];
  let dAdded = 0, dChanged = 0, dRemoved = 0, sAdded = 0, sRemoved = 0;
  for (const q of after.questions) {
    const p = bq.get(q.id);
    if (!p) { if (q.displayLogic) dAdded++; sAdded += q.skipLogic?.length ?? 0; continue; }
    const ch: QuestionChange["changes"] = [];
    const push = (field: string, from: string, to: string) => { if (from !== to) ch.push({ field, from, to }); };
    push("type", typeLabel(p), typeLabel(q));
    push("text", plain(p.text, 120), plain(q.text, 120));
    // the rich content between the text and the answers — where HTML above the answers lives (October 2026)
    push("instruction", (p.instruction ?? "").slice(0, 160), (q.instruction ?? "").slice(0, 160));
    push("code", String(p.code), String(q.code));
    push("variable", p.variableName, q.variableName);
    push("required", p.required ? "required" : "optional", q.required ? "required" : "optional");
    push("options", (p.options ?? []).map((o) => o.label).join(" | "), (q.options ?? []).map((o) => o.label).join(" | "));
    /*
     * WHAT AN OPTION-LEVEL ACTION WRITES must read as a change too: a recode,
     * a flag (exclusive, other-specify, anchored), an option's own display
     * condition or export value, a mask. Only the labels were compared, so
     * "mask the brands selected in Q5 from Q10" or "recode B as 7" produced
     * a proposal the review called empty — and Apply refused it as nothing.
     */
    const optCodes = (x: Question) => (x.options ?? []).map((o) => `${o.code}=${o.label}`).join(" | ");
    if ((p.options ?? []).map((o) => o.label).join("|") === (q.options ?? []).map((o) => o.label).join("|")) push("option codes", optCodes(p), optCodes(q));
    const optFlags = (x: Question) => (x.options ?? []).filter((o) => o.flags?.length).map((o) => `${o.label}: ${o.flags!.join(", ")}`).join(" | ");
    push("option flags", optFlags(p), optFlags(q));
    const optVis = (d: SurveyDefinition, x: Question) => (x.options ?? []).filter((o) => o.visibleIf).map((o) => `${o.label}: ${cond(d, o.visibleIf)}`).join(" | ");
    push("option display conditions", optVis(before, p), optVis(after, q));
    const optVal = (x: Question) => (x.options ?? []).filter((o) => o.value !== undefined).map((o) => `${o.label}=${o.value}`).join(" | ");
    push("option values", optVal(p), optVal(q));
    for (const [key, field] of [["mask", "mask"], ["rowMask", "row mask"], ["columnMask", "column mask"]] as const) {
      const m = (d: SurveyDefinition, x: Question) => { const v = (x as Record<string, unknown>)[key] as OptionMask | undefined; return v ? `${v.action}: ${formatSetExpression(d, v.expr)}` : ""; };
      push(field, m(before, p), m(after, q));
    }
    push("custom JavaScript", (p.customJs ?? "").slice(0, 120), (q.customJs ?? "").slice(0, 120));
    push("custom CSS", (p.customCss ?? "").slice(0, 120), (q.customCss ?? "").slice(0, 120));
    push("rows", (p.rows ?? []).map((o) => o.label).join(" | "), (q.rows ?? []).map((o) => o.label).join(" | "));
    push("display logic", cond(before, p.displayLogic), cond(after, q.displayLogic));
    push("skip rules", String(p.skipLogic?.length ?? 0), String(q.skipLogic?.length ?? 0));
    // a rule's value is part of it: "between 18 and 99" → "between 21 and 99" keeps the kinds and must still read as a change
    const vText = (x: Question) => (x.validation ?? []).map((v) => `${v.kind}${v.value !== undefined && v.value !== null ? ` ${typeof v.value === "object" ? JSON.stringify(v.value) : v.value}` : ""}`).join(", ");
    push("validation", vText(p), vText(q));
    push("randomized", p.randomization?.enabled ? "yes" : "no", q.randomization?.enabled ? "yes" : "no");
    push("punch rules", punchText(before, p), punchText(after, q));
    // look-and-behaviour fields of a question: without them a proposal that only sets these would read as "no change"
    const dv = (x: Question) => { const v = (x.settings as { defaultValue?: unknown } | undefined)?.defaultValue; return v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v); };
    push("default value", dv(p), dv(q));
    push("custom HTML", (p.customHtml ?? "").slice(0, 120), (q.customHtml ?? "").slice(0, 120));
    push("block", blockOf(before, q.id)?.title ?? "", blockOf(after, q.id)?.title ?? "");
    // what the question is FOR (the analysis framework): a proposal that only tags questions must read as a change
    push("analysis", analysisText(p), analysisText(q));
    if (!p.displayLogic && q.displayLogic) dAdded++; else if (p.displayLogic && !q.displayLogic) dRemoved++; else if (p.displayLogic && q.displayLogic && cond(before, p.displayLogic) !== cond(after, q.displayLogic)) dChanged++;
    const ds = (q.skipLogic?.length ?? 0) - (p.skipLogic?.length ?? 0);
    if (ds > 0) sAdded += ds; else sRemoved -= ds;
    if (ch.length) questionsModified.push({ id: q.id, code: q.code, changes: ch });
  }
  for (const q of before.questions) if (!aq.has(q.id)) { if (q.displayLogic) dRemoved++; sRemoved += q.skipLogic?.length ?? 0; }
  const keysB = new Map(blocksB.map((b) => [keyOf(b, aIds)!, b]));
  const keysA = new Map(blocksA.map((b) => [keyOf(b, bIds)!, b]));
  const blocksAdded = blocksA.filter((b) => !keysB.has(keyOf(b, bIds)!) && !(b.pages.length === 1 && bIds.has(b.pages[0].node.id))).map((b) => ({ id: b.id, title: b.title ?? b.id, questions: b.pages.reduce((n, p) => n + p.node.questionIds.length, 0) }));
  const removedB = blocksB.filter((b) => !keysA.has(keyOf(b, aIds)!) && !blocksA.some((x) => x.pages.some((p) => p.node.id === b.id)));
  const blocksRemoved = removedB.map((b) => ({ id: b.id, title: b.title ?? b.id }));
  const blocksRenamed = blocksA.flatMap((b) => { const was = keysB.get(keyOf(b, bIds)!); return was && (was.title ?? "") !== (b.title ?? "") ? [{ id: b.id, from: was.title ?? "", to: b.title ?? "" }] : []; });
  const countType = (def: SurveyDefinition, t: string) => { let n = 0; const walk = (ns: FlowNode[]) => { for (const x of ns) { if (x.type === t) n++; const k = x as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] }; if (k.children) walk(k.children); if (k.branches) for (const b of k.branches) walk(b.children); if (k.otherwise) walk(k.otherwise); } }; walk(def.flow as FlowNode[]); return n; };
  const embeddedNames = (def: SurveyDefinition) => { const out: string[] = []; const walk = (ns: FlowNode[]) => { for (const x of ns) { if (x.type === "embedded_data") out.push(...x.fields.map((f) => f.name)); const k = x as { children?: FlowNode[] }; if (k.children) walk(k.children); } }; walk(def.flow as FlowNode[]); return out; };
  const eb = new Set(embeddedNames(before));
  const embeddedAdded = embeddedNames(after).filter((n) => !eb.has(n));
  const cb = new Set((before.calculations ?? []).map((c) => c.targetVariable));
  const calculationsAdded = (after.calculations ?? []).map((c) => c.targetVariable).filter((n) => !cb.has(n));
  const qb = new Set((before.quotas ?? []).map((c) => c.id));
  const quotasAdded = (after.quotas ?? []).filter((c) => !qb.has(c.id)).map((c) => c.name);
  const randomizers = countType(after, "randomizer") - countType(before, "randomizer");
  const branches = countType(after, "branch") - countType(before, "branch");
  const loops = countType(after, "loop") - countType(before, "loop");
  const pages = { before: listPages(before.flow as unknown[]).length, after: listPages(after.flow as unknown[]).length };
  const designOf = (d: SurveyDefinition) => { const r = d.research; return r ? JSON.stringify({ ...r, analysisPlan: undefined }) : null; };
  const researchChanged = designOf(before) !== designOf(after);
  const planLines = analysisPlanDiff(before.research?.analysisPlan, after.research?.analysisPlan);
  const langLines = localizationDiff(before, after);
  const ux = diffUx(before, after);
  const theme = diffTheme(before.branding, after.branding);
  const randomizedAdded = after.questions.filter((q) => q.randomization?.enabled && !bq.get(q.id)?.randomization?.enabled).length;
  const scales = new Map<number, number>();
  for (const q of questionsAdded.map((x) => aq.get(x.id)!)) if (/single_select|matrix/.test(q.type) && q.options?.length && q.options.every((o) => /^\d+$/.test(String(o.code))) && isScale(q)) scales.set(q.options.length, (scales.get(q.options.length) ?? 0) + 1);
  const n = (k: number, w: string, pl = `${w}s`) => `${k} ${k === 1 ? w : pl}`;
  const summary = [
    blocksAdded.length ? `Add ${n(blocksAdded.length, "block")}: ${blocksAdded.map((b) => `“${b.title}”`).join(", ")}` : "",
    questionsAdded.length ? `Add ${n(questionsAdded.length, "question")}` : "",
    ...[...scales].map(([k, c]) => `${n(c, `${k}-point scale`)}`),
    dAdded ? `Add ${n(dAdded, "display condition")}` : "",
    sAdded ? `Add ${n(sAdded, "skip condition")}` : "",
    randomizers > 0 ? `Add ${n(randomizers, "block randomizer")}` : "",
    branches > 0 ? `Add ${n(branches, "branch", "branches")}` : "",
    loops > 0 ? `Add ${n(loops, "loop")}` : "",
    randomizedAdded ? `Randomize the options of ${n(randomizedAdded, "question")}` : "",
    // a new block brings its own page; only the breaks beyond that are news
    pages.after - pages.before - blocksAdded.length > 0 ? `Add ${n(pages.after - pages.before - blocksAdded.length, "page break")}` : "",
    // pages joined — beyond the pages of the blocks that were deleted outright
    pages.before - pages.after - removedB.reduce((k, b) => k + b.pages.length, 0) > 0 ? `Remove ${n(pages.before - pages.after - removedB.reduce((k, b) => k + b.pages.length, 0), "page break")}` : "",
    embeddedAdded.length ? `Add embedded ${embeddedAdded.join(", ")}` : "",
    calculationsAdded.length ? `Add calculation${calculationsAdded.length === 1 ? "" : "s"} ${calculationsAdded.join(", ")}` : "",
    ...quotaDiff(before, after),
    ...questionsModified.slice(0, 30).map((m) => `Change ${m.code}: ${m.changes.map((c) => c.field === "type" ? `${c.from} → ${c.to}` : c.field === "text" ? "wording" : c.field).join(", ")}`),
    dChanged ? `Change ${n(dChanged, "display condition")}` : "",
    blocksRenamed.length ? `Rename ${blocksRenamed.map((b) => `“${b.from}” → “${b.to}”`).join(", ")}` : "",
    ...questionsMoved.slice(0, 10).map((m) => `Move ${m.code} (${m.to})`),
    questionsRemoved.length ? `Delete ${n(questionsRemoved.length, "question")}: ${questionsRemoved.map((q) => q.code).join(", ")}` : "",
    blocksRemoved.length ? `Delete ${n(blocksRemoved.length, "block")}: ${blocksRemoved.map((b) => `“${b.title}”`).join(", ")}` : "",
    dRemoved ? `Remove ${n(dRemoved, "display condition")}` : "",
    sRemoved ? `Remove ${n(sRemoved, "skip condition")}` : "",
    researchChanged ? "Record the research design (objective, hypotheses, constructs)" : "",
    ...planLines,
    ...langLines,
    ...(theme.length ? [`Theme: ${theme.slice(0, 6).join("; ")}${theme.length > 6 ? ` and ${theme.length - 6} more` : ""}`] : []),
    ...ux.added.map((x) => `Add ${x.kind} “${x.label}” on ${x.target}`),
    ...ux.changed.map((x) => `Change ${x.kind} “${x.label}” on ${x.target}`),
    ...ux.removed.map((x) => `Remove ${x.kind} “${x.label}” (${x.target})`),
  ].filter(Boolean);
  const empty = !summary.length;
  return { blocksAdded, blocksRemoved, blocksRenamed, questionsAdded, questionsRemoved, questionsModified, questionsMoved, pages, displayLogic: { added: dAdded, changed: dChanged, removed: dRemoved }, skips: { added: sAdded, removed: sRemoved }, randomizers, embeddedAdded, calculationsAdded, quotasAdded, researchChanged, ux, theme, summary, empty };
}

function longestCommonSubsequence(a: string[], b: string[]): Set<string> {
  const m = a.length, n = b.length;
  if (!m || !n) return new Set();
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = new Set<string>();
  for (let i = 0, j = 0; i < m && j < n;) { if (a[i] === b[j]) { out.add(a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return out;
}

function punchText(def: SurveyDefinition, q: Question): string {
  return (q.punches ?? []).map((r) => { try { return formatPunchExpression(def, q, r as never); } catch { return r.id; } }).join(" · ");
}

function isScale(q: Question): boolean {
  const n = q.options?.length ?? 0;
  if (n < 3 || n > 11) return false;
  const codes = q.options!.map((o) => Number(o.code));
  return codes.every((c, i) => i === 0 || c === codes[i - 1] + 1);
}

/**
 * NEW QUESTIONS NUMBERED IN ORDER. A proposal revised before it is applied
 * ("remove the trust block") leaves gaps in the codes it minted — Q1–Q4, Q6.
 * Before anything is applied, the questions the proposal CREATED (and only
 * those: an existing question's code is the researcher's, and exports and
 * documents name it) are renumbered in flow order after the survey's own
 * highest Q-number; a variable that was only the old code follows it, as do
 * piped references to it. Question ids never change, so logic is untouched.
 */
/** a question's analysis metadata as one comparable line */
function analysisText(q: Question): string {
  const a = q.analysis;
  if (!a) return "";
  return [a.role, a.measurement, a.construct, a.primary?.join("+"), a.crosstabBy?.join("+"), a.relatedTo?.join("+"), a.modeling?.join("+"), a.hypotheses?.join("+"), a.notes?.slice(0, 60)].map((x) => x ?? "").join("|");
}

/** the analysis plan's changes, as summary lines */
function analysisPlanDiff(before: AnalysisPlan | undefined, after: AnalysisPlan | undefined): string[] {
  if (!before && !after) return [];
  const n = (k: number, w: string, pl = `${w}s`) => `${k} ${k === 1 ? w : pl}`;
  if (!before && after) return [`Plan the analysis: ${n(after.crosstabs.length, "crosstab")}, ${n(after.tests.length, "test")}${after.derived.length ? `, ${n(after.derived.length, "derived variable")}` : ""}${after.segments.length ? `, ${n(after.segments.length, "segment")}` : ""}`];
  if (before && !after) return ["Remove the analysis plan"];
  const b = before!, a = after!;
  const out: string[] = [];
  const xtKey = (x: { rows: string[]; columns: string[] }) => `${x.rows.join("+")} by ${x.columns.join("+")}`;
  const tKey = (t: { method: string; outcome?: string; variables: string[]; groupBy?: string }) => `${t.method.replace(/_/g, " ")}${t.outcome ? ` on ${t.outcome}` : ""}${t.variables.length ? ` with ${t.variables.join(", ")}` : ""}${t.groupBy ? ` across ${t.groupBy}` : ""}`;
  const bx = new Set(b.crosstabs.map(xtKey)), ax = new Set(a.crosstabs.map(xtKey));
  const addedX = [...ax].filter((k) => !bx.has(k)), removedX = [...bx].filter((k) => !ax.has(k));
  if (addedX.length) out.push(addedX.length <= 3 ? `Plan crosstab${addedX.length === 1 ? "" : "s"}: ${addedX.join("; ")}` : `Plan ${n(addedX.length, "crosstab")}`);
  for (const k of removedX) out.push(`Remove the planned crosstab ${k}`);
  const bt = new Set(b.tests.map(tKey)), at = new Set(a.tests.map(tKey));
  const addedT = [...at].filter((k) => !bt.has(k)), removedT = [...bt].filter((k) => !at.has(k));
  if (addedT.length) out.push(addedT.length <= 3 ? `Plan ${addedT.join("; ")}` : `Plan ${n(addedT.length, "test")}`);
  for (const k of removedT) out.push(`Remove the planned ${k}`);
  const bd = new Set(b.derived.map((d) => d.name)), ad = new Set(a.derived.map((d) => d.name));
  const addedD = [...ad].filter((k) => !bd.has(k)), removedD = [...bd].filter((k) => !ad.has(k));
  if (addedD.length) out.push(`Plan derived variable${addedD.length === 1 ? "" : "s"} ${addedD.join(", ")}`);
  if (removedD.length) out.push(`Remove the planned derived variable${removedD.length === 1 ? "" : "s"} ${removedD.join(", ")}`);
  return out;
}

/** the languages, translations, glossary and routing: what changed, as summary lines */
function localizationDiff(before: SurveyDefinition, after: SurveyDefinition): string[] {
  const b = before.localization, a = after.localization;
  if (!b && !a) return [];
  const out: string[] = [];
  const bl = new Set((b?.languages ?? []).map((l) => l.code)), al = new Set((a?.languages ?? []).map((l) => l.code));
  for (const l of al) if (!bl.has(l)) out.push(`Add ${languageName(l, a!.languages.find((x) => x.code === l))} as a language`);
  for (const l of bl) if (!al.has(l)) out.push(`Remove the ${languageName(l, b!.languages.find((x) => x.code === l))} version`);
  for (const l of al) {
    const bc = (b?.languages ?? []).find((x) => x.code === l), ac = a!.languages.find((x) => x.code === l)!;
    if (bc && (bc.status !== ac.status || bc.enabled !== ac.enabled)) out.push(`${languageName(l, ac)}: ${bc.status !== ac.status ? ac.status : ""}${bc.enabled !== ac.enabled ? `${bc.status !== ac.status ? ", " : ""}${ac.enabled ? "offered" : "not offered"}` : ""}`);
    const bt = b?.translations?.[l] ?? {}, at = a?.translations?.[l] ?? {};
    let written = 0, approved = 0, confirmed = 0;
    // a translation that followed its option's recode is not a new one
    const moved = movedTranslationKeys(bt, at);
    for (const [k, t] of Object.entries(at)) {
      const p = bt[k] ?? (moved.has(k) ? bt[moved.get(k)!] : undefined);
      if (!p || p.text !== t.text) { if (t.text.trim() && t.status !== "not_translated") written++; continue; }
      // a confirmation re-stamps the source hash without changing the text — whether the stale state was stored ("outdated") or only detected (the hash no longer matched)
      if (p.sourceHash !== t.sourceHash && (p.status === "outdated" || t.status === "edited")) { confirmed++; continue; }
      if (p.status !== t.status && (t.status === "approved" || t.status === "reviewed")) approved++;
    }
    if (written) out.push(`Translate ${written} element${written === 1 ? "" : "s"} into ${languageName(l, ac)}`);
    if (approved) out.push(`Approve ${approved} ${languageName(l, ac)} translation${approved === 1 ? "" : "s"}`);
    if (confirmed) out.push(`Confirm ${confirmed} outdated ${languageName(l, ac)} translation${confirmed === 1 ? "" : "s"}`);
  }
  if (JSON.stringify(b?.routing ?? null) !== JSON.stringify(a?.routing ?? null)) out.push("Change the language routing");
  const bg = (b?.glossary ?? []).length, ag = (a?.glossary ?? []).length;
  if (JSON.stringify(b?.glossary ?? []) !== JSON.stringify(a?.glossary ?? [])) out.push(ag > bg ? `Add ${ag - bg} glossary term${ag - bg === 1 ? "" : "s"}` : ag < bg ? `Remove ${bg - ag} glossary term${bg - ag === 1 ? "" : "s"}` : "Change the glossary");
  return out;
}

export function renumberNewQuestions(base: SurveyDefinition, after: SurveyDefinition): SurveyDefinition {
  const old = new Set(base.questions.map((q) => q.id));
  const fresh = questionOrder(after).map((id) => after.questions.find((q) => q.id === id)!).filter((q) => q && !old.has(q.id) && /^Q\d+$/.test(String(q.code)));
  if (!fresh.length) return after;
  const taken = new Set(after.questions.filter((q) => !fresh.includes(q)).flatMap((q) => [String(q.code).toUpperCase(), q.variableName.toUpperCase()]));
  for (const c of after.calculations ?? []) taken.add(c.targetVariable.toUpperCase());
  let n = Math.max(0, ...base.questions.map((q) => (/^Q(\d+)$/.exec(String(q.code)) ? Number(/^Q(\d+)$/.exec(String(q.code))![1]) : 0)));
  const plan: { q: Question; code: string }[] = [];
  for (const q of fresh) { do n++; while (taken.has(`Q${n}`)); taken.add(`Q${n}`); plan.push({ q, code: `Q${n}` }); }
  if (plan.every((p) => p.q.code === p.code)) return after;
  const out = structuredClone(after) as SurveyDefinition;
  const renamedVars = new Map<string, string>();
  for (const p of plan) {
    const q = out.questions.find((x) => x.id === p.q.id)!;
    if (q.variableName === q.code && !taken.has(`${p.code}_VAR`)) renamedVars.set(q.variableName, p.code);
    q.code = p.code;
  }
  // a variable that was only its code follows the code — unless another question already holds that name
  const holders = new Set(out.questions.map((q) => q.variableName));
  for (const [from, to] of renamedVars) if (from !== to && holders.has(to)) renamedVars.delete(from);
  for (const q of out.questions) if (!old.has(q.id) && renamedVars.has(q.variableName)) q.variableName = renamedVars.get(q.variableName)!;
  if (renamedVars.size) for (const q of out.questions) if (!old.has(q.id)) q.text = q.text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/g, (m, v: string) => (renamedVars.has(v) ? m.replace(v, renamedVars.get(v)!) : m));
  return out;
}
