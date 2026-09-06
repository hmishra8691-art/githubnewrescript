"use client";
import React from "react";
import type { Condition, ConditionRule } from "@rescript/schema";
import type { VariableMeta } from "@rescript/analytics";

/**
 * THE ANALYTICS FILTER BUILDER (§6, §7). Builds an ordinary survey `Condition`
 * — the same object the survey engine evaluates — from the dictionary's
 * variables, so a saved filter or segment means exactly what the same rule
 * would mean in display logic. AND / OR / NOT groups nest; rules offer the
 * operators that make sense for the variable's role.
 */

const OPS: { op: ConditionRule["operator"]; label: string; roles: string[]; arity: 0 | 1 | 2 | "list" }[] = [
  { op: "eq", label: "equals", roles: ["categorical", "scale", "numeric", "text", "date"], arity: 1 },
  { op: "ne", label: "not equals", roles: ["categorical", "scale", "numeric", "text", "date"], arity: 1 },
  { op: "gt", label: "greater than", roles: ["numeric", "scale"], arity: 1 },
  { op: "gte", label: "greater than or equal", roles: ["numeric", "scale"], arity: 1 },
  { op: "lt", label: "less than", roles: ["numeric", "scale"], arity: 1 },
  { op: "lte", label: "less than or equal", roles: ["numeric", "scale"], arity: 1 },
  { op: "between", label: "between", roles: ["numeric", "scale"], arity: 2 },
  { op: "in", label: "in", roles: ["categorical", "scale"], arity: "list" },
  { op: "notIn", label: "not in", roles: ["categorical", "scale"], arity: "list" },
  { op: "selected", label: "selected", roles: ["multi"], arity: 1 },
  { op: "notSelected", label: "not selected", roles: ["multi"], arity: 1 },
  { op: "containsAny", label: "contains any of", roles: ["multi"], arity: "list" },
  { op: "containsAll", label: "contains all of", roles: ["multi"], arity: "list" },
  { op: "contains", label: "contains text", roles: ["text"], arity: 1 },
  { op: "answered", label: "is answered", roles: ["categorical", "scale", "numeric", "text", "multi", "date"], arity: 0 },
  { op: "unanswered", label: "is unanswered", roles: ["categorical", "scale", "numeric", "text", "multi", "date"], arity: 0 },
];

/** Variables the engine can evaluate a condition on: question-backed ones (system columns are analytics-only). */
export function filterableVariables(vars: VariableMeta[]): VariableMeta[] {
  return vars.filter((v) => v.questionId && v.role !== "complex" && v.role !== "system" && v.optionCode == null);
}

function sourceFor(v: VariableMeta): ConditionRule["source"] {
  return { kind: "question", ref: v.questionId!, ...(v.rowCode ? { rowCode: v.rowCode } : {}) };
}

function variableFor(vars: VariableMeta[], src: ConditionRule["source"]): VariableMeta | undefined {
  return vars.find((v) => v.questionId === src.ref && (src.rowCode ? v.rowCode === src.rowCode : v.rowCode == null && v.optionCode == null));
}

export function newRule(v: VariableMeta): ConditionRule {
  const op = v.role === "multi" ? "selected" : v.role === "numeric" ? "gt" : "eq";
  return { type: "rule", source: sourceFor(v), operator: op, value: v.categories?.[0]?.code ?? "" };
}

function coerce(v: VariableMeta, raw: string): string | number {
  const n = Number(raw);
  return (v.role === "numeric" || v.role === "scale" || (v.categories && v.categories.every((c) => Number.isFinite(Number(c.code))))) && raw !== "" && Number.isFinite(n) ? n : raw;
}

