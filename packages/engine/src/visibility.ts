import type { Question, SurveyDefinition } from "@rescript/schema";
import type { EvalContext, EvalTrace } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import { visibleByRules } from "./displayRules.js";
import { effectiveQuestion } from "./carryforward.js";
import { effectiveResponseModel } from "@rescript/schema";
import { listFillHiddenDestinations } from "./listFill.js";
import { answerKey, getQuestion, type LoopContext, type ResponseState } from "./state.js";
import type { RuntimeStep } from "./flow.js";
import type { QuotaCounts } from "./quotas.js";
import { otherKey } from "./otherSpecify.js";
import { sourceKindForQuestion } from "./lintLogic.js";
import { adaptedQuestion } from "./adaptive.js";

/**
 * WHY IS THIS VISIBLE, AND WHY IS THAT NOT.
 *
 * Display logic has two scopes and they are not peers. A QUESTION's logic
 * decides whether the question is asked at all; an OPTION's (or row's, or
 * column's) decides which of its items are offered. The question is the
 * parent: if it is hidden, there are no items to speak of — not "hidden
 * items", not "items whose own rule said show". That was already how the
 * runtime behaved, because `visibleQuestions` filters the page before
 * `effectiveQuestion` is ever called on anything; what was missing was
 * anywhere that SAID so. The debug panel ran the option pipeline for every
 * question on the page, hidden ones included, and printed the result next to
 * a display-logic verdict that said the opposite.
 *
 * `explainVisibility` is the single answer to both questions, in the order
 * the runtime resolves them:
 *
 *     1. is this question the kind that is asked at all?      (type, hidden)
 *     2. does its own display logic pass?                     (displayLogic)
 *     3. do the survey's named rules allow it?                (displayRules)
 *     4. did a List Fill leave it with nothing?               (listFill)
 *     --- only if all four say yes ---
 *     5. which of its options / rows / columns survive?       (item pipeline)
 *
 * A question that fails any of 1–4 reports every item as unavailable with
 * `decidedBy: "question_hidden"` — the parent scope, stated rather than
 * implied.
 */

export type VisibilityScope = "question" | "option" | "row" | "column";

export type VisibilityCause =
  | "type"            // hidden / calculated / embedded_data: never asked
  | "hidden_setting"  // settings.hidden
  | "display_logic"   // the question's own condition
  | "display_rule"    // a named survey-level rule
  | "list_fill"       // a List Fill destination that received nothing
  | "question_hidden" // an item whose question is not shown — the parent scope
  | "item_pipeline"   // eligibility, item logic, masks, named rules on the item
  | "shown";          // nothing hid it

export interface ItemVisibility {
  scope: Exclude<VisibilityScope, "question">;
  /** option / row code, or column id */
  ref: string;
  label: string;
  visible: boolean;
  decidedBy: VisibilityCause;
  reason: string;
}

export interface QuestionVisibility {
  questionId: string;
  code: string;
  visible: boolean;
  decidedBy: VisibilityCause;
  reason: string;
  /** the condition trace behind `display_logic`, for the debug panel */
  trace: EvalTrace[];
  /**
   * Every item of the question and its fate. When the question itself is
   * hidden these are all `visible: false` / `question_hidden` — a hidden
   * question cannot have a visible option.
   */
  items: ItemVisibility[];
}

const strip = (s: string) => String(s ?? "").replace(/<[^>]*>/g, "").trim();

/** The visibility story for one question, in the runtime's own order. */
export function explainQuestionVisibility(
  q: Question,
  ctx: EvalContext,
  opts: { listFillHidden?: Set<string> } = {},
): QuestionVisibility {
  const base = { questionId: q.id, code: q.code, trace: [] as EvalTrace[] };

  const hidden = (decidedBy: VisibilityCause, reason: string, trace: EvalTrace[] = []): QuestionVisibility => ({
    ...base, visible: false, decidedBy, reason, trace,
    items: allItems(q, ctx, null).map((i) => ({
      ...i, visible: false, decidedBy: "question_hidden" as const,
      reason: `${q.code} is hidden, so this ${i.scope} is not available.`,
    })),
  });

  if (q.type === "hidden" || q.type === "calculated" || q.type === "embedded_data") {
    return hidden("type", `${q.code} is a ${q.type.replace(/_/g, " ")} question — it is filled by the engine, never asked.`);
  }
  if (q.settings.hidden) return hidden("hidden_setting", `${q.code} is set to hidden in its settings.`);

  const trace: EvalTrace[] = [];
  if (!evaluateCondition(q.displayLogic, { ...ctx, trace })) {
    return hidden("display_logic", `${q.code} is hidden: its display logic evaluated FALSE.`, trace);
  }
  if (opts.listFillHidden?.has(q.id)) {
    return hidden("list_fill", `${q.code} is a List Fill destination that received no item, and is configured to disappear.`);
  }
  if (!visibleByRules(ctx.def, "question", q.id, ctx)) {
    return hidden("display_rule", `${q.code} is hidden by a survey display rule.`);
  }

  /* visible — now, and only now, the items */
  const view = effectiveQuestion(q, ctx);
  const shownOptions = new Set(view.options.map((o) => String(o.code)));
  const shownRows = new Set(view.rows.map((r) => String(r.code)));
  const shownColumns = new Set(view.columns.map((c) => String(c.id)));
  const items = allItems(q, ctx, null).map((i) => {
    const shown = i.scope === "option" ? shownOptions.has(i.ref) : i.scope === "row" ? shownRows.has(i.ref) : shownColumns.has(i.ref);
    return shown
      ? { ...i, visible: true, decidedBy: "shown" as const, reason: "" }
      : { ...i, visible: false, decidedBy: "item_pipeline" as const, reason: `Hidden: this ${i.scope}'s display condition evaluated FALSE, or a rule, mask or eligibility removed it.` };
  });

  return { ...base, visible: true, decidedBy: "shown", reason: "", trace, items };
}

