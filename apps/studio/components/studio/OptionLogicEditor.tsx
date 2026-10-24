"use client";
import React from "react";
import type { Condition, OptionLogic, OptionPopup, OptionSourceRule } from "@rescript/schema";
import { isEmptyOptionLogic, migrateOptionVisibility } from "@rescript/schema";
import { optionLogicSummary } from "@rescript/engine";
import { useStudio } from "./store";
import { ConditionEditor, OptionalCondition } from "./ConditionBuilder";

/**
 * Option-level logic editor (reqs §1–4, §12–14).
 *
 * Everything a programmer can do to a single option lives here, built
 * entirely through the UI: always show / always hide, eligibility (the old
 * "Show when…"), exclusion (the old "Hide when…"), prioritisation, randomisation participation and
 * carry forward / carry back. The readable summary at the bottom is the
 * check that what they configured is what they meant.
 */

const VISIBILITY: { value: NonNullable<OptionLogic["visibility"]>; label: string; hint: string }[] = [
  { value: "default", label: "Default", hint: "Shown unless another rule removes it." },
  { value: "always_show", label: "Always show", hint: "Pinned visible — filtering can’t remove it. Ideal for Other / None of the above." },
  { value: "always_hide", label: "Always hide", hint: "Kept in the definition for reference, never displayed." },
];
/*
 * "Show when…" and "Hide when…" are gone from the pills: they were exactly
 * "Eligible when" and "Exclude when" under two more names, and having both
 * meant the same rule could be written in two places that disagreed. A saved
 * option that still carries one is migrated into the equivalent rule (the
 * store does it on load; the editor does it again defensively below).
 */

const POPUP_TYPES: { value: OptionPopup["type"]; label: string; hint: string }[] = [
  { value: "information", label: "Information", hint: "A note the respondent acknowledges." },
  { value: "warning", label: "Warning", hint: "A caution the respondent acknowledges." },
  { value: "confirmation", label: "Confirmation", hint: "Continue or Cancel. Cancel on a Next-triggered message keeps the respondent on the page." },
];

const DEFAULT_POPUP: OptionPopup = {
  enabled: true, message: "", type: "information", trigger: "immediate", frequency: "every",
};

