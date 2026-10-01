import { resolveOptionValue, describeOptions, type OptionList } from "./optionCodes.js";
import type { Condition, PunchRule, Question, SurveyDefinition } from "@rescript/schema";
import { cond } from "@rescript/schema";
import { parseLogicExpression, formatCondition, type ExpressionError } from "./logicExpression.js";
import { evaluateCondition, type EvalContext } from "./evaluate.js";
import { evaluateSetExpr, LIST_ACTIONS } from "./setExpression.js";
import { activePunchRules } from "./punchChain.js";
import { authoringQuestionView } from "./carryforward.js";

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

/**
 * Whether a rule belongs on the OPTION-LEVEL punch editors at all
 * (`AutoPunchPanel`, the survey-wide Logic-tab list, and `AutoPunchRows`,
 * the per-question one) — a literal code source with no matrix/composite
 * cell target and no explicit priority. Those two fields have no
 * representation in this file's Simple form or its `IF ... THEN ...`
 * expression DSL (`parsePunchExpression`/`formatPunchExpression`), so a rule
 * that carries either must never round-trip through here: doing so would
 * silently drop the cell address or the priority the moment the rule is
 * merely re-printed, let alone edited. Such a rule belongs to — and is only
 * ever rendered by — the set-expression punch editor (`PunchRules` in
 * Studio), which has real controls for both.
 */
export function isOptionLevelPunch(rule: PunchRule): boolean {
  return (
    rule.source.kind === "codes"
    && rule.targetRow === undefined
    && rule.targetColumn === undefined
    && rule.priority === undefined
  );
}

/* ------------------------------------------------------------- the simple form */

export interface SimplePunch {
  sourceQuestionId: string;
  /** the option tested, for "is selected" / "is not selected" */
  sourceCode: string | number;
  /**
   * "selected" | "not_selected" on a choice question; a VALUE comparison on a
   * numeric (or text) question — "Q32 is between 2 and 3 → punch Medium".
   */
  test: "selected" | "not_selected" | SimpleValueTest;
  /** the number (or text) a value test compares with; `value2` is the top of a between */
  value?: string | number;
  value2?: string | number;
  action: PunchActionKind;
  targetCodes: (string | number)[];
}

export type SimpleValueTest = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "between";
export const SIMPLE_VALUE_TESTS: SimpleValueTest[] = ["eq", "ne", "gt", "gte", "lt", "lte", "between"];
const isValueTest = (t: string): t is SimpleValueTest => (SIMPLE_VALUE_TESTS as string[]).includes(t);

/**
 * The simple form as a PunchRule.
 *
 * `base` is the rule being edited. Everything the simple form has no field
 * for — its place in an IF / ELSE IF / ELSE chain, `recompute`,
 * `ignoreUnmatched`, a label, a priority — is carried over from it. This used
 * to build a brand-new rule on every Simple-mode edit, so touching the option
 * of an ELSE IF turned it back into an independent IF (and the chain then
 * punched two options at once).
 */
export function optionRule(s: SimplePunch, id = newId(), base?: PunchRule): PunchRule {
  const when: Condition = isValueTest(s.test)
    ? cond.rule(s.sourceQuestionId, s.test, s.value, s.test === "between" ? s.value2 : undefined)
    : cond.rule(s.sourceQuestionId, s.test === "selected" ? "selected" : "notSelected", s.sourceCode);
  return {
    ...(base ?? {}),
    id,
    source: { kind: "codes", codes: s.targetCodes },
    action: s.action,
    mapping: base?.mapping ?? [],
    ignoreUnmatched: base?.ignoreUnmatched ?? true,
    // a conditional punch follows the condition: revisit → recompute
    recompute: base?.recompute ?? "always",
    when,
  };
}

/**
 * Read a rule back into the simple form, when it IS that simple: a literal
 * code set, one condition on one option — or one value comparison on one
 * numeric / text question. Anything richer (an AND / OR, a grid cell, a
 * count) is edited in the builder or as an expression instead — never
 * flattened into a shape that loses information.
 */
