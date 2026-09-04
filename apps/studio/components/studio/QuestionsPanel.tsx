"use client";
import { OptionalCondition } from "./ConditionBuilder";
import { optionMetaFields, VariantSettings, type MetaField } from "./variantConfig";
import { CountInput } from "./CountInput";
import React from "react";
import type { Question, Option, QuestionColumn, ResponseType, QuestionVariantDef } from "@rescript/schema";
import { questionTypeRegistry, variantRegistry, resolveVariant } from "@rescript/schema";
import { VariantPickerModal, VariantSwitcher, createFromVariant } from "./VariantPicker";
import { RichTextEditor } from "./RichTextEditor";
import { OptionLogicEditor } from "./OptionLogicEditor";
import { OptionPreview } from "./OptionPreview";
import { usePreviewBlock } from "./PreviewBlock";
import { MediaUrlInput } from "./MediaUrlInput";

/** Variants whose stimulus IS `settings.mediaUrl` (their own settings edit it). */
const MEDIA_OWNING = new Set(["videorating", "videotimeline", "watchtime", "audiorec", "base:media_timeline"]);
import { InsertPipingButton } from "./PipingPicker";
import {
  FIELD_TYPES, nextCode, resequenceQuestionCodes,
  parsePastedOptions, planPaste, optionsToPaste, type PasteMode,
} from "@rescript/engine"; // also registers builtin question types
import { isEmptyOptionLogic } from "@rescript/schema";
import { useStudio, uid } from "./store";
import {
  type PageRef, type BlockRef, listPages, listBlocks, wrapBlock, unwrapIfSingle,
} from "./blockModel";
import { MoveQuestionModal } from "./MoveQuestion";

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

/**
 * Flags that make sense on a matrix ROW (a statement), as opposed to a column
 * option (the scale point). Anchoring and exclusivity are row-level concepts
 * the engine already honours — the editor simply never offered them, so a
 * programmer could not pin "None of these" to the bottom of a grid.
 */
export function allowedRowFlagsFor(qtype: string): string[] {
  const base = ["anchor_top", "anchor_bottom", "other_specify"];
  if (qtype === "matrix_multi") return [...base, "exclusive", "none_of_above"];
  return base;
}

const OPTION_WINDOW = 40;