/** "Show Popup Message When Selected" — the controls appear only once it is switched on. */
function PopupEditor({ popup, onChange }: { popup: OptionPopup | undefined; onChange(p: OptionPopup | undefined): void }) {
  const p = popup;
  const on = !!p?.enabled;
  const set = (patch: Partial<OptionPopup>) => onChange({ ...(p ?? DEFAULT_POPUP), ...patch });
  const empty = on && !p!.message.trim();
  return (
    <div style={{ margin: "10px 0" }} data-testid="popup-editor">
      <label className="row" style={{ gap: 6, cursor: "pointer" }}>
        <input type="checkbox" data-testid="popup-enabled" checked={on}
          onChange={(e) => (e.target.checked ? set({ enabled: true }) : p && onChange({ ...p, enabled: false }))} />
        <span className="flabel" style={{ margin: 0 }}>Show Popup Message When Selected</span>
      </label>
      {on && (
        <div className="card" style={{ marginTop: 6, padding: 8 }} data-testid="popup-fields">
          <div className="flabel">Message</div>
          <textarea className="textarea" rows={3} data-testid="popup-message" value={p!.message}
            placeholder="What the respondent should see…"
            onChange={(e) => set({ message: e.target.value })} />
          {empty && <div style={{ color: "var(--amber, #b45309)", fontSize: 12.5 }} data-testid="popup-empty">
            Add a message — an empty popup is never shown.</div>}
          <div className="flabel" style={{ marginTop: 8 }}>Title (optional)</div>
          <input className="input" data-testid="popup-title" value={p!.title ?? ""}
            onChange={(e) => set({ title: e.target.value || undefined })} />
          <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            <div>
              <div className="flabel">Popup type</div>
              <select className="select" data-testid="popup-type" value={p!.type}
                title={POPUP_TYPES.find((t) => t.value === p!.type)?.hint}
                onChange={(e) => set({ type: e.target.value as OptionPopup["type"] })}>
                {POPUP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <div className="flabel">Trigger</div>
              <select className="select" data-testid="popup-trigger" value={p!.trigger}
                onChange={(e) => set({ trigger: e.target.value as OptionPopup["trigger"] })}>
                <option value="immediate">Immediately when selected</option>
                <option value="on_next">When the respondent clicks Next</option>
              </select>
            </div>
            <div>
              <div className="flabel">Show</div>
              <select className="select" data-testid="popup-frequency" value={p!.frequency}
                onChange={(e) => set({ frequency: e.target.value as OptionPopup["frequency"] })}>
                <option value="every">Every selection</option>
                <option value="once">Only once</option>
              </select>
            </div>
            <div>
              <div className="flabel">Button text</div>
              <input className="input" data-testid="popup-button" style={{ width: 130 }}
                placeholder={p!.type === "confirmation" ? "Continue" : "OK"} value={p!.buttonText ?? ""}
                onChange={(e) => set({ buttonText: e.target.value || undefined })} />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            Deselecting never shows a message and the option is never deselected for the respondent.
            This works alongside every other rule on the option.
          </div>
        </div>
      )}
    </div>
  );
}

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

/**
 * The older `visibleIf` gate, folded into option logic with the same meaning:
 * it is an extra "Eligible when" gate — which is exactly where
 * `eligibilityVerdict` evaluates it ("Show when…" no longer exists as its own
 * mode; it was this rule under another name).
 */
export function absorbLegacyVisibleIf(l: OptionLogic, visibleIf: Condition): OptionLogic {
  const and = (a: Condition | undefined, b: Condition): Condition =>
    a && !(a.type === "group" && a.children.length === 0) ? { type: "group", op: "and", children: [a, b] } : b;
  return { ...l, eligibleWhen: and(l.eligibleWhen, visibleIf) };
}

export function OptionLogicEditor({ title, logic, visibleIf, onChange }: {
  title: string;
  logic: OptionLogic | undefined;
  visibleIf: Condition | undefined;
  onChange(patch: { logic?: OptionLogic; visibleIf?: Condition }): void;
}) {
  const s = useStudio();
  /*
   * Opening the Logic panel lands straight on the Advanced Rules. The rules
   * people came for (Eligible / Exclude / popup …) used to sit behind a
   * second click on a collapsed toggle; the toggle stays so it can be folded
   * away, but the panel starts open.
   */
  const [advanced, setAdvanced] = React.useState(true);
  /* an option saved with "Show when…"/"Hide when…" is read as the Eligible/Exclude rule it always meant */
  const migrated = logic ? migrateOptionVisibility(logic) : null;
  const l: OptionLogic = { visibility: "default", ...((migrated?.logic ?? logic) ?? {}) } as OptionLogic;
  React.useEffect(() => {
    if (logic && migrated?.changed) onChange({ logic: isEmptyOptionLogic(migrated.logic) ? undefined : migrated.logic });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [migrated?.changed]);

  const setLogic = (patch: Partial<OptionLogic>) => {
    const next = { ...l, ...patch } as OptionLogic;
    onChange({ logic: isEmptyOptionLogic(next) ? undefined : next });
  };

  const summary = optionLogicSummary(s.def, logic, visibleIf);

  return (
    <div className="option-logic" data-testid="option-logic">
      <div className="row" style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
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
              })} />
            {v.label}
          </label>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        {VISIBILITY.find((v) => v.value === l.visibility)?.hint}
      </div>

      {visibleIf && (
        /*
         * The older "visible if" field. It still runs (an extra gate on top of
         * everything above), so it is SHOWN and editable here — it used to be a
         * chip saying it existed, with only a way to delete it unseen. "Convert"
         * moves it into the visibility rules without changing what it does.
         */
        <div className="card" style={{ margin: "6px 0", padding: 8, borderColor: "var(--amber)" }} data-testid="legacy-visibleif">
          <div className="row" style={{ marginBottom: 4, flexWrap: "wrap" }}>
            <span className="flabel" style={{ margin: 0 }}>ALSO SHOWN ONLY WHEN (older “visible if”)</span>
            <span className="grow" />
            <button className="btn small" data-testid="legacy-visibleif-convert"
              title="Move this condition into “Eligible when” — same behaviour, one place"
              onClick={() => onChange({ logic: absorbLegacyVisibleIf(l, visibleIf), visibleIf: undefined })}>convert</button>
            <button className="btn small danger" onClick={() => onChange({ visibleIf: undefined })}>remove it</button>
          </div>
          <ConditionEditor perOption value={visibleIf} onChange={(c) => onChange({ visibleIf: c })}
            workspace={{ title: "Option display logic (legacy “show when”)", subject: title, description: "Show this option only when the following condition is met:" }} />
        </div>
      )}

      <button className="btn small" style={{ margin: "8px 0" }} onClick={() => setAdvanced((v) => !v)}>
        {advanced ? "▾ hide advanced rules" : "▸ advanced rules: eligibility, exclusion, ordering, popup, carry forward"}
      </button>

      {advanced && (
        <div className="option-logic-adv">
          <div data-testid="adv-eligible"><OptionalCondition perOption label="Eligible when" value={l.eligibleWhen}
            hint="The option is shown only while this holds (what “Show when…” used to do)."
            workspace={{ title: "Option logic — eligible when", subject: title, description: "Show this option only while the following condition is met:" }}
            onChange={(c) => setLogic({ eligibleWhen: c })} /></div>
          <div data-testid="adv-exclude"><OptionalCondition perOption label="Exclude when" value={l.excludeWhen}
            hint="The option is removed while this holds — overrides Always Show (what “Hide when…” used to do)."
            workspace={{ title: "Option logic — exclude when", subject: title, description: "Remove this option while the following condition is met:" }}
            onChange={(c) => setLogic({ excludeWhen: c })} /></div>
          <div data-testid="adv-prioritize"><OptionalCondition perOption label="Prioritize when (move to top)" value={l.prioritizeWhen}
            workspace={{ title: "Option logic — prioritize when", subject: title, description: "Move this option to the top while the following condition is met:" }}
            onChange={(c) => setLogic({ prioritizeWhen: c })} /></div>
          <div data-testid="adv-deprioritize"><OptionalCondition perOption label="Deprioritize when (move to bottom)" value={l.deprioritizeWhen}
            workspace={{ title: "Option logic — deprioritize when", subject: title, description: "Move this option to the bottom while the following condition is met:" }}
            onChange={(c) => setLogic({ deprioritizeWhen: c })} /></div>
          <div data-testid="adv-randomize"><OptionalCondition perOption label="Randomize when" value={l.randomizeWhen}
            hint="When the condition is false the option stays in its programmed position."
            workspace={{ title: "Option logic — randomize when", subject: title, description: "Randomize this option's position only while the following condition is met:" }}
            onChange={(c) => setLogic({ randomizeWhen: c })} /></div>

          <PopupEditor popup={l.popup} onChange={(popup) => setLogic({ popup })} />

          <div className="flabel" style={{ marginTop: 10 }}>Carry forward / carry back</div>
          <SourceRuleEditor title="Carry forward" direction="forward" rule={l.carryForward}
            onChange={(r) => setLogic({ carryForward: r })} />
          <SourceRuleEditor title="Carry back" direction="back" rule={l.carryBack}
            onChange={(r) => setLogic({ carryBack: r })} />
          <div className="muted" style={{ fontSize: 12.5 }}>
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
