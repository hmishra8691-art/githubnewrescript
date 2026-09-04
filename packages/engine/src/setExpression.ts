import type {
  SetExpr, SetOperator, SetSelection, SurveyDefinition, Question, PunchRule,
} from "@rescript/schema";
import { SET_OPERATOR_LABEL } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import { codesFrom } from "./carryforward.js";
import { getQuestion, getQuestionByCodeOrVar, type AnswerValue } from "./state.js";

/**
 * The set-expression engine: evaluate a nested set tree, and read or write it
 * as text.
 *
 * Three things it deliberately does NOT do:
 *
 *   • resolve a source question's answers itself — that is `codesFrom` in
 *     `carryforward.ts`, which already handles selected / unselected /
 *     displayed / all, loop-scoped answers, and running a source question's
 *     own pipeline for "displayed". One implementation, one set of answers;
 *   • evaluate conditions — `when` guards go through the same
 *     `evaluateCondition` everything else uses;
 *   • store anything. A mask is the tree; the text is printed from it.
 *
 * ## The language
 *
 *     Q5.Selected                            what they picked
 *     Q5.Unselected                          what they were shown and skipped
 *     Q5.Options                             everything Q5 defines
 *     Q5.Displayed                           what Q5 actually showed them
 *     Q5.Selected UNION Q6.Selected          either
 *     Q5.Selected INTERSECTION Q6.Selected   both
 *     Q5.Selected DIFFERENCE Q6.Selected     in Q5 and not in Q6
 *     NOT (Q5.Selected)                      this question's other options
 *     [a, b, c]                              literal codes
 *
 * `EXCLUDE` is accepted as a spelling of `DIFFERENCE`, because that is what
 * survey programmers call it. Set operators all bind equally and associate to
 * the left, so a mixed expression without brackets is flagged — `A UNION B
 * DIFFERENCE C` is the kind of line two people read two ways.
 */

/* ============================================================= evaluating */

const key = (c: string | number) => String(c);

/** Options the target question defines — the universe for a complement. */
function universe(target: Question | undefined): (string | number)[] {
  if (!target) return [];
  return target.rows.length > 0 && target.options.length === 0
    ? target.rows.map((r) => r.code)
    : target.options.map((o) => o.code);
}

export interface SetEvalOptions {
  /** The question the mask belongs to — the scope of a complement. */
  target?: Question;
}

/**
 * Evaluate a set expression against the current answers (req §29).
 *
 * Order is preserved: the result keeps the order in which codes first appear,
 * so a mask does not silently reshuffle a question's options. Presentation
 * order stays the job of the sort / randomize stages.
 */
export function evaluateSetExpr(
  expr: SetExpr | undefined | null,
  ctx: EvalContext,
  opts: SetEvalOptions = {},
): (string | number)[] {
  if (!expr) return [];

  switch (expr.kind) {
    case "codes":
      return dedupe(expr.codes);

    case "ref": {
      const which = expr.selection === "unselected" ? "not_selected" : expr.selection;
      return dedupe(codesFrom(expr.questionId, which as any, ctx));
    }

    case "complement": {
      const inside = new Set(evaluateSetExpr(expr.of, ctx, opts).map(key));
      return universe(opts.target).filter((c) => !inside.has(key(c)));
    }

    case "op": {
      const left = evaluateSetExpr(expr.left, ctx, opts);
      const right = evaluateSetExpr(expr.right, ctx, opts);
      const rightKeys = new Set(right.map(key));
      switch (expr.operator) {
        case "union": {
          const seen = new Set(left.map(key));
          return [...left, ...right.filter((c) => !seen.has(key(c)))];
        }
        case "intersection":
          return left.filter((c) => rightKeys.has(key(c)));
        case "difference":
          return left.filter((c) => !rightKeys.has(key(c)));
        default:
          return left;
      }
    }

    default:
      return [];
  }
}

function dedupe(codes: (string | number)[]): (string | number)[] {
  const seen = new Set<string>();
  const out: (string | number)[] = [];
  for (const c of codes) {
    if (seen.has(key(c))) continue;
    seen.add(key(c));
    out.push(c);
  }
  return out;
}

/* ================================================================ punching */

/** Actions that change the option LIST rather than the answer (autoPunch.ts owns those). */
export const LIST_ACTIONS: ReadonlySet<PunchRule["action"]> = new Set(["show", "hide", "enable", "disable"]);

