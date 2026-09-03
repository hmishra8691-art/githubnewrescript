import type {
  Condition, ConditionGroup, ConditionRule, ComparisonOperator,
  Question, SurveyDefinition,
} from "@rescript/schema";
import { getQuestionByCodeOrVar } from "./state.js";

/**
 * The logic expression language: text in, canonical tree out, and back again.
 *
 * This is a second WAY TO WRITE the logic the visual builder writes — never a
 * second logic system. `parseLogicExpression` produces the same `Condition`
 * tree the builder produces, evaluated by the same evaluator;
 * `formatCondition` turns any such tree back into text. Neither knows anything
 * about evaluation, and there is no expression stored anywhere: the tree is
 * the only source of truth, so the two editors cannot drift.
 *
 * ## The language
 *
 *     Q1.R1                      row R1 of Q1 is answered
 *     Q1.brandA                  option brandA is selected in Q1
 *     Q1.R1.C2                   row R1 of Q1 answered C2 (matrix)
 *                                — or that cell, for a composite table
 *     Q3 > 25                    any operator, written out
 *     Q1 contains any [a, b]     list operators take a bracketed list
 *     NOT Q1.R1                  negation
 *     A AND B          A OR B    conjunction / disjunction
 *     (A OR B) AND C             parentheses decide the nesting
 *     calc.SCORE > 10            calculations, embedded data, loops, quotas
 *     @option.code               the option a per-option rule is attached to
 *
 * Precedence is the usual one — `NOT` binds tightest, then `AND`, then `OR` —
 * and a mixed `AND`/`OR` expression written without parentheses is accepted
 * but reported as a warning, because "A OR B AND C" is the kind of line two
 * people read two ways. Everything this module PRINTS is fully parenthesised.
 *
 * ## References
 *
 * A reference is resolved against the survey, never guessed:
 *
 *   1. the first segment names a question by code, variable name or id;
 *   2. the second names one of its rows, or one of its options;
 *   3. the third names a matrix scale point or a composite column.
 *
 * `R1` / `C1` / `O1` are accepted as sugar for "the row/column/option whose
 * code is 1", and then for "the first row/column/option". A numeric code is
 * printed with that prefix (`Q1.R1`) because bare `Q1.1` reads badly; a named
 * code is printed as it is (`Q1.brandA`). Either form parses.
 */

/* ============================================================== tokenizer */

type TokKind = "ident" | "number" | "string" | "punct";
interface Tok { kind: TokKind; text: string; pos: number }

const PUNCT = ["(", ")", "[", "]", ",", ">=", "<=", "!=", "==", "=", ">", "<"];

