import type { Condition, DisplayRule, OptionMask, Question, SetExpr, SkipRule, SurveyDefinition, ValidationRule } from "@rescript/schema";
import { listPages, listBlocks } from "./blocks.js";
import { conditionRefs, questionOrder } from "./dependencies.js";
import { addQuestion } from "./questionOps.js";
import { renameVariable } from "./variableUsage.js";
import { conditionSummary } from "./logicSummary.js";
import { findNode } from "./flowTree.js";
import { formatSetExpression } from "./setExpression.js";

/**
 * A LOGIC PROPOSAL — what the Intelligent mode asks permission to do.
 *
 * The brief's rule for the natural-language mode is absolute: it "must NEVER
 * silently modify logic. Always show a review step." So a sentence typed by
 * the programmer is never turned into a mutation directly. It becomes a list
 * of CHANGES of the kinds below — a closed, typed vocabulary — which the
 * review card renders in words, and which `applyLogicProposal` performs only
 * when the programmer presses Apply.
 *
 * The vocabulary is deliberately small and every entry maps onto an edit the
 * Studio already performs by hand: display logic on a question, a skip rule,
 * a display rule on a page or block, the required flag, a new question, a
 * variable rename. Nothing here is a new way to express logic; a change
 * carries the canonical `Condition` tree the visual builder and the
 * expression editor already produce, so the evaluator, the linter, the
 * dependency index and the summaries all read the result without knowing
 * where it came from.
 *
 * Whether the sentence came from the deterministic grammar or from a
 * language model makes no difference on this side: both produce changes, and
 * a change is checked (`validateProposal`) against the survey it will be
 * applied to before Apply is even offered. A model that names a question
 * which does not exist produces an error, not a broken survey.
 */

export type ProposalChange =
  /** replace a question's display logic; `null` removes it */
  | { kind: "set_display_logic"; questionId: string; condition: Condition | null }
  /** a new skip rule on the question that triggers it */
  | { kind: "add_skip_rule"; questionId: string; rule: SkipRule }
  /** a survey-level display rule — for pages, blocks, options and rows */
  | { kind: "add_display_rule"; rule: DisplayRule }
  | { kind: "set_required"; questionId: string; required: boolean }
  /** an already-built question (the Studio's factory builds it; the engine places it) */
  | { kind: "add_question"; question: Question; at?: { pageId?: string; index?: number } }
  | { kind: "rename_variable"; oldName: string; newName: string }
  /**
   * Validation rules, merged by KIND: a rule replaces the question's existing
   * rule of the same kind and is otherwise appended, so "between 18 and 99"
   * sets min_value and max_value and leaves an email rule alone.
   */
  | { kind: "set_validation"; questionId: string; rules: ValidationRule[] }
  /** drop rules — the named kinds, or every rule when `kinds` is absent */
  | { kind: "clear_validation"; questionId: string; kinds?: ValidationRule["kind"][] }
  /** the question's option mask (universal masking); `null` removes it */
  | { kind: "set_mask"; questionId: string; mask: OptionMask | null };

export interface ProposalOutcome {
  /** the definition after the changes — the same object when every change mutates in place */
  def: SurveyDefinition;
  applied: number;
  /** why nothing was applied — Apply is all-or-nothing */
  errors: string[];
}

const q = (def: SurveyDefinition, id: string): Question | undefined => def.questions.find((x) => x.id === id);
const name = (def: SurveyDefinition, id: string): string => {
  const x = q(def, id);
  return x ? (x.code || x.variableName || x.id) : id;
};

/** the id of a page, block or section named by a rule target, or null */
function flowTargetExists(def: SurveyDefinition, ref: string): boolean {
  return !!findNode(def.flow as never, ref);
}

/**
 * Every reason a change cannot be applied to THIS survey, in words. Empty
 * means Apply is safe. Run before offering the button, and again inside
 * `applyLogicProposal`, because the survey may have changed in between.
 */
