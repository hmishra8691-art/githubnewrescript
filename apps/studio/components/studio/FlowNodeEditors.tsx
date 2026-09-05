"use client";
import React from "react";
import type { FlowNode, EmbeddedDataType } from "@rescript/schema";
import {
  EMBEDDED_TYPES, checkEmbeddedExpression, normalizeExpression, coerceEmbedded,
  validateRedirectUrl, urlVariableCatalog, embeddedCatalog,
} from "@rescript/engine";
import { useStudio, uid } from "./store";
import { OptionalCondition, ConditionEditor, conditionToText } from "./ConditionBuilder";
import { LoopEditor } from "./LoopEditor";

/**
 * The property editors for each kind of flow element.
 *
 * These are what the flow cards open into. The two rebuilt here are the ones
 * the brief calls out: embedded data (typed, with expressions — reqs §12–14)
 * and redirect (validated, with a variable picker — reqs §17–18).
 */

/* ==================================================== expression builder */

const OPERATOR_KEYS = ["+", "-", "*", "/", "(", ")", ">", "<", ">=", "<=", "==", "!="];
const FUNCTION_KEYS = ["sum(", "avg(", "round(", "min(", "max(", "if("];

/**
 * A text expression with a click-to-insert palette and live checking (req §14).
 *
 * The stored value is always the expression text — the same string the engine
 * evaluates and the exports show. A structured builder that stored its own
 * tree would need a second evaluator to agree with the first one.
 */
