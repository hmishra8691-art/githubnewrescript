"use client";
import React from "react";
import type { Condition, ConditionRule, SkipRule } from "@rescript/schema";

/**
 * SHOW-IF AND SKIP RULES, WRITTEN IN THE ENGINE'S OWN LANGUAGE.
 *
 * What this produces is a `Condition` from `@rescript/schema` — the exact JSON
 * the survey builder writes and `evaluateCondition` reads. Nothing here is an
 * interview dialect. A rule built on this screen could be pasted into a survey
 * and mean the same thing, which is the whole reason to adopt the engine
 * rather than write a second one.
 *
 * ## Deliberately narrower than the survey builder's
 *
 * The Studio's `ConditionBuilder` offers thirty-eight operators over nine
 * kinds of source. An interview has one kind of source that makes sense — an
 * earlier question — and a handful of comparisons an interviewer actually
 * reaches for. So this offers: rules over earlier questions, `and`/`or`
 * between them, and one level of grouping. The output is unrestricted; the
 * input is what the job needs.
 *
 * ## Only EARLIER questions are offered
 *
 * A condition on Q4 that reads Q7 can never be true when Q4 is reached — Q7
 * has not been answered — so the engine hides Q4 for everybody, silently. The
 * picker refuses to offer it, and `forwardReferences` in the package catches
 * anything that got in another way.
 */

export interface EarlierQuestion {
  id: string;
  code: string;
  prompt: string;
  kind: string;
  options: { code: string; label: string }[];
}

/** The comparisons an interviewer reaches for, by the kind of question they point at. */
const OPS_FOR_CHOICE = ["eq", "ne", "in", "notIn", "answered", "unanswered"] as const;
const OPS_FOR_TEXT = ["contains", "notContains", "answered", "unanswered"] as const;
const OPS_FOR_RECORDED = ["answered", "unanswered"] as const;

/** The operator names are the schema's; the words are an interviewer's. */
const OPERATOR_SAY: Record<string, string> = {
  eq: "is", ne: "is not", in: "is one of", notIn: "is none of",
  contains: "contains", notContains: "does not contain",
  answered: "was answered", unanswered: "was not answered",
};

function opsFor(q: EarlierQuestion | undefined): readonly string[] {
  if (!q) return OPS_FOR_RECORDED;
  if (q.kind === "single_choice" || q.kind === "multi_choice") return OPS_FOR_CHOICE;
  if (q.kind === "text" || q.kind === "long_text") return OPS_FOR_TEXT;
  return OPS_FOR_RECORDED;
}
const needsValue = (op: string) => !["answered", "unanswered"].includes(op);
const takesMany = (op: string) => op === "in" || op === "notIn";

const say = (op: string) => OPERATOR_SAY[op] ?? op;

/* ------------------------------------------------------------ helpers */

function emptyRule(earlier: EarlierQuestion[]): ConditionRule {
  const q = earlier[0];
  return {
    type: "rule",
    source: { kind: "question", ref: q?.id ?? "" },
    operator: (opsFor(q)[0] ?? "answered") as ConditionRule["operator"],
    value: undefined,
  };
}

function isGroup(c: Condition): c is Extract<Condition, { type: "group" }> { return c.type === "group"; }

/** A flat top-level `and` group, which is how most conditions start. */
function normalise(c: Condition | null | undefined): Extract<Condition, { type: "group" }> {
  if (!c) return { type: "group", op: "and", children: [] };
  if (isGroup(c)) return c;
  return { type: "group", op: "and", children: [c] };
}

/** Empty groups mean "always", which is what null means — so they collapse to null. */
function denormalise(g: Extract<Condition, { type: "group" }>): Condition | null {
  const kids = g.children.filter((k) => !(isGroup(k) && k.children.length === 0));
  if (!kids.length) return null;
  return { ...g, children: kids };
}

/* ------------------------------------------------------------- pieces */

function RuleRow({ rule, earlier, onChange, onRemove }: {
  rule: ConditionRule;
  earlier: EarlierQuestion[];
  onChange: (r: ConditionRule) => void;
  onRemove: () => void;
}) {
  const q = earlier.find((x) => x.id === rule.source.ref);
  const ops = opsFor(q);
  const op = ops.includes(rule.operator) ? rule.operator : ops[0]!;
  const many = takesMany(op);
  const values: string[] = Array.isArray(rule.value) ? rule.value.map(String) : rule.value != null ? [String(rule.value)] : [];

  return (
    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }} data-testid="logic-rule">
      <select value={rule.source.ref} data-testid="logic-source"
        onChange={(e) => {
          const nq = earlier.find((x) => x.id === e.target.value);
          const nops = opsFor(nq);
          onChange({ ...rule, source: { kind: "question", ref: e.target.value }, operator: nops[0] as ConditionRule["operator"], value: undefined });
        }}>
        {earlier.map((e) => <option key={e.id} value={e.id}>{e.code} — {e.prompt.slice(0, 40)}{e.prompt.length > 40 ? "…" : ""}</option>)}
      </select>

      <select value={op} data-testid="logic-operator"
        onChange={(e) => onChange({ ...rule, operator: e.target.value as ConditionRule["operator"], value: needsValue(e.target.value) ? rule.value : undefined })}>
        {ops.map((o) => <option key={o} value={o}>{say(o)}</option>)}
      </select>

      {needsValue(op) && q && (q.kind === "single_choice" || q.kind === "multi_choice") && (
        many ? (
          <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {q.options.map((o) => (
              <label key={o.code} className="pill" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={values.includes(o.code)}
                  onChange={(e) => onChange({ ...rule, value: e.target.checked ? [...values, o.code] : values.filter((v) => v !== o.code) })} />
                {" "}{o.label}
              </label>
            ))}
          </span>
        ) : (
          <select value={values[0] ?? ""} data-testid="logic-value"
            onChange={(e) => onChange({ ...rule, value: e.target.value })}>
            <option value="">— choose —</option>
            {q.options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
          </select>
        )
      )}
      {needsValue(op) && q && (q.kind === "text" || q.kind === "long_text") && (
        <input value={values[0] ?? ""} placeholder="words to look for" data-testid="logic-value"
          onChange={(e) => onChange({ ...rule, value: e.target.value })} />
      )}

      <button type="button" className="btn small secondary" onClick={onRemove} aria-label="Remove this rule">×</button>
    </div>
  );
}

