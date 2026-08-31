"use client";
import React from "react";
import type { Question, ValidationRule, SkipRule } from "@rescript/schema";
import { validateExpression, lintPipingTokens } from "@rescript/engine";
import { useStudio, selectedQuestion, uid } from "./store";
import { OptionalCondition, ConditionEditor, conditionToText } from "./ConditionBuilder";

const VALIDATION_KINDS: { value: ValidationRule["kind"]; label: string; hasValue: boolean }[] = [
  { value: "required", label: "required", hasValue: false },
  { value: "min_value", label: "min value", hasValue: true },
  { value: "max_value", label: "max value", hasValue: true },
  { value: "min_length", label: "min length", hasValue: true },
  { value: "max_length", label: "max length", hasValue: true },
  { value: "min_selections", label: "min selections", hasValue: true },
  { value: "max_selections", label: "max selections", hasValue: true },
  { value: "sum_equals", label: "sum equals", hasValue: true },
  { value: "sum_max", label: "sum ≤", hasValue: true },
  { value: "sum_min", label: "sum ≥", hasValue: true },
  { value: "pattern", label: "regex pattern", hasValue: true },
  { value: "email", label: "email", hasValue: false },
  { value: "integer", label: "whole number", hasValue: false },
  { value: "custom_expression", label: "expression (calc DSL)", hasValue: true },
];

