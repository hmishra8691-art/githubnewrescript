"use client";
import React from "react";
import type { Question, Option, SurveyDefinition, QuestionColumn } from "@rescript/schema";
import { variantRegistry } from "@rescript/schema";
import {
  effectiveQuestion,
  resolvePiping,
  evaluateExpression,
  flattenVariables,
  toggleMultiValue,
  normalizeMultiValue,
  fieldInputProps,
  type EvalContext,
  type ResponseState,
  type LoopContext,
} from "@rescript/engine";

export interface QRProps {
  def: SurveyDefinition;
  q: Question;
  state: ResponseState;
  loop: LoopContext | null;
  value: unknown;
  otherValue?: string;
  errors: string[];
  onChange(value: unknown): void;
  onOtherChange?(text: string): void;
}

const OTHER = (o: Option) => o.flags?.includes("other_specify");
const EXCLUSIVE = (o: Option) =>
  o.flags?.includes("exclusive") || o.flags?.includes("none_of_above") ||
  o.flags?.includes("dont_know") || o.flags?.includes("refused");

function ctxOf(p: QRProps): EvalContext {
  return { def: p.def, state: p.state, loop: p.loop };
}

/** N-column option layout (req §10) with a mobile fallback in CSS. */
function optionsClass(p: QRProps): string {
  const n = p.q.settings.columnsLayout ?? 1;
  return n > 1 ? `rs-options cols-${Math.min(n, 4)}` : "rs-options";
}

