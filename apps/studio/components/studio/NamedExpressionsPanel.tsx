"use client";
import React from "react";
import type { NamedExpression } from "@rescript/schema";
import { lintNamedExpressions, namedExpressionUsage, conditionSummary } from "@rescript/engine";
import { useStudio, uid } from "./store";
import { OptionalCondition } from "./ConditionBuilder";

/**
 * THE NAMED EXPRESSION LIBRARY (§34, §35).
 *
 * A condition written once and referenced from display logic, skip logic,
 * masking, option logic, auto punch, quota cells, List Fill, loops — anywhere
 * a condition is accepted, which is everywhere, because they all call the same
 * evaluator.
 *
 * Two things this panel does that a plain list would not:
 *
 *   IT SHOWS USAGE. Deleting a definition that four rules depend on is the
 *   one destructive thing here, so every place a macro is used is listed
 *   before the delete button, and the button says how many.
 *
 *   IT SHOWS THE READING. A macro is only worth having if its name and its
 *   meaning agree, and a name is the easiest thing in a survey to let drift.
 *   The condition is summarised in words under the name so the two can be
 *   compared at a glance.
 */
export function NamedExpressionsPanel() {
  const s = useStudio();
  const list: NamedExpression[] = s.def.namedExpressions ?? [];
  const usage = React.useMemo(() => namedExpressionUsage(s.def), [s.def]);
  const problems = React.useMemo(() => lintNamedExpressions(s.def), [s.def]);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const setList = (next: NamedExpression[]) => s.update((d) => { d.namedExpressions = next; });
  const patch = (id: string, p: Partial<NamedExpression>) =>
    setList(list.map((e) => (e.id === id ? { ...e, ...p } : e)));

  const add = () => {
    const id = uid("ne");
    setList([...list, {
      id,
      name: `RULE_${list.length + 1}`,
      /*
       * A new macro starts with a condition that is TRUE for everybody rather
       * than with none at all. An empty condition would evaluate true anyway;
       * making that visible is better than a rule that silently matches
       * everyone while looking unfinished.
       */
      when: { type: "group", op: "and", children: [] },
    }]);
    setOpenId(id);
  };

  const remove = (e: NamedExpression) => {
    const used = usage.get(e.id) ?? [];
    if (used.length && !window.confirm(
      `“${e.name}” is used by ${used.length} rule${used.length === 1 ? "" : "s"}:\n\n`
      + used.slice(0, 8).map((u) => `· ${u.where}`).join("\n")
      + (used.length > 8 ? `\n· …and ${used.length - 8} more` : "")
      + "\n\nThose rules will evaluate to FALSE. Delete it anyway?",
    )) return;
    setList(list.filter((x) => x.id !== e.id));
  };

  /**
   * A name is what a programmer types in the expression editor, so it is
   * normalised the way a constant is: upper snake case, no spaces. Rejecting
   * the input as they type would be worse — this rewrites it on the way in and
   * leaves the caret alone.
   */
  const normaliseName = (raw: string) =>
    raw.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+/, "").slice(0, 60);

  return (
    <div data-testid="named-expressions">
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Named expressions</h3>
        <span className="muted" style={{ fontSize: 13 }}>
          write a condition once, use it everywhere
        </span>
        <span className="grow" />
        <button className="btn small" data-testid="add-named-expression"
          data-command="add-named-expression" onClick={add}>+ Add expression</button>
      </div>

      {list.length === 0 && (
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>
          Nothing yet. A named expression is an ordinary condition with a name —{" "}
          <span className="mono">IS_HIGH_VALUE</span>,{" "}
          <span className="mono">HAS_APPLE</span>. Once one exists you can write{" "}
          <span className="mono">IS_HIGH_VALUE AND HAS_APPLE</span> in any logic builder in
          the platform, and changing the definition changes every rule that uses it.
        </p>
      )}

      {problems.map((p) => (
        <div key={p} className="chip warn qd-note" data-testid="named-expression-problem">{p}</div>
      ))}

      {list.map((e) => {
        const used = usage.get(e.id) ?? [];
        const open = openId === e.id;
        return (
          <div className="card" key={e.id} style={{ padding: "8px 12px", marginBottom: 8 }}
            data-testid="named-expression" data-ne-id={e.id}>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <input
                className="input mono" style={{ maxWidth: 240 }}
                value={e.name}
                data-testid={`ne-name-${e.id}`}
                onChange={(ev) => patch(e.id, { name: normaliseName(ev.target.value) })}
                placeholder="IS_HIGH_VALUE"
              />
              <input
                className="input grow" style={{ minWidth: 180 }}
                value={e.description ?? ""}
                data-testid={`ne-desc-${e.id}`}
                onChange={(ev) => patch(e.id, { description: ev.target.value || undefined })}
                placeholder="what it means, for whoever inherits this survey"
              />
              <span className="chip" data-testid={`ne-usage-${e.id}`}
                title={used.length ? used.map((u) => u.where).join("\n") : "not used yet"}>
                used {used.length}×
              </span>
              <button className="btn small" data-testid={`ne-edit-${e.id}`}
                onClick={() => setOpenId(open ? null : e.id)}>{open ? "done" : "edit"}</button>
              <button className="btn small danger" data-testid={`ne-remove-${e.id}`}
                onClick={() => remove(e)}>×</button>
            </div>

            {/* the reading, so the name and the meaning can be compared */}
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}
              data-testid={`ne-summary-${e.id}`}>
              {conditionSummary(s.def, e.when) || "matches everybody — no conditions yet"}
            </div>

            {open && (
              <div style={{ marginTop: 8 }}>
                <OptionalCondition
                  label={`${e.name} is true when`}
                  value={e.when}
                  onChange={(c) => patch(e.id, { when: c ?? { type: "group", op: "and", children: [] } })}
                />
                {used.length > 0 && (
                  <details style={{ marginTop: 4 }} data-testid={`ne-used-by-${e.id}`}>
                    <summary style={{ cursor: "pointer", fontSize: 12.5 }}>
                      Used by {used.length} rule{used.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="muted" style={{ fontSize: 12.5, margin: "6px 0 0 16px" }}>
                      {used.map((u, i) => <li key={`${u.where}-${i}`}>{u.where}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