export interface PunchResult {
  /** Codes to tick in the question the rule belongs to. */
  select: (string | number)[];
  /** Codes to untick. */
  deselect: (string | number)[];
  /** Source codes with no counterpart here, for the editor to report. */
  unmatched: (string | number)[];
  /** True when any rule asked to recompute on every visit. */
  recomputeAlways: boolean;
  /** A `clear` rule fired: the answer is to be emptied (before any select). */
  clear: boolean;
  /**
   * A `set_value` rule fired: the answer becomes exactly these values — the
   * rule's source codes, mapped — replacing whatever was there. The codes are
   * not required to be options: `set_value` is how a numeric or text answer
   * is written by logic too.
   */
  setValue: (string | number)[] | null;
}

/**
 * What this question's punch rules want ticked, given the current answers
 * (reqs §14–§19).
 *
 * A rule maps source codes to this question's codes — identity by default,
 * which is the `FOR EACH option IN Q5.Selected → punch the matching option`
 * case. Codes this question does not have are dropped or reported, never
 * written: an answer holding a code the option list has never contained is
 * unexportable and unanswerable.
 */
export function resolvePunches(
  q: Question,
  ctx: EvalContext,
): PunchResult {
  const own = new Set(
    [...q.options.map((o) => o.code), ...q.rows.map((r) => r.code)].map(key),
  );
  const select: (string | number)[] = [];
  const deselect: (string | number)[] = [];
  const unmatched: (string | number)[] = [];
  let recomputeAlways = false;
  let clear = false;
  let setValue: (string | number)[] | null = null;

  for (const rule of q.punches ?? []) {
    // show / hide / enable / disable shape the option LIST, not the answer —
    // the option pipeline (carryforward.ts) reads those; see autoPunch.ts
    if (LIST_ACTIONS.has(rule.action)) continue;
    if (rule.when && !evaluateCondition(rule.when, ctx)) continue;
    if (rule.recompute === "always") recomputeAlways = true;

    if (rule.action === "clear") { clear = true; continue; }

    const sourceCodes = evaluateSetExpr(rule.source, ctx, { target: q });
    const map = new Map(rule.mapping.map((m) => [key(m.from), m.to]));

    if (rule.action === "set_value") {
      setValue = sourceCodes.map((c) => (map.has(key(c)) ? map.get(key(c))! : c));
      continue;
    }

    for (const code of sourceCodes) {
      const mapped = map.has(key(code)) ? map.get(key(code))! : code;
      if (!own.has(key(mapped))) {
        if (!rule.ignoreUnmatched) unmatched.push(code);
        continue;
      }
      // rules apply in order: a later rule on the same code wins
      if (rule.action === "deselect") {
        remove(select, mapped);
        deselect.push(mapped);
      } else {
        remove(deselect, mapped);
        select.push(mapped);
      }
    }
  }

  return {
    select: dedupe(select),
    deselect: dedupe(deselect),
    unmatched: dedupe(unmatched),
    recomputeAlways,
    clear,
    setValue,
  };
}

/* =============================================================== parsing */

export interface SetExprError { message: string; position?: number }
export interface SetParseResult {
  expr?: SetExpr;
  errors: SetExprError[];
  warnings: SetExprError[];
}

const SELECTION_WORDS: Record<string, SetSelection> = {
  selected: "selected",
  unselected: "unselected",
  notselected: "unselected",
  all: "all",
  options: "all",
  displayed: "displayed",
  shown: "displayed",
};

const OPERATOR_WORDS: Record<string, SetOperator> = {
  union: "union",
  or: "union",
  intersection: "intersection",
  intersect: "intersection",
  and: "intersection",
  difference: "difference",
  minus: "difference",
  exclude: "difference",
  except: "difference",
};

interface Tok { kind: "ident" | "number" | "punct"; text: string; pos: number }

