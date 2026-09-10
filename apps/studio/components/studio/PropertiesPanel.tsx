"use client";
import { CountInput } from "./CountInput";
import React from "react";
import type { Question, ValidationRule, SkipRule, ListOperation, ListSource } from "@rescript/schema";
import { validateExpression, lintPipingTokens, lintQuestionLogic, listOperationSummary, hasOptionGroups, PROBE_TYPES, lintProbeQuestion } from "@rescript/engine";
import { resolveVariant, effectiveCapabilities, allowedValidationKinds, LIST_OP_LABELS, LIST_OPS_WITH_SOURCES } from "@rescript/schema";
import { useStudio, selectedQuestion, uid } from "./store";
import { useCanvas } from "../canvas/CanvasContext";
import { ElementPanel } from "../canvas/ElementPanel";
import { OptionalCondition, ConditionEditor, newConditionGroup } from "./ConditionBuilder";
import { LoopScopeProvider, loopsAroundQuestion } from "./loopScope";
import { MaskingBuilder, PunchRules } from "./MaskingBuilder";
import { QualitySettings } from "./QualitySettings";
import { OptionGroupsEditor } from "./OptionGroupsEditor";
import { CollapsibleSection } from "./CollapsibleSection";

/** Context-aware validation (req §6/§19): only offer rules that make sense
 *  for the question type. */
export function validationKindsFor(qtype: string): ValidationRule["kind"][] {
  // "condition" (the Universal Logic Engine's Visual/Expression builder) is
  // meaningful for every question type — unlike e.g. sum_equals, which only
  // makes sense for allocation — so every branch below gets it appended.
  if (["multi_select", "multi_dropdown", "image_select"].includes(qtype))
    return ["required", "min_selections", "max_selections", "custom_expression", "condition"];
  if (["numeric", "slider", "nps", "matrix_numeric"].includes(qtype))
    return ["required", "min_value", "max_value", "integer", "custom_expression", "condition"];
  if (["open_text", "long_text", "text_list"].includes(qtype))
    return ["required", "min_length", "max_length", "pattern", "email", "phone", "custom_expression", "custom_script", "condition"];
  if (qtype === "numeric_list")
    return ["required", "min_value", "max_value", "integer", "custom_expression", "condition"];
  if (qtype === "allocation")
    return ["required", "sum_equals", "sum_max", "sum_min", "custom_expression", "condition"];
  if (["date", "datetime"].includes(qtype))
    return ["required", "date_min", "date_max", "custom_expression", "custom_script", "condition"];
  if (["single_select", "dropdown", "time", "ranking", "image_ranking"].includes(qtype))
    return ["required", "custom_expression", "custom_script", "condition"];
  if (qtype === "composite" || qtype === "custom_table")
    return ["required", "min_selections", "max_selections",
      "column_sum_equals", "column_sum_max", "column_sum_min", "custom_expression", "custom_script", "condition"];
  if (qtype.startsWith("matrix"))
    return ["required", "min_selections", "max_selections", "custom_expression", "custom_script", "condition"];
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
  { value: "phone", label: "phone number", hasValue: false },
  { value: "date_min", label: "date on or after", hasValue: true },
  { value: "date_max", label: "date on or before", hasValue: true },
  { value: "column_sum_equals", label: "column total =", hasValue: true },
  { value: "column_sum_max", label: "column total ≤", hasValue: true },
  { value: "column_sum_min", label: "column total ≥", hasValue: true },
  { value: "integer", label: "whole number", hasValue: false },
  { value: "custom_expression", label: "expression (calc DSL)", hasValue: true },
  { value: "custom_script", label: "script (by name)", hasValue: true },
  { value: "condition", label: "condition (visual/expression)", hasValue: false },
];

/** What the value box is asking for, per kind — a hint beats a guess. */
const VALUE_HINT: Partial<Record<ValidationRule["kind"], string>> = {
  date_min: "2026-01-01, or a variable holding a date",
  date_max: "2026-12-31, or a variable holding a date",
  column_sum_equals: "100",
  column_sum_max: "100",
  column_sum_min: "0",
  custom_script: "the script's name",
  custom_expression: "value > 0",
  pattern: "^[A-Z]{2}\\d{4}$",
};

