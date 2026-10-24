"use client";
import React from "react";
import type { Condition, ConditionGroup, ConditionRule, ComparisonOperator, Question, SurveyDefinition } from "@rescript/schema";
import {
  VALUELESS_OPERATORS,
  TWO_VALUE_OPERATORS,
  LIST_VALUE_OPERATORS,
  isOptionValueRef,
  isQuestionValueRef,
  isPipedValueRef,
} from "@rescript/schema";
import {
  operatorsForQuestion, choiceDisplayText, conditionSummary, embeddedCatalog, authoringQuestionView,
  gridAxes, authoringValueChoicesFor, describeReference,
  isCategoricalGrid, normalizeGridRule, gridCellOperators, isCellOperator, isDisplayOperator, withGridOperator,
  type LogicPath,
  editableCondition, canonicalCondition, pathKey, appendTo, replaceAt, removeAt,
  duplicateAt, setOperatorAt, groupSelection, ungroupAt, canUngroup, validateLogicTree,
  OPERATOR_LABEL, OPERATOR_HINT, setGroupConnector, listFillVariableNames,
  stripHtmlText,
  operatorMenu, entryForRule, applyOperatorEntry, operatorStatus, ruleSentence, conditionSentence,
  conditionTestInputs, evaluateWithTestInputs, containsMatchesItems, applyContainsReplacement,
  type OperatorEntry,
} from "@rescript/engine";
import { SYSTEM_VARIABLE_HELP } from "@rescript/quality";
import { useLoopScope } from "./loopScope";
import { useStudio } from "./store";
import { ExpressionEditor } from "./ExpressionEditor";
import { CountEditor, COUNT_OPERATORS, scopesFor } from "./CountEditor";
import { ExprEditor } from "./ExprEditor";
import { InsertPipedText } from "./InsertPipedText";
import { LogicDialog, WorkspaceButton, WorkspaceSummary, useCompactLogic } from "./LogicDialog";

/**
 * Recursive visual condition builder — arbitrary AND/OR/NOT nesting with
 * every operator the engine implements (reqs §6–7, §13).
 *
 * Two things make it work for option-level logic:
 *   • operators are filtered to the ones that make sense for the source
 *     question, so a ranking operator never appears under a text question;
 *   • in per-option mode the builder can read "this option" and compare
 *     against it, which is how one rule covers a whole option list without
 *     any per-question hard-coding (reqs §8–9, §28).
 */

const OPERATOR_LABELS: Record<ComparisonOperator, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
  between: "between",
  notBetween: "not between",
  in: "in list",
  notIn: "not in list",
  contains: "contains",
  notContains: "doesn't contain",
  containsAny: "contains any of",
  containsAll: "contains all of",
  containsNone: "contains none of",
  selected: "has selected",
  notSelected: "hasn't selected",
  answered: "is answered",
  unanswered: "is unanswered",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  matches: "matches regex",
  startsWith: "starts with",
  endsWith: "ends with",
  rankedFirst: "ranked first",
  rankedLast: "ranked last",
  rankedTopN: "ranked in top N",
  rankEquals: "rank equals",
  rankGreaterThan: "rank greater than",
  rankLessThan: "rank less than",
  notRanked: "not ranked",
  dateBefore: "before",
  dateAfter: "after",
  dateEquals: "on",
  dateBetween: "between dates",
  /* "Display": the option (or row) was on the respondent's screen after display / exclusion logic, selected or not */
  displayed: "option is displayed",
  notDisplayed: "option is not displayed",
  containsItem: "contains item",
  notContainsItem: "does not contain item",
  containsAllItems: "contains all items",
  containsExactly: "is exactly",
};

const VALUE2_PLACEHOLDER: Partial<Record<ComparisonOperator, string>> = {
  /* a range reads "between [min] [max]" — inclusive, both ends count */
  between: "max",
  notBetween: "max",
  dateBetween: "and",
  rankedTopN: "N",
  rankEquals: "rank",
  rankGreaterThan: "rank",
  rankLessThan: "rank",
};

function newRule(defaultRef: string, def?: SurveyDefinition): ConditionRule {
  /* a new rule on a categorical grid starts as the cell question — "is" an answer column — with no value to fill in */
  const q = def?.questions.find((x) => x.id === defaultRef);
  if (q && def && isCategoricalGrid(authoringQuestionView(q, def))) {
    return { type: "rule", source: { kind: "question", ref: defaultRef }, operator: "selected" };
  }
  const base: ConditionRule = { type: "rule", source: { kind: "question", ref: defaultRef }, operator: "eq", value: "" };
  /* SMART OPERATORS: a new rule starts on its source's own default — Equals, Has selected, Is on … */
  return def && q ? withDefaultOperator(def, base) : base;
}

/**
 * The rule on its (new) source's DEFAULT operator — Equals for a single
 * select, "has selected" for a multi select, "is" a row's answer on a grid,
 * "contains item" for a list, "is on" for a date. Used only when the SOURCE is
 * picked, when the old operator and value belong to the old source; a stored
 * rule is never re-pointed by this (see `operatorStatus` for that case).
 */
function withDefaultOperator(def: SurveyDefinition, next: ConditionRule): ConditionRule {
  if (next.source.kind === "rule") return next;
  const m = operatorMenu(def, next.source);
  return m.defaultEntry ? applyOperatorEntry({ ...next, value: undefined, value2: undefined }, m.defaultEntry) : next;
}

/**
 * A ready-to-edit condition list.
 *
 * Deliberately EMPTY. It used to arrive with one rule already in it and an
 * AND group around it, which is the thing the builder now avoids: the
 * programmer adds conditions first and decides about grouping afterwards.
 */
export function newConditionGroup(_defaultRef?: string): Condition {
  return { type: "group", op: "and", children: [] };
}

const stripHtml = (s: string) => stripHtmlText(s);

/**
 * The question a `{ $question: … }` comparison names, however it was stored.
 *
 * New rules store the id. Rules written before that store the code, and a few
 * store the variable name — the evaluator has always accepted all three, so
 * the picker has to as well or an existing rule would show as unset and be
 * lost the first time somebody touched it.
 */
const rhsQuestion = (def: SurveyDefinition, ref: unknown) =>
  typeof ref === "string"
    ? def.questions.find((x) => x.id === ref || x.code === ref || x.variableName === ref)
    : undefined;

