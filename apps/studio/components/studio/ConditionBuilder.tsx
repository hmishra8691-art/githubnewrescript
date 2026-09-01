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
import { useStudio, refOptions } from "./store";

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
  const refs = refOptions(s.def);
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

  return (
    <div className="cond-rule">
      <select className="select" value={rule.source.kind}
        onChange={(e) => setSource({ kind: e.target.value as any, ref: e.target.value === "option" ? "code" : rule.source.ref })}>
        <option value="question">Question</option>
        <option value="variable">Variable</option>
        <option value="calculation">Calculation</option>
        <option value="embedded">Embedded</option>
        <option value="loop">Loop</option>
        {perOption && <option value="option">This option</option>}
      </select>
      {rule.source.kind === "option" ? (
        <select className="select" value={rule.source.ref || "code"}
          onChange={(e) => setSource({ ref: e.target.value })}>
          <option value="code">its code</option>
          <option value="label">its label</option>
          <option value="value">its value</option>
          <option value="index">its position</option>
        </select>
      ) : rule.source.kind === "question" ? (
        <select className="select" value={rule.source.ref}
          onChange={(e) => setSource({ ref: e.target.value })}>
          <option value="">— pick —</option>
          {refs.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      ) : (
        <input className="input mono" style={{ width: 130 }} placeholder="name" value={rule.source.ref}
          onChange={(e) => setSource({ ref: e.target.value })} />
      )}
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
      <select className="select" value={rule.operator}
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
          <input className="input" style={{ width: 120 }}
            placeholder={listOps ? "1,2,3" : "value"}
            value={listOps && Array.isArray(rule.value) ? rule.value.join(",") : String(rule.value ?? "")}
            onChange={(e) =>
              onChange({ ...rule, value: listOps ? e.target.value.split(",").map((x) => x.trim()) : e.target.value })
            } />
        )
      )}
      {perOption && needsValue && (
        <button className="btn small" title="Compare against the option this rule is attached to"
          onClick={() => onChange({ ...rule, value: usesOption ? "" : { $option: "code" } })}>
          {usesOption ? "use a fixed value" : "↺ this option"}
        </button>
      )}
      {needsValue2 && (
        <input className="input" style={{ width: 90 }} placeholder={VALUE2_PLACEHOLDER[rule.operator] ?? "and"}
          value={String(rule.value2 ?? "")}
          onChange={(e) => onChange({ ...rule, value2: e.target.value })} />
      )}
      <button className="btn small danger" onClick={onRemove}>×</button>
    </div>
  );
}

export function ConditionEditor({ value, onChange, perOption }: {
  value: Condition; onChange(c: Condition): void; perOption?: boolean;
}) {
  const s = useStudio();
  const firstRef = s.def.questions[0]?.id ?? "";

  if (value.type === "rule") {
    return (
      <div className="cond-group">
        <RuleEditor rule={value} onChange={onChange} perOption={perOption}
          onRemove={() => onChange({ type: "group", op: "and", children: [] })} />
        <button className="btn small" onClick={() =>
          onChange({ type: "group", op: "and", children: [value, newRule(firstRef)] })}>
          + add condition (AND/OR)
        </button>
      </div>
    );
  }

  const g = value;
  return (
    <div className={`cond-group op-${g.op}`}>
      <div className="row" style={{ marginBottom: 6 }}>
        <select className="select" style={{ width: 112 }} value={g.op}
          onChange={(e) => onChange({ ...g, op: e.target.value as any })}>
          <option value="and">ALL (AND)</option>
          <option value="or">ANY (OR)</option>
          <option value="not">NOT</option>
        </select>
        <span className="muted" style={{ fontSize: 12 }}>
          {g.op === "and" ? "all of these must hold" : g.op === "or" ? "at least one must hold" : "none of these may hold"}
        </span>
      </div>
      {g.children.map((child, i) =>
        child.type === "rule" ? (
          <RuleEditor key={i} rule={child} perOption={perOption}
            onChange={(r) => onChange({ ...g, children: g.children.map((c, j) => (j === i ? r : c)) })}
            onRemove={() => onChange({ ...g, children: g.children.filter((_, j) => j !== i) })} />
        ) : (
          <div key={i}>
            <ConditionEditor value={child} perOption={perOption}
              onChange={(c) => onChange({ ...g, children: g.children.map((x, j) => (j === i ? c : x)) })} />
            <button className="btn small danger" style={{ marginTop: -2, marginBottom: 6 }}
              onClick={() => onChange({ ...g, children: g.children.filter((_, j) => j !== i) })}>
              remove group
            </button>
          </div>
        ),
      )}
      <div className="row">
        <button className="btn small" onClick={() => onChange({ ...g, children: [...g.children, newRule(firstRef)] })}>
          + condition
        </button>
        <button className="btn small" onClick={() =>
          onChange({ ...g, children: [...g.children, { type: "group", op: "or", children: [newRule(firstRef)] }] })}>
          + nested group
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