function OptionRows({ options, onChange, showFlags = true, flagChoices, showImage = false, metaFields = [],
  enableLogic = false, questionId, onAfterDelete }: {
  options: Option[]; onChange(opts: Option[]): void; showFlags?: boolean;
  flagChoices?: string[]; showImage?: boolean; metaFields?: MetaField[];
  /** per-option logic + piping controls (reqs §1–4, §21) */
  enableLogic?: boolean; questionId?: string;
  /** called after a removal so the owner can re-sequence codes */
  onAfterDelete?(): void;
}) {
  const [filter, setFilter] = React.useState("");
  const [showAll, setShowAll] = React.useState(false);
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState("");
  /**
   * Paste box modes. REPLACE is the default: the box opens showing the list
   * as it is (`code<TAB>label`), so what you see is what you get after
   * import; options named by code or label keep their identity — codes,
   * flags, images, logic — so nothing that refers to them breaks. APPEND is
   * the explicit "add these after what I have" choice.
   */
  const [pasteMode, setPasteMode] = React.useState<PasteMode>("replace");
  const openPaste = () => {
    if (!pasteOpen) {
      setPasteText(options.some((o) => o.label.trim()) ? optionsToPaste(options) : "");
      setPasteMode("replace");
    }
    setPasteOpen((v) => !v);
  };
  const pastePlan = React.useMemo(() => planPaste(options, pasteText, pasteMode), [options, pasteText, pasteMode]);
  const [logicOpen, setLogicOpen] = React.useState<string | null>(null);
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

  /**
   * New codes are `max(existing) + 1`. Using the list LENGTH — as this did —
   * produces a duplicate the moment anything has been deleted (delete #2 of 5,
   * add one, and the new option is also coded 5), and duplicate codes silently
   * corrupt every code-keyed lookup: logic, piping, exports, stored answers.
   * It also numbered the first five rows 2,3,4,5,6 whenever a blank row
   * already existed.
   */
  const insertAfter = (i: number) => {
    const next = [...options];
    next.splice(i + 1, 0, { code: nextCode(options), label: "", flags: [] } as Option);
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
      onAfterDelete?.();
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
    const parsed = parsePastedOptions(text, Number(nextCode(options)));
    if (parsed.length === 0) return;
    const next = [...options];
    next[i] = { ...next[i], label: parsed[0].label, code: options[i].label ? next[i].code : parsed[0].code };
    next.splice(i + 1, 0, ...(parsed.slice(1) as Option[]));
    pendingFocus.current = i + parsed.length - 1;
    setShowAll(true); // the pasted rows must be mounted for focus to land
    onChange(next);
  };

  const importPaste = () => {
    if (parsePastedOptions(pasteText, 1).length === 0) return;
    onChange(pastePlan.options);
    if (pastePlan.removed > 0) onAfterDelete?.();
    setFilter("");
    setShowAll(true);
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
  const f = filter.trim().toLowerCase();
  // Showing the search box only while the list is long meant that deleting
  // back under the threshold unmounted it with the filter still applied — the
  // rows vanished and there was no control left to clear it.
  const big = options.length > OPTION_WINDOW || f.length > 0;
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
        <div className={`opt-row ${logicOpen === String(o.code) ? "logic-open" : ""}`}>
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
            <div style={{ width: 200 }}>
              <MediaUrlInput compact placeholder="image URL" testId={`option-image-${i}`}
                value={o.imageUrl} onChange={(v) => set(i, { imageUrl: v })} />
            </div>
          )}
          {metaFields.map((mf) => {
            const cur = o.meta?.[mf.key];
            const setMeta = (v: unknown) => {
              const meta = { ...(o.meta ?? {}) };
              if (v === undefined || v === "" || v === false) delete meta[mf.key]; else meta[mf.key] = v;
              set(i, { meta: Object.keys(meta).length ? meta : undefined });
            };
            if (mf.kind === "check") {
              return (
                <label key={mf.key} className="row" style={{ gap: 4, fontSize: 11 }} title={mf.label}>
                  <input type="checkbox" checked={!!cur} data-testid={`option-meta-${mf.key}-${i}`}
                    onChange={(e) => setMeta(e.target.checked)} />
                  {mf.label}
                </label>
              );
            }
            return (
              <input key={mf.key} className="input" style={{ width: mf.width ?? 120 }}
                type={mf.kind === "number" ? "number" : "text"}
                placeholder={mf.placeholder ?? mf.label} title={mf.label}
                data-testid={`option-meta-${mf.key}-${i}`}
                value={cur == null ? "" : String(cur)}
                onChange={(e) => setMeta(mf.kind === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)} />
            );
          })}
          {showFlags && (
            /**
             * Option properties are INDEPENDENT and combine freely.
             *
             * This was a single-value <select>: choosing "exclusive" erased
             * "other/specify", so the commonest requirement in survey research
             * — an "Other: ____" that is also exclusive, or a "None of these"
             * anchored to the bottom — could not be expressed at all. The
             * engine always supported a list; only the editor insisted on one.
             */
            <details className="opt-flags" onClick={(e) => e.stopPropagation()}>
              <summary className={(o.flags?.length ?? 0) > 0 ? "has" : ""}
                title="Option properties — combine as many as you need"
                data-testid={`option-flags-${i}`}>
                {(o.flags?.length ?? 0) > 0
                  ? o.flags!.map((f2) => ALL_FLAGS.find((x) => x.value === f2)?.label ?? f2).join(" + ")
                  : "properties…"}
              </summary>
              <div className="opt-flags-menu">
                {flags.map((fl) => {
                  const on = o.flags?.includes(fl.value as any) ?? false;
                  return (
                    <label key={fl.value} className="opt-flag-row">
                      <input type="checkbox" checked={on}
                        data-testid={`option-flag-${i}-${fl.value}`}
                        onChange={(e) => {
                          const cur = new Set(o.flags ?? []);
                          if (e.target.checked) cur.add(fl.value as any);
                          else cur.delete(fl.value as any);
                          // anchor top and bottom are the one genuinely
                          // exclusive pair — an option cannot be pinned to
                          // both ends of the list
                          if (e.target.checked && fl.value === "anchor_top") cur.delete("anchor_bottom" as any);
                          if (e.target.checked && fl.value === "anchor_bottom") cur.delete("anchor_top" as any);
                          set(i, { flags: [...cur] as any });
                        }} />
                      {fl.label}
                    </label>
                  );
                })}
                {(o.flags?.length ?? 0) > 0 && (
                  <button className="btn small" onClick={() => set(i, { flags: [] })}>clear</button>
                )}
              </div>
            </details>
          )}
          {enableLogic && (
            <button className={`btn small ${hasLogic ? "has-logic" : ""}`} data-testid={`option-logic-${i}`}
              title="Option-level logic: always show / hide, conditions, eligibility, ordering"
              onClick={() => setLogicOpen(logicOpen === String(o.code) ? null : String(o.code))}>
              {o.logic?.visibility === "always_show" ? "◉ show"
                : o.logic?.visibility === "always_hide" ? "◌ hide"
                : hasLogic ? "⑂ logic" : "⑂"}
            </button>
          )}
          <button className="btn small" onClick={() => move(i, -1)}>↑</button>
          <button className="btn small" onClick={() => move(i, 1)}>↓</button>
          <button className="btn small danger"
            onClick={() => { onChange(options.filter((_, j) => j !== i)); onAfterDelete?.(); }}>×</button>
        </div>
        {enableLogic && logicOpen === String(o.code) && (
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
        <button className="btn small" data-testid="toggle-paste" onClick={openPaste}>
          {pasteOpen ? "hide paste box" : "📋 paste options"}
        </button>
      </div>
      {pasteOpen && (
        <div className="paste-box" data-testid="paste-panel">
          <div className="row" style={{ alignItems: "center", gap: 10 }}>
            <span className="muted" style={{ fontSize: 11 }}>On import:</span>
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
              <input type="radio" name={`paste-mode-${questionId ?? "x"}`} data-testid="paste-mode-replace"
                checked={pasteMode === "replace"} onChange={() => setPasteMode("replace")} />
              Replace the list
            </label>
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
              <input type="radio" name={`paste-mode-${questionId ?? "x"}`} data-testid="paste-mode-append"
                checked={pasteMode === "append"} onChange={() => { setPasteMode("append"); if (pasteText === optionsToPaste(options)) setPasteText(""); }} />
              Append to the list
            </label>
          </div>
          <textarea className="ta" data-testid="paste-box" rows={Math.min(14, Math.max(4, pasteText.split("\n").length + 1))}
            placeholder={pasteMode === "append"
              ? "Paste the options to ADD — one per line.\nNumbering (1. / 1)) and bullets (- * •) are cleaned automatically.\nUse code<TAB>label to set codes."
              : "Paste the new list here — one per line. This REPLACES the options above.\nKeep code<TAB>label lines to keep an option's code (and everything that refers to it)."}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)} />
          <div className="row" style={{ alignItems: "center" }}>
            <button className="btn small primary" data-testid="import-options" onClick={importPaste}
              disabled={parsePastedOptions(pasteText, 1).length === 0}>
              {pasteMode === "replace" ? "Replace" : "Append"} {parsePastedOptions(pasteText, 1).length || ""} option{parsePastedOptions(pasteText, 1).length === 1 ? "" : "s"}
            </button>
            <span className="muted" style={{ fontSize: 11 }} data-testid="paste-summary">
              {pasteMode === "replace"
                ? `keeps ${pastePlan.kept} · adds ${pastePlan.added} · removes ${pastePlan.removed}`
                : `adds ${pastePlan.added} after the existing ${options.length}`}
            </span>
          </div>
          {pasteMode === "replace" && pastePlan.removed > 0 && (
            <div className="muted" style={{ fontSize: 11, color: "var(--warn, #b45309)" }} data-testid="paste-removes">
              ⚠ Removes option{pastePlan.removed === 1 ? "" : "s"} {pastePlan.removedCodes.map(String).join(", ")} — any logic, piping or masking that names them will be flagged by the linter.
            </div>
          )}
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
  const [condOpen, setCondOpen] = React.useState<number | null>(null);
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
              <select className="select" style={{ width: 150 }} value={ft} data-testid={`field-type-${i}`}
                onChange={(e) => setRow(i, { fieldType: e.target.value as any })}>
                {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="row" style={{ gap: 4, fontSize: 12 }}>
                <input type="checkbox" checked={r.required ?? false} data-testid={`field-required-${i}`}
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
              {/* a field that appears only when an earlier answer says so — the
                  runtime already honours row.visibleIf live; this is where it
                  gets set (the Conditional Form variant is built on it) */}
              <button className={`btn small ${r.visibleIf ? "has-logic" : ""}`}
                data-testid={`field-showwhen-${i}`}
                title="Show this field only when a condition holds"
                onClick={() => setCondOpen(condOpen === i ? null : i)}>
                {r.visibleIf ? "⑂ shown when…" : "⑂ show when"}
              </button>
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
            {condOpen === i && (
              <div style={{ marginTop: 8 }} data-testid={`field-showwhen-editor-${i}`}>
                <OptionalCondition label={`Show “${r.label || r.code}” when`}
                  hint="Leave empty to always show this field."
                  value={r.visibleIf}
                  onChange={(c) => setRow(i, { visibleIf: c })} />
              </div>
            )}
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
            <CountInput min={1} allowEmpty={false} width={80}
              value={q.settings.listCount ?? 3}
              onChange={(v) => patchSettings({ listCount: v ?? 1 })} />
          </label>
        )}
      </div>
    </>
  );
}

