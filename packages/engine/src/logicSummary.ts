import type {
  ComparisonOperator,
  Condition,
  ListOperation,
  Option,
  OptionLogic,
  Question,
  QuestionRow,
  SurveyDefinition,
} from "@rescript/schema";
import { VALUELESS_OPERATORS, TWO_VALUE_OPERATORS, isOptionValueRef } from "@rescript/schema";
import { getQuestionByCodeOrVar } from "./state.js";
import { LIST_OP_LABELS } from "@rescript/schema";

/**
 * Readable logic summaries (req §14).
 *
 * "Show this option when Q1 includes Apple AND Q2 does not include Banana."
 *
 * Used by the option-logic editor, the question list, the variable dictionary
 * export and the programmer's spec sheet — one phrasing everywhere, so what
 * the editor promises is what the documentation says.
 */

const OPERATOR_WORDS: Record<ComparisonOperator, string> = {
  eq: "is",
  ne: "is not",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  in: "is one of",
  notIn: "is not one of",
  contains: "includes",
  notContains: "does not include",
  answered: "is answered",
  unanswered: "is not answered",
  selected: "includes",
  notSelected: "does not include",
  between: "is between",
  matches: "matches the pattern",
  startsWith: "starts with",
  endsWith: "ends with",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  notBetween: "is outside",
  containsAny: "includes any of",
  containsAll: "includes all of",
  containsNone: "includes none of",
  rankedFirst: "ranked first",
  rankedLast: "ranked last",
  rankedTopN: "ranked within the top",
  rankEquals: "ranked exactly",
  rankGreaterThan: "ranked below",
  rankLessThan: "ranked above",
  notRanked: "did not rank",
  dateBefore: "is before",
  dateAfter: "is after",
  dateEquals: "is on",
  dateBetween: "is between",
};

const stripHtml = (s: string) => String(s ?? "").replace(/<[^>]*>/g, "").trim();

function labelForCode(q: Question | undefined, code: unknown): string {
  if (!q) return `“${String(code)}”`;
  const o = q.options.find((x) => String(x.code) === String(code));
  if (o) return `“${stripHtml(o.label) || String(code)}”`;
  const r = q.rows.find((x) => String(x.code) === String(code));
  if (r) return `“${stripHtml(r.label) || String(code)}”`;
  return `“${String(code)}”`;
}

function valueText(def: SurveyDefinition, src: Question | undefined, value: unknown): string {
  if (isOptionValueRef(value)) return "this option";
  if (Array.isArray(value)) return value.map((v) => labelForCode(src, v)).join(", ");
  if (value === undefined || value === null || value === "") return "…";
  return labelForCode(src, value);
}

/** One condition tree, in plain English. */
export function conditionSummary(def: SurveyDefinition, c: Condition | undefined | null): string {
  if (!c) return "";
  if (c.type === "group") {
    const parts = c.children.map((ch) => conditionSummary(def, ch)).filter(Boolean);
    if (parts.length === 0) return "";
    if (c.op === "not") return `not (${parts.join(" and ")})`;
    const joiner = c.op === "and" ? " AND " : " OR ";
    return parts.length === 1 ? parts[0] : `(${parts.join(joiner)})`;
  }

  const { source, operator } = c;
  let subject: string;
  if (source.kind === "option") {
    subject = `this option's ${source.ref || "code"}`;
  } else if (source.kind === "calculation") {
    subject = `calculated ${source.ref}`;
  } else if (source.kind === "embedded") {
    subject = `data field ${source.ref}`;
  } else if (source.kind === "loop") {
    subject = `loop ${source.ref}`;
  } else if (source.kind === "quota") {
    subject = `quota ${source.ref}`;
  } else {
    const q = getQuestionByCodeOrVar(def, source.ref);
    subject = q?.code ?? source.ref ?? "?";
    if (source.rowCode) subject += ` row ${source.rowCode}`;
    if (source.columnId) {
      const col = q?.columns.find((x) => x.id === source.columnId);
      subject += ` — ${stripHtml(col?.label ?? source.columnId)}`;
    }
  }

  const src =
    source.kind === "question" || source.kind === "variable"
      ? getQuestionByCodeOrVar(def, source.ref)
      : undefined;
  const word = OPERATOR_WORDS[operator] ?? operator;

  if (VALUELESS_OPERATORS.includes(operator)) return `${subject} ${word}`;
  const v1 = valueText(def, src, c.value);
  if (TWO_VALUE_OPERATORS.includes(operator)) {
    const v2 = c.value2 === undefined || c.value2 === "" ? "…" : String(c.value2);
    if (operator === "between" || operator === "notBetween" || operator === "dateBetween")
      return `${subject} ${word} ${String(c.value ?? "…")} and ${v2}`;
    return `${subject} ${word} ${v2} (${v1})`;
  }
  return `${subject} ${word} ${v1}`;
}

