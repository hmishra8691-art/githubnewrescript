"use client";
import React from "react";
import type { PunchRule, Question } from "@rescript/schema";
import {
  optionRule, simpleView, parsePunchExpression, formatPunchExpression, allPunchRules,
  formatCondition, PUNCH_ACTION_LABELS, LIST_ACTIONS,
  type SimplePunch, type PunchActionKind,
} from "@rescript/engine";
import { useStudio, uid } from "./store";
import { ConditionEditor } from "./ConditionBuilder";

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

const strip = (s: string) => s.replace(/<[^>]*>/g, "").trim();
const short = (q: Question) => `${q.code} · ${strip(q.text).slice(0, 36) || q.variableName}`;

/** Questions whose answer is a set of option codes — sources and targets. */
const choiceQuestions = (qs: Question[]) => qs.filter((q) => q.options.length > 0);

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
  const qs = choiceQuestions(s.def.questions);
  const simple = simpleView(rule);
  const [mode, setMode] = React.useState<"simple" | "expression">(simple ? "simple" : "expression");
  const [text, setText] = React.useState(() => formatPunchExpression(s.def, target, rule));
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (mode === "expression") setText(formatPunchExpression(s.def, target, rule));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule, target.id]);

  const set = (patch: Partial<SimplePunch>) => {
    if (!simple) return;
    const next = { ...simple, ...patch };
    // switching source question: pick its first option
    if (patch.sourceQuestionId && patch.sourceQuestionId !== simple.sourceQuestionId) {
      const src = qs.find((q) => q.id === patch.sourceQuestionId);
      next.sourceCode = src?.options[0]?.code ?? "";
    }
    s.labelNextEdit?.("edit auto punch rule");
    onChange(optionRule(next, rule.id));
  };

  const applyExpression = () => {
    const r = parsePunchExpression(s.def, text);
    if (r.errors.length) { setErr(r.errors[0].message); return; }
    if (r.rules.length !== 1) { setErr("One rule per row here — a rule with several target questions is added from the box below as separate rows."); return; }
    setErr(null);
    s.labelNextEdit?.("edit auto punch rule");
    const { targetQuestionId, rule: parsed } = r.rules[0];
    const next = { ...parsed, id: rule.id };
    if (targetQuestionId === target.id) onChange(next); else onMove(targetQuestionId, next);
  };

  const source = simple ? qs.find((q) => q.id === simple.sourceQuestionId) : undefined;
  const conditionText = rule.when ? formatCondition(s.def, rule.when) : "always";

  return (
    <div className="card ap-rule" data-testid="ap-rule" style={{ padding: 10 }}>
      <div className="row" style={{ alignItems: "center", marginBottom: 6 }}>
        <span className="muted mono" style={{ fontSize: 11 }} data-testid="ap-rule-text">{formatPunchExpression(s.def, target, rule)}</span>
        <span className="grow" />
        <button className={`btn small ${mode === "simple" ? "primary" : ""}`} data-testid="ap-mode-simple"
          disabled={!simple} title={simple ? "" : "This rule's condition is more than one option — edit it as an expression"}
          onClick={() => setMode("simple")}>Simple</button>
        <button className={`btn small ${mode === "expression" ? "primary" : ""}`} data-testid="ap-mode-expression"
          onClick={() => setMode("expression")}>Expression</button>
        <button className="btn small danger" data-testid="ap-remove" onClick={onRemove} title="Remove this rule">×</button>
      </div>

      {mode === "simple" && simple ? (
        <div className="ap-grid" data-testid="ap-simple">
          <label className="f"><span>If question</span>
            <select className="select" data-testid="ap-source-q" value={simple.sourceQuestionId}
              onChange={(e) => set({ sourceQuestionId: e.target.value })}>
              {qs.map((q) => <option key={q.id} value={q.id}>{short(q)}</option>)}
            </select></label>
          <label className="f"><span>Option</span>
            <select className="select" data-testid="ap-source-opt" value={String(simple.sourceCode)}
              onChange={(e) => set({ sourceCode: e.target.value })}>
              {(source?.options ?? []).map((o) => <option key={String(o.code)} value={String(o.code)}>{o.code}: {strip(o.label).slice(0, 30)}</option>)}
            </select></label>
          <label className="f"><span>Condition</span>
            <select className="select" data-testid="ap-test" value={simple.test}
              onChange={(e) => set({ test: e.target.value as SimplePunch["test"] })}>
              <option value="selected">is selected</option>
              <option value="not_selected">is not selected</option>
            </select></label>
          <label className="f"><span>Then</span>
            <select className="select" data-testid="ap-action" value={simple.action}
              onChange={(e) => set({ action: e.target.value as PunchActionKind, targetCodes: e.target.value === "clear" ? [] : simple.targetCodes })}>
              {ACTIONS.map((a) => <option key={a} value={a}>{PUNCH_ACTION_LABELS[a]}</option>)}
            </select></label>
          <label className="f"><span>In question</span>
            <select className="select" data-testid="ap-target-q" value={target.id}
              onChange={(e) => {
                const t = qs.find((q) => q.id === e.target.value);
                if (!t) return;
                s.labelNextEdit?.("move auto punch rule");
                onMove(t.id, optionRule({ ...simple, targetCodes: simple.action === "clear" ? [] : [t.options[0]?.code ?? ""] }, rule.id));
              }}>
              {qs.map((q) => <option key={q.id} value={q.id}>{short(q)}</option>)}
            </select></label>
          {simple.action !== "clear" && (
            <label className="f"><span>Option{simple.targetCodes.length > 1 ? "s" : ""}</span>
              <select className="select" data-testid="ap-target-opt" multiple={simple.targetCodes.length > 1}
                value={simple.targetCodes.length > 1 ? simple.targetCodes.map(String) : String(simple.targetCodes[0] ?? "")}
                onChange={(e) => {
                  const picked = Array.from(e.target.selectedOptions).map((o) => o.value);
                  set({ targetCodes: picked });
                }}>
                {target.options.map((o) => <option key={String(o.code)} value={String(o.code)}>{o.code}: {strip(o.label).slice(0, 30)}</option>)}
              </select></label>
          )}
          {simple.action !== "clear" && simple.targetCodes.length === 1 && (
            <button className="btn small ghost" style={{ alignSelf: "end" }} data-testid="ap-more-targets"
              title="Punch several options at once"
              onClick={() => {
                const nxt = target.options.find((o) => !simple.targetCodes.map(String).includes(String(o.code)));
                if (nxt) set({ targetCodes: [...simple.targetCodes, nxt.code] });
              }}>+ another option</button>
          )}
        </div>
      ) : (
        <div>
          {!simple && rule.when && (
            <details style={{ marginBottom: 6 }}>
              <summary className="muted" style={{ fontSize: 11, cursor: "pointer" }}>Condition, in the visual builder</summary>
              <ConditionEditor value={rule.when} onChange={(when) => { s.labelNextEdit?.("edit auto punch rule"); onChange({ ...rule, when }); }} />
            </details>
          )}
          <textarea className="ta mono xe-input" data-testid="ap-expression" rows={2} value={text}
            onChange={(e) => { setText(e.target.value); setErr(null); }}
            onBlur={applyExpression}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); applyExpression(); } }} />
          <div className="row" style={{ alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 11 }}>
              IF &lt;condition&gt; THEN SELECT / DESELECT / SHOW / HIDE / ENABLE / DISABLE Q.option[, Q.option] · CLEAR Q — condition: {conditionText}
            </span>
            <span className="grow" />
            <button className="btn small primary" data-testid="ap-apply" onClick={applyExpression}>Apply</button>
          </div>
          {err && <div className="xe-error" data-testid="ap-error" style={{ color: "var(--danger, #b91c1c)", fontSize: 12 }}>{err}</div>}
        </div>
      )}
      {LIST_ACTIONS.has(rule.action) && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
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
        <span className="muted" style={{ fontSize: 11 }}>or type one:</span>
        <input className="input mono grow" data-testid="ap-add-expression" placeholder={example} value={text}
          onChange={(e) => { setText(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") addExpression(); }} />
        <button className="btn small primary" data-testid="ap-add-apply" disabled={!text.trim()} onClick={addExpression}>Add</button>
      </div>
      {err && <div data-testid="ap-add-error" style={{ color: "var(--danger, #b91c1c)", fontSize: 12, marginTop: 4 }}>{err}</div>}
    </div>
  );
}

/** Survey-wide: every option-level rule, on whichever question it lives. */
export function AutoPunchPanel() {
  const s = useStudio();
  const ops = useRuleOps();
  const all = allPunchRules(s.def);
  return (
    <div data-testid="auto-punch-panel">
      <p className="muted" style={{ fontSize: 12 }}>
        “If an option is selected in one question, automatically select (or deselect, show, hide,
        enable, disable) an option in another.” Rules are stored on the question they fill and
        run when that question is reached — or immediately when both are on the same page. The
        condition is ordinary survey logic: AND / OR / NOT and brackets all work.
      </p>
      {all.length === 0 && <div className="muted" style={{ fontSize: 12, margin: "6px 0" }} data-testid="ap-empty">No auto punch rules yet.</div>}
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
  const rules = (q.punches ?? []).filter((r) => simpleView(r) || r.source.kind === "codes");
  return (
    <div data-testid="auto-punch-rows">
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
