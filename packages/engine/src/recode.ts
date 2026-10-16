import type { SurveyDefinition } from "@rescript/schema";
import { renumberQuestionCodes, type RenumberResult } from "./renumber.js";
import { K, moveTranslationKey } from "./localization.js";

/**
 * ONE OPTION OR ROW CODE CHANGES HAND — AND EVERYTHING THAT NAMED IT FOLLOWS.
 *
 * A code is the platform's join key: display and skip logic compare against
 * it, quota cells test it, masks and punches list it, randomisation groups
 * hold it, a grid cell names its row and column by it, a pipe addresses a
 * matrix row with it. The Intelligent-Mode action `update_option { code }`
 * has always repointed all of that; the Studio's hand editors wrote the new
 * code straight into the option and left every reference comparing with the
 * old one — a question that was shown "when Q1 = 2" stopped appearing the
 * moment Blue became 20, and only a warning-level lint said so.
 *
 * This is the one path both now share. It is `renumberQuestionCodes` with a
 * one-entry mapping — the same structural walk the re-sequence button uses,
 * which already knows every place a code can sit — plus the translation keys
 * an option's label is stored under, which move with the code exactly as the
 * action moves them. Pure: the input definition is never mutated.
 */
export interface RecodeResult {
  def: SurveyDefinition;
  /** how many references — rule values, grid cells, count subsets, masks, punches, groups, pipes — were repointed */
  updated: number;
  /** translations re-keyed from the old code to the new one */
  translationsMoved: number;
  /** calculations whose free-text expression names the question: a literal inside one cannot be rewritten safely, so a person checks it */
  needsReview: RenumberResult["needsReview"];
  /** why nothing was done, when nothing was — a clash with another code, or a code nothing holds */
  problem?: string;
}

type Scope = "options" | "rows";

const noop = (def: SurveyDefinition, problem?: string): RecodeResult => ({ def, updated: 0, translationsMoved: 0, needsReview: [], ...(problem ? { problem } : {}) });

function recode(def: SurveyDefinition, questionId: string, scope: Scope, oldCode: string | number, newCode: string | number): RecodeResult {
  const from = String(oldCode).trim(), to = String(newCode).trim();
  const q = def.questions.find((x) => x.id === questionId);
  if (!q) return noop(def, `there is no question “${questionId}”`);
  if (from === to || !from) return noop(def);
  const what = scope === "options" ? "option" : "row";
  const items = ((scope === "options" ? q.options : q.rows) ?? []) as { code: string | number }[];
  /*
   * The editor writes the new code into the item on every keystroke and calls
   * this when the field is left, so the item may already hold `to`; the
   * action path calls it with the item still holding `from`. Either way,
   * exactly one item may end up with the new code.
   */
  const fromItem = items.find((i) => String(i.code) === from);
  const holders = items.filter((i) => String(i.code) === to);
  if (holders.length > (fromItem ? 0 : 1)) return noop(def, `${q.code} already has an${what === "option" ? " option" : "other row"} coded ${to}`);
  if (!fromItem && !holders.length) return noop(def, `${q.code} has no ${what} coded ${from}`);

  const r = renumberQuestionCodes(def, questionId, scope, { [from]: to });
  let next = r.def;
  /* the new code takes the TYPE its neighbours have, so `1` and "1" do not end up side by side */
  const numeric = /^-?\d+$/.test(to) && items.some((i) => typeof i.code === "number");
  const nq = next.questions.find((x) => x.id === questionId)!; // a fresh object: renumber spreads every question
  const list = ((scope === "options" ? nq.options : nq.rows) ?? []) as { code: string | number }[];
  const typed: string | number = typeof newCode === "number" || numeric ? Number(to) : to;
  if (list.some((i) => String(i.code) === to && i.code !== typed)) {
    const retyped = list.map((i) => (String(i.code) === to && i.code !== typed ? { ...i, code: typed } : i));
    if (scope === "options") nq.options = retyped as never; else nq.rows = retyped as never;
  }

  /* the label's translations are keyed by the code: they move, approved status and history with them */
  let translationsMoved = 0;
  if (next.localization) {
    next = { ...next, localization: structuredClone(next.localization) };
    translationsMoved = scope === "options"
      ? moveTranslationKey(next, K.opt(q.id, from), K.opt(q.id, to)) + moveTranslationKey(next, K.optAlt(q.id, from), K.optAlt(q.id, to))
      : moveTranslationKey(next, K.row(q.id, from), K.row(q.id, to));
  }
  return { def: next, updated: r.referencesUpdated, translationsMoved, needsReview: r.needsReview };
}

/**
 * Recode one OPTION of a question and repoint every reference to it:
 * rule values anywhere (display, skip, validation, branches, quota cells,
 * named expressions, list fills…), a Likert grid's `columnId`, a constant
 * sum's `rowCode`, COUNT subsets and `@option` comparisons, the question's
 * own mask, punches, randomisation groups, option groups, attention check
 * and carry-forward columns, and the label's translation keys.
 */
export function recodeOptionCode(def: SurveyDefinition, questionId: string, oldCode: string | number, newCode: string | number): RecodeResult {
  return recode(def, questionId, "options", oldCode, newCode);
}

/**
 * Recode one ROW of a question and repoint every reference to it: `rowCode`
 * on rule sources and on right-hand `$question` refs, COUNT row subsets, the
 * row mask, punch target rows, display-rule targets, `{{Q1[row]}}` pipes and
 * the row label's translation key.
 */
export function recodeRowCode(def: SurveyDefinition, questionId: string, oldCode: string | number, newCode: string | number): RecodeResult {
  return recode(def, questionId, "rows", oldCode, newCode);
}