export function QuestionEditor({ q }: { q: Question }) {
  const s = useStudio();
  const pendingResequenceNote = React.useRef<number | null>(null);
  React.useEffect(() => {
    const n = pendingResequenceNote.current;
    if (n == null) return;
    pendingResequenceNote.current = null;
    s.toast(n > 0 ? `Codes re-sequenced — ${n} logic reference${n === 1 ? "" : "s"} updated` : "Codes re-sequenced");
  });
  const plugin = questionTypeRegistry.get(q.type);
  const feats = plugin?.features ?? {};
  // capability-driven configuration: a variant narrows what the editor shows;
  // legacy questions (no variant) keep the base-type behaviour untouched.
  const variantDef = resolveVariant(q.variant);
  const has = (c: string) =>
    variantDef ? variantDef.capabilities.includes(c as any) : true;
  const patch = (p: Partial<Question>) =>
    s.update((d) => {
      const i = d.questions.findIndex((x) => x.id === q.id);
      if (i >= 0) d.questions[i] = { ...d.questions[i], ...p } as Question;
    });
  const patchSettings = (p: Partial<Question["settings"]>) =>
    patch({ settings: { ...q.settings, ...p } });

  /**
   * After a deletion, re-sequence this list's codes to 1..N and repoint every
   * reference to them — conditions, list rules, pipeline sources,
   * randomization groups, quota cells and matrix row pipes — in the same edit.
   * Skipped entirely once the survey has responses, because stored answers are
   * keyed by the old codes and cannot be rewritten, and skipped for lists that
   * use meaningful (non-numeric) codes.
   */
  const resequence = (scope: "options" | "rows") => {
    if (s.hasResponses) return;
    s.update((d) => {
      const r = resequenceQuestionCodes(d, q.id, scope);
      if (Object.keys(r.mapping).length === 0) return;
      Object.assign(d, r.def);
      pendingResequenceNote.current = r.referencesUpdated;
    });
  };

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
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="f grow">
          <span>Instruction — formatting and piping supported</span>
          <RichTextEditor value={q.instruction ?? ""} questionId={q.id}
            onChange={(html) => patch({ instruction: html || undefined })}
            placeholder="e.g. Select all that apply." />
        </div>
        <label className="f" style={{ width: 120 }}><span>Required</span>
          <select className="select" value={q.required ? "1" : "0"}
            onChange={(e) => patch({ required: e.target.value === "1" })}>
            <option value="0">optional</option><option value="1">required</option>
          </select></label>
      </div>
      {!MEDIA_OWNING.has(variantDef?.renderer ?? `base:${q.type}`) && (
        <MediaUrlInput label="Media — shown under the question text (image, video, YouTube or Google Drive URL)"
          testId="question-media" value={q.settings.mediaUrl}
          onChange={(v) => patchSettings({ mediaUrl: v })} />
      )}

      {feats.options && has("options") && (
        <>
          <h3 className="sec">Options</h3>
          <OptionRows options={q.options} onChange={(options) => patch({ options })}
            onAfterDelete={() => resequence("options")}
            flagChoices={allowedFlagsFor(q.type)} enableLogic questionId={q.id}
            showImage={has("images") && (variantDef?.capabilities.includes("images") || q.type.startsWith("image"))}
            metaFields={optionMetaFields(variantDef)} />
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
            {has("layout_columns") && q.options.length >= 10 && !q.settings.columnsLayout && (
              <button className="btn small" style={{ alignSelf: "flex-end", marginBottom: 7 }}
                title="A long single column is hard to scan"
                onClick={() => patchSettings({ columnsLayout: q.options.length >= 16 ? 4 : q.options.length >= 9 ? 3 : 2 })}>
                {q.options.length} options — use {q.options.length >= 16 ? 4 : 3} columns?
              </button>
            )}
            <span className="muted" style={{ fontSize: 11, alignSelf: "flex-end", paddingBottom: 7 }}>
              sorting never changes the programmed order; randomization is configured in the right panel
            </span>
          </div>
          <OptionPreview q={q} />
        </>
      )}

      {feats.rows && q.type !== "numeric_list" && q.type !== "text_list" && q.type !== "repeating_group" && (
        <>
          <h3 className="sec">Rows</h3>
          <OptionRows enableLogic questionId={q.id}
            flagChoices={allowedRowFlagsFor(q.type)}
            onAfterDelete={() => resequence("rows")}
            options={q.rows.map((r) => ({
              code: r.code, label: r.label, flags: r.flags ?? [],
              logic: r.logic, visibleIf: r.visibleIf,
            }))}
            onChange={(rows) =>
              patch({
                rows: rows.map((r, i) => {
                  // match by position, not by code: a code edit would otherwise
                  // lose the row's validation and field settings
                  const prev = q.rows[i];
                  return {
                    ...prev,
                    validation: prev?.validation ?? [],
                    required: prev?.required ?? false,
                    code: r.code, label: r.label,
                    // flags used to be hard-reset to [] here, silently wiping
                    // any anchoring the row carried
                    flags: r.flags ?? [],
                    logic: r.logic, visibleIf: r.visibleIf,
                  };
                }),
              })} />
          <p className="muted" style={{ fontSize: 11, marginTop: -2 }}>
            Row flags anchor a statement to the top or bottom of the grid — anchored rows
            are never moved by row randomization (Properties → Randomization → scope “rows”).
          </p>
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

      {(q.type === "numeric_list" || q.type === "text_list" || q.type === "repeating_group") && (
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

      {q.options.some((o) => o.flags?.includes("other_specify")) && (
        <label className="row" style={{ gap: 8, fontSize: 12.5 }} data-testid="other-specify-required">
          <input type="checkbox"
            checked={!q.settings.otherSpecifyOptional}
            onChange={(e) => patchSettings({ otherSpecifyOptional: e.target.checked ? undefined : true })} />
          <span>
            Require the “Other” text —{" "}
            <span className="muted">respondents who pick Other cannot continue until they say what it is</span>
          </span>
        </label>
      )}

      {(q.type === "multi_select" || q.type === "multi_dropdown" || q.type === "image_select" || q.type === "ranking") && has("min_max_selections") && (
        <div className="row">
          <label className="f"><span>Min selections</span>
            <CountInput data-testid="min-selections" value={q.settings.minSelections}
              onChange={(v) => patchSettings({ minSelections: v })} /></label>
          <label className="f"><span>Max selections</span>
            <CountInput data-testid="max-selections" value={q.settings.maxSelections}
              onChange={(v) => patchSettings({ maxSelections: v })} /></label>
          {q.settings.minSelections != null && q.settings.maxSelections != null
            && q.settings.minSelections > q.settings.maxSelections && (
            <span className="chip warn" data-testid="selections-inverted">min is above max — nothing can satisfy both</span>
          )}
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
              <CountInput value={q.settings.minSelections}
                onChange={(v) => patchSettings({ minSelections: v })} /></label>
            <label className="f"><span>Max points</span>
              <CountInput min={1} allowEmpty={false} value={q.settings.maxSelections ?? 1}
                onChange={(v) => patchSettings({ maxSelections: v ?? 1 })} /></label>
          </div>
          {q.settings.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={q.settings.imageUrl} alt="stimulus preview" style={{ maxWidth: 320, borderRadius: 8, border: "1px solid var(--border)" }} />
          )}
        </>
      )}

      {(q.type === "conjoint_task" || q.type === "maxdiff_task") && (
        <>
          <label className="f"><span>Design file</span>
            <select className="select" value={q.settings.designRef ?? ""}
              data-testid="design-ref"
              onChange={(e) => patchSettings({ designRef: e.target.value || undefined })}>
              <option value="">— pick a generated design —</option>
              {s.def.designs.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.kind} v{d.version})</option>)}
            </select></label>
          {s.def.designs.length === 0 && (
            <div className="chip warn" data-testid="no-designs" style={{ marginTop: -6 }}>
              No designs yet — generate one in{" "}
              <button className="btn small" style={{ marginLeft: 4 }}
                onClick={() => s.goToTab?.("designs")}>Design Generators →</button>
              {" "}then come back and pick it here.
            </div>
          )}
        </>
      )}

      <VariantSettings q={q} v={variantDef} patch={patch} patchSettings={patchSettings} />

      {q.type === "html" && (
        <label className="f"><span>HTML content</span>
          <textarea className="ta code" value={q.customHtml ?? ""}
            onChange={(e) => patch({ customHtml: e.target.value || undefined })} /></label>
      )}
    </div>
  );
}