/** Every authored item of a question, before any pipeline runs. */
function allItems(q: Question, _ctx: EvalContext, _unused: null): Omit<ItemVisibility, "visible" | "decidedBy" | "reason">[] {
  const out: Omit<ItemVisibility, "visible" | "decidedBy" | "reason">[] = [];
  for (const o of q.options ?? []) out.push({ scope: "option", ref: String(o.code), label: strip(o.label) });
  for (const r of q.rows ?? []) out.push({ scope: "row", ref: String(r.code), label: strip(r.label) });
  for (const c of q.columns ?? []) out.push({ scope: "column", ref: String(c.id), label: strip(c.label) });
  return out;
}

/** The whole page, question by question — what the debug panel shows. */
export function explainVisibility(
  def: SurveyDefinition,
  step: Extract<RuntimeStep, { kind: "page" }>,
  state: ResponseState,
  quotaCounts?: QuotaCounts,
): QuestionVisibility[] {
  const ctx: EvalContext = { def, state, loop: step.loop, quotaCounts };
  const listFillHidden = listFillHiddenDestinations(def, state);
  const out: QuestionVisibility[] = [];
  for (const id of step.questionIds) {
    const q = getQuestion(def, id);
    if (!q) continue;
    try {
      out.push(explainQuestionVisibility(q, ctx, { listFillHidden }));
    } catch (e) {
      out.push({
        questionId: id, code: q.code, visible: false, decidedBy: "display_logic", trace: [],
        reason: `Could not be evaluated: ${e instanceof Error ? e.message : String(e)}`, items: [],
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ pruning */

export interface PrunedSelection {
  questionId: string;
  scope: Exclude<VisibilityScope, "question">;
  /** the codes that were dropped */
  removed: string[];
}

/**
 * A SELECTION OF SOMETHING THAT IS NO LONGER OFFERED IS NOT A SELECTION.
 *
 * Option-level logic can turn against an answer already given: a respondent
 * picks "Blue", changes an earlier answer, and the rule that offered Blue now
 * says no. The renderer stops drawing it and the validator stops counting it
 * as available — but the ANSWER still said "Blue", so it counted towards
 * min/max selections, drove other questions' logic, filled a quota cell and
 * left on the export. "Option B must not remain selectable, referenced as
 * active, or included in validation as an available option" has to mean the
 * stored answer too.
 *
 * So after anything that can change what is offered — an answer on the page,
 * arrival at the page — every VISIBLE question's answer is intersected with
 * what it actually offers. Hidden questions are left completely alone: their
 * answers are not pruned, because a question the respondent cannot see has
 * not been asked to change anything (and a respondent who goes back and
 * returns must find their answer where they left it).
 *
 * Returns what it removed, so a debug panel can say so.
 */
export function pruneHiddenSelections(
  def: SurveyDefinition,
  questions: Question[],
  ctx: EvalContext,
  loop?: LoopContext | null,
): PrunedSelection[] {
  const out: PrunedSelection[] = [];
  const state = ctx.state;
  for (const q of questions) {
    /*
     * ONLY WHERE THE PIPELINE ACTUALLY GOVERNS THE ANSWER'S VOCABULARY.
     *
     * The model says what shape an answer has and what its parts are named;
     * anything else is left completely alone. A `fields` answer is an ARRAY
     * OF RECORDS whose rows describe the columns of each record, not the keys
     * of the answer — the first version of this walked it as if the array
     * indices were row codes and emptied it. A numeric, text, date, geo,
     * allocation, ranking or design-task answer names no option at all.
     */
    const model = effectiveResponseModel(q);
    if (model !== "single_choice" && model !== "multiple_choice" && model !== "per_row" && model !== "cells") continue;

    /*
     * DOES THIS QUESTION'S ANSWER HOLD OPTION CODES AT ALL?
     *
     * The response model says the answer's SHAPE — `{ row: value }` — not
     * what the values mean, and a question can hold options it no longer
     * answers with: switch a carousel judge from a 1–5 scale to a slider and
     * the base type becomes `matrix_numeric` while the old options stay on
     * the question. The values are then readings, not codes, and checking
     * them against that stale scale deletes every one of them — a slider at
     * 6 read as "a selection of an option that has gone away".
     *
     * `sourceKindForQuestion` is the engine's existing answer to what kind of
     * value a question holds — the same classifier the logic operators use —
     * so a numeric, text or date grid is never measured against a code list.
     */
    const kind = sourceKindForQuestion(q);
    const valuesAreCodes = kind === "choice" || kind === "list";

    const key = answerKey(q.id, loop ?? ctx.loop ?? null);
    const answer = state.answers[key];
    if (answer === undefined || answer === null || answer === "") continue;

    /*
     * THE QUESTION AS THE RESPONDENT SEES IT, NOT AS IT WAS AUTHORED.
     *
     * An adaptive question can substitute its whole option list — "What went
     * wrong?" with its own reasons replacing the authored ones — and the
     * substitution lives in `adaptedQuestion`, which the renderer applies on
     * top of `effectiveQuestion`. Pruning against the authored list instead
     * deletes the answer the respondent just gave, because the code they
     * picked was never in it.
     */
    let view;
    try { view = effectiveQuestion(adaptedQuestion(q, ctx).q, ctx); } catch { continue; }
    const offered = new Set(view.options.map((o) => String(o.code)));
    const rows = new Set(view.rows.map((r) => String(r.code)));
    const removed: string[] = [];

    if (model === "multiple_choice") {
      if (!valuesAreCodes || !Array.isArray(answer) || !offered.size) continue;
      const kept = answer.filter((v) => (typeof v === "string" || typeof v === "number") && offered.has(String(v)));
      if (kept.length === answer.length) continue;
      for (const v of answer) if (!(typeof v === "string" || typeof v === "number") || !offered.has(String(v))) removed.push(String(v));
      state.answers[key] = kept as never;
      out.push({ questionId: q.id, scope: "option", removed });
      continue;
    }

    if (model === "single_choice") {
      if (!valuesAreCodes || (typeof answer !== "string" && typeof answer !== "number") || !offered.size) continue;
      if (offered.has(String(answer))) continue;
      delete state.answers[key];
      /* the Other text belonged to the selection that has just gone */
      delete state.answers[otherKey(q.id, loop ?? ctx.loop ?? null)];
      out.push({ questionId: q.id, scope: "option", removed: [String(answer)] });
      continue;
    }

    /*
     * A GRID — two separate questions, and conflating them is what emptied a
     * numeric grid: is this ROW still asked, and is this VALUE still offered.
     *
     * A row goes only if THE QUESTION ITSELF AUTHORS IT and the pipeline has
     * since taken it away: hidden by row logic, masked, dropped from a set.
     * A row the question does not author was put there by carry-forward, a
     * list operation or a loop item — this function does not know where it
     * came from, and does not get to delete a respondent's answer over that.
     *
     * A value goes only if the answer HOLDS CODES (see `valuesAreCodes`
     * above) and the code is not on the scale. A numeric or text grid's
     * values are not codes, whatever options the question happens to carry.
     */
    if (Array.isArray(answer) || typeof answer !== "object") continue;
    const obj = answer as Record<string, unknown>;
    const authored = new Set(
      (q.rows ?? []).filter((r) => !r.sourceQuestionId && !r.sourceCode).map((r) => String(r.code)),
    );
    /* `cells`: each column carries its own vocabulary, so there is no one
       scale to check a value against here. Rows still apply. */
    const scale = valuesAreCodes && model === "per_row" && offered.size ? offered : null;
    const next: Record<string, unknown> = {};
    let droppedRow = false;
    let changed = false;

    for (const [rowCode, v] of Object.entries(obj)) {
      if (authored.has(rowCode) && rows.size && !rows.has(rowCode)) {
        removed.push(rowCode); droppedRow = true; changed = true;
        continue;
      }
      if (scale) {
        if (Array.isArray(v)) {
          const kept = v.filter((x) => (typeof x === "string" || typeof x === "number") && scale.has(String(x)));
          if (kept.length !== v.length) {
            changed = true;
            for (const x of v) if (!(typeof x === "string" || typeof x === "number") || !scale.has(String(x))) removed.push(`${rowCode}:${String(x)}`);
          }
          next[rowCode] = kept;
          continue;
        }
        if ((typeof v === "string" || typeof v === "number") && !scale.has(String(v))) {
          removed.push(`${rowCode}:${String(v)}`); changed = true;
          continue;
        }
      }
      next[rowCode] = v;
    }

    if (changed) {
      state.answers[key] = next as never;
      out.push({ questionId: q.id, scope: droppedRow ? "row" : "option", removed });
    }
  }
  return out;
}
