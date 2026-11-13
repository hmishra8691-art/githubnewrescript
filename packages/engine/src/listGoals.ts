import type { Question, SurveyDefinition, ListLogicRule } from "@rescript/schema";
import { listRulesOverview, type ListRuleSection } from "./listRules.js";
import { questionOrder } from "./dependencies.js";

/**
 * SAY WHAT THE LIST SHOULD SHOW, NOT WHICH TOOL (2026-11-13).
 *
 * Four tools decide which options a question shows (listRules.ts). A researcher thinks "only the brands they chose at
 * Q1", not "carry-forward" or "list logic" — and which of the two is right depends on something they should not have
 * to check: whether this question already has the same answer list as Q1. Here the researcher picks the GOAL and the
 * earlier question; the engine picks the tool, builds the rule, and says in one sentence what it will do before
 * anything is stored:
 *
 *   same answer list as the source      → a list-logic rule (keep / remove / move to the top)
 *   no answers of its own yet           → carry-forward (the list IS the source's answers)
 *   its own answers, none in common     → carry-forward, with a note that its own answers are not shown
 *
 * The rule it builds is an ordinary rule of that tool, edited afterwards exactly like one made by hand.
 */
export type ListGoal = "only_chosen" | "except_chosen" | "chosen_first" | "only_shown";

export const LIST_GOALS: { goal: ListGoal; label: string }[] = [
  { goal: "only_chosen", label: "only the answers they chose at" },
  { goal: "except_chosen", label: "everything except what they chose at" },
  { goal: "chosen_first", label: "what they chose first, then the rest — at" },
  { goal: "only_shown", label: "only the answers they were shown at" },
];

export type ListGoalPatch = Partial<Pick<Question, "carryForward" | "listLogic">>;
export type ListGoalResult =
  | { ok: true; tool: ListRuleSection; patch: ListGoalPatch; summary: string; note?: string }
  | { ok: false; reason: string };

const listOf = (q: Question | undefined): string[] => (q?.options ?? []).map((o) => String(o.code));

/** earlier questions whose answers a list can follow — nearest first */
export function listGoalSources(def: SurveyDefinition, questionId: string): Question[] {
  const order = questionOrder(def);
  const at = order.indexOf(questionId);
  const before = at >= 0 ? order.slice(0, at) : [];
  return before.reverse()
    .map((id) => def.questions.find((q) => q.id === id))
    .filter((q): q is Question => !!q && q.options.length > 0 && (q.type === "multi_select" || q.type === "single_select" || q.type === "dropdown" || q.type === "ranking"));
}

/** the earlier question a list most likely follows: the nearest multi-select, else the nearest question with answers */
export function suggestListSource(def: SurveyDefinition, questionId: string): string | null {
  const cands = listGoalSources(def, questionId);
  return (cands.find((q) => q.type === "multi_select") ?? cands[0])?.id ?? null;
}

/** does this question already carry (most of) the source's answer list? */
export function sharesAnswerList(q: Question, source: Question): boolean {
  const own = listOf(q), src = new Set(listOf(source));
  if (!own.length) return false;
  return own.filter((c) => src.has(c)).length * 2 >= own.length;
}

/** what the chosen goal would add to this question — nothing is stored until the caller applies `patch` */
export function applyListGoal(def: SurveyDefinition, q: Question, goal: ListGoal, sourceId: string, newId: () => string): ListGoalResult {
  const source = def.questions.find((x) => x.id === sourceId);
  if (!source || source.id === q.id) return { ok: false, reason: "Choose an earlier question with answers." };
  if (!listGoalSources(def, q.id).some((x) => x.id === sourceId)) return { ok: false, reason: `${source.code} is not asked before this question, so its answers are not known yet. Choose an earlier question.` };
  const same = sharesAnswerList(q, source);
  const which = goal === "only_shown" ? "displayed" : "selected";

  let tool: ListRuleSection, patch: ListGoalPatch, note: string | undefined;
  if (same) {
    const action: ListLogicRule["action"] = goal === "except_chosen" ? "exclude" : goal === "chosen_first" ? "prioritize" : "include";
    const rules = q.listLogic ?? [];
    if (rules.some((r) => r.sourceQuestionId === sourceId && r.action === action && r.which === which && !r.when)) return { ok: false, reason: "This question already does that." };
    tool = "list-logic";
    patch = { listLogic: [...rules, { id: newId(), sourceQuestionId: sourceId, action, which }] };
  } else {
    if (goal === "chosen_first") return { ok: false, reason: `This question does not share ${source.code}'s answers, so there is nothing to move to the top. Use “only the answers they chose” instead.` };
    if (q.carryForward) return { ok: false, reason: `This question already copies its list from ${def.questions.find((x) => x.id === q.carryForward!.sourceQuestionId)?.code ?? "another question"}. Change that under “1 · Copy the list from another question”.` };
    tool = "carry-forward";
    patch = { carryForward: { sourceQuestionId: sourceId, filter: goal === "except_chosen" ? "not_selected" : which, into: "options", keepOwn: false } as Question["carryForward"] };
    if (q.options.length) note = `This question's own ${q.options.length === 1 ? "answer is" : `${q.options.length} answers are`} not on ${source.code}'s list, so ${q.options.length === 1 ? "it is" : "they are"} not shown while this rule is on.`;
  }
  const after = listRulesOverview(def, { ...q, ...patch } as Question);
  const step = [...after.steps].reverse().find((st) => st.section === tool);
  return { ok: true, tool, patch, summary: step?.summary ?? "", ...(note ? { note } : {}) };
}