/**
 * Esc closes the open question. Listens on the document because the card is
 * not focusable, so a keypress lands on the body — but yields to anything
 * modal (the variant picker, a menu, a dialog), which owns Esc while open.
 */
function EscapeCloses({ onClose }: { onClose: () => void }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[role="dialog"], .modal, .menu, .picker, [data-modal]')) return;
      if (document.querySelector('[role="dialog"], .modal-back, .menu-scrim')) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return null;
}

// `parsePastedOptions` now lives in the engine (optionsPaste.ts) beside the
// replace/append planner; re-exported so existing imports keep working.
export { parsePastedOptions };

/**
 * The subtle bar between questions.
 *
 * A page break is offered here, but only where it would do something: at the
 * start or end of a page there is nothing to split off. It stays visually
 * quieter than "+ Question" because it is structure, not content — and it does
 * NOT create a block. The block-level split lives on the block header.
 */
function InsertBar({
  onQuestion, onPick, onPageBreak,
}: { onQuestion(): void; onPick(): void; onPageBreak?(): void }) {
  return (
    <div className="insert-bar">
      <span className="insert-line" />
      <button className="btn small" onClick={onQuestion} title="Add a question here">
        + Question
      </button>
      <button className="btn small" onClick={onPick} title="Pick a question type from the full library">▾ type…</button>
      {onPageBreak && (
        <button className="btn small ghost" data-testid="add-page-break" onClick={onPageBreak}
          title="Start a new respondent page here — the block stays one block">
          ⎯ Page break
        </button>
      )}
      <span className="insert-line" />
    </div>
  );
}

