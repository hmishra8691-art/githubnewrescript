"use client";
import React from "react";
import type { Condition, OptionLogic, OptionSourceRule } from "@rescript/schema";
import { isEmptyOptionLogic } from "@rescript/schema";
import { optionLogicSummary } from "@rescript/engine";
import { useStudio } from "./store";
import { ConditionEditor, OptionalCondition, newConditionGroup } from "./ConditionBuilder";

/**
 * Option-level logic editor (reqs §1–4, §12–14).
 *
 * Everything a programmer can do to a single option lives here, built
 * entirely through the UI: always show / always hide / show when / hide when,
 * eligibility, exclusion, prioritisation, randomisation participation and
 * carry forward / carry back. The readable summary at the bottom is the
 * check that what they configured is what they meant.
 */

const VISIBILITY: { value: NonNullable<OptionLogic["visibility"]>; label: string; hint: string }[] = [
  { value: "default", label: "Default", hint: "Shown unless another rule removes it." },
  { value: "always_show", label: "Always show", hint: "Pinned visible — filtering can’t remove it. Ideal for Other / None of the above." },
  { value: "always_hide", label: "Always hide", hint: "Kept in the definition for reference, never displayed." },
  { value: "show_when", label: "Show when…", hint: "Displayed only while the condition holds." },
  { value: "hide_when", label: "Hide when…", hint: "Removed while the condition holds." },
];

/** An "always true" condition — an empty AND group. */
export const EMPTY_CONDITION: Condition = { type: "group", op: "and", children: [] };

function SourceRuleEditor({ title, rule, direction, onChange }: {
  title: string;
  rule: OptionSourceRule | undefined;
  direction: "forward" | "back";
  onChange(r: OptionSourceRule | undefined): void;
}) {
  const s = useStudio();
  if (!rule) {
    return (
      <button className="btn small" disabled={s.def.questions.length === 0}
        onClick={() => onChange({
          direction,
          sourceQuestionId: s.def.questions[0].id,
          which: "selected",
          match: "code",
        })}>
        + {title}
      </button>
    );
  }
  return (
    <div className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
      <span className="flabel" style={{ marginBottom: 0, width: 92 }}>{title}</span>
      <select className="select" style={{ width: 150 }} value={rule.which}
        onChange={(e) => onChange({ ...rule, which: e.target.value as any })}>
        <option value="selected">was selected in</option>
        <option value="not_selected">was NOT selected in</option>
        <option value="displayed">was displayed in</option>
      </select>
      <select className="select grow" value={rule.sourceQuestionId}
        onChange={(e) => onChange({ ...rule, sourceQuestionId: e.target.value })}>
        {s.def.questions.map((q) => <option key={q.id} value={q.id}>{q.code}</option>)}
      </select>
      <select className="select" style={{ width: 110 }} value={rule.match}
        onChange={(e) => onChange({ ...rule, match: e.target.value as any })}>
        <option value="code">match code</option>
        <option value="value">match value</option>
        <option value="label">match label</option>
      </select>
      <button className="btn small danger" onClick={() => onChange(undefined)}>×</button>
    </div>
  );
}

