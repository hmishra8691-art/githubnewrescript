import type { Condition, FlowNode, Question, SurveyDefinition, ValidationRule } from "@rescript/schema";
import { SurveyDefinition as SurveyDefinitionSchema, variantRegistry } from "@rescript/schema";
import { createQuestionFromVariant } from "./questionCreate.js";
import { defaultIds, removeQuestion, type IdMinter } from "./questionOps.js";
import { listBlocks, listPages } from "./blocks.js";
import { splitPageAfter, joinPageAfter } from "./pageBreaks.js";
import { addEmbeddedField, wrapInLoop } from "./structureOps.js";
import { parseLogicExpression, formatCondition } from "./logicExpression.js";
import { migrateQuestionType } from "./questionShape.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { runQualityCheck } from "./qualityCheck.js";
import { questionOrder } from "./dependencies.js";

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
export interface ValidationSpec { kind: string; value?: number | string }

export type SurveyAction =
  | { op: "create_block"; ref?: string; title: string; after?: string }
  | { op: "rename_block"; target: string; title: string }
  | { op: "delete_block"; target: string }
  | { op: "create_question"; ref?: string; block?: string; after?: string; newPage?: boolean; type: string; text: string; code?: string; variable?: string; options?: OptionSpec[]; rows?: string[]; scale?: ScaleSpec; required?: boolean; randomize?: boolean; instruction?: string; validation?: ValidationSpec[] }
  | { op: "update_question"; target: string; text?: string; type?: string; code?: string; variable?: string; required?: boolean; instruction?: string; options?: OptionSpec[]; addOptions?: OptionSpec[]; removeOptions?: (string | number)[]; rows?: string[]; scale?: ScaleSpec; randomize?: boolean }
  | { op: "delete_question"; target: string }
  | { op: "move_question"; target: string; block?: string; after?: string }
  | { op: "set_display_logic"; target: string; expression: string | null }
  | { op: "add_skip"; from: string; when: string; to: string }
  | { op: "clear_skips"; target: string }
  | { op: "set_validation"; target: string; rules: ValidationSpec[] }
  | { op: "page_break"; after: string; remove?: boolean }
  | { op: "create_embedded"; name: string; source?: "url" | "static" | "panel" | "expression"; value?: string }
  | { op: "create_calculation"; name: string; expression: string; label?: string; dataType?: "numeric" | "text" | "boolean" }
  | { op: "create_randomizer"; blocks: string[]; show?: number; title?: string }
  | { op: "create_branch"; blocks: string[]; when: string; title?: string }
  | { op: "create_loop"; from: string; to: string; over?: string; items?: string[]; loopVar?: string; title?: string }
  | { op: "create_quota"; name: string; cells: { label: string; when: string; limit: number }[]; onFull?: "terminate" | "flag" }
  | { op: "set_research"; objective?: string; hypotheses?: string[]; population?: string; methodology?: string; constructs?: { name: string; role?: string; definition?: string; questions?: string[] }[]; analysis?: string[]; assumptions?: string[]; sources?: string[] };