function RuleEditor({ rule: storedRule, onChange, onRemove, perOption }: {
  rule: ConditionRule; onChange(r: ConditionRule): void; onRemove(): void; perOption?: boolean;
}) {
  const s = useStudio();
  const q: Question | undefined = s.def.questions.find((x) => x.id === storedRule.source.ref);
  /*
   * A RULE THAT SPELT ITS SCALE POINT TWICE is shown as the one cell it means.
   * Nothing is rewritten until somebody edits it — the first change is made to
   * the canonical form, so opening a survey never alters a stored condition.
   */
  const gridNorm = normalizeGridRule(q, storedRule);
  const rule = gridNorm.rule;
  /*
   * A carry-forward question has no rows/options of its own in the static
   * schema — they only exist as a runtime computation from another
   * question's answer. Without this, the row/column pickers below and the
   * option-value dropdown enumerate an empty list for exactly the questions
   * this builder most needs to address (dynamic matrices, carried-forward
   * multi-selects), which is the reported bug. `authoringQuestionView` is
   * the one shared resolver every design-time list in Studio reads instead
   * of the raw `q.rows` / `q.options` / `q.columns` — for an ordinary,
   * non-carry-forward question it returns `q` unchanged.
   */
  const view: Question | undefined = q ? authoringQuestionView(q, s.def) : undefined;
  /*
   * The question's AXES, and the values the current reference can hold. One
   * resolver, shared with the lint and the evaluator, so the builder cannot
   * offer a row where a column belongs or a scale the question does not use.
   */
  const srcQuestion = view ?? q;
  const axes = gridAxes(srcQuestion);
  const valueChoices = authoringValueChoicesFor(q, s.def, { rowCode: rule.source.rowCode, columnId: rule.source.columnId });
  const listOps = LIST_VALUE_OPERATORS.includes(rule.operator);
  /*
   * ROW + ANSWER COLUMN: on a single- or multi-select matrix the answer column
   * IS the answer, so "is / is not / has selected" take the column and nothing
   * else. A comparison takes a value and no column. One control, never both.
   */
  const gridQ = !rule.source.count && srcQuestion && isCategoricalGrid(srcQuestion) ? srcQuestion : undefined;
  const cellForm = !!gridQ && isCellOperator(rule.operator);
  /*
   * OR-07: when the row AND the column select are both on screen they already
   * say which cell this is, so the reference chip shows only the question —
   * a third spelling of the same row and column on one line is noise.
   */
  const bothAxesShown = !rule.source.count && !isDisplayOperator(rule.operator) && axes.isGrid
    && axes.rows.length > 0 && axes.columns.length > 0 && (!gridQ || cellForm);
  /*
   * "DISPLAY" asks what the respondent SAW, not what they answered: Source
   * Question + Source Option (a row, on a grid). So it takes no row/column
   * picker of its own — the one value picker below IS the option — and it
   * lists the question's options as displayable things, never its scale.
   */
  const displayOp = isDisplayOperator(rule.operator);
  const displayChoices: { ref: string; label: string }[] = !displayOp || !srcQuestion ? [] : gridQ
    ? axes.rows.map((r) => ({ ref: String(r.ref), label: String(r.label) }))
    : valueChoices.map((o) => ({ ref: String(o.ref), label: String(o.label) }));
  const needsValue2 = TWO_VALUE_OPERATORS.includes(rule.operator);
  const usesOption = isOptionValueRef(rule.value);
  const usesQuestion = isQuestionValueRef(rule.value);
  /* piped text as the value — `{{Q1.ZIP}}` — resolved when the rule is evaluated */
  const usesPipe = isPipedValueRef(rule.value);

  /*
   * COUNTING CHANGES THE LEFT-HAND SIDE, SO IT CHANGES THE OPERATORS.
   *
   * A count is a number. "contains", "ranked first" and "matches regex" are
   * meaningless against it, and offering them is how a programmer builds a
   * rule that can never be true. The six comparisons plus `between` are
   * exactly the set the brief asks for, and they were already implemented —
   * nothing new was added to the operator union.
   */
  const counting = !!rule.source.count;

  /*
   * SMART OPERATORS (document 16/10): ONE menu per source, from the engine —
   * the same function every builder in the Studio reaches through this
   * component (display, skip, branch, flow, quota, validation, auto-punch,
   * masking, option logic, loops, list fills, named expressions …). It knows
   * the source's type, groups the operators, words them for that type and
   * names the default. OR-05 still holds: a composite column takes its own
   * column type's operators.
   */
  const menu = rule.source.kind === "rule" ? null : operatorMenu(s.def, rule.source);
  const currentEntry: OperatorEntry | undefined = menu ? entryForRule(menu, rule) : undefined;
  const status = rule.source.kind === "rule" ? { status: "ok" as const, message: undefined } : operatorStatus(s.def, rule);
  const [opQuery, setOpQuery] = React.useState("");
  const allowed: ComparisonOperator[] = counting ? COUNT_OPERATORS : (menu?.entries ?? []).map((x) => x.op);
  /* a stored operator this source still evaluates but no longer offers (`Q1 > 2` on a single select): kept, shown as "other" */
  const legacyAllowed = status.status === "other";
  /*
   * AN OPERATOR THE SOURCE CAN NO LONGER TAKE.
   *
   * Retyping a question changes what comparisons mean for it: "contains" on
   * a multi-select is nothing at all once that question is a number, and
   * "ranked first" survives nothing. The saved operator used to be quietly
   * added to the list and rendered like any other, so a rule that could
   * never be true looked exactly like a rule that could.
   *
   * It is still SELECTABLE — dropping it would leave the select showing the
   * first valid operator while the stored rule still held the invalid one,
   * which is the same lie the other way round — but it is labelled for what
   * it is, and the row says so with a one-click fix beside it.
   */
  /*
   * NEEDS UPDATE: the source's type changed under the rule. Never silently
   * replaced — the stored operator stays selected and labelled, the menu
   * offers this source's own operators, and the linter blocks deployment
   * until the programmer chooses one.
   */
  const operatorStale = status.status === "needsUpdate";
  const query = opQuery.trim().toLowerCase();
  const shownGroups = (menu?.groups ?? [])
    .map((g) => ({ ...g, entries: g.entries.filter((x) => !query || x === currentEntry || x.label.toLowerCase().includes(query) || x.op.toLowerCase().includes(query)) }))
    .filter((g) => g.entries.length > 0);
  const valueKind = currentEntry?.value;
  /* "is true" / "has uploaded a file" carry their value in the operator choice itself */
  const needsValue = !VALUELESS_OPERATORS.includes(rule.operator) && !cellForm && valueKind !== "none";
  const rankOp = valueKind === "rank";
  const inputType = valueKind === "number" || valueKind === "numberRange" ? "number"
    : valueKind === "date" || valueKind === "dateRange" ? "date"
    : valueKind === "time" || valueKind === "timeRange" ? "time" : "text";

  /**
   * Turn counting on or off for this rule.
   *
   * On: the value becomes a number, and the operator moves to ">=" unless it
   * already compares numerically — so the rule is valid the instant it is
   * switched, rather than sitting in an impossible state until the programmer
   * notices.
   *
   * Off: the count is dropped and the rule is an ordinary one again. The
   * operator is left alone, because ">= 2" against an answer is a legitimate
   * rule and second-guessing it would throw away a deliberate edit.
   */
  const setCounting = (on: boolean) => {
    if (!on) {
      const { count: _drop, ...source } = rule.source;
      return onChange({ ...rule, source });
    }
    const scope = scopesFor(view)[0];
    onChange({
      ...rule,
      source: { ...rule.source, count: { of: "selected", scope } as never },
      operator: COUNT_OPERATORS.includes(rule.operator) ? rule.operator : "gte",
      value: Number(rule.value) || 1,
      value2: undefined,
    });
  };

  const setSource = (patch: Partial<ConditionRule["source"]>) =>
    onChange({ ...rule, source: { ...rule.source, ...patch } });

  /**
   * Source is ONE control, not two. A separate "Question / Variable /
   * Calculation / Embedded" picker sat in front of every rule, truncated to
   * "Questi⌄" in the panel, and was almost never changed — the overwhelming
   * majority of conditions read a question. Option groups put every source in
   * a single dropdown, which is both narrower and less to explain.
   */
  const sourceValue =
    rule.source.kind === "rule" ? `rule:${rule.source.ref}`
      : rule.source.kind === "question" ? `q:${rule.source.ref}`
      : rule.source.kind === "option" ? `o:${rule.source.ref || "code"}`
        : rule.source.kind === "loop" && rule.source.scope ? `loopscope:${rule.source.scope}:${rule.source.ref}`
        : `${rule.source.kind}:${rule.source.ref}`;

  const pickSource = (raw: string) => {
    const [kind, ...rest] = raw.split(":");
    const ref = rest.join(":");
    if (kind === "q") {
      /*
       * ANOTHER QUESTION IS ANOTHER VOCABULARY. The row, the answer column and
       * the value belong to the question they were picked on — carried over,
       * they would name a row or a code the new question does not have. The
       * operator is kept when the new question can take it, and otherwise
       * becomes that question's natural one.
       */
      if (ref === rule.source.ref) return;
      const next = s.def.questions.find((x) => x.id === ref);
      const { rowCode: _r, columnId: _c, rowPosition: _rp, optionPosition: _op, count: _ct, ...rest } = rule.source;
      const keep = rule.operator;
      const base: ConditionRule = {
        ...rule,
        source: { ...rest, kind: "question", ref },
        operator: keep,
        value: VALUELESS_OPERATORS.includes(keep) || (next && isCategoricalGrid(next) && isCellOperator(keep)) ? undefined : "",
        value2: undefined,
      };
      /* SMART OPERATORS: the operator is kept when the new question offers it, otherwise it becomes that question's default */
      return onChange(next ? withDefaultOperator(s.def, base) : base);
    }
    /*
     * A named expression already answers yes or no, so choosing one fixes the
     * operator too — leaving "= " and an empty value would ask the programmer
     * to compare a boolean with something, which is not a question they have.
     */
    if (kind === "rule") {
      return onChange({
        ...rule,
        source: { kind: "rule", ref },
        operator: "eq",
        value: true,
        value2: undefined,
      });
    }
    /*
     * Any other source: a field, a calculation, a loop value, this option.
     * The previous question's row, column and count do not belong to it, and
     * the operator becomes this source's default unless it already offers it
     * — an Embedded Data list starts on "contains item", a boolean on "is true".
     */
    const { rowCode: _r2, columnId: _c2, rowPosition: _rp2, optionPosition: _op2, count: _ct2, scope: _sc2, ...baseSrc } = rule.source;
    const switchTo = (src: Partial<ConditionRule["source"]>) =>
      onChange(withDefaultOperator(s.def, { ...rule, source: { ...baseSrc, ...src } as ConditionRule["source"] }));
    if (kind === "o") return switchTo({ kind: "option", ref: ref || "code" });
    if (kind === "loopscope") {
      // an OUTER loop, named by its loopVar (§32)
      const [scope, ...r] = rest;
      return switchTo({ kind: "loop", ref: r.join(":"), scope });
    }
    if (kind === "loop") return switchTo({ kind: "loop", ref });
    switchTo({ kind: kind as any, ref });
  };

  /*
   * THE LOOPS THIS RULE SITS INSIDE (innermost first). Their reference columns
   * are offered as sources; a loop the rule is not inside is not, because that
   * value would always be empty here. The columns are whatever each loop
   * declared — nothing in this file knows what they are called.
   */
  const loopScope = useLoopScope();

  return (
    <div className="cond-rule">
      <div className="cond-rule-main">
      <select className="select ref-select" aria-label="What this condition reads"
        value={sourceValue} onChange={(e) => pickSource(e.target.value)}>
        <option value="q:">— pick a question —</option>
        {perOption && (
          <optgroup label="This option">
            <option value="o:code">this option’s code</option>
            <option value="o:label">this option’s label</option>
            <option value="o:value">this option’s value</option>
            <option value="o:index">this option’s position</option>
          </optgroup>
        )}
        {/*
          * Named expressions first, above Questions. They are the shortest and
          * most reusable thing in the list, and a programmer who has defined
          * one is looking for it — burying it under sixty questions is how a
          * reusable rule gets rewritten by hand instead.
          */}
        {(s.def.namedExpressions ?? []).length > 0 && (
          <optgroup label="Named expressions">
            {(s.def.namedExpressions ?? []).map((e) => (
              <option key={e.id} value={`rule:${e.id}`} title={e.description ?? ""}>{e.name}</option>
            ))}
          </optgroup>
        )}
        <optgroup label="Questions">
          {s.def.questions.map((x) => (
            <option key={x.id} value={`q:${x.id}`}>{x.code} — {x.variableName}</option>
          ))}
        </optgroup>
        {s.def.calculations.length > 0 && (
          <optgroup label="Calculations">
            {s.def.calculations.map((c) => (
              <option key={c.id} value={`calculation:${c.targetVariable}`}>{c.targetVariable}</option>
            ))}
          </optgroup>
        )}
        {/* List Fill results are ordinary calculated variables, so a
            condition on "which brand was this respondent allocated" is built
            with the same builder as everything else — no separate List Fill
            logic language (§24) */}
        {s.def.listFills.length > 0 && (
          <optgroup label="List Fill results">
            {s.def.listFills.flatMap((lf) => listFillVariableNames(lf as never)
              .filter((v) => v.kind === "code" || v.kind === "count")
              .slice(0, 12)
              .map((v) => (
                <option key={v.name} value={`calculation:${v.name}`}>{v.name}</option>
              )))}
          </optgroup>
        )}
        {/*
          * A function call (SUM/AVG/MIN/MAX/…) gets its OWN full editor below
          * (`ExprEditor`) — this option is only what the closed select shows,
          * so it stays short instead of squeezing the entire call into one
          * `.ref-select` sized for a short token like `q:Q3`, which is what
          * used to look cut off / misaligned.
          */}
        {rule.source.kind === "expr" && (
          <optgroup label="Function">
            <option value={sourceValue}>
              ƒ {rule.source.ref.length > 28 ? `${rule.source.ref.slice(0, 28)}…` : rule.source.ref || "(empty)"}
            </option>
          </optgroup>
        )}
        {/* a source this build does not list still displays as itself, never as
            the placeholder — the rule stays readable and a re-save keeps it */}
        {rule.source.kind !== "question" && rule.source.kind !== "option" && rule.source.kind !== "expr"
          && !knownSource(sourceValue, s.def, loopScope) && (
          <optgroup label="Other">
            <option value={sourceValue}>{rule.source.kind}: {rule.source.ref}</option>
          </optgroup>
        )}
        {/* every embedded field declared anywhere in the flow, with its type —
            not only the ones registered on the survey (reqs §15–16) */}
        {embeddedCatalog(s.def).length > 0 && (
          <optgroup label="Embedded data">
            {embeddedCatalog(s.def).map((e2) => (
              <option key={e2.name} value={`embedded:${e2.name}`}>
                {e2.name}{e2.dataType !== "string" ? ` (${e2.dataType})` : ""}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label={loopScope[0] ? `Current item (loop “${loopScope[0].loopVar}”)` : "Loop"}>
          <option value="loop:label">current item — label</option>
          <option value="loop:code">current item — code</option>
          <option value="loop:index">current item — position (LOOP_INDEX)</option>
          <option value="loop:count">loop — number of iterations (LOOP_COUNT)</option>
          <option value="loop:first">this is the first iteration (LOOP_FIRST)</option>
          <option value="loop:last">this is the last iteration (LOOP_LAST)</option>
          {(loopScope[0]?.references?.columns ?? []).map((c) => (
            <option key={c.name} value={`loop:${c.name}`} title={c.description}>
              current item — {c.name}{c.dataType && c.dataType !== "text" ? ` (${c.dataType})` : ""}
            </option>
          ))}
        </optgroup>
        {loopScope.slice(1).map((outer) => (
          <optgroup key={outer.id} label={`Outer loop “${outer.loopVar}”`}>
            <option value={`loopscope:${outer.loopVar}:label`}>{outer.loopVar} — label</option>
            <option value={`loopscope:${outer.loopVar}:code`}>{outer.loopVar} — code</option>
            <option value={`loopscope:${outer.loopVar}:index`}>{outer.loopVar} — position</option>
            {(outer.references?.columns ?? []).map((c) => (
              <option key={c.name} value={`loopscope:${outer.loopVar}:${c.name}`}>{outer.loopVar} — {c.name}</option>
            ))}
          </optgroup>
        ))}
        {/* the quality engine's SYSTEM_* metrics — what custom quality rules
            test; without this group a saved `calc.SYSTEM_DURATION_RATIO` rule
            displayed as "— pick a question —" and looked unsaved.
            OR-06: LAST, under its own heading — about forty-five of them used
            to sit between the calculations and the loop items, in the middle of
            the list a programmer scans for a question. */}
        <optgroup label="Quality scores (SYSTEM_*)" data-testid="quality-scores-group">
          {SYSTEM_VARIABLE_HELP.map((v) => (
            <option key={v.name} value={`calculation:${v.name}`} title={v.hint}>{v.name}</option>
          ))}
        </optgroup>
      </select>
      {/*
        * THE COUNT TOGGLE, on the rule itself.
        *
        * Offered only for a question source, because a count is a count of a
        * question's options, rows or columns — there is nothing to count in a
        * calculated variable or an embedded field, and a control that appears
        * and then refuses is worse than one that is not there.
        */}
      {rule.source.kind === "question" && rule.source.ref && (
        <button
          type="button"
          className={`btn small ${counting ? "primary" : "ghost"}`}
          data-testid="toggle-count"
          data-command="toggle-count"
          title={counting
            ? "Compare the answer itself instead of how many qualify"
            : "Compare HOW MANY options, rows or columns qualify"}
          onClick={() => setCounting(!counting)}
        >∑ count</button>
      )}
      {/* a count reads the whole collection, so a single row or column is not
          the thing being asked about — the subset picker inside the count
          editor is where narrowing happens */}
      {/*
        * THE TWO AXES, NAMED FOR WHAT THEY ACTUALLY ARE.
        *
        * The column picker used to appear only when `q.columns` was non-empty
        * — which is never true of a Likert grid, because a Likert grid keeps
        * its columns in `q.options` as the answer scale. So "any row rated
        * Excellent", a reference the evaluator has always supported and the
        * engine tests cover, could not be authored at all. `gridAxes` answers
        * "what are this question's axes" once, for both spellings, and the
        * pickers follow it.
        */}
      {!counting && !displayOp && axes.isGrid && (axes.rows.length > 0 || axes.columns.length > 0) && (
        <>
          {axes.rows.length > 0 && (
            <select className="select" data-testid="cond-row" value={rule.source.rowCode ?? ""}
              onChange={(e) => setSource({ rowCode: e.target.value || undefined })}>
              <option value="">any row</option>
              {axes.rows.map((r) => <option key={r.ref} value={r.ref}>{menu?.rowSelector === "field" ? "field" : "row"}: {r.label}</option>)}
            </select>
          )}
          {/* on a categorical grid the column is the ANSWER and belongs to "is / is not"; a comparison has a value instead */}
          {axes.columns.length > 0 && (!gridQ || cellForm) && (
            <select className="select" data-testid="cond-column" value={rule.source.columnId ?? ""}
              onChange={(e) => {
                const columnId = e.target.value || undefined;
                /* OR-05: another column is another type — keep the operator when it still fits, else take that column's first */
                if (!gridQ && q && !counting) {
                  const fits = operatorsForQuestion(q, columnId);
                  if (!fits.includes(rule.operator)) {
                    /* that column's own default operator (smart operators), never one it cannot take */
                    const m = operatorMenu(s.def, { ...rule.source, columnId });
                    const moved = { ...rule, source: { ...rule.source, columnId }, value: undefined, value2: undefined };
                    return onChange(m.defaultEntry ? applyOperatorEntry(moved, m.defaultEntry) : { ...moved, operator: fits[0] ?? rule.operator });
                  }
                }
                setSource({ columnId });
              }}
              title={axes.columnMeaning === "option_code"
                ? "The columns of this grid are its answer scale. Naming one asks about any row with that answer."
                : "Naming a column asks about that column's cell."}>
              <option value="">{gridQ ? "— answer —" : axes.columnMeaning === "option_code" ? "any answer" : "any col"}</option>
              {axes.columns.map((c) => <option key={c.ref} value={c.ref}>{gridQ ? c.label : axes.columnMeaning === "option_code" ? "rated" : "col"}{gridQ ? "" : ": "}{gridQ ? "" : c.label}</option>)}
            </select>
          )}
        </>
      )}
      {/* what the reference reads as, so there is never a doubt which cell it names */}
      {!counting && !displayOp && axes.isGrid && (rule.source.rowCode || rule.source.columnId) && (
        <span className="chip mono" data-testid="cond-reference" data-collapsed={bothAxesShown ? "true" : undefined}
          title={bothAxesShown ? `the element this condition reads: ${describeReference(srcQuestion, rule.source)}` : "the element this condition reads"}>
          {bothAxesShown ? describeReference(srcQuestion, {}) : describeReference(srcQuestion, rule.source)}
        </span>
      )}
      {gridNorm.conflict && (
        <span className="chip warn" data-testid="cond-conflict" title={gridNorm.conflict}>column and value disagreed — value kept</span>
      )}
      {/*
        * A NAMED EXPRESSION NEEDS NO OPERATOR. It already answers yes or no,
        * so the row is just the name and an is/is-not toggle — offering
        * "contains" or "ranked first" against a boolean would be offering a
        * rule that cannot be true.
        */}
      {rule.source.kind === "rule" ? (
        <button
          type="button" className="btn small" data-testid="named-truth"
          title="Match when this expression is true, or when it is not"
          onClick={() => onChange({ ...rule, operator: "eq", value: rule.value === false })}
        >{rule.value === false ? "is NOT true" : "is true"}</button>
      ) : (
        <>
          {/* MaxDiff: which task — none means any task */}
          {menu?.rowSelector === "task" && !counting && (
            <input className="input" type="number" min={1} style={{ maxWidth: 92 }} data-testid="cond-task"
              aria-label="Task" placeholder="any task" title="Which task — leave empty for any task"
              value={String(rule.source.rowCode ?? "")}
              onChange={(e) => setSource({ rowCode: e.target.value === "" ? undefined : e.target.value })} />
          )}
          <select className={`select op-select${operatorStale ? " stale" : ""}`} value={currentEntry?.id ?? rule.operator} data-testid="cond-operator"
            data-stale={operatorStale ? "1" : undefined}
            data-operand-type={menu?.type}
            aria-label={`Operator — ${menu?.typeLabel ?? "value"}`}
            title={currentEntry?.hint ?? menu?.typeLabel}
            onChange={(e) => {
              const entry = menu?.entries.find((x) => x.id === e.target.value);
              if (!entry) return; /* the stored, no-longer-offered operator itself: nothing to change */
              setOpQuery("");
              if (gridQ && !entry.preset) return onChange(withGridOperator(rule, entry.op));
              /* to or from Display the old value is a different kind of thing (an answer vs an option shown) */
              if (isDisplayOperator(entry.op) !== displayOp) return onChange({ ...rule, operator: entry.op, value: undefined, value2: undefined });
              onChange(applyOperatorEntry(rule, entry, currentEntry));
            }}>
            {(operatorStale || (legacyAllowed && !currentEntry)) && (
              <option value={rule.operator}>
                {(OPERATOR_LABELS[rule.operator] ?? rule.operator) + (operatorStale ? " — not available for this question (needs update)" : " — other, still valid")}
              </option>
            )}
            {shownGroups.map((g) => (
              <optgroup key={g.id} label={g.label}>
                {g.entries.map((x) => <option key={x.id} value={x.id} title={x.hint}>{x.label}</option>)}
              </optgroup>
            ))}
          </select>
          {operatorStale && (
            <span className="chip warn" data-testid="cond-needs-update" title={status.message}>needs update</span>
          )}
          {operatorStale && status.replacement ? (
            /*
             * "CONTAINS" ON A CHOICE QUESTION (2026-10-24): a text operator
             * where "equals" / "has selected" says what it does. One click
             * renames it; the value and the source stay, and the rule
             * evaluates exactly as it did.
             */
            <button type="button" className="btn small" data-testid="fix-operator" data-replacement={status.replacement.op}
              title={status.message}
              onClick={() => onChange(applyContainsReplacement(rule, status.replacement!))}>
              use “{status.replacement.label}”
            </button>
          ) : operatorStale && menu?.defaultEntry && (
            <button type="button" className="btn small" data-testid="fix-operator"
              title={`“${OPERATOR_LABELS[rule.operator] ?? rule.operator}” cannot be evaluated against this source any more — its type changed. Use “${menu.defaultEntry.label}” (or pick another operator from the list).`}
              onClick={() => onChange(applyOperatorEntry({ ...rule, value: undefined, value2: undefined }, menu.defaultEntry!))}>
              fix
            </button>
          )}
        </>
      )}

      {/* a count is compared against a NUMBER — never against an option code,
          which is what the option dropdown below would offer */}
      {rule.source.kind === "rule" ? null : needsValue && counting ? (
        <input
          className="input" type="number" min={0} style={{ maxWidth: 90 }}
          data-testid="count-value" aria-label="How many"
          value={String(rule.value ?? "")}
          onChange={(e) => onChange({ ...rule, value: e.target.value === "" ? undefined : Number(e.target.value) })}
        />
      ) : needsValue && (
        usesPipe ? (
          <input className="input mono" data-testid="cond-value-pipe" aria-label="Piped value"
            title="Piped text — resolved for each respondent when the condition is evaluated"
            value={(rule.value as { $pipe: string }).$pipe}
            onChange={(e) => onChange({ ...rule, value: { $pipe: e.target.value } })} />
        ) : usesOption ? (
          <span className="chip pipe-chip" title="Compares against the option this rule is attached to">
            this option’s {(rule.value as any).$option}
          </span>
        ) : usesQuestion ? (
          /*
           * Comparing against ANOTHER QUESTION'S ANSWER rather than a fixed
           * value — "end date on or after start date", "confirm email matches
           * email", "priorities selected equals the number given in Q63".
           * Rendered as a question picker so the reference is always a real
           * question: typing a code into the plain value box next door would
           * silently become the literal text of that code.
           */
          /*
           * Stored as the question's ID, shown as its code. It used to be
           * stored as the code, so renaming Q5 to Q5b broke every rule that
           * compared against it — silently, since an unresolvable reference
           * is simply false. The evaluator has always resolved an id, a code
           * or a variable name, so old rules keep working and new ones stop
           * depending on a name a person is free to change.
           */
          <select className="select" data-testid="value-question"
            value={rhsQuestion(s.def, (rule.value as any).$question)?.id ?? ""}
            onChange={(e) => onChange({ ...rule, value: { $question: e.target.value } })}>
            <option value="">— question —</option>
            {s.def.questions.filter((x) => x.id !== rule.source.ref).map((x) => (
              <option key={x.id} value={x.id}>{x.code} — {stripHtml(x.text).slice(0, 40)}</option>
            ))}
          </select>
        ) : displayOp ? (
          <select className="select" data-testid="cond-display-option" aria-label="Source option"
            value={String(rule.value ?? "")}
            onChange={(e) => onChange({ ...rule, value: e.target.value === "" ? undefined : e.target.value })}>
            <option value="">{gridQ ? "— any row (the question) —" : "— the question itself —"}</option>
            {displayChoices.map((o) => (
              <option key={o.ref} value={o.ref}>{choiceDisplayText(o)}</option>
            ))}
          </select>
        ) : valueChoices.length > 0 && !listOps && rule.operator !== "matches" ? (
          /* the values THIS reference can hold: a flat question's options, a
             grid's scale, or the named column's own list — never a list from
             a different axis, which is how an unmatchable rule got authored */
          <select className="select" data-testid="cond-value" value={String(rule.value ?? "")}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}>
            <option value="">— value —</option>
            {valueChoices.map((o) => (
              <option key={o.ref} value={o.ref}>{choiceDisplayText(o)}</option>
            ))}
          </select>
        ) : (
          <>
          <input className="input" type={listOps ? "text" : inputType} data-testid="cond-value-input"
            inputMode={inputType === "number" || valueKind === "numberList" ? "decimal" : undefined}
            placeholder={valueKind === "numberList" ? "1, 5, 10, 25 — separated by commas" : listOps ? "1,2,3" : valueKind === "items" ? "10003 — or a list: 10001, 10003" : valueKind === "textList" ? "a, b, c — separated by commas" : valueKind === "numberRange" ? "min" : "value"}
            aria-label={valueKind === "numberRange" ? "Minimum" : undefined}
            value={listOps && Array.isArray(rule.value) ? rule.value.join(",") : String(rule.value ?? "")}
            onChange={(e) =>
              onChange({ ...rule, value: listOps ? e.target.value.split(",").map((x) => x.trim()) : e.target.value })
            } />
          {/*
            * THE LIST AS CHIPS (2026-10-24): "is in list" on an open end takes
            * a value list — typed with commas above, shown one chip per value
            * here, each removable — so "1, 5, 10, 25, 50, 100" is seen as six
            * values and not as one piece of text.
            */}
          {listOps && valueChoices.length === 0 && Array.isArray(rule.value) && rule.value.filter((x) => String(x).trim() !== "").length > 0 && (
            <span className="cond-options" data-testid="cond-value-chips" role="group" aria-label="Values in the list" style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", gap: 4 }}>
              {rule.value.map((x, i) => String(x).trim() === "" ? null : (
                <span key={`${i}:${String(x)}`} className="chip" data-testid="cond-value-chip" data-value={String(x)} style={{ fontSize: 12 }}>
                  {String(x)}
                  <button type="button" className="chip-x" aria-label={`Remove ${String(x)}`} title="Remove this value"
                    style={{ marginLeft: 4, border: 0, background: "transparent", cursor: "pointer", padding: 0 }}
                    onClick={() => onChange({ ...rule, value: (rule.value as unknown[]).filter((_, j) => j !== i) })}>×</button>
                </span>
              ))}
            </span>
          )}
          </>
        )
      )}
      {/*
        * INSERT PIPED TEXT (FLOW's shared picker): the comparison value can be
        * another answer, an Embedded Data field, a calculation … — "IF
        * ZIP_Code_DMA contains item {{Q1.ZIP_Code}}". Offered for typed values
        * only (a number field is offered numeric sources); the token is stored
        * as a `{ $pipe }` reference, never as literal text.
        */}
      {needsValue && !counting && !usesOption && !usesQuestion && !listOps && !displayOp && !rankOp
        && ["text", "number", "items", "date", "time"].includes(String(valueKind)) && (
        <InsertPipedText def={s.def} accept={inputType === "number" ? "number" : "text"} label="Pipe" testId="cond-insert-pipe"
          onInsert={(token) => onChange({ ...rule, value: { $pipe: `${usesPipe ? (rule.value as { $pipe: string }).$pipe : String(rule.value ?? "")}${token}` } })} />
      )}
      {usesPipe && (
        <button type="button" className="btn small" data-testid="cond-pipe-clear" title="Compare against a typed value instead"
          onClick={() => onChange({ ...rule, value: "" })}>fixed value</button>
      )}
      {/* SEVERAL OPTIONS: tick them (the typed list beside stays in step) */}
      {needsValue && listOps && !usesOption && !usesQuestion && !counting && valueChoices.length > 0 && (
        <span className="cond-options" data-testid="cond-options" role="group" aria-label="Options">
          {valueChoices.map((o) => {
            const cur = Array.isArray(rule.value) ? rule.value.map(String) : [];
            const on = cur.includes(String(o.ref));
            return (
              <label key={o.ref} className="chip" style={{ cursor: "pointer" }}>
                <input type="checkbox" data-testid="cond-option" data-code={o.ref} checked={on}
                  onChange={(e) => onChange({ ...rule, value: e.target.checked ? [...cur.filter((x) => x !== ""), String(o.ref)] : cur.filter((x) => x !== String(o.ref)) })} />
                {" "}{choiceDisplayText(o)}
              </label>
            );
          })}
        </span>
      )}
      {perOption && needsValue && (
        <button className="btn small" style={{ flex: "0 0 auto" }}
          title="Compare against the option this rule is attached to"
          onClick={() => onChange({ ...rule, value: usesOption ? "" : { $option: "code" } })}>
          {usesOption ? "fixed value" : "↺ this option"}
        </button>
      )}
      {/*
        * Switch the right-hand side between a typed value and another
        * question's answer. Without this the comparison is expressible only
        * in the Expression tab, and the obvious visual spelling — pick Q5,
        * pick ">", type "Q6" — quietly compares against the letters "Q6".
        */}
      {needsValue && !counting && !usesOption && !listOps && (
        <button className="btn small" style={{ flex: "0 0 auto" }}
          data-testid="value-mode-toggle"
          title={usesQuestion
            ? "Compare against a typed value instead"
            : "Compare against another question's answer"}
          onClick={() => onChange({ ...rule, value: usesQuestion ? "" : { $question: "" } })}>
          {usesQuestion ? "fixed value" : "↔ a question"}
        </button>
      )}
      {needsValue2 && rankOp ? (
        /* a rank POSITION: 1 … the number of items */
        <select className="select" data-testid="cond-rank-position" aria-label="Position"
          value={String(rule.value2 ?? "")}
          onChange={(e) => onChange({ ...rule, value2: e.target.value === "" ? undefined : Number(e.target.value) })}>
          <option value="">{VALUE2_PLACEHOLDER[rule.operator] ?? "position"}</option>
          {Array.from({ length: Math.max(valueChoices.length, 2) }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
        </select>
      ) : needsValue2 && (
        <input className="input" style={{ flex: "0 1 90px" }} placeholder={VALUE2_PLACEHOLDER[rule.operator] ?? "and"}
          type={inputType} data-testid="cond-value2" aria-label="Second value"
          value={String(rule.value2 ?? "")}
          onChange={(e) => onChange({ ...rule, value2: e.target.value })} />
      )}
      </div>
      {/*
        * UNDER THE RULE: what it says in words, the item-vs-text rule where it
        * matters, and a search over this source's operators (outside the main
        * row so it never stands in for the value box).
        */}
      {rule.source.kind !== "rule" && (
        <div className="cond-rule-tools" style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 12.5 }}>
          <span className="muted cond-rule-summary" data-testid="cond-rule-summary">{ruleSentence(s.def, rule)}</span>
          {(menu?.entries.length ?? 0) > 6 && (
            <input className="op-search" data-testid="cond-op-search" type="search" placeholder="find operator…"
              aria-label="Find an operator" value={opQuery} style={{ fontSize: 12, padding: "1px 6px", maxWidth: 140 }}
              onChange={(e) => setOpQuery(e.target.value)} />
          )}
          {menu && <span className="muted" data-testid="cond-operand-type" style={{ fontSize: 11.5 }}>{menu.typeLabel}</span>}
          {(rule.operator === "contains" || rule.operator === "notContains" || rule.operator === "containsItem" || rule.operator === "notContainsItem" || rule.operator === "containsAllItems") && menu && (menu.type === "list" || menu.type === "text" || menu.type === "any") ? (
            <span className="muted" data-testid="cond-op-hint" style={{ flexBasis: "100%" }}>
              {(rule.operator === "contains" || rule.operator === "notContains") && !containsMatchesItems(s.def, rule.source)
                ? "Contains text: any part of the text — “1000” matches “10001”. For a comma-separated list use “contains item”; for a number or a range use “is in list” or “is between”."
                : "Contains item: whole items of a comma-separated list, spaces and case ignored — 10001 never matches 110001; a list of items matches when any of them is there."}
            </span>
          ) : currentEntry?.hint && ["between", "notBetween", "in", "notIn"].includes(rule.operator) && menu && ["text", "numeric", "grid_text", "grid_numeric", "constant_sum"].includes(menu.type) && !counting ? (
            /* an open end's range / list operator says how a comma-separated answer is read (2026-10-24) */
            <span className="muted" data-testid="cond-op-hint" style={{ flexBasis: "100%" }}>{currentEntry.hint}</span>
          ) : null}
        </div>
      )}
      {/* the count's own controls, on their own line: what to count, over
          what, narrowed to what, and a plain reading of the result */}
      {counting && <CountEditor rule={rule} onChange={onChange}
        renderWhere={(value, set) => <OptionalCondition label="each counted item must meet" value={value} onChange={set} perOption />} />}
      {/* a function call's own controls, on their own line: which function,
          one row per argument, add/remove — see ExprEditor's own doc comment */}
      {rule.source.kind === "expr" && <ExprEditor rule={rule} onChange={onChange} />}
      <div className="cond-rule-actions">
        <button className="btn small danger" title="Remove this condition" onClick={onRemove}>×</button>
      </div>
    </div>
  );
}

/* ==========================================================================
 * The logic builder: conditions first, groups only when asked for.
 *
 * It used to open on a logical structure — a group, an "ALL (AND)" operator
 * and an empty slot — so the first thing a programmer met was set theory, and
 * mixing AND with OR meant knowing to press "+ condition group ( … )" before
 * writing anything down.
 *
 * Now the builder opens empty. Conditions are added to a flat list. When two
 * of them belong together the programmer ticks them and presses
 * "Move to new group", which is the only nesting gesture there is — and it
 * works on groups too, so depth accumulates the same way at every level.
 *
 * The stored shape does not change: still `Condition`, still a group that owns
 * its own `op`, still evaluated by the recursive evaluator. All of the tree
 * arithmetic lives in `@rescript/engine`'s `logicTree.ts`, shared with Survey
 * Flow, so question logic and branch logic cannot drift apart (req §14).
 * ======================================================================== */

/** Number the groups in document order, so the badges read "Group 1, 2, 3". */
function groupNumbers(root: ConditionGroup): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  const walk = (node: Condition, path: LogicPath) => {
    if (node.type !== "group") return;
    node.children.forEach((child, i) => {
      const p = [...path, i];
      if (child.type === "group") out.set(pathKey(p), ++n);
      walk(child, p);
    });
  };
  walk(root, []);
  return out;
}

interface BuilderCtx {
  root: ConditionGroup;
  commit(next: ConditionGroup, label: string): void;
  selected: string[];
  toggle(path: LogicPath, on: boolean): void;
  numbers: Map<string, number>;
  perOption?: boolean;
  justGrouped: string | null;
}

/**
 * One level of the list: the rows, the connector between them, and the
 * "+ Add condition" that grows it.
 *
 * The same component renders the top level and the inside of every group,
 * which is what makes nesting free — a group is a row that happens to contain
 * a list.
 */
function ConditionList({ ctx, path, group }: {
  ctx: BuilderCtx; path: LogicPath; group: ConditionGroup;
}) {
  const s = useStudio();
  const firstRef = s.def.questions[0]?.id ?? "";
  const isRoot = path.length === 0;

  const addCondition = () =>
    ctx.commit(appendTo(ctx.root, path, newRule(firstRef, s.def)), "add condition");

  if (group.children.length === 0) {
    return (
      <div className="lb-empty" data-testid={isRoot ? "lb-empty" : "lb-empty-group"}>
        <span className="muted">
          {isRoot ? "No conditions added yet." : "This group is empty."}
        </span>
        <button className="btn small primary" data-testid="lb-add-condition" onClick={addCondition}>
          + Add condition
        </button>
      </div>
    );
  }

  return (
    <div className={`lb-list${isRoot ? " root" : ""}`}>
      {group.children.map((child, i) => {
        const childPath = [...path, i];
        const key = pathKey(childPath);
        return (
          <React.Fragment key={key}>
            {i > 0 && (
              <Connector ctx={ctx} path={path} group={group} gapIndex={i - 1} />
            )}
            <div className={`lb-row${ctx.selected.includes(key) ? " selected" : ""}`}
              data-testid="lb-row">
              {/* a plain span, not a <label>: a label wrapping its own checkbox
                  re-dispatches the click to it, which toggles twice */}
              <span className="lb-pick">
                <input type="checkbox" data-testid="lb-check"
                  aria-label="Select this condition to group, duplicate or delete it"
                  title="Select this to group, duplicate or delete it"
                  checked={ctx.selected.includes(key)}
                  onChange={(e) => ctx.toggle(childPath, e.target.checked)} />
              </span>
              <div className="lb-row-body">
                {child.type === "rule" ? (
                  <RuleEditor rule={child} perOption={ctx.perOption}
                    onChange={(r) => ctx.commit(replaceAt(ctx.root, childPath, r), "edit condition")}
                    onRemove={() => ctx.commit(removeAt(ctx.root, childPath), "remove condition")} />
                ) : (
                  <GroupRow ctx={ctx} path={childPath} group={child} />
                )}
              </div>
            </div>
          </React.Fragment>
        );
      })}
      <div className="lb-add">
        <button className="btn small" data-testid="lb-add-condition" onClick={addCondition}>
          + Add condition
        </button>
      </div>
    </div>
  );
}

/**
 * The operator between two rows — one per gap, each independently settable.
 *
 * This is the fix for "changing one AND/OR changes the others". A group holds
 * ONE operator, and this control used to write it directly, so four conditions
 * in one list drew three dropdowns onto one stored value: setting any of them
 * moved all three. Worse, `C1 AND C2 OR C3 AND C4` could not be expressed at
 * all, because one level can only hold one operator.
 *
 * `setGroupConnector` writes the gap instead, and rebuilds the level so every
 * other gap keeps what it had — AND binding tighter than OR, so the brackets
 * that appear are exactly the ones the edit means. Each operator then lives on
 * a real group node of its own; nothing is shared.
 */
function Connector({ ctx, path, group, gapIndex }: {
  ctx: BuilderCtx; path: LogicPath; group: ConditionGroup; gapIndex: number;
}) {
  // NOT is not a relationship between two things — it belongs to the group as
  // a whole, and is set in that group's header
  if (group.op === "not") {
    return (
      <div className="lb-join">
        <span className="lb-join-label" data-testid="cond-join">{OPERATOR_LABEL.not}</span>
      </div>
    );
  }
  return (
    <div className="lb-join">
      <select className="select lb-join-select" data-testid="lb-join-op"
        aria-label="How these two combine"
        value={group.op === "or" ? "or" : "and"}
        onChange={(e) => ctx.commit(
          setGroupConnector(ctx.root, path, gapIndex, e.target.value as "and" | "or"),
          "change operator",
        )}>
        <option value="and">AND</option>
        <option value="or">OR</option>
      </select>
      <span className="muted lb-join-hint">{OPERATOR_HINT[group.op]}</span>
    </div>
  );
}

/** A group: a bordered container with its own operator, holding its own list. */
function GroupRow({ ctx, path, group }: {
  ctx: BuilderCtx; path: LogicPath; group: ConditionGroup;
}) {
  const key = pathKey(path);
  const n = ctx.numbers.get(key);
  return (
    <div className={`lb-group op-${group.op}${ctx.justGrouped === key ? " just-created" : ""}`}
      data-testid="lb-group">
      <div className="lb-group-head">
        <span className="lb-group-badge">GROUP {n ?? ""}</span>
        <select className="select lb-op-select" data-testid="group-op"
          aria-label="How the conditions in this group combine"
          value={group.op}
          onChange={(e) => ctx.commit(
            setOperatorAt(ctx.root, path, e.target.value as ConditionGroup["op"]),
            "change group operator",
          )}>
          <option value="and">AND</option>
          <option value="or">OR</option>
          <option value="not">NOT</option>
        </select>
        <span className="muted lb-group-hint">{OPERATOR_HINT[group.op]}</span>
        {/* the two buttons travel together: letting them wrap independently
            dropped a lone × onto a second line in the 380px panel */}
        <span className="lb-group-actions">
          <button className="btn small" data-testid="lb-ungroup"
            disabled={!canUngroup(ctx.root, path)}
            title={canUngroup(ctx.root, path)
              ? group.op === "not" ? "Remove this group — each condition in it keeps its NOT" : "Remove this group, keep the conditions in it"
              : "A NOT group can only be ungrouped inside an AND — anywhere else its conditions would stop being negated"}
            onClick={() => ctx.commit(ungroupAt(ctx.root, path), "ungroup")}>
            ungroup
          </button>
          <button className="btn small danger" title="Delete this group and everything in it"
            onClick={() => ctx.commit(removeAt(ctx.root, path), "delete group")}>×</button>
        </span>
      </div>
      <div className="lb-group-body">
        <ConditionList ctx={ctx} path={path} group={group} />
      </div>
    </div>
  );
}

/**
 * The builder. `value` is the stored condition; what comes back out is the
 * smallest tree with the same meaning, so a one-condition rule is stored as a
 * rule and an emptied builder as an empty list rather than an inverted one.
 */
/**
 * Visual or written — the same logic either way.
 *
 * Both panes edit the one canonical tree: the visual builder assembles it,
 * the expression editor parses text into it and prints it back. Nothing
 * stores an expression, so switching modes cannot lose or change anything
 * (reqs §1, §13–15).
 */
/**
 * What the workspace dialog says at the top for this condition. Every
 * `ConditionEditor` offers one (the 23-Oct review: the right-hand box is too
 * narrow for nested logic — see LogicDialog.tsx); the embedding names the
 * feature and the subject, or the editor falls back to its `purpose`.
 */
export interface ConditionWorkspace {
  /** "Display logic", "Skip logic — rule 2", "Branch path" … */
  title?: string;
  /** "Q5 — Which brand do you use?" */
  subject?: string;
  /** one line under the title */
  description?: React.ReactNode;
}

export function ConditionEditor(props: {
  value: Condition; onChange(c: Condition): void; perOption?: boolean;
  /** what the condition decides, to read it as a sentence: "Display Q4 if" */
  purpose?: string;
  /** `wide` inside the workspace: source, operator and value on one row, deeper indents (CSS only — same data, same behaviour) */
  layout?: "narrow" | "wide";
  /** the "Edit in workspace" button and the dialog it opens; `false` hides it (used inside the workspace itself) */
  workspace?: ConditionWorkspace | false;
}) {
  const [mode, setMode] = React.useState<"visual" | "expression">("visual");
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const s = useStudio();
  const sentence = props.purpose ? conditionSentence(s.def, props.value, props.purpose) : "";
  const ws = props.workspace === false ? null : (props.workspace ?? {});
  const wsTitle = ws?.title ?? (props.purpose ? `Condition — ${props.purpose.replace(/\s+if$/i, "")}` : "Condition");
  const compact = useCompactLogic();
  const dialog = ws && workspaceOpen && (
    <LogicDialog<Condition>
      title={wsTitle} subject={ws.subject}
      description={ws.description ?? (props.purpose ? `${props.purpose} the following condition is met:` : undefined)}
      value={props.value}
      onSave={(next) => { s.labelNextEdit?.(`edit ${wsTitle.toLowerCase()}`); props.onChange(next); }}
      onClose={() => setWorkspaceOpen(false)}>
      {(draft, setDraft) => (
        <ConditionEditor value={draft} onChange={setDraft} perOption={props.perOption} purpose={props.purpose}
          layout="wide" workspace={false} />
      )}
    </LogicDialog>
  );
  /*
   * THE COMPACT PANEL ("workspace" surface, see lib/logicDialog/surface.ts):
   * a read-only reading of the condition and the button — the builder itself
   * lives only in the centred workspace.
   */
  if (ws && compact && props.layout !== "wide") {
    const text = conditionSummary(s.def, props.value);
    const n = countConditions(props.value);
    return (
      <div className="cond-modes summary-only" data-testid="cond-summary-only">
        <WorkspaceSummary text={text || "No conditions yet."} count={n} countNoun={n === 1 ? "condition" : "conditions"}
          onOpen={() => setWorkspaceOpen(true)} testId="cond-summary-strip" />
        {sentence && <div className="muted" data-testid="cond-purpose-summary" style={{ fontSize: 12.5, marginTop: 2 }}>{sentence}</div>}
        {dialog}
      </div>
    );
  }
  return (
    <div className={`cond-modes${props.layout === "wide" ? " wide" : ""}`}>
      <div className="cond-mode-bar" data-testid="logic-mode-bar">
        <button className={`cm-tab ${mode === "visual" ? "on" : ""}`} data-testid="mode-visual"
          onClick={() => setMode("visual")}>Visual</button>
        <button className={`cm-tab ${mode === "expression" ? "on" : ""}`} data-testid="mode-expression"
          onClick={() => setMode("expression")}>Expression</button>
        <span className="grow" />
        <span className="muted cm-hint">
          {mode === "visual" ? "click to build" : "type, drag or click references"}
        </span>
        {ws && <WorkspaceButton onClick={() => setWorkspaceOpen(true)} compact={!props.layout || props.layout === "narrow"} />}
      </div>
      {mode === "visual"
        ? <VisualConditionEditor {...props} />
        : <ExpressionEditor {...props} />}
      {/* one plain-English reading, under whichever pane is open — it used to
          be rendered by OptionalCondition as well, which showed it twice */}
      <ConditionSummary value={props.value} />
      {sentence && <div className="muted" data-testid="cond-purpose-summary" style={{ fontSize: 12.5, marginTop: 2 }}>{sentence}</div>}
      <ConditionTester value={props.value} />
      {dialog}
    </div>
  );
}

/**
 * TEST CONDITION — type a test response, see TRUE or FALSE from the real
 * evaluator (`evaluateWithTestInputs` → `evaluateCondition`), with nothing
 * saved anywhere. One input per thing the condition reads.
 */
function ConditionTester({ value }: { value: Condition | undefined }) {
  const s = useStudio();
  const [open, setOpen] = React.useState(false);
  const [vals, setVals] = React.useState<Record<string, string>>({});
  const inputs = React.useMemo(() => (open ? conditionTestInputs(s.def, value) : []), [open, s.def, value]);
  if (!value || (value.type === "group" && (value.children ?? []).length === 0)) return null;
  let verdict: boolean | null = null;
  let problem: string | null = null;
  if (open) {
    try { verdict = evaluateWithTestInputs(s.def, value, vals).result; } catch (e) { problem = (e as Error).message; }
  }
  return (
    <div className="cond-tester" data-testid="cond-test" style={{ marginTop: 6 }}>
      <button type="button" className="btn small ghost" data-testid="cond-test-toggle" onClick={() => setOpen(!open)}>
        {open ? "Hide test" : "Test condition"}
      </button>
      {open && (
        <div className="card" style={{ padding: 8, marginTop: 4, display: "grid", gap: 6 }}>
          {inputs.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>This condition reads nothing a test response can set (loop values, this option, quotas).</span>}
          {inputs.map((i) => (
            <label key={i.key} className="f" style={{ marginBottom: 0 }}>
              <span>{i.label} <span className="muted">— {i.hint}</span></span>
              <input className="op-search" data-testid="cond-test-input" data-key={i.key}
                list={i.choices ? `cond-test-${i.key}` : undefined}
                value={vals[i.key] ?? ""} placeholder={i.choices ? i.choices.slice(0, 4).map((c) => c.code).join(", ") : ""}
                onChange={(e) => setVals({ ...vals, [i.key]: e.target.value })} />
              {i.choices && (
                <datalist id={`cond-test-${i.key}`}>
                  {i.choices.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </datalist>
              )}
            </label>
          ))}
          <div>
            Result:{" "}
            <strong data-testid="cond-test-result" data-result={verdict === null ? "" : String(verdict)}
              style={{ color: verdict ? "var(--ok, #157f3b)" : "var(--danger, #b42318)" }}>
              {problem ? `cannot evaluate: ${problem}` : verdict ? "TRUE" : "FALSE"}
            </strong>
          </div>
        </div>
      )}
    </div>
  );
}

/** The tree's shape, with nothing of its contents: what a path key depends on. */
function shapeSignature(c: Condition | undefined): string {
  if (!c) return "";
  return c.type === "group"
    ? `(${(c.children ?? []).map(shapeSignature).join(",")})`
    : "r";
}

function VisualConditionEditor({ value, onChange, perOption, layout }: {
  value: Condition; onChange(c: Condition): void; perOption?: boolean; layout?: "narrow" | "wide";
}) {
  const s = useStudio();
  const root = editableCondition(value);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [justGrouped, setJustGrouped] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  /**
   * A SELECTION IS A LIST OF POSITIONS, so it survives only while the
   * positions mean the same thing.
   *
   * `selected` holds path keys — "0.2" is the third child of the first group.
   * Nothing cleared them when the tree changed underneath: an undo, a rule
   * deleted from its own row, a collaborator's edit, or the logic being
   * replaced wholesale all shifted every path along, and "group these two"
   * then grouped two different conditions than the ones with ticks next to
   * them. Structure is what moves paths, so structure is what clears the
   * selection; editing an operator or a value leaves it alone, because those
   * do not move anything.
   */
  const shape = React.useMemo(() => shapeSignature(root), [root]);
  const lastShape = React.useRef(shape);
  React.useEffect(() => {
    if (lastShape.current === shape) return;
    lastShape.current = shape;
    setSelected([]);
    setJustGrouped(null);
    setNotice(null);
  }, [shape]);

  /** Every write goes through here: canonicalise, label for undo, save. */
  const commit = (next: ConditionGroup, label: string) => {
    s.labelNextEdit?.(label);
    onChange(canonicalCondition(next, { allowEmpty: false })!);
  };

  const toggle = (path: LogicPath, on: boolean) => {
    const key = pathKey(path);
    setNotice(null);
    setSelected((cur) => (on ? [...cur, key] : cur.filter((k) => k !== key)));
  };

  const selectedPaths: LogicPath[] = selected.map((k) => k.split(".").map(Number));
  // grouping only makes sense among siblings; the engine refuses the rest
  const sameLevel = selectedPaths.length > 0 &&
    new Set(selectedPaths.map((p) => p.slice(0, -1).join("."))).size === 1;

  const moveToGroup = () => {
    const res = groupSelection(root, selectedPaths, "and");
    if (!res.ok) { setNotice(res.reason ?? "That selection cannot be grouped"); return; }
    commit(res.root, "move to new group");
    setSelected([]);
    const key = res.groupPath ? pathKey(res.groupPath) : null;
    setJustGrouped(key);
    setTimeout(() => setJustGrouped(null), 1800);
  };

  const duplicateSelected = () => {
    // deepest-last, so earlier duplications do not shift later paths
    const ordered = [...selectedPaths].sort((a, b) => b.join(".").localeCompare(a.join(".")));
    let next = root;
    for (const p of ordered) next = duplicateAt(next, p);
    commit(next, "duplicate conditions");
    setSelected([]);
  };

  const deleteSelected = () => {
    const ordered = [...selectedPaths].sort((a, b) => b.join(".").localeCompare(a.join(".")));
    let next = root;
    for (const p of ordered) next = removeAt(next, p);
    commit(next, "delete conditions");
    setSelected([]);
  };

  const numbers = groupNumbers(root);
  const ctx: BuilderCtx = { root, commit, selected, toggle, numbers, perOption, justGrouped };
  const issues = validateLogicTree(root);

  return (
    <div className={`logic-builder${layout === "wide" ? " wide" : ""}`} data-testid="logic-builder" data-layout={layout ?? "narrow"}>
      {selected.length > 0 && (
        <div className="lb-actions" data-testid="lb-actions">
          <span className="lb-count" data-testid="lb-count">{selected.length} selected</span>
          <button className="btn small primary" data-testid="lb-move-to-group"
            disabled={!sameLevel}
            title={sameLevel
              ? "Wrap the selected conditions in a group you can give its own AND / OR / NOT"
              : "Select conditions that sit at the same level"}
            onClick={moveToGroup}>
            Move to new group
          </button>
          <button className="btn small" data-testid="lb-duplicate" onClick={duplicateSelected}>
            Duplicate
          </button>
          <button className="btn small danger" data-testid="lb-delete" onClick={deleteSelected}>
            Delete
          </button>
          <span className="grow" />
          <button className="btn small" onClick={() => { setSelected([]); setNotice(null); }}>
            Clear selection
          </button>
        </div>
      )}
      {notice && <div className="lb-notice" data-testid="lb-notice">{notice}</div>}

      {/*
        * THE TOP LEVEL'S OWN OPERATOR, shown. A stored `NOT (…)` — what typing
        * `NOT Q1.A` produces — used to render as if it were `Q1.A`: the top
        * level has no group header, and the only trace of the NOT was the
        * word between two rows, of which a single condition has none. It is
        * now a control at the head of the list, so a negation is always
        * visible and can be set or removed where it applies.
        */}
      {(root.children.length > 0 || root.op === "not") && (
        <div className="lb-root-head" data-testid="lb-root-head">
          <span className="muted" style={{ fontSize: 12.5 }}>Match</span>
          <select className="select small lb-root-op" data-testid="lb-root-op"
            aria-label="How the top-level conditions combine"
            value={root.op}
            onChange={(e) => commit(setOperatorAt(root, [], e.target.value as ConditionGroup["op"]), "change top-level operator")}>
            <option value="and">ALL of these (AND)</option>
            <option value="or">ANY of these (OR)</option>
            <option value="not">NONE of these (NOT)</option>
          </select>
          {root.op === "not" && <span className="chip warn" data-testid="lb-root-not">negated</span>}
        </div>
      )}

      <ConditionList ctx={ctx} path={[]} group={root} />

      {issues.filter((i) => i.level === "error").slice(0, 3).map((i, k) => (
        <div key={k} className="lb-issue" data-testid="lb-issue">⛔ {i.message}</div>
      ))}
    </div>
  );
}

/** Optional condition wrapper: none / edit. */
export function OptionalCondition({ label, value, onChange, perOption, hint, purpose, workspace }: {
  label: string; value: Condition | undefined; onChange(c: Condition | undefined): void;
  perOption?: boolean; hint?: string;
  /** read the condition as a sentence: "Display Q4 if …" */
  purpose?: string;
  /** the workspace dialog's title / subject / description; `false` offers no workspace */
  workspace?: ConditionWorkspace | false;
}) {
  const s = useStudio();
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const ws = workspace === false ? null : (workspace ?? {});
  const wsTitle = ws?.title ?? (purpose ? `Condition — ${purpose.replace(/\s+if$/i, "")}` : label);
  const compact = useCompactLogic();
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="flabel" style={{ marginBottom: 0 }}>{label}</span>
        <span className="grow" />
        {value ? (
          <button className="btn small danger" onClick={() => onChange(undefined)}>clear</button>
        ) : (
          <>
            {/* opens an EMPTY builder — no group, no operator, nothing to undo (not on the compact panel, where the workspace is the builder) */}
            {(!ws || !compact) && <button className="btn small" data-testid="optional-add"
              onClick={() => onChange(newConditionGroup())}>
              + add
            </button>}
            {/* …or build it in the centred workspace; nothing is stored until Save */}
            {ws && <WorkspaceButton onClick={() => setWorkspaceOpen(true)} label={compact ? "Add logic" : "in workspace"} testId="optional-add-workspace"
              title="Build this condition in a larger, centred workspace — stored when you press Save" />}
          </>
        )}
      </div>
      {hint && !value && <div className="muted" style={{ fontSize: 12.5, marginTop: -2 }}>{hint}</div>}
      {value && <ConditionEditor value={value} onChange={onChange} perOption={perOption} purpose={purpose} workspace={workspace} />}
      {ws && !value && workspaceOpen && (
        <LogicDialog<Condition>
          title={wsTitle} subject={ws.subject}
          description={ws.description ?? (purpose ? `${purpose} the following condition is met:` : hint)}
          value={newConditionGroup()}
          onSave={(next) => { s.labelNextEdit?.(`add ${wsTitle.toLowerCase()}`); onChange(isEmptyTree(next) ? undefined : next); }}
          onClose={() => setWorkspaceOpen(false)}>
          {(draft, setDraft) => (
            <ConditionEditor value={draft} onChange={setDraft} perOption={perOption} purpose={purpose} layout="wide" workspace={false} />
          )}
        </LogicDialog>
      )}
    </div>
  );
}

/** how many leaf conditions a tree holds — the count on the compact summary */
function countConditions(c: Condition | undefined): number {
  if (!c) return 0;
  return c.type === "group" ? (c.children ?? []).reduce((n, x) => n + countConditions(x), 0) : 1;
}

/** an empty group is "no condition" — saving one from the workspace leaves the optional condition unset */
const isEmptyTree = (c: Condition | undefined): boolean => !c || (c.type === "group" && (c.children ?? []).length === 0);

/** Readable one-line summary of a configured condition (req §14). */
export function ConditionSummary({ value }: { value: Condition | undefined }) {
  const s = useStudio();
  const text = conditionSummary(s.def, value);
  if (!text) return null;
  return <div className="logic-summary">{text}</div>;
}

/** Legacy text renderer kept for the logic-flow export; now shares the
 *  engine's phrasing so the editor and the export never disagree. */
export function conditionToText(c: Condition | undefined, def: any): string {
  return conditionSummary(def, c);
}

/** Is this `kind:ref` source offered by one of the select's groups? */
function knownSource(
  value: string,
  def: { calculations: { targetVariable: string }[]; flow: unknown[]; listFills?: unknown[] },
  loopScope: { loopVar: string; references?: { columns: { name: string }[] } }[] = [],
): boolean {
  if (value.startsWith("loopscope:")) {
    const [, scope, ...rest] = value.split(":");
    const outer = loopScope.find((l) => l.loopVar === scope);
    const ref = rest.join(":");
    return !!outer && (["label", "code", "index", "count"].includes(ref) || (outer.references?.columns ?? []).some((c) => c.name === ref));
  }
  if (value.startsWith("loop:")) {
    const ref = value.slice(5);
    return ["label", "code", "index", "count"].includes(ref)
      || (loopScope[0]?.references?.columns ?? []).some((c) => c.name === ref);
  }
  if (value.startsWith("calculation:")) {
    const ref = value.slice("calculation:".length);
    if (def.calculations.some((c) => c.targetVariable === ref)) return true;
    if (SYSTEM_VARIABLE_HELP.some((v) => v.name === ref)) return true;
    return (def.listFills ?? []).some((lf) => listFillVariableNames(lf as never).some((v) => v.name === ref));
  }
  if (value.startsWith("embedded:")) return embeddedCatalog(def as any).some((e) => `embedded:${e.name}` === value);
  return false;
}
