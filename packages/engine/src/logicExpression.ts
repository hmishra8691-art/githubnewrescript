import type {
  Condition, ConditionGroup, ConditionRule, ComparisonOperator, FlowNode,
  Question, SurveyDefinition,
} from "@rescript/schema";
import { getQuestionByCodeOrVar } from "./state.js";
import { findNamedExpression } from "./namedExpressions.js";

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

/*
 * Two-character operators come first, so ">=" is not read as ">" followed by
 * "=". The arithmetic four are here so an expression like `Q5 + Q6 > 100` can
 * tokenize at all — before this they were "Unexpected character".
 */
const PUNCT = [">=", "<=", "!=", "==", "(", ")", "[", "]", ",", "=", ">", "<", "+", "-", "*", "/", "%"];

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

/** Every loopVar in the flow — what lets `brand.Category` name the outer loop. */
function loopVarsIn(nodes: FlowNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "loop") { out.push(n.loopVar); out.push(...loopVarsIn(n.children)); }
    else if (n.type === "section" || n.type === "block" || n.type === "randomizer") out.push(...loopVarsIn(n.children));
    else if (n.type === "branch") {
      for (const b of n.branches) out.push(...loopVarsIn(b.children));
      if (n.otherwise) out.push(...loopVarsIn(n.otherwise));
    }
  }
  return out;
}

/* ============================================== functions in a condition
 *
 * `COUNT(Q2) >= 3`, `SUM(Q5, Q6, Q7) > 100`, `CONTAINS(Q10, "manager")`.
 *
 * TWO KINDS OF FUNCTION, AND NEITHER ONE IS A NEW ENGINE.
 *
 *   COUNT(...)   compiles to the `count` SOURCE — the structured count spec
 *                the visual builder writes. So a count typed as text and a
 *                count built by clicking are the same tree, and the count
 *                evaluator is the only one there is.
 *
 *   everything   compiles to the `expr` source, whose value is produced by
 *   else         the CALCULATION engine — the same `evaluateExpression` that
 *                runs `Calculation.expression`. Every function it already had
 *                (sum, avg, min, max, round, abs, len, concat, contains, …)
 *                is therefore available in a condition on the day this lands,
 *                and a function added there is available in both places at
 *                once. That is the §29 requirement — new functions plug in
 *                without rewriting the features that consume them.
 *
 * The alternative was a third expression language with its own function table
 * to keep in step with the other two. The repo already has one such
 * duplication (`embedded.ts` lists calc's functions again, with nothing
 * keeping them in sync); a third would be a promise to get it wrong.
 */

/** Names that mean "count of a collection", handled structurally. */
const COUNT_FUNCTIONS = new Set(["count", "counted"]);

/**
 * Names handed to the calculation engine. Kept as a list rather than "anything
 * with a bracket after it" so a typo is a parse error naming the function
 * instead of a rule that silently evaluates to null at run time.
 */
const CALC_FUNCTIONS = new Set([
  /* numeric */
  "sum", "avg", "average", "mean", "min", "max", "round", "abs", "floor",
  "ceil", "ceiling", "sqrt", "pow", "pct", "percent", "weighted", "countif",
  /* string */
  "len", "length", "concat", "contains", "upper", "lower", "trim",
  "substring", "substr", "replace", "startswith", "endswith",
  /* general */
  "if", "coalesce", "number", "text",
]);

/**
 * Functions whose value IS a yes/no answer, so a bare call is a complete
 * condition: `CONTAINS(Q10, "manager")` needs no comparison. A COUNT does —
 * reading `COUNT(Q1)` alone as "> 0" would be a guess, and it is wrong as
 * often as it is right, so that case is refused with a message instead.
 */
const BOOLEAN_FUNCTIONS = new Set(["contains", "startswith", "endswith"]);

/** Arithmetic that turns a run of tokens into a calc expression. */
const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);