export function OptionLogicEditor({ title, logic, visibleIf, onChange }: {
  title: string;
  logic: OptionLogic | undefined;
  visibleIf: Condition | undefined;
  onChange(patch: { logic?: OptionLogic; visibleIf?: Condition }): void;
}) {
  const s = useStudio();
  const [advanced, setAdvanced] = React.useState(
    !!(logic?.eligibleWhen || logic?.excludeWhen || logic?.prioritizeWhen ||
       logic?.deprioritizeWhen || logic?.randomizeWhen || logic?.carryForward || logic?.carryBack),
  );
  const l: OptionLogic = { visibility: "default", ...(logic ?? {}) } as OptionLogic;
  const starter = () => newConditionGroup(s.def.questions[0]?.id ?? "");
  const hasRows = (c: Condition | undefined) =>
    !!c && (c.type === "rule" || c.children.length > 0);

  const setLogic = (patch: Partial<OptionLogic>) => {
    const next = { ...l, ...patch } as OptionLogic;
    onChange({ logic: isEmptyOptionLogic(next) ? undefined : next });
  };

  const summary = optionLogicSummary(s.def, logic, visibleIf);

  return (
    <div className="option-logic" data-testid="option-logic">
      <div className="row" style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 12 }}>{title}</strong>
        <span className="grow" />
        {!isEmptyOptionLogic(logic) && (
          <button className="btn small danger" onClick={() => onChange({ logic: undefined })}>
            clear all logic
          </button>
        )}
      </div>

      <div className="flabel">Visibility</div>
      <div className="row vis-row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
        {VISIBILITY.map((v) => (
          <label key={v.value} className={`vis-pill ${l.visibility === v.value ? "on" : ""}`} title={v.hint}>
            <input type="radio" name={`vis_${title}`} checked={l.visibility === v.value}
              data-testid={`vis-${v.value}`}
              onChange={() => setLogic({
                visibility: v.value,
                // land on an editable row rather than an empty box
                when: v.value === "show_when" || v.value === "hide_when"
                  ? (hasRows(l.when) ? l.when : starter())
                  : l.when,
              })} />
            {v.label}
          </label>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        {VISIBILITY.find((v) => v.value === l.visibility)?.hint}
      </div>

      {(l.visibility === "show_when" || l.visibility === "hide_when") && (
        <>
          <div className="flabel">{l.visibility === "show_when" ? "SHOW THIS OPTION WHEN" : "HIDE THIS OPTION WHEN"}</div>
          <ConditionEditor perOption value={hasRows(l.when) ? l.when! : starter()}
            onChange={(when) => setLogic({ when })} />
        </>
      )}

      {visibleIf && (
        <div className="chip warn" style={{ margin: "6px 0" }}>
          This option also has a legacy “visible if” condition —
          <button className="btn small" style={{ marginLeft: 6 }}
            onClick={() => onChange({ visibleIf: undefined })}>remove it</button>
        </div>
      )}

      <button className="btn small" style={{ margin: "8px 0" }} onClick={() => setAdvanced((v) => !v)}>
        {advanced ? "▾ hide advanced rules" : "▸ eligibility, exclusion, ordering, carry forward"}
      </button>

      {advanced && (
        <div className="option-logic-adv">
          <OptionalCondition perOption label="Eligible when" value={l.eligibleWhen}
            hint="An extra gate on top of visibility."
            onChange={(c) => setLogic({ eligibleWhen: c })} />
          <OptionalCondition perOption label="Exclude when" value={l.excludeWhen}
            hint="Hard removal — overrides Always Show."
            onChange={(c) => setLogic({ excludeWhen: c })} />
          <OptionalCondition perOption label="Prioritize when (move to top)" value={l.prioritizeWhen}
            onChange={(c) => setLogic({ prioritizeWhen: c })} />
          <OptionalCondition perOption label="Deprioritize when (move to bottom)" value={l.deprioritizeWhen}
            onChange={(c) => setLogic({ deprioritizeWhen: c })} />
          <OptionalCondition perOption label="Randomize when" value={l.randomizeWhen}
            hint="When the condition is false the option stays in its programmed position."
            onChange={(c) => setLogic({ randomizeWhen: c })} />

          <div className="flabel" style={{ marginTop: 10 }}>Carry forward / carry back</div>
          <SourceRuleEditor title="Carry forward" direction="forward" rule={l.carryForward}
            onChange={(r) => setLogic({ carryForward: r })} />
          <SourceRuleEditor title="Carry back" direction="back" rule={l.carryBack}
            onChange={(r) => setLogic({ carryBack: r })} />
          <div className="muted" style={{ fontSize: 11 }}>
            Carry back reads a question asked later; while it is unanswered the rule is skipped,
            so the option is never hidden by a question the respondent hasn’t reached.
          </div>
        </div>
      )}

      {summary.length > 0 && (
        <div className="logic-summary" data-testid="logic-summary">
          {summary.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  );
}