function ValidationEditor({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  const s = useStudio();
  const qVariant = resolveVariant(q.variant);
  const allowed = allowedValidationKinds(
    qVariant?.validations,
    validationKindsFor(q.type),
  ) as ValidationRule["kind"][];
  const kinds = VALIDATION_KINDS.filter((k) => allowed.includes(k.value));
  return (
    <div>
      {q.validation.map((v, i) => {
        const kind = VALIDATION_KINDS.find((k) => k.value === v.kind);
        const pipingIssues = v.message ? lintPipingTokens(s.def, v.message) : [];
        return (
          /*
            * A plain-condition rule (kind:"condition") needs room below the
            * top line for the shared visual/expression builder — the same
            * card-per-rule shape SkipLogicEditor already uses for exactly
            * this reason, so every logic-editing surface reads the same way.
            */
          <div key={i} className="card" data-testid="validation-rule" style={{ padding: 10, marginBottom: 6 }}>
            <div className="opt-row">
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
                  placeholder={VALUE_HINT[v.kind] ?? ""}
                  data-testid="validation-value"
                  onChange={(e) => patch({
                    validation: q.validation.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                  })} />
              )}
              {/* which column a column-total rule adds up; blank = every column */}
              {v.kind.startsWith("column_sum") && (
                <select className="select" style={{ width: 120 }} value={v.ref ?? ""}
                  data-testid="validation-column"
                  title="Which column to total — every column when left blank"
                  onChange={(e) => patch({
                    validation: q.validation.map((x, j) => (j === i ? { ...x, ref: e.target.value || undefined } : x)),
                  })}>
                  <option value="">every column</option>
                  {q.columns.map((c) => <option key={c.id} value={c.id}>{c.label || c.id}</option>)}
                </select>
              )}
              <input className="input grow" placeholder="message (optional)" value={v.message ?? ""}
                onChange={(e) => patch({
                  validation: q.validation.map((x, j) => (j === i ? { ...x, message: e.target.value || undefined } : x)),
                })} />
              {/*
                * Blocks, or only warns. A soft check is how a researcher says
                * "that is unusual, look again" without making a legitimate
                * answer impossible to give — the respondent sees it once and
                * the next click goes through.
                */}
              <select className="select" style={{ width: 92 }} value={v.severity ?? "error"}
                data-testid="validation-severity"
                title="Blocks the page, or shows a message and lets the respondent continue"
                onChange={(e) => patch({
                  validation: q.validation.map((x, j) => (j === i
                    ? { ...x, severity: e.target.value === "warning" ? "warning" as const : undefined }
                    : x)),
                })}>
                <option value="error">blocks</option>
                <option value="warning">warns</option>
              </select>
              <button className="btn small danger"
                onClick={() => patch({ validation: q.validation.filter((_, j) => j !== i) })}>×</button>
            </div>
            {pipingIssues.map((p, pi) => (
              <div key={pi} className="chip warn" data-testid="validation-message-piping-warning" style={{ marginTop: 4 }}>
                {p}
              </div>
            ))}
            {v.kind === "condition" && (
              /*
                * The Universal Logic Engine's own builder — nested AND/OR/
                * NOT, COUNT, cross-question, matrix-cell (row/column
                * pickers), and loop sources — reused verbatim, not forked.
                * Its own Visual⇄Expression tab bar IS the "mode" the brief
                * asks for; "Simple" mode is just picking one of the flat
                * kinds above instead of this one.
                */
              <div style={{ marginTop: 6 }} data-testid="validation-condition-editor">
                <ConditionEditor
                  value={v.check ?? newConditionGroup()}
                  onChange={(check) => patch({
                    validation: q.validation.map((x, j) => (j === i ? { ...x, check } : x)),
                  })}
                />
              </div>
            )}
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
      <p className="muted" style={{ fontSize: 12.5, marginTop: -2 }}>
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
                <label className="row" style={{ gap: 4, fontSize: 13 }}>
                  show
                  <CountInput min={1} width={60} value={op.pick}
                    onChange={(v) => setOp(i, { pick: v })} />
                </label>
              </>
            )}
            {op.kind === "carry_forward" && (
              <label className="row" style={{ gap: 4, fontSize: 13 }}>
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
      <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>
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
      {/* white labelling stops at CSS unless the domain in the address bar
          changes too; the field existed and nothing read it */}
      <label className="f"><span>Custom domain (optional)</span>
        <input className="input mono" value={dep.customDomain ?? ""} data-testid="custom-domain"
          placeholder="survey.acme.com"
          onChange={(e) => s.update((d) => {
            d.deployment.customDomain = e.target.value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "") || undefined;
          })} /></label>
      {dep.customDomain && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>
          Respondent links will use <span className="mono">https://{dep.customDomain}</span>. Point it
          at the runtime in DNS, with a certificate, before you deploy — the platform builds the link,
          it cannot make the domain resolve.
        </p>
      )}

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

      {/*
        * This used to be a warning that no invitation screen existed, and
        * that the live link would therefore refuse everyone. It now points at
        * the screen (§24). The substance that remains true is worth keeping:
        * a personal-link survey has nobody who can take it until a list has
        * been uploaded, and Test Survey works regardless because it mints a
        * throwaway token.
        */}
      {(mode === "unique_links" || mode === "invitation") && (
        <div className="chip qd-note" style={{ marginBottom: 10 }} data-testid="access-personal-note">
          Each respondent needs their own link. Upload the list under{" "}
          <strong>Distribution</strong>, where each person&apos;s link is minted and can be downloaded for sending.
          Until somebody is on the list the live link has nobody to admit; <strong>Test Survey still works</strong> —
          it mints a throwaway token for you.
        </div>
      )}

      <label className="row" style={{ gap: 6, fontSize: 13, marginBottom: 8 }}>
        <input type="checkbox" checked={dep.access.allowRetake ?? false}
          onChange={(e) => s.update((d) => { d.deployment.access.allowRetake = e.target.checked; })} />
        Allow a respondent to retake the survey
      </label>

      <QualitySettings />

      <p className="muted" style={{ fontSize: 12.5 }}>
        Changes here autosave to your draft. They reach respondents only when you save a version
        and publish it.
      </p>
    </div>
  );
}

export function PropertiesPanel() {
  const s = useStudio();
  const q = selectedQuestion(s);
  const canvas = useCanvas();

  /*
   * CONTEXTUAL, NOT SEPARATE.
   *
   * This is the same panel it has always been. When the programmer selects an
   * element in the Live View — an option, a row, a column, a cell — it offers
   * that element's properties instead of the question's, because showing every
   * property of every element at once is precisely what makes a matrix hard to
   * program. Selecting the question, or working in Standard view, gives back
   * the full question interface below, unchanged.
   */
  const elementSel = canvas?.selected;
  if (q && canvas?.mode === "live" && elementSel && elementSel.questionId === q.id && elementSel.type !== "question") {
    return <ElementPanel q={q} sel={elementSel} ann={canvas.annotations} onSelect={canvas.select} />;
  }

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
  /*
   * Capabilities come from the TYPE, so a question created from a preset
   * ("Email") is configurable exactly like the type it is a preset of
   * ("Single-Line Text"). Reading the preset's own list would hide settings
   * from it that its parent offers.
   */
  const effectiveCaps = effectiveCapabilities(q.variant);
  const hasCap = (c: string) =>
    effectiveCaps ? (effectiveCaps as readonly string[]).includes(c) : true;
  const pipingProblems = lintPipingTokens(s.def, `${q.text} ${q.instruction ?? ""}`);
  const exprError =
    q.type === "calculated" && q.settings.expression ? validateExpression(q.settings.expression) : null;
  const logicIssues = lintQuestionLogic(s.def, q);
  /*
   * The loops this question sits inside, so its display logic, skip logic and
   * piping picker can offer the loops' reference columns — and only theirs.
   */
  const loopScope = loopsAroundQuestion(s.def, q.id);
  const [search, setSearch] = React.useState("");
  const showSec = (title: string) =>
    !search.trim() || title.toLowerCase().includes(search.trim().toLowerCase());

  return (
    <LoopScopeProvider loops={loopScope}>
    <div>
      <h2>{q.code} properties</h2>
      <input className="input psec-search" data-testid="properties-search"
        placeholder="Search properties…" value={search}
        onChange={(e) => setSearch(e.target.value)} />
      {loopScope.length > 0 && (
        <div className="chip" data-testid="in-loop-chip" style={{ marginBottom: 6 }} title={`Inside loop${loopScope.length > 1 ? "s" : ""}: ${loopScope.map((l) => l.loopVar).join(" › ")}. Answers are stored per iteration; {{loop.…}} pipes the current item.`}>
          in loop “{loopScope[0].loopVar}”{loopScope.length > 1 ? ` (nested in ${loopScope.slice(1).map((l) => l.loopVar).join(", ")})` : ""}
          {loopScope[0].references?.columns.length ? ` · references: ${loopScope[0].references.columns.map((c) => c.name).join(", ")}` : ""}
        </div>
      )}
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
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
          {logicIssues.length} logic note{logicIssues.length === 1 ? "" : "s"} — see Logic → Logic check
        </div>
      )}

      {/* Logic reads as IF → THEN: the conditions, then what happens. */}
      {showSec("Display logic") && (
      <CollapsibleSection id="display-logic" title="Display logic" active={!!q.displayLogic}>
      <div className="logic-rule">
        <div className="logic-if">IF</div>
        <OptionalCondition label="these conditions hold"
          hint={`Nothing here means ${q.code} always shows.`}
          value={q.displayLogic} onChange={(c) => patch({ displayLogic: c })} />
        <div className="logic-then">
          <span className="logic-then-word">THEN</span> show <strong>{q.code}</strong>
        </div>
      </div>
      </CollapsibleSection>
      )}

      {showSec("Skip logic") && (
      <CollapsibleSection id="skip-logic" title="Skip logic" active={(q.skipLogic?.length ?? 0) > 0}>
      <SkipLogicEditor q={q} patch={patch} />
      </CollapsibleSection>
      )}

      {/*
        * LOCATION — the `geo` response model's one configuration block. The
        * mode picks the renderer (pin / address / radius) over one stored shape;
        * the rest frames the map and bounds the radius (schema settings.geo*).
        */}
      {q.type === "geo" && showSec("Location / map") && (
      <CollapsibleSection id="geo" title="Location / map" active defaultOpen>
      <div className="card" style={{ padding: 10 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
          <label className="f" style={{ width: 200 }}><span>How the place is given</span>
            <select className="select" value={q.settings.geoMode ?? "pin"} data-testid="geo-mode"
              onChange={(e) => patch({ settings: { ...q.settings, geoMode: e.target.value as "pin" | "address" | "radius" } })}>
              <option value="pin">Pin on a map</option>
              <option value="address">Address search / typed</option>
              <option value="radius">Pin with a radius</option>
            </select></label>
          <label className="row" style={{ gap: 4, fontSize: 13, alignSelf: "end" }}>
            <input type="checkbox" checked={!!q.settings.allowGeolocation} data-testid="geo-allow-geolocation"
              onChange={(e) => patch({ settings: { ...q.settings, allowGeolocation: e.target.checked || undefined } })} /> offer "use my location"
          </label>
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
          <label className="f" style={{ width: 130 }}><span>Map centre latitude</span>
            <input className="input mono" type="number" step="0.0001" min={-90} max={90} value={q.settings.mapCenter?.lat ?? ""} data-testid="geo-center-lat"
              placeholder="e.g. 51.5"
              onChange={(e) => { const lat = e.target.value === "" ? undefined : Number(e.target.value); patch({ settings: { ...q.settings, mapCenter: lat == null ? undefined : { lat, lng: q.settings.mapCenter?.lng ?? 0 } } }); }} /></label>
          <label className="f" style={{ width: 130 }}><span>Map centre longitude</span>
            <input className="input mono" type="number" step="0.0001" min={-180} max={180} value={q.settings.mapCenter?.lng ?? ""} data-testid="geo-center-lng"
              placeholder="e.g. -0.12"
              onChange={(e) => { const lng = e.target.value === "" ? undefined : Number(e.target.value); patch({ settings: { ...q.settings, mapCenter: lng == null ? undefined : { lat: q.settings.mapCenter?.lat ?? 0, lng } } }); }} /></label>
          <label className="f" style={{ width: 110 }}><span>Initial zoom (1–19)</span>
            <input className="input" type="number" min={1} max={19} value={q.settings.mapZoom ?? ""} data-testid="geo-zoom"
              onChange={(e) => patch({ settings: { ...q.settings, mapZoom: e.target.value === "" ? undefined : Math.min(19, Math.max(1, Math.round(Number(e.target.value)))) } })} /></label>
        </div>
        {(q.settings.geoMode ?? "pin") === "radius" && (
          <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
            <label className="f" style={{ width: 130 }}><span>Radius min (m)</span>
              <input className="input" type="number" min={0} value={q.settings.radiusMinM ?? ""} data-testid="geo-radius-min"
                onChange={(e) => patch({ settings: { ...q.settings, radiusMinM: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) } })} /></label>
            <label className="f" style={{ width: 130 }}><span>Radius max (m)</span>
              <input className="input" type="number" min={0} value={q.settings.radiusMaxM ?? ""} data-testid="geo-radius-max"
                onChange={(e) => patch({ settings: { ...q.settings, radiusMaxM: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) } })} /></label>
            <label className="f" style={{ width: 130 }}><span>Radius default (m)</span>
              <input className="input" type="number" min={0} value={q.settings.radiusDefaultM ?? ""} data-testid="geo-radius-default"
                onChange={(e) => patch({ settings: { ...q.settings, radiusDefaultM: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) } })} /></label>
          </div>
        )}
        <label className="f" style={{ marginTop: 8 }}><span>Map tiles URL template (blank = OpenStreetMap; use a commercial provider at scale)</span>
          <input className="input mono" value={q.settings.mapTiles ?? ""} placeholder="https://…/{z}/{x}/{y}.png" data-testid="geo-tiles"
            onChange={(e) => patch({ settings: { ...q.settings, mapTiles: e.target.value || undefined } })} /></label>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Exports as <code>{q.variableName}</code> (address or lat,lng), <code>{q.variableName}_LAT</code>, <code>{q.variableName}_LNG</code>
          {(q.settings.geoMode ?? "pin") === "radius" ? <>, <code>{q.variableName}_RADIUS_M</code></> : null}
          {(q.settings.geoMode ?? "pin") === "address" ? <>, <code>{q.variableName}_CITY</code>, <code>{q.variableName}_COUNTRY</code>, <code>{q.variableName}_POSTAL</code></> : null}.
          Distance between two places: <code>distance_km(Q1, Q2)</code> in a calculated question.
          {(q.settings.geoMode ?? "pin") === "address" ? " Address search needs GEOCODE_API_URL on the runtime; without it the typed address is kept." : ""}
        </div>
      </div>
      </CollapsibleSection>
      )}

      {/*
        * FOLLOW-UP PROBE — "tell me more" on an open end, asked after the page
        * is submitted, up to N times, without touching the flow. Configuration
        * on the question, not a question type (schema ProbeConfig).
        */}
      {(PROBE_TYPES as readonly string[]).includes(q.type) && showSec("Follow-up probe") && (
      <CollapsibleSection id="probe" title="Follow-up probe" active={!!q.probe}>
      <label className="row" style={{ gap: 4, fontSize: 13, marginBottom: 8 }}>
        <input type="checkbox" checked={!!q.probe} data-testid="probe-toggle"
          onChange={(e) => patch({ probe: e.target.checked ? { maxProbes: 1, minWords: 0, required: false } : undefined })} />
        ask a follow-up after this answer
      </label>
      {q.probe && (
        <div className="card" style={{ padding: 10 }}>
          <label className="f"><span>Wording (blank = the AI writes it from the answer)</span>
            <textarea className="ta" style={{ minHeight: 56 }} value={q.probe.prompt ?? ""} data-testid="probe-prompt"
              placeholder="You said “{answer}” — what made you feel that way?"
              onChange={(e) => patch({ probe: { ...q.probe!, prompt: e.target.value || undefined } })} /></label>
          {!q.probe.prompt && (
            <label className="f"><span>Instruction for the AI</span>
              <input className="input" value={q.probe.instruction ?? ""} data-testid="probe-instruction"
                placeholder="find out which part of the experience they mean"
                onChange={(e) => patch({ probe: { ...q.probe!, instruction: e.target.value || undefined } })} /></label>
          )}
          <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
            <label className="f" style={{ width: 120 }}><span>Most follow-ups</span>
              <input className="input" type="number" min={1} max={5} value={q.probe.maxProbes} data-testid="probe-max"
                onChange={(e) => patch({ probe: { ...q.probe!, maxProbes: Math.min(5, Math.max(1, Number(e.target.value) || 1)) } })} /></label>
            <label className="f" style={{ width: 160 }}><span>Only if the answer has ≥ words</span>
              <input className="input" type="number" min={0} value={q.probe.minWords} data-testid="probe-min-words"
                onChange={(e) => patch({ probe: { ...q.probe!, minWords: Math.max(0, Number(e.target.value) || 0) } })} /></label>
            <label className="row" style={{ gap: 4, fontSize: 13, alignSelf: "end" }}>
              <input type="checkbox" checked={q.probe.required}
                onChange={(e) => patch({ probe: { ...q.probe!, required: e.target.checked } })} /> answer required
            </label>
          </div>
          <div className="logic-rule" style={{ marginTop: 8 }}>
            <div className="logic-if">IF</div>
            <OptionalCondition label="ask only when these hold"
              hint="Nothing here means the follow-up is asked whenever the question was answered."
              value={q.probe.when} onChange={(c) => patch({ probe: { ...q.probe!, when: c } })} />
            <OptionalCondition label="stop probing once these hold"
              hint="Evaluated after every follow-up answer."
              value={q.probe.stopWhen} onChange={(c) => patch({ probe: { ...q.probe!, stopWhen: c } })} />
          </div>
          {lintProbeQuestion(q).map((m, i) => (
            <div key={i} className="muted" data-testid="probe-lint" style={{ fontSize: 12.5, color: "#7a4b00", marginTop: 6 }}>{m}</div>
          ))}
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Answers export as <code>{q.variableName}_PROBE_1</code>{q.probe.maxProbes > 1 ? ` … _PROBE_${q.probe.maxProbes}` : ""}, the wording asked as <code>{q.variableName}_PROBE_1_Q</code>. The programmed flow is not changed.
          </div>
        </div>
      )}
      </CollapsibleSection>
      )}

      {hasCap("carry_forward") && showSec("Carry-forward") && (
      <CollapsibleSection id="carry-forward" title="Carry-forward (dynamic options)" active={!!q.carryForward}>
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
            <label className="row" style={{ gap: 4, fontSize: 13 }}>
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
      </CollapsibleSection>
      )}

      {/*
        * OPTION GROUPS (§13–30), directly above Randomization on purpose.
        *
        * The two interact and a programmer needs to see that: when a question
        * has groups, the group order wins and the flat randomization below is
        * ignored, because a flat shuffle would move an item out of its group.
        * The lint inside the groups panel says so; putting them adjacent means
        * the setting that is being overridden is visible at the same time.
        */}
      {hasCap("randomization") && showSec("Option groups") && (
      <CollapsibleSection id="option-groups" title="Option groups" active={hasOptionGroups(q, "options")}>
      <OptionGroupsEditor q={q} patch={patch} />
      </CollapsibleSection>
      )}

      {hasCap("randomization") && showSec("Randomization") && (
      <CollapsibleSection id="randomization" title="Randomization" active={q.randomization?.enabled ?? false}>
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
            <label className="row" style={{ gap: 4, fontSize: 13 }}>
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
          <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 8px" }}>
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
                <label className="row" style={{ gap: 4, fontSize: 13 }}>
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

      </CollapsibleSection>
      )}

      {hasCap("list_logic") && showSec("Masking") && (
      <CollapsibleSection id="masking" title="Masking (dynamic option sets)" active={!!q.mask}>
      <MaskingBuilder q={q} patch={patch} field="mask" />
      </CollapsibleSection>
      )}

      {hasCap("list_logic") && showSec("List logic") && (
      <CollapsibleSection id="list-logic" title="List logic (from previous questions)" active={(q.listLogic?.length ?? 0) > 0}>
      <p className="muted" style={{ fontSize: 12.5, marginTop: -2 }}>
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
      </CollapsibleSection>
      )}

      {hasCap("list_logic") && showSec("List operations") && (
      <CollapsibleSection id="list-operations" title="List operations (intersection / union / difference)" active={(q.optionPipeline?.length ?? 0) > 0}>
      <ListOperationsEditor q={q} patch={patch} />
      </CollapsibleSection>
      )}

      {/*
       * The identical mask engine, aimed at rows and columns instead of
       * options — shown only for question types that actually have them
       * (matrix/grid/composite), matching the universal masking brief's
       * "the UI shows only the dimensions this question type supports."
       */}
      {q.rows.length > 0 && showSec("Row masking") && (
      <CollapsibleSection id="row-masking" title="Row masking (dynamic row sets)" active={!!q.rowMask}>
      <MaskingBuilder q={q} patch={patch} field="rowMask" />
      </CollapsibleSection>
      )}

      {q.columns.length > 0 && showSec("Column masking") && (
      <CollapsibleSection id="column-masking" title="Column masking (dynamic column sets)" active={!!q.columnMask}>
      <MaskingBuilder q={q} patch={patch} field="columnMask" />
      </CollapsibleSection>
      )}

      {/*
       * ITS OWN TOP-LEVEL SECTION, not nested inside masking — Auto Punch
       * targets any question type (numeric, hidden, matrix/composite cells,
       * not just the choice-like types masking applies to), so it is not
       * gated behind masking's capability check.
       */}
      {showSec("Auto punch") && (
      <CollapsibleSection id="auto-punch" title="Auto punch" active={(q.punches?.length ?? 0) > 0}>
      <PunchRules q={q} patch={patch} />
      </CollapsibleSection>
      )}

      {showSec("Validation rules") && (
      <CollapsibleSection id="validation-rules" title="Validation rules" active={(q.validation?.length ?? 0) > 0}>
      <ValidationEditor q={q} patch={patch} />
      </CollapsibleSection>
      )}

      {showSec("State") && (
      <CollapsibleSection id="state" title="State"
        active={q.settings.hidden || q.settings.readOnly || !!q.settings.defaultValue}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="row" style={{ gap: 4, fontSize: 13 }}>
          <input type="checkbox" checked={q.settings.hidden}
            onChange={(e) => patch({ settings: { ...q.settings, hidden: e.target.checked } })} /> hidden
        </label>
        <label className="row" style={{ gap: 4, fontSize: 13 }}>
          <input type="checkbox" checked={q.settings.readOnly}
            onChange={(e) => patch({ settings: { ...q.settings, readOnly: e.target.checked } })} /> read-only
        </label>
        {hasCap("speech_input") && (
          <label className="row" style={{ gap: 4, fontSize: 13 }} title="Adds a microphone; the transcript becomes the ordinary text answer">
            <input type="checkbox" checked={!!q.settings.speechInput} data-testid="speech-input-toggle"
              onChange={(e) => patch({ settings: { ...q.settings, speechInput: e.target.checked || undefined } })} /> allow dictation
          </label>
        )}
      </div>
      {hasCap("speech_input") && q.settings.speechInput && (
        <label className="f" style={{ marginTop: 8 }}><span>Dictation language (BCP-47, blank = survey language)</span>
          <input className="input mono" value={q.settings.speechLang ?? ""} placeholder="en-GB, hi-IN, de-DE…"
            data-testid="speech-lang"
            onChange={(e) => patch({ settings: { ...q.settings, speechLang: e.target.value || undefined } })} /></label>
      )}
      <label className="f" style={{ marginTop: 8 }}><span>Default / piped value</span>
        <input className="input mono" value={String(q.settings.defaultValue ?? "")}
          placeholder='static, or {{Q1}} piped'
          onChange={(e) => patch({ settings: { ...q.settings, defaultValue: e.target.value || undefined } })} /></label>
      </CollapsibleSection>
      )}

      {showSec("Custom code") && (
      <CollapsibleSection id="custom-code" title="Custom code"
        active={!!q.customJs || !!q.customCss || !!q.customHtml}>
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
      </CollapsibleSection>
      )}
    </div>
    </LoopScopeProvider>
  );
}