/** Every rule configured on one option, as sentences. */
export function optionLogicSummary(
  def: SurveyDefinition,
  logic: OptionLogic | undefined,
  visibleIf?: Condition,
): string[] {
  const out: string[] = [];
  if (visibleIf) out.push(`Show when ${conditionSummary(def, visibleIf)}.`);
  if (!logic) return out;

  switch (logic.visibility) {
    case "always_show":
      out.push("Always shown — dynamic filtering cannot remove it.");
      break;
    case "always_hide":
      out.push("Always hidden — kept in the definition but never displayed.");
      break;
    case "show_when":
      out.push(`Show when ${conditionSummary(def, logic.when)}.`);
      break;
    case "hide_when":
      out.push(`Hide when ${conditionSummary(def, logic.when)}.`);
      break;
  }
  if (logic.eligibleWhen) out.push(`Eligible when ${conditionSummary(def, logic.eligibleWhen)}.`);
  if (logic.excludeWhen) out.push(`Excluded when ${conditionSummary(def, logic.excludeWhen)}.`);
  if (logic.prioritizeWhen)
    out.push(`Moved to the top when ${conditionSummary(def, logic.prioritizeWhen)}.`);
  if (logic.deprioritizeWhen)
    out.push(`Moved to the bottom when ${conditionSummary(def, logic.deprioritizeWhen)}.`);
  if (logic.randomizeWhen)
    out.push(`Randomized only when ${conditionSummary(def, logic.randomizeWhen)} — otherwise pinned in place.`);
  for (const [name, rule] of [
    ["Carry forward", logic.carryForward],
    ["Carry back", logic.carryBack],
  ] as const) {
    if (!rule) continue;
    const src = def.questions.find((q) => q.id === rule.sourceQuestionId);
    out.push(
      `${name}: shown only when this option was ${rule.which.replace("_", " ")} in ${src?.code ?? rule.sourceQuestionId}.`,
    );
  }
  return out;
}

/** One list operation, in plain English. */
export function listOperationSummary(def: SurveyDefinition, op: ListOperation): string {
  const names = (op.sources ?? [])
    .map((s) => {
      const q = def.questions.find((x) => x.id === s.questionId);
      return `${q?.code ?? s.questionId} (${s.which.replace("_", " ")})`;
    })
    .join(", ");
  const head = LIST_OP_LABELS[op.kind] ?? op.kind;
  let body: string;
  switch (op.kind) {
    case "dedupe":
      body = head;
      break;
    case "filter":
      body = `${head}: ${conditionSummary(def, op.where)}`;
      break;
    case "sort":
      body = `${head} ${op.order ?? "az"}`;
      break;
    case "randomize":
      body = `${head} (${op.method ?? "shuffle"}${op.pick != null ? `, show ${op.pick}` : ""})`;
      break;
    default:
      body = `${head} ${names}`;
  }
  return op.when ? `${body} — only when ${conditionSummary(def, op.when)}` : body;
}

/** Whole-question summary used by the spec sheet / variable dictionary. */
export function questionLogicSummary(def: SurveyDefinition, q: Question): string[] {
  const out: string[] = [];
  if (q.displayLogic) out.push(`Shown when ${conditionSummary(def, q.displayLogic)}.`);
  if (q.carryForward) {
    const src = def.questions.find((x) => x.id === q.carryForward!.sourceQuestionId);
    out.push(
      `Options carried forward from ${src?.code ?? "?"} (${q.carryForward.filter.replace("_", " ")}).`,
    );
  }
  for (const r of q.listLogic ?? []) {
    const src = def.questions.find((x) => x.id === r.sourceQuestionId);
    out.push(`${r.action} options ${r.which.replace("_", " ")} in ${src?.code ?? "?"}.`);
  }
  for (const op of q.optionPipeline ?? []) out.push(`${listOperationSummary(def, op)}.`);
  const withLogic = (q.options ?? []).filter((o: Option) => o.logic || o.visibleIf);
  if (withLogic.length)
    out.push(`${withLogic.length} option${withLogic.length === 1 ? "" : "s"} carry their own logic.`);
  const rowsWithLogic = (q.rows ?? []).filter((r: QuestionRow) => r.logic || r.visibleIf);
  if (rowsWithLogic.length)
    out.push(`${rowsWithLogic.length} row${rowsWithLogic.length === 1 ? "" : "s"} carry their own logic.`);
  return out;
}
