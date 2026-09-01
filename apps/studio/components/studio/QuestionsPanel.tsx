"use client";
import React from "react";
import type { Question, Option, QuestionColumn, ResponseType, QuestionVariantDef } from "@rescript/schema";
import { questionTypeRegistry, variantRegistry } from "@rescript/schema";
import { VariantPickerModal, VariantSwitcher, createFromVariant } from "./VariantPicker";
import { RichTextEditor } from "./RichTextEditor";
import { OptionLogicEditor } from "./OptionLogicEditor";
import { OptionPreview } from "./OptionPreview";
import { InsertPipingButton } from "./PipingPicker";
import { FIELD_TYPES } from "@rescript/engine"; // also registers builtin question types
import { isEmptyOptionLogic } from "@rescript/schema";
import { useStudio, uid } from "./store";

const RESPONSE_TYPES: ResponseType[] = [
  "single", "multi", "dropdown", "multi_dropdown", "text", "longtext",
  "numeric", "date", "time", "slider", "checkbox",
];

const ALL_FLAGS: { value: string; label: string }[] = [
  { value: "exclusive", label: "exclusive" },
  { value: "other_specify", label: "other/specify" },
  { value: "none_of_above", label: "none of above" },
  { value: "dont_know", label: "don't know" },
  { value: "refused", label: "refused" },
  { value: "anchor_top", label: "anchor top" },
  { value: "anchor_bottom", label: "anchor bottom" },
];

/** Context-aware option flags (req §2/§19): exclusive semantics only exist
 *  on multi-selects; a single-select never shows them. */
export function allowedFlagsFor(qtype: string): string[] {
  if (["single_select", "dropdown"].includes(qtype))
    return ["other_specify", "anchor_top", "anchor_bottom"];
  if (["ranking", "image_ranking", "allocation"].includes(qtype))
    return ["anchor_top", "anchor_bottom"];
  return ALL_FLAGS.map((f) => f.value);
}

const OPTION_WINDOW = 40;