export function ExpressionField({ value, dataType, onChange, placeholder }: {
  value: string;
  dataType?: EmbeddedDataType;
  onChange(v: string): void;
  placeholder?: string;
}) {
  const s = useStudio();
  const [showPalette, setShowPalette] = React.useState(false);
  const ref = React.useRef<HTMLTextAreaElement>(null);

  const insert = (text: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, at)}${text}${value.slice(el?.selectionEnd ?? at)}`;
    onChange(next);
    // put the caret after what was just inserted, so clicking [+] [Q2] reads
    // left to right the way the palette implies
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = at + text.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const check = value.trim() ? checkEmbeddedExpression(s.def, value, dataType) : null;
  const normalized = value.trim() ? normalizeExpression(value) : "";
  const rewritten = normalized !== value.trim() ? normalized : null;

  return (
    <div className="expr-field">
      <textarea ref={ref} className="ta code expr-input" data-testid="expr-input"
        rows={2} value={value} placeholder={placeholder ?? 'Q1 + Q2 + Q3   —  or  IF Q1 > 10 THEN "High" ELSE "Low"'}
        onChange={(e) => onChange(e.target.value)} />
      <div className="row expr-tools">
        <button className="btn small" data-testid="expr-palette-toggle"
          onClick={() => setShowPalette((v) => !v)}>
          {showPalette ? "hide builder" : "⌗ builder"}
        </button>
        {check && (
          <span className={`chip ${check.ok ? "on" : "warn"}`} data-testid="expr-status">
            {check.ok ? "valid" : check.error}
          </span>
        )}
        {check?.ok && check.resultNote && <span className="muted" style={{ fontSize: 11 }}>{check.resultNote}</span>}
      </div>
      {rewritten && (
        <div className="muted mono expr-normalized" style={{ fontSize: 11 }}>
          reads as: {rewritten}
        </div>
      )}
      {showPalette && (
        <div className="expr-palette" data-testid="expr-palette">
          <div className="ep-group">
            <span className="flabel">Questions</span>
            <div className="ep-keys">
              {s.def.questions.slice(0, 40).map((q) => (
                <button key={q.id} className="ep-key" title={q.text.replace(/<[^>]*>/g, "").slice(0, 60)}
                  onClick={() => insert(q.variableName)}>{q.variableName}</button>
              ))}
              {s.def.questions.length === 0 && <span className="muted" style={{ fontSize: 11 }}>no questions yet</span>}
            </div>
          </div>
          {embeddedCatalog(s.def).length > 0 && (
            <div className="ep-group">
              <span className="flabel">Embedded data</span>
              <div className="ep-keys">
                {embeddedCatalog(s.def).map((e) => (
                  <button key={e.name} className="ep-key" title={`${e.dataType}`}
                    onClick={() => insert(e.name)}>{e.name}</button>
                ))}
              </div>
            </div>
          )}
          {s.def.calculations.length > 0 && (
            <div className="ep-group">
              <span className="flabel">Calculations</span>
              <div className="ep-keys">
                {s.def.calculations.map((c) => (
                  <button key={c.id} className="ep-key" onClick={() => insert(c.targetVariable)}>
                    {c.targetVariable}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="ep-group">
            <span className="flabel">Operators</span>
            <div className="ep-keys">
              {OPERATOR_KEYS.map((op) => (
                <button key={op} className="ep-key op" onClick={() => insert(` ${op} `)}>{op}</button>
              ))}
            </div>
          </div>
          <div className="ep-group">
            <span className="flabel">Functions & conditions</span>
            <div className="ep-keys">
              {FUNCTION_KEYS.map((fn) => (
                <button key={fn} className="ep-key op" onClick={() => insert(fn)}>{fn}</button>
              ))}
              <button className="ep-key op" onClick={() => insert('IF  THEN "" ELSE ""')}>IF … THEN … ELSE</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================== typed embedded data */

/** Embedded data: a name, a type, where the value comes from (reqs §12–13). */
export function EmbeddedDataEditor({ node, onChange }: {
  node: Extract<FlowNode, { type: "embedded_data" }>;
  onChange(n: FlowNode): void;
}) {
  const setField = (i: number, patch: Record<string, unknown>) =>
    onChange({ ...node, fields: node.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  return (
    <div className="ed-editor">
      <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
        Captured values become variables you can use in any logic, in piping and in
        redirect URLs. The type decides how the value is read — an Integer
        <code> score</code> compares as a number, so 9 is less than 80 rather than after it.
      </p>
      {node.fields.map((f, i) => {
        const dataType = (f.dataType ?? "string") as EmbeddedDataType;
        return (
          <div key={i} className="card ed-field" data-testid="ed-field">
            <div className="row ed-row1">
              <label className="f grow" style={{ marginBottom: 0 }}>
                <span>Variable name</span>
                <input className="input mono" data-testid="ed-name" value={f.name}
                  placeholder="customer_score"
                  onChange={(e) => setField(i, { name: e.target.value.replace(/\s+/g, "_") })} />
              </label>
              <label className="f" style={{ marginBottom: 0, width: 132 }}>
                <span>Data type</span>
                <select className="select" data-testid="ed-type" value={dataType}
                  onChange={(e) => setField(i, { dataType: e.target.value as EmbeddedDataType })}>
                  {EMBEDDED_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </label>
              <label className="f" style={{ marginBottom: 0, width: 140 }}>
                <span>Value from</span>
                <select className="select" data-testid="ed-source" value={f.source}
                  onChange={(e) => setField(i, { source: e.target.value })}>
                  <option value="url">URL parameter</option>
                  <option value="panel">Panel</option>
                  <option value="static">Fixed value</option>
                  <option value="expression">Calculation</option>
                </select>
              </label>
              <button className="btn small danger" title="Remove this field"
                onClick={() => onChange({ ...node, fields: node.fields.filter((_, j) => j !== i) })}>×</button>
            </div>

            <div className="ed-row2">
              {f.source === "static" && (
                <label className="f" style={{ marginBottom: 0 }}>
                  <span>Value</span>
                  <input className="input" data-testid="ed-value" value={f.value ?? ""}
                    onChange={(e) => setField(i, { value: e.target.value })} />
                </label>
              )}
              {f.source === "expression" && (
                <label className="f" style={{ marginBottom: 0 }}>
                  <span>Expression</span>
                  <ExpressionField value={f.value ?? ""} dataType={dataType}
                    onChange={(v) => setField(i, { value: v })} />
                </label>
              )}
              {(f.source === "url" || f.source === "panel") && (
                <p className="muted" style={{ fontSize: 11, margin: "2px 0 6px" }}>
                  Read from <code>?{f.name || "name"}=…</code> when the respondent arrives.
                </p>
              )}
              <label className="f" style={{ marginBottom: 0, maxWidth: 260 }}>
                <span>Default value {f.source === "static" ? "(unused for a fixed value)" : "(when nothing arrives)"}</span>
                <input className="input" data-testid="ed-default" value={f.defaultValue ?? ""}
                  placeholder={dataType === "integer" ? "25" : dataType === "boolean" ? "false" : ""}
                  onChange={(e) => setField(i, { defaultValue: e.target.value || undefined })} />
              </label>
              <TypePreview dataType={dataType} raw={f.source === "static" ? f.value : f.defaultValue} />
            </div>
          </div>
        );
      })}
      <button className="btn small" data-testid="ed-add-field"
        onClick={() => onChange({
          ...node,
          fields: [...node.fields, { name: "", source: "url", dataType: "string" }],
        })}>+ add field</button>
    </div>
  );
}

/** Shows how the declared type will read the value — before any respondent does. */
function TypePreview({ dataType, raw }: { dataType: EmbeddedDataType; raw?: string }) {
  if (!raw) return null;
  // the engine's own coercion, so this preview cannot disagree with the runtime
  const { value, error } = coerceEmbedded(dataType, raw);
  return (
    <div className="row" style={{ marginTop: 4 }}>
      <span className={`chip ${error ? "warn" : "on"}`} data-testid="ed-preview">
        {error ? error : `stored as ${dataType}: ${JSON.stringify(value)}`}
      </span>
    </div>
  );
}

/* ========================================================= redirect */

/** Redirect: a validated URL that may carry survey values (reqs §17–18). */
export function RedirectEditor({ node, onChange }: {
  node: Extract<FlowNode, { type: "redirect" }>;
  onChange(n: FlowNode): void;
}) {
  const s = useStudio();
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const check = validateRedirectUrl(node.url);
  const catalog = urlVariableCatalog(s.def);
  const groups = [...new Set(catalog.map((v) => v.group))];
  const f = filter.trim().toLowerCase();

  const insertToken = (token: string) => {
    const el = inputRef.current;
    const at = el?.selectionStart ?? node.url.length;
    onChange({ ...node, url: `${node.url.slice(0, at)}${token}${node.url.slice(el?.selectionEnd ?? at)}` });
    setPickerOpen(false);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = at + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="redirect-editor">
      <label className="f">
        <span>Redirect URL</span>
        <div className="row">
          <input ref={inputRef} className="input grow mono" data-testid="redirect-url"
            value={node.url} placeholder="https://example.com/completed"
            onChange={(e) => onChange({ ...node, url: e.target.value })} />
          <div className="menu-anchor">
            <button className="btn small" data-testid="redirect-insert-var"
              onClick={() => setPickerOpen((v) => !v)}>+ variable</button>
            {pickerOpen && (
              <>
                <div className="menu-scrim" onClick={() => setPickerOpen(false)} />
                <div className="menu wide" role="menu" data-testid="redirect-var-menu">
                  <input className="input" autoFocus placeholder="search variables…"
                    value={filter} onChange={(e) => setFilter(e.target.value)} />
                  <div className="menu-scroll">
                    {groups.map((g) => {
                      const items = catalog.filter(
                        (v) => v.group === g && (!f || v.label.toLowerCase().includes(f) || v.token.toLowerCase().includes(f)),
                      );
                      if (!items.length) return null;
                      return (
                        <div key={g}>
                          <div className="menu-group">{g}</div>
                          {items.slice(0, 25).map((v) => (
                            <button key={v.token} className="menu-item" onClick={() => insertToken(v.token)}>
                              <span className="mi-label">{v.label}</span>
                              <span className="mi-hint mono">{v.token}</span>
                            </button>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </label>

      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <span className={`chip ${check.ok ? "on" : "warn"}`} data-testid="redirect-url-status">
          {check.ok ? (check.warning ?? "valid URL") : check.error}
        </span>
        {check.tokens.length > 0 && (
          <span className="muted" style={{ fontSize: 11 }} data-testid="redirect-tokens">
            carries {check.tokens.length} value{check.tokens.length === 1 ? "" : "s"}: {check.tokens.join(" ")}
          </span>
        )}
      </div>

      <div className="row" style={{ marginTop: 8, gap: 16 }}>
        <label className="row" style={{ gap: 5, fontSize: 12 }}>
          <input type="radio" name={`win_${node.id}`} checked={!node.newWindow}
            data-testid="redirect-same-window"
            onChange={() => onChange({ ...node, newWindow: undefined })} />
          Open in same window
        </label>
        <label className="row" style={{ gap: 5, fontSize: 12 }}>
          <input type="radio" name={`win_${node.id}`} checked={!!node.newWindow}
            data-testid="redirect-new-window"
            onChange={() => onChange({ ...node, newWindow: true })} />
          Open in new window
        </label>
      </div>

      <OptionalCondition label="Redirect only when" value={node.when}
        onChange={(c) => onChange({ ...node, when: c })} />
    </div>
  );
}

/* ================================================== every other element */

export function NodeEditor({ node, onChange }: { node: FlowNode; onChange(n: FlowNode): void }) {
  const s = useStudio();
  switch (node.type) {
    case "page":
      return (
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input" style={{ width: 220 }} value={node.title ?? ""}
              placeholder="Page title" onChange={(e) => onChange({ ...node, title: e.target.value })} />
            <span className="muted mono" style={{ fontSize: 11 }}>{node.id}</span>
          </div>
          <div className="flabel">Questions on this page</div>
          {node.questionIds.map((qid, i) => {
            const q = s.def.questions.find((x) => x.id === qid);
            return (
              <div key={qid} className="opt-row">
                <span className="mono grow">
                  {q ? `${q.code} — ${q.text.replace(/<[^>]*>/g, "").slice(0, 60)}` : `⚠ missing ${qid}`}
                </span>
                <button className="btn small" onClick={() => {
                  if (i === 0) return;
                  const ids = [...node.questionIds];
                  [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                  onChange({ ...node, questionIds: ids });
                }}>↑</button>
                <button className="btn small danger"
                  onClick={() => onChange({ ...node, questionIds: node.questionIds.filter((x) => x !== qid) })}>×</button>
              </div>
            );
          })}
          <select className="select" style={{ width: 260, marginTop: 4 }} value=""
            onChange={(e) => {
              if (e.target.value) onChange({ ...node, questionIds: [...node.questionIds, e.target.value] });
            }}>
            <option value="">+ add question to page…</option>
            {s.def.questions.filter((q) => !node.questionIds.includes(q.id))
              .map((q) => <option key={q.id} value={q.id}>{q.code} — {q.variableName}</option>)}
          </select>
          <OptionalCondition label="Show page only when" value={node.visibleIf}
            onChange={(c) => onChange({ ...node, visibleIf: c })} />
        </div>
      );

    case "section":
    case "block":
      return (
        <div>
          <label className="f">
            <span>Name</span>
            <input className="input" style={{ maxWidth: 280 }} value={node.title ?? ""}
              onChange={(e) => onChange({ ...node, title: e.target.value })} />
          </label>
          <OptionalCondition label="Show only when" value={node.visibleIf}
            onChange={(c) => onChange({ ...node, visibleIf: c })} />
        </div>
      );

    case "randomizer":
      return (
        <div>
          <label className="f">
            <span>Name (optional)</span>
            <input className="input" style={{ maxWidth: 280 }} value={node.title ?? ""}
              placeholder="Randomizer" onChange={(e) => onChange({ ...node, title: e.target.value || undefined })} />
          </label>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label className="row" style={{ gap: 6, fontSize: 12 }}>
              show
              <input className="input" style={{ width: 64 }} type="number" min={1}
                data-testid="randomizer-show"
                value={node.show ?? ""} placeholder="all"
                onChange={(e) => onChange({ ...node, show: e.target.value === "" ? undefined : Number(e.target.value) })} />
              of {node.children.length}, in random order
            </label>
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
              <input type="checkbox" checked={node.evenPresentation ?? false}
                onChange={(e) => onChange({ ...node, evenPresentation: e.target.checked || undefined })} />
              even presentation
            </label>
          </div>
          <p className="muted" style={{ fontSize: 11 }}>
            Anything can go inside: blocks, groups, even another randomizer. Drag it onto
            this card, or use <em>+ Add element</em> inside it.
          </p>
        </div>
      );

    case "branch":
      return (
        <div>
          <label className="f">
            <span>Name (optional)</span>
            <input className="input" style={{ maxWidth: 280 }} value={node.title ?? ""}
              placeholder="Branch" onChange={(e) => onChange({ ...node, title: e.target.value || undefined })} />
          </label>
          {node.branches.map((b, i) => (
            <div key={b.id} className="card" style={{ padding: 10 }}>
              <div className="row" style={{ marginBottom: 4 }}>
                <span className="flabel" style={{ margin: 0 }}>IF</span>
                <input className="input grow" placeholder="name this path" value={b.label ?? ""}
                  onChange={(e) => onChange({
                    ...node,
                    branches: node.branches.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  })} />
                <button className="btn small danger" title="Remove this path"
                  disabled={node.branches.length <= 1}
                  onClick={() => onChange({ ...node, branches: node.branches.filter((_, j) => j !== i) })}>×</button>
              </div>
              <ConditionEditor value={b.when} onChange={(when) =>
                onChange({ ...node, branches: node.branches.map((x, j) => (j === i ? { ...x, when } : x)) })} />
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                THEN run what is nested under “{b.label || conditionToText(b.when, s.def) || "this path"}” below.
              </div>
            </div>
          ))}
          <button className="btn small" data-testid="branch-add-path"
            onClick={() => onChange({
              ...node,
              branches: [...node.branches, {
                id: uid("br"), when: { type: "group", op: "and", children: [] }, children: [],
              }],
            })}>+ add path</button>
        </div>
      );

    case "loop":
      // the loop has its own editor — source, filters, count, order, the
      // loop-scoped reference table and the simulator (LoopEditor.tsx)
      return <LoopEditor node={node} onChange={onChange as never} />;

    case "embedded_data":
      return <EmbeddedDataEditor node={node} onChange={onChange} />;

    case "redirect":
      return <RedirectEditor node={node} onChange={onChange} />;

    case "quota_check":
      return (
        <div className="row" style={{ flexWrap: "wrap" }}>
          <select className="select" multiple size={Math.max(2, Math.min(4, s.def.quotas.length))}
            value={node.quotaIds}
            onChange={(e) => onChange({ ...node, quotaIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
            {s.def.quotas.map((qt) => <option key={qt.id} value={qt.id}>{qt.name}</option>)}
          </select>
          <span className="flabel" style={{ margin: 0 }}>when full →</span>
          <select className="select" value={node.onFull.kind}
            onChange={(e) => onChange({ ...node, onFull: { ...node.onFull, kind: e.target.value as any } })}>
            <option value="terminate">terminate</option>
            <option value="redirect">redirect</option>
            <option value="flag">flag &amp; continue</option>
            <option value="continue">continue</option>
          </select>
          {node.onFull.kind === "redirect" && (
            <input className="input grow mono" placeholder="https://…" value={node.onFull.url ?? ""}
              onChange={(e) => onChange({ ...node, onFull: { ...node.onFull, url: e.target.value } })} />
          )}
        </div>
      );

    case "end":
      return (
        <div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <select className="select" value={node.status}
              onChange={(e) => onChange({ ...node, status: e.target.value as any })}>
              <option value="complete">complete</option>
              <option value="screened">screened</option>
              <option value="quota_full">quota full</option>
              <option value="terminated">terminated</option>
            </select>
            <input className="input grow" placeholder="end message (piping allowed)" value={node.message ?? ""}
              onChange={(e) => onChange({ ...node, message: e.target.value || undefined })} />
          </div>
          <label className="f" style={{ marginTop: 8 }}>
            <span>Redirect on finish (optional — variables allowed)</span>
            <input className="input mono" placeholder="https://panel.com/done?id={{ed.PANEL_ID}}"
              data-testid="end-redirect-url"
              value={node.redirectUrl ?? ""}
              onChange={(e) => onChange({ ...node, redirectUrl: e.target.value || undefined })} />
          </label>
          {node.redirectUrl && (
            <span className={`chip ${validateRedirectUrl(node.redirectUrl).ok ? "on" : "warn"}`}>
              {validateRedirectUrl(node.redirectUrl).ok
                ? (validateRedirectUrl(node.redirectUrl).warning ?? "valid URL")
                : validateRedirectUrl(node.redirectUrl).error}
            </span>
          )}
        </div>
      );
  }
}