/** Search box for long option lists (req §9). */
function useOptionFilter(options: Option[], threshold = 25) {
  const [filter, setFilter] = React.useState("");
  const filtered = React.useMemo(() => {
    if (!filter.trim()) return options;
    const f = filter.toLowerCase();
    return options.filter((o) =>
      o.label.replace(/<[^>]*>/g, "").toLowerCase().includes(f),
    );
  }, [options, filter]);
  const searchBox =
    options.length > threshold ? (
      <input
        className="rs-input rs-optfilter"
        placeholder={`Search ${options.length} options…`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
    ) : null;
  return { filtered, searchBox };
}

/* ------------------------------------------------ single select / dropdown */
function SingleSelect(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const { filtered, searchBox } = useOptionFilter(options);
  return (
    <div>
    {searchBox}
    <div className={optionsClass(p)} role="radiogroup">
      {filtered.map((o) => {
        const sel = String(p.value) === String(o.code);
        return (
          <label key={String(o.code)} className={`rs-option ${sel ? "selected" : ""}`}>
            <input
              type="radio"
              name={p.q.id}
              checked={sel}
              onChange={() => p.onChange(o.code)}
              disabled={p.q.settings.readOnly}
            />
            <span className="lbl" dangerouslySetInnerHTML={{ __html: o.label }} />
            {OTHER(o) && sel && (
              <input
                className="rs-input rs-other-input"
                placeholder="Please specify"
                value={p.otherValue ?? ""}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => p.onOtherChange?.(e.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
    </div>
  );
}

function MultiSelect(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const { filtered, searchBox } = useOptionFilter(options);
  const vals: (string | number)[] = Array.isArray(p.value) ? (p.value as any) : [];
  const toggle = (o: Option) =>
    p.onChange(toggleMultiValue(vals, o.code, options, p.q.settings.maxSelections));
  return (
    <div>
    {searchBox}
    <div className={optionsClass(p)}>
      {filtered.map((o) => {
        const sel = vals.some((v) => String(v) === String(o.code));
        const atMax =
          !sel &&
          p.q.settings.maxSelections != null &&
          vals.length >= p.q.settings.maxSelections;
        return (
          <label key={String(o.code)}
            className={`rs-option ${sel ? "selected" : ""}`}
            style={atMax ? { opacity: 0.5 } : undefined}>
            <input type="checkbox" checked={sel} onChange={() => toggle(o)}
              disabled={p.q.settings.readOnly} />
            <span className="lbl" dangerouslySetInnerHTML={{ __html: o.label }} />
            {OTHER(o) && sel && (
              <input
                className="rs-input rs-other-input"
                placeholder="Please specify"
                value={p.otherValue ?? ""}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => p.onOtherChange?.(e.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
    </div>
  );
}

function Dropdown(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  return (
    <select
      className="rs-select"
      value={p.value == null ? "" : String(p.value)}
      onChange={(e) => p.onChange(e.target.value === "" ? null : e.target.value)}
      disabled={p.q.settings.readOnly}
    >
      <option value="">— Select —</option>
      {options.map((o) => (
        <option key={String(o.code)} value={String(o.code)}>{o.label.replace(/<[^>]*>/g, "")}</option>
      ))}
    </select>
  );
}

/**
 * Real multi-select dropdown (req §1): chips for current selections, a
 * searchable checkbox list, select all / clear all, min/max enforcement and
 * shared exclusive-option semantics.
 */
function MultiDropdown(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const vals: (string | number)[] = Array.isArray(p.value) ? (p.value as any) : [];
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const max = p.q.settings.maxSelections;
  const min = p.q.settings.minSelections;

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const plain = (s: string) => s.replace(/<[^>]*>/g, "");
  const filtered = search.trim()
    ? options.filter((o) => plain(o.label).toLowerCase().includes(search.toLowerCase()))
    : options;
  const selectedOpts = vals
    .map((v) => options.find((o) => String(o.code) === String(v)))
    .filter((o): o is Option => !!o);

  const toggle = (o: Option) => {
    if (o.meta?.disabled) return;
    p.onChange(toggleMultiValue(vals, o.code, options, max));
  };
  const selectAll = () =>
    p.onChange(
      normalizeMultiValue(filtered.filter((o) => !o.meta?.disabled).map((o) => o.code), options, max),
    );
  const clearAll = () => p.onChange([]);

  return (
    <div className="rs-msd" ref={rootRef}>
      <div
        className="rs-msd-control"
        role="combobox"
        aria-expanded={open}
        tabIndex={0}
        onClick={() => !p.q.settings.readOnly && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); }
          if (e.key === "Escape") setOpen(false);
        }}
      >
        {selectedOpts.length === 0 && (
          <span style={{ color: "var(--rs-subtle)" }}>
            {p.q.settings.placeholder ?? "— Select all that apply —"}
          </span>
        )}
        {selectedOpts.map((o) => (
          <span key={String(o.code)} className="rs-msd-chip">
            {plain(o.label)}
            <button
              type="button"
              aria-label={`Remove ${plain(o.label)}`}
              onClick={(e) => { e.stopPropagation(); toggle(o); }}
            >
              ×
            </button>
          </span>
        ))}
        <span className="rs-msd-caret">{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div className="rs-msd-pop">
          {options.length > 7 && (
            <input
              className="rs-input"
              style={{ maxWidth: "100%" }}
              autoFocus
              placeholder={`Search ${options.length} options…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
          <div className="rs-msd-actions">
            <button type="button" onClick={selectAll}>Select all</button>
            <button type="button" onClick={clearAll}>Clear all</button>
            <span style={{ marginLeft: "auto", color: "var(--rs-subtle)" }}>
              {vals.length} selected
              {min != null ? ` · min ${min}` : ""}{max != null ? ` · max ${max}` : ""}
            </span>
          </div>
          <div className="rs-msd-list" role="listbox" aria-multiselectable>
            {filtered.length === 0 && (
              <div style={{ padding: 8, color: "var(--rs-subtle)" }}>No matches</div>
            )}
            {filtered.map((o) => {
              const sel = vals.some((v) => String(v) === String(o.code));
              const disabled =
                !!o.meta?.disabled || (!sel && max != null && vals.length >= max && !EXCLUSIVE(o));
              return (
                <div
                  key={String(o.code)}
                  className={`rs-msd-item ${disabled ? "disabled" : ""}`}
                  role="option"
                  aria-selected={sel}
                  onClick={() => !disabled && toggle(o)}
                >
                  <input type="checkbox" readOnly checked={sel} disabled={disabled} />
                  <span dangerouslySetInnerHTML={{ __html: o.label }} />
                  {EXCLUSIVE(o) && (
                    <span style={{ marginLeft: "auto", fontSize: "0.75em", color: "var(--rs-subtle)" }}>
                      exclusive
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------- numeric / text */
function NumericInput(p: QRProps) {
  return (
    <input
      className="rs-input sm"
      type="number"
      inputMode="decimal"
      min={p.q.settings.minValue}
      max={p.q.settings.maxValue}
      step={p.q.settings.step ?? "any"}
      value={p.value == null ? "" : String(p.value)}
      placeholder={p.q.settings.placeholder}
      readOnly={p.q.settings.readOnly}
      onChange={(e) => p.onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
}

function TextInput(p: QRProps) {
  return (
    <input
      className="rs-input"
      type="text"
      value={p.value == null ? "" : String(p.value)}
      placeholder={p.q.settings.placeholder}
      readOnly={p.q.settings.readOnly}
      onChange={(e) => p.onChange(e.target.value)}
    />
  );
}

function LongText(p: QRProps) {
  return (
    <textarea
      className="rs-textarea"
      value={p.value == null ? "" : String(p.value)}
      placeholder={p.q.settings.placeholder}
      readOnly={p.q.settings.readOnly}
      onChange={(e) => p.onChange(e.target.value)}
    />
  );
}

function DateInput(p: QRProps) {
  return (
    <input className="rs-input sm" type="date" value={p.value == null ? "" : String(p.value)}
      readOnly={p.q.settings.readOnly} onChange={(e) => p.onChange(e.target.value || null)} style={{ maxWidth: 190 }} />
  );
}
function TimeInput(p: QRProps) {
  return (
    <input className="rs-input sm" type="time" value={p.value == null ? "" : String(p.value)}
      readOnly={p.q.settings.readOnly} onChange={(e) => p.onChange(e.target.value || null)} style={{ maxWidth: 150 }} />
  );
}

/**
 * Form-style list questions (reqs §3–5): labeled rows, each with its own
 * field type (email, phone, currency, date…) and validation. Answers store
 * keyed by row code; surveys without rows keep the legacy numbered inputs.
 */
function ListInput(p: QRProps & { numeric: boolean }) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const cols = p.q.settings.columnsLayout ?? 1;

  if (view.rows.length > 0) {
    const vals = (p.value ?? {}) as Record<string, unknown>;
    const setField = (rc: string, v: unknown) => p.onChange({ ...vals, [rc]: v });
    return (
      <div
        className={cols > 1 ? `rs-options cols-${Math.min(cols, 4)}` : "rs-options"}
        style={{ maxWidth: cols > 1 ? undefined : 520 }}
      >
        {view.rows.map((row) => {
          const rc = String(row.code);
          const ft = row.fieldType ?? (p.numeric ? "number" : "text");
          const ip = fieldInputProps(ft);
          const v = vals[rc];
          const err = p.errors.find((e) => e.startsWith(row.label.replace(/<[^>]*>/g, "")));
          return (
            <div key={rc}>
              <div className="rs-field-row">
                <span className="flab">
                  <span dangerouslySetInnerHTML={{ __html: row.label }} />
                  {row.required && <span className="rs-req"> *</span>}
                </span>
                {ip.prefix && <span className="rs-prefix">{ip.prefix}</span>}
                {ip.multiline ? (
                  <textarea
                    className="rs-textarea"
                    style={{ minHeight: 60 }}
                    placeholder={row.placeholder}
                    value={v == null ? "" : String(v)}
                    readOnly={p.q.settings.readOnly}
                    onChange={(e) => setField(rc, e.target.value || null)}
                  />
                ) : (
                  <input
                    className="rs-input"
                    type={ip.inputType}
                    inputMode={ip.inputMode as any}
                    placeholder={row.placeholder}
                    value={v == null ? "" : String(v)}
                    readOnly={p.q.settings.readOnly}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const isNum = ["number", "decimal", "integer", "currency"].includes(ft);
                      setField(rc, raw === "" ? null : isNum && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw);
                    }}
                  />
                )}
              </div>
              {err && <div className="rs-error-msg">{err}</div>}
            </div>
          );
        })}
      </div>
    );
  }

  // legacy numbered list (no labeled rows configured)
  const n = p.q.settings.listCount ?? 3;
  const arr: unknown[] = Array.isArray(p.value) ? [...(p.value as unknown[])] : [];
  return (
    <div className="rs-options" style={{ maxWidth: 460 }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ minWidth: 110, fontSize: "0.92em" }}>{`${i + 1}.`}</span>
          <input
            className="rs-input"
            type={p.numeric ? "number" : "text"}
            value={arr[i] == null ? "" : String(arr[i])}
            onChange={(e) => {
              const next = [...arr];
              while (next.length <= i) next.push(null);
              next[i] = e.target.value === "" ? null : p.numeric ? Number(e.target.value) : e.target.value;
              p.onChange(next);
            }}
          />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- NPS / slider */
function Nps(p: QRProps) {
  const min = p.q.settings.minValue ?? 0;
  const max = p.q.settings.maxValue ?? 10;
  return (
    <div>
      <div className="rs-nps">
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
          <button
            key={n}
            type="button"
            className={String(p.value) === String(n) ? "selected" : ""}
            onClick={() => p.onChange(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="rs-nps-labels">
        <span>{p.q.settings.npsLeftLabel ?? "Not at all likely"}</span>
        <span>{p.q.settings.npsRightLabel ?? "Extremely likely"}</span>
      </div>
    </div>
  );
}

function Slider(p: QRProps) {
  const min = p.q.settings.minValue ?? 0;
  const max = p.q.settings.maxValue ?? 100;
  const val = p.value == null ? Math.round((min + max) / 2) : Number(p.value);
  return (
    <div>
      <div className="rs-slider-row">
        <span style={{ fontSize: "0.85em", color: "var(--rs-subtle)" }}>{p.q.settings.sliderLeftLabel ?? min}</span>
        <input
          type="range" min={min} max={max} step={p.q.settings.step ?? 1} value={val}
          onChange={(e) => p.onChange(Number(e.target.value))}
        />
        <span style={{ fontSize: "0.85em", color: "var(--rs-subtle)" }}>{p.q.settings.sliderRightLabel ?? max}</span>
        <span className="rs-slider-val">{p.value == null ? "—" : String(p.value)}</span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- ranking */
function Ranking(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const ranked: (string | number)[] = Array.isArray(p.value) ? (p.value as any) : [];
  const unranked = options.filter((o) => !ranked.some((r) => String(r) === String(o.code)));
  const move = (code: string | number, dir: -1 | 1) => {
    const idx = ranked.findIndex((r) => String(r) === String(code));
    const next = [...ranked];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    p.onChange(next);
  };
  return (
    <div className="rs-rank-list">
      {ranked.map((code, i) => {
        const o = options.find((x) => String(x.code) === String(code));
        if (!o) return null;
        return (
          <div key={String(code)} className="rs-rank-item">
            <span className="rs-rank-num">{i + 1}</span>
            <span dangerouslySetInnerHTML={{ __html: o.label }} />
            <span className="rs-rank-btns">
              <button type="button" onClick={() => move(code, -1)} aria-label="Move up">↑</button>
              <button type="button" onClick={() => move(code, 1)} aria-label="Move down">↓</button>
              <button type="button" onClick={() => p.onChange(ranked.filter((r) => String(r) !== String(code)))} aria-label="Remove">×</button>
            </span>
          </div>
        );
      })}
      {unranked.map((o) => (
        <div
          key={String(o.code)}
          className="rs-rank-item"
          style={{ cursor: "pointer", opacity: 0.85 }}
          onClick={() => p.onChange([...ranked, o.code])}
        >
          <span className="rs-rank-num empty">–</span>
          <span dangerouslySetInnerHTML={{ __html: o.label }} />
          <span style={{ marginLeft: "auto", fontSize: "0.8em", color: "var(--rs-subtle)" }}>tap to rank</span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- allocation */
function Allocation(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const vals = (p.value ?? {}) as Record<string, number | null>;
  const total = Object.values(vals).reduce((a: number, b) => a + (Number(b) || 0), 0);
  const target = p.q.settings.sumTarget;
  return (
    <div style={{ maxWidth: 460 }}>
      {options.map((o) => (
        <div key={String(o.code)} className="rs-alloc-row">
          <span className="lbl" dangerouslySetInnerHTML={{ __html: o.label }} />
          <input
            className="rs-input sm"
            type="number"
            min={0}
            value={vals[String(o.code)] == null ? "" : String(vals[String(o.code)])}
            onChange={(e) =>
              p.onChange({ ...vals, [String(o.code)]: e.target.value === "" ? null : Number(e.target.value) })
            }
          />
          {p.q.settings.sumUnit && <span style={{ color: "var(--rs-subtle)" }}>{p.q.settings.sumUnit}</span>}
        </div>
      ))}
      <div className={`rs-alloc-total ${target != null ? (total === target ? "ok" : "bad") : ""}`}>
        Total: {total}{target != null ? ` / ${target}` : ""}{p.q.settings.sumUnit ?? ""}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ image select */
function ImageSelect(p: QRProps & { multi?: boolean; ranking?: boolean }) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const vals: (string | number)[] = Array.isArray(p.value) ? (p.value as any) : p.value == null ? [] : [p.value as any];
  const click = (o: Option) => {
    if (p.ranking) {
      const on = vals.some((v) => String(v) === String(o.code));
      p.onChange(on ? vals.filter((v) => String(v) !== String(o.code)) : [...vals, o.code]);
    } else if (p.multi) {
      const on = vals.some((v) => String(v) === String(o.code));
      p.onChange(on ? vals.filter((v) => String(v) !== String(o.code)) : [...vals, o.code]);
    } else {
      p.onChange(o.code);
    }
  };
  return (
    <div className="rs-imggrid">
      {options.map((o) => {
        const idx = vals.findIndex((v) => String(v) === String(o.code));
        const sel = idx >= 0;
        return (
          <div key={String(o.code)} className={`rs-imgopt ${sel ? "selected" : ""}`} onClick={() => click(o)}>
            {o.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={o.imageUrl} alt={o.label.replace(/<[^>]*>/g, "")} />
            ) : (
              <div style={{ height: 110, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--rs-border)" }}>🖼</div>
            )}
            <div className="cap">
              {p.ranking && sel && <strong style={{ color: "var(--rs-primary)" }}>#{idx + 1} </strong>}
              <span dangerouslySetInnerHTML={{ __html: o.label }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- matrix */
function Matrix(p: QRProps) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const colOpts = view.columns[0]?.options?.length ? view.columns[0].options : view.options;
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const setRow = (row: string, v: unknown) => p.onChange({ ...vals, [row]: v });
  const type = p.q.type;

  return (
    <div className="rs-table-wrap">
      <table className="rs-matrix">
        <thead>
          <tr>
            <th className="rowlabel"></th>
            {type === "matrix_numeric" || type === "matrix_text" || type === "matrix_dropdown"
              ? <th>{view.columns[0]?.label ?? "Answer"}</th>
              : colOpts.map((o) => <th key={String(o.code)} dangerouslySetInnerHTML={{ __html: o.label }} />)}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => {
            const rc = String(row.code);
            const rowVal = vals[rc];
            return (
              <tr key={rc}>
                <td className="rowlabel" dangerouslySetInnerHTML={{ __html: row.label }} />
                {type === "matrix_single" &&
                  colOpts.map((o) => (
                    <td key={String(o.code)}>
                      <input type="radio" name={`${p.q.id}_${rc}`}
                        checked={String(rowVal) === String(o.code)}
                        onChange={() => setRow(rc, o.code)} />
                    </td>
                  ))}
                {type === "matrix_multi" &&
                  colOpts.map((o) => {
                    const arr = (Array.isArray(rowVal) ? rowVal : []) as (string | number)[];
                    const on = arr.some((v) => String(v) === String(o.code));
                    return (
                      <td key={String(o.code)}>
                        <input type="checkbox" checked={on}
                          onChange={() => setRow(rc, toggleMultiValue(arr, o.code, colOpts))} />
                      </td>
                    );
                  })}
                {type === "matrix_numeric" && (
                  <td>
                    <input className="rs-input" type="number"
                      value={rowVal == null ? "" : String(rowVal)}
                      onChange={(e) => setRow(rc, e.target.value === "" ? null : Number(e.target.value))} />
                  </td>
                )}
                {type === "matrix_text" && (
                  <td>
                    <input className="rs-input" type="text"
                      value={rowVal == null ? "" : String(rowVal)}
                      onChange={(e) => setRow(rc, e.target.value)} />
                  </td>
                )}
                {type === "matrix_dropdown" && (
                  <td>
                    <select className="rs-select" value={rowVal == null ? "" : String(rowVal)}
                      onChange={(e) => setRow(rc, e.target.value || null)}>
                      <option value="">—</option>
                      {colOpts.map((o) => (
                        <option key={String(o.code)} value={String(o.code)}>{o.label.replace(/<[^>]*>/g, "")}</option>
                      ))}
                    </select>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------- composite (multi-column, §3) */
function CompositeCell({
  col, value, onChange, p,
}: { col: QuestionColumn; value: unknown; onChange(v: unknown): void; p: QRProps }) {
  if (col.expression) {
    // calculated read-only cell
    const flat = flattenVariables(p.def, p.state);
    let display = "";
    try {
      const v = evaluateExpression(col.expression, { resolver: (n) => flat[n], names: () => Object.keys(flat) });
      display = v == null ? "" : String(v);
    } catch { display = ""; }
    return <span style={{ fontWeight: 600 }}>{display}</span>;
  }
  const ro = col.readOnly;
  switch (col.responseType) {
    case "single":
      return (
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          {col.options.map((o) => (
            <label key={String(o.code)} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="radio" checked={String(value) === String(o.code)} disabled={ro}
                onChange={() => onChange(o.code)} />
              <span style={{ fontSize: "0.88em" }}>{o.label.replace(/<[^>]*>/g, "")}</span>
            </label>
          ))}
        </div>
      );
    case "multi":
      return (
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          {col.options.map((o) => {
            const arr = (Array.isArray(value) ? value : []) as (string | number)[];
            const on = arr.some((v) => String(v) === String(o.code));
            return (
              <label key={String(o.code)} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                <input type="checkbox" checked={on} disabled={ro}
                  onChange={() => onChange(toggleMultiValue(arr, o.code, col.options))} />
                <span style={{ fontSize: "0.88em" }}>{o.label.replace(/<[^>]*>/g, "")}</span>
              </label>
            );
          })}
        </div>
      );
    case "dropdown":
      return (
        <select className="rs-select" disabled={ro} value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {col.options.map((o) => (
            <option key={String(o.code)} value={String(o.code)}>{o.label.replace(/<[^>]*>/g, "")}</option>
          ))}
        </select>
      );
    case "multi_dropdown":
      return (
        <select className="rs-select" multiple disabled={ro} size={Math.min(col.options.length, 4)}
          value={Array.isArray(value) ? (value as unknown[]).map(String) : []}
          onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}>
          {col.options.map((o) => (
            <option key={String(o.code)} value={String(o.code)}>{o.label.replace(/<[^>]*>/g, "")}</option>
          ))}
        </select>
      );
    case "numeric":
    case "slider":
      return (
        <input className="rs-input" type="number" readOnly={ro} min={col.min} max={col.max}
          placeholder={col.placeholder}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
      );
    case "date":
      return <input className="rs-input" type="date" readOnly={ro} value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value || null)} />;
    case "time":
      return <input className="rs-input" type="time" readOnly={ro} value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value || null)} />;
    case "checkbox":
      return <input type="checkbox" checked={!!value} disabled={ro} onChange={(e) => onChange(e.target.checked)} />;
    case "longtext":
      return <textarea className="rs-textarea" style={{ minHeight: 50 }} readOnly={ro}
        value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />;
    case "text":
    default:
      return <input className="rs-input" type="text" readOnly={ro} placeholder={col.placeholder}
        value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />;
  }
}

function Composite(p: QRProps) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const vals = (p.value ?? {}) as Record<string, Record<string, unknown>>;
  const setCell = (row: string, col: string, v: unknown) =>
    p.onChange({ ...vals, [row]: { ...(vals[row] ?? {}), [col]: v } });
  return (
    <div className="rs-table-wrap">
      <table className="rs-matrix">
        <thead>
          <tr>
            <th className="rowlabel"></th>
            {view.columns.map((c) => (
              <th key={c.id} style={c.width ? { width: c.width } : undefined}
                dangerouslySetInnerHTML={{ __html: c.label }} />
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={String(row.code)}>
              <td className="rowlabel" dangerouslySetInnerHTML={{ __html: row.label }} />
              {view.columns.map((c) => (
                <td key={c.id}>
                  <CompositeCell col={c} p={p}
                    value={vals[String(row.code)]?.[c.id]}
                    onChange={(v) => setCell(String(row.code), c.id, v)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------- design-driven task questions */
function DesignTasks(p: QRProps) {
  const design = p.def.designs.find((d) => d.id === p.q.settings.designRef);
  if (!design?.file?.rows?.length) {
    return <div className="rs-error-msg">Design file “{p.q.settings.designRef}” not generated yet.</div>;
  }
  const rows = design.file.rows as Record<string, unknown>[];
  const tasks = [...new Set(rows.map((r) => String(r.task)))];
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const isMaxdiff = p.q.type === "maxdiff_task";
  const attrCols = design.file.columns.filter(
    (c) => !["version", "task", "alt", "is_holdout", "none_option", "position", "item_index", "item_label"].includes(c),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {tasks.map((t) => {
        const alts = rows.filter((r) => String(r.task) === t && String(r.version ?? "1") === "1");
        return (
          <div key={t} className="rs-card" style={{ margin: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 10 }}>Task {t}</div>
            <div className="rs-table-wrap">
              <table className="rs-matrix">
                <thead>
                  <tr>
                    {isMaxdiff ? (
                      <>
                        <th>Least</th><th className="rowlabel">Item</th><th>Most</th>
                      </>
                    ) : (
                      <>
                        <th className="rowlabel">Option</th>
                        {attrCols.map((a) => <th key={a}>{a}</th>)}
                        <th>Choose</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {alts.map((alt, i) => {
                    const altKey = isMaxdiff ? String(alt.item_index ?? i) : String(alt.alt ?? i + 1);
                    if (isMaxdiff) {
                      const cur = (vals[t] ?? {}) as { best?: string; worst?: string };
                      return (
                        <tr key={altKey}>
                          <td>
                            <input type="radio" name={`${p.q.id}_${t}_worst`}
                              checked={cur.worst === altKey}
                              onChange={() => p.onChange({ ...vals, [t]: { ...cur, worst: altKey } })} />
                          </td>
                          <td className="rowlabel">{String(alt.item_label ?? altKey)}</td>
                          <td>
                            <input type="radio" name={`${p.q.id}_${t}_best`}
                              checked={cur.best === altKey}
                              onChange={() => p.onChange({ ...vals, [t]: { ...cur, best: altKey } })} />
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={altKey}>
                        <td className="rowlabel">{Number(alt.none_option) === 1 ? "None of these" : `Option ${altKey}`}</td>
                        {attrCols.map((a) => <td key={a}>{Number(alt.none_option) === 1 ? "—" : String(alt[a] ?? "")}</td>)}
                        <td>
                          <input type="radio" name={`${p.q.id}_${t}`}
                            checked={String(vals[t]) === altKey}
                            onChange={() => p.onChange({ ...vals, [t]: altKey })} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------- variant renderers (families) */

/** Button Select / Button Multi-Select — large tap targets, exclusive-aware. */
function ChoiceButtons(p: QRProps & { multi: boolean }) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const { filtered, searchBox } = useOptionFilter(options);
  const vals: (string | number)[] = p.multi
    ? Array.isArray(p.value) ? (p.value as any) : []
    : p.value == null ? [] : [p.value as any];
  const pick = (o: Option) => {
    if (p.q.settings.readOnly) return;
    if (p.multi) p.onChange(toggleMultiValue(vals, o.code, options, p.q.settings.maxSelections));
    else p.onChange(String(p.value) === String(o.code) ? null : o.code);
  };
  return (
    <div>
      {searchBox}
      <div className={`rs-choicebtns ${p.q.settings.columnsLayout ? `cols-${Math.min(p.q.settings.columnsLayout, 4)}` : ""}`}>
        {filtered.map((o) => {
          const sel = vals.some((v) => String(v) === String(o.code));
          return (
            <button key={String(o.code)} type="button"
              className={`rs-choicebtn ${sel ? "selected" : ""}`}
              aria-pressed={sel}
              onClick={() => pick(o)}>
              <span dangerouslySetInnerHTML={{ __html: o.label }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Card / Tile Select — title, optional description (option.meta.description)
 *  and optional image, single or multi. */
function ChoiceCards(p: QRProps & { multi: boolean }) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const vals: (string | number)[] = p.multi
    ? Array.isArray(p.value) ? (p.value as any) : []
    : p.value == null ? [] : [p.value as any];
  const pick = (o: Option) => {
    if (p.q.settings.readOnly) return;
    if (p.multi) p.onChange(toggleMultiValue(vals, o.code, options, p.q.settings.maxSelections));
    else p.onChange(String(p.value) === String(o.code) ? null : o.code);
  };
  const cols = p.q.settings.columnsLayout ?? 2;
  return (
    <div className={`rs-cardgrid cols-${Math.min(Math.max(cols, 1), 4)}`}>
      {options.map((o) => {
        const sel = vals.some((v) => String(v) === String(o.code));
        const desc = (o.meta?.description as string) ?? "";
        return (
          <div key={String(o.code)}
            className={`rs-cardopt ${sel ? "selected" : ""}`}
            role={p.multi ? "checkbox" : "radio"}
            aria-checked={sel}
            tabIndex={0}
            onClick={() => pick(o)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(o); } }}>
            {o.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={o.imageUrl} alt="" />
            )}
            <div className="rs-cardopt-title" dangerouslySetInnerHTML={{ __html: o.label }} />
            {desc && <div className="rs-cardopt-desc" dangerouslySetInnerHTML={{ __html: desc }} />}
            <span className="rs-cardopt-check">{sel ? "✓" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Star Rating — numeric 1..max. */
function StarRating(p: QRProps) {
  const max = Math.min(p.q.settings.maxValue ?? 5, 10);
  const min = p.q.settings.minValue ?? 1;
  const val = p.value == null ? 0 : Number(p.value);
  const [hover, setHover] = React.useState(0);
  const shown = hover || val;
  return (
    <div className="rs-stars" role="radiogroup" aria-label="Star rating">
      {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
        <button key={n} type="button"
          className={n <= shown ? "on" : ""}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={() => p.onChange(val === n ? null : n)}>
          ★
        </button>
      ))}
      <span className="rs-stars-val">{val ? `${val} / ${max}` : ""}</span>
    </div>
  );
}

const EMOJI_SCALE = ["😠", "😕", "😐", "🙂", "😍"];

/** Emoji / Smiley Rating — stores 1..5. */
function EmojiRating(p: QRProps) {
  const val = p.value == null ? 0 : Number(p.value);
  return (
    <div className="rs-emoji" role="radiogroup" aria-label="Rating">
      {EMOJI_SCALE.map((e, i) => (
        <button key={i} type="button"
          className={val === i + 1 ? "on" : ""}
          aria-label={`${i + 1} of 5`}
          onClick={() => p.onChange(val === i + 1 ? null : i + 1)}>
          {e}
        </button>
      ))}
    </div>
  );
}

/** Searchable single-select dropdown (autocomplete / combobox). */
function SearchableSingle(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const plain = (s: string) => s.replace(/<[^>]*>/g, "");

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = options.find((o) => String(o.code) === String(p.value));
  const filtered = search.trim()
    ? options.filter((o) => plain(o.label).toLowerCase().includes(search.toLowerCase()))
    : options;

  return (
    <div className="rs-msd" ref={rootRef}>
      <div className="rs-msd-control" role="combobox" aria-expanded={open} tabIndex={0}
        onClick={() => !p.q.settings.readOnly && setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } if (e.key === "Escape") setOpen(false); }}>
        {selected ? (
          <span>{plain(selected.label)}</span>
        ) : (
          <span style={{ color: "var(--rs-subtle)" }}>{p.q.settings.placeholder ?? "— Select —"}</span>
        )}
        <span className="rs-msd-caret">{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="rs-msd-pop">
          <input className="rs-input" style={{ maxWidth: "100%" }} autoFocus
            placeholder={`Search ${options.length} options…`}
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="rs-msd-list" role="listbox">
            {filtered.length === 0 && <div style={{ padding: 8, color: "var(--rs-subtle)" }}>No matches</div>}
            {filtered.map((o) => (
              <div key={String(o.code)}
                className="rs-msd-item"
                role="option"
                aria-selected={String(o.code) === String(p.value)}
                onClick={() => { p.onChange(o.code); setOpen(false); setSearch(""); }}>
                <span dangerouslySetInnerHTML={{ __html: o.label }} />
                {String(o.code) === String(p.value) && <span style={{ marginLeft: "auto" }}>✓</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Tinder-style swipe (per-row model): each row is a card, judged with the
 * first option (swipe left) or last option (swipe right). Pointer-drag on
 * the card or the buttons below — data is identical to a single-select
 * matrix, so reporting and logic see ordinary VAR_<row> values.
 */
function SwipeDeck(p: QRProps) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const remaining = view.rows.filter((r) => vals[String(r.code)] === undefined);
  const current = remaining[0];
  const done = view.rows.length - remaining.length;
  const [drag, setDrag] = React.useState<{ x: number; active: boolean }>({ x: 0, active: false });
  const startX = React.useRef(0);

  const leftOpt = view.options[0];
  const rightOpt = view.options[view.options.length - 1];

  const judge = (rowCode: string, optCode: string | number) => {
    p.onChange({ ...vals, [rowCode]: optCode });
    setDrag({ x: 0, active: false });
  };
  const undo = () => {
    const judged = view.rows.filter((r) => vals[String(r.code)] !== undefined);
    const last = judged[judged.length - 1];
    if (!last) return;
    const next = { ...vals };
    delete next[String(last.code)];
    p.onChange(next);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    startX.current = e.clientX;
    setDrag({ x: 0, active: true });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.active) return;
    setDrag({ x: e.clientX - startX.current, active: true });
  };
  const onPointerUp = () => {
    if (!drag.active || !current) return;
    if (drag.x > 80 && rightOpt) judge(String(current.code), rightOpt.code);
    else if (drag.x < -80 && leftOpt) judge(String(current.code), leftOpt.code);
    else setDrag({ x: 0, active: false });
  };

  if (!current) {
    return (
      <div className="rs-swipe-done">
        <p>All {view.rows.length} cards judged ✓</p>
        <div className="rs-swipe-summary">
          {view.rows.map((r) => {
            const o = view.options.find((x) => String(x.code) === String(vals[String(r.code)]));
            return (
              <span key={String(r.code)} className="rs-swipe-chip"
                title="tap to judge again"
                onClick={() => {
                  const next = { ...vals };
                  delete next[String(r.code)];
                  p.onChange(next);
                }}>
                {r.label.replace(/<[^>]*>/g, "")}: {o?.label.replace(/<[^>]*>/g, "") ?? "?"}
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  const img = (current.meta?.image as string) ?? undefined;
  const tilt = Math.max(-14, Math.min(14, drag.x / 10));
  const verdict = drag.x > 40 ? rightOpt : drag.x < -40 ? leftOpt : null;

  return (
    <div className="rs-swipe">
      <div className="rs-swipe-progress">{done + 1} / {view.rows.length}</div>
      <div className="rs-swipe-stack">
        {remaining[1] && <div className="rs-swipe-card behind" />}
        <div
          className="rs-swipe-card"
          style={{
            transform: `translateX(${drag.x}px) rotate(${tilt}deg)`,
            transition: drag.active ? "none" : "transform .18s ease",
            touchAction: "pan-y",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {img && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img} alt="" draggable={false} />
          )}
          <div className="rs-swipe-label" dangerouslySetInnerHTML={{ __html: current.label }} />
          {verdict && (
            <div className={`rs-swipe-verdict ${drag.x > 0 ? "right" : "left"}`}>
              {verdict.label.replace(/<[^>]*>/g, "")}
            </div>
          )}
        </div>
      </div>
      <div className="rs-swipe-actions">
        {leftOpt && (
          <button type="button" className="rs-swipe-btn left"
            onClick={() => judge(String(current.code), leftOpt.code)}>
            <span dangerouslySetInnerHTML={{ __html: leftOpt.label }} />
          </button>
        )}
        {done > 0 && (
          <button type="button" className="rs-swipe-btn undo" onClick={undo} title="Undo last">↩</button>
        )}
        {rightOpt && rightOpt !== leftOpt && (
          <button type="button" className="rs-swipe-btn right"
            onClick={() => judge(String(current.code), rightOpt.code)}>
            <span dangerouslySetInnerHTML={{ __html: rightOpt.label }} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Drag-and-drop ranking (rank_order model) with arrow-button fallback. */
function DragRank(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const stored: (string | number)[] = Array.isArray(p.value) ? (p.value as any) : [];
  // order = stored ranking, with any unranked options appended in display order
  const order = [
    ...stored.filter((c) => options.some((o) => String(o.code) === String(c))),
    ...options.map((o) => o.code).filter((c) => !stored.some((s2) => String(s2) === String(c))),
  ];
  const [dragIdx, setDragIdx] = React.useState<number | null>(null);
  const [overIdx, setOverIdx] = React.useState<number | null>(null);

  const commit = (next: (string | number)[]) => p.onChange(next);
  const moveTo = (from: number, to: number) => {
    if (from === to) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    commit(next);
  };

  return (
    <div className="rs-rank-list">
      <p className="rs-qinstruction" style={{ margin: "0 0 4px" }}>
        Drag to reorder — 1 = highest.
      </p>
      {order.map((code, i) => {
        const o = options.find((x) => String(x.code) === String(code));
        if (!o) return null;
        return (
          <div key={String(code)}
            className={`rs-rank-item rs-dragrow ${overIdx === i ? "dragover" : ""} ${dragIdx === i ? "dragging" : ""}`}
            draggable
            onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { e.preventDefault(); setOverIdx(i); }}
            onDragLeave={() => setOverIdx((v) => (v === i ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx != null) moveTo(dragIdx, i);
              setDragIdx(null); setOverIdx(null);
            }}
            onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}>
            <span className="rs-drag-grip" aria-hidden>⠿</span>
            <span className="rs-rank-num">{i + 1}</span>
            <span dangerouslySetInnerHTML={{ __html: o.label }} />
            <span className="rs-rank-btns">
              <button type="button" onClick={() => moveTo(i, Math.max(0, i - 1))} aria-label="Move up">↑</button>
              <button type="button" onClick={() => moveTo(i, Math.min(order.length - 1, i + 1))} aria-label="Move down">↓</button>
            </span>
          </div>
        );
      })}
      {stored.length === 0 && (
        <button type="button" className="btn-like rs-btn secondary" style={{ alignSelf: "flex-start", padding: "8px 16px" }}
          onClick={() => commit(order)}>
          Accept this order
        </button>
      )}
    </div>
  );
}

/** Semantic differential: row label "Left | Right" anchors a numbered scale. */
function SemanticDifferential(p: QRProps) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const setRow = (rc: string, v: unknown) => p.onChange({ ...vals, [rc]: v });
  return (
    <div className="rs-table-wrap">
      <table className="rs-matrix rs-semantic">
        <tbody>
          {view.rows.map((row) => {
            const rc = String(row.code);
            const [left, right] = row.label.split("|").map((x) => x.trim());
            return (
              <tr key={rc}>
                <td className="rowlabel" style={{ textAlign: "right" }}
                  dangerouslySetInnerHTML={{ __html: left ?? row.label }} />
                {view.options.map((o) => (
                  <td key={String(o.code)}>
                    <label style={{ display: "block", cursor: "pointer", padding: 2 }} title={o.label.replace(/<[^>]*>/g, "")}>
                      <input type="radio" name={`${p.q.id}_${rc}`}
                        checked={String(vals[rc]) === String(o.code)}
                        onChange={() => setRow(rc, o.code)} />
                    </label>
                  </td>
                ))}
                <td className="rowlabel"
                  dangerouslySetInnerHTML={{ __html: right ?? "" }} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Single-item carousel: browse option cards one at a time, select one. */
function CarouselSelect(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const [idx, setIdx] = React.useState(0);
  if (options.length === 0) return null;
  const i = Math.min(idx, options.length - 1);
  const o = options[i];
  const selected = String(p.value) === String(o.code);
  const desc = (o.meta?.description as string) ?? "";
  return (
    <div className="rs-carousel">
      <div className="rs-carousel-row">
        <button type="button" className="rs-carousel-nav" disabled={i === 0}
          onClick={() => setIdx(i - 1)} aria-label="Previous">‹</button>
        <div className={`rs-cardopt rs-carousel-card ${selected ? "selected" : ""}`}
          onClick={() => p.onChange(selected ? null : o.code)}>
          {o.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={o.imageUrl} alt="" />
          )}
          <div className="rs-cardopt-title" dangerouslySetInnerHTML={{ __html: o.label }} />
          {desc && <div className="rs-cardopt-desc" dangerouslySetInnerHTML={{ __html: desc }} />}
          <span className="rs-cardopt-check">{selected ? "✓" : ""}</span>
        </div>
        <button type="button" className="rs-carousel-nav" disabled={i === options.length - 1}
          onClick={() => setIdx(i + 1)} aria-label="Next">›</button>
      </div>
      <div className="rs-carousel-foot">
        <span className="rs-carousel-dots">
          {options.map((x, j) => (
            <span key={String(x.code)}
              className={`dot ${j === i ? "on" : ""} ${String(p.value) === String(x.code) ? "picked" : ""}`}
              onClick={() => setIdx(j)} />
          ))}
        </span>
        <button type="button" className={`rs-btn ${selected ? "" : "secondary"}`}
          style={{ padding: "8px 20px" }}
          onClick={() => p.onChange(selected ? null : o.code)}>
          {selected ? "Selected ✓" : "Select this"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- custom component */
function CustomComponent(p: QRProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!ref.current || !p.q.customJs) return;
    try {
      // controlled execution: the component script gets a tiny api
      // eslint-disable-next-line no-new-func
      const fn = new Function("el", "api", p.q.customJs);
      fn(ref.current, {
        getValue: () => p.value,
        setValue: (v: unknown) => p.onChange(v),
      });
    } catch (e) {
      console.error("custom component error", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.q.id]);
  return (
    <div
      ref={ref}
      dangerouslySetInnerHTML={{ __html: resolvePiping(p.q.customHtml ?? "", ctxOf(p)) }}
    />
  );
}

/* ------------------------------------------------------------------ shell */
export function QuestionRenderer(p: QRProps) {
  const ctx = ctxOf(p);
  const text = resolvePiping(p.q.text, ctx);
  const instruction = p.q.instruction ? resolvePiping(p.q.instruction, ctx) : null;

  // Variant renderer dispatch (family/variant architecture). Questions
  // without a variant — every pre-existing survey — fall through to the
  // base-type switch below unchanged.
  const variantDef = p.q.variant ? variantRegistry.get(p.q.variant) : undefined;
  const variantBody = ((): React.ReactNode | null => {
    switch (variantDef?.renderer) {
      case "buttons":
        return <ChoiceButtons {...p} multi={variantDef!.responseModel === "multiple_choice"} />;
      case "cards":
        return <ChoiceCards {...p} multi={variantDef!.responseModel === "multiple_choice"} />;
      case "stars":
        return <StarRating {...p} />;
      case "emoji":
        return <EmojiRating {...p} />;
      case "searchable_single":
        return <SearchableSingle {...p} />;
      case "swipe":
        return <SwipeDeck {...p} />;
      case "dragrank":
        return <DragRank {...p} />;
      case "semantic":
        return <SemanticDifferential {...p} />;
      case "carousel":
        return <CarouselSelect {...p} />;
      default:
        return null;
    }
  })();

  let body: React.ReactNode;
  if (variantBody) {
    body = variantBody;
  } else switch (p.q.type) {
    case "single_select": body = <SingleSelect {...p} />; break;
    case "multi_select": body = <MultiSelect {...p} />; break;
    case "dropdown": body = <Dropdown {...p} />; break;
    case "multi_dropdown": body = <MultiDropdown {...p} />; break;
    case "numeric": body = <NumericInput {...p} />; break;
    case "open_text": body = <TextInput {...p} />; break;
    case "long_text": body = <LongText {...p} />; break;
    case "numeric_list": body = <ListInput {...p} numeric />; break;
    case "text_list": body = <ListInput {...p} numeric={false} />; break;
    case "date": body = <DateInput {...p} />; break;
    case "time": body = <TimeInput {...p} />; break;
    case "ranking": body = <Ranking {...p} />; break;
    case "slider": body = <Slider {...p} />; break;
    case "nps": body = <Nps {...p} />; break;
    case "matrix_single":
    case "matrix_multi":
    case "matrix_numeric":
    case "matrix_text":
    case "matrix_dropdown": body = <Matrix {...p} />; break;
    case "image_select": body = <ImageSelect {...p} multi={(p.q.settings.maxSelections ?? 2) > 1} />; break;
    case "image_ranking": body = <ImageSelect {...p} ranking />; break;
    case "allocation": body = <Allocation {...p} />; break;
    case "composite":
    case "custom_table": body = <Composite {...p} />; break;
    case "conjoint_task":
    case "maxdiff_task": body = <DesignTasks {...p} />; break;
    case "custom_component": body = <CustomComponent {...p} />; break;
    case "html":
      return (
        <div className="rs-card" data-qid={p.q.id}>
          <div dangerouslySetInnerHTML={{ __html: resolvePiping(p.q.customHtml ?? p.q.text, ctx) }} />
        </div>
      );
    default: body = <TextInput {...p} />;
  }

  return (
    <div className="rs-card" data-qid={p.q.id}>
      {p.q.customCss && <style dangerouslySetInnerHTML={{ __html: p.q.customCss }} />}
      <p className="rs-qtext">
        <span dangerouslySetInnerHTML={{ __html: text }} />
        {p.q.required && <span className="rs-required">*</span>}
      </p>
      {instruction && <p className="rs-qinstruction" dangerouslySetInnerHTML={{ __html: instruction }} />}
      {p.q.customHtml && p.q.type !== "custom_component" && (
        <div dangerouslySetInnerHTML={{ __html: resolvePiping(p.q.customHtml, ctx) }} />
      )}
      {body}
      {p.errors.map((e, i) => (
        <div key={i} className="rs-error-msg">{e}</div>
      ))}
    </div>
  );
}