export function simpleView(rule: PunchRule): SimplePunch | null {
  if (rule.source.kind !== "codes" || rule.mapping.length) return null;
  // A matrix/composite cell target, or an explicit priority, carries
  // information `SimplePunch` has no field for — flattening it here would
  // silently drop the cell address (or the priority) the moment the
  // programmer touches anything in Simple mode. Force Expression mode
  // instead, the same "never lose information" contract this function
  // already applies to a non-empty mapping.
  if (rule.targetRow !== undefined || rule.targetColumn !== undefined || rule.priority !== undefined) return null;
  const w = rule.when;
  if (!w || w.type !== "rule") return null;
  if (w.source.kind !== "question" || w.source.count || w.source.rowCode || w.source.columnId
    || w.source.rowPosition != null || w.source.optionPosition != null) return null;
  const scalar = (v: unknown) => v !== undefined && v !== null && typeof v !== "object";
  if (w.operator === "selected" || w.operator === "notSelected") {
    if (!scalar(w.value)) return null;
    return {
      sourceQuestionId: w.source.ref,
      sourceCode: w.value as string | number,
      test: w.operator === "selected" ? "selected" : "not_selected",
      action: rule.action,
      targetCodes: rule.source.codes,
    };
  }
  if (isValueTest(w.operator) && scalar(w.value) && (w.operator !== "between" || scalar(w.value2))) {
    return {
      sourceQuestionId: w.source.ref,
      sourceCode: "",
      test: w.operator,
      value: w.value as string | number,
      ...(w.operator === "between" ? { value2: w.value2 as string | number } : {}),
      action: rule.action,
      targetCodes: rule.source.codes,
    };
  }
  return null;
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

  /*
   * IF / ELSE IF / ELSE, as the rule's place in a chain:
   *   IF <condition> THEN <action>
   *   ELSE IF <condition> THEN <action>
   *   ELSE <action>            (or ELSE THEN <action>) — no condition of its own
   */
  let mode: "if" | "else_if" | "else" = "if";
  let body = text;
  const elseIf = /^\s*ELSE\s+IF\b/i.exec(body);
  const elseOnly = !elseIf && /^\s*ELSE\b/i.exec(body);
  if (elseIf) { mode = "else_if"; body = body.slice(elseIf[0].length - 2); }
  else if (elseOnly) { mode = "else"; body = body.slice(elseOnly[0].length).replace(/^\s*THEN\b/i, ""); }

  let condText = "";
  let actionText = body.trim();
  let thenAt = text.length - body.length;
  if (mode !== "else") {
    /*
     * The THEN that ends the condition is the first one OUTSIDE quotes and
     * brackets. A plain regex took the first THEN anywhere, so a condition
     * like `Q5 contains "then"` split in the middle of its own text.
     */
    const ifm = /^\s*IF\b/i.exec(body);
    const at = ifm ? topLevelThen(body, ifm[0].length) : -1;
    if (!ifm || at < 0) {
      return { rules: [], errors: [{ message: "Write the rule as IF <condition> THEN <action> — e.g. IF Q1.A IS SELECTED THEN SELECT Q2.B", position: 0 }], warnings: [] };
    }
    condText = body.slice(ifm[0].length, at).trim();
    actionText = body.slice(at + 4).trim();
    thenAt = text.length - body.length + at;
  }

  const parsed = mode === "else" ? { condition: undefined, errors: [], warnings: [] } as ReturnType<typeof parseLogicExpression> : parseLogicExpression(def, condText);
  if (mode !== "else" && !parsed.condition) {
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
    /*
     * `SET QH = 2`, `SET SEGMENT = "Premium"` — code a response. A choice
     * target takes the value as an option CODE (a label is read as its code,
     * as everywhere else); a text or numeric target takes it as its value.
     */
    const setM = verb === "set_value" ? /^([A-Za-z_][\w]*)\s*=\s*(.+)$/.exec(gm[2].trim()) : null;
    if (setM) {
      const q = findQuestion(def, setM[1]);
      if (!q) { errors.push({ message: `Unknown question “${setM[1]}” in the THEN part.`, position: thenAt + 4 }); continue; }
      const rawVal = setM[2].trim().replace(/^(["'])(.*)\1$/, "$2");
      const value: string | number = /^-?\d+(\.\d+)?$/.test(rawVal) ? Number(rawVal) : rawVal;
      const view = authoringQuestionView(q, def);
      if (view.options.length) {
        const r = resolveOptionValue(view.options as OptionList, value);
        if (r.kind === "none") { errors.push({ message: `${q.code} has no option “${rawVal}” — SET on a choice question takes an option code (${describeOptions(view.options as OptionList)}).`, position: thenAt + 4 }); continue; }
        if (byTarget.has(q.id)) { errors.push({ message: `Two actions on ${q.code} in one rule — write them as two rules.`, position: thenAt + 4 }); continue; }
        byTarget.set(q.id, { action: "select", codes: [r.code] });
      } else {
        if (byTarget.has(q.id)) { errors.push({ message: `Two actions on ${q.code} in one rule — write them as two rules.`, position: thenAt + 4 }); continue; }
        byTarget.set(q.id, { action: "set_value", codes: [value] });
      }
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
        /*
         * The EFFECTIVE (carry-forward resolved) option list, not the static
         * `q.options` array — a carry-forward question has no options of its
         * own in the schema, so naming one of its carried options here used
         * to always fail with "has no option". Design-time only (no answers
         * yet to run the real pipeline against), so this is the same
         * source-chain resolution the Condition Builder and Count Editor use.
         */
        const view = authoringQuestionView(q, def);
        if (oTok === undefined) { errors.push({ message: `${gm[1].toUpperCase()} needs an option — e.g. ${q.code}.${String(view.options[0]?.code ?? "1")}`, position: thenAt + 4 }); continue; }
        const hit = resolveOptionValue(view.options as OptionList, oTok);
        const opt = hit.kind === "code" ? view.options.find((o) => String(o.code) === String(hit.code)) : undefined;
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
      ...(parsed.condition ? { when: parsed.condition } : {}),
      ...(mode !== "if" ? { mode } : {}),
    },
  }));
  return { rules, errors: [], warnings: parsed.warnings };
}

/**
 * An edited expression applied to the rule it was typed over.
 *
 * The IF … THEN text carries the condition, the action, the codes and the
 * chain position (IF / ELSE IF / ELSE) — and nothing else. Everything else on
 * the rule (its id, label, `recompute`, `ignoreUnmatched`, a priority, notes)
 * belongs to the rule, not to the text, and is kept. Replacing the rule with
 * the parse result reset all of it: a "punch once" rule became "always" the
 * first time its text was touched.
 */
export function applyParsedPunch(base: PunchRule, parsed: PunchRule): PunchRule {
  const next: PunchRule = {
    ...base,
    id: base.id,
    source: parsed.source,
    action: parsed.action,
    mapping: parsed.mapping ?? [],
  };
  if (parsed.when) next.when = parsed.when; else delete (next as { when?: unknown }).when;
  if (parsed.mode && parsed.mode !== "if") next.mode = parsed.mode; else delete (next as { mode?: unknown }).mode;
  return next;
}

/** index of the first THEN outside quotes and brackets at or after `from`, or -1 */
function topLevelThen(text: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /^THEN\b/i.test(text.slice(i)) && (i === 0 || /\s/.test(text[i - 1]))) return i;
  }
  return -1;
}