function tokenize(src: string): { tokens: Tok[]; error?: ExpressionError } {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }

    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) {
        return { tokens, error: { message: "Unclosed quote", position: i } };
      }
      tokens.push({ kind: "string", text: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }

    const punct = PUNCT.find((p) => src.startsWith(p, i));
    if (punct) {
      tokens.push({ kind: "punct", text: punct, pos: i });
      i += punct.length;
      continue;
    }

    // a number, or an identifier — dots belong to references so they are part
    // of the identifier, and a leading digit is a number unless a dot follows
    const num = /^-?\d+(\.\d+)?(?![A-Za-z0-9_.])/.exec(src.slice(i));
    if (num) {
      tokens.push({ kind: "number", text: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    const ident = /^[@A-Za-z0-9_$][A-Za-z0-9_$.-]*/.exec(src.slice(i));
    if (ident) {
      tokens.push({ kind: "ident", text: ident[0], pos: i });
      i += ident[0].length;
      continue;
    }
    return { tokens, error: { message: `Unexpected character “${ch}”`, position: i } };
  }
  return { tokens };
}

/* ============================================================== operators */

/**
 * How each operator is written. The first spelling is what gets printed; the
 * rest are accepted. Every operator has its canonical name as a spelling too,
 * so nothing in the schema is inexpressible.
 */
const OPERATOR_WORDS: Partial<Record<ComparisonOperator, string[]>> = {
  eq: ["=", "==", "is", "eq"],
  ne: ["!=", "is not", "ne"],
  gt: [">", "gt"],
  gte: [">=", "gte"],
  lt: ["<", "lt"],
  lte: ["<=", "lte"],
  between: ["between", "between"],
  notBetween: ["not between", "notBetween"],
  in: ["in", "in"],
  notIn: ["not in", "notIn"],
  contains: ["contains", "contains"],
  notContains: ["not contains", "notContains"],
  containsAny: ["contains any", "containsAny"],
  containsAll: ["contains all", "containsAll"],
  containsNone: ["contains none", "containsNone"],
  selected: ["selected", "selected"],
  notSelected: ["not selected", "notSelected"],
  answered: ["answered", "answered"],
  unanswered: ["unanswered", "unanswered"],
  isEmpty: ["is empty", "isEmpty"],
  isNotEmpty: ["is not empty", "isNotEmpty"],
  matches: ["matches", "matches"],
  startsWith: ["starts with", "startsWith"],
  endsWith: ["ends with", "endsWith"],
  rankedFirst: ["ranked first", "rankedFirst"],
  rankedLast: ["ranked last", "rankedLast"],
  rankedTopN: ["ranked top", "rankedTopN"],
  rankEquals: ["rank equals", "rankEquals"],
  rankGreaterThan: ["rank after", "rankGreaterThan"],
  rankLessThan: ["rank before", "rankLessThan"],
  notRanked: ["not ranked", "notRanked"],
  dateBefore: ["before", "dateBefore"],
  dateAfter: ["after", "dateAfter"],
  dateEquals: ["on", "dateEquals"],
  dateBetween: ["between dates", "dateBetween"],
};

/** Operators that take no operand at all. */
const NO_OPERAND: ComparisonOperator[] = [
  "answered", "unanswered", "isEmpty", "isNotEmpty",
];
/** Operators that take two operands (`between 10 and 20`). */
const TWO_OPERANDS: ComparisonOperator[] = [
  "between", "notBetween", "dateBetween",
  "rankedTopN", "rankEquals", "rankGreaterThan", "rankLessThan",
];
/** Operators whose operand is a list. */
const LIST_OPERAND: ComparisonOperator[] = [
  "in", "notIn", "containsAny", "containsAll", "containsNone",
];

/**
 * Longest spellings first, so "not selected" wins over "not" — and lowercased,
 * because the reader compares lowercased tokens. (A camelCase name like
 * `startsWith` matched nothing until this did.)
 */
const SPELLINGS: { words: string[]; op: ComparisonOperator }[] = Object.entries(OPERATOR_WORDS)
  .flatMap(([op, words]) => (words ?? []).map((w) => ({
    words: w.toLowerCase().split(/\s+/),
    op: op as ComparisonOperator,
  })))
  .sort((a, b) => b.words.length - a.words.length);

export const OPERATOR_SPELLING = (op: ComparisonOperator): string =>
  OPERATOR_WORDS[op]?.[0] ?? op;

/* ================================================================= errors */

export interface ExpressionError {
  message: string;
  /** character offset in the source, when known */
  position?: number;
}

export interface ParseResult {
  condition?: Condition;
  errors: ExpressionError[];
  /** Things that parse but are worth saying out loud. */
  warnings: ExpressionError[];
}

/**
 * A source while it is being parsed.
 *
 * `optionCode` exists only here: the canonical model keeps a selected option
 * in the rule's VALUE, which is where the evaluator and the visual builder
 * both look for it, so `strip()` moves it out before the rule is built.
 */
type DraftSource = ConditionRule["source"] & { optionCode?: string };

/* ================================================================ parsing */

/**
 * Parse an expression against a survey. Returns the canonical tree, or the
 * errors that stopped it — never a partial tree, and never a throw.
 */
export function parseLogicExpression(
  def: SurveyDefinition,
  src: string,
  opts: { perOption?: boolean } = {},
): ParseResult {
  const errors: ExpressionError[] = [];
  const warnings: ExpressionError[] = [];
  const { tokens, error } = tokenize(src ?? "");
  if (error) return { errors: [error], warnings };
  if (tokens.length === 0) return { errors: [], warnings };

  let at = 0;
  /** Groups that came from brackets the programmer typed, not from precedence. */
  const bracketed = new WeakSet<object>();
  const peek = (k = 0): Tok | undefined => tokens[at + k];
  const isWord = (t: Tok | undefined, w: string) =>
    !!t && t.kind === "ident" && t.text.toLowerCase() === w;

  // the explicit annotation is what lets TypeScript treat a call to this as
  // unreachable-after, so the code below needs no redundant null checks
  const fail: (message: string, pos?: number) => never = (message, pos) => {
    const e: ExpressionError = { message, position: pos ?? peek()?.pos };
    throw e;
  };

  /* ---------------------------------------------------------- references */

  const readReference = (): { source: DraftSource; question?: Question; segments: string[] } => {
    const tok = peek();
    if (!tok || tok.kind !== "ident") fail("Expected a question reference");
    at += 1;
    const raw = tok!.text;
    const segments = raw.split(".").filter(Boolean);
    const head = segments[0];

    // namespaces first: calc.X / ed.X / embedded.X / loop.X / quota.X / @option
    const ns = head.toLowerCase();
    if (ns === "calc" || ns === "calculation") {
      return { source: { kind: "calculation", ref: segments.slice(1).join(".") }, segments };
    }
    if (ns === "ed" || ns === "embedded") {
      return { source: { kind: "embedded", ref: segments.slice(1).join(".") }, segments };
    }
    if (ns === "loop") {
      return { source: { kind: "loop", ref: segments[1] ?? "code" }, segments };
    }
    if (ns === "quota") {
      return { source: { kind: "quota", ref: segments.slice(1).join(".") }, segments };
    }
    if (ns === "@option" || ns === "option") {
      if (!opts.perOption) {
        fail("“@option” can only be used in option-level logic", tok!.pos);
      }
      return { source: { kind: "option", ref: segments[1] ?? "code" }, segments };
    }

    const q = getQuestionByCodeOrVar(def, head);
    if (!q) fail(`${head} does not exist`, tok!.pos);
    const source: DraftSource = { kind: "question", ref: q!.id };

    if (segments.length > 1) {
      const second = resolveRowOrOption(q!, segments[1]);
      if (!second) fail(`${head} has no “${segments[1]}”`, tok!.pos);
      if (second.kind === "row") source.rowCode = String(second.code);
      else source.optionCode = String(second.code);
    }
    if (segments.length > 2) {
      const third = resolveColumnOrOption(q!, segments[2]);
      if (!third) fail(`${segments.slice(0, 2).join(".")} has no “${segments[2]}”`, tok!.pos);
      if (third.kind === "column") source.columnId = String(third.code);
      else source.optionCode = String(third.code);
    }
    if (segments.length > 3) {
      fail(`“${raw}” has more parts than this question has dimensions`, tok!.pos);
    }
    return { source, question: q!, segments };
  };

  /* ----------------------------------------------------------- operators */

  const readOperator = (): ComparisonOperator | null => {
    // punctuation operators
    const t = peek();
    if (t?.kind === "punct" && ["=", "==", "!=", ">", ">=", "<", "<="].includes(t.text)) {
      at += 1;
      const hit = SPELLINGS.find((s) => s.words.length === 1 && s.words[0] === t.text);
      return hit!.op;
    }
    // word operators, longest spelling first
    for (const s of SPELLINGS) {
      if (s.words.every((w, k) => isWord(peek(k), w))) {
        at += s.words.length;
        return s.op;
      }
    }
    return null;
  };

  const readOperand = (): unknown => {
    const t = peek();
    if (!t) fail("Expected a value");
    if (t!.kind === "punct" && t!.text === "[") {
      at += 1;
      const list: unknown[] = [];
      while (peek() && !(peek()!.kind === "punct" && peek()!.text === "]")) {
        list.push(readOperand());
        if (peek()?.kind === "punct" && peek()!.text === ",") at += 1;
      }
      if (!peek()) fail("Missing closing bracket ]");
      at += 1;
      return list;
    }
    at += 1;
    if (t!.kind === "number") return Number(t!.text);
    return t!.text;
  };

  /* -------------------------------------------------------------- grammar */

  const parsePrimary = (): Condition => {
    const t = peek();
    if (!t) fail("Expression ended early — expected a condition");
    if (t!.kind === "punct" && t!.text === "(") {
      at += 1;
      const inner = parseOr();
      const close = peek();
      if (!close || close.kind !== "punct" || close.text !== ")") {
        fail("Missing closing parenthesis", t!.pos);
      }
      at += 1;
      // an explicit bracket is kept as a group, so the shape the programmer
      // wrote is the shape that gets stored (req §4, §16)
      const group: Condition = inner.type === "group"
        ? inner
        : { type: "group", op: "and", children: [inner] };
      // remember that THIS group came from brackets the programmer typed, so
      // the precedence warning below can tell it apart from one precedence
      // built on its own
      bracketed.add(group);
      return group;
    }
    if (t!.kind === "punct") fail(`Unexpected “${t!.text}”`, t!.pos);
    if (isWord(t, "and") || isWord(t, "or")) {
      fail(`An expression cannot start with ${t!.text.toUpperCase()}`, t!.pos);
    }

    const { source, question } = readReference();
    const opStart = at;
    const operator = readOperator();

    if (!operator) {
      // a bare reference: the natural reading depends on what it points at
      return bareCondition(source, question);
    }
    if (NO_OPERAND.includes(operator)) {
      return { type: "rule", source: strip(source), operator };
    }
    if (LIST_OPERAND.includes(operator)) {
      const value = readOperand();
      return { type: "rule", source: strip(source), operator, value: Array.isArray(value) ? value : [value] };
    }
    if (TWO_OPERANDS.includes(operator)) {
      const value = readOperand();
      if (isWord(peek(), "and")) at += 1;
      else if (peek()?.kind === "punct" && peek()!.text === ",") at += 1;
      const value2 = readOperand();
      return { type: "rule", source: strip(source), operator, value, value2 };
    }
    if (!peek() || (peek()!.kind === "punct" && [")", ",", "]"].includes(peek()!.text))
      || isWord(peek(), "and") || isWord(peek(), "or")) {
      fail(`${OPERATOR_SPELLING(operator)} needs a value`, tokens[opStart]?.pos);
    }
    return { type: "rule", source: strip(source), operator, value: readOperand() };
  };

  const parseNot = (): Condition => {
    if (isWord(peek(), "not")) {
      at += 1;
      const inner = parseNot();
      return { type: "group", op: "not", children: [inner] };
    }
    return parsePrimary();
  };

  const parseAnd = (): Condition => {
    const parts = [parseNot()];
    while (isWord(peek(), "and")) {
      at += 1;
      if (!peek()) fail("Expression ends with AND — expected another condition");
      parts.push(parseNot());
    }
    return parts.length === 1 ? parts[0] : { type: "group", op: "and", children: parts };
  };

  const parseOr = (): Condition => {
    const parts = [parseAnd()];
    while (isWord(peek(), "or")) {
      at += 1;
      if (!peek()) fail("Expression ends with OR — expected another condition");
      parts.push(parseAnd());
    }
    if (parts.length === 1) return parts[0];
    /*
     * Warn only when precedence did the grouping.
     *
     * `A OR B AND C` is the ambiguous line worth flagging. A fully bracketed
     * one — `(A AND B) OR (C AND D)`, or anything this module printed — is not
     * ambiguous at all, and warning about it told programmers their correct
     * expression looked wrong.
     */
    const implicitAnd = parts.some(
      (p) => p.type === "group" && p.op === "and" && !bracketed.has(p),
    );
    if (implicitAnd) {
      warnings.push({
        message: "AND and OR are mixed without parentheses — AND binds tighter. Add brackets to be explicit.",
      });
    }
    return { type: "group", op: "or", children: parts };
  };

  try {
    const condition = parseOr();
    if (at < tokens.length) {
      const t = tokens[at];
      fail(t.kind === "punct" && t.text === ")"
        ? "Unmatched closing parenthesis"
        : `Unexpected “${t.text}” — is an AND or OR missing?`, t.pos);
    }
    return { condition, errors, warnings };
  } catch (e) {
    const err = e as ExpressionError;
    return { errors: [err.message ? err : { message: String(e) }], warnings };
  }
}

/**
 * `optionCode` is carried on the source only while parsing — the canonical
 * model keeps a selected option in the rule's VALUE, which is where the
 * evaluator and the visual builder both look for it.
 */
function strip(source: DraftSource): ConditionRule["source"] {
  const { optionCode: _dropped, ...rest } = source;
  return rest;
}

/** What a reference with no operator means, given what it points at. */
function bareCondition(source: DraftSource, question?: Question): ConditionRule {
  const optionCode = source.optionCode;
  const clean = strip(source);
  if (optionCode != null) {
    // `Q1.brandA` — that option is selected
    return { type: "rule", source: clean, operator: "selected", value: optionCode };
  }
  // `Q1` or `Q1.R1` — there is an answer there
  return { type: "rule", source: clean, operator: "answered" };
}

/* ------------------------------------------------------ resolving segments */

interface Resolved { kind: "row" | "option" | "column"; code: string | number }

const positional = (token: string, prefix: string): number | null => {
  const m = new RegExp(`^${prefix}(\\d+)$`, "i").exec(token);
  return m ? Number(m[1]) : null;
};

/** The second segment: a row when the question has rows, else an option. */
export function resolveRowOrOption(q: Question, token: string): Resolved | null {
  const byRow = q.rows.find((r) => String(r.code) === token);
  if (byRow) return { kind: "row", code: byRow.code };
  const byOpt = q.options.find((o) => String(o.code) === token);
  if (byOpt) return { kind: "option", code: byOpt.code };

  const rn = positional(token, "R");
  if (rn != null) {
    const byCode = q.rows.find((r) => String(r.code) === String(rn));
    if (byCode) return { kind: "row", code: byCode.code };
    if (q.rows[rn - 1]) return { kind: "row", code: q.rows[rn - 1].code };
  }
  const on = positional(token, "O") ?? positional(token, "A");
  if (on != null) {
    const byCode = q.options.find((o) => String(o.code) === String(on));
    if (byCode) return { kind: "option", code: byCode.code };
    if (q.options[on - 1]) return { kind: "option", code: q.options[on - 1].code };
  }
  return null;
}

/** The third segment: a composite column, else a scale option (matrix). */
export function resolveColumnOrOption(q: Question, token: string): Resolved | null {
  const byCol = q.columns.find((c) => c.id === token || c.variableStem === token);
  if (byCol) return { kind: "column", code: byCol.id };
  const byOpt = q.options.find((o) => String(o.code) === token);
  if (byOpt) return { kind: "option", code: byOpt.code };

  const cn = positional(token, "C");
  if (cn != null) {
    if (q.columns.length) {
      const byCode = q.columns.find((c) => c.id === String(cn));
      if (byCode) return { kind: "column", code: byCode.id };
      if (q.columns[cn - 1]) return { kind: "column", code: q.columns[cn - 1].id };
    }
    const byOptCode = q.options.find((o) => String(o.code) === String(cn));
    if (byOptCode) return { kind: "option", code: byOptCode.code };
    if (q.options[cn - 1]) return { kind: "option", code: q.options[cn - 1].code };
  }
  return null;
}

/* ============================================================== formatting */

const IDENT_SAFE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** How a row / option / column code is written in an expression. */
function codeToken(code: string | number, prefix: "R" | "C" | ""): string {
  const s = String(code);
  if (IDENT_SAFE.test(s)) return s;
  return `${prefix}${s}`;
}

function operandText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(operandText).join(", ")}]`;
  if (typeof v === "number") return String(v);
  const s = String(v ?? "");
  if (s === "") return '""';
  if (IDENT_SAFE.test(s) || /^-?\d+(\.\d+)?$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** The reference text for a rule's source. */
function referenceText(def: SurveyDefinition, rule: ConditionRule): string {
  const { source } = rule;
  if (source.kind === "calculation") return `calc.${source.ref}`;
  if (source.kind === "embedded") return `ed.${source.ref}`;
  if (source.kind === "loop") return `loop.${source.ref || "code"}`;
  if (source.kind === "quota") return `quota.${source.ref}`;
  if (source.kind === "option") return `@option.${source.ref || "code"}`;

  const q = getQuestionByCodeOrVar(def, source.ref);
  let out = q?.code ?? source.ref;
  if (source.rowCode != null) {
    const row = q?.rows.find((r) => String(r.code) === String(source.rowCode));
    out += `.${codeToken(row?.code ?? source.rowCode, "R")}`;
  }
  if (source.columnId != null) {
    const col = q?.columns.find((c) => c.id === source.columnId);
    out += `.${codeToken(col?.id ?? source.columnId, "C")}`;
  }
  return out;
}

/**
 * One rule as text. `selected`/`notSelected` on an option collapse into the
 * dotted reference (`Q1.brandA`), which is how the shorthand round-trips.
 */
function ruleText(def: SurveyDefinition, rule: ConditionRule): string {
  const ref = referenceText(def, rule);
  const { operator, value, value2 } = rule;
  const q = rule.source.kind === "question" ? getQuestionByCodeOrVar(def, rule.source.ref) : undefined;

  if (operator === "answered" && rule.source.kind === "question") return ref;

  /*
   * `selected` collapses into the dotted reference, which is the shorthand
   * `Q1.brandA` parses back to — exactly. `notSelected` does NOT become
   * `NOT Q1.brandA`: that re-parses as a NOT group wrapping a selected rule,
   * which means the same thing but is a different tree, and the round trip
   * between the two editors has to be an identity.
   */
  if (operator === "selected" && value != null && q) {
    const opt = q.options.find((o) => String(o.code) === String(value));
    if (opt) return `${ref}.${codeToken(opt.code, "C")}`;
  }

  if (NO_OPERAND.includes(operator)) return `${ref} ${OPERATOR_SPELLING(operator)}`;
  if (TWO_OPERANDS.includes(operator)) {
    return `${ref} ${OPERATOR_SPELLING(operator)} ${operandText(value)} and ${operandText(value2)}`;
  }
  if (LIST_OPERAND.includes(operator)) {
    const list = Array.isArray(value) ? value : [value];
    return `${ref} ${OPERATOR_SPELLING(operator)} ${operandText(list)}`;
  }
  return `${ref} ${OPERATOR_SPELLING(operator)} ${operandText(value)}`;
}

export interface FormatOptions {
  /** Break long expressions over several indented lines (req §18). */
  pretty?: boolean;
  /** Width at which a group starts breaking. */
  width?: number;
}

/**
 * A canonical tree as expression text.
 *
 * Every group it prints is parenthesised, so re-parsing gives back the same
 * tree — the round trip the two editors depend on (reqs §13–15).
 */
export function formatCondition(
  def: SurveyDefinition,
  c: Condition | undefined | null,
  opts: FormatOptions = {},
): string {
  if (!c) return "";
  const width = opts.width ?? 46;

  const render = (node: Condition, depth: number, top: boolean): string => {
    if (node.type === "rule") return ruleText(def, node);

    const kids = node.children;
    if (kids.length === 0) return "";
    if (node.op === "not") {
      /*
       * One child renders itself — a group already comes back bracketed, so
       * adding another pair here produced `NOT ((A OR B))`.
       *
       * Several children mean "none of these are true", which is NOT(a OR b).
       * Joining them with AND would print NAND instead: true whenever any one
       * of them is false. The meaning survives the round trip; the shape
       * becomes an explicit `not` over an `or`, which is what the text says.
       */
      if (kids.length === 1) return `NOT ${render(kids[0], depth, false)}`;
      return `NOT (${kids.map((k) => render(k, depth + 1, false)).join(" OR ")})`;
    }

    const joiner = node.op === "and" ? "AND" : "OR";
    const parts = kids.map((k) => render(k, depth + 1, false));
    const oneLine = parts.join(` ${joiner} `);
    const body = !opts.pretty || oneLine.length + depth * 4 <= width
      ? oneLine
      : parts.map((p, i) => `${"  ".repeat(depth + 1)}${i === 0 ? "" : `${joiner} `}${p}`).join("\n");

    if (top) return body;
    return opts.pretty && body.includes("\n")
      ? `(\n${body}\n${"  ".repeat(depth)})`
      : `(${body})`;
  };

  return render(c, 0, true);
}

/* ========================================================== the reference tree */

export interface ReferenceNode {
  /** what to insert */
  token: string;
  label: string;
  kind: "question" | "row" | "option" | "column" | "variable";
  children?: ReferenceNode[];
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "").trim();

/**
 * The pickable structure of a survey: questions, their rows, and what sits
 * under each row. This is what the editor's picker renders and what a drag
 * carries, so nobody has to remember a reference (reqs §5, §19).
 */
export function referenceTree(def: SurveyDefinition): ReferenceNode[] {
  const out: ReferenceNode[] = def.questions.map((q) => {
    const rowNodes: ReferenceNode[] = q.rows.map((r) => {
      const rowToken = `${q.code}.${codeToken(r.code, "R")}`;
      // under a row: the matrix scale points, or a composite table's columns
      const under: ReferenceNode[] = q.columns.length
        ? q.columns.map((c) => ({
            token: `${rowToken}.${codeToken(c.id, "C")}`,
            label: stripHtml(c.label) || c.id,
            kind: "column" as const,
          }))
        : q.options.map((o) => ({
            token: `${rowToken}.${codeToken(o.code, "C")}`,
            label: stripHtml(o.label) || String(o.code),
            kind: "option" as const,
          }));
      return {
        token: rowToken,
        label: stripHtml(r.label) || String(r.code),
        kind: "row" as const,
        children: under.length ? under : undefined,
      };
    });

    // a question without rows offers its options directly
    const optionNodes: ReferenceNode[] = q.rows.length === 0
      ? q.options.map((o) => ({
          token: `${q.code}.${codeToken(o.code, "C")}`,
          label: stripHtml(o.label) || String(o.code),
          kind: "option" as const,
        }))
      : [];

    const children = [...rowNodes, ...optionNodes];
    return {
      token: q.code,
      label: `${q.code} — ${stripHtml(q.text).slice(0, 60) || q.variableName}`,
      kind: "question" as const,
      children: children.length ? children : undefined,
    };
  });

  for (const c of def.calculations) {
    out.push({ token: `calc.${c.targetVariable}`, label: `calc: ${c.targetVariable}`, kind: "variable" });
  }
  for (const e of def.embeddedData) {
    out.push({ token: `ed.${e.name}`, label: `data: ${e.name}`, kind: "variable" });
  }
  return out;
}
