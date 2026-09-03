"use client";
import { CountInput } from "./CountInput";
import React from "react";
import type { Question, ValidationRule, SkipRule, ListOperation, ListSource } from "@rescript/schema";
import { validateExpression, lintPipingTokens, lintQuestionLogic, listOperationSummary } from "@rescript/engine";
import { resolveVariant, LIST_OP_LABELS, LIST_OPS_WITH_SOURCES } from "@rescript/schema";
import { useStudio, selectedQuestion, uid } from "./store";
import { OptionalCondition, ConditionEditor } from "./ConditionBuilder";
import { MaskingBuilder } from "./MaskingBuilder";

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
  const qVariant = resolveVariant(q.variant);
  const allowed = (qVariant?.validations as ValidationRule["kind"][] | undefined) ?? validationKindsFor(q.type);
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
          <div className="row" style={{ marginBottom: 4 }}>
            <span className="flabel" style={{ margin: 0 }}>RULE {i + 1}</span>
            <span className="grow" />
            <button className="btn small danger" title="Remove this skip rule"
              onClick={() => patch({ skipLogic: q.skipLogic.filter((_, j) => j !== i) })}>×</button>
          </div>
          <div className="logic-if">IF</div>
          <ConditionEditor value={rule.when} onChange={(when) => setRule(i, { ...rule, when })} />
          <div className="row skip-target" style={{ marginTop: 8 }}>
            <span className="flabel logic-then-word" style={{ marginBottom: 0 }}>THEN GO TO</span>
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
              <input className="input skip-url" placeholder="https://example.com/thanks"
                value={rule.target.ref ?? ""}
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

/**
 * Reusable list-operation builder (reqs §9–11).
 *
 * The operations run in the order shown, so the panel doubles as the
 * documentation of what this question's option list actually does.
 */
