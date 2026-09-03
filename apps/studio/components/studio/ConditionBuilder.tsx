"use client";
import React from "react";
import type { Condition, ConditionRule, ComparisonOperator, Question } from "@rescript/schema";
import {
  VALUELESS_OPERATORS,
  TWO_VALUE_OPERATORS,
  LIST_VALUE_OPERATORS,
  isOptionValueRef,
} from "@rescript/schema";
import { operatorsForQuestion, conditionSummary } from "@rescript/engine";
import { useStudio } from "./store";

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
};

const VALUE2_PLACEHOLDER: Partial<Record<ComparisonOperator, string>> = {
  between: "and",
  notBetween: "and",
  dateBetween: "and",
  rankedTopN: "N",
  rankEquals: "rank",
  rankGreaterThan: "rank",
  rankLessThan: "rank",
};

function newRule(defaultRef: string): ConditionRule {
  return { type: "rule", source: { kind: "question", ref: defaultRef }, operator: "eq", value: "" };
}

/** A ready-to-edit condition group with one starter row. */
export function newConditionGroup(defaultRef: string): Condition {
  return { type: "group", op: "and", children: [newRule(defaultRef)] };
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "");

function RuleEditor({ rule, onChange, onRemove, perOption }: {
  rule: ConditionRule; onChange(r: ConditionRule): void; onRemove(): void; perOption?: boolean;
}) {
  const s = useStudio();
  const q: Question | undefined = s.def.questions.find((x) => x.id === rule.source.ref);
  const listOps = LIST_VALUE_OPERATORS.includes(rule.operator);
  const needsValue = !VALUELESS_OPERATORS.includes(rule.operator);
  const needsValue2 = TWO_VALUE_OPERATORS.includes(rule.operator);
  const usesOption = isOptionValueRef(rule.value);

  // only offer operators that make sense for the chosen source (req §7)
  const allowed: ComparisonOperator[] =
    rule.source.kind === "question" && q
      ? operatorsForQuestion(q)
      : (Object.keys(OPERATOR_LABELS) as ComparisonOperator[]);
  const operatorChoices = allowed.includes(rule.operator) ? allowed : [rule.operator, ...allowed];

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
    rule.source.kind === "question" ? `q:${rule.source.ref}`
      : rule.source.kind === "option" ? `o:${rule.source.ref || "code"}`
        : `${rule.source.kind}:${rule.source.ref}`;

  const pickSource = (raw: string) => {
    const [kind, ...rest] = raw.split(":");
    const ref = rest.join(":");
    if (kind === "q") return setSource({ kind: "question", ref });
    if (kind === "o") return setSource({ kind: "option", ref: ref || "code" });
    setSource({ kind: kind as any, ref });
  };

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
        {s.def.embeddedData.length > 0 && (
          <optgroup label="Embedded data">
            {s.def.embeddedData.map((e2) => (
              <option key={e2.name} value={`embedded:${e2.name}`}>{e2.name}</option>
            ))}
          </optgroup>
        )}
        <optgroup label="Loop">
          <option value="loop:label">loop label</option>
          <option value="loop:code">loop code</option>
          <option value="loop:index">loop index</option>
        </optgroup>
      </select>
      {q && (q.rows.length > 0 || q.columns.length > 0) && (
        <>
          {q.rows.length > 0 && (
            <select className="select" value={rule.source.rowCode ?? ""}
              onChange={(e) => setSource({ rowCode: e.target.value || undefined })}>
              <option value="">any row</option>
              {q.rows.map((r) => <option key={String(r.code)} value={String(r.code)}>row: {stripHtml(r.label)}</option>)}
            </select>
          )}
          {q.columns.length > 0 && (
            <select className="select" value={rule.source.columnId ?? ""}
              onChange={(e) => setSource({ columnId: e.target.value || undefined })}>
              <option value="">any col</option>
              {q.columns.map((c) => <option key={c.id} value={c.id}>col: {c.label}</option>)}
            </select>
          )}
        </>
      )}
      <select className="select op-select" value={rule.operator}
        onChange={(e) => onChange({ ...rule, operator: e.target.value as ComparisonOperator })}>
        {operatorChoices.map((o) => <option key={o} value={o}>{OPERATOR_LABELS[o] ?? o}</option>)}
      </select>

      {needsValue && (
        usesOption ? (
          <span className="chip pipe-chip" title="Compares against the option this rule is attached to">
            this option’s {(rule.value as any).$option}
          </span>
        ) : q && q.options.length > 0 && !listOps && rule.operator !== "matches" ? (
          <select className="select" value={String(rule.value ?? "")}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}>
            <option value="">— value —</option>
            {q.options.map((o) => (
              <option key={String(o.code)} value={String(o.code)}>{o.code}: {stripHtml(o.label)}</option>
            ))}
          </select>
        ) : (
          <input className="input"
            placeholder={listOps ? "1,2,3" : "value"}
            value={listOps && Array.isArray(rule.value) ? rule.value.join(",") : String(rule.value ?? "")}
            onChange={(e) =>
              onChange({ ...rule, value: listOps ? e.target.value.split(",").map((x) => x.trim()) : e.target.value })
            } />
        )
      )}
      {perOption && needsValue && (
        <button className="btn small" style={{ flex: "0 0 auto" }}
          title="Compare against the option this rule is attached to"
          onClick={() => onChange({ ...rule, value: usesOption ? "" : { $option: "code" } })}>
          {usesOption ? "fixed value" : "↺ this option"}
        </button>
      )}
      {needsValue2 && (
        <input className="input" style={{ flex: "0 1 90px" }} placeholder={VALUE2_PLACEHOLDER[rule.operator] ?? "and"}
          value={String(rule.value2 ?? "")}
          onChange={(e) => onChange({ ...rule, value2: e.target.value })} />
      )}
      </div>
      <div className="cond-rule-actions">
        <button className="btn small danger" title="Remove this condition" onClick={onRemove}>×</button>
      </div>
    </div>
  );
}