export const SURVEY_ACTION_OPS = [
  "create_block", "rename_block", "delete_block", "create_question", "update_question", "delete_question", "move_question",
  "set_display_logic", "add_skip", "clear_skips", "set_validation", "page_break", "create_embedded", "create_calculation",
  "create_randomizer", "create_branch", "create_loop", "create_quota", "set_research",
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

const VALIDATION_KINDS = new Set(["required", "min_value", "max_value", "min_length", "max_length", "min_selections", "max_selections", "sum_equals", "sum_max", "sum_min", "pattern", "email", "phone", "url", "zip", "date_min", "date_max", "integer"]);

/* ------------------------------------------------------------ the gate */

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
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
  return v.map((r) => {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const kind = str(o.kind);
    if (!kind || !VALIDATION_KINDS.has(kind)) return null;
    const value = strOrNum(o.value);
    return { kind, ...(value !== undefined ? { value } : {}) };
  }).filter((x): x is ValidationSpec => !!x);
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
    case "set_display_logic": { const target = str(o.target); if (!target) return "set_display_logic needs a target"; const e = o.expression === null ? null : str(o.expression); if (e === undefined) return "set_display_logic needs an expression (or null to remove it)"; return { op, target, expression: e }; }
    case "add_skip": { const from = str(o.from), when = str(o.when), to = str(o.to); return from && when && to ? { op, from, when, to } : "add_skip needs from, when and to"; }
    case "clear_skips": { const target = str(o.target); return target ? { op, target } : "clear_skips needs a target"; }
    case "set_validation": { const target = str(o.target); const rules = validations(o.rules); return target && rules ? { op, target, rules } : "set_validation needs a target and rules"; }
    case "page_break": { const after = str(o.after); return after ? { op, after, ...(bool(o.remove) ? { remove: true } : {}) } : "page_break needs after"; }
    case "create_embedded": {
      const name = str(o.name); if (!name) return "create_embedded needs a name";
      const source = ["url", "static", "panel", "expression"].includes(String(o.source)) ? (o.source as "url") : (str(o.value) ? "static" : "url");
      return { op, name, source, ...(str(o.value) ? { value: str(o.value) } : {}) };
    }
    case "create_calculation": { const name = str(o.name), expression = str(o.expression); return name && expression ? { op, name, expression, ...(str(o.label) ? { label: str(o.label) } : {}), ...(["numeric", "text", "boolean"].includes(String(o.dataType)) ? { dataType: o.dataType as "numeric" } : {}) } : "create_calculation needs name and expression"; }
    case "create_randomizer": { const blocks = strs(o.blocks); if (!blocks || blocks.length < 2) return "create_randomizer needs two or more blocks"; const show = Number(o.show); return { op, blocks, ...(Number.isInteger(show) && show > 0 ? { show } : {}), ...(str(o.title) ? { title: str(o.title) } : {}) }; }
    case "create_branch": { const blocks = strs(o.blocks), when = str(o.when); return blocks?.length && when ? { op, blocks, when, ...(str(o.title) ? { title: str(o.title) } : {}) } : "create_branch needs blocks and when"; }
    case "create_loop": {
      const from = str(o.from), to = str(o.to) ?? str(o.from);
      if (!from || !to) return "create_loop needs from (and to)";
      const items = strs(o.items, 100);
      if (!str(o.over) && !items?.length) return "create_loop needs over (a question) or items";
      return { op, from, to, ...(str(o.over) ? { over: str(o.over) } : {}), ...(items?.length ? { items } : {}), ...(str(o.loopVar) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(str(o.loopVar)!) ? { loopVar: str(o.loopVar) } : {}), ...(str(o.title) ? { title: str(o.title) } : {}) };
    }
    case "create_quota": {
      const name = str(o.name); const cells = Array.isArray(o.cells) ? o.cells.map((c) => { const x = (c ?? {}) as Record<string, unknown>; const label = str(x.label), when = str(x.when), limit = Number(x.limit); return label && when && Number.isFinite(limit) && limit > 0 ? { label, when, limit } : null; }).filter((x): x is { label: string; when: string; limit: number } => !!x) : [];
      return name && cells.length ? { op, name, cells, ...(o.onFull === "flag" ? { onFull: "flag" as const } : {}) } : "create_quota needs a name and cells with label, when and limit";
    }
    case "set_research": {
      const constructs = Array.isArray(o.constructs) ? o.constructs.map((c) => { const x = (c ?? {}) as Record<string, unknown>; const name = str(x.name); return name ? { name, ...(str(x.role) ? { role: str(x.role) } : {}), ...(str(x.definition) ? { definition: str(x.definition) } : {}), ...(strs(x.questions) ? { questions: strs(x.questions) } : {}) } : null; }).filter((x): x is NonNullable<typeof x> => !!x) : undefined;
      return { op, ...(str(o.objective) ? { objective: str(o.objective) } : {}), ...(strs(o.hypotheses) ? { hypotheses: strs(o.hypotheses) } : {}), ...(str(o.population) ? { population: str(o.population) } : {}), ...(str(o.methodology) ? { methodology: str(o.methodology) } : {}), ...(constructs ? { constructs } : {}), ...(strs(o.analysis) ? { analysis: strs(o.analysis) } : {}), ...(strs(o.assumptions) ? { assumptions: strs(o.assumptions) } : {}), ...(strs(o.sources) ? { sources: strs(o.sources) } : {}) };
    }
    default:
      return op ? `unknown action “${op}”` : "an action needs an op";
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
}