export function validateProposal(def: SurveyDefinition, changes: ProposalChange[]): string[] {
  const errors: string[] = [];
  const order = questionOrder(def);
  const at = (id: string) => order.indexOf(id);
  for (const c of changes) {
    switch (c.kind) {
      case "set_display_logic": {
        if (!q(def, c.questionId)) { errors.push(`No question ${c.questionId} to put display logic on.`); break; }
        if (c.condition) {
          const refs = conditionRefs(def, c.condition);
          if (refs.has(c.questionId)) errors.push(`${name(def, c.questionId)} cannot be shown based on its own answer.`);
          for (const r of refs) if (at(r) > at(c.questionId)) errors.push(`${name(def, r)} is asked after ${name(def, c.questionId)}, so its answer is not known yet.`);
        }
        break;
      }
      case "add_skip_rule": {
        if (!q(def, c.questionId)) { errors.push(`No question ${c.questionId} to hold the skip rule.`); break; }
        const t = c.rule.target;
        if (t.kind === "question" && (!t.ref || !q(def, t.ref))) errors.push(`The skip target question ${t.ref ?? "?"} does not exist.`);
        else if (t.kind === "question" && t.ref && at(t.ref) <= at(c.questionId)) errors.push(`A skip must jump forward: ${name(def, t.ref)} is not after ${name(def, c.questionId)}.`);
        else if ((t.kind === "page" || t.kind === "block" || t.kind === "section") && (!t.ref || !flowTargetExists(def, t.ref))) errors.push(`The skip target ${t.kind} ${t.ref ?? "?"} does not exist.`);
        else if (t.kind === "url" && !t.ref) errors.push("A skip to a URL needs the URL.");
        if (!c.rule.when) errors.push("A skip rule needs a condition.");
        if (q(def, c.questionId)?.skipLogic?.some((r) => r.id === c.rule.id)) errors.push(`Skip rule ${c.rule.id} already exists.`);
        break;
      }
      case "add_display_rule": {
        const t = c.rule.target;
        if (t.kind === "question") { if (!q(def, t.ref)) errors.push(`No question ${t.ref} for the display rule.`); }
        else if (t.kind === "option" || t.kind === "row" || t.kind === "column") {
          const owner = q(def, t.ref);
          if (!owner) errors.push(`No question ${t.ref} for the display rule.`);
          else if (!t.subRef) errors.push(`The display rule needs the ${t.kind} it applies to.`);
          else if (t.kind === "option" && !owner.options?.some((o) => String(o.code) === t.subRef)) errors.push(`${owner.code} has no option ${t.subRef}.`);
          else if (t.kind === "row" && !owner.rows?.some((r) => String(r.code) === t.subRef)) errors.push(`${owner.code} has no row ${t.subRef}.`);
        } else if (!flowTargetExists(def, t.ref)) errors.push(`No ${t.kind} ${t.ref} for the display rule.`);
        if (def.displayRules?.some((r) => r.id === c.rule.id)) errors.push(`Display rule ${c.rule.id} already exists.`);
        break;
      }
      case "set_required":
        if (!q(def, c.questionId)) errors.push(`No question ${c.questionId} to make ${c.required ? "required" : "optional"}.`);
        break;
      case "add_question": {
        if (def.questions.some((x) => x.id === c.question.id)) errors.push(`A question with id ${c.question.id} already exists.`);
        const taken = new Set<string>();
        for (const x of def.questions) { if (x.code) taken.add(x.code); if (x.variableName) taken.add(x.variableName); }
        if (taken.has(c.question.code)) errors.push(`The code ${c.question.code} is already in use.`);
        else if (taken.has(c.question.variableName)) errors.push(`The variable name ${c.question.variableName} is already in use.`);
        if (c.at?.pageId && !listPages(def.flow as unknown[]).some((p) => p.node.id === c.at!.pageId)) errors.push(`No page ${c.at.pageId} to add the question to.`);
        break;
      }
      case "rename_variable": {
        const r = renameVariable(def, c.oldName, c.newName);
        if (!r.ok) errors.push(...(r.impact.blockers.length ? r.impact.blockers : [`Cannot rename ${c.oldName} to ${c.newName}.`]));
        break;
      }
      case "set_validation": {
        const x = q(def, c.questionId);
        if (!x) { errors.push(`No question ${c.questionId} to validate.`); break; }
        if (!c.rules.length) errors.push("No validation rule to set.");
        const merged = mergeRules(x.validation ?? [], c.rules);
        const num = (k: ValidationRule["kind"]) => { const r = merged.find((v) => v.kind === k); return r && typeof r.value === "number" ? r.value : undefined; };
        for (const r of c.rules) {
          const fit = ruleFits(x, r.kind);
          if (fit) errors.push(fit);
          if (NUMERIC_RULE.has(r.kind) && (typeof r.value !== "number" || !Number.isFinite(r.value))) errors.push(`${ruleLabel(r.kind)} needs a number.`);
        }
        const lo = num("min_value"), hi = num("max_value");
        if (lo !== undefined && hi !== undefined && lo > hi) errors.push(`The minimum (${lo}) is above the maximum (${hi}).`);
        const ll = num("min_length"), lh = num("max_length");
        if (ll !== undefined && lh !== undefined && ll > lh) errors.push(`The minimum length (${ll}) is above the maximum (${lh}).`);
        const sl = num("min_selections"), sh = num("max_selections");
        if (sl !== undefined && sh !== undefined && sl > sh) errors.push(`The minimum selections (${sl}) is above the maximum (${sh}).`);
        if (sh !== undefined && x.options?.length && sh > x.options.length) errors.push(`${name(def, x.id)} has only ${x.options.length} options; at most ${sh} cannot be selected.`);
        break;
      }
      case "clear_validation": {
        const x = q(def, c.questionId);
        if (!x) { errors.push(`No question ${c.questionId}.`); break; }
        if (c.kinds && !c.kinds.some((k) => (x.validation ?? []).some((v) => v.kind === k))) errors.push(`${name(def, x.id)} has no ${c.kinds.map(ruleLabel).join(" or ")} rule to remove.`);
        if (!c.kinds && !(x.validation ?? []).length) errors.push(`${name(def, x.id)} has no validation rules to remove.`);
        break;
      }
      case "set_mask": {
        const x = q(def, c.questionId);
        if (!x) { errors.push(`No question ${c.questionId} to mask.`); break; }
        if (!c.mask) { if (!x.mask) errors.push(`${name(def, x.id)} has no mask to remove.`); break; }
        if (!x.options?.length && !/select|dropdown|rank|matrix/.test(x.type)) errors.push(`${name(def, x.id)} has no options to mask.`);
        for (const r of setExprRefs(c.mask.expr)) {
          if (!q(def, r)) errors.push(`The mask reads a question that does not exist (${r}).`);
          else if (r === x.id) errors.push(`${name(def, x.id)} cannot be masked by its own answer.`);
          else if (at(r) > at(x.id)) errors.push(`${name(def, r)} is asked after ${name(def, x.id)}, so its answer is not known yet.`);
        }
        break;
      }
    }
  }
  return errors;
}

