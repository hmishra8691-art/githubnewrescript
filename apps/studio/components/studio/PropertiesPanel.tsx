"use client";
import React from "react";
import type { Question, ValidationRule, SkipRule } from "@rescript/schema";
import { validateExpression, lintPipingTokens } from "@rescript/engine";
import { useStudio, selectedQuestion, uid } from "./store";
import { OptionalCondition, ConditionEditor, conditionToText } from "./ConditionBuilder";

/** Context-aware validation (req §6/§19): only offer rules that make sense
 *  for the question type. */
export function validationKindsFor(qtype: string): ValidationRule["kind"][] {
  if (["multi_select", "multi_dropdown", "image_select"].includes(qtype))
    return ["required", "min_selections", "max_selections", "custom_expression"];
  if (["numeric", "slider", "nps", "matrix_numeric"].includes(qtype))
    return ["required", "min_value", "max_value", "integer", "custom_expression"];
  if (["open_text", "long_text", "text_list"].includes(qtype))
    return ["required", "min_length", "max_length", "pattern", "email", "custom_expression"];
  if (qtype === "numeric_list")
    return ["required", "min_value", "max_value", "integer", "custom_expression"];
  if (qtype === "allocation")
    return ["required", "sum_equals", "sum_max", "sum_min", "custom_expression"];
  if (["single_select", "dropdown", "date", "time", "ranking", "image_ranking"].includes(qtype))
    return ["required", "custom_expression"];
  if (qtype.startsWith("matrix") || qtype === "composite" || qtype === "custom_table")
    return ["required", "min_selections", "max_selections", "custom_expression"];
  return VALIDATION_KINDS.map((k) => k.value);
}

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
  const allowed = validationKindsFor(q.type);
  const kinds = VALIDATION_KINDS.filter((k) => allowed.includes(k.value));
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
              {/* keep an already-set kind visible even if not offered for this type */}
              {(kinds.some((k) => k.value === v.kind) ? kinds : [kind!, ...kinds]).map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
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

        <h3 className="sec">Survey URL</h3>
        <p className="muted" style={{ fontSize: 11, marginTop: -4 }}>
          Must be unique across surveys — respondents get
          <span className="mono"> /s/{s.def.deployment.clientSlug || "client"}/{s.def.deployment.studySlug || "study-001"}</span>
        </p>
        <div className="row">
          <label className="f grow"><span>Client slug</span>
            <input className="input mono" value={s.def.deployment.clientSlug}
              placeholder="acme"
              onChange={(e) => s.update((d) => {
                d.deployment.clientSlug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
              })} /></label>
          <label className="f grow"><span>Study slug</span>
            <input className="input mono" value={s.def.deployment.studySlug}
              placeholder="brand-tracker-2026"
              onChange={(e) => s.update((d) => {
                d.deployment.studySlug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
              })} /></label>
        </div>

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
              <option value="shuffle">shuffle</option><option value="rotate">rotate</option>
              <option value="reverse_half">reverse for half</option><option value="none">keep order</option>
            </select>
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
              show only
              <input className="input" type="number" style={{ width: 64 }}
                title="Present N randomly chosen items (anchored items always show)"
                value={q.randomization.pick ?? ""}
                onChange={(e) => patch({
                  randomization: { ...q.randomization!, pick: e.target.value === "" ? undefined : Number(e.target.value) },
                })} />
              items
            </label>
          </>
        )}
      </div>
      {q.randomization?.enabled && (
        <>
          <p className="muted" style={{ fontSize: 11, margin: "4px 0 8px" }}>
            Fix items in place with the <em>anchor top / anchor bottom</em> option flags —
            anchored items are never shuffled or dropped by “show only N”.
          </p>
          <div className="flabel">Conditional randomization — first matching rule wins</div>
          {(q.randomization.rules ?? []).map((rule, ri) => (
            <div key={rule.id} className="card" style={{ padding: 10 }}>
              <div className="row" style={{ marginBottom: 6, flexWrap: "wrap" }}>
                <span className="flabel" style={{ margin: 0 }}>WHEN</span>
                <span className="grow" />
                <select className="select" style={{ width: 130 }} value={rule.method ?? ""}
                  onChange={(e) => patch({
                    randomization: {
                      ...q.randomization!,
                      rules: q.randomization!.rules!.map((x, j) =>
                        j === ri ? { ...x, method: (e.target.value || undefined) as any } : x),
                    },
                  })}>
                  <option value="">method: inherit</option>
                  <option value="shuffle">shuffle</option><option value="rotate">rotate</option>
                  <option value="reverse_half">reverse half</option><option value="none">keep order</option>
                </select>
                <label className="row" style={{ gap: 4, fontSize: 12 }}>
                  pick
                  <input className="input" type="number" style={{ width: 60 }} value={rule.pick ?? ""}
                    onChange={(e) => patch({
                      randomization: {
                        ...q.randomization!,
                        rules: q.randomization!.rules!.map((x, j) =>
                          j === ri ? { ...x, pick: e.target.value === "" ? undefined : Number(e.target.value) } : x),
                      },
                    })} />
                </label>
                <button className="btn small danger" onClick={() => patch({
                  randomization: {
                    ...q.randomization!,
                    rules: q.randomization!.rules!.filter((_, j) => j !== ri),
                  },
                })}>×</button>
              </div>
              <ConditionEditor value={rule.when}
                onChange={(when) => patch({
                  randomization: {
                    ...q.randomization!,
                    rules: q.randomization!.rules!.map((x, j) => (j === ri ? { ...x, when } : x)),
                  },
                })} />
            </div>
          ))}
          <button className="btn small" onClick={() => patch({
            randomization: {
              ...q.randomization!,
              rules: [...(q.randomization!.rules ?? []), {
                id: uid("rr"),
                when: { type: "group", op: "and", children: [] },
              }],
            },
          })}>
            + conditional rule (e.g. “if Q1 = A, use randomization set A”)
          </button>
        </>
      )}

      <h3 className="sec">List logic (from previous questions)</h3>
      <p className="muted" style={{ fontSize: 11, marginTop: -2 }}>
        Include / exclude / prioritize this question&apos;s options based on what an earlier
        question selected or displayed. Rules apply in order, before sorting and randomization.
        “Exclude + displayed” = show only items not yet seen.
      </p>
      {(q.listLogic ?? []).map((rule, ri) => (
        <div key={rule.id} className="card" style={{ padding: 10 }}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <select className="select" style={{ width: 120 }} value={rule.action}
              onChange={(e) => patch({
                listLogic: q.listLogic!.map((x, j) => (j === ri ? { ...x, action: e.target.value as any } : x)),
              })}>
              <option value="include">include only</option>
              <option value="exclude">exclude</option>
              <option value="prioritize">move to top</option>
              <option value="deprioritize">move to bottom</option>
            </select>
            <select className="select" style={{ width: 140 }} value={rule.which}
              onChange={(e) => patch({
                listLogic: q.listLogic!.map((x, j) => (j === ri ? { ...x, which: e.target.value as any } : x)),
              })}>
              <option value="selected">items selected in</option>
              <option value="not_selected">items NOT selected in</option>
              <option value="displayed">items displayed in</option>
            </select>
            <select className="select grow" value={rule.sourceQuestionId}
              onChange={(e) => patch({
                listLogic: q.listLogic!.map((x, j) => (j === ri ? { ...x, sourceQuestionId: e.target.value } : x)),
              })}>
              {s.def.questions.filter((x) => x.id !== q.id).map((x) => (
                <option key={x.id} value={x.id}>{x.code}</option>
              ))}
            </select>
            <button className="btn small danger" onClick={() =>
              patch({ listLogic: q.listLogic!.filter((_, j) => j !== ri) })}>×</button>
          </div>
        </div>
      ))}
      <button className="btn small" disabled={s.def.questions.length < 2}
        onClick={() => patch({
          listLogic: [...(q.listLogic ?? []), {
            id: uid("ll"),
            sourceQuestionId: s.def.questions.find((x) => x.id !== q.id)!.id,
            action: "include", which: "selected",
          } as any],
        })}>
        + list rule
      </button>

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