function OptionRows({ options, onChange, showFlags = true, flagChoices, showImage = false,
  enableLogic = false, questionId }: {
  options: Option[]; onChange(opts: Option[]): void; showFlags?: boolean;
  flagChoices?: string[]; showImage?: boolean;
  /** per-option logic + piping controls (reqs §1–4, §21) */
  enableLogic?: boolean; questionId?: string;
}) {
  const [filter, setFilter] = React.useState("");
  const [showAll, setShowAll] = React.useState(false);
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState("");
  const [logicOpen, setLogicOpen] = React.useState<number | null>(null);
  const pendingFocus = React.useRef<number | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  // after Enter/Backspace restructures the list, land focus on the right row
  React.useEffect(() => {
    if (pendingFocus.current == null) return;
    const idx = pendingFocus.current;
    pendingFocus.current = null;
    const el = rootRef.current?.querySelector<HTMLInputElement>(`input[data-oidx="${idx}"]`);
    el?.focus();
    el?.select();
  });

  const set = (i: number, patch: Partial<Option>) =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  const insertAfter = (i: number) => {
    const next = [...options];
    next.splice(i + 1, 0, { code: String(options.length + 1), label: "", flags: [] } as Option);
    pendingFocus.current = i + 1;
    onChange(next);
  };

  /** Enter = new option below (req §5); Backspace on empty = remove + focus
   *  previous (req §6); arrows move between options. */
  const onLabelKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      insertAfter(i);
    } else if (e.key === "Backspace" && options[i].label === "") {
      if (options.length <= 1) return;
      e.preventDefault();
      pendingFocus.current = Math.max(0, i - 1);
      onChange(options.filter((_, j) => j !== i));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      rootRef.current?.querySelector<HTMLInputElement>(`input[data-oidx="${i - 1}"]`)?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      rootRef.current?.querySelector<HTMLInputElement>(`input[data-oidx="${i + 1}"]`)?.focus();
    }
  };

  /** Pasting multi-line text into any option splits it into options (req §7). */
  const onLabelPaste = (e: React.ClipboardEvent<HTMLInputElement>, i: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\n")) return;
    e.preventDefault();
    const parsed = parsePastedOptions(text, options.length + 1);
    if (parsed.length === 0) return;
    const next = [...options];
    next[i] = { ...next[i], label: parsed[0].label, code: options[i].label ? next[i].code : parsed[0].code };
    next.splice(i + 1, 0, ...(parsed.slice(1) as Option[]));
    pendingFocus.current = i + parsed.length - 1;
    onChange(next);
  };

  const importPaste = () => {
    const parsed = parsePastedOptions(pasteText, options.length + 1);
    if (parsed.length === 0) return;
    onChange([...options, ...(parsed as Option[])]);
    setPasteText("");
    setPasteOpen(false);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const flags = ALL_FLAGS.filter((f) => (flagChoices ?? ALL_FLAGS.map((x) => x.value)).includes(f.value));
  const big = options.length > OPTION_WINDOW;
  const f = filter.trim().toLowerCase();
  let visible = options
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => !f || o.label.toLowerCase().includes(f) || String(o.code).toLowerCase().includes(f));
  const total = visible.length;
  if (!showAll && visible.length > OPTION_WINDOW) visible = visible.slice(0, OPTION_WINDOW);

  return (
    <div ref={rootRef}>
      {big && (
        <div className="row" style={{ marginBottom: 6 }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder={`search ${options.length} options…`}
            value={filter} onChange={(e) => { setFilter(e.target.value); setShowAll(false); }} />
          <span className="muted" style={{ fontSize: 11 }}>
            showing {visible.length} of {total}{f ? " matching" : ""}
          </span>
          {total > visible.length && (
            <button className="btn small" onClick={() => setShowAll(true)}>show all</button>
          )}
        </div>
      )}
      {visible.map(({ o, i }) => {
        const hasLogic = !isEmptyOptionLogic(o.logic) || !!o.visibleIf;
        return (
        <React.Fragment key={i}>
        <div className={`opt-row ${logicOpen === i ? "logic-open" : ""}`}>
          <input className="input code-input" value={String(o.code)}
            onChange={(e) => set(i, { code: e.target.value })} title="code" />
          <input className="input grow" value={o.label} data-oidx={i}
            onChange={(e) => set(i, { label: e.target.value })}
            onKeyDown={(e) => onLabelKeyDown(e, i)}
            onPaste={(e) => onLabelPaste(e, i)}
            placeholder="label — Enter adds the next option" />
          {enableLogic && (
            <InsertPipingButton className="btn small" label="{{ }}" currentQuestionId={questionId}
              onInsert={(tok) => set(i, { label: `${options[i].label}${tok}` })} />
          )}
          {showImage && (
            <input className="input" style={{ width: 180 }} placeholder="image URL"
              value={o.imageUrl ?? ""}
              onChange={(e) => set(i, { imageUrl: e.target.value || undefined })} />
          )}
          {showFlags && (
            <select className="select" style={{ width: 110 }} value={o.flags?.[0] ?? ""}
              onChange={(e) => set(i, { flags: e.target.value ? [e.target.value as any] : [] })}>
              <option value="">flags…</option>
              {flags.map((fl) => <option key={fl.value} value={fl.value}>{fl.label}</option>)}
            </select>
          )}
          {enableLogic && (
            <button className={`btn small ${hasLogic ? "has-logic" : ""}`} data-testid={`option-logic-${i}`}
              title="Option-level logic: always show / hide, conditions, eligibility, ordering"
              onClick={() => setLogicOpen(logicOpen === i ? null : i)}>
              {o.logic?.visibility === "always_show" ? "◉ show"
                : o.logic?.visibility === "always_hide" ? "◌ hide"
                : hasLogic ? "⑂ logic" : "⑂"}
            </button>
          )}
          <button className="btn small" onClick={() => move(i, -1)}>↑</button>
          <button className="btn small" onClick={() => move(i, 1)}>↓</button>
          <button className="btn small danger" onClick={() => onChange(options.filter((_, j) => j !== i))}>×</button>
        </div>
        {enableLogic && logicOpen === i && (
          <OptionLogicEditor
            title={`Logic for “${o.label.replace(/<[^>]*>/g, "") || o.code}”`}
            logic={o.logic}
            visibleIf={o.visibleIf}
            onChange={(patch) => set(i, patch as Partial<Option>)} />
        )}
        </React.Fragment>
        );
      })}
      <div className="row">
        <button className="btn small" data-testid="add-option" onClick={() => insertAfter(options.length - 1)}>
          + option <span className="muted" style={{ fontSize: 10 }}>(or press Enter)</span>
        </button>
        <button className="btn small" onClick={() => setPasteOpen((v) => !v)}>
          {pasteOpen ? "hide paste box" : "📋 paste options"}
        </button>
      </div>
      {pasteOpen && (
        <div className="paste-box">
          <textarea className="ta" data-testid="paste-box"
            placeholder={"Paste options here — one per line.\nNumbering (1. / 1)) and bullets (- * •) are cleaned automatically.\nUse code<TAB>label to set codes."}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)} />
          <div className="row">
            <button className="btn small primary" data-testid="import-options" onClick={importPaste}>
              Import {parsePastedOptions(pasteText, 1).length || ""} option{parsePastedOptions(pasteText, 1).length === 1 ? "" : "s"}
            </button>
            <span className="muted" style={{ fontSize: 11 }}>handles 500+ options without freezing (list is windowed)</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ColumnEditor({ q, onChange }: { q: Question; onChange(cols: QuestionColumn[]): void }) {
  const cols = q.columns;
  const set = (i: number, patch: Partial<QuestionColumn>) =>
    onChange(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= cols.length) return;
    const next = [...cols];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div>
      {cols.map((c, i) => (
        <div key={c.id} className="card" style={{ padding: 10 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input grow" value={c.label} placeholder="Column label"
              onChange={(e) => set(i, { label: e.target.value })} />
            <select className="select" style={{ width: 140 }} value={c.responseType}
              onChange={(e) => set(i, { responseType: e.target.value as ResponseType })}>
              {RESPONSE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="input mono" style={{ width: 120 }} value={c.variableStem}
              title="variable stem — variables become STEM_<row>"
              onChange={(e) => set(i, { variableStem: e.target.value.toUpperCase() })} />
            <button className="btn small" onClick={() => move(i, -1)}>↑</button>
            <button className="btn small" onClick={() => move(i, 1)}>↓</button>
            <button className="btn small danger" onClick={() => onChange(cols.filter((_, j) => j !== i))}>×</button>
          </div>
          {["single", "multi", "dropdown", "multi_dropdown"].includes(c.responseType) && (
            <OptionRows options={c.options} showFlags={false} enableLogic questionId={q.id}
              onChange={(opts) => set(i, { options: opts })} />
          )}
          <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
            {(c.responseType === "numeric" || c.responseType === "slider") && (
              <>
                <input className="input" style={{ width: 76 }} type="number" placeholder="min"
                  value={c.min ?? ""} onChange={(e) => set(i, { min: e.target.value === "" ? undefined : Number(e.target.value) })} />
                <input className="input" style={{ width: 76 }} type="number" placeholder="max"
                  value={c.max ?? ""} onChange={(e) => set(i, { max: e.target.value === "" ? undefined : Number(e.target.value) })} />
              </>
            )}
            <input className="input" style={{ width: 110 }} placeholder="width e.g. 120px"
              value={c.width ?? ""} onChange={(e) => set(i, { width: e.target.value || undefined })} />
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
              <input type="checkbox" checked={c.readOnly}
                onChange={(e) => set(i, { readOnly: e.target.checked })} /> read-only
            </label>
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
              required
              <input type="checkbox"
                checked={c.validation.some((v) => v.kind === "required")}
                onChange={(e) => set(i, {
                  validation: e.target.checked
                    ? [...c.validation, { kind: "required" as const }]
                    : c.validation.filter((v) => v.kind !== "required"),
                })} />
            </label>
          </div>
          <input className="input mono" style={{ marginTop: 6 }}
            placeholder="calculated expression (makes cell read-only), e.g. RATING_{{row}} * 2"
            value={c.expression ?? ""}
            onChange={(e) => set(i, { expression: e.target.value || undefined })} />
        </div>
      ))}
      <button className="btn small" onClick={() =>
        onChange([...cols, {
          id: uid("col"), label: `Column ${cols.length + 1}`, responseType: "text",
          variableStem: `${q.variableName}_C${cols.length + 1}`, options: [], validation: [],
          readOnly: false,
        }])}>
        + column
      </button>
    </div>
  );
}

/**
 * Form-field editor for Open Text List / Numeric List (reqs §3–5):
 * every row gets its own label, field type, required flag, placeholder and
 * min/max validation — no predefined label restrictions.
 */
function FieldRowsEditor({ q, patch, patchSettings }: {
  q: Question;
  patch(p: Partial<Question>): void;
  patchSettings(p: Partial<Question["settings"]>): void;
}) {
  const rows = q.rows;
  const setRow = (i: number, p: Partial<Question["rows"][number]>) =>
    patch({ rows: rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    patch({ rows: next });
  };
  const numericTypes = ["number", "decimal", "integer", "currency"];
  const getBound = (r: Question["rows"][number], kind: string) =>
    r.validation?.find((v) => v.kind === kind)?.value ?? "";
  const setBound = (i: number, kind: string, raw: string) => {
    const r = rows[i];
    const rest = (r.validation ?? []).filter((v) => v.kind !== kind);
    setRow(i, {
      validation: raw === "" ? rest : [...rest, { kind: kind as any, value: Number(raw) }],
    });
  };

  return (
    <>
      <h3 className="sec">Fields — each row is its own typed, validated variable</h3>
      {rows.length === 0 && (
        <p className="muted" style={{ fontSize: 12 }}>
          No fields yet. Add labeled fields below (recommended), or keep the legacy
          numbered list via <em>item count</em>.
        </p>
      )}
      {rows.map((r, i) => {
        const ft = r.fieldType ?? (q.type === "numeric_list" ? "number" : "text");
        const isNum = numericTypes.includes(ft);
        const boundMin = isNum ? "min_value" : "min_length";
        const boundMax = isNum ? "max_value" : "max_length";
        return (
          <div key={i} className="card" style={{ padding: 10 }}>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <input className="input code-input" title="row code / variable suffix" value={String(r.code)}
                onChange={(e) => setRow(i, { code: e.target.value })} />
              <input className="input grow" placeholder="Field label, e.g. Email Address"
                value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} />
              <select className="select" style={{ width: 150 }} value={ft}
                onChange={(e) => setRow(i, { fieldType: e.target.value as any })}>
                {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="row" style={{ gap: 4, fontSize: 12 }}>
                <input type="checkbox" checked={r.required ?? false}
                  onChange={(e) => setRow(i, { required: e.target.checked })} /> required
              </label>
              <button className="btn small" onClick={() => move(i, -1)}>↑</button>
              <button className="btn small" onClick={() => move(i, 1)}>↓</button>
              <button className="btn small danger"
                onClick={() => patch({ rows: rows.filter((_, j) => j !== i) })}>×</button>
            </div>
            <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
              <input className="input" style={{ width: 200 }} placeholder="placeholder text"
                value={r.placeholder ?? ""}
                onChange={(e) => setRow(i, { placeholder: e.target.value || undefined })} />
              <label className="row" style={{ gap: 4, fontSize: 12 }}>
                {isNum ? "min value" : "min length"}
                <input className="input" style={{ width: 76 }} type="number"
                  value={String(getBound(r, boundMin))}
                  onChange={(e) => setBound(i, boundMin, e.target.value)} />
              </label>
              <label className="row" style={{ gap: 4, fontSize: 12 }}>
                {isNum ? "max value" : "max length"}
                <input className="input" style={{ width: 76 }} type="number"
                  value={String(getBound(r, boundMax))}
                  onChange={(e) => setBound(i, boundMax, e.target.value)} />
              </label>
            </div>
          </div>
        );
      })}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn small" onClick={() =>
          patch({
            rows: [...rows, {
              code: `f${rows.length + 1}`, label: `Field ${rows.length + 1}`, flags: [],
              fieldType: q.type === "numeric_list" ? "number" : "text",
              validation: [], required: false,
            } as any],
          })}>
          + field
        </button>
        {rows.length === 0 && (
          <label className="row" style={{ gap: 6, fontSize: 12 }}>
            legacy item count
            <input className="input" type="number" style={{ width: 80 }}
              value={q.settings.listCount ?? 3}
              onChange={(e) => patchSettings({ listCount: Number(e.target.value) })} />
          </label>
        )}
      </div>
    </>
  );
}

export function QuestionEditor({ q }: { q: Question }) {
  const s = useStudio();
  const plugin = questionTypeRegistry.get(q.type);
  const feats = plugin?.features ?? {};
  // capability-driven configuration: a variant narrows what the editor shows;
  // legacy questions (no variant) keep the base-type behaviour untouched.
  const variantDef = q.variant ? variantRegistry.get(q.variant) : undefined;
  const has = (c: string) =>
    variantDef ? variantDef.capabilities.includes(c as any) : true;
  const patch = (p: Partial<Question>) =>
    s.update((d) => {
      const i = d.questions.findIndex((x) => x.id === q.id);
      if (i >= 0) d.questions[i] = { ...d.questions[i], ...p } as Question;
    });
  const patchSettings = (p: Partial<Question["settings"]>) =>
    patch({ settings: { ...q.settings, ...p } });

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="f" style={{ width: 90, marginBottom: 0 }}><span>Code</span>
          <input className="input mono" value={q.code} onChange={(e) => patch({ code: e.target.value })} /></label>
        <label className="f grow" style={{ marginBottom: 0 }}><span>Variable name</span>
          <input className="input mono" value={q.variableName}
            onChange={(e) => patch({ variableName: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} /></label>
        <VariantSwitcher q={q} />
      </div>

      <label className="f"><span>Question text — rich text, HTML and piping ({"{{Q1}}"}) supported</span></label>
      <RichTextEditor value={q.text} autoFocusId={`qtext_${q.id}`} questionId={q.id}
        onChange={(html) => patch({ text: html })}
        placeholder="e.g. Earlier you selected {{Q1}}. Why did you choose {{Q1.first}}?" />
      <div className="row">
        <label className="f grow"><span>Instruction</span>
          <input className="input" value={q.instruction ?? ""}
            onChange={(e) => patch({ instruction: e.target.value || undefined })} /></label>
        <label className="f" style={{ width: 120 }}><span>Required</span>
          <select className="select" value={q.required ? "1" : "0"}
            onChange={(e) => patch({ required: e.target.value === "1" })}>
            <option value="0">optional</option><option value="1">required</option>
          </select></label>
      </div>

      {feats.options && has("options") && (
        <>
          <h3 className="sec">Options</h3>
          <OptionRows options={q.options} onChange={(options) => patch({ options })}
            flagChoices={allowedFlagsFor(q.type)} enableLogic questionId={q.id}
            showImage={has("images") && (variantDef?.capabilities.includes("images") || q.type.startsWith("image"))} />
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
            {has("layout_columns") && (
            <label className="f" style={{ marginBottom: 0, width: 130 }}><span>Layout</span>
              <select className="select" value={q.settings.columnsLayout ?? 1}
                onChange={(e) => patchSettings({ columnsLayout: Number(e.target.value) === 1 ? undefined : Number(e.target.value) })}>
                <option value={1}>1 column</option>
                <option value={2}>2 columns</option>
                <option value={3}>3 columns</option>
                <option value={4}>4 columns</option>
              </select></label>)}
            {has("sorting") && (
            <label className="f" style={{ marginBottom: 0, width: 170 }}><span>Sort (presentation)</span>
              <select className="select" value={q.settings.optionOrder ?? "original"}
                onChange={(e) => patchSettings({ optionOrder: e.target.value === "original" ? undefined : (e.target.value as any) })}>
                <option value="original">original order</option>
                <option value="az">alphabetical A → Z</option>
                <option value="za">alphabetical Z → A</option>
                <option value="numeric_asc">numeric ascending</option>
                <option value="numeric_desc">numeric descending</option>
              </select></label>)}
            <span className="muted" style={{ fontSize: 11, alignSelf: "flex-end", paddingBottom: 7 }}>
              sorting never changes the programmed order; randomization is configured in the right panel
            </span>
          </div>
          <OptionPreview q={q} />
        </>
      )}

      {feats.rows && q.type !== "numeric_list" && q.type !== "text_list" && (
        <>
          <h3 className="sec">Rows</h3>
          <OptionRows showFlags={false} enableLogic questionId={q.id}
            options={q.rows.map((r) => ({
              code: r.code, label: r.label, flags: r.flags ?? [],
              logic: r.logic, visibleIf: r.visibleIf,
            }))}
            onChange={(rows) =>
              patch({
                rows: rows.map((r) => {
                  const prev = q.rows.find((x) => String(x.code) === String(r.code));
                  return {
                    validation: [], required: false, ...prev,
                    code: r.code, label: r.label, flags: [],
                    logic: r.logic, visibleIf: r.visibleIf,
                  };
                }),
              })} />
          {q.carryForward?.into === "rows" && (
            <p className="muted" style={{ fontSize: 12 }}>
              Rows are carried forward from {s.def.questions.find((x) => x.id === q.carryForward?.sourceQuestionId)?.code ?? "?"} —
              static rows above are {q.carryForward.keepOwn ? "appended" : "ignored"}.
            </p>
          )}
        </>
      )}

      {feats.columns && (
        <>
          <h3 className="sec">Columns {q.type === "composite" || q.type === "custom_table"
            ? "— each column has its own response type, variable, codes, validation" : ""}</h3>
          <ColumnEditor q={q} onChange={(columns) => patch({ columns })} />
        </>
      )}

      {(q.type === "numeric_list" || q.type === "text_list") && (
        <FieldRowsEditor q={q} patch={patch} patchSettings={patchSettings} />
      )}

      {feats.numericBounds && (
        <div className="row">
          <label className="f"><span>Min</span>
            <input className="input" type="number" style={{ width: 90 }} value={q.settings.minValue ?? ""}
              onChange={(e) => patchSettings({ minValue: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
          <label className="f"><span>Max</span>
            <input className="input" type="number" style={{ width: 90 }} value={q.settings.maxValue ?? ""}
              onChange={(e) => patchSettings({ maxValue: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
          {feats.sum && (
            <>
              <label className="f"><span>Sum target</span>
                <input className="input" type="number" style={{ width: 90 }} value={q.settings.sumTarget ?? ""}
                  onChange={(e) => patchSettings({ sumTarget: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
              <label className="f"><span>Unit</span>
                <input className="input" style={{ width: 70 }} value={q.settings.sumUnit ?? ""}
                  onChange={(e) => patchSettings({ sumUnit: e.target.value || undefined })} /></label>
            </>
          )}
        </div>
      )}

      {(q.type === "multi_select" || q.type === "multi_dropdown" || q.type === "image_select" || q.type === "ranking") && has("min_max_selections") && (
        <div className="row">
          <label className="f"><span>Min selections</span>
            <input className="input" type="number" style={{ width: 90 }} value={q.settings.minSelections ?? ""}
              onChange={(e) => patchSettings({ minSelections: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
          <label className="f"><span>Max selections</span>
            <input className="input" type="number" style={{ width: 90 }} value={q.settings.maxSelections ?? ""}
              onChange={(e) => patchSettings({ maxSelections: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
        </div>
      )}

      {(q.type === "hidden" || q.type === "calculated") && (
        <label className="f"><span>{q.type === "calculated" ? "Expression (calc DSL)" : "Default value"}</span>
          <input className="input mono"
            value={q.type === "calculated" ? (q.settings.expression ?? "") : String(q.settings.defaultValue ?? "")}
            placeholder={q.type === "calculated" ? "Q1 + Q2 + Q3" : ""}
            onChange={(e) =>
              q.type === "calculated"
                ? patchSettings({ expression: e.target.value })
                : patchSettings({ defaultValue: e.target.value })
            } /></label>
      )}

      {q.type === "hotspot" && (
        <>
          <label className="f"><span>Stimulus image URL</span>
            <input className="input" value={q.settings.imageUrl ?? ""}
              placeholder="https://…/image.jpg"
              onChange={(e) => patchSettings({ imageUrl: e.target.value || undefined })} /></label>
          <div className="row">
            <label className="f"><span>Min points</span>
              <input className="input" type="number" style={{ width: 90 }} value={q.settings.minSelections ?? ""}
                onChange={(e) => patchSettings({ minSelections: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
            <label className="f"><span>Max points</span>
              <input className="input" type="number" style={{ width: 90 }} value={q.settings.maxSelections ?? 1}
                onChange={(e) => patchSettings({ maxSelections: Number(e.target.value) })} /></label>
          </div>
          {q.settings.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={q.settings.imageUrl} alt="stimulus preview" style={{ maxWidth: 320, borderRadius: 8, border: "1px solid var(--border)" }} />
          )}
        </>
      )}

      {(q.type === "conjoint_task" || q.type === "maxdiff_task") && (
        <label className="f"><span>Design file</span>
          <select className="select" value={q.settings.designRef ?? ""}
            onChange={(e) => patchSettings({ designRef: e.target.value || undefined })}>
            <option value="">— pick a generated design —</option>
            {s.def.designs.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.kind} v{d.version})</option>)}
          </select></label>
      )}

      {q.type === "html" && (
        <label className="f"><span>HTML content</span>
          <textarea className="ta code" value={q.customHtml ?? ""}
            onChange={(e) => patch({ customHtml: e.target.value || undefined })} /></label>
      )}
    </div>
  );
}

/** Parse pasted option lists: strips numbering (1. / 1) ), bullets (- * •)
 *  and supports "code<TAB>label" lines. */
export function parsePastedOptions(text: string, startCode: number): Option[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const tab = line.split("\t");
      if (tab.length >= 2 && tab[0].trim()) {
        return { code: tab[0].trim(), label: tab.slice(1).join(" ").trim(), flags: [] as any[] };
      }
      const cleaned = line.replace(/^\s*(\d{1,4}[.)]|[-*•‣▪])\s+/, "").trim();
      return { code: String(startCode + i), label: cleaned || line, flags: [] as any[] };
    });
}

interface PageRef {
  node: { id: string; title?: string; questionIds: string[] };
  parent: any[];
  index: number;
}

/** Every page node with its parent array, in visual order. */
function listPages(flow: any[]): PageRef[] {
  const out: PageRef[] = [];
  const walk = (nodes: any[]) => {
    nodes.forEach((n, i) => {
      if (n.type === "page") out.push({ node: n, parent: nodes, index: i });
      if (n.children) walk(n.children);
      if (n.branches) for (const b of n.branches) walk(b.children);
      if (n.otherwise) walk(n.otherwise);
    });
  };
  walk(flow);
  return out;
}

/** Inline insert bar shown between questions (reqs §1–2, §4). */
function InsertBar({ onQuestion, onPick, onBreak, canBreak }: {
  onQuestion(): void; onPick(): void; onBreak(): void; canBreak: boolean;
}) {
  return (
    <div className="insert-bar">
      <span className="insert-line" />
      <button className="btn small" onClick={onQuestion} title="Add a question here (default type — change it inline)">
        + Question
      </button>
      <button className="btn small" onClick={onPick} title="Pick a question type from the full library">▾ type…</button>
      {canBreak && (
        <button className="btn small" onClick={onBreak} title="Start a new page here">⤵ Page break</button>
      )}
      <span className="insert-line" />
    </div>
  );
}

export function QuestionsPanel() {
  const s = useStudio();
  const [pickerAt, setPickerAt] = React.useState<{ pageId: string; pos: number } | null>(null);
  const selected = s.def.questions.find((q) => q.id === s.selectedQuestionId);
  const pages = listPages(s.def.flow as any[]);
  const placed = new Set(pages.flatMap((p) => p.node.questionIds));
  const unplaced = s.def.questions.filter((q) => !placed.has(q.id));

  const focusQuestion = (qid: string) => {
    s.select(qid);
    // the editor mounts on the next render — retry briefly until it exists
    let tries = 0;
    const attempt = () => {
      const el = document.getElementById(`qtext_${qid}`);
      if (el) {
        el.focus();
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (tries++ < 20) {
        setTimeout(attempt, 50);
      }
    };
    setTimeout(attempt, 30);
  };

  /** Insert a question on a page at position pos (after pos-1). */
  const insertQuestion = (pageId: string, pos: number, variant?: QuestionVariantDef) => {
    const v = variant ?? variantRegistry.get("single_select.radio")!;
    const q = createFromVariant(v, s.def.questions.length + 1);
    s.update((d) => {
      d.questions.push(q);
      for (const pg of listPages(d.flow as any[])) {
        if (pg.node.id === pageId) {
          pg.node.questionIds.splice(pos, 0, q.id);
          return;
        }
      }
      // page not found (edge case): append to last page
      const last = listPages(d.flow as any[]).pop();
      last?.node.questionIds.push(q.id);
    });
    focusQuestion(q.id);
    if (variant) s.toast(`Added ${variant.familyLabel} → ${variant.name}`);
  };

  /** Split a page after position pos — a real structural page break (req §2). */
  const pageBreak = (pageId: string, pos: number) => {
    s.update((d) => {
      for (const pg of listPages(d.flow as any[])) {
        if (pg.node.id !== pageId) continue;
        const moved = pg.node.questionIds.slice(pos);
        pg.node.questionIds = pg.node.questionIds.slice(0, pos);
        const newPage = { type: "page", id: uid("page"), questionIds: moved };
        pg.parent.splice(pg.index + 1, 0, newPage);
        return;
      }
    });
    s.toast("Page break added");
  };

  /** Merge a page into the previous page at the same level. */
  const removeBreak = (pageId: string) => {
    s.update((d) => {
      const all = listPages(d.flow as any[]);
      const i = all.findIndex((p) => p.node.id === pageId);
      if (i <= 0) return;
      const cur = all[i];
      const prev = all[i - 1];
      if (prev.parent !== cur.parent) return; // only merge siblings
      prev.node.questionIds.push(...cur.node.questionIds);
      cur.parent.splice(cur.parent.indexOf(cur.node), 1);
    });
  };

  /** Reorder within a page; crossing the edge moves to the adjacent page. */
  const move = (qid: string, dir: -1 | 1) =>
    s.update((d) => {
      const all = listPages(d.flow as any[]);
      const pi = all.findIndex((p) => p.node.questionIds.includes(qid));
      if (pi < 0) return;
      const ids = all[pi].node.questionIds;
      const k = ids.indexOf(qid);
      const t = k + dir;
      if (t >= 0 && t < ids.length) {
        [ids[k], ids[t]] = [ids[t], ids[k]];
      } else {
        const adj = all[pi + dir];
        if (!adj) return;
        ids.splice(k, 1);
        if (dir === -1) adj.node.questionIds.push(qid);
        else adj.node.questionIds.unshift(qid);
      }
    });

  const duplicate = (id: string) =>
    s.update((d) => {
      const q = d.questions.find((x) => x.id === id);
      if (!q) return;
      const copy = structuredClone(q);
      copy.id = uid("q");
      copy.code = `${q.code}_COPY`;
      copy.variableName = `${q.variableName}_COPY`;
      d.questions.push(copy);
      for (const pg of listPages(d.flow as any[])) {
        const k = pg.node.questionIds.indexOf(id);
        if (k >= 0) { pg.node.questionIds.splice(k + 1, 0, copy.id); return; }
      }
    });

  const remove = (id: string) => {
    if (!confirm("Delete this question? Logic referring to it will need updating.")) return;
    s.update((d) => {
      d.questions = d.questions.filter((q) => q.id !== id);
      for (const p of flattenPages(d.flow)) p.questionIds = p.questionIds.filter((x) => x !== id);
    });
    if (s.selectedQuestionId === id) s.select(null);
  };

  const card = (qid: string) => {
    const q = s.def.questions.find((x) => x.id === qid);
    if (!q) return null;
    return (
      <div key={q.id}
        className={`card selectable qcard ${q.id === s.selectedQuestionId ? "selected" : ""}`}
        onClick={() => s.select(q.id)}>
        <div className="qlist-item">
          <strong className="mono">{q.code}</strong>
          <span className="qtype-badge">{q.variant?.split(".")[1] ?? q.type}</span>
          <span className="grow qcard-text"
            dangerouslySetInnerHTML={{ __html: q.text || '<span class="muted">untitled</span>' }} />
          {q.displayLogic && <span className="chip warn" title="has display logic">DL</span>}
          {q.skipLogic.length > 0 && <span className="chip warn" title="has skip logic">SL</span>}
          {q.carryForward && <span className="chip" title="carry-forward">CF</span>}
          <button className="btn small" onClick={(e) => { e.stopPropagation(); move(q.id, -1); }}>↑</button>
          <button className="btn small" onClick={(e) => { e.stopPropagation(); move(q.id, 1); }}>↓</button>
          <button className="btn small" onClick={(e) => { e.stopPropagation(); duplicate(q.id); }}>⧉</button>
          <button className="btn small danger" onClick={(e) => { e.stopPropagation(); remove(q.id); }}>×</button>
        </div>
        {q.id === s.selectedQuestionId && selected && (
          <div style={{ marginTop: 14 }} onClick={(e) => e.stopPropagation()}>
            <QuestionEditor q={selected} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Questions</h2>
        <span className="chip">{s.def.questions.length}</span>
        <span className="chip">{pages.length} page{pages.length === 1 ? "" : "s"}</span>
        <span className="grow" />
        <button className="btn primary" onClick={() => {
          const last = pages[pages.length - 1];
          setPickerAt(last ? { pageId: last.node.id, pos: last.node.questionIds.length } : { pageId: "", pos: 0 });
        }}>+ Add question</button>
        {pickerAt && (
          <VariantPickerModal
            onPick={(v) => { insertQuestion(pickerAt.pageId, pickerAt.pos, v); setPickerAt(null); }}
            onClose={() => setPickerAt(null)} />
        )}
      </div>

      {pages.map((pg, pi) => (
        <div key={pg.node.id} className="page-group">
          <div className="page-head">
            <span className="page-badge">PAGE {pi + 1}</span>
            <input className="input page-title" placeholder="page title (optional)"
              value={pg.node.title ?? ""}
              onChange={(e) => s.update((d) => {
                const hit = listPages(d.flow as any[]).find((x) => x.node.id === pg.node.id);
                if (hit) (hit.node as any).title = e.target.value || undefined;
              })} />
            <span className="muted" style={{ fontSize: 11 }}>{pg.node.questionIds.length} question{pg.node.questionIds.length === 1 ? "" : "s"}</span>
            {pi > 0 && pages[pi - 1].parent === pg.parent && (
              <button className="btn small" title="Merge this page into the previous one"
                onClick={() => removeBreak(pg.node.id)}>merge ↑</button>
            )}
          </div>
          {pg.node.questionIds.length === 0 && (
            <InsertBar canBreak={false}
              onQuestion={() => insertQuestion(pg.node.id, 0)}
              onPick={() => setPickerAt({ pageId: pg.node.id, pos: 0 })}
              onBreak={() => {}} />
          )}
          {pg.node.questionIds.map((qid, k) => (
            <React.Fragment key={qid}>
              {card(qid)}
              <InsertBar
                canBreak={k < pg.node.questionIds.length - 1 || pg.node.questionIds.length > 0}
                onQuestion={() => insertQuestion(pg.node.id, k + 1)}
                onPick={() => setPickerAt({ pageId: pg.node.id, pos: k + 1 })}
                onBreak={() => pageBreak(pg.node.id, k + 1)} />
            </React.Fragment>
          ))}
        </div>
      ))}

      {unplaced.length > 0 && (
        <div className="page-group">
          <div className="page-head"><span className="page-badge" style={{ background: "var(--amber)" }}>NOT ON ANY PAGE</span>
            <span className="muted" style={{ fontSize: 11 }}>assign these in Survey Flow, or they will never display</span></div>
          {unplaced.map((q) => card(q.id))}
        </div>
      )}

      {s.def.questions.length === 0 && pages.length === 0 && (
        <p className="muted">No pages yet — add a page in the Survey Flow tab, then build questions here.</p>
      )}
    </div>
  );
}

export function flattenPages(flow: any[]): { id: string; questionIds: string[]; title?: string }[] {
  const out: any[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.type === "page") out.push(n);
      if (n.children) walk(n.children);
      if (n.branches) for (const b of n.branches) walk(b.children);
      if (n.otherwise) walk(n.otherwise);
    }
  };
  walk(flow);
  return out;
}