/* ----------------------------------------------------------- validation helpers */

const NUMERIC_RULE = new Set<ValidationRule["kind"]>(["min_value", "max_value", "min_length", "max_length", "min_selections", "max_selections", "sum_equals", "sum_max", "sum_min"]);
const CHOICE_TYPES = /select|dropdown|image_select|rank/;

const RULE_LABEL: Partial<Record<ValidationRule["kind"], string>> = {
  min_value: "minimum value", max_value: "maximum value", min_length: "minimum length", max_length: "maximum length",
  min_selections: "minimum selections", max_selections: "maximum selections", email: "email", phone: "phone number", url: "web address",
  zip: "postal code", integer: "whole number", pattern: "pattern", date_min: "earliest date", date_max: "latest date", required: "required",
};
export const ruleLabel = (k: ValidationRule["kind"]): string => RULE_LABEL[k] ?? String(k).replace(/_/g, " ");

/** why a rule kind makes no sense on this question, or null */
function ruleFits(x: Question, kind: ValidationRule["kind"]): string | null {
  const t = x.type;
  const label = x.code || x.variableName;
  if ((kind === "min_selections" || kind === "max_selections") && !/multi|rank|checkbox/.test(t)) return `${label} is not a multi-select, so a selection count does not apply.`;
  if ((kind === "min_value" || kind === "max_value" || kind === "integer") && !/numeric|slider|nps|number|currency|percent/.test(t)) return `${label} is not numeric, so a value range does not apply.`;
  if ((kind === "min_length" || kind === "max_length" || kind === "email" || kind === "phone" || kind === "url" || kind === "zip" || kind === "pattern") && !/text/.test(t)) return `${label} is not a text question, so a ${ruleLabel(kind)} rule does not apply.`;
  if ((kind === "date_min" || kind === "date_max") && !/date/.test(t)) return `${label} is not a date question.`;
  return null;
}

