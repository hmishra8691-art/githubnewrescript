"use client";
import React from "react";
import type { Question, Option, QuestionColumn, ResponseType, QuestionVariantDef } from "@rescript/schema";
import { questionTypeRegistry, variantRegistry } from "@rescript/schema";
import { VariantPickerModal, VariantSwitcher, createFromVariant } from "./VariantPicker";
import { FIELD_TYPES } from "@rescript/engine"; // also registers builtin question types
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

function OptionRows({ options, onChange, showFlags = true, flagChoices, showImage = false }: {
  options: Option[]; onChange(opts: Option[]): void; showFlags?: boolean;
  flagChoices?: string[]; showImage?: boolean;
}) {
  const [filter, setFilter] = React.useState("");
  const [showAll, setShowAll] = React.useState(false);
  const set = (i: number, patch: Partial<Option>) =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
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
    <div>
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
      {visible.map(({ o, i }) => (
        <div key={i} className="opt-row">
          <input className="input code-input" value={String(o.code)}
            onChange={(e) => set(i, { code: e.target.value })} title="code" />
          <input className="input grow" value={o.label}
            onChange={(e) => set(i, { label: e.target.value })} placeholder="label (piping {{Q1}} allowed)" />
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
          <button className="btn small" onClick={() => move(i, -1)}>↑</button>
          <button className="btn small" onClick={() => move(i, 1)}>↓</button>
          <button className="btn small danger" onClick={() => onChange(options.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="row">
        <button className="btn small" onClick={() =>
          onChange([...options, { code: String(options.length + 1), label: "", flags: [] }])}>
          + option
        </button>
        <button className="btn small" onClick={() => {
          const text = prompt("Paste options, one per line (\"code<TAB>label\" or just labels):");
          if (!text) return;
          const parsed = text.split("\n").filter(Boolean).map((line, i) => {
            const [a, b] = line.split("\t");
            return b !== undefined
              ? { code: a.trim(), label: b.trim(), flags: [] as any[] }
              : { code: String(options.length + i + 1), label: line.trim(), flags: [] as any[] };
          });
          onChange([...options, ...parsed]);
        }}>
          paste list
        </button>
      </div>
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
            <OptionRows options={c.options} showFlags={false}
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

      <label className="f"><span>Question text (HTML + piping tokens allowed)</span>
        <textarea className="ta" value={q.text} onChange={(e) => patch({ text: e.target.value })}
          placeholder='e.g. Earlier you selected {{Q1}}. Why did you choose {{Q1.first}}?' /></label>
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
            flagChoices={allowedFlagsFor(q.type)}
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
        </>
      )}

      {feats.rows && q.type !== "numeric_list" && q.type !== "text_list" && (
        <>
          <h3 className="sec">Rows</h3>
          <OptionRows showFlags={false}
            options={q.rows.map((r) => ({ code: r.code, label: r.label, flags: r.flags ?? [] }))}
            onChange={(rows) =>
              patch({
                rows: rows.map((r) => {
                  const prev = q.rows.find((x) => String(x.code) === String(r.code));
                  return { validation: [], required: false, ...prev, code: r.code, label: r.label, flags: [] };
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

export function QuestionsPanel() {
  const s = useStudio();
  const [addOpen, setAddOpen] = React.useState(false);
  const selected = s.def.questions.find((q) => q.id === s.selectedQuestionId);

  const addQuestion = (variant: QuestionVariantDef) => {
    const q = createFromVariant(variant, s.def.questions.length + 1);
    s.update((d) => {
      d.questions.push(q);
      // auto-place on the last page
      const lastPage = [...flattenPages(d.flow)].pop();
      if (lastPage) lastPage.questionIds.push(q.id);
    });
    s.select(q.id);
    setAddOpen(false);
    s.toast(`Added ${variant.familyLabel} → ${variant.name}`);
  };

  const move = (id: string, dir: -1 | 1) =>
    s.update((d) => {
      const i = d.questions.findIndex((q) => q.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.questions.length) return;
      [d.questions[i], d.questions[j]] = [d.questions[j], d.questions[i]];
    });

  const duplicate = (id: string) =>
    s.update((d) => {
      const q = d.questions.find((x) => x.id === id);
      if (!q) return;
      const copy = structuredClone(q);
      copy.id = uid("q");
      copy.code = `${q.code}_COPY`;
      copy.variableName = `${q.variableName}_COPY`;
      d.questions.splice(d.questions.findIndex((x) => x.id === id) + 1, 0, copy);
    });

  const remove = (id: string) => {
    if (!confirm("Delete this question? Logic referring to it will need updating.")) return;
    s.update((d) => {
      d.questions = d.questions.filter((q) => q.id !== id);
      for (const p of flattenPages(d.flow)) p.questionIds = p.questionIds.filter((x) => x !== id);
    });
    if (s.selectedQuestionId === id) s.select(null);
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Questions</h2>
        <span className="chip">{s.def.questions.length}</span>
        <span className="grow" />
        <button className="btn primary" onClick={() => setAddOpen(true)}>+ Add question</button>
        {addOpen && <VariantPickerModal onPick={addQuestion} onClose={() => setAddOpen(false)} />}
      </div>

      {s.def.questions.map((q) => (
        <div key={q.id}
          className={`card selectable ${q.id === s.selectedQuestionId ? "selected" : ""}`}
          onClick={() => s.select(q.id)}>
          <div className="qlist-item">
            <strong className="mono">{q.code}</strong>
            <span className="qtype-badge">{q.type}</span>
            <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {q.text.replace(/<[^>]*>/g, "") || <span className="muted">untitled</span>}
            </span>
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
      ))}
      {s.def.questions.length === 0 && (
        <p className="muted">No questions yet. Add one, then place it on a page in the Survey Flow.</p>
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