export function QuestionsPanel() {
  const s = useStudio();
  const [pickerAt, setPickerAt] = React.useState<{ pageId: string; pos: number } | null>(null);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [menuFor, setMenuFor] = React.useState<string | null>(null);
  const { previewBlock, modal: previewBlockModal } = usePreviewBlock();
  const [moveFor, setMoveFor] = React.useState<string | null>(null);
  const selected = s.def.questions.find((q) => q.id === s.selectedQuestionId);
  const pages = listPages(s.def.flow as any[]);
  const blocks = listBlocks(s.def.flow as any[]);
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

  /** Insert a question in a block at position pos (after pos-1). */
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
      const last = listPages(d.flow as any[]).pop();
      last?.node.questionIds.push(q.id);
    });
    focusQuestion(q.id);
    if (variant) s.toast(`Added ${variant.familyLabel} → ${variant.name}`);
  };

  /* ------------------------------------------------------------- blocks */

  /**
   * A Block is a page node. The schema is unchanged — this is a change of
   * mental model, not of data: "Block" is what a page has always been, and
   * calling it one stops page breaks looking like questions.
   */
  const addBlock = () => {
    const id = uid("page");
    s.update((d) => {
      const all = listPages(d.flow as any[]);
      const node = { type: "page", id, title: undefined, questionIds: [] };
      if (all.length === 0) (d.flow as any[]).unshift(node);
      else {
        const last = all[all.length - 1];
        last.parent.splice(last.parent.indexOf(last.node) + 1, 0, node);
      }
    });
    s.toast("Block added");
  };

  /** The same block, resolved inside a draft definition. */
  const blockIn = (d: any, blockId: string) =>
    listBlocks(d.flow as any[]).find((b) => b.id === blockId);

  const renameBlock = (blockId: string, title: string) =>
    s.update((d) => {
      const b = blockIn(d, blockId);
      if (b) b.node.title = title || undefined;
    });
  const [mediaFor, setMediaFor] = React.useState<string | null>(null);
  const setBlockMedia = (blockId: string, url: string | undefined) =>
    s.update((d) => {
      const b = blockIn(d, blockId);
      if (b) (b.node as any).mediaUrl = url || undefined;
    });

  /**
   * Whether respondents see this block's name. Three states: inherit the
   * survey default (unset), always show, always hide. The Studio shows the
   * name regardless — it is the programmer's label first.
   */
  const setBlockShowTitle = (blockId: string, v: boolean | undefined) =>
    s.update((d) => {
      const b = blockIn(d, blockId);
      if (!b) return;
      if (v === undefined) delete (b.node as any).showTitle;
      else (b.node as any).showTitle = v;
    });
  const surveyShowsTitles = s.def.branding?.layout?.showBlockTitles ?? true;
  const blockShowsTitle = (b: BlockRef) =>
    ((b.node as any).showTitle as boolean | undefined) ?? surveyShowsTitles;

  /** An optional heading for one page of a multi-page block. */
  const renamePage = (blockId: string, pageIdx: number, title: string) =>
    s.update((d) => {
      const p = blockIn(d, blockId)?.pages[pageIdx];
      if (p) (p.node as any).title = title || undefined;
    });

  const deleteBlock = (blockId: string) => {
    const b = blocks.find((x) => x.id === blockId);
    if (!b) return;
    const qids = b.pages.flatMap((p) => p.node.questionIds);
    const n = qids.length;
    if (n > 0 && !confirm(
      `Delete this block and its ${n} question${n === 1 ? "" : "s"}? Logic referring to them will need updating.`,
    )) return;
    s.update((d) => {
      const hit = blockIn(d, blockId);
      if (!hit) return;
      const ids = new Set(hit.pages.flatMap((p) => p.node.questionIds));
      d.questions = d.questions.filter((q) => !ids.has(q.id));
      hit.parent.splice(hit.parent.indexOf(hit.node), 1);
    });
    if (s.selectedQuestionId && qids.includes(s.selectedQuestionId)) s.select(null);
  };

  /**
   * Copy a block and every question in it, ids and codes freshly minted.
   * Page breaks are part of the block, so the copy keeps its pagination.
   */
  const duplicateBlock = (blockId: string) =>
    s.update((d) => {
      const hit = blockIn(d, blockId);
      if (!hit) return;
      const copyPage = (page: any) => {
        const newIds: string[] = [];
        for (const qid of page.questionIds) {
          const q = d.questions.find((x: any) => x.id === qid);
          if (!q) continue;
          const copy = structuredClone(q);
          copy.id = uid("q");
          copy.code = `${q.code}_COPY`;
          copy.variableName = `${q.variableName}_COPY`;
          d.questions.push(copy);
          newIds.push(copy.id);
        }
        const out: any = { type: "page", id: uid("page"), questionIds: newIds };
        if (page.title) out.title = page.title;
        return out;
      };
      const copies = hit.pages.map((p) => copyPage(p.node));
      const title = hit.title ? `${hit.title} (copy)` : undefined;
      const node = copies.length === 1
        ? { ...copies[0], ...(title ? { title } : {}) }
        : { type: "block", id: uid("block"), ...(title ? { title } : {}), children: copies };
      hit.parent.splice(hit.parent.indexOf(hit.node) + 1, 0, node);
    });

  const moveBlock = (blockId: string, dir: -1 | 1) =>
    s.update((d) => {
      const all = listBlocks(d.flow as any[]);
      const i = all.findIndex((x) => x.id === blockId);
      const target = all[i + dir];
      if (i < 0 || !target || target.parent !== all[i].parent) return; // siblings only
      const arr = all[i].parent;
      const a = arr.indexOf(all[i].node);
      const b = arr.indexOf(target.node);
      [arr[a], arr[b]] = [arr[b], arr[a]];
    });

  /* -------------------------------------------------------- page breaks */

  /**
   * Split one page of a block in two at `pos`. The block does not change:
   * it gains a page, so the respondent gets an extra page inside it.
   */
  const addPageBreak = (pageId: string, pos: number) => {
    s.update((d) => {
      for (const b of listBlocks(d.flow as any[])) {
        const page = b.pages.find((p) => p.node.id === pageId)?.node as any;
        if (!page) continue;
        if (pos <= 0 || pos >= page.questionIds.length) return; // nothing to split
        const rest = page.questionIds.slice(pos);
        page.questionIds = page.questionIds.slice(0, pos);
        const newPage = { type: "page", id: uid("page"), questionIds: rest };
        const blockNode = wrapBlock(b);
        const kids: any[] = blockNode.children;
        kids.splice(kids.indexOf(page) + 1, 0, newPage);
        return;
      }
    });
    s.toast("Page break added — same block, new respondent page");
  };

  /** Remove the break between page i and page i+1: the two pages become one. */
  const removePageBreak = (blockId: string, i: number) =>
    s.update((d) => {
      const b = blockIn(d, blockId);
      if (!b || !b.wrapped || i < 0 || i + 1 >= b.pages.length) return;
      const kids: any[] = b.node.children;
      const first = b.pages[i].node as any;
      const second = b.pages[i + 1].node as any;
      first.questionIds.push(...second.questionIds);
      kids.splice(kids.indexOf(second), 1);
      unwrapIfSingle(b);
    });

  /** Nudge a break past one question, in either direction. */
  const movePageBreak = (blockId: string, i: number, dir: -1 | 1) =>
    s.update((d) => {
      const b = blockIn(d, blockId);
      if (!b || i < 0 || i + 1 >= b.pages.length) return;
      const before = b.pages[i].node as any;
      const after = b.pages[i + 1].node as any;
      if (dir === -1) {
        if (before.questionIds.length <= 1) return; // never leave a page empty
        after.questionIds.unshift(before.questionIds.pop());
      } else {
        if (after.questionIds.length <= 1) return;
        before.questionIds.push(after.questionIds.shift());
      }
    });

  /** Promote everything after a break into a block of its own. */
  const splitBlockAtBreak = (blockId: string, i: number) => {
    s.update((d) => {
      const b = blockIn(d, blockId);
      if (!b || !b.wrapped || i + 1 >= b.pages.length) return;
      const kids: any[] = b.node.children;
      const tail = b.pages.slice(i + 1).map((p) => p.node as any);
      for (const p of tail) kids.splice(kids.indexOf(p), 1);
      const node = tail.length === 1
        ? tail[0]
        : { type: "block", id: uid("block"), children: tail };
      b.parent.splice(b.parent.indexOf(b.node) + 1, 0, node);
      unwrapIfSingle(b);
    });
    s.toast("New block started");
  };

  /** Split a single-page block into two blocks after position pos. */
  const splitBlock = (pageId: string, pos: number) => {
    s.update((d) => {
      for (const pg of listPages(d.flow as any[])) {
        if (pg.node.id !== pageId) continue;
        const moved = pg.node.questionIds.slice(pos);
        pg.node.questionIds = pg.node.questionIds.slice(0, pos);
        pg.parent.splice(pg.index + 1, 0, { type: "page", id: uid("page"), questionIds: moved });
        return;
      }
    });
    s.toast("Block split");
  };

  /** Merge a block into the one above it, keeping both blocks' page breaks. */
  const mergeUp = (blockId: string) =>
    s.update((d) => {
      const all = listBlocks(d.flow as any[]);
      const i = all.findIndex((b) => b.id === blockId);
      if (i <= 0) return;
      const cur = all[i];
      const prev = all[i - 1];
      if (prev.parent !== cur.parent) return;
      const curPages = cur.pages.map((p) => p.node as any);
      if (curPages.length === 1 && prev.pages.length === 1) {
        // the simple case stays simple: one page absorbs the other
        (prev.pages[0].node as any).questionIds.push(...curPages[0].questionIds);
      } else {
        const target = wrapBlock(prev);
        for (const p of curPages) target.children.push(p);
      }
      cur.parent.splice(cur.parent.indexOf(cur.node), 1);
    });

  /** Move a question into another block, appended to its last page. */
  const moveQuestionToBlock = (qid: string, blockId: string) =>
    s.update((d) => {
      for (const pg of listPages(d.flow as any[])) {
        const k = pg.node.questionIds.indexOf(qid);
        if (k >= 0) pg.node.questionIds.splice(k, 1);
      }
      const target = blockIn(d, blockId);
      const last = target?.pages[target.pages.length - 1];
      (last?.node as any)?.questionIds.push(qid);
    });

  /** Reorder within a block; crossing the edge moves to the adjacent block. */
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

  const card = (
    qid: string,
    pageId: string,
    blockId: string,
    indexInPage: number,
    pageSize: number,
    canSplit: boolean,
  ) => {
    const q = s.def.questions.find((x) => x.id === qid);
    if (!q) return null;
    const isSelected = q.id === s.selectedQuestionId;
    /*
     * Closing an open question was reported as impossible: clicking the card
     * re-selected it, so it never collapsed, and the only × on the row is
     * Delete — a tester looking for "close" finds the one button that destroys
     * the question. Now: the header toggles, Done closes, Esc closes, and the
     * block head has its own Close. Delete stays last and stays red.
     */
    const close = () => s.select(null);
    return (
      <div key={q.id}
        className={`card selectable qcard ${isSelected ? "selected" : ""}`}
        data-testid="qcard"
        onClick={() => s.select(isSelected ? null : q.id)}>
        {isSelected && <EscapeCloses onClose={close} />}
        <div className="qlist-item">
          <strong className="mono">{q.code}</strong>
          <span className="qtype-badge">{q.variant?.split(".")[1] ?? q.type}</span>
          <span className="grow qcard-text"
            dangerouslySetInnerHTML={{ __html: q.text || '<span class="muted">untitled</span>' }} />
          {q.displayLogic && <span className="chip warn" title="has display logic">DL</span>}
          {q.skipLogic.length > 0 && <span className="chip warn" title="has skip logic">SL</span>}
          {q.carryForward && <span className="chip" title="carry-forward">CF</span>}
          <button className="btn small" title="Move up" onClick={(e) => { e.stopPropagation(); move(q.id, -1); }}>↑</button>
          <button className="btn small" title="Move down" onClick={(e) => { e.stopPropagation(); move(q.id, 1); }}>↓</button>
          <button className="btn small" title="Duplicate" onClick={(e) => { e.stopPropagation(); duplicate(q.id); }}>⧉</button>
          {blocks.length > 1 && (
            <button className="btn small" data-testid="move-question-btn"
              title="Move this question to another block and position"
              onClick={(e) => { e.stopPropagation(); setMoveFor(q.id); }}>move…</button>
          )}
          {canSplit && indexInPage > 0 && indexInPage < pageSize && (
            <button className="btn small" title="Start a new block here"
              onClick={(e) => { e.stopPropagation(); splitBlock(pageId, indexInPage); }}>⤵</button>
          )}
          {isSelected && (
            <button className="btn small primary" data-testid="close-question"
              title="Done editing — close this question (Esc)"
              onClick={(e) => { e.stopPropagation(); close(); }}>Done</button>
          )}
          <button className="btn small danger" title="Delete this question" onClick={(e) => { e.stopPropagation(); remove(q.id); }}>×</button>
        </div>
        {isSelected && selected && (
          <div style={{ marginTop: 14 }} onClick={(e) => e.stopPropagation()}>
            <QuestionEditor q={selected} />
            <div className="row qcard-foot">
              <span className="muted" style={{ fontSize: 11 }}>Changes save automatically.</span>
              <span className="grow" />
              <button className="btn primary" data-testid="close-question-bottom"
                title="Done editing — close this question (Esc)"
                onClick={close}>Done</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Questions</h2>
        <span className="chip">{s.def.questions.length} question{s.def.questions.length === 1 ? "" : "s"}</span>
        <span className="chip">{blocks.length} block{blocks.length === 1 ? "" : "s"}</span>
        <span className="grow" />
        <button className="btn" onClick={addBlock} data-testid="add-block">+ Add block</button>
        <button className="btn primary" data-testid="add-question-top" onClick={() => {
          const last = blocks[blocks.length - 1]?.pages.slice(-1)[0];
          setPickerAt(last ? { pageId: last.node.id, pos: last.node.questionIds.length } : { pageId: "", pos: 0 });
        }}>+ Add question</button>
        {pickerAt && (
          <VariantPickerModal
            onPick={(v) => { insertQuestion(pickerAt.pageId, pickerAt.pos, v); setPickerAt(null); }}
            onClose={() => setPickerAt(null)} />
        )}
      </div>

      {blocks.map((b, pi) => {
        const isCollapsed = collapsed[b.id];
        const n = b.pages.reduce((t, p) => t + p.node.questionIds.length, 0);
        const multi = b.pages.length > 1;
        return (
        <div key={b.id} className={`block ${isCollapsed ? "collapsed" : ""}`} data-testid="block">
          <div className="block-head">
            <button className="block-toggle" title={isCollapsed ? "Expand block" : "Collapse block"}
              onClick={() => setCollapsed((c) => ({ ...c, [b.id]: !c[b.id] }))}>
              {isCollapsed ? "▸" : "▾"}
            </button>
            <span className="block-badge">BLOCK {pi + 1}</span>
            <input className="input block-title" placeholder="Name this block — e.g. Introduction"
              data-testid="block-title"
              value={b.title ?? ""}
              onChange={(e) => renameBlock(b.id, e.target.value)} />
            <span className="muted block-count">
              {n} question{n === 1 ? "" : "s"}
              {multi && ` · ${b.pages.length} pages`}
            </span>
            {b.title && !blockShowsTitle(b) && (
              <span className="chip" data-testid="block-title-hidden"
                title="Respondents will not see this block's name — change it in the ••• menu">name hidden</span>
            )}
            <button className="btn small" data-testid="block-preview"
              title="Open the real runtime starting at this block — with the latest saved state"
              onClick={() => previewBlock(b.id, b.title || `Block ${pi + 1}`)}>▶ Preview block</button>
            {!isCollapsed && (
              <button className="btn small" data-testid="block-close"
                title="Close this block — collapses it and closes any open question inside"
                onClick={() => {
                  const inside = b.pages.some((p) => p.node.questionIds.includes(s.selectedQuestionId ?? ""));
                  if (inside) s.select(null);
                  setCollapsed((c) => ({ ...c, [b.id]: true }));
                }}>Close</button>
            )}
            <div className="menu-anchor">
              <button className="btn small" data-testid="block-menu"
                onClick={() => setMenuFor(menuFor === b.id ? null : b.id)}>•••</button>
              {menuFor === b.id && (
                <>
                  <div className="menu-scrim" onClick={() => setMenuFor(null)} />
                  <div className="menu" role="menu">
                    <button className="menu-item" disabled={pi === 0}
                      onClick={() => { setMenuFor(null); moveBlock(b.id, -1); }}>↑ Move block up</button>
                    <button className="menu-item" disabled={pi === blocks.length - 1}
                      onClick={() => { setMenuFor(null); moveBlock(b.id, 1); }}>↓ Move block down</button>
                    <button className="menu-item"
                      onClick={() => { setMenuFor(null); duplicateBlock(b.id); }}>⧉ Duplicate block</button>
                    <div className="menu-sep" />
                    <div className="menu-label">Block name for respondents</div>
                    {([
                      [undefined, `Survey default (${surveyShowsTitles ? "shown" : "hidden"})`],
                      [true, "Always shown"],
                      [false, "Always hidden"],
                    ] as [boolean | undefined, string][]).map(([v, label]) => {
                      const cur = (b.node as any).showTitle as boolean | undefined;
                      return (
                        <button key={String(v)} className="menu-item" role="menuitemradio"
                          aria-checked={cur === v}
                          data-testid={`block-title-${v === undefined ? "inherit" : v ? "show" : "hide"}`}
                          onClick={() => { setMenuFor(null); setBlockShowTitle(b.id, v); }}>
                          {cur === v ? "● " : "○ "}{label}
                        </button>
                      );
                    })}
                    {pi > 0 && blocks[pi - 1].parent === b.parent && (
                      <button className="menu-item"
                        onClick={() => { setMenuFor(null); mergeUp(b.id); }}>⇧ Merge into block above</button>
                    )}
                    <div className="menu-sep" />
                    <button className="menu-item" data-testid="block-media-toggle"
                      onClick={() => { setMenuFor(null); setMediaFor(mediaFor === b.id ? null : b.id); }}>
                      🖼 {(b.node as any).mediaUrl ? "Edit block media" : "Add block media (image / video / URL)"}
                    </button>
                    <div className="menu-sep" />
                    <button className="menu-item danger"
                      onClick={() => { setMenuFor(null); deleteBlock(b.id); }}>Delete block…</button>
                  </div>
                </>
              )}
            </div>
          </div>

          {(mediaFor === b.id || (!isCollapsed && (b.node as any).mediaUrl)) && (
            <div className="block-media-row" data-testid="block-media-row" style={{ padding: "6px 12px 2px" }}>
              <MediaUrlInput compact testId="block-media" label="Block media — shown under the block name"
                value={(b.node as any).mediaUrl}
                onChange={(v) => setBlockMedia(b.id, v)} />
            </div>
          )}
          {!isCollapsed && (
            <div className="block-body">
              {n === 0 && (
                <>
                  <div className="block-empty">This block has no questions yet.</div>
                  {/* the same control as between questions, so adding the first
                      one and adding the tenth look and behave identically */}
                  <InsertBar
                    onQuestion={() => insertQuestion(b.pages[0].node.id, 0)}
                    onPick={() => setPickerAt({ pageId: b.pages[0].node.id, pos: 0 })} />
                </>
              )}
              {b.pages.map((pg, pgi) => {
                const ids: string[] = pg.node.questionIds;
                return (
                <React.Fragment key={pg.node.id}>
                  {/* a page break, drawn as the boundary it is */}
                  {pgi > 0 && (
                    <div className="page-break" data-testid="page-break">
                      <span className="pb-line" />
                      <span className="pb-label">PAGE BREAK</span>
                      <button className="btn small" title="Move the break up one question"
                        onClick={() => movePageBreak(b.id, pgi - 1, -1)}>↑</button>
                      <button className="btn small" title="Move the break down one question"
                        onClick={() => movePageBreak(b.id, pgi - 1, 1)}>↓</button>
                      <button className="btn small" data-testid="break-to-block"
                        title="Make this page and everything below it a separate block"
                        onClick={() => splitBlockAtBreak(b.id, pgi - 1)}>split block</button>
                      <button className="btn small danger" data-testid="remove-page-break"
                        title="Remove this break — the two pages become one"
                        onClick={() => removePageBreak(b.id, pgi - 1)}>×</button>
                      <span className="pb-line" />
                    </div>
                  )}
                  {multi && (
                    <div className="page-row">
                      <span className="page-badge" data-testid="page-badge">PAGE {pgi + 1}</span>
                      <input className="input page-title" placeholder="Page heading (optional)"
                        value={pg.node.title ?? ""}
                        onChange={(e) => renamePage(b.id, pgi, e.target.value)} />
                      <span className="muted" style={{ fontSize: 11 }}>
                        {ids.length} question{ids.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  )}
                  {ids.map((qid, k) => (
                    <React.Fragment key={qid}>
                      {card(qid, pg.node.id, b.id, k, ids.length, !multi)}
                      <InsertBar
                        onQuestion={() => insertQuestion(pg.node.id, k + 1)}
                        onPick={() => setPickerAt({ pageId: pg.node.id, pos: k + 1 })}
                        onPageBreak={k + 1 < ids.length
                          ? () => addPageBreak(pg.node.id, k + 1)
                          : undefined} />
                    </React.Fragment>
                  ))}
                </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
        );
      })}

      <button className="btn add-block-btn" onClick={addBlock}>+ Add block</button>

      {unplaced.length > 0 && (
        <div className="block warn-block">
          <div className="block-head">
            <span className="block-badge" style={{ background: "var(--amber)" }}>NOT IN ANY BLOCK</span>
            <span className="muted" style={{ fontSize: 11 }}>
              these never display — move them into a block
            </span>
          </div>
          <div className="block-body">
            {unplaced.map((q) => (
              <div key={q.id} className="row" style={{ gap: 6, alignItems: "stretch" }}>
                <div style={{ flex: 1 }}>{card(q.id, "", "", 0, 0, false)}</div>
                {blocks.length > 0 && (
                  <select className="select" style={{ width: 150, alignSelf: "center" }}
                    value="" onChange={(e) => { if (e.target.value) moveQuestionToBlock(q.id, e.target.value); }}>
                    <option value="">move into…</option>
                    {blocks.map((b, i) => (
                      <option key={b.id} value={b.id}>
                        Block {i + 1}{b.title ? ` — ${b.title}` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {moveFor && <MoveQuestionModal qid={moveFor} onClose={() => setMoveFor(null)} />}
      {previewBlockModal}

      {s.def.questions.length === 0 && blocks.length === 0 && (
        <p className="muted">Start by adding a block, then put questions inside it.</p>
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