function ValidationEditor({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  return (
    <div>
      {q.validation.map((v, i) => {
        const kind = VALIDATION_KINDS.find((k) => k.value === v.kind);
        return (
          <div key={i} className="opt-row">
            <select className="select" style={{ width: 130 }} value={v.kind}
              onChange={(e) => patch({
                validation: q.validation.map((x, j) => (j === i ? { ...x, kind: e.target.value as any } : x)),
              })}>
              {VALIDATION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            {kind?.hasValue && (
              <input className="input grow mono" value={String(v.value ?? "")}
                onChange={(e) => patch({
                  validation: q.validation.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                })} />
            )}
            <input className="input grow" placeholder="error message (optional)" value={v.message ?? ""}
              onChange={(e) => patch({
                validation: q.validation.map((x, j) => (j === i ? { ...x, message: e.target.value || undefined } : x)),
              })} />
            <button className="btn small danger"
              onClick={() => patch({ validation: q.validation.filter((_, j) => j !== i) })}>×</button>
          </div>
        );
      })}
      <button className="btn small"
        onClick={() => patch({ validation: [...q.validation, { kind: "required" }] })}>+ rule</button>
    </div>
  );
}

function SkipLogicEditor({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  const s = useStudio();
  const pages: { id: string; title?: string }[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.type === "page") pages.push(n);
      if (n.children) walk(n.children);
      if (n.branches) for (const b of n.branches) walk(b.children);
      if (n.otherwise) walk(n.otherwise);
    }
  };
  walk(s.def.flow as any[]);

  const setRule = (i: number, r: SkipRule) =>
    patch({ skipLogic: q.skipLogic.map((x, j) => (j === i ? r : x)) });

  return (
    <div>
      {q.skipLogic.map((rule, i) => (
        <div key={rule.id} className="card" style={{ padding: 10 }}>
          <div className="flabel">WHEN</div>
          <ConditionEditor value={rule.when} onChange={(when) => setRule(i, { ...rule, when })} />
          <div className="row" style={{ marginTop: 6 }}>
            <span className="flabel" style={{ marginBottom: 0 }}>GO TO</span>
            <select className="select" value={rule.target.kind}
              onChange={(e) => setRule(i, { ...rule, target: { ...rule.target, kind: e.target.value as any } })}>
              <option value="question">question</option>
              <option value="page">page</option>
              <option value="end">end (complete)</option>
              <option value="terminate">terminate</option>
              <option value="url">external URL</option>
            </select>
            {rule.target.kind === "question" && (
              <select className="select grow" value={rule.target.ref ?? ""}
                onChange={(e) => setRule(i, { ...rule, target: { ...rule.target, ref: e.target.value } })}>
                <option value="">— pick —</option>
                {s.def.questions.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
              </select>
            )}
            {rule.target.kind === "page" && (
              <select className="select grow" value={rule.target.ref ?? ""}
                onChange={(e) => setRule(i, { ...rule, target: { ...rule.target, ref: e.target.value } })}>
                <option value="">— pick —</option>
                {pages.map((p) => <option key={p.id} value={p.id}>{p.title ?? p.id}</option>)}
              </select>
            )}
            {rule.target.kind === "url" && (
              <input className="input grow" placeholder="https://…" value={rule.target.ref ?? ""}
                onChange={(e) => setRule(i, { ...rule, target: { ...rule.target, ref: e.target.value } })} />
            )}
            {rule.target.kind === "terminate" && (
              <select className="select" value={rule.target.status ?? "terminated"}
                onChange={(e) => setRule(i, { ...rule, target: { ...rule.target, status: e.target.value as any } })}>
                <option value="terminated">terminated</option>
                <option value="screened">screened</option>
                <option value="quota_full">quota full</option>
              </select>
            )}
            <button className="btn small danger"
              onClick={() => patch({ skipLogic: q.skipLogic.filter((_, j) => j !== i) })}>×</button>
          </div>
        </div>
      ))}
      <button className="btn small" onClick={() =>
        patch({
          skipLogic: [...q.skipLogic, {
            id: uid("skip"),
            when: { type: "group", op: "and", children: [] },
            target: { kind: "end" },
          }],
        })}>
        + skip rule
      </button>
    </div>
  );
}

export function PropertiesPanel() {
  const s = useStudio();
  const q = selectedQuestion(s);
  if (!q) {
    return (
      <div>
        <h2>Properties</h2>
        <p className="muted">Select a question to edit its logic, validation, randomization, carry-forward and custom code.</p>
        <h2 style={{ marginTop: 24 }}>Survey</h2>
        <label className="f"><span>Title</span>
          <input className="input" value={s.def.meta.title}
            onChange={(e) => s.update((d) => { d.meta.title = e.target.value; })} /></label>
        <label className="f"><span>Survey code</span>
          <input className="input mono" value={s.def.meta.code}
            onChange={(e) => s.update((d) => { d.meta.code = e.target.value; })} /></label>
        <label className="f"><span>Access mode</span>
          <select className="select" value={s.def.deployment.access.mode}
            onChange={(e) => s.update((d) => { d.deployment.access.mode = e.target.value as any; })}>
            <option value="open">open link</option>
            <option value="password">password protected</option>
            <option value="unique_links">unique respondent links</option>
            <option value="invitation">email invitations</option>
          </select></label>
        {s.def.deployment.access.mode === "password" && (
          <label className="f"><span>Password</span>
            <input className="input" value={s.def.deployment.access.password ?? ""}
              onChange={(e) => s.update((d) => { d.deployment.access.password = e.target.value; })} /></label>
        )}
      </div>
    );
  }

  const patch = (p: Partial<Question>) =>
    s.update((d) => {
      const i = d.questions.findIndex((x) => x.id === q.id);
      if (i >= 0) d.questions[i] = { ...d.questions[i], ...p } as Question;
    });

  const pipingProblems = lintPipingTokens(s.def, `${q.text} ${q.instruction ?? ""}`);
  const exprError =
    q.type === "calculated" && q.settings.expression ? validateExpression(q.settings.expression) : null;

  return (
    <div>
      <h2>{q.code} properties</h2>
      {pipingProblems.map((p, i) => <div key={i} className="chip warn" style={{ marginBottom: 6 }}>{p}</div>)}
      {exprError && <div className="chip warn" style={{ marginBottom: 6 }}>expr: {exprError}</div>}

      <h3 className="sec">Display logic</h3>
      <OptionalCondition label="Show this question only when…"
        value={q.displayLogic} onChange={(c) => patch({ displayLogic: c })} />
      {q.displayLogic && (
        <div className="muted mono" style={{ fontSize: 11, marginTop: -6, marginBottom: 8 }}>
          {conditionToText(q.displayLogic, s.def)}
        </div>
      )}

      <h3 className="sec">Skip logic</h3>
      <SkipLogicEditor q={q} patch={patch} />

      <h3 className="sec">Carry-forward (dynamic options)</h3>
      {q.carryForward ? (
        <div className="card" style={{ padding: 10 }}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <select className="select" value={q.carryForward.sourceQuestionId}
              onChange={(e) => patch({ carryForward: { ...q.carryForward!, sourceQuestionId: e.target.value } })}>
              {s.def.questions.filter((x) => x.id !== q.id).map((x) => (
                <option key={x.id} value={x.id}>{x.code}</option>
              ))}
            </select>
            <select className="select" value={q.carryForward.filter}
              onChange={(e) => patch({ carryForward: { ...q.carryForward!, filter: e.target.value as any } })}>
              <option value="selected">selected options</option>
              <option value="not_selected">NOT selected</option>
              <option value="displayed">displayed options</option>
              <option value="answered_rows">answered rows</option>
              <option value="all">all options</option>
            </select>
            <select className="select" value={q.carryForward.into}
              onChange={(e) => patch({ carryForward: { ...q.carryForward!, into: e.target.value as any } })}>
              <option value="options">→ into options</option>
              <option value="rows">→ into rows</option>
              <option value="columns">→ into columns</option>
            </select>
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
              <input type="checkbox" checked={q.carryForward.keepOwn}
                onChange={(e) => patch({ carryForward: { ...q.carryForward!, keepOwn: e.target.checked } })} />
              keep own
            </label>
            <button className="btn small danger" onClick={() => patch({ carryForward: undefined })}>remove</button>
          </div>
        </div>
      ) : (
        <button className="btn small" disabled={s.def.questions.length < 2}
          onClick={() => patch({
            carryForward: {
              sourceQuestionId: s.def.questions.find((x) => x.id !== q.id)!.id,
              filter: "selected", into: "options", keepOwn: false,
            },
          })}>
          + carry forward from another question
        </button>
      )}

      <h3 className="sec">Randomization</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={q.randomization?.enabled ?? false}
            onChange={(e) => patch({
              randomization: { enabled: e.target.checked, scope: q.randomization?.scope ?? "options", method: q.randomization?.method ?? "shuffle" },
            })} />
          enabled
        </label>
        {q.randomization?.enabled && (
          <>
            <select className="select" value={q.randomization.scope}
              onChange={(e) => patch({ randomization: { ...q.randomization!, scope: e.target.value as any } })}>
              <option value="options">options</option><option value="rows">rows</option><option value="columns">columns</option>
            </select>
            <select className="select" value={q.randomization.method}
              onChange={(e) => patch({ randomization: { ...q.randomization!, method: e.target.value as any } })}>
              <option value="shuffle">shuffle</option><option value="rotate">rotate</option><option value="reverse_half">reverse for half</option>
            </select>
            <span className="muted" style={{ fontSize: 11 }}>anchor via option flags</span>
          </>
        )}
      </div>

      <h3 className="sec">Validation rules</h3>
      <ValidationEditor q={q} patch={patch} />

      <h3 className="sec">State</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="row" style={{ gap: 4, fontSize: 12 }}>
          <input type="checkbox" checked={q.settings.hidden}
            onChange={(e) => patch({ settings: { ...q.settings, hidden: e.target.checked } })} /> hidden
        </label>
        <label className="row" style={{ gap: 4, fontSize: 12 }}>
          <input type="checkbox" checked={q.settings.readOnly}
            onChange={(e) => patch({ settings: { ...q.settings, readOnly: e.target.checked } })} /> read-only
        </label>
      </div>
      <label className="f" style={{ marginTop: 8 }}><span>Default / piped value</span>
        <input className="input mono" value={String(q.settings.defaultValue ?? "")}
          placeholder='static, or {{Q1}} piped'
          onChange={(e) => patch({ settings: { ...q.settings, defaultValue: e.target.value || undefined } })} /></label>

      <h3 className="sec">Custom code</h3>
      <label className="f"><span>Custom JavaScript (question scope)</span>
        <textarea className="ta code" style={{ minHeight: 90 }} value={q.customJs ?? ""}
          placeholder="// runs via the script host; use get()/set()/setCalc()…"
          onChange={(e) => patch({ customJs: e.target.value || undefined })} /></label>
      <label className="f"><span>Custom CSS</span>
        <textarea className="ta code" style={{ minHeight: 60 }} value={q.customCss ?? ""}
          onChange={(e) => patch({ customCss: e.target.value || undefined })} /></label>
      <label className="f"><span>Custom HTML (above the input)</span>
        <textarea className="ta code" style={{ minHeight: 60 }} value={q.customHtml ?? ""}
          onChange={(e) => patch({ customHtml: e.target.value || undefined })} /></label>

      <label className="f"><span>Programmer notes</span>
        <textarea className="ta" value={q.notes ?? ""}
          onChange={(e) => patch({ notes: e.target.value || undefined })} /></label>
    </div>
  );
}
