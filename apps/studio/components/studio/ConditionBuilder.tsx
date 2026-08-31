"use client";
import React from "react";
import type { Condition, ConditionRule, ComparisonOperator } from "@rescript/schema";
import { useStudio, refOptions } from "./store";

/**
 * Recursive visual condition builder — supports arbitrary AND/OR/NOT nesting
 * with every operator the engine implements (requirement §6).
 */

const OPERATORS: { value: ComparisonOperator; label: string }[] = [
  { value: "eq", label: "=" },
  { value: "ne", label: "≠" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: "≥" },
  { value: "lte", label: "≤" },
  { value: "between", label: "between" },
  { value: "in", label: "in list" },
  { value: "notIn", label: "not in list" },
  { value: "contains", label: "contains" },
  { value: "notContains", label: "doesn't contain" },
  { value: "selected", label: "has selected" },
  { value: "notSelected", label: "hasn't selected" },
  { value: "answered", label: "is answered" },
  { value: "unanswered", label: "is unanswered" },
  { value: "matches", label: "matches regex" },
];

const NO_VALUE: ComparisonOperator[] = ["answered", "unanswered"];

function newRule(defaultRef: string): ConditionRule {
  return { type: "rule", source: { kind: "question", ref: defaultRef }, operator: "eq", value: "" };
}

function RuleEditor({ rule, onChange, onRemove }: {
  rule: ConditionRule; onChange(r: ConditionRule): void; onRemove(): void;
}) {
  const s = useStudio();
  const refs = refOptions(s.def);
  const q = s.def.questions.find((x) => x.id === rule.source.ref);
  const listOps = ["in", "notIn"].includes(rule.operator);
  return (
    <div className="cond-rule">
      <select className="select" value={rule.source.kind}
        onChange={(e) => onChange({ ...rule, source: { ...rule.source, kind: e.target.value as any } })}>
        <option value="question">Question</option>
        <option value="variable">Variable</option>
        <option value="calculation">Calculation</option>
        <option value="embedded">Embedded</option>
        <option value="loop">Loop</option>
      </select>
      {rule.source.kind === "question" ? (
        <select className="select" value={rule.source.ref}
          onChange={(e) => onChange({ ...rule, source: { ...rule.source, ref: e.target.value } })}>
          <option value="">— pick —</option>
          {refs.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      ) : (
        <input className="input mono" style={{ width: 130 }} placeholder="name" value={rule.source.ref}
          onChange={(e) => onChange({ ...rule, source: { ...rule.source, ref: e.target.value } })} />
      )}
      {q && (q.rows.length > 0 || q.columns.length > 0) && (
        <>
          {q.rows.length > 0 && (
            <select className="select" value={rule.source.rowCode ?? ""}
              onChange={(e) => onChange({ ...rule, source: { ...rule.source, rowCode: e.target.value || undefined } })}>
              <option value="">any row</option>
              {q.rows.map((r) => <option key={String(r.code)} value={String(r.code)}>row: {r.label}</option>)}
            </select>
          )}
          {q.columns.length > 0 && (
            <select className="select" value={rule.source.columnId ?? ""}
              onChange={(e) => onChange({ ...rule, source: { ...rule.source, columnId: e.target.value || undefined } })}>
              <option value="">any col</option>
              {q.columns.map((c) => <option key={c.id} value={c.id}>col: {c.label}</option>)}
            </select>
          )}
        </>
      )}
      <select className="select" value={rule.operator}
        onChange={(e) => onChange({ ...rule, operator: e.target.value as ComparisonOperator })}>
        {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {!NO_VALUE.includes(rule.operator) && (
        q && q.options.length > 0 && !listOps && rule.operator !== "matches" ? (
          <select className="select" value={String(rule.value ?? "")}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}>
            <option value="">— value —</option>
            {q.options.map((o) => <option key={String(o.code)} value={String(o.code)}>{o.code}: {o.label.replace(/<[^>]*>/g, "")}</option>)}
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
      {rule.operator === "between" && (
        <input className="input" style={{ width: 80 }} placeholder="and"
          value={String(rule.value2 ?? "")}
          onChange={(e) => onChange({ ...rule, value2: e.target.value })} />
      )}
      <button className="btn small danger" onClick={onRemove}>×</button>
    </div>
  );
}

export function ConditionEditor({ value, onChange }: {
  value: Condition; onChange(c: Condition): void;
}) {
  const s = useStudio();
  const firstRef = s.def.questions[0]?.id ?? "";

  if (value.type === "rule") {
    return (
      <div className="cond-group">
        <RuleEditor rule={value} onChange={onChange}
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
          <RuleEditor key={i} rule={child}
            onChange={(r) => onChange({ ...g, children: g.children.map((c, j) => (j === i ? r : c)) })}
            onRemove={() => onChange({ ...g, children: g.children.filter((_, j) => j !== i) })} />
        ) : (
          <div key={i}>
            <ConditionEditor value={child}
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
export function OptionalCondition({ label, value, onChange }: {
  label: string; value: Condition | undefined; onChange(c: Condition | undefined): void;
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
      {value && <ConditionEditor value={value} onChange={onChange} />}
    </div>
  );
}

/** Human-readable condition summary for lists/exports. */
export function conditionToText(c: Condition | undefined, def: { questions: { id: string; code: string }[] }): string {
  if (!c) return "";
  if (c.type === "rule") {
    const q = def.questions.find((x) => x.id === c.source.ref);
    const ref = q?.code ?? c.source.ref;
    const op = OPERATORS.find((o) => o.value === c.operator)?.label ?? c.operator;
    const val = NO_VALUE.includes(c.operator) ? "" :
      c.operator === "between" ? ` ${c.value}–${c.value2}` :
      ` ${Array.isArray(c.value) ? c.value.join(",") : String(c.value ?? "")}`;
    return `${ref}${c.source.rowCode ? `[${c.source.rowCode}]` : ""} ${op}${val}`;
  }
  const joiner = c.op === "and" ? " AND " : c.op === "or" ? " OR " : " NOR ";
  const inner = c.children.map((ch) => conditionToText(ch, def)).join(joiner);
  return c.op === "not" ? `NOT(${inner})` : `(${inner})`;
}
