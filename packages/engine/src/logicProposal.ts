import type { Condition, DisplayRule, Question, SkipRule, SurveyDefinition } from "@rescript/schema";
import { listPages, listBlocks } from "./blocks.js";
import { conditionRefs, questionOrder } from "./dependencies.js";
import { addQuestion } from "./questionOps.js";
import { renameVariable } from "./variableUsage.js";
import { conditionSummary } from "./logicSummary.js";
import { findNode } from "./flowTree.js";

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
  | { kind: "rename_variable"; oldName: string; newName: string };

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
    }
  }
  return errors;
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
    }
  }
  return { def: cur, applied: changes.length, errors: [] };
}

/** the questions a proposal touches — for selecting them after Apply */
export function proposalTargets(changes: ProposalChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (c.kind === "set_display_logic" || c.kind === "add_skip_rule" || c.kind === "set_required") out.push(c.questionId);
    else if (c.kind === "add_question") out.push(c.question.id);
    else if (c.kind === "add_display_rule" && c.rule.target.kind === "question") out.push(c.rule.target.ref);
  }
  return [...new Set(out)];
}
