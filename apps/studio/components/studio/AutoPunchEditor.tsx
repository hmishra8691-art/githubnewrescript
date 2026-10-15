"use client";
import React from "react";
import type { PunchRule, Question } from "@rescript/schema";
import {
  optionRule, simpleView, parsePunchExpression, formatPunchExpression, allPunchRules, applyParsedPunch,
  isVacuousCondition,
  formatCondition, PUNCH_ACTION_LABELS, LIST_ACTIONS, isOptionLevelPunch,
  type PunchActionKind,
  stripHtmlText,
} from "@rescript/engine";
import { useStudio, uid } from "./store";
import { ConditionEditor } from "./ConditionBuilder";
import { CheckboxDropdown } from "./CheckboxDropdown";
import { isMultiValuedQuestion } from "@rescript/schema";
import { lintPunchChain } from "@rescript/engine";

/**
 * Option-level auto punching — "if Q1 · Product A is selected → select Q2 ·
 * Product B" — edited two ways over ONE stored form.
 *
 * The stored form is the existing `PunchRule` on the target question (see
 * engine/autoPunch.ts): a literal code set plus the ordinary `when`
 * Condition. There is no second rule type and no second evaluator; the visual
 * row and the IF … THEN text are both views of that rule, so a rule typed as
 * an expression shows up in the simple row when it is simple enough, and a
 * simple rule prints as an expression on request.
 *
 *   <AutoPunchPanel />          the survey-wide list (Logic tab): every rule,
 *                               whatever question it lives on, add / edit /
 *                               remove, with an expression box for the
 *                               complex ones.
 *   <AutoPunchRows q={q} />     the same rules filtered to one target question
 *                               (inside the question's masking section).
 */

const strip = (s: string) => stripHtmlText(s);

/** Questions whose answer is a set of option codes — the targets (and choice sources). */
const choiceQuestions = (qs: Question[]) => qs.filter((q) => q.options.length > 0);

/** the option code as the question stores it (a number stays a number) */
const codeOf = (q: Question, v: string): string | number => q.options.find((o) => String(o.code) === v)?.code ?? v;

/**
 * THE OPTIONS A RULE ACTS ON, picked from the TARGET question's own list.
 * A question that holds one answer, punched with "select", can take one
 * option — a single-choice dropdown. Every other case (a multi-select target,
 * or show / hide / enable / disable, which are about lists) can act on several
 * — a dropdown of checkboxes. Never a scrolling list box.
 */
