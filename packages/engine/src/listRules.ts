import type { Question, SurveyDefinition } from "@rescript/schema";
import { setExpressionSummary } from "./setExpression.js";
import { conditionSummary, listOperationSummary } from "./logicSummary.js";

/**
 * THE ANSWER LIST OF ONE QUESTION, AS ONE STORY (2026-11-15).
 *
 * Four tools decide which options a question shows, and they were presented as three unrelated sections with
 * technical names — "Masking (dynamic option sets)", "List logic (from previous questions)", "List operations
 * (intersection / union / difference)" — plus carry-forward somewhere else on the panel. Each works; together they
 * were hard to tell apart, nothing said in which order they act, and nothing said when two of them were doing the
 * same job or cancelling each other.
 *
 * Nothing about how they RUN changes here (carryforward.ts, "THE OPTION PIPELINE"). This reads a question and says,
 * in the order the engine applies them:
 *
 *   1  copy       carry-forward               the list STARTS as another question's answers
 *   2  by answer  list logic                  keep / remove / move options by ONE earlier question
 *   3  calculated masking                     show / remove / pre-select a set worked out from SEVERAL questions
 *   4  extra      list operations             further steps on the list: combine, filter, sort, de-duplicate, shuffle
 *
 * and names the overlaps and contradictions between them, so the programmer sees them before a respondent does.
 */
export type ListRuleSection = "carry-forward" | "list-logic" | "masking" | "list-operations";

export interface ListRuleStep {
  section: ListRuleSection;
  /** 1–4: where the tool sits in the order of application */
  order: 1 | 2 | 3 | 4;
  /** what this rule does, in plain words */
  summary: string;
}
export interface ListRuleNote {
  level: "conflict" | "overlap" | "info";
  message: string;
  sections: ListRuleSection[];
}
export interface ListRulesOverview {
  steps: ListRuleStep[];
  notes: ListRuleNote[];
  /** nothing configured: the question shows its own list as written */
  plain: boolean;
}

/** the researcher's name for each tool, its technical name kept in brackets so documentation and search still match */
export const LIST_RULE_TOOLS: Record<ListRuleSection, { order: 1 | 2 | 3 | 4; title: string; technical: string; use: string }> = {
  "carry-forward": { order: 1, title: "Copy the list from another question", technical: "carry-forward", use: "The options ARE what the respondent chose (or did not choose, or saw) at an earlier question." },
  "list-logic": { order: 2, title: "Keep, remove or reorder by an earlier answer", technical: "list logic", use: "This question has its own options; one earlier question decides which stay, which go, or which come first." },
  masking: { order: 3, title: "Show a calculated set", technical: "masking", use: "The options to show (or remove, or pre-select) are worked out from several questions — in either, in both, in one but not the other." },
  "list-operations": { order: 4, title: "Extra list steps", technical: "list operations", use: "Anything further, in sequence: combine lists, filter by a condition, sort, remove duplicates, shuffle." },
};

const WHICH: Record<string, string> = { selected: "selected", not_selected: "not selected", displayed: "shown", answered_rows: "answered", all: "listed" };
const code = (def: SurveyDefinition, id: string) => def.questions.find((x) => x.id === id)?.code ?? "a question that no longer exists";