function RuleRow({ rule, vars, onChange, onRemove }: { rule: ConditionRule; vars: VariableMeta[]; onChange: (r: ConditionRule) => void; onRemove: () => void }) {
  const v = variableFor(vars, rule.source) ?? vars[0];
  const ops = OPS.filter((o) => o.roles.includes(v?.role ?? "categorical"));
  const op = OPS.find((o) => o.op === rule.operator) ?? ops[0];
  const cats = v?.categories ?? [];
  const listVal: (string | number)[] = Array.isArray(rule.value) ? rule.value : rule.value != null && rule.value !== "" ? [rule.value] : [];
  return (
    <div className="ax-rule" data-testid="ax-rule">
      <select className="select small" value={v ? v.name : ""} onChange={(e) => { const nv = vars.find((x) => x.name === e.target.value); if (nv) onChange(newRule(nv)); }}>
        {vars.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
      </select>
      <select className="select small" value={op?.op} onChange={(e) => onChange({ ...rule, operator: e.target.value as ConditionRule["operator"], value: OPS.find((o) => o.op === e.target.value)?.arity === "list" ? listVal : rule.value })}>
        {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </select>
      {op?.arity === 1 && (cats.length && v.role !== "text"
        ? <select className="select small" value={String(rule.value ?? "")} onChange={(e) => onChange({ ...rule, value: coerce(v, e.target.value) })}>{cats.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select>
        : <input className="input small" value={String(rule.value ?? "")} onChange={(e) => onChange({ ...rule, value: coerce(v, e.target.value) })} placeholder="value" />)}
      {op?.arity === 2 && <><input className="input small" style={{ width: 80 }} value={String(rule.value ?? "")} onChange={(e) => onChange({ ...rule, value: coerce(v, e.target.value) })} placeholder="from" /><span className="muted">and</span><input className="input small" style={{ width: 80 }} value={String(rule.value2 ?? "")} onChange={(e) => onChange({ ...rule, value2: coerce(v, e.target.value) })} placeholder="to" /></>}
      {op?.arity === "list" && <div className="ax-chips">{cats.map((c) => { const on = listVal.map(String).includes(c.code); return <button key={c.code} type="button" className={`ax-chip ${on ? "on" : ""}`} onClick={() => onChange({ ...rule, value: on ? listVal.filter((x) => String(x) !== c.code) : [...listVal, coerce(v, c.code)] })}>{c.label}</button>; })}</div>}
      <button className="btn small" type="button" onClick={onRemove} title="Remove rule">×</button>
    </div>
  );
}

export function FilterBuilder({ value, onChange, variables, depth = 0 }: { value: Condition; onChange: (c: Condition) => void; variables: VariableMeta[]; depth?: number }) {
  const vars = React.useMemo(() => filterableVariables(variables), [variables]);
  if (value.type === "rule") return <RuleRow rule={value} vars={vars} onChange={onChange} onRemove={() => onChange({ type: "group", op: "and", children: [] })} />;
  const g = value;
  const set = (i: number, c: Condition) => onChange({ ...g, children: g.children.map((x, j) => (j === i ? c : x)) });
  const remove = (i: number) => onChange({ ...g, children: g.children.filter((_, j) => j !== i) });
  return (
    <div className={`ax-group ${depth ? "nested" : ""}`} data-testid="ax-filter-group">
      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        <select className="select small" value={g.op} onChange={(e) => onChange({ ...g, op: e.target.value as "and" | "or" | "not" })} data-testid="ax-group-op">
          <option value="and">ALL of these (AND)</option>
          <option value="or">ANY of these (OR)</option>
          <option value="not">NONE of these (NOT)</option>
        </select>
        <span className="grow" />
        <button className="btn small" type="button" disabled={!vars.length} onClick={() => vars[0] && onChange({ ...g, children: [...g.children, newRule(vars[0])] })} data-testid="ax-add-rule">+ Rule</button>
        {depth < 2 && <button className="btn small" type="button" onClick={() => onChange({ ...g, children: [...g.children, { type: "group", op: "or", children: [] }] })}>+ Group</button>}
      </div>
      {g.children.length === 0 && <div className="muted" style={{ fontSize: 13, padding: "2px 0 6px" }}>{depth ? "Empty group — add a rule." : "No conditions — every respondent is included."}</div>}
      {g.children.map((c, i) => (
        <div key={i} className="ax-group-row">
          {i > 0 && <span className="ax-conj">{g.op === "and" ? "AND" : g.op === "or" ? "OR" : "NOR"}</span>}
          {c.type === "rule" ? <RuleRow rule={c} vars={vars} onChange={(r) => set(i, r)} onRemove={() => remove(i)} /> : <div className="row" style={{ alignItems: "flex-start" }}><div className="grow"><FilterBuilder value={c} onChange={(x) => set(i, x)} variables={variables} depth={depth + 1} /></div><button className="btn small" type="button" onClick={() => remove(i)}>×</button></div>}
        </div>
      ))}
    </div>
  );
}

/** Human summary of a condition, using variable labels. */
export function conditionText(c: Condition | null | undefined, variables: VariableMeta[]): string {
  if (!c) return "";
  if (c.type === "rule") {
    const v = variableFor(variables, c.source);
    const label = v?.label ?? c.source.ref;
    const op = OPS.find((o) => o.op === c.operator)?.label ?? c.operator;
    const name = (code: unknown) => v?.categories?.find((x) => x.code === String(code))?.label ?? String(code);
    const val = Array.isArray(c.value) ? `(${c.value.map(name).join(", ")})` : c.operator === "between" ? `${c.value} and ${c.value2}` : c.value == null || c.value === "" ? "" : name(c.value);
    return `${label} ${op} ${val}`.trim();
  }
  const inner = c.children.map((x) => conditionText(x, variables)).filter(Boolean);
  if (!inner.length) return "";
  const joined = inner.map((t) => (t.includes(" AND ") || t.includes(" OR ") ? `(${t})` : t)).join(c.op === "and" ? " AND " : c.op === "or" ? " OR " : " NOR ");
  return c.op === "not" ? `NOT (${joined})` : joined;
}

export const emptyCondition = (): Condition => ({ type: "group", op: "and", children: [] });
export const isEmptyCondition = (c: Condition | null | undefined): boolean => !c || (c.type === "group" && c.children.every(isEmptyCondition));