function GroupEditor({ group, earlier, onChange, depth }: {
  group: Extract<Condition, { type: "group" }>;
  earlier: EarlierQuestion[];
  onChange: (g: Extract<Condition, { type: "group" }>) => void;
  depth: number;
}) {
  const set = (i: number, c: Condition) => onChange({ ...group, children: group.children.map((k, j) => (j === i ? c : k)) });
  const remove = (i: number) => onChange({ ...group, children: group.children.filter((_, j) => j !== i) });

  return (
    <div style={{ borderLeft: depth ? "2px solid var(--line)" : undefined, paddingLeft: depth ? 10 : 0 }}>
      {group.children.length > 1 && (
        <div className="row" style={{ gap: 6, alignItems: "center", marginBottom: 6 }}>
          <span className="tiny muted">Match</span>
          <select value={group.op === "or" ? "or" : "and"} data-testid="logic-op"
            onChange={(e) => onChange({ ...group, op: e.target.value as "and" | "or" })}>
            <option value="and">all of these</option>
            <option value="or">any of these</option>
          </select>
        </div>
      )}
      {group.children.map((child, i) => (
        <div key={i} style={{ marginBottom: 6 }}>
          {isGroup(child)
            ? <GroupEditor group={child} earlier={earlier} depth={depth + 1} onChange={(g) => set(i, g)} />
            : <RuleRow rule={child} earlier={earlier} onChange={(r) => set(i, r)} onRemove={() => remove(i)} />}
        </div>
      ))}
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn small secondary" data-testid="logic-add-rule"
          onClick={() => onChange({ ...group, children: [...group.children, emptyRule(earlier)] })}>
          + condition
        </button>
        {depth === 0 && (
          <button type="button" className="btn small secondary" data-testid="logic-add-group"
            onClick={() => onChange({ ...group, children: [...group.children, { type: "group", op: "or", children: [emptyRule(earlier)] }] })}>
            + group
          </button>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- export */

/**
 * Display logic: when is this question shown at all?
 */
export function ShowIfEditor({ value, earlier, onChange }: {
  value: Condition | null;
  earlier: EarlierQuestion[];
  onChange: (c: Condition | null) => void;
}) {
  const group = normalise(value);
  if (!earlier.length) {
    return <p className="tiny muted">Show-if rules can refer to earlier questions. Add this question after the ones it depends on.</p>;
  }
  return (
    <div data-testid="show-if">
      {group.children.length === 0
        ? <p className="tiny muted" style={{ marginBottom: 6 }}>Always shown. Add a condition to show it only sometimes.</p>
        : <p className="tiny muted" style={{ marginBottom: 6 }}>Shown only when:</p>}
      <GroupEditor group={group} earlier={earlier} depth={0} onChange={(g) => onChange(denormalise(g))} />
    </div>
  );
}

/**
 * Skip logic: after this question is answered, where does the candidate go?
 *
 * Each rule is `when` (a Condition, typically about THIS question's answer)
 * and `target` — a later question, or the end of the interview.
 */
export function SkipRulesEditor({ value, self, later, onChange }: {
  value: SkipRule[];
  self: EarlierQuestion;
  later: EarlierQuestion[];
  onChange: (rules: SkipRule[]) => void;
}) {
  const sources = [self];
  return (
    <div data-testid="skip-rules">
      {value.length === 0 && <p className="tiny muted" style={{ marginBottom: 6 }}>No skip rules — the next question follows.</p>}
      {value.map((rule, i) => (
        <div key={rule.id} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid var(--line)" }} data-testid="skip-rule">
          <p className="tiny muted" style={{ margin: "0 0 4px" }}>When the answer to {self.code}…</p>
          <GroupEditor group={normalise(rule.when)} earlier={sources} depth={0}
            onChange={(g) => onChange(value.map((r, j) => (j === i ? { ...r, when: denormalise(g) ?? { type: "group", op: "and", children: [] } } : r)))} />
          <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 6 }}>
            <span className="tiny muted">go to</span>
            <select value={rule.target.kind === "end" ? "__end" : rule.target.ref ?? ""} data-testid="skip-target"
              onChange={(e) => {
                const v = e.target.value;
                onChange(value.map((r, j) => (j === i
                  ? { ...r, target: v === "__end" ? { kind: "end", status: "complete" } : { kind: "question", ref: v } }
                  : r)));
              }}>
              {later.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.prompt.slice(0, 40)}</option>)}
              <option value="__end">the end of the interview</option>
            </select>
            <button type="button" className="btn small secondary" onClick={() => onChange(value.filter((_, j) => j !== i))}>Remove rule</button>
          </div>
        </div>
      ))}
      <button type="button" className="btn small secondary" data-testid="skip-add"
        onClick={() => onChange([...value, {
          id: `skip_${Math.random().toString(36).slice(2, 8)}`,
          when: { type: "group", op: "and", children: [emptyRule(sources)] },
          target: later[0] ? { kind: "question", ref: later[0].id } : { kind: "end", status: "complete" },
        }])}>
        + skip rule
      </button>
    </div>
  );
}
