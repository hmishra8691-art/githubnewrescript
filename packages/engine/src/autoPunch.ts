import type { Condition, PunchRule, Question, SurveyDefinition } from "@rescript/schema";
import { cond } from "@rescript/schema";
import { parseLogicExpression, formatCondition, type ExpressionError } from "./logicExpression.js";
import { evaluateCondition, type EvalContext } from "./evaluate.js";
import { evaluateSetExpr, LIST_ACTIONS } from "./setExpression.js";

/**
 * Option-level auto punching — "IF Q1.A is selected THEN SELECT Q2.B".
 *
 * There is no new model here. That sentence is already a `PunchRule` stored
 * on Q2 (the question being filled):
 *
 *   { source: { kind: "codes", codes: ["B"] },      ← what to punch
 *     when:   Q1 selected A,                         ← the ordinary Condition
 *     action: "select", recompute: "always" }
 *
 * The condition is the same canonical tree the display, skip and branch logic
 * use, so the visual builder, the expression editor and the evaluator are all
 * the ones that already exist. What this file adds is the two views of that
 * rule a programmer actually wants to type or click:
 *
 *   - the SIMPLE form: source question + option, action, target question +
 *     option — `optionRule()` builds the PunchRule, `simpleView()` reads one
 *     back when a rule is still that simple;
 *   - the EXPRESSION form: `IF <condition> THEN SELECT Q2.B, Q2.C` —
 *     `parsePunchExpression()` / `formatPunchExpression()`, where the
 *     condition half is `parseLogicExpression` verbatim, brackets and all.
 *
 * Rules that name several target questions become one PunchRule per target,
 * because a rule lives on the question it fills.
 */

export type PunchActionKind = PunchRule["action"];

export const PUNCH_ACTION_WORDS: Record<string, PunchActionKind> = {
  select: "select",
  punch: "select",
  deselect: "deselect",
  unselect: "deselect",
  unpunch: "deselect",
  clear: "clear",
  set: "set_value",
  show: "show",
  hide: "hide",
  enable: "enable",
  disable: "disable",
};

export const PUNCH_ACTION_LABELS: Record<PunchActionKind, string> = {
  select: "Select option",
  deselect: "Deselect option",
  clear: "Clear the answer",
  set_value: "Set the answer to",
  show: "Show option",
  hide: "Hide option",
  enable: "Enable option",
  disable: "Disable option",
};

export { LIST_ACTIONS };

let seq = 0;
const newId = () => `punch_${Date.now().toString(36)}${(seq++).toString(36)}`;

/* ------------------------------------------------------------- the simple form */

export interface SimplePunch {
  sourceQuestionId: string;
  sourceCode: string | number;
  /** "selected" | "not_selected" */
  test: "selected" | "not_selected";
  action: PunchActionKind;
  targetCodes: (string | number)[];
}

/** Build the PunchRule that lives on the TARGET question. */
export function optionRule(s: SimplePunch, id = newId()): PunchRule {
  const when: Condition = cond.rule(
    s.sourceQuestionId,
    s.test === "selected" ? "selected" : "notSelected",
    s.sourceCode,
  );
  return {
    id,
    source: { kind: "codes", codes: s.targetCodes },
    action: s.action,
    mapping: [],
    ignoreUnmatched: true,
    // a conditional punch follows the condition: revisit → recompute
    recompute: "always",
    when,
  };
}

/**
 * Read a rule back into the simple form, when it IS that simple: a literal
 * code set, one condition on one option. Anything richer is edited as an
 * expression instead — never flattened into a shape that loses information.
 */
export function simpleView(rule: PunchRule): SimplePunch | null {
  if (rule.source.kind !== "codes" || rule.mapping.length) return null;
  const w = rule.when;
  if (!w || w.type !== "rule") return null;
  if (w.source.kind !== "question" || (w.operator !== "selected" && w.operator !== "notSelected")) return null;
  if (w.value === undefined || w.value === null || typeof w.value === "object") return null;
  return {
    sourceQuestionId: w.source.ref,
    sourceCode: w.value as string | number,
    test: w.operator === "selected" ? "selected" : "not_selected",
    action: rule.action,
    targetCodes: rule.source.codes,
  };
}