interface Ctx { def: SurveyDefinition; ids: IdMinter; refs: Map<string, string>; blockRefs: Map<string, string>; lastBlock: string | null; now: string }

type PageNode = Extract<FlowNode, { type: "page" }>;

export function applySurveyActions(input: SurveyDefinition, actions: SurveyAction[], opts: { ids?: IdMinter; now?: string } = {}): ApplyActionsOutcome {
  const before = input;
  let def = structuredClone(input) as SurveyDefinition;
  const ctx: Ctx = { def, ids: opts.ids ?? defaultIds, refs: new Map(), blockRefs: new Map(), lastBlock: null, now: opts.now ?? new Date().toISOString() };
  const results: ActionResult[] = [];
  // the research design names the questions that measure each construct, so it is recorded after they exist
  const order = actions.map((a, index) => ({ a, index })).sort((x, y) => Number(x.a.op === "set_research") - Number(y.a.op === "set_research"));
  order.forEach(({ a, index }) => {
    const snapshot = structuredClone(def) as SurveyDefinition;
    ctx.def = def;
    try {
      const r = apply(ctx, a);
      results.push({ index, op: a.op, ok: true, description: r.description, touched: r.touched ?? [], ...(r.destructive ? { destructive: r.destructive } : {}) });
    } catch (e) {
      def = snapshot; ctx.def = def;
      results.push({ index, op: a.op, ok: false, description: describeAction(a), error: (e as Error).message, touched: [] });
    }
    def = ctx.def;
  });
  const parsed = SurveyDefinitionSchema.safeParse(def);
  results.sort((x, y) => x.index - y.index);
  const errors = results.filter((r) => !r.ok).map((r) => `${describeAction(actions[r.index])}: ${r.error}`);
  if (!parsed.success) {
    return { def: before, results, errors: [...errors, ...parsed.error.issues.slice(0, 5).map((i) => `The result does not pass the survey schema at ${i.path.join(".")}: ${i.message}`)], warnings: [], destructive: [], refs: Object.fromEntries(ctx.refs), valid: false };
  }
  const after = parsed.data;
  const beforeIssues = new Set(runQualityCheck(before).areas.flatMap((x) => x.issues).filter((i) => i.level === "error").map((i) => i.message));
  const warnings = runQualityCheck(after).areas.flatMap((x) => x.issues).filter((i) => i.level === "error" && !beforeIssues.has(i.message)).map((i) => `${i.questionCode ? `${i.questionCode}: ` : ""}${i.message}`);
  return { def: after, results, errors, warnings: [...new Set(warnings)].slice(0, 40), destructive: results.filter((r) => r.ok && r.destructive).map((r) => r.destructive!), refs: Object.fromEntries(ctx.refs), valid: true };
}