/** The expression form of a rule stored on `target`. Identity with the parser for what it prints. */
export function formatPunchExpression(def: SurveyDefinition, target: Question, rule: PunchRule): string {
  const mode = rule.mode ?? "if";
  /*
   * The rule's place in its chain is part of what it says. An ELSE IF printed
   * as "IF …" (the 30-09 report's screenshot) reads as an independent rule,
   * and applying that text back made it one.
   */
  const head = mode === "else"
    ? "ELSE"
    : `${mode === "else_if" ? "ELSE IF" : "IF"} ${rule.when && formatCondition(def, rule.when) ? formatCondition(def, rule.when) : "TRUE"} THEN`;
  const verb = rule.action === "set_value" ? "SET" : rule.action.toUpperCase();
  if (rule.action === "clear") return `${head} CLEAR ${target.code}`;
  const codes = rule.source.kind === "codes" ? rule.source.codes : [];
  if (rule.action === "set_value" && codes.length === 1) {
    const v = codes[0];
    return `${head} SET ${target.code} = ${typeof v === "number" || /^[A-Za-z_][\w]*$/.test(String(v)) ? String(v) : JSON.stringify(String(v))}`;
  }
  const refs = codes.map((c) => `${target.code}.${String(c)}`).join(", ");
  return `${head} ${verb} ${refs || target.code}`;
}

function findQuestion(def: SurveyDefinition, tok: string): Question | undefined {
  const t = tok.trim();
  return def.questions.find((q) => q.code === t) ?? def.questions.find((q) => q.id === t)
    ?? def.questions.find((q) => q.code.toLowerCase() === t.toLowerCase())
    // a variable name reads here as it does in the IF part ("SET SEGMENT = 2")
    ?? def.questions.find((q) => q.variableName === t) ?? def.questions.find((q) => q.variableName.toLowerCase() === t.toLowerCase());
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
  /*
   * The same list-side chain the option pipeline walks (§8, §23). This
   * function and `applyListPunches` in `carryforward.ts` are deliberate
   * duplicates for different callers, so they have to agree about which rules
   * ran — which is why both go through `activePunchRules` rather than each
   * having its own idea of what a chain is.
   */
  const listRules = (q.punches ?? []).filter((r) => LIST_ACTIONS.has(r.action));
  for (const rule of activePunchRules(listRules, (r) => evaluateCondition(r.when, ctx))) {
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