function mergeRules(existing: ValidationRule[], next: ValidationRule[]): ValidationRule[] {
  const out = [...existing];
  for (const r of next) {
    const i = out.findIndex((v) => v.kind === r.kind);
    if (i >= 0) out[i] = { ...out[i], ...r }; else out.push(r);
  }
  return out;
}

/** every question a set expression reads */
export function setExprRefs(e: SetExpr, into: Set<string> = new Set()): Set<string> {
  switch (e.kind) {
    case "ref": into.add(e.questionId); break;
    case "complement": setExprRefs(e.of, into); break;
    case "op": setExprRefs(e.left, into); setExprRefs(e.right, into); break;
    default: break;
  }
  return into;
}

function ruleText(r: ValidationRule): string {
  const v = r.value;
  switch (r.kind) {
    case "min_value": return `at least ${v}`;
    case "max_value": return `at most ${v}`;
    case "min_length": return `at least ${v} characters`;
    case "max_length": return `at most ${v} characters`;
    case "min_selections": return `at least ${v} selection${v === 1 ? "" : "s"}`;
    case "max_selections": return `at most ${v} selection${v === 1 ? "" : "s"}`;
    case "integer": return "a whole number";
    case "email": return "an email address";
    case "phone": return "a phone number";
    case "url": return "a web address";
    case "zip": return "a postal code";
    case "pattern": return `matching ${v}`;
    default: return `${ruleLabel(r.kind)}${v !== undefined && v !== null && v !== "" && typeof v !== "object" ? ` ${v}` : ""}`;
  }
}

const MASK_ACTION_TEXT: Record<OptionMask["action"], string> = {
  display: "Show at", preselect: "Preselect at", display_and_preselect: "Show and preselect at", disable: "Disable at", remove: "Remove from",
};
export function maskSummary(def: SurveyDefinition, target: string, mask: OptionMask): string {
  return `${MASK_ACTION_TEXT[mask.action] ?? "Show at"} ${target} ${mask.action === "display" ? "only " : ""}the options ${formatSetExpression(def, mask.expr)}`;
}

/**
 * One change, in a sentence the review card shows — what WILL happen, before
 * it happens. Uses the same `conditionSummary` the Logic panel uses, so the
 * proposal reads the way the applied rule will read afterwards.
 */
export function describeChange(def: SurveyDefinition, c: ProposalChange): string {
  switch (c.kind) {
    case "set_display_logic":
      return c.condition
        ? `Show ${name(def, c.questionId)} only when ${conditionSummary(def, c.condition)}.`
        : `Remove the display logic from ${name(def, c.questionId)} (always shown).`;
    case "add_skip_rule": {
      const t = c.rule.target;
      const where = t.kind === "question" ? `to ${name(def, t.ref ?? "")}`
        : t.kind === "end" ? `to the end${t.status ? ` (${t.status.replace("_", " ")})` : ""}`
        : t.kind === "terminate" ? `out of the survey${t.status ? ` as ${t.status.replace("_", " ")}` : ""}`
        : t.kind === "url" ? `to ${t.ref}`
        : `to ${t.kind} ${flowLabel(def, t.ref ?? "")}`;
      return `After ${name(def, c.questionId)}, skip ${where} when ${conditionSummary(def, c.rule.when)}.`;
    }
    case "add_display_rule": {
      const t = c.rule.target;
      const what = t.kind === "question" ? name(def, t.ref)
        : (t.kind === "option" || t.kind === "row" || t.kind === "column") ? `${t.kind} ${t.subRef} of ${name(def, t.ref)}`
        : `${t.kind} ${flowLabel(def, t.ref)}`;
      return `${c.rule.action === "hide" ? "Hide" : "Show"} ${what} when ${conditionSummary(def, c.rule.when)}.`;
    }
    case "set_required":
      return `Make ${name(def, c.questionId)} ${c.required ? "required" : "optional"}.`;
    case "add_question": {
      const page = c.at?.pageId ? listPages(def.flow as unknown[]).find((p) => p.node.id === c.at!.pageId) : null;
      const text = (c.question.text ?? "").replace(/<[^>]+>/g, "").trim();
      return `Add ${c.question.code} (${c.question.type.replace(/_/g, " ")})${text ? ` — “${text}”` : ""}${page ? ` on ${page.node.title ?? page.node.id}` : " on the last page"}${c.question.options?.length ? `, ${c.question.options.length} options` : ""}.`;
    }
    case "rename_variable":
      return `Rename ${c.oldName} to ${c.newName} everywhere it is used.`;
    case "set_validation":
      return `Validate ${name(def, c.questionId)}: ${c.rules.map(ruleText).join(", ")}.`;
    case "clear_validation":
      return c.kinds ? `Remove the ${c.kinds.map(ruleLabel).join(" and ")} rule${c.kinds.length === 1 ? "" : "s"} from ${name(def, c.questionId)}.` : `Remove every validation rule from ${name(def, c.questionId)}.`;
    case "set_mask":
      return c.mask ? `${maskSummary(def, name(def, c.questionId), c.mask)}.` : `Remove the option mask from ${name(def, c.questionId)}.`;
  }
}