/* --------------------------------------------------------- the expression form */

export interface PunchExpressionResult {
  /** one entry per target question named in the THEN clause */
  rules: { targetQuestionId: string; rule: PunchRule }[];
  errors: ExpressionError[];
  warnings: ExpressionError[];
}

/**
 * `IF <condition> THEN <action> Q2.B[, Q2.C] [AND <action> Q3.X]`
 *
 * The condition is parsed by the logic expression parser — same references,
 * same AND/OR/NOT, same brackets, same precedence rules. The action clause is
 * a verb followed by option references; several verbs may be joined with AND.
 * `CLEAR Q2` takes a bare question.
 */
export function parsePunchExpression(def: SurveyDefinition, src: string): PunchExpressionResult {
  const errors: ExpressionError[] = [];
  const text = (src ?? "").trim();
  if (!text) return { rules: [], errors: [], warnings: [] };

  const m = /^\s*IF\b([\s\S]*?)\bTHEN\b([\s\S]*)$/i.exec(text);
  if (!m) {
    return { rules: [], errors: [{ message: "Write the rule as IF <condition> THEN <action> — e.g. IF Q1.A IS SELECTED THEN SELECT Q2.B", position: 0 }], warnings: [] };
  }
  const condText = m[1].trim();
  const actionText = m[2].trim();
  const thenAt = text.toUpperCase().indexOf("THEN");

  const parsed = parseLogicExpression(def, condText);
  if (!parsed.condition) {
    return { rules: [], errors: parsed.errors.length ? parsed.errors : [{ message: "The IF part needs a condition.", position: 2 }], warnings: parsed.warnings };
  }

  // THEN clause: `<verb> <refs>` groups joined by AND
  const byTarget = new Map<string, { action: PunchActionKind; codes: (string | number)[] }>();
  const groups = actionText.split(/\bAND\b/i).map((g) => g.trim()).filter(Boolean);
  if (groups.length === 0) errors.push({ message: "The THEN part needs an action — SELECT, DESELECT, CLEAR, SHOW, HIDE, ENABLE or DISABLE.", position: thenAt + 4 });

  for (const g of groups) {
    const gm = /^([A-Za-z_]+)\s+([\s\S]*)$/.exec(g);
    const verb = gm ? PUNCH_ACTION_WORDS[gm[1].toLowerCase()] : undefined;
    if (!gm || !verb) {
      errors.push({ message: `“${g.split(/\s+/)[0]}” is not an action — use SELECT, DESELECT, CLEAR, SHOW, HIDE, ENABLE or DISABLE.`, position: thenAt + 4 });
      continue;
    }
    const refs = gm[2].split(",").map((r) => r.trim()).filter(Boolean);
    if (refs.length === 0) { errors.push({ message: `${gm[1].toUpperCase()} needs at least one option, e.g. Q2.B`, position: thenAt + 4 }); continue; }
    for (const ref of refs) {
      const [qTok, oTok, extra] = ref.split(".");
      const q = findQuestion(def, qTok);
      if (!q) { errors.push({ message: `Unknown question “${qTok}” in the THEN part.`, position: thenAt + 4 }); continue; }
      if (extra !== undefined) { errors.push({ message: `“${ref}” has too many parts — use Question.Option.`, position: thenAt + 4 }); continue; }
      const entry: { action: PunchActionKind; codes: (string | number)[] } = byTarget.get(q.id) ?? { action: verb, codes: [] };
      if (entry.action !== verb) {
        errors.push({ message: `Two different actions on ${q.code} in one rule — write them as two rules.`, position: thenAt + 4 });
        continue;
      }
      if (verb === "clear") {
        if (oTok !== undefined) errors.push({ message: `CLEAR takes a whole question — write CLEAR ${q.code}.`, position: thenAt + 4 });
      } else {
        if (oTok === undefined) { errors.push({ message: `${gm[1].toUpperCase()} needs an option — e.g. ${q.code}.${String(q.options[0]?.code ?? "1")}`, position: thenAt + 4 }); continue; }
        const opt = q.options.find((o) => String(o.code) === oTok)
          ?? q.options.find((o) => o.label.replace(/<[^>]*>/g, "").trim().toLowerCase() === oTok.toLowerCase());
        if (!opt) { errors.push({ message: `${q.code} has no option “${oTok}”.`, position: thenAt + 4 }); continue; }
        entry.codes.push(opt.code);
      }
      byTarget.set(q.id, entry);
    }
  }

  if (errors.length) return { rules: [], errors, warnings: parsed.warnings };

  const rules = [...byTarget.entries()].map(([targetQuestionId, e]) => ({
    targetQuestionId,
    rule: {
      id: newId(),
      source: { kind: "codes" as const, codes: e.codes },
      action: e.action,
      mapping: [],
      ignoreUnmatched: true,
      recompute: "always" as const,
      when: parsed.condition,
    },
  }));
  return { rules, errors: [], warnings: parsed.warnings };
}

