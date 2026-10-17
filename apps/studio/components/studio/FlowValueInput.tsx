"use client";
import React from "react";
import type { SurveyDefinition, EmbeddedDataType } from "@rescript/schema";
import {
  coerceEmbedded, detectValueType, testEmbeddedValue, testReferences, type EmbeddedField,
} from "@rescript/engine";
import { compactWidthCh, previewText, insertAt } from "@/lib/flow/flowEd";

/**
 * VALUE FIELDS OF THE SURVEY FLOW (document 15/10/2026, items B and E).
 *
 * `CompactValueInput` — compact by default, wider as the text grows, never
 * wider than its container: past that it wraps and grows DOWN, up to a few
 * lines, then scrolls. No width setting, no overlap, and a list of hundreds
 * of ZIP codes cannot push the card sideways.
 *
 * `StoredAsPreview` — "stored as …", shortened with a "show all" control.
 *
 * `TestValuePanel` — the field run as the flow would run it, with SAMPLE
 * values typed in the panel (`testEmbeddedValue`).
 */

export interface CompactValueHandle {
  /** insert at the cursor (or over the selection) and keep editing after it */
  insert(token: string): void;
}

export const CompactValueInput = React.forwardRef<CompactValueHandle, {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  mono?: boolean;
  testId?: string;
  inputMode?: React.HTMLAttributes<HTMLTextAreaElement>["inputMode"];
  ariaLabel?: string;
}>(function CompactValueInput({ value, onChange, placeholder, mono, testId, inputMode, ariaLabel }, ref) {
  const el = React.useRef<HTMLTextAreaElement>(null);
  /* the height follows the content: one line by default, growing to the CSS max, then scrolling */
  React.useLayoutEffect(() => {
    const t = el.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + 2}px`;
  }, [value]);
  React.useImperativeHandle(ref, () => ({
    insert(token: string) {
      const t = el.current;
      const r = insertAt(value, t?.selectionStart, t?.selectionEnd, token);
      onChange(r.value);
      requestAnimationFrame(() => {
        if (!t) return;
        t.focus();
        t.setSelectionRange(r.caret, r.caret);
      });
    },
  }), [value, onChange]);
  return (
    <textarea ref={el} rows={1} className={`input compact-value${mono ? " mono" : ""}`} data-testid={testId}
      aria-label={ariaLabel} value={value} placeholder={placeholder} inputMode={inputMode}
      spellCheck={mono ? false : undefined} autoCapitalize={mono ? "off" : undefined}
      style={{ width: `${compactWidthCh(value || placeholder || "", 14)}ch` }}
      onChange={(e) => onChange(e.target.value)} />
  );
});

/** "stored as integer: 25", shortened when long, with a control to see all of it. */
export function StoredAsPreview({ dataType, raw, piped }: { dataType: EmbeddedDataType; raw?: string; piped?: boolean }) {
  const [all, setAll] = React.useState(false);
  if (!raw) return null;
  if (piped) {
    return (
      <div className="row ed-preview-row">
        <span className="chip ed-preview" data-testid="ed-preview">
          resolved where this element runs — use Test value to see the result
        </span>
      </div>
    );
  }
  // the engine's own coercion, so this preview cannot disagree with the runtime
  const { value, error } = coerceEmbedded(dataType, raw);
  const shownType = dataType === "auto" ? (() => { const d = detectValueType(value); return d === "empty" ? "string" : d; })() : dataType;
  const text = error ? error : dataType === "url" ? `stored as url: ${String(value)}` : `stored as ${shownType}: ${JSON.stringify(value)}`;
  const p = previewText(text, 140);
  return (
    <div className="row ed-preview-row">
      <span className={`chip ed-preview ${error ? "warn" : "on"}`} data-testid="ed-preview" title={p.truncated && !all ? text : undefined}>
        {all || !p.truncated ? text : p.shown}
      </span>
      {p.truncated && (
        <button type="button" className="btn small ghost" data-testid="ed-preview-expand" aria-expanded={all}
          onClick={() => setAll((v) => !v)}>
          {all ? "show less" : `show all (${p.length.toLocaleString()} characters)`}
        </button>
      )}
    </div>
  );
}

/** The Test Value panel: sample inputs for what the value reads, and the result. */
export function TestValuePanel({ def, field, loop }: { def: SurveyDefinition; field: EmbeddedField; loop?: boolean }) {
  const refs = React.useMemo(() => testReferences(def, field), [def, field]);
  const [samples, setSamples] = React.useState<Record<string, string>>({});
  const result = React.useMemo(() => {
    try { return testEmbeddedValue(def, field, samples, { loop }); } catch { return null; }
  }, [def, field, samples, loop]);
  const askable = refs.filter((r) => !r.problem && !r.automatic);
  const automatic = refs.filter((r) => r.automatic && !r.problem);
  return (
    <div className="ed-test" data-testid="ed-test-panel" role="region" aria-label="Test value with sample data">
      <div className="ed-test-head">
        <strong>Test value</strong>
        <span className="chip" data-testid="ed-test-sample-badge">sample test data</span>
      </div>
      <p className="muted ed-test-note">
        Type sample values below to see what this field would store. They are test data only — nothing is
        saved, and no respondent's data is used.
      </p>
      {askable.length > 0 && (
        <div className="ed-test-inputs">
          {askable.map((r) => (
            <label key={r.key} className="f ed-test-input">
              <span>{r.label}</span>
              <input className="input" data-testid="ed-test-input" data-ref={r.ref}
                placeholder={r.suggested ? `${r.suggested} (its fixed value)` : "sample value"}
                value={samples[r.key] ?? ""} onChange={(e) => setSamples((s) => ({ ...s, [r.key]: e.target.value }))} />
            </label>
          ))}
        </div>
      )}
      {automatic.length > 0 && (
        <p className="muted ed-test-note">
          Filled in by the platform at test time: {automatic.map((r) => r.label).join(", ")}.
        </p>
      )}
      {result && (
        <dl className="ed-test-result">
          <dt>Expression</dt>
          <dd><code className="mono" data-testid="ed-test-expression">{result.expression || "(empty)"}</code></dd>
          {field.source === "static" && (<>
            <dt>Resolved</dt>
            <dd><code className="mono" data-testid="ed-test-resolved">{previewText(result.resolved, 400).shown || "(empty)"}</code></dd>
          </>)}
          <dt>Stored as</dt>
          <dd data-testid="ed-test-stored">
            <span className="mono">{result.storedType}</span>: <code className="mono">{previewText(JSON.stringify(result.stored), 400).shown}</code>
          </dd>
        </dl>
      )}
      {result?.error && <div className="fi-issue warning" data-testid="ed-test-error">⚠ {result.error}</div>}
      {result?.warnings.map((w) => <div key={w} className="fi-issue warning" data-testid="ed-test-warning">⚠ {w}</div>)}
    </div>
  );
}
