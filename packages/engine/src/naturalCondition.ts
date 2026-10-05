import type { Condition, SurveyDefinition } from "@rescript/schema";
import { formatCondition, parseLogicExpression } from "./logicExpression.js";

/**
 * EVERYDAY CONDITION WORDS → THE EXPRESSION LANGUAGE.
 *
 * The expression parser speaks `Q3 = Yes AND Q9 > 25`; people write "Q3 is
 * yes and Q9 is over 25". This module is the bridge, and it is the ONLY one:
 * the Studio's deterministic grammar and the engine's sentence interpreter
 * (`nlIntent.ts`) both hand a condition to `normaliseConditionText` before
 * the parser sees it, so "is over" means `>` in both, and a spelling learnt
 * by one is learnt by the other. (It began life as the Studio's
 * `normaliseExpression`; the rewrites are the same, plus the comparator words
 * the Studio missed — over, under, older than, N or more, N+, up to, exceeds,
 * between, and a plain "is" before a value.)
 *
 * The rewrites are TEXTUAL and CONSERVATIVE. Nothing here decides what a rule
 * means — whether `Male` is an option of Q7, whether Q9 is numeric, whether
 * the question exists at all — only how an operator is spelled. The parser
 * still has the last word, against the real survey, and `conditionFromText`
 * runs it in strict mode so a word compared with a number is an error rather
 * than a rule that is never true.
 *
 * Quoted text is never rewritten: `Q4 = "is over the moon"` reaches the parser
 * exactly as typed (curly quotes become straight ones, which is all the
 * parser reads).
 */

/** "option 3" → `"option 3"` (code 3, else the third option); any other token is left as written */
const optionRef = (v: string) => (/^\d+$/.test(v) ? `"option ${v}"` : v);
type Rewrite = string | ((match: string, ...groups: string[]) => string);

/** a number ahead that is not the start of an ISO date — "before 30" is a comparison, "before 2026-01-01" is the date operator */
const NUMBER_AHEAD = String.raw`(?=\s*-?\d+(?:\.\d+)?(?![\d-]))`;

/*
 * Order matters, and it is the order a reader resolves the words in: the
 * connectives first (they decide the grouping), then the option-number forms,
 * then the comparators from the longest phrase to the shortest — "no less
 * than" before "less than", "is greater than or equal to" before "greater
 * than", "N or more" before "more" — and only then a bare "is", which by that
 * point can only mean equality.
 */