function TargetOptions({ target, action, codes, onChange, testId }: {
  target: Question; action: string; codes: (string | number)[]; onChange(codes: (string | number)[]): void; testId: string;
}) {
  const options = target.options.map((o) => ({ value: String(o.code), label: `${o.code}: ${strip(o.label).slice(0, 40)}` }));
  const single = action === "select" && !isMultiValuedQuestion(target);
  if (single) {
    return (
      <select className="select" data-testid={testId} value={String(codes[0] ?? "")}
        onChange={(e) => onChange(e.target.value === "" ? [] : [codeOf(target, e.target.value)])}>
        <option value="">— select option —</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  return (
    <CheckboxDropdown testId={testId} options={options} values={codes.map(String)} placeholder="Select options"
      ariaLabel={`Options in ${target.code}`}
      onChange={(vals) => onChange(vals.map((v) => codeOf(target, v)))} />
  );
}

const ACTIONS: PunchActionKind[] = ["select", "deselect", "show", "hide", "enable", "disable", "clear"];

/* ------------------------------------------------------------ one rule row */

function SimpleRow({ target, rule, onChange, onMove, onRemove }: {
  target: Question;
  rule: PunchRule;
  onChange(next: PunchRule): void;
  /** the rule lives on a different target now */
  onMove(targetId: string, next: PunchRule): void;
  onRemove(): void;
}) {
  const s = useStudio();
  /*
   * Two views of one rule. "builder" (the default — the old "Simple" row is gone) is the visual AND / OR / NOT editor for
   * the condition: a nested condition (Q2.1 AND Q2.2, Q2.1 BUT NOT Q2.2) could
   * only be typed before — the builder sat collapsed under the expression box
   * and was not offered at all for a rule with no condition yet. Its tab, and
   * "+ add condition" in Simple mode, open it.
   */
  const [mode, setMode] = React.useState<"expression" | "builder">("builder");
  const [text, setText] = React.useState(() => formatPunchExpression(s.def, target, rule));
  const [err, setErr] = React.useState<string | null>(null);

  /*
   * The expression is a RENDERING of the definition, not a second copy of it.
   *
   * This used to resync only when `rule` or `target.id` changed, and only
   * while the expression tab was open — so an expression naming Q5 went on
   * reading "Q5" after Q5 was renamed, retyped or deleted elsewhere in the
   * Studio, and a programmer who then pressed Apply wrote the stale text
   * back over the rule. `s.def` is in the dependencies now (it is a new
   * object on every edit, which is exactly the signal wanted), and the text
   * is refreshed whichever tab is open, so switching to the expression can
   * never show something the definition no longer says.
   */
  React.useEffect(() => {
    setText(formatPunchExpression(s.def, target, rule));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.def, rule, target.id]);

  const applyExpression = () => {
    const r = parsePunchExpression(s.def, text);
    if (r.errors.length) { setErr(r.errors[0].message); return; }
    if (r.rules.length !== 1) { setErr("One rule per row here — a rule with several target questions is added from the box below as separate rows."); return; }
    setErr(null);
    s.labelNextEdit?.("edit auto punch rule");
    const { targetQuestionId, rule: parsed } = r.rules[0];
    const next = applyParsedPunch(rule, parsed);
    /* blur after no edit is not an edit — rewriting the rule would add an
       undo step and normalise a rule nobody touched */
    if (targetQuestionId === target.id && JSON.stringify(next) === JSON.stringify(rule)) return;
    if (targetQuestionId === target.id) onChange(next); else onMove(targetQuestionId, next);
  };

  const conditionText = rule.when ? formatCondition(s.def, rule.when) : "always";

  return (
    <div className="card ap-rule" data-testid="ap-rule" style={{ padding: 10 }}>
      {/*
        * A dedicated header class, not the generic `.row` — `.row` has no
        * `flex-wrap`, and this row combines an unbounded-length rule-text
        * span with three nowrap buttons. Once the row was narrower than its
        * content, flex-shrink squeezed the buttons below their own text's
        * natural width; the text itself can't reflow (`white-space: nowrap`
        * on `.btn`), so it overflowed the shrunk box and visually
        * overlapped the next button ("SimplExpression"). `.ap-rule-head`
        * lets the row wrap instead, and `.ap-rule-actions` keeps the
        * mode/remove buttons together as one non-shrinking group so they
        * wrap as a unit rather than splitting mid-text.
        */}
      <div className="ap-rule-head" style={{ marginBottom: 6 }}>
        {/*
          * IF / ELSE IF / ELSE (§8, §23), on the rule itself.
          *
          * A chain is an ADJACENCY, not a new object: consecutive rules form
          * one chain and the first match wins. So the control belongs on the
          * rule rather than in a wrapper — and "if" is what every existing
          * rule already is, which is why the default reads as no change.
          *
          * An ELSE has no condition of its own: reaching it IS the condition.
          * The editors below are hidden for one, because a condition that is
          * ignored is worse than no field at all.
          */}
        <select
          className="select small ap-mode" data-testid="ap-chain-mode"
          aria-label="How this rule relates to the one above"
          value={rule.mode ?? "if"}
          onChange={(e) => {
            const mode = e.target.value as "if" | "else_if" | "else";
            s.labelNextEdit?.("change auto punch chain");
            onChange({
              ...rule,
              mode,
              /* an ELSE's condition would be ignored, so it is dropped rather
                 than left to mislead whoever reads the rule next */
              when: mode === "else" ? undefined : rule.when,
            });
          }}
        >
          <option value="if">IF</option>
          <option value="else_if">ELSE IF</option>
          <option value="else">ELSE</option>
        </select>
        <span className="muted mono ap-rule-text" style={{ fontSize: 12.5 }}
          data-testid="ap-rule-text" title={formatPunchExpression(s.def, target, rule)}>
          {formatPunchExpression(s.def, target, rule)}
        </span>
        <span className="ap-rule-actions">
          <button className={`btn small ${mode === "builder" ? "primary" : ""}`} data-testid="ap-mode-builder"
            title="Build the condition with AND / OR / NOT groups"
            onClick={() => setMode("builder")}>Builder</button>
          <button className={`btn small ${mode === "expression" ? "primary" : ""}`} data-testid="ap-mode-expression"
            onClick={() => setMode("expression")}>Expression</button>
          <button className="btn small danger" data-testid="ap-remove" onClick={onRemove} title="Remove this rule">×</button>
        </span>
      </div>

      {rule.mode === "else" ? (
        <div className="ap-grid" data-testid="ap-else">
          <p className="muted" style={{ fontSize: 12.5, margin: 0, gridColumn: "1 / -1" }}>
            Runs when every rule above it in this chain failed. It has no condition of its own —
            being reached is the condition.
          </p>
          <label className="f"><span>Then</span>
            <select className="select" data-testid="ap-else-action" value={rule.action}
              onChange={(e) => onChange({ ...rule, action: e.target.value as never })}>
              {ACTIONS.map((a) => <option key={a} value={a}>{PUNCH_ACTION_LABELS[a]}</option>)}
            </select></label>
          <label className="f"><span>Options</span>
            <TargetOptions target={target} action={rule.action} testId="ap-else-target"
              codes={rule.source.kind === "codes" ? rule.source.codes : []}
              onChange={(codes) => onChange({ ...rule, source: { kind: "codes", codes } })} /></label>
        </div>
      ) : mode === "builder" ? (
        <div data-testid="ap-builder">
          <div className="flabel" style={{ marginBottom: 4 }}>{rule.mode === "else_if" ? "ELSE IF" : "IF"}</div>
          <ConditionEditor value={rule.when ?? { type: "group", op: "and", children: [] }}
            onChange={(when) => {
              s.labelNextEdit?.("edit auto punch rule");
              const next = { ...rule };
              /* an empty builder is "always" — stored as no condition, the way an
                 IF … THEN with no condition has always been stored */
              if (isVacuousCondition(when)) delete (next as { when?: unknown }).when; else next.when = when;
              onChange(next);
            }} />
          <div className="ap-grid" style={{ marginTop: 8 }}>
            <label className="f"><span>Then</span>
              <select className="select" data-testid="ap-builder-action" value={rule.action}
                onChange={(e) => {
                  const action = e.target.value as never;
                  const held = rule.source.kind === "codes" ? rule.source.codes : [];
                  /* a one-answer question can be punched with ONE option; moving to "select" keeps the first */
                  const trim = String(action) === "select" && !isMultiValuedQuestion(target) && held.length > 1;
                  onChange({ ...rule, action, ...(String(action) === "clear" ? { source: { kind: "codes", codes: [] } } : trim ? { source: { kind: "codes", codes: held.slice(0, 1) } } : {}) });
                }}>
                {ACTIONS.map((a) => <option key={a} value={a}>{PUNCH_ACTION_LABELS[a]}</option>)}
              </select></label>
            {rule.action !== "clear" && (
              <label className="f"><span>Options in {target.code}</span>
                <TargetOptions target={target} action={rule.action} testId="ap-builder-target"
                  codes={rule.source.kind === "codes" ? rule.source.codes : []}
                  onChange={(codes) => onChange({ ...rule, source: { kind: "codes", codes } })} /></label>
            )}
          </div>
          {!rule.when && <div className="muted" style={{ fontSize: 12.5 }} data-testid="ap-builder-always">No condition — this rule runs for every respondent who reaches {target.code}.</div>}
        </div>
      ) : (
        <div>
          <textarea className="ta mono xe-input" data-testid="ap-expression" rows={2} value={text}
            onChange={(e) => { setText(e.target.value); setErr(null); }}
            onBlur={applyExpression}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); applyExpression(); } }} />
          <div className="row" style={{ alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              IF &lt;condition&gt; THEN SELECT / DESELECT / SHOW / HIDE / ENABLE / DISABLE Q.option[, Q.option] · CLEAR Q — condition: {conditionText}
            </span>
            <span className="grow" />
            <button className="btn small primary" data-testid="ap-apply" onClick={applyExpression}>Apply</button>
          </div>
          {err && <div className="xe-error" data-testid="ap-error" style={{ color: "var(--danger, #b91c1c)", fontSize: 13 }}>{err}</div>}
        </div>
      )}
      {LIST_ACTIONS.has(rule.action) && (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
          Changes what the respondent sees in {target.code}; the answer itself is untouched.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the list */

function useRuleOps() {
  const s = useStudio();
  const replaceRule = (targetId: string, next: PunchRule) =>
    s.update((d) => {
      const t = d.questions.find((q) => q.id === targetId);
      if (!t) return;
      t.punches = (t.punches ?? []).map((r) => (r.id === next.id ? next : r));
    });
  const moveRule = (fromId: string, toId: string, next: PunchRule) =>
    s.update((d) => {
      const from = d.questions.find((q) => q.id === fromId);
      const to = d.questions.find((q) => q.id === toId);
      if (!from || !to) return;
      from.punches = (from.punches ?? []).filter((r) => r.id !== next.id);
      to.punches = [...(to.punches ?? []), next];
    });
  const removeRule = (targetId: string, id: string) =>
    s.update((d) => {
      const t = d.questions.find((q) => q.id === targetId);
      if (t) t.punches = (t.punches ?? []).filter((r) => r.id !== id);
    });
  const addRules = (rules: { targetQuestionId: string; rule: PunchRule }[]) =>
    s.update((d) => {
      for (const { targetQuestionId, rule } of rules) {
        const t = d.questions.find((q) => q.id === targetQuestionId);
        if (t) t.punches = [...(t.punches ?? []), rule];
      }
    });
  return { replaceRule, moveRule, removeRule, addRules };
}

function AddRule({ defaultTarget }: { defaultTarget?: Question }) {
  const s = useStudio();
  const ops = useRuleOps();
  const qs = choiceQuestions(s.def.questions);
  const [text, setText] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  const addSimple = () => {
    const target = defaultTarget ?? qs[1] ?? qs[0];
    const source = qs.find((q) => q.id !== target?.id) ?? qs[0];
    if (!target || !source) return;
    s.labelNextEdit?.("add auto punch rule");
    ops.addRules([{
      targetQuestionId: target.id,
      rule: optionRule({
        sourceQuestionId: source.id, sourceCode: source.options[0]?.code ?? "", test: "selected",
        action: "select", targetCodes: [target.options[0]?.code ?? ""],
      }, uid("punch")),
    }]);
  };

  const addExpression = () => {
    const r = parsePunchExpression(s.def, text);
    if (r.errors.length) { setErr(r.errors[0].message); return; }
    if (r.rules.length === 0) { setErr("Nothing to add."); return; }
    if (defaultTarget && r.rules.some((x) => x.targetQuestionId !== defaultTarget.id)) {
      setErr(`This box adds rules for ${defaultTarget.code} — use the Logic tab for other targets.`);
      return;
    }
    setErr(null);
    s.labelNextEdit?.("add auto punch rule");
    ops.addRules(r.rules);
    setText("");
  };

  const example = (() => {
    const src = qs[0]; const tgt = defaultTarget ?? qs[1] ?? qs[0];
    if (!src || !tgt) return "IF Q1.A IS SELECTED THEN SELECT Q2.B";
    return `IF ${src.code}.${String(src.options[0]?.code ?? "1")} IS SELECTED THEN SELECT ${tgt.code}.${String(tgt.options[0]?.code ?? "1")}`;
  })();

  return (
    <div className="ap-add" data-testid="ap-add">
      <div className="row" style={{ alignItems: "center" }}>
        <button className="btn small" data-testid="ap-add-simple" disabled={qs.length === 0} onClick={addSimple}>+ auto punch rule</button>
        <span className="muted" style={{ fontSize: 12.5 }}>or type one:</span>
        <input className="input mono grow" data-testid="ap-add-expression" placeholder={example} value={text}
          onChange={(e) => { setText(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") addExpression(); }} />
        <button className="btn small primary" data-testid="ap-add-apply" disabled={!text.trim()} onClick={addExpression}>Add</button>
      </div>
      {err && <div data-testid="ap-add-error" style={{ color: "var(--danger, #b91c1c)", fontSize: 13, marginTop: 4 }}>{err}</div>}
    </div>
  );
}

/** Survey-wide: every option-level rule, on whichever question it lives. */
export function AutoPunchPanel() {
  const s = useStudio();
  const ops = useRuleOps();
  // Only option-level rules round-trip through this DSL (see
  // `isOptionLevelPunch`); a matrix/composite cell rule or one carrying an
  // explicit priority is edited from its question's "Auto-select from a
  // set" section instead, where the address and priority have real controls.
  const all = allPunchRules(s.def).filter(({ rule }) => isOptionLevelPunch(rule) || simpleView(rule));
  return (
    <div data-testid="auto-punch-panel">
      <p className="muted" style={{ fontSize: 13 }}>
        “If an option is selected in one question, automatically select (or deselect, show, hide,
        enable, disable) an option in another.” Rules are stored on the question they fill and
        run when that question is reached — or immediately when both are on the same page. The
        condition is ordinary survey logic: AND / OR / NOT and brackets all work.
      </p>
      {all.length === 0 && <div className="muted" style={{ fontSize: 13, margin: "6px 0" }} data-testid="ap-empty">No auto punch rules yet.</div>}
      {all.map(({ target, rule }) => (
        <SimpleRow key={rule.id} target={target} rule={rule}
          onChange={(next) => ops.replaceRule(target.id, next)}
          onMove={(toId, next) => ops.moveRule(target.id, toId, next)}
          onRemove={() => { s.labelNextEdit?.("remove auto punch rule"); ops.removeRule(target.id, rule.id); }} />
      ))}
      <AddRule />
    </div>
  );
}

/** The rules that fill one question — for that question's editor. */
export function AutoPunchRows({ q }: { q: Question }) {
  const s = useStudio();
  const ops = useRuleOps();
  const rules = (q.punches ?? []).filter((r) => simpleView(r) || isOptionLevelPunch(r));
  /*
   * Chain problems the engine cannot refuse: an ELSE carrying a condition
   * that will be ignored, an ELSE IF with none, a rule stranded after the
   * ELSE. Each evaluates perfectly well and produces a rule that never runs,
   * which is exactly the class of thing that has to be read rather than run.
   */
  const chainProblems = lintPunchChain(
    q.punches ?? [],
    (r, i) => `Rule ${i + 1}${r.label ? ` (${r.label})` : ""}`,
  );
  return (
    <div data-testid="auto-punch-rows">
      {chainProblems.map((p) => (
        <div key={p} className="chip warn qd-note" data-testid="ap-chain-problem">{p}</div>
      ))}
      {rules.map((rule) => (
        <SimpleRow key={rule.id} target={q} rule={rule}
          onChange={(next) => ops.replaceRule(q.id, next)}
          onMove={(toId, next) => ops.moveRule(q.id, toId, next)}
          onRemove={() => { s.labelNextEdit?.("remove auto punch rule"); ops.removeRule(q.id, rule.id); }} />
      ))}
      <AddRule defaultTarget={q} />
    </div>
  );
}