export function listRulesOverview(def: SurveyDefinition, q: Question): ListRulesOverview {
  const steps: ListRuleStep[] = [];
  const notes: ListRuleNote[] = [];

  /* 1 — the source */
  const cf = q.carryForward;
  if (cf && (cf.into ?? "options") === "options") {
    const what = cf.filter === "all" ? "every option" : `the options ${WHICH[cf.filter] ?? cf.filter}`;
    steps.push({ section: "carry-forward", order: 1, summary: `Starts from ${what} at ${code(def, cf.sourceQuestionId)}${cf.keepOwn ? ", followed by this question's own options" : ""}.` });
  }

  /* 2 — one earlier answer */
  const rules = q.listLogic ?? [];
  for (const r of rules) {
    const src = code(def, r.sourceQuestionId), w = WHICH[r.which] ?? r.which;
    const body =
      r.action === "include" ? `Keeps only the options ${w} at ${src}`
      : r.action === "exclude" ? `Removes the options ${w} at ${src}`
      : r.action === "prioritize" ? `Moves the options ${w} at ${src} to the top`
      : `Moves the options ${w} at ${src} to the bottom`;
    steps.push({ section: "list-logic", order: 2, summary: `${body}${r.when ? ` — only when ${conditionSummary(def, r.when)}` : ""}.` });
  }

  /* 3 — a calculated set */
  const mask = q.mask;
  if (mask) {
    const set = setExpressionSummary(def, mask.expr) || "the chosen set";
    const body =
      mask.action === "remove" ? `Removes ${set}`
      : mask.action === "preselect" ? `Pre-selects ${set} (the list itself is not filtered)`
      : mask.action === "display_and_preselect" ? `Shows only ${set}, already selected`
      : mask.action === "disable" ? `Shows every option, but only ${set} can be answered`
      : `Shows only ${set}`;
    steps.push({ section: "masking", order: 3, summary: `${body}${mask.when ? ` — only when ${conditionSummary(def, mask.when)}` : ""}.` });
  }

  /* 4 — further steps */
  const ops = q.optionPipeline ?? [];
  for (const op of ops) steps.push({ section: "list-operations", order: 4, summary: `${listOperationSummary(def, op)}.` });

  /* ---- contradictions and overlaps ---- */
  const key = (r: { sourceQuestionId: string; which: string }) => `${r.sourceQuestionId}:${r.which}`;
  const unconditional = rules.filter((r) => !r.when);
  for (const inc of unconditional.filter((r) => r.action === "include")) {
    if (unconditional.some((r) => r.action === "exclude" && key(r) === key(inc))) {
      notes.push({ level: "conflict", sections: ["list-logic"], message: `One rule keeps only the options ${WHICH[inc.which] ?? inc.which} at ${code(def, inc.sourceQuestionId)} and another removes exactly those — nothing would be left. Delete one of the two.` });
    }
  }
  for (const pri of unconditional.filter((r) => r.action === "prioritize")) {
    if (unconditional.some((r) => r.action === "deprioritize" && key(r) === key(pri))) {
      notes.push({ level: "conflict", sections: ["list-logic"], message: `The options ${WHICH[pri.which] ?? pri.which} at ${code(def, pri.sourceQuestionId)} are moved to the top by one rule and to the bottom by another. Keep one.` });
    }
  }
  const includeSources = new Set(unconditional.filter((r) => r.action === "include").map(key));
  if (includeSources.size > 1) {
    notes.push({ level: "info", sections: ["list-logic"], message: "More than one “keep only” rule: an option must pass every one of them to stay." });
  }

  const filtersByMask = !!mask && mask.action !== "preselect";
  const setOps = ops.filter((o) => ["union", "intersect", "difference", "exclude", "remaining"].includes(o.kind));
  if (filtersByMask && setOps.length) {
    notes.push({ level: "overlap", sections: ["masking", "list-operations"], message: `The calculated set (masking) and ${setOps.length === 1 ? "an extra list step" : `${setOps.length} extra list steps`} both decide which options are shown. They run one after the other — masking first — so an option must pass both. One of the two is usually enough: a calculated set can already say “in either”, “in both” and “in one but not the other”.` });
  }
  if (cf && (cf.into ?? "options") === "options" && ops.some((o) => o.kind === "carry_forward")) {
    notes.push({ level: "overlap", sections: ["carry-forward", "list-operations"], message: "The list is copied from another question twice: by “Copy the list” and again by an extra list step. Keep one." });
  }
  const filtersByLogic = rules.some((r) => r.action === "include" || r.action === "exclude");
  if (filtersByLogic && filtersByMask) {
    const shared = rules.find((r) => (r.action === "include" || r.action === "exclude") && JSON.stringify(mask!.expr).includes(`"${r.sourceQuestionId}"`));
    notes.push({ level: shared ? "overlap" : "info", sections: ["list-logic", "masking"], message: shared
      ? `${code(def, shared.sourceQuestionId)} is used twice: by a keep / remove rule and inside the calculated set. Both apply (the rule first), so an option must pass both — check that this is intended.`
      : "A keep / remove rule and a calculated set both filter this list. Both apply — the rule first, then the set." });
  }
  const moves = rules.some((r) => r.action === "prioritize" || r.action === "deprioritize") || ops.some((o) => o.kind === "prioritize" || o.kind === "deprioritize" || o.kind === "sort");
  if (q.randomization?.enabled && ops.some((o) => o.kind === "randomize")) {
    notes.push({ level: "overlap", sections: ["list-operations"], message: "The list is shuffled twice: by an extra list step and by this question's Randomization. Keep one." });
  }
  if (q.randomization?.enabled && moves) {
    notes.push({ level: "info", sections: ["list-logic", "list-operations"], message: "This question is also randomized. Randomization runs last, so an order set here (top / bottom / sort) only survives for options that Randomization keeps in place." });
  }
  for (const s of [cf?.sourceQuestionId, ...rules.map((r) => r.sourceQuestionId)].filter((x): x is string => !!x)) {
    if (!def.questions.some((x) => x.id === s)) { notes.push({ level: "conflict", sections: ["carry-forward", "list-logic"], message: "A rule reads a question that no longer exists. Choose another question or delete the rule." }); break; }
  }

  steps.sort((a, b) => a.order - b.order);
  return { steps, notes, plain: steps.length === 0 };
}