/** Words that end an arithmetic run — they belong to the condition, not to it. */
const CALC_STOP_WORDS = new Set(["and", "or", "not", "then", "else"]);

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

  /* ----------------------------------------------------------- functions */

  /** The source text of tokens [from, to), as the calc engine will see it. */
  const sliceText = (from: number, to: number): string => {
    const parts: string[] = [];
    for (let i = from; i < to; i++) {
      const t = tokens[i];
      if (t.kind === "string") { parts.push(JSON.stringify(t.text)); continue; }
      if (t.kind === "ident") {
        /*
         * REFERENCES ARE NORMALISED TO VARIABLE NAMES before the calc engine
         * sees them, because the two languages address things differently: a
         * condition resolves a question by code, variable name OR id, while
         * calc resolves a name in the flat variable map. Without this,
         * `Q5 + Q6 > 100` would work only when a question's code and its
         * variable name happen to be the same string — true in most surveys,
         * and quietly false in the ones where somebody renamed a variable.
         */
        const q = getQuestionByCodeOrVar(def, t.text);
        parts.push(q ? q.variableName : t.text);
        continue;
      }
      parts.push(t.text);
    }
    return parts.join(" ");
  };

  /** Skip a balanced bracket pair starting at `i` (which must be "("). */
  const matchParen = (i: number): number => {
    let depth = 0;
    for (let j = i; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.kind !== "punct") continue;
      if (t.text === "(") depth += 1;
      else if (t.text === ")") { depth -= 1; if (depth === 0) return j; }
    }
    return -1;
  };

  /**
   * `COUNT(Q1, selected, rows, only [a, b], answering [4, 5])`.
   *
   * The first argument is the question; the rest are optional and order-free,
   * because a positional fifth argument nobody can read is worse than a named
   * one. Returns the count SOURCE — the same object the visual builder writes.
   */
  const readCountCall = (): DraftSource => {
    const nameTok = tokens[at];
    at += 1;              // the function name
    at += 1;              // "("
    const first = peek();
    if (!first || first.kind !== "ident") fail("COUNT needs a question", nameTok.pos);
    const q = getQuestionByCodeOrVar(def, first!.text);
    if (!q) fail(`${first!.text} does not exist`, first!.pos);
    at += 1;

    const spec: Record<string, unknown> = { of: "selected", scope: "options" };
    while (peek()?.kind === "punct" && peek()!.text === ",") {
      at += 1;
      const t = peek();
      if (!t) fail("COUNT( … has no closing bracket", nameTok.pos);
      const word = t!.kind === "ident" ? t!.text.toLowerCase() : "";
      if (["selected", "notselected", "valid", "invalid", "eligible", "visible", "hidden", "matching"].includes(word)) {
        spec.of = word === "notselected" ? "notSelected" : word;
        at += 1;
      } else if (["options", "rows", "columns"].includes(word)) {
        spec.scope = word;
        at += 1;
      } else if (word === "only" || word === "answering" || word === "group") {
        at += 1;
        const v = readOperand();
        if (word === "group") spec.group = String(v);
        else spec[word === "only" ? "only" : "responseIn"] = Array.isArray(v) ? v : [v];
      } else {
        fail(`COUNT does not understand “${t!.text}”`, t!.pos);
      }
    }
    const close = peek();
    if (!close || close.kind !== "punct" || close.text !== ")") {
      fail("COUNT( … has no closing bracket", nameTok.pos);
    }
    at += 1;
    return { kind: "question", ref: q!.id, count: spec as never };
  };

  /**
   * Is there a function call or an arithmetic run starting here, whose VALUE is
   * the left-hand side of a comparison?
   *
   * The disambiguation that matters: `(` begins a condition group almost
   * always, and an arithmetic expression only when a comparison operator
   * follows the closing bracket. `(A OR B) AND C` and `(Q5 + Q6) > 100` differ
   * only in what comes after the `)`, so the lookahead is exactly that — find
   * the matching bracket, look at the next token.
   */
  const calcRunEndsAt = (): number => {
    const t = peek();
    if (!t) return -1;

    if (t.kind === "punct" && t.text === "(") {
      const close = matchParen(at);
      if (close < 0) return -1;
      const after = tokens[close + 1];
      const isComparison = !!after && after.kind === "punct"
        && [">", "<", ">=", "<=", "=", "==", "!="].includes(after.text);
      return isComparison ? close + 1 : -1;
    }

    if (t.kind !== "ident") return -1;
    const name = t.text.toLowerCase();
    const isFn = CALC_FUNCTIONS.has(name) || COUNT_FUNCTIONS.has(name);
    if (isFn && tokens[at + 1]?.kind === "punct" && tokens[at + 1].text === "(") {
      const close = matchParen(at + 1);
      return close < 0 ? -1 : close + 1;
    }

    /*
     * A bare arithmetic run: `Q5 + Q6 > 100`. Only treated as one when an
     * arithmetic operator actually appears before the comparison — otherwise
     * every ordinary rule would take this path.
     */
    let i = at;
    let sawArithmetic = false;
    let depth = 0;
    while (i < tokens.length) {
      const tk = tokens[i];
      if (tk.kind === "punct") {
        if (tk.text === "(") { depth += 1; i += 1; continue; }
        if (tk.text === ")") { if (depth === 0) break; depth -= 1; i += 1; continue; }
        if (ARITHMETIC.has(tk.text)) { sawArithmetic = true; i += 1; continue; }
        break;                                     // a comparison, comma, or ]
      }
      if (tk.kind === "ident" && CALC_STOP_WORDS.has(tk.text.toLowerCase())) break;
      /*
       * A word that begins an operator spelling ends the run: in
       * `Q5 + Q6 is greater than 100`, "is" is the comparison, not a term.
       */
      if (tk.kind === "ident" && SPELLINGS.some((sp) => sp.words[0] === tk.text.toLowerCase())) break;
      i += 1;
    }
    return sawArithmetic ? i : -1;
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
    /*
     * A NAMED EXPRESSION (§34, §35): `IS_HIGH_VALUE`, or `rule.IS_HIGH_VALUE`
     * when a question happens to share the name.
     *
     * Checked before questions only for the explicit `rule.` spelling; the
     * bare name is checked AFTER questions below, so a survey that has both a
     * question and a macro called the same thing keeps meaning the question —
     * the same precedence a loopVar already gets.
     */
    if (ns === "rule" || ns === "expr" || ns === "macro") {
      const wanted = segments.slice(1).join(".");
      const named = findNamedExpression(def, wanted);
      if (!named) fail(`There is no named expression “${wanted}”`, tok!.pos);
      return { source: { kind: "rule", ref: named!.id }, segments };
    }
    if (ns === "calc" || ns === "calculation") {
      return { source: { kind: "calculation", ref: segments.slice(1).join(".") }, segments };
    }
    if (ns === "ed" || ns === "embedded") {
      return { source: { kind: "embedded", ref: segments.slice(1).join(".") }, segments };
    }
    if (ns === "loop") {
      // loop.code / loop.label / loop.index / loop.count / loop.<ReferenceColumn>
      return { source: { kind: "loop", ref: segments[1] ?? "code" }, segments };
    }
    /*
     * The requirement's spelling of the current item (§19, §27):
     * CURRENT_ITEM.Category, CURRENT_ITEM_CODE, LOOP_INDEX, LOOP_COUNT. Aliases
     * of loop.*, parsed to the same source the evaluator already understands.
     */
    if (head === "CURRENT_ITEM") {
      return { source: { kind: "loop", ref: segments[1] ?? "label" }, segments };
    }
    const fixedAlias: Record<string, string> = {
      CURRENT_ITEM_CODE: "code", CURRENT_ITEM_LABEL: "label", LOOP_INDEX: "index", LOOP_COUNT: "count",
    };
    if (fixedAlias[head] && segments.length === 1) {
      return { source: { kind: "loop", ref: fixedAlias[head] }, segments };
    }
    /*
     * `brand.Category` — an OUTER loop addressed by its loopVar (§32). A loop's
     * name is only taken as such when no question has that code, so a survey
     * with a question called `brand` keeps meaning the question.
     */
    if (segments.length >= 2 && !getQuestionByCodeOrVar(def, head)) {
      const loopVars = new Set(loopVarsIn(def.flow));
      if (loopVars.has(head)) {
        return { source: { kind: "loop", ref: segments[1], scope: head }, segments };
      }
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
    if (!q) {
      /* a bare macro name, once nothing else has claimed it */
      const named = segments.length === 1 ? findNamedExpression(def, head) : undefined;
      if (named) return { source: { kind: "rule", ref: named.id }, segments };
      fail(`${head} does not exist`, tok!.pos);
    }
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
    /*
     * A FUNCTION CALL OR AN ARITHMETIC RUN, whose value is the left-hand side
     * of a comparison. Checked before the bracket case below, because
     * `(Q5 + Q6) > 100` and `(A OR B) AND C` both start with "(" and are told
     * apart only by what follows the closing bracket.
     */
    const calcEnd = calcRunEndsAt();
    if (calcEnd > at) {
      const isCount = t!.kind === "ident" && COUNT_FUNCTIONS.has(t!.text.toLowerCase())
        && tokens[at + 1]?.kind === "punct" && tokens[at + 1].text === "(";
      const source: DraftSource = isCount
        ? readCountCall()
        : (() => {
          /*
           * A run that is entirely wrapped in brackets is stored WITHOUT them.
           * The printer adds exactly one pair back, so `(Q5 + Q6) > 100`
           * prints as itself; keeping the typed pair too would print
           * `((Q5 + Q6)) > 100`, which re-parses to a different tree and
           * breaks the round-trip identity the two editors depend on.
           */
          const wrapped = tokens[at]?.kind === "punct" && tokens[at].text === "("
            && matchParen(at) === calcEnd - 1;
          const text = wrapped ? sliceText(at + 1, calcEnd - 1) : sliceText(at, calcEnd);
          at = calcEnd;
          return { kind: "expr" as const, ref: text };
        })();

      const operator = readOperator();
      if (!operator) {
        /*
         * A bare call to a function that already answers yes or no is a
         * complete condition; anything else needs something to compare to.
         * Reading `COUNT(Q1)` as "> 0" would be a guess, and it is wrong as
         * often as it is right — more often it means somebody stopped typing.
         */
        const fname = t!.kind === "ident" ? t!.text.toLowerCase() : "";
        if (BOOLEAN_FUNCTIONS.has(fname)) {
          return { type: "rule", source: strip(source), operator: "eq", value: true };
        }
        fail("A count or calculation needs a comparison — for example COUNT(Q1) >= 2", t!.pos);
      }
      if (NO_OPERAND.includes(operator!)) {
        return { type: "rule", source: strip(source), operator: operator! };
      }
      if (TWO_OPERANDS.includes(operator!)) {
        const value = readOperand();
        if (isWord(peek(), "and")) at += 1;
        else if (peek()?.kind === "punct" && peek()!.text === ",") at += 1;
        return { type: "rule", source: strip(source), operator: operator!, value, value2: readOperand() };
      }
      if (LIST_OPERAND.includes(operator!)) {
        const value = readOperand();
        return { type: "rule", source: strip(source), operator: operator!, value: Array.isArray(value) ? value : [value] };
      }
      return { type: "rule", source: strip(source), operator: operator!, value: readOperand() };
    }

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
      /*
       * A bare macro is a complete condition — `IF IS_HIGH_VALUE` needs no
       * operator, which is the whole reason to give a condition a name.
       */
      if (source.kind === "rule") return { type: "rule", source: strip(source), operator: "eq", value: true };
      // a bare reference: the natural reading depends on what it points at
      return bareCondition(source, question);
    }
    /*
     * `Q1.A IS SELECTED`, `Q1.A = SELECTED`, `Q1.A IS NOT SELECTED`, `Q1.A
     * SELECTED`: the spelled-out form of the `Q1.A` shorthand. Without this the
     * words parsed as "Q1 equals the text SELECTED", which is never what a
     * programmer who writes it means.
     */
    if (source.optionCode != null) {
      const SELECTED_WORDS = ["selected", "checked", "chosen", "ticked", "picked"];
      const nextIsSelectedWord = SELECTED_WORDS.some((w) => isWord(peek(), w));
      if ((operator === "eq" || operator === "ne") && nextIsSelectedWord) {
        at += 1;
        return { type: "rule", source: strip(source), operator: operator === "eq" ? "selected" : "notSelected", value: source.optionCode };
      }
      if (operator === "selected" || operator === "notSelected") {
        const p = peek();
        const endsHere = !p || (p.kind === "punct" && [")", ",", "]"].includes(p.text)) || isWord(p, "and") || isWord(p, "or") || isWord(p, "then");
        if (endsHere) return { type: "rule", source: strip(source), operator, value: source.optionCode };
      }
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

  /* `O`/`A` accepted here as well, so a scale option spelled either way reads */
  const cn = positional(token, "C") ?? positional(token, "O") ?? positional(token, "A");
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
function codeToken(code: string | number, prefix: "R" | "C" | "O" | ""): string {
  const s = String(code);
  if (IDENT_SAFE.test(s)) return s;
  return `${prefix}${s}`;
}

/**
 * A count source as a `COUNT(...)` call.
 *
 * The argument order is the one the requirement writes — `COUNT(Q1, selected)`
 * — and everything after the first two is a named argument, so a subset or a
 * grid response set stays readable and stays optional. `SELECTED` is the
 * default and is therefore not printed, which keeps the common case short.
 */
function countText(def: SurveyDefinition, source: ConditionRule["source"]): string {
  const spec = source.count!;
  const q = getQuestionByCodeOrVar(def, source.ref);
  const args: string[] = [q?.code ?? source.ref];
  if (spec.of !== "selected") args.push(spec.of);
  if (spec.scope !== "options") args.push(spec.scope);
  if (spec.only?.length) args.push(`only [${spec.only.map(operandText).join(", ")}]`);
  if (spec.group) args.push(`group ${operandText(spec.group)}`);
  if (spec.responseIn?.length) args.push(`answering [${spec.responseIn.map(operandText).join(", ")}]`);
  return `COUNT(${args.join(", ")})`;
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
  /*
   * A calc expression prints as itself, in brackets — `(Q5 + Q6) > 100`. The
   * brackets are what make it re-parse as one expression rather than as the
   * start of a condition group, which is what the round-trip identity needs.
   */
  if (source.kind === "expr") return `(${source.ref})`;
  /*
   * A macro prints as its NAME, which is the point of having one — and the
   * name re-parses to the same id, so the round trip holds even though what
   * is stored is the id.
   */
  if (source.kind === "rule") {
    const named = findNamedExpression(def, source.ref);
    return named?.name?.trim() || `rule.${source.ref}`;
  }
  /*
   * A count prints as the function call it parses from, so `COUNT(Q1) >= 2`
   * survives a trip through the visual builder and back.
   */
  if (source.count) return countText(def, source);
  if (source.kind === "calculation") return `calc.${source.ref}`;
  if (source.kind === "embedded") return `ed.${source.ref}`;
  if (source.kind === "loop") return `${source.scope ?? "loop"}.${source.ref || "code"}`;
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

  /*
   * The bare-reference shorthand for `answered` applies to a question, not to
   * a count of one: `COUNT(Q1)` on its own would re-parse as "the count is
   * answered", which is not the same rule.
   */
  if (operator === "answered" && rule.source.kind === "question" && !rule.source.count) return ref;
  /* `IS_HIGH_VALUE = true` prints as `IS_HIGH_VALUE`, which parses back to it */
  if (rule.source.kind === "rule" && operator === "eq" && value === true) return ref;

  /*
   * `selected` collapses into the dotted reference, which is the shorthand
   * `Q1.brandA` parses back to — exactly. `notSelected` does NOT become
   * `NOT Q1.brandA`: that re-parses as a NOT group wrapping a selected rule,
   * which means the same thing but is a different tree, and the round trip
   * between the two editors has to be an identity.
   */
  if (operator === "selected" && value != null && q) {
    const opt = q.options.find((o) => String(o.code) === String(value));
    /*
     * THE PREFIX DEPENDS ON WHICH SEGMENT THE OPTION IS.
     *
     * A numeric code is not a bare identifier, so it needs a prefix — and
     * numeric is what `nextCode` generates for every option this platform
     * creates, which makes this the DEFAULT case rather than an edge one.
     * The two resolvers spell it differently and both are right: the second
     * segment (`Q1.O2`) is read by `resolveRowOrOption`, which takes O/A for
     * an option; the third (`Q2.R1.C2`) is read by `resolveColumnOrOption`,
     * where a matrix's scale options ARE its columns and the prefix is C.
     *
     * One printer line served both and always wrote C, so `Q1.1` printed as
     * `Q1.C1` — which re-parses as a column that does not exist. The round
     * trip was broken for plain option codes, and had been since the printer
     * was written.
     */
    if (opt) return `${ref}.${codeToken(opt.code, rule.source.rowCode != null ? "C" : "O")}`;
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