/**
 * One group of conditions.
 *
 * A group has a single operator, but showing it as a leading "ALL (AND)"
 * dropdown put the most abstract control first and made a two-line rule look
 * like set theory. The operator now lives BETWEEN the rules, as the connector
 * you actually read — "Q1 is answered / AND / Q2 is Apple" — which is both how
 * every survey tool presents it and how the sentence reads out loud. Changing
 * any connector changes the group, because there is only one; with a single
 * condition no connector is shown at all.
 */
export function ConditionEditor({ value, onChange, perOption, nested }: {
  value: Condition; onChange(c: Condition): void; perOption?: boolean; nested?: boolean;
}) {
  const s = useStudio();
  const firstRef = s.def.questions[0]?.id ?? "";

  if (value.type === "rule") {
    return (
      <div className="cond-group">
        <RuleEditor rule={value} onChange={onChange} perOption={perOption}
          onRemove={() => onChange({ type: "group", op: "and", children: [] })} />
        <div className="cond-add">
          <button className="btn small" onClick={() =>
            onChange({ type: "group", op: "and", children: [value, newRule(firstRef)] })}>
            + condition
          </button>
        </div>
      </div>
    );
  }

  const g = value;
  const setOp = (op: "and" | "or" | "not") => onChange({ ...g, op });

  /** The connector shown between two rules — and the only place the operator
   *  is editable, so it can never disagree with itself. */
  const Connector = () => (
    <div className="cond-join">
      <span className="cond-join-label" data-testid="cond-join">
        {g.op === "and" ? "AND" : g.op === "or" ? "OR" : "NOR"}
      </span>
    </div>
  );

  /**
   * Each group owns its operator, and each group shows it.
   *
   * The operator used to appear ONLY as a connector between two children, so
   * a bracketed sub-group holding one condition displayed no control of its
   * own — the nearest dropdown belonged to the PARENT. Changing "the nested
   * OR" therefore changed the parent's AND, which is exactly the bug this
   * fixes. The header control below is scoped to `g` and nothing else; the
   * connectors between rows are now plain text, so two controls can never
   * disagree about one group.
   */
  const showHeaderOp = nested || g.children.length > 1;

  return (
    <div className={`cond-group op-${g.op}${nested ? " nested" : ""}`} data-testid="cond-group">
      <div className="cond-lead">
        {showHeaderOp ? (
          <span className="cond-op-head">
            <select className="select cond-op-select" data-testid="group-op"
              value={g.op} aria-label={nested ? "How this bracketed group combines" : "How these conditions combine"}
              onChange={(e) => setOp(e.target.value as any)}>
              <option value="and">AND</option>
              <option value="or">OR</option>
              <option value="not">NOR</option>
            </select>
            <span className="muted" style={{ fontSize: 11.5 }}>
              {g.op === "and" ? "every condition in this group must be true"
                : g.op === "or" ? "any one condition in this group"
                  : "none of these may be true"}
              {nested ? " — this bracket only" : ""}
            </span>
          </span>
        ) : (
          "This is true when:"
        )}
      </div>
      {g.children.map((child, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Connector />}
          {child.type === "rule" ? (
            <RuleEditor rule={child} perOption={perOption}
              onChange={(r) => onChange({ ...g, children: g.children.map((c, j) => (j === i ? r : c)) })}
              onRemove={() => onChange({ ...g, children: g.children.filter((_, j) => j !== i) })} />
          ) : (
            <div className="cond-subgroup">
              <ConditionEditor value={child} perOption={perOption} nested
                onChange={(c) => onChange({ ...g, children: g.children.map((x, j) => (j === i ? c : x)) })} />
              <button className="btn small danger" style={{ marginTop: -2, marginBottom: 6 }}
                onClick={() => onChange({ ...g, children: g.children.filter((_, j) => j !== i) })}>
                remove group
              </button>
            </div>
          )}
        </React.Fragment>
      ))}
      <div className="cond-add">
        <button className="btn small" title="Add another condition"
          onClick={() => onChange({ ...g, children: [...g.children, newRule(firstRef)] })}>
          + condition
        </button>
        {/* A group has ONE operator, so mixing AND with OR means nesting. */}
        <button className="btn small"
          title={`Add a bracketed sub-group, for rules like A ${g.op === "and" ? "AND" : "OR"} (B ${g.op === "and" ? "OR" : "AND"} C)`}
          onClick={() =>
            onChange({
              ...g,
              children: [
                ...g.children,
                // the opposite operator — nesting an OR inside an OR is a no-op
                { type: "group", op: g.op === "or" ? "and" : "or", children: [newRule(firstRef)] },
              ],
            })}>
          + condition group ( … )
        </button>
      </div>
    </div>
  );
}

/** Optional condition wrapper: none / edit. */
export function OptionalCondition({ label, value, onChange, perOption, hint }: {
  label: string; value: Condition | undefined; onChange(c: Condition | undefined): void;
  perOption?: boolean; hint?: string;
}) {
  const s = useStudio();
  const firstRef = s.def.questions[0]?.id ?? "";
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="flabel" style={{ marginBottom: 0 }}>{label}</span>
        <span className="grow" />
        {value ? (
          <button className="btn small danger" onClick={() => onChange(undefined)}>clear</button>
        ) : (
          <button className="btn small" onClick={() =>
            onChange({ type: "group", op: "and", children: [newRule(firstRef)] })}>
            + add
          </button>
        )}
      </div>
      {hint && !value && <div className="muted" style={{ fontSize: 11, marginTop: -2 }}>{hint}</div>}
      {value && <ConditionEditor value={value} onChange={onChange} perOption={perOption} />}
      {value && <ConditionSummary value={value} />}
    </div>
  );
}

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