function tokenize(src: string): { tokens: Tok[]; error?: SetExprError } {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if ("()[],".includes(ch)) {
      tokens.push({ kind: "punct", text: ch, pos: i });
      i += 1;
      continue;
    }
    const num = /^-?\d+(?![A-Za-z0-9_.])/.exec(src.slice(i));
    if (num) {
      tokens.push({ kind: "number", text: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z0-9_$][A-Za-z0-9_$.-]*/.exec(src.slice(i));
    if (ident) {
      tokens.push({ kind: "ident", text: ident[0], pos: i });
      i += ident[0].length;
      continue;
    }
    return { tokens, error: { message: `Unexpected character “${ch}”`, position: i } };
  }
  return { tokens };
}

/**
 * Parse a set expression against a survey. Question references resolve to
 * stable ids, so renaming a question later cannot break a stored mask
 * (req §28).
 */
export function parseSetExpression(def: SurveyDefinition, src: string): SetParseResult {
  const warnings: SetExprError[] = [];
  const { tokens, error } = tokenize(src ?? "");
  if (error) return { errors: [error], warnings };
  if (tokens.length === 0) return { errors: [], warnings };

  let at = 0;
  const bracketed = new WeakSet<object>();
  const peek = (k = 0): Tok | undefined => tokens[at + k];
  const fail: (m: string, pos?: number) => never = (message, pos) => {
    throw { message, position: pos ?? peek()?.pos } as SetExprError;
  };
  const word = (t: Tok | undefined) => (t?.kind === "ident" ? t.text.toLowerCase() : "");

  const readOperator = (): SetOperator | null => {
    const w = word(peek());
    const op = OPERATOR_WORDS[w];
    if (!op) return null;
    at += 1;
    return op;
  };

  const parsePrimary = (): SetExpr => {
    const t = peek();
    if (!t) fail("Expression ended early — expected a question reference");

    if (t!.kind === "punct" && t!.text === "(") {
      at += 1;
      const inner = parseOps();
      const close = peek();
      if (!close || close.kind !== "punct" || close.text !== ")") {
        fail("Missing closing parenthesis", t!.pos);
      }
      at += 1;
      bracketed.add(inner as unknown as object);
      return inner;
    }

    // a literal list of codes
    if (t!.kind === "punct" && t!.text === "[") {
      at += 1;
      const codes: (string | number)[] = [];
      while (peek() && !(peek()!.kind === "punct" && peek()!.text === "]")) {
        const c = peek()!;
        if (c.kind === "punct" && c.text === ",") { at += 1; continue; }
        codes.push(c.kind === "number" ? Number(c.text) : c.text);
        at += 1;
      }
      if (!peek()) fail("Missing closing bracket ]");
      at += 1;
      return { kind: "codes", codes };
    }

    if (word(t) === "not" || word(t) === "complement") {
      at += 1;
      return { kind: "complement", of: parsePrimary() };
    }

    if (t!.kind !== "ident") fail(`Unexpected “${t!.text}”`, t!.pos);

    const segments = t!.text.split(".").filter(Boolean);
    at += 1;
    const q = getQuestionByCodeOrVar(def, segments[0]);
    if (!q) fail(`${segments[0]} does not exist`, t!.pos);
    if (segments.length > 2) {
      fail(`“${t!.text}” has too many parts — use Question.Selected`, t!.pos);
    }
    let selection: SetSelection = "selected";
    if (segments.length === 2) {
      const s = SELECTION_WORDS[segments[1].toLowerCase()];
      if (!s) {
        fail(
          `“${segments[1]}” is not a selection — use Selected, Unselected, Options or Displayed`,
          t!.pos,
        );
      }
      selection = s!;
    }
    return { kind: "ref", questionId: q!.id, selection };
  };

  const parseOps = (): SetExpr => {
    let left = parsePrimary();
    const used = new Set<SetOperator>();
    while (true) {
      const op = readOperator();
      if (!op) break;
      if (!peek()) fail(`Expression ends with ${SET_OPERATOR_LABEL[op]}`);
      const right = parsePrimary();
      used.add(op);
      left = { kind: "op", operator: op, left, right };
    }
    if (used.size > 1 && !bracketed.has(left as unknown as object)) {
      warnings.push({
        message:
          "Set operators are mixed without parentheses — they apply left to right. Add brackets to be explicit.",
      });
    }
    return left;
  };

  try {
    const expr = parseOps();
    if (at < tokens.length) {
      const t = tokens[at];
      fail(
        t.kind === "punct" && t.text === ")"
          ? "Unmatched closing parenthesis"
          : `Unexpected “${t.text}” — is an operator missing?`,
        t.pos,
      );
    }
    return { expr, errors: [], warnings };
  } catch (e) {
    const err = e as SetExprError;
    return { errors: [err?.message ? err : { message: String(e) }], warnings };
  }
}

/* ============================================================ formatting */

const SELECTION_TEXT: Record<SetSelection, string> = {
  selected: "Selected",
  unselected: "Unselected",
  all: "Options",
  displayed: "Displayed",
};

/**
 * Print a set expression. Every nested operation is bracketed, so re-parsing
 * gives back the same tree — the round trip the two mask editors depend on.
 */
export function formatSetExpression(
  def: SurveyDefinition,
  expr: SetExpr | undefined | null,
): string {
  if (!expr) return "";
  const render = (node: SetExpr, top: boolean): string => {
    switch (node.kind) {
      case "codes":
        return `[${node.codes.join(", ")}]`;
      case "ref": {
        const q = getQuestion(def, node.questionId);
        return `${q?.code ?? node.questionId}.${SELECTION_TEXT[node.selection]}`;
      }
      case "complement":
        return `NOT ${render(node.of, false)}`;
      case "op": {
        const body = `${render(node.left, false)} ${SET_OPERATOR_LABEL[node.operator]} ${render(node.right, false)}`;
        return top ? body : `(${body})`;
      }
      default:
        return "";
    }
  };
  return render(expr, true);
}

/** Plain English, for the summary line under the builder. */
export function setExpressionSummary(
  def: SurveyDefinition,
  expr: SetExpr | undefined | null,
): string {
  if (!expr) return "";
  const render = (node: SetExpr): string => {
    switch (node.kind) {
      case "codes":
        return `the options ${node.codes.join(", ")}`;
      case "ref": {
        const q = getQuestion(def, node.questionId);
        const name = q?.code ?? node.questionId;
        return node.selection === "selected" ? `what ${name} selected`
          : node.selection === "unselected" ? `what ${name} did not select`
            : node.selection === "displayed" ? `what ${name} displayed`
              : `every option in ${name}`;
      }
      case "complement":
        return `everything except ${render(node.of)}`;
      case "op": {
        const joiner = node.operator === "union" ? "or"
          : node.operator === "intersection" ? "and also" : "but not";
        return `(${render(node.left)} ${joiner} ${render(node.right)})`;
      }
      default:
        return "";
    }
  };
  return render(expr);
}

/* ============================================================== analysis */

/** Every question a set expression reads — for cycle detection (req §31). */
export function setExprSources(expr: SetExpr | undefined | null, into = new Set<string>()): Set<string> {
  if (!expr) return into;
  if (expr.kind === "ref") into.add(expr.questionId);
  if (expr.kind === "complement") setExprSources(expr.of, into);
  if (expr.kind === "op") {
    setExprSources(expr.left, into);
    setExprSources(expr.right, into);
  }
  return into;
}

export interface SetExprIssue { level: "error" | "warning"; message: string }

/**
 * Problems a mask can carry (req §31). A question masking itself is the one
 * that matters: `Q5` reading `Q5.Selected` to decide what `Q5` shows cannot
 * settle, so it is refused rather than left to the runtime's re-entrancy
 * guard.
 */
export function validateSetExpr(
  def: SurveyDefinition,
  ownerId: string,
  expr: SetExpr | undefined | null,
): SetExprIssue[] {
  const issues: SetExprIssue[] = [];
  if (!expr) return issues;

  const sources = setExprSources(expr);
  if (sources.has(ownerId)) {
    const q = getQuestion(def, ownerId);
    issues.push({
      level: "error",
      message: `${q?.code ?? ownerId} cannot mask itself — the list it shows would depend on the list it shows.`,
    });
  }
  for (const id of sources) {
    if (!def.questions.some((q) => q.id === id)) {
      issues.push({ level: "error", message: `A source question no longer exists (${id}).` });
    }
  }
  const empty = (node: SetExpr): boolean =>
    node.kind === "codes" ? node.codes.length === 0
      : node.kind === "op" ? empty(node.left) && empty(node.right)
        : node.kind === "complement" ? empty(node.of)
          : false;
  if (empty(expr)) {
    issues.push({ level: "warning", message: "This mask has nothing in it, so it selects no options." });
  }
  return issues;
}

/* ------------------------------------------------- from the flat pipeline */

/**
 * Read an existing sequential pipeline as a set tree, when it is made only of
 * set steps.
 *
 * This is what lets the mask builder open a survey that was built with the
 * older pipeline: the steps are folded left to right, which is exactly how
 * they already execute, so the tree means what the pipeline meant. A pipeline
 * containing sort / randomize / prioritize / filter is NOT a set expression
 * and returns null — those questions keep using the pipeline, untouched.
 */
export function pipelineToSetExpr(q: Question): SetExpr | null {
  const ops = q.optionPipeline ?? [];
  if (ops.length === 0) return null;

  const SET_KINDS: Record<string, SetOperator | "start" | "remaining"> = {
    carry_forward: "start",
    union: "union",
    intersect: "intersection",
    difference: "difference",
    exclude: "difference",
    remaining: "remaining",
  };

  let expr: SetExpr | null = null;
  for (const op of ops) {
    const mapped = SET_KINDS[op.kind];
    if (!mapped) return null;                 // a presentation step — not a set
    if (op.when) return null;                 // conditional steps do not fold
    const sources = op.sources ?? [];
    if (sources.length === 0) return null;

    const asExpr = (i: number): SetExpr => ({
      kind: "ref",
      questionId: sources[i].questionId,
      selection: sources[i].which === "not_selected" ? "unselected"
        : sources[i].which === "all" ? "all"
          : sources[i].which === "displayed" ? "displayed" : "selected",
    });
    let right: SetExpr = asExpr(0);
    for (let i = 1; i < sources.length; i++) {
      // several sources in one step behave as a union of them
      right = { kind: "op", operator: "union", left: right, right: asExpr(i) };
    }

    if (mapped === "start") {
      expr = op.keepOwn && expr ? { kind: "op", operator: "union", left: expr, right } : right;
      continue;
    }
    if (mapped === "remaining") {
      expr = expr
        ? { kind: "op", operator: "difference", left: expr, right }
        : { kind: "complement", of: right };
      continue;
    }
    if (!expr) { expr = right; continue; }
    expr = { kind: "op", operator: mapped, left: expr, right };
  }
  return expr;
}

/* ============================================== applying punches at runtime */

/**
 * Fill in a question's punched options, if it has any.
 *
 * Returns the value written, or null when nothing was. A `once` rule — the
 * default — only fills a question the respondent has not answered, so going
 * back and forward never overwrites an edit they made. `always` recomputes on
 * every visit, which is what a derived question wants.
 */
export function applyPunches(
  q: Question,
  ctx: EvalContext,
  answerKeyFor: (q: Question) => string,
): { key: string; value: unknown } | null {
  if (!q.punches?.length) return null;

  const result = resolvePunches(q, ctx);
  const nothing = result.select.length === 0 && result.deselect.length === 0 && !result.clear && !result.setValue;
  if (nothing) return null;

  const key = answerKeyFor(q);
  let existing: unknown = ctx.state.answers[key];
  const answered = existing !== undefined;
  if (answered && !result.recomputeAlways) return null;

  const multi = Array.isArray(existing) || isMultiValued(q);

  // `set_value` replaces the answer outright; `clear` empties it. Either may
  // be followed by selects in the same pass, which then apply on top.
  if (result.setValue) {
    const v: unknown = multi ? result.setValue : result.setValue[0];
    ctx.state.answers[key] = v as AnswerValue;
    existing = v;
    if (result.select.length === 0 && result.deselect.length === 0) return { key, value: v };
  } else if (result.clear) {
    delete ctx.state.answers[key];
    existing = undefined;
    if (result.select.length === 0) return { key, value: undefined };
  }

  if (multi) {
    // punching only ever targets choice questions, whose arrays hold codes
    const current: (string | number)[] = Array.isArray(existing) ? ([...existing] as (string | number)[]) : [];
    const drop = new Set(result.deselect.map(key0));
    const next = [
      ...current.filter((c) => !drop.has(key0(c as string | number))),
      ...result.select.filter(
        (c) => !current.some((x) => key0(x as string | number) === key0(c)),
      ),
    ];
    ctx.state.answers[key] = next;
    return { key, value: next };
  }

  // a single-answer question takes the first punched code
  if (result.select.length === 0) return null;
  ctx.state.answers[key] = result.select[0];
  return { key, value: result.select[0] };
}

const key0 = (c: string | number) => String(c);

function remove(list: (string | number)[], code: string | number): void {
  for (let i = list.length - 1; i >= 0; i--) if (String(list[i]) === String(code)) list.splice(i, 1);
}

/** Whether a question holds several codes at once. */
function isMultiValued(q: Question): boolean {
  return [
    "multi_select", "multi_dropdown", "checkbox", "ranking", "image_ranking",
    "image_multi", "max_diff",
  ].includes(q.type);
}

/**
 * Punch every question on a page that asks for it. Called once per navigation
 * by the flow interpreter, never during render.
 */
export function prefillQuestions(
  questions: Question[],
  ctx: EvalContext,
  answerKeyFor: (q: Question) => string,
): string[] {
  const filled: string[] = [];
  for (const q of questions) {
    const done = applyPunches(q, ctx, answerKeyFor);
    if (done) filled.push(q.id);
  }
  return filled;
}

/* ==================================================== editing helpers */

export interface SetChain {
  /** The operands, left to right. */
  items: SetExpr[];
  /** `ops[i]` joins `items[i]` to `items[i + 1]`. */
  ops: SetOperator[];
}

/**
 * Read a left-associated tree as a flat chain — `((A ∪ B) \ C)` becomes
 * `A ∪ B \ C` with two operators.
 *
 * This is what lets the visual builder show one row per set with an operator
 * between them, the same idiom the logic builder uses, while the STORED form
 * stays a tree. A tree that nests on the right (`A ∪ (B ∩ C)`) is not a chain;
 * its right-hand side renders as a bracket card of its own.
 */
export function setExprToChain(expr: SetExpr): SetChain {
  const items: SetExpr[] = [];
  const ops: SetOperator[] = [];
  const walk = (node: SetExpr) => {
    if (node.kind === "op") {
      walk(node.left);
      ops.push(node.operator);
      items.push(node.right);
      return;
    }
    items.push(node);
  };
  // only the LEFT spine flattens; anything else is a single item
  if (expr.kind === "op") walk(expr);
  else items.push(expr);
  return { items, ops };
}

/** Rebuild a left-associated tree from a chain. */
export function chainToSetExpr(chain: SetChain): SetExpr | null {
  if (chain.items.length === 0) return null;
  let expr = chain.items[0];
  for (let i = 1; i < chain.items.length; i++) {
    expr = {
      kind: "op",
      operator: chain.ops[i - 1] ?? "union",
      left: expr,
      right: chain.items[i],
    };
  }
  return expr;
}

/** Append a set to the end of a chain. */
export function appendSet(
  expr: SetExpr | undefined | null,
  item: SetExpr,
  operator: SetOperator = "union",
): SetExpr {
  if (!expr) return item;
  const chain = setExprToChain(expr);
  chain.items.push(item);
  chain.ops.push(operator);
  return chainToSetExpr(chain)!;
}

/** Replace the item at `index` of a chain. */
export function replaceSetAt(expr: SetExpr, index: number, item: SetExpr): SetExpr {
  const chain = setExprToChain(expr);
  if (!chain.items[index]) return expr;
  chain.items[index] = item;
  return chainToSetExpr(chain)!;
}

/** Remove the item at `index`; the operator that joined it goes too. */
export function removeSetAt(expr: SetExpr, index: number): SetExpr | null {
  const chain = setExprToChain(expr);
  if (!chain.items[index]) return expr;
  chain.items.splice(index, 1);
  chain.ops.splice(Math.max(0, index - 1), 1);
  return chainToSetExpr(chain);
}

/** Change the operator in one gap. Nothing else in the tree moves. */
export function setChainOperator(expr: SetExpr, gapIndex: number, operator: SetOperator): SetExpr {
  const chain = setExprToChain(expr);
  if (gapIndex < 0 || gapIndex >= chain.ops.length) return expr;
  chain.ops[gapIndex] = operator;
  return chainToSetExpr(chain)!;
}

/**
 * Bracket two adjacent items, so `A ∪ B \ C` can become `A ∪ (B \ C)` — the
 * gesture that makes the right-hand nesting a chain cannot express.
 */
export function bracketSetPair(expr: SetExpr, index: number): SetExpr {
  const chain = setExprToChain(expr);
  if (index < 0 || index + 1 >= chain.items.length) return expr;
  const operator = chain.ops[index] ?? "union";
  const pair: SetExpr = {
    kind: "op",
    operator,
    left: chain.items[index],
    right: chain.items[index + 1],
  };
  chain.items.splice(index, 2, pair);
  chain.ops.splice(index, 1);
  return chainToSetExpr(chain)!;
}