class ActionError extends Error {}
const fail = (m: string): never => { throw new ActionError(m); };

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
      if (a.code && a.code !== q.code) {
        if (def.questions.some((x) => x.id !== q.id && String(x.code).toLowerCase() === a.code!.toLowerCase())) fail(`code ${a.code} is already used`);
        what.push(`code ${q.code} → ${a.code}`); q.code = a.code;
      }
      if (a.variable && a.variable !== q.variableName) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.variable)) fail(`${a.variable} is not a valid variable name`);
        if (def.questions.some((x) => x.id !== q.id && x.variableName.toLowerCase() === a.variable!.toLowerCase())) fail(`variable ${a.variable} is already used`);
        lossy.push(`renames variable ${q.variableName} to ${a.variable} (exports and logic that name it by variable change)`);
        what.push(`variable ${q.variableName} → ${a.variable}`); q.variableName = a.variable;
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
      return { description: `Changed ${q.code}: ${what.join(", ")}`, touched: [q.id], ...(lossy.length ? { destructive: lossy.join("; ") } : {}) };
    }
    case "delete_question": {
      const q = resolveQuestion(ctx, a.target);
      const placedBefore = placedIds(def);
      const refs = removeQuestion(def, q.id);
      // removing a question also removes logic that named it — a branch arm among them, and with it whatever it held
      const stranded = def.questions.filter((x) => placedBefore.has(x.id) && !placedIds(def).has(x.id)).map((x) => x.code);
      return { description: `Deleted ${q.code}: ${plain(q.text, 60)}`, destructive: `Deletes ${q.code}${refs.length ? ` and ${refs.length} reference${refs.length === 1 ? "" : "s"} to it` : ""}${stranded.length ? ` — which leaves ${stranded.join(", ")} on no page` : ""}`, touched: [q.id] };
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
      q.validation = a.rules.map((r) => ({ id: ctx.ids("val"), kind: r.kind, ...(r.value !== undefined ? { value: r.value } : {}) })) as ValidationRule[];
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
      const ids = a.blocks.map((b) => resolveTop(ctx, b));
      const flow = def.flow as FlowNode[];
      const idx = ids.map((id) => flow.findIndex((n) => n.id === id));
      if (idx.some((i) => i < 0)) fail("only blocks at the top level of the survey flow can go into a branch");
      const sorted = [...idx].sort((x, y) => x - y);
      if (sorted.some((v, k) => k > 0 && v !== sorted[k - 1] + 1)) fail("the blocks of a branch must sit next to each other in the flow");
      const when = parseCondition(def, withRefs(ctx, a.when));
      // the condition may only read questions asked before the branch
      const order = questionOrder(def);
      const firstInside = Math.min(...sorted.flatMap((i) => listPages([flow[i]]).flatMap((p) => p.node.questionIds)).map((q) => order.indexOf(q)).filter((x) => x >= 0));
      const reads = new Set<string>(); collectRefs(when, reads, def);
      if ([...reads].some((q) => order.indexOf(q) >= firstInside)) fail("a branch condition can only read questions asked before the branch");
      const nodes = sorted.map((i) => flow[i]);
      const node = { type: "branch", id: ctx.ids("branch"), ...(a.title ? { title: a.title } : {}), branches: [{ id: ctx.ids("arm"), label: a.title, when, children: nodes }] } as unknown as FlowNode;
      flow.splice(sorted[0], nodes.length, node);
      return { description: `${nodes.map((n) => `“${(n as { title?: string }).title ?? n.id}”`).join(", ")} only when ${formatCondition(def, when)}`, touched: ids };
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
    case "create_quota": {
      const cells = a.cells.map((c) => ({ id: ctx.ids("cell"), label: c.label, when: parseCondition(def, withRefs(ctx, c.when)), limit: c.limit, limitType: "count" }));
      const quota = { id: ctx.ids("quota"), name: a.name, mode: "hard", cells, onFull: { kind: a.onFull ?? "terminate" }, countStatus: ["complete"] };
      def.quotas = [...(def.quotas ?? []), quota as never];
      // the check goes after the block that asks the last question the cells read
      const order = questionOrder(def);
      const read = new Set<string>();
      for (const c of cells) collectRefs(c.when, read, def);
      const last = [...read].sort((x, y) => order.indexOf(y) - order.indexOf(x))[0];
      const flow = def.flow as FlowNode[];
      const top = last ? flow.findIndex((n) => containsQuestion(n, last)) : -1;
      flow.splice(top >= 0 ? top + 1 : endIndex(flow), 0, { type: "quota_check", id: ctx.ids("quota_check"), quotaIds: [quota.id], onFull: { kind: quota.onFull.kind } } as never);
      return { description: `Quota “${a.name}”: ${cells.map((c) => `${c.label} ≤ ${c.limit}`).join(", ")}`, touched: [] };
    }
    case "set_research": {
      const map = (xs: string[] | undefined) => (xs ?? []).map((r) => tryQuestion(ctx, r)?.id).filter((x): x is string => !!x);
      const prev = def.research;
      def.research = {
        objective: a.objective ?? prev?.objective,
        hypotheses: a.hypotheses ?? prev?.hypotheses ?? [],
        population: a.population ?? prev?.population,
        methodology: a.methodology ?? prev?.methodology,
        constructs: a.constructs ? a.constructs.map((c) => ({ name: c.name, role: (ROLES.has(String(c.role)) ? c.role : "descriptive") as never, ...(c.definition ? { definition: c.definition } : {}), questionIds: map(c.questions) })) : prev?.constructs ?? [],
        analysis: a.analysis ?? prev?.analysis ?? [],
        assumptions: a.assumptions ?? prev?.assumptions ?? [],
        sources: a.sources ?? prev?.sources ?? [],
        updatedAt: ctx.now,
      } as never;
      return { description: `Research design: ${[a.objective ? "objective" : "", a.hypotheses?.length ? `${a.hypotheses.length} hypothes${a.hypotheses.length === 1 ? "is" : "es"}` : "", a.constructs?.length ? `${a.constructs.length} constructs` : ""].filter(Boolean).join(", ") || "updated"}`, touched: [] };
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

function withRefs(ctx: Ctx, text: string): string {
  if (!ctx.refs.size) return text;
  return text.split(/("[^"]*"|'[^']*')/).map((part, i) => i % 2 ? part : part.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (w) => {
    const id = ctx.refs.get(w.toLowerCase());
    if (!id) return w;
    const q = ctx.def.questions.find((x) => x.id === id);
    if (!q || q.variableName.toLowerCase() === w.toLowerCase() || String(q.code).toLowerCase() === w.toLowerCase()) return w;
    return String(q.code);
  })).join("");
}