const REWRITES: [RegExp, Rewrite][] = [
  /*
   * The connectives people write instead of AND / OR / NOT. "neither A nor B"
   * is NOT (A OR B); "either A or B" and "both A and B" are just A OR B and
   * A AND B; "A but not B" and "A except (when) B" exclude B.
   */
  [/\bneither\s+(.+?)\s+nor\s+(.+?)(?=\s+(?:and|or|then)\b|$)/gi, "NOT ($1 OR $2)"],
  [/\beither\s+/gi, ""],
  [/\bboth\s+(?=\S+.*\band\b)/gi, ""],
  [/,?\s+but\s+not\s+/gi, " AND NOT "],
  [/,?\s+except\s+(?:when|if|where)?\s*(.+)$/gi, " AND NOT ($1)"],
  // "Q5 option 3 is selected" / "Q5 is option 2" / "option 3 of Q5 is selected" — an option by its code
  // ("option 3" stays "option 3" so the parser can read it as code 3, or as the third option when the codes are words)
  [/\b([A-Za-z_][\w.]*)\s+(?:option|answer|choice|code)\s+(\w+)\s+(?:is|was|has\s+been)\s+(?:selected|chosen|picked|ticked|answered)\b/gi, (_, q: string, v: string) => `${q} = ${optionRef(v)}`],
  [/\b(?:option|answer|choice|code)\s+(\w+)\s+(?:of|in|at|on|for)\s+([A-Za-z_][\w.]*)\s+(?:is|was|has\s+been)\s+(?:selected|chosen|picked|ticked)\b/gi, (_, v: string, q: string) => `${q} = ${optionRef(v)}`],
  [/\b([A-Za-z_][\w.]*)\s+(?:is|was|equals|=)\s+(?:option|answer|choice|code)\s+(\w+)\b/gi, (_, q: string, v: string) => `${q} = ${optionRef(v)}`],
  [/\b([A-Za-z_][\w.]*)\s+(?:is\s+not|isn't|!=)\s+(?:option|answer|choice|code)\s+(\w+)\b/gi, (_, q: string, v: string) => `${q} != ${optionRef(v)}`],
  /* ranges: the parser's own `between A and B` (two operands), and its negation */
  [/\b(?:is\s+not|isn't|not)\s+between\b/gi, "not between"],
  [/\bis\s+between\b/gi, "between"],
  /* the negated comparatives — longest first, so "no less than" is not read as "less than" */
  [/\b(?:is\s+)?(?:no|not)\s+(?:less|fewer|lower|smaller|younger)\s+than\b/gi, ">="],
  [/\b(?:is\s+)?(?:no|not)\s+(?:more|greater|higher|bigger|older)\s+than\b/gi, "<="],
  [/\bis\s+(?:greater|more|higher|bigger)\s+than\s+or\s+equal\s+to\b/gi, ">="],
  [/\bis\s+(?:less|lower|smaller|fewer)\s+than\s+or\s+equal\s+to\b/gi, "<="],
  /* "25 or more", "18 and over", "25+" — the bound comes before the comparator, so the two swap */
  [/\b(?:is\s+)?(-?\d+(?:\.\d+)?)\s+(?:or|and)\s+(?:more|over|above|higher|greater|older|up|later)\b/gi, ">= $1"],
  [/\b(?:is\s+)?(-?\d+(?:\.\d+)?)\s+(?:or|and)\s+(?:less|fewer|under|below|lower|smaller|younger|earlier)\b/gi, "<= $1"],
  [/\b(?:is\s+)?(\d+(?:\.\d+)?)\+(?=\s|$|\))/gi, ">= $1"],
  [/\b(?:is\s+)?(?:greater|more|higher|bigger|older)\s+than\b/gi, ">"],
  [/\b(?:is\s+)?(?:less|lower|smaller|fewer|younger)\s+than\b/gi, "<"],
  [/\b(?:is\s+)?(?:over|above|exceeds|exceeding|exceeded)\b/gi, ">"],
  [/\b(?:is\s+)?(?:under|below)\b/gi, "<"],
  // "after 30" / "before 30" compare numbers; "after 2026-01-01" stays the parser's date operator
  [new RegExp(String.raw`\b(?:is\s+)?after${NUMBER_AHEAD}`, "gi"), ">"],
  [new RegExp(String.raw`\b(?:is\s+)?before${NUMBER_AHEAD}`, "gi"), "<"],
  [/\bis\s+(after|before|on)(?=\s+\d{4}-\d{2}-\d{2})/gi, "$1"],
  [/\b(?:is\s+)?at\s+least\b/gi, ">="],
  [/\b(?:is\s+)?at\s+most\b/gi, "<="],
  [/\b(?:is\s+)?up\s+to\b/gi, "<="],
  [/\b(?:is\s+)?(?:equal\s+to|equals)\b/gi, "="],
  [/\b(?:does\s+not|doesn't|didn't|did\s+not)\s+(?:equal|contain|include)\b/gi, "is not"],
  [/\b(?:is\s+not|isn't|was\s+not|wasn't)\s+(?:selected|chosen|picked|ticked)\b/gi, "not selected"],
  [/\b(?:is|was|has\s+been)\s+(?:selected|chosen|picked|ticked)\b/gi, "selected"],
  [/\b(?:includes?|selected)\s+(?:the\s+)?(?:option|answer|choice)\b/gi, "contains"],
  [/\b(?:is|was|has\s+been)\s+answered\b/gi, "answered"],
  [/\b(?:is|was)\s+(?:blank|empty|unanswered|skipped|not\s+answered)\b/gi, "unanswered"],
  [/\b(?:isn't|is\s+not|was\s+not|wasn't)\b/gi, "is not"],
  [/\b(?:was|are|were|has|have)\b/gi, "is"],
  [/\bthe\s+(?:answer|response|value)\s+(?:to|of|for)\s+/gi, ""],
  [/\b(?:respondent|they|the\s+user|the\s+person)\s+(?:answered|said|chose|selected|picked)\s+/gi, ""],
  [/\bin\s+([A-Za-z_][\w.]*)\s+(?:is|=)\s+/gi, "$1 = "],
  [/\bmore\s+than\s+or\s+=\b/gi, ">="],
  /*
   * THE PLAIN "IS". By now every "is" that was part of a longer operator has
   * been consumed, so what is left is "Q7 is Male" — equality — or "is"
   * before an operator the parser already reads ("is not empty", "is in",
   * "is >= 25" from "is 25 or more"), which is left to the parser or dropped.
   */
  [/\bis\s+not\s+in\b/gi, "not in"],
  [/\bis\s+in\b/gi, "in"],
  [/\bis\s+not\b(?!\s+(?:empty|blank|selected|answered|ranked|contains)\b)/gi, "!="],
  [/\bis\s+(?=(?:>=|<=|!=|=|>|<)(?:\s|$))/gi, ""],
  [/\bis\s+(?!not\b|empty\b|in\b|between\b|selected\b|answered\b|unanswered\b|ranked\b|before\b|after\b|on\b|contains\b)(?=\S)/gi, "= "],
];

/**
 * A multi-word operand gets quotes: `Q4 = United States` is what people
 * write, `Q4 = "United States"` is what the parser reads. Only bare words
 * (no quotes, no digits-only tokens) up to the next AND/OR/parenthesis.
 */
const OPERAND_AFTER = /((?:^|\s)(?:=|!=|<>|>=|<=|>|<|is not|is|not contains|contains|not selected|selected|matches|starts with|ends with))\s+((?!and\b|or\b|nor\b|not\b|then\b)[A-Za-z][\w'’\-\/]*(?:\s+(?!and\b|or\b|nor\b|not\b|then\b)[A-Za-z0-9][\w'’\-\/]*)+)(?=\s+(?:and|or|nor|then)\b|\s*\)|$)/gi;

/**
 * "none of A, B or C" / "any of …" / "all of …" at the head of a condition:
 * a list of conditions under one connective. NONE is NOT (A OR B OR C) — the
 * NOR the parser stores — ANY is A OR B, ALL is A AND B. Fewer than two
 * items is not a list and is left alone.
 */
function listOfConditions(text: string): string {
  const m = /^(none|neither|any|either|all|both)\s+of\s+(?:these\s*|the\s+following\s*)?:?\s*(.+)$/i.exec(text);
  if (!m) return text;
  const kind = m[1].toLowerCase();
  const items = m[2].split(/\s*;\s*|\s*,\s*(?:(?:and|or|nor)\s+)?|\s+(?:or|nor)\s+|\s+and\s+(?=[A-Za-z_][\w.]*\s*(?:=|!=|>|<|is\b|contains\b|selected\b))/i).map((s) => s.trim()).filter(Boolean);
  if (items.length < 2) return text;
  const joined = items.join(kind === "all" || kind === "both" ? " AND " : " OR ");
  return kind === "none" || kind === "neither" ? `NOT (${joined})` : joined;
}

/** the connectives in capitals — the way the expression editor prints them — outside quotes only */
function capitaliseConnectives(text: string): string {
  return text
    // "between 18 and 30" is one operator's two operands, not a conjunction: its "and" stays as written
    .replace(/(?<!\bbetween\s+\S+\s+)\b(and|or|nor)\b/gi, (w) => w.toUpperCase())
    // NOT as a connective; "not selected", "not in", "not between" are operators and stay lower case
    .replace(/\bnot\b(?!\s+(?:selected|contains|in|between|empty|ranked|answered)\b)/gi, "NOT");
}

/**
 * Everyday condition text → the expression language, ready for
 * `parseLogicExpression`. Already-canonical text passes through unchanged
 * (apart from the connectives' capitals).
 */
export function normaliseConditionText(text: string): string {
  /*
   * Quoted text is masked while the rewrites run, so a value that happens to
   * contain "is" or "over" is never rewritten, and restored afterwards with
   * straight quotes.
   */
  const quoted: string[] = [];
  let out = String(text ?? "").trim().replace(/[.?!]+$/, "").replace(/"([^"]*)"|“([^”]*)”/g, (_, a: string | undefined, b: string | undefined) => {
    quoted.push(a ?? b ?? "");
    return `\u0001${quoted.length - 1}\u0001`;
  });
  out = listOfConditions(out.replace(/\s+/g, " "));
  for (const [re, to] of REWRITES) out = typeof to === "string" ? out.replace(re, to) : out.replace(re, to as (m: string, ...g: string[]) => string);
  out = out.replace(OPERAND_AFTER, (_, op: string, words: string) => `${op} "${words}"`);
  out = capitaliseConnectives(out.replace(/\s+/g, " ").trim());
  return out.replace(/\u0001(\d+)\u0001/g, (_, i: string) => `"${quoted[Number(i)]}"`);
}

