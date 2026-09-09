import type {
  SetExpr, SetOperator, SetSelection, SurveyDefinition, Question, PunchRule, ListFill,
} from "@rescript/schema";
import { SET_OPERATOR_LABEL, isMultiValuedQuestion } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import { codesFrom, effectiveQuestion } from "./carryforward.js";
import {
  getQuestion, getQuestionByCodeOrVar, findLoopScope, loopValue,
  type AnswerValue, type ResponseState,
} from "./state.js";
import { activePunchRules } from "./punchChain.js";
import { listFillLoopItems } from "./listFill.js";
import { loopNodes, questionIdsInLoop } from "./loopModel.js";
import { safeExpression } from "./calcContext.js";
import { validateExpression } from "./calc.js";
import { referencedNames } from "./embedded.js";
import { orderPunchRules } from "@rescript/schema";

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
/**
 * The full set a complement (`NOT(...)`) is taken against: the question's
 * EFFECTIVE, carry-forward resolved rows/options — not the static schema
 * arrays, which for a carry-forward question are empty and previously made
 * every `NOT(...)` mask against one evaluate to nothing.
 */
function universe(target: Question | undefined, ctx: EvalContext): (string | number)[] {
  if (!target) return [];
  const view = effectiveQuestion(target, ctx);
  return view.rows.length > 0 && view.options.length === 0
    ? view.rows.map((r) => r.code)
    : view.options.map((o) => o.code);
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

    case "listFill": {
      /*
       * Read, never decided — the exact same reader a Loop already uses for
       * `source.kind: "listFill"` (`listFillLoopItems`). A mask evaluates on
       * every render; re-deciding the List Fill here would give the
       * respondent a different list each time and consume sample capacity
       * repeatedly, so this only ever looks at what was already allocated
       * (empty until then, which composes correctly with `onEmptySource`).
       */
      return dedupe(listFillLoopItems(ctx.def, ctx.state, expr.listFillId).map((it) => it.code));
    }

    case "loopItem": {
      /*
       * The current loop item as a PAYLOAD, not a trigger — resolved by the
       * exact `findLoopScope`/`loopValue` pair the condition engine uses for
       * `CURRENT_ITEM`/`CURRENT_ITEM.<ref>` (`evaluate.ts`'s `kind: "loop"`
       * case), so "the current item" can never mean two different things
       * depending on whether it gates a rule or fills one. Outside a loop, or
       * a reference the loop does not declare, this is empty — never a guess.
       */
      const loop = findLoopScope(ctx.loop, null);
      if (!loop) return [];
      const v = loopValue(loop, expr.ref || "code");
      return v == null ? [] : [v as string | number];
    }

    case "expr": {
      /*
       * A calculated value as a payload (§8, §17) — the same
       * `evaluateExpression` a calculation and the condition `expr` source
       * already run, through the same resolver (`safeExpression`), so a
       * function calc already has works as a punch value from day one. Never
       * throws: a broken expression punches nothing rather than crashing the
       * page.
       */
      const v = safeExpression(expr.expression, ctx.def, ctx.state);
      return v == null || v === "" ? [] : [v as string | number];
    }

    case "complement": {
      const inside = new Set(evaluateSetExpr(expr.of, ctx, opts).map(key));
      return universe(opts.target, ctx).filter((c) => !inside.has(key(c)));
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
  /**
   * Cell-targeted writes — one entry per distinct `targetRow`/`targetColumn`
   * a rule addressed. `applyPunches` writes each of these into its own row
   * (matrix) or row+column (composite grid) slot of the target's answer,
   * completely independently of the whole-answer fields above, which is what
   * makes a matrix cell punch safe: it can never overwrite a sibling row's
   * value or replace the whole per-row answer object with a bare code.
   */
  cells: PunchCellWrite[];
}

export interface PunchCellWrite {
  row: string | number;
  /** Present only for a composite/custom-table cell; absent for a plain matrix row. */
  column?: string;
  select: (string | number)[];
  deselect: (string | number)[];
  clear: boolean;
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
/**
 * Rules in the order `resolvePunches` should APPLY them so that, per target
 * code, the last one applied wins — the mechanism every rule's select/
 * deselect/set_value already relies on. Ascending priority (lowest first,
 * highest last) makes the highest-priority rule the one that wins a
 * conflict, exactly as `PunchRule.priority` documents; equal priority (the
 * default, 0, for every rule that predates this field) is a stable no-op
 * re-sort, so an existing survey with no priority set anywhere keeps its
 * exact current behavior (original array order, last one wins ties).
 *
 * This is deliberately the reverse of `orderPunchRules` (schema), which
 * sorts highest-first for DISPLAY — "the important rule at the top of the
 * list" — a different, unrelated ordering need.
 */
function byApplicationOrder<T extends { priority?: number }>(rules: T[]): T[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => (a.rule.priority ?? 0) - (b.rule.priority ?? 0) || a.index - b.index)
    .map((x) => x.rule);
}

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

  // Cell-targeted rules (`targetRow` set) write into their own row, or
  // row+column for a composite/custom-table cell, instead of the question's
  // whole answer — grouped by that address so two rules on the SAME cell
  // still combine with the identical last-wins mechanic as the whole-answer
  // path below, while rules on DIFFERENT cells can never collide. This is
  // the fix for the matrix/composite scalar-overwrite bug: a cell write
  // never touches `select`/`deselect`/`setValue` above, so `applyPunches`
  // can never mistake a per-row answer object for a bare code to overwrite.
  const cellMap = new Map<string, PunchCellWrite>();
  const cellFor = (row: string | number, column?: string): PunchCellWrite => {
    const k = column !== undefined ? `${key(row)}::${column}` : key(row);
    let c = cellMap.get(k);
    if (!c) {
      c = { row, column, select: [], deselect: [], clear: false, setValue: null };
      cellMap.set(k, c);
    }
    return c;
  };

  /*
   * IF / ELSE IF / ELSE (§8, §23), resolved before anything is applied.
   *
   * The chain is walked over the ANSWER-side rules only. A list action
   * (show/hide/enable/disable) belongs to the option pipeline and is chained
   * there, on its own list — mixing the two would let a `hide` rule satisfy
   * an `else` that a `select` rule was waiting for, and the two lists are not
   * even evaluated at the same point in the run.
   *
   * `walkPunchChain` calls the predicate only for rules it REACHES, so a
   * branch the chain has already settled is not evaluated at all. Ordering
   * by priority happens BEFORE chaining, not after: a chain's members share
   * the default priority in every survey that doesn't use this field, so a
   * stable sort leaves every chain exactly as authored (see
   * `byApplicationOrder`) — priority is for INDEPENDENT rules, per the
   * schema's own doc comment on `PunchRule.priority`.
   */
  const answerRules = byApplicationOrder(
    (q.punches ?? []).filter((r) => !LIST_ACTIONS.has(r.action)),
  );
  for (const rule of activePunchRules(answerRules, (r) => evaluateCondition(r.when, ctx))) {
    if (rule.recompute === "always") recomputeAlways = true;

    const cellTarget = rule.targetRow !== undefined;
    // The row (and, for a composite cell, the column) must actually exist on
    // the target question — an address that doesn't resolve is a validation
    // problem (see `validatePunchRule`), not a silent write to `existing[0]`
    // or similar. Every source code is reported unmatched instead.
    const rowExists = !cellTarget || q.rows.some((r) => key(r.code) === key(rule.targetRow!));
    const column = rule.targetColumn ? q.columns.find((c) => c.id === rule.targetColumn) : undefined;
    const columnExists = !rule.targetColumn || !!column;
    if (cellTarget && (!rowExists || !columnExists)) {
      if (!rule.ignoreUnmatched) {
        unmatched.push(...evaluateSetExpr(rule.source, ctx, { target: q }));
      }
      continue;
    }

    // The codes this write may land on: the addressed column's own options
    // for a composite cell, the shared row scale (`q.options`) for a plain
    // matrix row, or — a numeric/text cell with no option list — anything
    // (`null` below), matched unconditionally like `set_value` already is
    // for a non-cell numeric/text target.
    const cellOwn: Set<string> | null = !cellTarget
      ? null
      : column
        ? (column.options.length > 0 ? new Set(column.options.map((o) => key(o.code))) : null)
        : (q.options.length > 0 ? new Set(q.options.map((o) => key(o.code))) : null);

    if (rule.action === "clear") {
      if (cellTarget) cellFor(rule.targetRow!, rule.targetColumn).clear = true;
      else clear = true;
      continue;
    }

    const sourceCodes = evaluateSetExpr(rule.source, ctx, { target: q });
    const map = new Map(rule.mapping.map((m) => [key(m.from), m.to]));

    if (rule.action === "set_value") {
      const values = sourceCodes.map((c) => (map.has(key(c)) ? map.get(key(c))! : c));
      if (cellTarget) cellFor(rule.targetRow!, rule.targetColumn).setValue = values;
      else setValue = values;
      continue;
    }

    for (const code of sourceCodes) {
      const mapped = map.has(key(code)) ? map.get(key(code))! : code;
      const matches = cellTarget ? (cellOwn === null || cellOwn.has(key(mapped))) : own.has(key(mapped));
      if (!matches) {
        if (!rule.ignoreUnmatched) unmatched.push(code);
        continue;
      }
      // rules apply in order: a later rule on the same code (or cell) wins
      if (cellTarget) {
        const cell = cellFor(rule.targetRow!, rule.targetColumn);
        if (rule.action === "deselect") {
          remove(cell.select, mapped);
          cell.deselect.push(mapped);
        } else {
          remove(cell.deselect, mapped);
          cell.select.push(mapped);
        }
      } else if (rule.action === "deselect") {
        remove(select, mapped);
        deselect.push(mapped);
      } else {
        remove(deselect, mapped);
        select.push(mapped);
      }
    }
  }

  for (const cell of cellMap.values()) {
    cell.select = dedupe(cell.select);
    cell.deselect = dedupe(cell.deselect);
  }

  return {
    select: dedupe(select),
    deselect: dedupe(deselect),
    unmatched: dedupe(unmatched),
    recomputeAlways,
    clear,
    setValue,
    cells: [...cellMap.values()],
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

/** A List Fill by stable id, or by name (case-insensitively) for the text DSL. */
function findListFillByRef(def: SurveyDefinition, ref: string): ListFill | undefined {
  return (
    def.listFills.find((lf) => lf.id === ref) ??
    def.listFills.find((lf) => (lf.name ?? lf.id).toLowerCase() === ref.toLowerCase())
  );
}

interface Tok { kind: "ident" | "number" | "punct" | "exprBody"; text: string; pos: number }

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

      /*
       * EXPR(...) carries a DIFFERENT language inside its parentheses — the
       * calc engine's (`+`, `>`, quoted text, function calls) — none of which
       * this tokenizer's own character set accepts. Once the identifier
       * "expr" is immediately followed by "(" (whitespace allowed between),
       * the whole balanced-paren span is captured as one opaque `exprBody`
       * token instead of being re-tokenized character by character here, so
       * `EXPR(SUM(Q1, Q2) + 5 > 10)` never hits "Unexpected character '+'"
       * before parsing even starts.
       */
      if (ident[0].toLowerCase() === "expr") {
        let k = i;
        while (k < src.length && /\s/.test(src[k])) k += 1;
        if (src[k] === "(") {
          const openPos = k;
          let depth = 0;
          let j = k;
          for (; j < src.length; j++) {
            if (src[j] === "(") depth += 1;
            else if (src[j] === ")") { depth -= 1; if (depth === 0) break; }
          }
          if (depth !== 0) {
            return {
              tokens,
              error: { message: "EXPR(...) is missing its closing parenthesis", position: openPos },
            };
          }
          tokens.push({ kind: "punct", text: "(", pos: openPos });
          tokens.push({ kind: "exprBody", text: src.slice(openPos + 1, j), pos: openPos + 1 });
          tokens.push({ kind: "punct", text: ")", pos: j });
          i = j + 1;
        }
      }
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

    if (word(t) === "listfill") {
      const start = t!;
      at += 1;
      const open = peek();
      if (!open || open.kind !== "punct" || open.text !== "(") {
        fail("LISTFILL needs a name in parentheses, e.g. LISTFILL(brands)", start.pos);
      }
      at += 1;
      const nameTok = peek();
      if (!nameTok || nameTok.kind !== "ident") {
        fail("LISTFILL(...) needs a List Fill name or id", open!.pos);
      }
      at += 1;
      const close = peek();
      if (!close || close.kind !== "punct" || close.text !== ")") {
        fail("Missing closing parenthesis", nameTok!.pos);
      }
      at += 1;
      const lf = findListFillByRef(def, nameTok!.text);
      if (!lf) fail(`“${nameTok!.text}” is not a List Fill on this survey`, nameTok!.pos);
      return { kind: "listFill", listFillId: lf!.id };
    }

    if (word(t) === "expr") {
      const start = t!;
      at += 1;
      const open = peek();
      if (!open || open.kind !== "punct" || open.text !== "(") {
        fail("EXPR needs a calculation in parentheses, e.g. EXPR(SUM(Q1, Q2))", start.pos);
      }
      at += 1;
      const body = peek();
      if (!body || body.kind !== "exprBody") {
        fail("EXPR(...) needs a calculation expression inside the parentheses", open!.pos);
      }
      at += 1;
      const close = peek();
      if (!close || close.kind !== "punct" || close.text !== ")") {
        fail("Missing closing parenthesis", open!.pos);
      }
      at += 1;
      const expression = body!.text.trim();
      if (!expression) fail("EXPR(...) needs a calculation expression inside the parentheses", open!.pos);
      const exprErr = validateExpression(expression);
      if (exprErr) fail(`Invalid expression inside EXPR(...): ${exprErr}`, open!.pos);
      return { kind: "expr", expression };
    }

    if (t!.kind === "ident") {
      const segs = t!.text.split(".").filter(Boolean);
      const head = segs[0]?.toLowerCase();
      if (head === "current_item" || head === "current_item_code") {
        at += 1;
        if (segs.length > 2) fail(`“${t!.text}” has too many parts — use CURRENT_ITEM.<reference>`, t!.pos);
        if (head === "current_item_code" && segs.length > 1) {
          fail(`CURRENT_ITEM_CODE does not take a reference — use CURRENT_ITEM.${segs[1]} instead`, t!.pos);
        }
        return { kind: "loopItem", ref: head === "current_item_code" ? null : (segs[1] ?? null) };
      }
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
      case "listFill": {
        const lf = def.listFills.find((l) => l.id === node.listFillId);
        return `LISTFILL(${lf?.name ?? node.listFillId})`;
      }
      case "loopItem":
        return node.ref ? `CURRENT_ITEM.${node.ref}` : "CURRENT_ITEM_CODE";
      case "expr":
        // Prints for readability; a calc expression's own syntax (+, >, quoted
        // text, …) is outside this tokenizer's grammar, so this form is
        // display-only — edit it back via the Visual builder, not by retyping
        // the printed text (the brief's own "where it can be parsed safely").
        return `EXPR(${node.expression})`;
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
      case "listFill": {
        const lf = def.listFills.find((l) => l.id === node.listFillId);
        return `what ${lf?.name ?? node.listFillId} allocated`;
      }
      case "loopItem":
        return node.ref ? `the current item's ${node.ref}` : "the current loop item";
      case "expr":
        return `the calculated value of "${node.expression}"`;
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

/**
 * Every question a set expression reads — for cycle detection (req §31).
 *
 * `def` is optional and only needed to bridge a `listFill` node to the
 * question that feeds it (a mask on `LISTFILL(lf1)` depends on whatever `lf1`
 * itself reads), so every existing call site that has no survey handy keeps
 * compiling unchanged and simply does not see through the list fill.
 */
export function setExprSources(
  expr: SetExpr | undefined | null,
  into = new Set<string>(),
  def?: SurveyDefinition,
): Set<string> {
  if (!expr) return into;
  if (expr.kind === "ref") into.add(expr.questionId);
  if (expr.kind === "listFill" && def) {
    const lf = def.listFills.find((l) => l.id === expr.listFillId);
    if (lf?.source.kind === "question") into.add(lf.source.questionId);
  }
  // `expr` reads whatever names its calc expression references — resolving
  // them here (same as `calcReads` does for a calc variable's own
  // dependencies) lets `validateSetExpr`'s self-mask check and the dependency
  // graph both see through a calculated punch payload, not just a literal
  // question reference.
  if (expr.kind === "expr" && def) {
    for (const name of referencedNames(expr.expression)) {
      const q = getQuestionByCodeOrVar(def, name);
      if (q) into.add(q.id);
    }
  }
  if (expr.kind === "complement") setExprSources(expr.of, into, def);
  if (expr.kind === "op") {
    setExprSources(expr.left, into, def);
    setExprSources(expr.right, into, def);
  }
  return into;
}

/** Every List Fill id a set expression reads directly (for validation/UI, not cycle detection). */
export function setExprListFillIds(expr: SetExpr | undefined | null, into = new Set<string>()): Set<string> {
  if (!expr) return into;
  if (expr.kind === "listFill") into.add(expr.listFillId);
  if (expr.kind === "complement") setExprListFillIds(expr.of, into);
  if (expr.kind === "op") {
    setExprListFillIds(expr.left, into);
    setExprListFillIds(expr.right, into);
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

  const sources = setExprSources(expr, new Set<string>(), def);
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
  for (const lfId of setExprListFillIds(expr)) {
    if (!def.listFills.some((lf) => lf.id === lfId)) {
      issues.push({ level: "error", message: `A source List Fill no longer exists (${lfId}).` });
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

  // `expr`/`loopItem` leaves (the calc-value and current-loop-item payloads):
  // a bad expression or a loop reference with nowhere to run is a design-time
  // mistake worth flagging now, not a silent `null`/`undefined` at runtime.
  const ownerInLoop = loopNodes(def).some((info) => questionIdsInLoop(info.node).includes(ownerId));
  const walk = (node: SetExpr): void => {
    if (node.kind === "expr") {
      const err = validateExpression(node.expression);
      if (err) issues.push({ level: "error", message: `Invalid expression "${node.expression}": ${err}` });
    } else if (node.kind === "loopItem" && !ownerInLoop) {
      issues.push({
        level: "warning",
        message: node.ref
          ? `CURRENT_ITEM.${node.ref} is only meaningful inside a loop — this question is not in one.`
          : "CURRENT_ITEM_CODE is only meaningful inside a loop — this question is not in one.",
      });
    } else if (node.kind === "complement") {
      walk(node.of);
    } else if (node.kind === "op") {
      walk(node.left);
      walk(node.right);
    }
  };
  walk(expr);

  return issues;
}

/* ================================================== masking variables §35 */

/** Which field on `Question` a mask target reads/writes — one engine, three dimensions. */
export type MaskTarget = "mask" | "rowMask" | "columnMask";

const MASK_TARGET_SUFFIX: Record<MaskTarget, string> = {
  mask: "",
  rowMask: "_ROWS",
  columnMask: "_COLS",
};

/**
 * `MASK_<CODE>_COUNT` / `_LIST` / `_ITEM_<n>` / `_SOURCE` / `_OPERATION` (§35),
 * named and shaped the same way `listFillVariables` already exposes
 * `LISTFILL_<NAME>_*` — a survey programmer who has used one recognizes the
 * other immediately, and both land in `state.calculated` through the same
 * `Object.assign` in `runCalculations` (`flow.ts`).
 *
 * `items` is whatever `effectiveQuestion` already resolved for this
 * dimension — the exact list the respondent sees — so these variables can
 * never disagree with what actually rendered.
 */
export function maskVariables(
  def: SurveyDefinition,
  q: Question,
  target: MaskTarget,
  items: { code: string | number; label: string }[],
): Record<string, string | number> {
  const mask = q[target];
  if (!mask) return {};
  const key = `MASK_${String(q.code ?? q.id).toUpperCase()}${MASK_TARGET_SUFFIX[target]}`;
  const out: Record<string, string | number> = {
    [`${key}_COUNT`]: items.length,
    [`${key}_LIST`]: items.map((i) => String(i.code)).join(","),
    [`${key}_SOURCE`]: formatSetExpression(def, mask.expr),
    [`${key}_OPERATION`]: mask.action,
  };
  items.forEach((it, i) => { out[`${key}_ITEM_${i + 1}`] = it.code; });
  return out;
}

/**
 * Every masked, non-loop-scoped question's variables, merged in one call
 * (used by `runCalculations`). A question inside a loop is skipped here —
 * its options/rows/columns are still masked correctly for rendering, but a
 * per-iteration `MASK_*` naming scheme is a further decision the brief
 * leaves open ("where possible"), so it is left unbuilt rather than shipped
 * half-specified.
 */
export function maskingVariablesFor(def: SurveyDefinition, state: ResponseState): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const ctx: EvalContext = { def, state };
  for (const q of def.questions) {
    if (!q.mask && !q.rowMask && !q.columnMask) continue;
    if (isInsideLoop(def, q.id)) continue;
    const view = effectiveQuestion(q, ctx);
    if (q.mask) Object.assign(out, maskVariables(def, q, "mask", view.options));
    if (q.rowMask) Object.assign(out, maskVariables(def, q, "rowMask", view.rows));
    if (q.columnMask) {
      Object.assign(out, maskVariables(def, q, "columnMask", view.columns.map((c) => ({ code: c.id, label: c.label }))));
    }
  }
  return out;
}

/** Whether a question is reached inside any loop node — reuses the same
 *  loop/question map `LOOP_*` variable generation already builds. */
function isInsideLoop(def: SurveyDefinition, questionId: string): boolean {
  return loopNodes(def).some(({ node }) => questionIdsInLoop(node).includes(questionId));
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
  const nothingFlat =
    result.select.length === 0 && result.deselect.length === 0 && !result.clear && !result.setValue;
  if (nothingFlat && result.cells.length === 0) return null;

  const key = answerKeyFor(q);
  const original: unknown = ctx.state.answers[key];
  let wroteCell = false;

  /*
   * CELL-TARGETED WRITES (`targetRow`/`targetColumn`) — read and write one
   * row, or one row+column of a composite grid, at a time. This is the fix
   * for the confirmed bug: the old code path below writes `existing` itself,
   * which for a matrix/composite answer (`Record<rowCode, value>`) meant a
   * `select` action REPLACED THE WHOLE PER-ROW ANSWER OBJECT with one bare
   * code. Every cell here is read from, and written back into, a shallow
   * copy of the existing per-row object, so a rule on "Apple" can never
   * touch "Banana", and a composite cell write never overwrites its row's
   * other columns.
   */
  if (result.cells.length > 0) {
    const base: Record<string, unknown> =
      original && typeof original === "object" && !Array.isArray(original)
        ? { ...(original as Record<string, unknown>) }
        : {};
    for (const cell of result.cells) {
      const rowKey = String(cell.row);
      const rowVal = base[rowKey];
      const isRowObject = rowVal !== null && typeof rowVal === "object" && !Array.isArray(rowVal);
      const cellAnswered = cell.column
        ? isRowObject && (rowVal as Record<string, unknown>)[cell.column] !== undefined
        : rowVal !== undefined;
      if (cellAnswered && !result.recomputeAlways) continue;

      if (cell.column) {
        // one column of a composite/custom-table row — never disturbs the
        // row's other columns.
        const rowObj: Record<string, unknown> = isRowObject ? { ...(rowVal as Record<string, unknown>) } : {};
        if (cell.setValue) {
          rowObj[cell.column] = cell.setValue.length > 1 ? cell.setValue : cell.setValue[0];
        } else if (cell.clear) {
          delete rowObj[cell.column];
        } else {
          for (const c of cell.deselect) {
            if (String(rowObj[cell.column]) === key0(c)) delete rowObj[cell.column];
          }
          if (cell.select.length) rowObj[cell.column] = cell.select[cell.select.length - 1];
        }
        base[rowKey] = rowObj;
      } else {
        // a plain matrix row — the row holds one scale value unless the
        // question's own type is multi-valued per row.
        if (cell.setValue) {
          base[rowKey] = isMultiValued(q) ? cell.setValue : cell.setValue[0];
        } else if (cell.clear) {
          delete base[rowKey];
        } else if (isMultiValued(q)) {
          const current: (string | number)[] = Array.isArray(rowVal) ? [...(rowVal as (string | number)[])] : [];
          const drop = new Set(cell.deselect.map(key0));
          base[rowKey] = [
            ...current.filter((c) => !drop.has(key0(c))),
            ...cell.select.filter((c) => !current.some((x) => key0(x) === key0(c))),
          ];
        } else if (cell.select.length) {
          base[rowKey] = cell.select[cell.select.length - 1];
        } else if (cell.deselect.some((c) => key0(c) === String(rowVal))) {
          delete base[rowKey];
        }
      }
      wroteCell = true;
    }
    if (wroteCell) {
      ctx.state.answers[key] = base as AnswerValue;
    }
  }

  // WHOLE-ANSWER PATH — exactly the original behavior for every rule with no
  // `targetRow`/`targetColumn`; a target that mixes cell and whole-answer
  // rules is unusual, but the "answered" gate below is judged against the
  // answer as it stood BEFORE this call (not after any cell write above),
  // so the two paths can never see each other's writes as "already answered".
  if (nothingFlat) {
    return wroteCell ? { key, value: ctx.state.answers[key] } : null;
  }

  let existing: unknown = original;
  const answered = existing !== undefined;
  if (answered && !result.recomputeAlways) {
    return wroteCell ? { key, value: ctx.state.answers[key] } : null;
  }

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

/**
 * Whether a question holds several codes at once.
 *
 * Delegates to the schema's response model rather than keeping a list here.
 * The list this replaced named three types that do not exist (`checkbox`,
 * `image_multi`, `max_diff`) and omitted `image_select`, whose multiple-choice
 * variant does store an array — so punching one took the single-answer branch
 * and replaced the respondent's whole selection with one code.
 */
function isMultiValued(q: Question): boolean {
  return isMultiValuedQuestion(q);
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