function ListOperationsEditor({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  const s = useStudio();
  const ops = q.optionPipeline ?? [];
  const others = s.def.questions.filter((x) => x.id !== q.id);

  const setOp = (i: number, p: Partial<ListOperation>) =>
    patch({ optionPipeline: ops.map((o, j) => (j === i ? { ...o, ...p } : o)) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= ops.length) return;
    const next = [...ops];
    [next[i], next[j]] = [next[j], next[i]];
    patch({ optionPipeline: next });
  };
  const setSource = (i: number, k: number, p: Partial<ListSource>) =>
    setOp(i, { sources: ops[i].sources.map((x, m) => (m === k ? { ...x, ...p } : x)) });

  return (
    <div data-testid="list-operations">
      <p className="muted" style={{ fontSize: 11, marginTop: -2 }}>
        Set operations across any number of earlier questions — intersection, union, difference,
        remaining, dedupe, filter, sort, randomize. They run top to bottom, after the list rules
        above and before the question&apos;s own sorting and randomization.
      </p>
      {ops.map((op, i) => (
        <div key={op.id} className="card" style={{ padding: 10 }}>
          <div className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
            <span className="step-badge">{i + 1}</span>
            <select className="select" style={{ width: 210 }} value={op.kind}
              data-testid={`list-op-kind-${i}`}
              onChange={(e) => setOp(i, { kind: e.target.value as any })}>
              {(Object.keys(LIST_OP_LABELS) as (keyof typeof LIST_OP_LABELS)[]).map((k) => (
                <option key={k} value={k}>{LIST_OP_LABELS[k]}</option>
              ))}
            </select>
            {op.kind === "sort" && (
              <select className="select" value={op.order ?? "az"}
                onChange={(e) => setOp(i, { order: e.target.value as any })}>
                <option value="az">A → Z</option><option value="za">Z → A</option>
                <option value="numeric_asc">numeric ↑</option><option value="numeric_desc">numeric ↓</option>
                <option value="original">programmed order</option>
              </select>
            )}
            {op.kind === "randomize" && (
              <>
                <select className="select" value={op.method ?? "shuffle"}
                  onChange={(e) => setOp(i, { method: e.target.value as any })}>
                  <option value="shuffle">shuffle</option><option value="rotate">rotate</option>
                  <option value="reverse_half">reverse half</option><option value="none">keep order</option>
                </select>
                <label className="row" style={{ gap: 4, fontSize: 12 }}>
                  show
                  <CountInput min={1} width={60} value={op.pick}
                    onChange={(v) => setOp(i, { pick: v })} />
                </label>
              </>
            )}
            {op.kind === "carry_forward" && (
              <label className="row" style={{ gap: 4, fontSize: 12 }}>
                <input type="checkbox" checked={op.keepOwn}
                  onChange={(e) => setOp(i, { keepOwn: e.target.checked })} /> keep own options
              </label>
            )}
            <span className="grow" />
            <button className="btn small" onClick={() => move(i, -1)}>↑</button>
            <button className="btn small" onClick={() => move(i, 1)}>↓</button>
            <button className="btn small danger"
              onClick={() => patch({ optionPipeline: ops.filter((_, j) => j !== i) })}>×</button>
          </div>

          {LIST_OPS_WITH_SOURCES.includes(op.kind) && (
            <>
              {op.sources.map((src, k) => (
                <div key={k} className="row" style={{ marginBottom: 4 }}>
                  <select className="select" style={{ width: 150 }} value={src.which}
                    onChange={(e) => setSource(i, k, { which: e.target.value as any })}>
                    <option value="selected">selected in</option>
                    <option value="not_selected">NOT selected in</option>
                    <option value="displayed">displayed in</option>
                    <option value="answered_rows">answered rows of</option>
                    <option value="all">all options of</option>
                  </select>
                  <select className="select grow" value={src.questionId}
                    onChange={(e) => setSource(i, k, { questionId: e.target.value })}>
                    {others.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
                  </select>
                  <button className="btn small danger"
                    onClick={() => setOp(i, { sources: op.sources.filter((_, m) => m !== k) })}>×</button>
                </div>
              ))}
              <button className="btn small" disabled={others.length === 0}
                onClick={() => setOp(i, { sources: [...op.sources, { questionId: others[0].id, which: "selected" }] })}>
                + list
              </button>
            </>
          )}

          {op.kind === "filter" && (
            <div style={{ marginTop: 6 }}>
              <div className="flabel">KEEP OPTIONS WHERE</div>
              <ConditionEditor perOption
                value={op.where ?? { type: "group", op: "and", children: [] }}
                onChange={(where) => setOp(i, { where })} />
            </div>
          )}

          <div style={{ marginTop: 6 }}>
            <OptionalCondition label="Only run this step when" value={op.when}
              onChange={(when) => setOp(i, { when })} />
          </div>
          <div className="logic-summary">{listOperationSummary(s.def, op)}</div>
        </div>
      ))}
      <button className="btn small" data-testid="add-list-op"
        onClick={() => patch({
          optionPipeline: [...ops, {
            id: uid("lop"),
            kind: "intersect",
            sources: others.length ? [{ questionId: others[0].id, which: "selected" }] : [],
            keepOwn: false,
          } as ListOperation],
        })}>
        + list operation
      </button>
    </div>
  );
}

/**
 * Survey-level settings: title, code, URL slugs and access mode.
 *
 * These used to live inside the Properties panel's "no question selected"
 * branch, so the moment a programmer clicked any question the Access mode
 * control vanished with no way back — which is why "the study mode doesn't
 * save" was the most common report. It has its own Settings tab now, always
 * reachable, and the same component is reused in the empty Properties state.
 */
export function SurveySettings() {
  const s = useStudio();
  const dep = s.def.deployment;
  const mode = dep.access.mode;

  return (
    <div data-testid="survey-settings">
      <label className="f"><span>Title</span>
        <input className="input" value={s.def.meta.title}
          onChange={(e) => s.update((d) => { d.meta.title = e.target.value; })} /></label>
      <label className="f"><span>Survey code</span>
        <input className="input mono" value={s.def.meta.code}
          onChange={(e) => s.update((d) => { d.meta.code = e.target.value; })} /></label>

      <h3 className="sec">Survey URL</h3>
      <p className="muted" style={{ fontSize: 11, marginTop: -4 }}>
        Must be unique across surveys — respondents get
        <span className="mono"> /s/{dep.clientSlug || "client"}/{dep.studySlug || "study-001"}</span>
      </p>
      <div className="row">
        <label className="f grow"><span>Client slug</span>
          <input className="input mono" value={dep.clientSlug}
            placeholder="acme"
            onChange={(e) => s.update((d) => {
              d.deployment.clientSlug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
            })} /></label>
        <label className="f grow"><span>Study slug</span>
          <input className="input mono" value={dep.studySlug}
            placeholder="brand-tracker-2026"
            onChange={(e) => s.update((d) => {
              d.deployment.studySlug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
            })} /></label>
      </div>

      <h3 className="sec">Who can take this survey</h3>
      <label className="f"><span>Access mode</span>
        <select className="select" data-testid="access-mode" value={mode}
          onChange={(e) => s.update((d) => { d.deployment.access.mode = e.target.value as any; })}>
          <option value="open">Open link — anyone with the URL</option>
          <option value="password">Password protected</option>
          <option value="unique_links">Unique respondent links</option>
          <option value="invitation">Email invitations</option>
        </select></label>

      {mode === "password" && (
        <label className="f"><span>Password</span>
          <input className="input" value={dep.access.password ?? ""}
            placeholder="respondents are asked for this"
            onChange={(e) => s.update((d) => { d.deployment.access.password = e.target.value; })} /></label>
      )}

      {(mode === "unique_links" || mode === "invitation") && (
        <div className="chip warn" style={{ marginBottom: 10 }}>
          Each respondent needs their own token. There is no invitation-management screen yet, so
          the live link will refuse everyone until tokens exist in the <span className="mono">respondents</span>{" "}
          table. <strong>Test Survey still works</strong> — it mints a throwaway token for you.
        </div>
      )}

      <label className="row" style={{ gap: 6, fontSize: 12, marginBottom: 8 }}>
        <input type="checkbox" checked={dep.access.allowRetake ?? false}
          onChange={(e) => s.update((d) => { d.deployment.access.allowRetake = e.target.checked; })} />
        Allow a respondent to retake the survey
      </label>

      <p className="muted" style={{ fontSize: 11 }}>
        Changes here autosave to your draft. They reach respondents only when you save a version
        and publish it.
      </p>
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
        <p className="muted">
          Select a question to edit its logic, validation, randomization, carry-forward and custom
          code.
        </p>
        <h2 style={{ marginTop: 24 }}>Survey</h2>
        <SurveySettings />
      </div>
    );
  }

  const patch = (p: Partial<Question>) =>
    s.update((d) => {
      const i = d.questions.findIndex((x) => x.id === q.id);
      if (i >= 0) d.questions[i] = { ...d.questions[i], ...p } as Question;
    });

  const variantDef = resolveVariant(q.variant);
  const hasCap = (c: string) =>
    variantDef ? variantDef.capabilities.includes(c as any) : true;
  const pipingProblems = lintPipingTokens(s.def, `${q.text} ${q.instruction ?? ""}`);
  const exprError =
    q.type === "calculated" && q.settings.expression ? validateExpression(q.settings.expression) : null;
  const logicIssues = lintQuestionLogic(s.def, q);

  return (
    <div>
      <h2>{q.code} properties</h2>
      {pipingProblems.map((p, i) => <div key={i} className="chip warn" style={{ marginBottom: 6 }}>{p}</div>)}
      {exprError && <div className="chip warn" style={{ marginBottom: 6 }}>expr: {exprError}</div>}
      {/* Only errors are shown here. Warnings ("operator has no value set")
          are true but fire the instant you add a condition, before there is
          anything to type into — which made the panel look broken on first
          use. They stay available in Logic → Logic check. */}
      {logicIssues.some((i) => i.level === "error") && (
        <div data-testid="logic-issues" style={{ marginBottom: 6 }}>
          {logicIssues.filter((i) => i.level === "error").map((i, k) => (
            <div key={k} className="chip warn" style={{ marginBottom: 4 }}>
              ✕ {i.path}{i.optionCode ? ` [${i.optionCode}]` : ""} — {i.message}
            </div>
          ))}
        </div>
      )}
      {logicIssues.length > 0 && !logicIssues.some((i) => i.level === "error") && (
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          {logicIssues.length} logic note{logicIssues.length === 1 ? "" : "s"} — see Logic → Logic check
        </div>
      )}

      {/* Logic reads as IF → THEN: the conditions, then what happens. */}
      <h3 className="sec">Display logic</h3>
      <div className="logic-rule">
        <div className="logic-if">IF</div>
        <OptionalCondition label="these conditions hold"
          hint={`Nothing here means ${q.code} always shows.`}
          value={q.displayLogic} onChange={(c) => patch({ displayLogic: c })} />
        <div className="logic-then">
          <span className="logic-then-word">THEN</span> show <strong>{q.code}</strong>
        </div>
      </div>

      <h3 className="sec">Skip logic</h3>
      <SkipLogicEditor q={q} patch={patch} />

      {hasCap("carry_forward") && (<>
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
      </>)}

      {hasCap("randomization") && (<>
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
              <CountInput min={1} width={64}
                title="Present N randomly chosen items (anchored items always show)"
                value={q.randomization.pick}
                onChange={(v) => patch({
                  randomization: { ...q.randomization!, pick: v },
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
                  <CountInput min={1} width={60} value={rule.pick}
                    onChange={(v) => patch({
                      randomization: {
                        ...q.randomization!,
                        rules: q.randomization!.rules!.map((x, j) =>
                          j === ri ? { ...x, pick: v } : x),
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

      </>)}

      {hasCap("list_logic") && (<>
      <h3 className="sec">Masking (dynamic option sets)</h3>
      <MaskingBuilder q={q} patch={patch} />

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

      <h3 className="sec">List operations (intersection / union / difference)</h3>
      <ListOperationsEditor q={q} patch={patch} />
      </>)}

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