export interface ConditionFromText {
  /** the text handed to the parser (normalised) */
  expression: string;
  condition?: Condition;
  /** the canonical spelling of the parsed tree — what the expression editor shows — or "" */
  canonical: string;
  /** anything here means there is no condition; `suggestion` is a corrected expression when the parser has a "did you mean" */
  errors: { message: string; suggestion?: string }[];
  warnings: string[];
}

/**
 * Everyday condition text, parsed against the survey: normalised, then read
 * by `parseLogicExpression` in STRICT mode (a word compared with a numeric
 * question is an error, not a literal) unless `strict: false` is asked for.
 *
 * When the normalised text does not parse but the text as typed does — it
 * was already in the expression language and a rewrite got in its way — the
 * typed text wins: the normaliser exists to help the parser, never to stand
 * between it and a correct expression.
 */
export function conditionFromText(def: SurveyDefinition, text: string, opts: { strict?: boolean } = {}): ConditionFromText {
  const strict = opts.strict !== false;
  const expression = normaliseConditionText(text);
  const read = (src: string) => parseLogicExpression(def, src, { strict });
  let r = read(expression);
  let used = expression;
  if ((r.errors.length || !r.condition) && expression !== text.trim()) {
    const raw = read(text.trim().replace(/[.?!]+$/, ""));
    if (!raw.errors.length && raw.condition) { r = raw; used = text.trim().replace(/[.?!]+$/, ""); }
  }
  if (r.errors.length || !r.condition) {
    const errors = r.errors.length ? r.errors.map((e) => ({ message: e.message, ...(e.suggestion ? { suggestion: e.suggestion } : {}) })) : [{ message: "the condition is empty" }];
    return { expression: used, canonical: "", errors, warnings: r.warnings.map((w) => w.message) };
  }
  return { expression: used, condition: r.condition, canonical: formatCondition(def, r.condition), errors: [], warnings: r.warnings.map((w) => w.message) };
}