/** The expression form of a rule stored on `target`. Identity with the parser for what it prints. */
export function formatPunchExpression(def: SurveyDefinition, target: Question, rule: PunchRule): string {
  const condText = rule.when ? formatCondition(def, rule.when) : "TRUE";
  const verb = rule.action === "set_value" ? "SET" : rule.action.toUpperCase();
  if (rule.action === "clear") return `IF ${condText} THEN CLEAR ${target.code}`;
  const codes = rule.source.kind === "codes" ? rule.source.codes : [];
  const refs = codes.map((c) => `${target.code}.${String(c)}`).join(", ");
  return `IF ${condText} THEN ${verb} ${refs || target.code}`;
}

function findQuestion(def: SurveyDefinition, tok: string): Question | undefined {
  const t = tok.trim();
  return def.questions.find((q) => q.code === t) ?? def.questions.find((q) => q.id === t)
    ?? def.questions.find((q) => q.code.toLowerCase() === t.toLowerCase());
}

/* ---------------------------------------------------------- list actions */

/**
 * The option-list side of punching: which of `q`'s codes are to be hidden,
 * forced visible, disabled or re-enabled right now. Evaluated by the option
 * pipeline (carryforward.ts) after the mask, so it composes with everything
 * else that shapes the list. Answer-side actions are ignored here; the flow
 * interpreter owns those.
 */
export function listPunches(q: Question, ctx: EvalContext): { hide: Set<string>; show: Set<string>; disable: Set<string>; enable: Set<string> } {
  const out = { hide: new Set<string>(), show: new Set<string>(), disable: new Set<string>(), enable: new Set<string>() };
  for (const rule of q.punches ?? []) {
    if (!LIST_ACTIONS.has(rule.action)) continue;
    if (rule.when && !evaluateCondition(rule.when, ctx)) continue;
    const codes = evaluateSetExpr(rule.source, ctx, { target: q });
    const map = new Map(rule.mapping.map((m) => [String(m.from), m.to]));
    for (const c of codes) {
      const mapped = String(map.has(String(c)) ? map.get(String(c))! : c);
      out[rule.action as "hide" | "show" | "disable" | "enable"].add(mapped);
    }
  }
  return out;
}

/** Every option-level rule in the survey, with the question it lives on — for the survey-wide editor. */
export function allPunchRules(def: SurveyDefinition): { target: Question; rule: PunchRule }[] {
  const out: { target: Question; rule: PunchRule }[] = [];
  for (const q of def.questions) for (const r of q.punches ?? []) out.push({ target: q, rule: r });
  return out;
}