function parseCondition(def: SurveyDefinition, text: string, selfId?: string): Condition {
  const r = parseLogicExpression(def, text);
  if (r.errors.length || !r.condition) fail(`the condition “${text}” does not parse: ${r.errors[0]?.message ?? "empty"}`);
  if (selfId) {
    const refs = new Set<string>(); collectRefs(r.condition!, refs, def);
    if (refs.has(selfId)) fail(`a question's display logic cannot read the question itself`);
  }
  return r.condition!;
}
function collectRefs(c: Condition, into: Set<string>, def: SurveyDefinition): void {
  if (c.type === "group") { for (const k of c.children) collectRefs(k, into, def); return; }
  if (c.source.kind === "question") { const q = getQuestionByCodeOrVar(def, c.source.ref); if (q) into.add(q.id); }
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
/** before the survey's trailing End node(s) */
function endIndex(flow: FlowNode[]): number {
  let i = flow.length;
  while (i > 0 && flow[i - 1].type === "end") i--;
  return i;
}
/** after the embedded-data setup at the top of the flow */
function leadingSetupEnd(flow: FlowNode[]): number {
  let i = 0;
  while (i < flow.length && flow[i].type === "embedded_data") i++;
  return i;
}
function containsQuestion(n: FlowNode, qid: string): boolean {
  if (n.type === "page") return n.questionIds.includes(qid);
  const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
  for (const list of [k.children, ...(k.branches ?? []).map((b) => b.children), k.otherwise]) if (list?.some((c) => containsQuestion(c, qid))) return true;
  return false;
}

/* ------------------------------------------------------------ words */

export function describeAction(a: SurveyAction): string {
  switch (a.op) {
    case "create_block": return `Create block “${a.title}”`;
    case "rename_block": return `Rename block ${a.target} to “${a.title}”`;
    case "delete_block": return `Delete block ${a.target}`;
    case "create_question": return `Create ${a.type} question “${plain(a.text, 50)}”`;
    case "update_question": return `Change ${a.target}`;
    case "delete_question": return `Delete ${a.target}`;
    case "move_question": return `Move ${a.target}`;
    case "set_display_logic": return a.expression === null ? `Remove the display logic of ${a.target}` : `Show ${a.target} only when ${a.expression}`;
    case "add_skip": return `After ${a.from}, when ${a.when}, go to ${a.to}`;
    case "clear_skips": return `Remove the skip rules of ${a.target}`;
    case "set_validation": return `Set the validation of ${a.target}`;
    case "page_break": return a.remove ? `Remove the page break after ${a.after}` : `Page break after ${a.after}`;
    case "create_embedded": return `Create embedded variable ${a.name}`;
    case "create_calculation": return `Create calculation ${a.name}`;
    case "create_randomizer": return `Randomize ${a.blocks.join(", ")}`;
    case "create_branch": return `Show ${a.blocks.join(", ")} only when ${a.when}`;
    case "create_loop": return `Loop ${a.from}${a.to !== a.from ? `–${a.to}` : ""}`;
    case "create_quota": return `Create quota ${a.name}`;
    case "set_research": return "Record the research design";
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
  pages: { before: number; after: number };
  displayLogic: { added: number; changed: number; removed: number };
  skips: { added: number; removed: number };
  randomizers: number;
  embeddedAdded: string[];
  calculationsAdded: string[];
  quotasAdded: string[];
  researchChanged: boolean;
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
  const cond = (def: SurveyDefinition, c: Condition | undefined) => (c ? formatCondition(def, c, { width: 400 }).replace(/\s+/g, " ") : "");
  const questionsAdded = after.questions.filter((q) => !bq.has(q.id)).map((q) => ({ id: q.id, code: q.code, type: typeLabel(q), text: plain(q.text, 90), block: blockOf(after, q.id)?.title }));
  const questionsRemoved = before.questions.filter((q) => !aq.has(q.id)).map((q) => ({ id: q.id, code: q.code, text: plain(q.text, 90) }));
  const questionsModified: QuestionChange[] = [];
  let dAdded = 0, dChanged = 0, dRemoved = 0, sAdded = 0, sRemoved = 0;
  for (const q of after.questions) {
    const p = bq.get(q.id);
    if (!p) { if (q.displayLogic) dAdded++; sAdded += q.skipLogic?.length ?? 0; continue; }
    const ch: QuestionChange["changes"] = [];
    const push = (field: string, from: string, to: string) => { if (from !== to) ch.push({ field, from, to }); };
    push("type", typeLabel(p), typeLabel(q));
    push("text", plain(p.text, 120), plain(q.text, 120));
    push("code", String(p.code), String(q.code));
    push("variable", p.variableName, q.variableName);
    push("required", p.required ? "required" : "optional", q.required ? "required" : "optional");
    push("options", (p.options ?? []).map((o) => o.label).join(" | "), (q.options ?? []).map((o) => o.label).join(" | "));
    push("rows", (p.rows ?? []).map((o) => o.label).join(" | "), (q.rows ?? []).map((o) => o.label).join(" | "));
    push("display logic", cond(before, p.displayLogic), cond(after, q.displayLogic));
    push("skip rules", String(p.skipLogic?.length ?? 0), String(q.skipLogic?.length ?? 0));
    push("validation", (p.validation ?? []).map((v) => v.kind).join(", "), (q.validation ?? []).map((v) => v.kind).join(", "));
    push("randomized", p.randomization?.enabled ? "yes" : "no", q.randomization?.enabled ? "yes" : "no");
    push("block", blockOf(before, q.id)?.title ?? "", blockOf(after, q.id)?.title ?? "");
    if (!p.displayLogic && q.displayLogic) dAdded++; else if (p.displayLogic && !q.displayLogic) dRemoved++; else if (p.displayLogic && q.displayLogic && cond(before, p.displayLogic) !== cond(after, q.displayLogic)) dChanged++;
    const ds = (q.skipLogic?.length ?? 0) - (p.skipLogic?.length ?? 0);
    if (ds > 0) sAdded += ds; else sRemoved -= ds;
    if (ch.length) questionsModified.push({ id: q.id, code: q.code, changes: ch });
  }
  for (const q of before.questions) if (!aq.has(q.id)) { if (q.displayLogic) dRemoved++; sRemoved += q.skipLogic?.length ?? 0; }
  const blocksAdded = blocksA.filter((b) => !bIds.has(b.id) && !(b.pages.length === 1 && bIds.has(b.pages[0].node.id))).map((b) => ({ id: b.id, title: b.title ?? b.id, questions: b.pages.reduce((n, p) => n + p.node.questionIds.length, 0) }));
  const blocksRemoved = blocksB.filter((b) => !aIds.has(b.id) && !blocksA.some((x) => x.pages.some((p) => p.node.id === b.id))).map((b) => ({ id: b.id, title: b.title ?? b.id }));
  const blocksRenamed = blocksA.filter((b) => bIds.has(b.id) && (bIds.get(b.id)!.title ?? "") !== (b.title ?? "")).map((b) => ({ id: b.id, from: bIds.get(b.id)!.title ?? "", to: b.title ?? "" }));
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
  const researchChanged = JSON.stringify(before.research ?? null) !== JSON.stringify(after.research ?? null);
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
    embeddedAdded.length ? `Add embedded ${embeddedAdded.join(", ")}` : "",
    calculationsAdded.length ? `Add calculation${calculationsAdded.length === 1 ? "" : "s"} ${calculationsAdded.join(", ")}` : "",
    quotasAdded.length ? `Add quota${quotasAdded.length === 1 ? "" : "s"} ${quotasAdded.map((x) => `“${x}”`).join(", ")}` : "",
    ...questionsModified.slice(0, 30).map((m) => `Change ${m.code}: ${m.changes.map((c) => c.field === "type" ? `${c.from} → ${c.to}` : c.field === "text" ? "wording" : c.field).join(", ")}`),
    dChanged ? `Change ${n(dChanged, "display condition")}` : "",
    blocksRenamed.length ? `Rename ${blocksRenamed.map((b) => `“${b.from}” → “${b.to}”`).join(", ")}` : "",
    questionsRemoved.length ? `Delete ${n(questionsRemoved.length, "question")}: ${questionsRemoved.map((q) => q.code).join(", ")}` : "",
    blocksRemoved.length ? `Delete ${n(blocksRemoved.length, "block")}: ${blocksRemoved.map((b) => `“${b.title}”`).join(", ")}` : "",
    dRemoved ? `Remove ${n(dRemoved, "display condition")}` : "",
    sRemoved ? `Remove ${n(sRemoved, "skip condition")}` : "",
    researchChanged ? "Record the research design (objective, hypotheses, constructs)" : "",
  ].filter(Boolean);
  const empty = !summary.length;
  return { blocksAdded, blocksRemoved, blocksRenamed, questionsAdded, questionsRemoved, questionsModified, pages, displayLogic: { added: dAdded, changed: dChanged, removed: dRemoved }, skips: { added: sAdded, removed: sRemoved }, randomizers, embeddedAdded, calculationsAdded, quotasAdded, researchChanged, summary, empty };
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