function flowLabel(def: SurveyDefinition, id: string): string {
  const b = listBlocks(def.flow as unknown[]).find((x) => x.node.id === id);
  if (b) return b.title || id;
  const p = listPages(def.flow as unknown[]).find((x) => x.node.id === id);
  return p?.node.title || id;
}

/**
 * Perform a proposal. ALL-OR-NOTHING: if any change fails validation against
 * the survey as it is now, nothing is touched and the errors come back. In
 * the Studio this runs inside `store.update`, so the result is one undo
 * step labelled with the proposal's summary.
 *
 * Mutates `def` in place for every change kind except the rename, whose
 * engine operation returns a new definition; the returned `def` is what the
 * caller should keep, either way.
 */
export function applyLogicProposal(def: SurveyDefinition, changes: ProposalChange[]): ProposalOutcome {
  const errors = validateProposal(def, changes);
  if (errors.length) return { def, applied: 0, errors };
  let cur = def;
  for (const c of changes) {
    switch (c.kind) {
      case "set_display_logic": {
        const x = q(cur, c.questionId)!;
        if (c.condition) x.displayLogic = c.condition; else delete (x as { displayLogic?: Condition }).displayLogic;
        break;
      }
      case "add_skip_rule": {
        const x = q(cur, c.questionId)!;
        x.skipLogic = [...(x.skipLogic ?? []), c.rule];
        break;
      }
      case "add_display_rule":
        cur.displayRules = [...(cur.displayRules ?? []), c.rule];
        break;
      case "set_required":
        q(cur, c.questionId)!.required = c.required;
        break;
      case "add_question":
        addQuestion(cur, c.question, c.at ?? {});
        break;
      case "rename_variable": {
        const r = renameVariable(cur, c.oldName, c.newName);
        if (!r.ok) return { def, applied: 0, errors: r.impact.blockers.length ? r.impact.blockers : [`Cannot rename ${c.oldName}.`] };
        // keep the caller's object identity when we can: the store hands out
        // a clone and takes back the same reference
        if (r.def !== cur) { Object.assign(cur, r.def); }
        break;
      }
      case "set_validation": {
        const x = q(cur, c.questionId)!;
        x.validation = mergeRules(x.validation ?? [], c.rules);
        break;
      }
      case "clear_validation": {
        const x = q(cur, c.questionId)!;
        x.validation = c.kinds ? (x.validation ?? []).filter((v) => !c.kinds!.includes(v.kind)) : [];
        break;
      }
      case "set_mask": {
        const x = q(cur, c.questionId)!;
        if (c.mask) x.mask = c.mask; else delete (x as { mask?: OptionMask }).mask;
        break;
      }
    }
  }
  return { def: cur, applied: changes.length, errors: [] };
}

/** the questions a proposal touches — for selecting them after Apply */
export function proposalTargets(changes: ProposalChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (c.kind === "set_display_logic" || c.kind === "add_skip_rule" || c.kind === "set_required" || c.kind === "set_validation" || c.kind === "clear_validation" || c.kind === "set_mask") out.push(c.questionId);
    else if (c.kind === "add_question") out.push(c.question.id);
    else if (c.kind === "add_display_rule" && c.rule.target.kind === "question") out.push(c.rule.target.ref);
  }
  return [...new Set(out)];
}
