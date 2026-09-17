"use client";
import { OptionalCondition } from "./ConditionBuilder";
import { optionMetaFields, VariantSettings, type MetaField } from "./variantConfig";
import { CountInput } from "./CountInput";
import React from "react";
import type { Question, Option, QuestionColumn, ResponseType, QuestionVariantDef } from "@rescript/schema";
import { questionTypeRegistry, variantRegistry, resolveVariant } from "@rescript/schema";
import { honoursColumns, drawsOptionImages, honoursOrientation } from "@rescript/renderer";
import { VariantPickerModal, VariantSwitcher, createFromVariant } from "./VariantPicker";
import { RichTextEditor } from "./RichTextEditor";
import { OptionLogicEditor } from "./OptionLogicEditor";
import { OptionPreview } from "./OptionPreview";
import { usePreviewBlock } from "./PreviewBlock";
import { MediaUrlInput } from "./MediaUrlInput";
import { AttentionCheckEditor } from "./AttentionCheckEditor";
import { DeleteQuestionDialog } from "./DeleteQuestionDialog";
import { Icon } from "../ui/Icon";
import { useCanvas } from "../canvas/CanvasContext";
import { LiveView } from "../canvas/LiveView";

/**
 * BLOCK COMMANDS — one identifier per action, on the button that performs it.
 *
 * The five block actions were already five separate closures calling five
 * different mutations; there was no shared callback and no string-dispatch to
 * collide in. What there was no way to do was TELL THEM APART from outside:
 * "+ Add block" appeared twice with one `data-testid` between the two,
 * "split block" and "⤵" both split but only one was addressable, and
 * "📋 paste options" — which belongs to the option list, not to blocks — sits
 * a few pixels from "+ option" and is instantiated once per matrix column, so
 * an unscoped `[data-testid="toggle-paste"]` hits whichever mounted first.
 *
 * A stable `data-command` on each control means a test, a keyboard map or a
 * future integration names the action it wants rather than a position or a
 * label, and a regression that swaps two handlers becomes a failing assertion
 * instead of a bug report six weeks later.
 *
 * PASTE IS DELIBERATELY IN THIS LIST even though it is not a block action, so
 * that "paste is not a block command" is written down somewhere a reader will
 * find it.
 */
export const BLOCK_COMMANDS = {
  ADD_BLOCK: "add-block",
  SPLIT_BLOCK: "split-block",
  SPLIT_BLOCK_AT_BREAK: "split-block-at-break",
  DUPLICATE_BLOCK: "duplicate-block",
  DELETE_BLOCK: "delete-block",
  MERGE_BLOCK_UP: "merge-block-up",
  ADD_PAGE_BREAK: "add-page-break",
  REMOVE_PAGE_BREAK: "remove-page-break",
  /** the option list's paste box — NOT a block action, and never was */
  PASTE_OPTIONS: "paste-options",
} as const;

/** Variants whose stimulus IS `settings.mediaUrl` (their own settings edit it). */
const MEDIA_OWNING = new Set(["videorating", "videotimeline", "watchtime", "audiorec", "base:media_timeline"]);
import { InsertPipingButton } from "./PipingPicker";
import {
  FIELD_TYPES, nextCode, nextQuestionNaming, resequenceQuestionCodes,
  parsePastedOptions, planPaste, optionsToPaste, type PasteMode,
  stripHtmlText, referencesTo, pruneReferencesTo, referencesToMany, pruneReferencesToMany,
  PIPE_TOKEN_RE,
  effectiveScale,
  PHONE_FORMATS,
  POSTAL_FORMATS,
  CURRENCIES,
  type QuestionReference,
} from "@rescript/engine"; // also registers builtin question types
import { isEmptyOptionLogic } from "@rescript/schema";
import { useStudio, uid } from "./store";
import {
  type PageRef, type BlockRef, listPages, listBlocks, wrapBlock, unwrapIfSingle, newBlockNode,
} from "./blockModel";
import { MoveQuestionModal } from "./MoveQuestion";

const RESPONSE_TYPES: ResponseType[] = [
  "single", "multi", "dropdown", "multi_dropdown", "text", "longtext",
  "numeric", "date", "time", "slider", "checkbox",
];

/*
 * "None of above", "don't know" and "refused" used to be here. All three did
 * exactly what "exclusive" does — `isExclusiveOption` never distinguished
 * them — so the editor was offering four names for one behaviour, which the
 * September review reported. They fold into `exclusive` on parse now
 * (schema `normalizeOptionFlags`), so an existing option keeps working and
 * the picker stops promising a difference that was never there.
 */
const ALL_FLAGS: { value: string; label: string }[] = [
  { value: "exclusive", label: "exclusive" },
  { value: "other_specify", label: "other/specify" },
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
  if (qtype === "matrix_multi") return [...base, "exclusive"];
  return base;
}

const OPTION_WINDOW = 40;

/** Text questions whose answer is one box, so `settings.placeholder` applies. */
const SCALAR_TEXT_TYPES = ["open_text", "long_text"];

function OptionRows({ options, onChange, showFlags = true, flagChoices, showImage = false, metaFields = [],
  enableLogic = false, questionId, onAfterDelete }: {
  options: Option[]; onChange(opts: Option[]): void; showFlags?: boolean;
  flagChoices?: string[]; showImage?: boolean; metaFields?: MetaField[];
  /** per-option logic + piping controls (reqs §1–4, §21) */
  enableLogic?: boolean; questionId?: string;
  /** called after a removal so the owner can re-sequence codes */
  onAfterDelete?(): void;
}) {
  /*
   * Codes go read-only once the survey has live responses. The canvas
   * surface froze them from the start; this panel — the one programmers
   * actually use — never did, so the guard existed and was unreachable.
   */
  const frozen = useStudio().codesFrozen;
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
    /*
     * A MINTED id, not a derived one (§43). An element created here gets an id
     * that was never a function of its code or its position, so renaming or
     * renumbering it later cannot move it. `ensureElementIds` only derives ids
     * for elements that predate this — it never overwrites one that exists.
     */
    next.splice(i + 1, 0, { id: uid("opt"), code: nextCode(options), label: "", flags: [] } as Option);
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
    next.splice(i + 1, 0, ...(parsed.slice(1).map((o) => ({ ...o, id: uid("opt") })) as Option[]));
    pendingFocus.current = i + parsed.length - 1;
    setShowAll(true); // the pasted rows must be mounted for focus to land
    onChange(next);
  };

  /*
   * The paste box builds a whole new option list. Options it CARRIED OVER keep
   * their ids (planPaste preserves the objects it matched); options it created
   * have none, so they are minted here rather than left to be derived from a
   * code later.
   */
  const importPaste = () => {
    if (parsePastedOptions(pasteText, 1).length === 0) return;
    onChange(pastePlan.options.map((o) => (o.id ? o : { ...o, id: uid("opt") })));
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
          <span className="muted" style={{ fontSize: 12.5 }}>
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
          <input className="input code-input" value={String(o.code)} data-testid="option-code"
            disabled={frozen}
            onChange={(e) => set(i, { code: e.target.value })}
            title={frozen
              ? "Codes are frozen once this survey has live responses — moving a code would rewrite what a respondent said"
              : "code"} />
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
            <div className="opt-meta" style={{ width: 200, maxWidth: 200 }}>
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
                <label key={mf.key} className="row" style={{ gap: 4, fontSize: 12.5 }} title={mf.label}>
                  <input type="checkbox" checked={!!cur} data-testid={`option-meta-${mf.key}-${i}`}
                    onChange={(e) => setMeta(e.target.checked)} />
                  {mf.label}
                </label>
              );
            }
            return (
              <input key={mf.key} className="input opt-meta"
                /* `maxWidth`, not `width`: these were fixed pixels that could
                   not give, so on a product option 520px of them squeezed the
                   label — the field the option is actually about — down to
                   nothing. They shrink first now. */
                style={{ width: mf.width ?? 120, maxWidth: mf.width ?? 120 }}
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
          {/* one group, pinned to the end of the row — these were the buttons
              the review's screenshot showed cut in half by the panel edge */}
          <span className="opt-actions">
            <button className="btn small" onClick={() => move(i, -1)}>↑</button>
            <button className="btn small" onClick={() => move(i, 1)}>↓</button>
            <button className="btn small danger"
              onClick={() => { onChange(options.filter((_, j) => j !== i)); onAfterDelete?.(); }}>×</button>
          </span>
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
          + option <span className="muted" style={{ fontSize: 11.5 }}>(or press Enter)</span>
        </button>
        <button className="btn small" data-testid="toggle-paste" data-command={BLOCK_COMMANDS.PASTE_OPTIONS} onClick={openPaste}>
          {pasteOpen ? "hide paste box" : "📋 paste options"}
        </button>
      </div>
      {pasteOpen && (
        <div className="paste-box" data-testid="paste-panel">
          <div className="row" style={{ alignItems: "center", gap: 10 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>On import:</span>
            <label className="row" style={{ gap: 4, fontSize: 13 }}>
              <input type="radio" name={`paste-mode-${questionId ?? "x"}`} data-testid="paste-mode-replace"
                checked={pasteMode === "replace"} onChange={() => setPasteMode("replace")} />
              Replace the list
            </label>
            <label className="row" style={{ gap: 4, fontSize: 13 }}>
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
            <span className="muted" style={{ fontSize: 12.5 }} data-testid="paste-summary">
              {pasteMode === "replace"
                ? `keeps ${pastePlan.kept} · adds ${pastePlan.added} · removes ${pastePlan.removed}`
                : `adds ${pastePlan.added} after the existing ${options.length}`}
            </span>
          </div>
          {pasteMode === "replace" && pastePlan.removed > 0 && (
            <div className="muted" style={{ fontSize: 12.5, color: "var(--warn, #b45309)" }} data-testid="paste-removes">
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
            <label className="row" style={{ gap: 4, fontSize: 13 }}>
              <input type="checkbox" checked={c.readOnly}
                onChange={(e) => set(i, { readOnly: e.target.checked })} /> read-only
            </label>
            <label className="row" style={{ gap: 4, fontSize: 13 }}>
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
          readOnly: false, flags: [],
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
  /* a field row's code is its variable suffix — same freeze, same reason */
  const frozen = useStudio().codesFrozen;
  /*
   * WHAT THIS VARIANT'S FIELDS MAY BE.
   *
   * There is one field-type dropdown in the Studio and it offered all twelve
   * types to every list question, so a Numeric Range's From could be set to
   * Long Text or Email and the "+ field" button could turn a two-ended range
   * into a three-ended one. A variant may now say otherwise; one that says
   * nothing behaves exactly as before.
   */
  const fieldSpec = resolveVariant(q.variant)?.fields;
  const fieldTypes = fieldSpec?.types
    ? FIELD_TYPES.filter((t) => fieldSpec.types!.includes(t.value))
    : FIELD_TYPES;
  const fieldsFixed = !!fieldSpec?.fixed;
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
        <p className="muted" style={{ fontSize: 13 }}>
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
              <input className="input code-input" value={String(r.code)} data-testid="field-row-code"
                disabled={frozen}
                title={frozen
                  ? "Codes are frozen once this survey has live responses — moving a code would rewrite what a respondent said"
                  : "row code / variable suffix"}
                onChange={(e) => setRow(i, { code: e.target.value })} />
              <input className="input grow" placeholder="Field label, e.g. Email Address"
                value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} />
              <select className="select" style={{ width: 150 }} value={ft} data-testid={`field-type-${i}`}
                onChange={(e) => setRow(i, { fieldType: e.target.value as any })}>
                {/* an already-set type stays listed even if this variant would
                    not offer it, so a question authored earlier is never
                    silently re-typed by opening its editor */}
                {(fieldTypes.some((t) => t.value === ft) ? fieldTypes : [...fieldTypes, { value: ft as never, label: ft }])
                  .map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="row" style={{ gap: 4, fontSize: 13 }}>
                <input type="checkbox" checked={r.required ?? false} data-testid={`field-required-${i}`}
                  onChange={(e) => setRow(i, { required: e.target.checked })} /> required
              </label>
              <button className="btn small" onClick={() => move(i, -1)}>↑</button>
              <button className="btn small" onClick={() => move(i, 1)}>↓</button>
              {/* a from–to pair has two ends; removing one leaves a range that
                  is not one, so the control is not offered */}
              {!fieldsFixed && (
                <button className="btn small danger"
                  onClick={() => patch({ rows: rows.filter((_, j) => j !== i) })}>×</button>
              )}
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
              <label className="row" style={{ gap: 4, fontSize: 13 }}>
                {isNum ? "min value" : "min length"}
                <input className="input" style={{ width: 76 }} type="number"
                  value={String(getBound(r, boundMin))}
                  onChange={(e) => setBound(i, boundMin, e.target.value)} />
              </label>
              <label className="row" style={{ gap: 4, fontSize: 13 }}>
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
        {!fieldsFixed && (
        <button className="btn small" data-testid="add-field" onClick={() =>
          patch({
            rows: [...rows, {
              id: uid("row"),
              code: `f${rows.length + 1}`, label: `Field ${rows.length + 1}`, flags: [],
              fieldType: (fieldTypes[0]?.value ?? (q.type === "numeric_list" ? "number" : "text")),
              validation: [], required: false,
            } as any],
          })}>
          + field
        </button>
        )}
        {rows.length === 0 && (
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
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
  const mode = useCanvas()?.mode ?? "standard";
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
  /*
   * A control that cannot take effect is worse than a missing one: the
   * programmer believes they have made a setting. `has()` alone was not
   * enough for the Layout control on two counts — it answers `true` for any
   * question with no variant at all (so a legacy dropdown got the control),
   * and several variants declare `layout_columns` while their renderer never
   * reads it (Multi-Select Dropdown, Multi-Item Carousel). The renderer
   * package owns the list, because the renderer is what decides.
   */
  const showLayout = has("layout_columns") && honoursColumns(variantDef?.renderer, q.type);
  /* what this variant's scale may be, and what it will actually be drawn as */
  const scaleLimit = variantDef?.scale;
  const scaleShown = effectiveScale(q, { min: scaleLimit?.min ?? 0, max: scaleLimit?.max ?? 10 });
  const scaleOut = !!scaleLimit && scaleShown.clamped;
  /*
   * Which pair of end-label settings this question's renderer reads. The NPS
   * button row and the emoji row read `npsLeftLabel`/`npsRightLabel`; the
   * slider reads `sliderLeftLabel`/`sliderRightLabel`. Stars and hearts draw
   * no labels at all, so there is nothing to offer for them.
   */
  /** all-numeric codes that no longer ascend — a list that has been reordered */
  const outOfOrderCodes = React.useMemo(() => {
    const ns = q.options.map((o) => Number(o.code));
    if (ns.length < 2 || ns.some((n) => !Number.isFinite(n))) return false;
    return ns.some((n, i) => i > 0 && n < ns[i - 1]);
  }, [q.options]);
  /*
   * The points a scale actually has, for the per-point label editor. Taken
   * from the effective scale rather than the raw settings, so a range the
   * variant does not allow cannot produce labels for points nobody will see.
   */
  const scalePoints = React.useMemo(() => {
    if (q.type !== "nps" && variantDef?.renderer !== "emoji") return [] as number[];
    const { min, max } = scaleShown;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [] as number[];
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }, [q.type, variantDef?.renderer, scaleShown.min, scaleShown.max]);
  const pointLabelCount = Object.keys(q.settings.scalePointLabels ?? {}).length;
  /** does this question carry a validation rule of this kind? */
  const hasRule = (kind: string) => q.validation.some((r) => r.kind === kind);
  const scaleLabelKeys: readonly [string, string] | null =
    q.type === "nps" || variantDef?.renderer === "emoji"
      ? ["npsLeftLabel", "npsRightLabel"] as const
      : q.type === "slider"
        ? ["sliderLeftLabel", "sliderRightLabel"] as const
        : null;
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
    if (s.codesFrozen) return;
    s.update((d) => {
      const r = resequenceQuestionCodes(d, q.id, scope);
      if (Object.keys(r.mapping).length === 0) return;
      Object.assign(d, r.def);
      pendingResequenceNote.current = r.referencesUpdated;
    });
  };

  return (
    <div>
      {/* Two views of ONE question, inside the editor the programmer already
          has open. Switching changes what is drawn in this card and nothing
          else — no navigation, no reload, and no second copy of the question:
          both views mutate the same definition through the same store. */}
      <QuestionViewSwitch q={q} />
      {mode === "live" ? <LiveView q={q} /> : (
      <>
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
      {(q.options.length > 0 || q.type === "open_text" || q.type === "long_text" || q.type === "numeric") && (
        <AttentionCheckEditor q={q} patch={patch} />
      )}

      {feats.options && has("options") && (
        <>
          <h3 className="sec">Options</h3>
          <OptionRows options={q.options} onChange={(options) => patch({ options })}
            onAfterDelete={() => resequence("options")}
            flagChoices={allowedFlagsFor(q.type)} enableLogic questionId={q.id}
            /*
              * `drawsOptionImages` as well as the capability. The capability
              * says the question shape can carry an image; this says the
              * renderer will actually put one on screen. A card-sort question
              * declares `images` and draws its pictures from the ROWS, so the
              * editor was accepting an image URL on every bucket, ticking it
              * green, and showing nothing — which is the "image not displayed
              * in preview" the review filed.
              */
            showImage={has("images") && drawsOptionImages(variantDef?.renderer, q.type)}
            metaFields={optionMetaFields(variantDef)} />
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
            {showLayout && (
            /*
             * THE MOST-REPORTED BUG IN THE SEPTEMBER REVIEW, and it was this
             * control rather than any renderer. Picking "1 column" wrote
             * `undefined`, which every renderer reads as "the author has not
             * chosen" and answers with its own default — 2 for cards, 3 for
             * rich cards, 4 for icons, as-many-as-fit for image grids. So 2,
             * 3 and 4 worked and 1 did nothing, on eleven variants.
             *
             * "Not chosen" is now a value the control can show ("auto"), so 1
             * can be stored as 1 and mean it. Questions authored before this
             * still hold `undefined` and still render exactly as they did —
             * the fix changes what the editor can say, not what any existing
             * survey looks like.
             */
            <label className="f" style={{ marginBottom: 0, width: 175 }}><span>Layout</span>
              <select className="select" data-testid="layout-columns"
                value={q.settings.optionOrientation === "horizontal" ? "horizontal" : String(q.settings.columnsLayout ?? "")}
                onChange={(e) => {
                  /*
                   * ONE CONTROL, NOT TWO. The review asked for a
                   * Horizontal / Vertical choice on Radio and Button Select;
                   * that is the same question as "how many columns", so it
                   * lives in the same list. Choosing one clears the other,
                   * because "horizontal" and "3 columns" together is a
                   * contradiction the renderer would have to guess at — and a
                   * setting that is guessed at is the next report.
                   */
                  const v = e.target.value;
                  if (v === "horizontal") patchSettings({ optionOrientation: "horizontal", columnsLayout: undefined });
                  else patchSettings({ optionOrientation: undefined, columnsLayout: v === "" ? undefined : Number(v) });
                }}>
                <option value="">auto (fit width)</option>
                <option value={1}>1 column</option>
                <option value={2}>2 columns</option>
                <option value={3}>3 columns</option>
                <option value={4}>4 columns</option>
                {/* offered only where a row is a thing this renderer can draw */}
                {honoursOrientation(variantDef?.renderer, q.type) && <option value="horizontal">horizontal row</option>}
              </select></label>)}
            {/*
              * The search box stopped being a surprise. It used to appear on
              * its own past twenty-five options, which the review reported as
              * a feature arriving uninvited — "if search is not an intended
              * feature for these question types, it should not be
              * automatically added based only on the number of options".
              * "automatic" is still the default, so nothing already in field
              * moves.
              */}
            {has("options") && (
            <label className="f" style={{ marginBottom: 0, width: 190 }}><span>Search box</span>
              <select className="select" data-testid="option-search"
                value={q.settings.optionSearch ?? "auto"}
                onChange={(e) => patchSettings({ optionSearch: e.target.value === "auto" ? undefined : (e.target.value as "always" | "never") })}>
                <option value="auto">automatic (over 25 options)</option>
                <option value="always">always show</option>
                <option value="never">never show</option>
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
            {showLayout && q.options.length >= 10 && !q.settings.columnsLayout && (
              <button className="btn small" style={{ alignSelf: "flex-end", marginBottom: 7 }}
                title="A long single column is hard to scan"
                onClick={() => patchSettings({ columnsLayout: q.options.length >= 16 ? 4 : q.options.length >= 9 ? 3 : 2 })}>
                {q.options.length} options — use {q.options.length >= 16 ? 4 : 3} columns?
              </button>
            )}
            {/*
              * CODES OUT OF ORDER AFTER A REORDER.
              * Moving an option with ↑/↓ moves the row and keeps the code,
              * which is right — the code is the value that lands in the data
              * and is named by every condition, quota and pipe that points at
              * it, so renumbering silently would rewrite stored answers'
              * meaning. But the review saw a list running 1,2,3,4,5,7,…,12,6
              * and read it as a bug, because nothing said which of the two
              * was happening. Now it says, and offers the renumber as a
              * deliberate act — the same one a deletion already performs,
              * references and all, and frozen once responses exist.
              */}
            {!s.codesFrozen && outOfOrderCodes && (
              <button className="btn small" data-testid="resequence-options"
                style={{ alignSelf: "flex-end", marginBottom: 7 }}
                title="Codes keep their value when a row moves, because the code is what lands in the data. This renumbers them 1…N and repoints every reference."
                onClick={() => resequence("options")}>
                codes run out of order — renumber 1…{q.options.length}
              </button>
            )}
            <span className="muted" style={{ fontSize: 12.5, alignSelf: "flex-end", paddingBottom: 7 }}>
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
          <p className="muted" style={{ fontSize: 12.5, marginTop: -2 }}>
            Row flags anchor a statement to the top or bottom of the grid — anchored rows
            are never moved by row randomization (Properties → Randomization → scope “rows”).
          </p>
          {q.carryForward?.into === "rows" && (
            <p className="muted" style={{ fontSize: 13 }}>
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

      {/*
        * A SCALE THAT IS THE VARIANT'S DEFINITION HAS NO FIELDS TO EDIT.
        * An NPS that is not 0–10 is not an NPS, so the range is shown and
        * there is nothing to change. This is the review's "remove the Min and
        * Max input fields from the NPS settings" — removed for the variants
        * whose scale is a standard, kept and bounded for the ones where the
        * range is a real choice.
        */}
      {feats.numericBounds && scaleLimit?.fixed && (
        <p className="muted" style={{ fontSize: 13 }} data-testid="scale-fixed">
          Scale fixed at {scaleLimit.min}–{scaleLimit.max} — the standard for this question type.
        </p>
      )}
      {feats.numericBounds && !scaleLimit?.fixed && (
        <div className="row">
          <label className="f"><span>Min</span>
            <input className="input" type="number" style={{ width: 90 }} data-testid="min-value"
              min={scaleLimit?.min} max={scaleLimit?.max}
              value={q.settings.minValue ?? ""}
              onChange={(e) => patchSettings({ minValue: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
          <label className="f"><span>Max</span>
            <input className="input" type="number" style={{ width: 90 }} data-testid="max-value"
              min={scaleLimit?.min} max={scaleLimit?.max}
              value={q.settings.maxValue ?? ""}
              onChange={(e) => patchSettings({ maxValue: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
          {/*
            * The message the review asked for. `min`/`max` on a number input
            * are a hint to the spinner, not a refusal — a typed 50 still
            * lands in the setting, so the editor has to say so. Nothing here
            * rewrites the author's value: it tells them what will be drawn,
            * which is what was missing when a 1–50 heart rating showed ten
            * hearts and said nothing.
            */}
          {scaleLimit && scaleOut && (
            <span className="chip warn" data-testid="scale-out-of-range" style={{ alignSelf: "flex-end", marginBottom: 7 }}>
              This scale can only be {scaleLimit.min}–{scaleLimit.max}. It will be drawn and scored as {scaleShown.min}–{scaleShown.max}.
            </span>
          )}
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

      {/*
        * SUBTYPE CONFIGURATION: the country a format is checked against, the
        * symbol beside a number, and the placeholder.
        *
        * All three are things the review asked for and none of them had an
        * editor. The country dropdowns appear where the question actually
        * carries the matching check, so they cannot be set on a question that
        * will never use them; the symbol controls follow the `currency_symbol`
        * capability; and the placeholder had no input at all on a scalar text
        * question, so it was whatever the preset seeded and could not be
        * changed without editing JSON.
        */}
      {(hasRule("phone") || hasRule("zip")) && (
        <div className="row">
          {hasRule("phone") && (
            <label className="f" style={{ minWidth: 220 }}><span>Phone number country</span>
              <select className="select" data-testid="phone-country"
                value={q.settings.phoneCountry ?? ""}
                onChange={(e) => patchSettings({ phoneCountry: e.target.value || undefined })}>
                <option value="">any country (loose check)</option>
                {PHONE_FORMATS.map((f) => <option key={f.code} value={f.code}>{f.name} (+{f.dial})</option>)}
              </select></label>
          )}
          {hasRule("zip") && (
            <label className="f" style={{ minWidth: 220 }}><span>Postal code country</span>
              <select className="select" data-testid="postal-country"
                value={q.settings.postalCountry ?? ""}
                onChange={(e) => patchSettings({ postalCountry: e.target.value || undefined })}>
                <option value="">any country (loose check)</option>
                {POSTAL_FORMATS.map((f) => <option key={f.code} value={f.code}>{f.name}</option>)}
              </select></label>
          )}
        </div>
      )}

      {/*
        * QUANTITY: the stepper and the unit word beside it. Offered for any
        * numeric question, because "7 nights" and "3 items" are the same
        * need as "₹ 1,000" — a number the respondent should be able to see
        * the meaning of.
        */}
      {feats.numericBounds && q.type === "numeric" && (
        <div className="row">
          <label className="row" style={{ gap: 8, fontSize: 13.5, alignSelf: "flex-end", paddingBottom: 7 }}>
            <input type="checkbox" data-testid="stepper"
              checked={!!q.settings.stepper}
              onChange={(e) => patchSettings({ stepper: e.target.checked || undefined })} />
            <span>− / + steppers <span className="muted">a counting input rather than a plain box</span></span>
          </label>
          <label className="f" style={{ width: 150 }}><span>Unit label</span>
            <input className="input" data-testid="unit-label" placeholder="items, nights, kg…"
              value={q.settings.unitLabel ?? ""}
              onChange={(e) => patchSettings({ unitLabel: e.target.value || undefined })} /></label>
          {q.settings.stepper && (
            <label className="f" style={{ width: 100 }}><span>Step</span>
              <input className="input" type="number" min={1} data-testid="stepper-step"
                value={q.settings.step ?? ""}
                onChange={(e) => patchSettings({ step: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
          )}
        </div>
      )}

      {has("currency_symbol") && (
        <div className="row">
          <label className="f" style={{ minWidth: 200 }}><span>Currency</span>
            <select className="select" data-testid="currency-code"
              value={q.settings.currencyCode ?? ""}
              onChange={(e) => patchSettings({ currencyCode: e.target.value || undefined })}>
              <option value="">none</option>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.symbol} {c.code} — {c.name}</option>)}
            </select></label>
          <label className="f" style={{ width: 150 }}><span>Or type a symbol</span>
            <input className="input" data-testid="currency-symbol" placeholder="%, kg, pts…"
              value={q.settings.currencySymbol ?? ""}
              onChange={(e) => patchSettings({ currencySymbol: e.target.value || undefined })} /></label>
          <label className="f" style={{ width: 130 }}><span>Symbol side</span>
            <select className="select" data-testid="symbol-side"
              value={q.settings.symbolSide ?? "left"}
              onChange={(e) => patchSettings({ symbolSide: e.target.value === "right" ? "right" : undefined })}>
              <option value="left">left (₹ 1,000)</option>
              <option value="right">right (1,000 ₹)</option>
            </select></label>
        </div>
      )}

      {SCALAR_TEXT_TYPES.includes(q.type) && (
        <label className="f" style={{ maxWidth: 420 }}><span>Placeholder</span>
          <input className="input" data-testid="placeholder"
            placeholder="shown in the empty box"
            value={q.settings.placeholder ?? ""}
            onChange={(e) => patchSettings({ placeholder: e.target.value || undefined })} /></label>
      )}

      {/*
        * SCALE END LABELS.
        *
        * `scale_labels` has been a declared capability on fifteen variants
        * since the taxonomy work, the settings keys exist, and the renderers
        * read them — but nothing in the Studio ever wrote them. The slider
        * variant's own config file says these "are edited in the ordinary
        * panels"; they were not. So every NPS in the product showed the
        * renderer's hard-coded "Not at all likely" / "Extremely likely",
        * which is exactly what the review asked to be able to change.
        */}
      {has("scale_labels") && scaleLabelKeys && (
        <div className="row">
          <label className="f" style={{ minWidth: 220 }}><span>Left end label</span>
            <input className="input" data-testid="scale-left-label"
              placeholder={scaleLabelKeys[0] === "npsLeftLabel" ? "Not at all likely" : String(q.settings.minValue ?? "")}
              value={(q.settings as Record<string, unknown>)[scaleLabelKeys[0]] as string ?? ""}
              onChange={(e) => patchSettings({ [scaleLabelKeys[0]]: e.target.value || undefined } as Partial<Question["settings"]>)} /></label>
          <label className="f" style={{ minWidth: 220 }}><span>Right end label</span>
            <input className="input" data-testid="scale-right-label"
              placeholder={scaleLabelKeys[1] === "npsRightLabel" ? "Extremely likely" : String(q.settings.maxValue ?? "")}
              value={(q.settings as Record<string, unknown>)[scaleLabelKeys[1]] as string ?? ""}
              onChange={(e) => patchSettings({ [scaleLabelKeys[1]]: e.target.value || undefined } as Partial<Question["settings"]>)} /></label>
        </div>
      )}

      {/*
        * LABELS ON PARTICULAR SCALE POINTS.
        *
        * The end labels say what the extremes mean. The review asked to be
        * able to say what the middle means too — "0 → Not at all likely,
        * 5 → Likely, 10 → Extremely likely" — which is what a scale with a
        * labelled midpoint needs and what nothing in the product offered.
        * Only drawn for a scale short enough to label point by point.
        */}
      {has("scale_labels") && scaleLabelKeys?.[0] === "npsLeftLabel" && scalePoints.length > 0 && scalePoints.length <= 16 && (
        <details className="card" style={{ padding: 10 }} data-testid="scale-point-labels">
          <summary style={{ cursor: "pointer", fontSize: 13.5 }}>
            Label individual points{pointLabelCount ? ` — ${pointLabelCount} set` : ""}
          </summary>
          <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
            {scalePoints.map((n) => (
              <label key={n} className="f" style={{ width: 150, marginBottom: 6 }}>
                <span>{n}</span>
                <input className="input" data-testid={`scale-point-${n}`}
                  placeholder="(no label)"
                  value={q.settings.scalePointLabels?.[String(n)] ?? ""}
                  onChange={(e) => {
                    const next = { ...(q.settings.scalePointLabels ?? {}) };
                    if (e.target.value) next[String(n)] = e.target.value; else delete next[String(n)];
                    patchSettings({ scalePointLabels: Object.keys(next).length ? next : undefined });
                  }} />
              </label>
            ))}
          </div>
        </details>
      )}

      {q.options.some((o) => o.flags?.includes("other_specify")) && (
        <label className="row" style={{ gap: 8, fontSize: 13.5 }} data-testid="other-specify-required">
          <input type="checkbox"
            checked={!q.settings.otherSpecifyOptional}
            onChange={(e) => patchSettings({ otherSpecifyOptional: e.target.checked ? undefined : true })} />
          <span>
            Require the “Other” text —{" "}
            <span className="muted">respondents who pick Other cannot continue until they say what it is</span>
          </span>
        </label>
      )}

      {/*
        * WHAT MAY BE TYPED INTO THE "OTHER" BOX.
        * It accepted anything, because nothing ever checked it — the only
        * rule applied to that text was that it must not be empty. "Anything"
        * stays the default, so no survey already in field starts refusing an
        * answer it used to take.
        */}
      {q.options.some((o) => o.flags?.includes("other_specify")) && (
        <label className="f" style={{ width: 230 }}><span>“Other” accepts</span>
          <select className="select" data-testid="other-specify-format"
            value={q.settings.otherSpecifyFormat ?? ""}
            onChange={(e) => patchSettings({ otherSpecifyFormat: (e.target.value || undefined) as "text" | "numeric" | "alphanumeric" | undefined })}>
            <option value="">anything</option>
            <option value="text">text only</option>
            <option value="numeric">numbers only</option>
            <option value="alphanumeric">letters and numbers</option>
          </select></label>
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

      {(q.type === "conjoint_task" || q.type === "maxdiff_task" || q.type === "acbc_task") && (
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
      </>
      )}
    </div>
  );
}

/**
 * Standard / Live View — a per-question switch, not application navigation.
 *
 * It belongs to the question currently open, so opening another one starts in
 * Standard again; neither view is privileged and neither can be skipped past.
 * The mode lives in the canvas context because the property panel, which is a
 * sibling column in the Studio shell, has to know about it too.
 */
function QuestionViewSwitch({ q }: { q: Question }) {
  const canvas = useCanvas();
  React.useEffect(() => { canvas?.attach(q.id); }, [q.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!canvas) return null;
  return (
    <div className="qview" data-testid="question-view-switch">
      <div className="lc-seg" role="group" aria-label="Question view">
        <button className={canvas.mode === "standard" ? "on" : ""} data-testid="view-standard"
          onClick={() => { canvas.setMode("standard"); canvas.select(null); }}
          title="The full programming interface">
          <Icon name="settings" size={14} /> Standard
        </button>
        <button className={canvas.mode === "live" ? "on" : ""} data-testid="view-live"
          onClick={() => canvas.setMode("live")}
          title="The question as a respondent sees it — click any part to program it">
          <Icon name="sparkle" size={14} /> Live View
        </button>
      </div>
      <span className="grow" />
      <SaveChip />
    </div>
  );
}

/** The existing save state, shown where the editing happens. */
function SaveChip() {
  const s = useStudio();
  const k = s.saveState.kind;
  const label = k === "saving" ? "Saving…" : k === "saved" || k === "clean" ? "Saved"
    : k === "dirty" ? "Editing" : k;
  return (
    <span className={`lc-save ${k}`} data-testid="question-save-state">
      {k === "saved" || k === "clean" ? "✓ " : ""}{label}
    </span>
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
        <button className="btn small ghost" data-testid="add-page-break" data-command={BLOCK_COMMANDS.ADD_PAGE_BREAK} onClick={onPageBreak}
          title="Start a new respondent page here — the block stays one block">
          ⎯ Page break
        </button>
      )}
      <span className="insert-line" />
    </div>
  );
}

/**
 * A COPY IS A NEW QUESTION, AND EVERY ID INSIDE IT IS NEW TOO.
 *
 * Duplicating re-minted the question's own `id`, `code` and `variableName` and
 * then deep-cloned everything under them — so the copy's options, rows,
 * columns, punches, skip rules and option groups carried the ORIGINAL's
 * element ids. Two questions then claimed the same option id, which is the
 * identity the element registry, the live canvas, per-element analytics and
 * the option-level logic editor all key on. Codes and labels are meant to be
 * shared by a copy; ids are exactly the thing that must not be.
 */
function reidentify(copy: Record<string, any>): void {
  const mint = (el: any, prefix: string) => {
    if (el && typeof el === "object" && typeof el.id === "string") el.id = uid(prefix);
  };
  for (const [axis, prefix] of [["options", "opt"], ["rows", "row"], ["columns", "col"]] as const) {
    for (const el of (copy[axis] ?? []) as any[]) {
      mint(el, prefix);
      /* a cell grid's column carries its own option list */
      for (const o of (el?.options ?? []) as any[]) mint(o, "opt");
    }
  }
  for (const key of ["punches", "skipLogic", "optionGroups", "validation", "listLogic", "optionPipeline"]) {
    for (const el of (copy[key] ?? []) as any[]) mint(el, "r");
  }
}

/**
 * Rewrite every reference inside `node` that names something the copy renamed.
 *
 * Deliberately a string rewrite over the whole subtree rather than a list of
 * known fields: a reference can be a question id in `sourceQuestionId`, a page
 * id in `skipLogic[].target.ref`, a code inside a condition or a `{{Q3}}` in a
 * sentence, and a hand-kept list of the places it can appear is how the last
 * one gets forgotten. Only EXACT matches are rewritten, so a label that happens
 * to contain a code is left alone; piped tokens are matched on their ref.
 */
function remapRefs(node: any, map: Map<string, string>, skipKeys = new Set<string>()): void {
  if (Array.isArray(node)) { for (const x of node) remapRefs(x, map, skipKeys); return; }
  if (!node || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    if (skipKeys.has(key)) continue;
    const v = node[key];
    if (typeof v === "string") {
      if (map.has(v)) { node[key] = map.get(v)!; continue; }
      if (v.includes("{{")) {
        node[key] = v.replace(PIPE_TOKEN_RE, (whole, body: string) => {
          const ref = body.trim().split(/[.[|]/)[0].trim();
          const to = map.get(ref);
          return to ? whole.replace(ref, to) : whole;
        });
      }
      continue;
    }
    remapRefs(v, map, skipKeys);
  }
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
    const q = createFromVariant(v, nextQuestionNaming(s.def));
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

  /**
   * ADD A BLOCK — at the end of the survey, in front of the End node.
   *
   * THE BUG THIS REPLACES, because it is worth not reintroducing. The old
   * version found the last PAGE via `listPages` and inserted a sibling next to
   * it. `listPages` walks recursively, and a `PageRef.parent` is the array the
   * page actually sits in — which, the moment any block has a page break, is
   * that block's `children`. So "+ Add block" appended a page INSIDE the last
   * block: the block count did not change, a second PAGE BREAK row appeared,
   * and the button had silently performed a page-break action under an Add
   * Block label. Nested in a group, a branch or a loop it was worse — the new
   * block landed inside the branch path, visible only to some respondents.
   *
   * Worse still, the page it created was unreachable: the insert bar is
   * rendered per existing question and the empty-block bar keys off the whole
   * block's count, so a 0-question page inside a non-empty block got no
   * "+ Question" control at all, and `containerSlots` returns [] for `block`
   * so the Flow panel could not move or delete it either. The only way out was
   * "remove page break".
   *
   * That is almost certainly the "Add Block opens Paste" report: nothing
   * appeared to happen, and the next control anybody reaches for is
   * "📋 paste options", which sits beside "+ option" in the selected
   * question. Paste was never wired to this button — see the note by
   * BLOCK_COMMANDS below.
   *
   * The fix is to stop deriving the insertion point from a page at all. A new
   * block goes at the TOP LEVEL, before the End node, which is exactly what
   * the Survey Flow tab's own "+ Add block" already did (`endTarget`) — two
   * buttons with one label now do one thing.
   */
  const addBlock = () => {
    s.update((d) => {
      const flow = d.flow as any[];
      const at = flow.findIndex((n) => n?.type === "end");
      flow.splice(at < 0 ? flow.length : at, 0, newBlockNode());
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

  /*
   * A block goes the same way a question does: the dialog lists what OUTSIDE
   * the block referred to anything inside it, and confirming prunes those
   * references in the same undo step. Wiring between the block's own
   * questions is not listed — it is going with them, and burying the
   * external breakage under it is what makes such a list unread.
   */
  const deleteBlock = (blockId: string) => {
    const b = blocks.find((x) => x.id === blockId);
    if (!b) return;
    const qids = b.pages.flatMap((p) => p.node.questionIds);
    setPendingDelete({
      ids: qids, blockId,
      code: `${(b as any).title || "this block"}${qids.length ? ` and its ${qids.length} question${qids.length === 1 ? "" : "s"}` : ""}`,
      refs: referencesToMany(s.def, qids),
    });
  };

  const confirmDeleteBlock = (blockId: string, qids: string[], label: string) => {
    setPendingDelete(null);
    s.labelNextEdit(`delete ${label}`);
    s.update((d) => {
      const hit = blockIn(d, blockId);
      if (!hit) return;
      const ids = hit.pages.flatMap((p) => p.node.questionIds);
      pruneReferencesToMany(d, ids);
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
      /**
       * A COPIED BLOCK POINTS AT ITSELF, NOT AT THE BLOCK IT CAME FROM.
       *
       * Fresh page ids were minted here and nothing was rewritten to use them,
       * so every `skipLogic.target.ref` in the copy still named the ORIGINAL
       * block's page: a respondent who took the copy jumped back into the
       * source. The same held for a display rule inside the block that tested
       * a question inside the block — it went on testing the original.
       *
       * So the copy is made in two passes: mint the new identities first,
       * building a map of what became what, then rewrite every reference the
       * copies hold that names something inside the block.
       */
      const idMap = new Map<string, string>();
      const copiedQuestions: any[] = [];
      const copyPage = (page: any) => {
        const newIds: string[] = [];
        for (const qid of page.questionIds) {
          const q = d.questions.find((x: any) => x.id === qid);
          if (!q) continue;
          const copy = structuredClone(q);
          copy.id = uid("q");
          copy.code = `${q.code}_COPY`;
          copy.variableName = `${q.variableName}_COPY`;
          reidentify(copy);
          idMap.set(q.id, copy.id);
          /* questions are named by code and by variable name as well as by id
             — see `getQuestionByCodeOrVar` — and all three have to travel */
          if (q.code) idMap.set(q.code, copy.code);
          if (q.variableName) idMap.set(q.variableName, copy.variableName);
          d.questions.push(copy);
          copiedQuestions.push(copy);
          newIds.push(copy.id);
        }
        const out: any = { type: "page", id: uid("page"), questionIds: newIds };
        idMap.set(page.id, out.id);
        if (page.title) out.title = page.title;
        return out;
      };
      const copies = hit.pages.map((p) => copyPage(p.node));
      const title = hit.title ? `${hit.title} (copy)` : undefined;
      const node = copies.length === 1
        ? { ...copies[0], ...(title ? { title } : {}) }
        : { type: "block", id: uid("block"), ...(title ? { title } : {}), children: copies };
      idMap.set(hit.node.id, node.id);
      /* `questionIds` are already the new ones; everything else is rewritten */
      for (const q of copiedQuestions) remapRefs(q, idMap);
      remapRefs(node, idMap, new Set(["questionIds"]));
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

  /**
   * SPLIT A BLOCK at a question — everything from here down becomes a block.
   *
   * Had the same defect as `addBlock`: it spliced into the PAGE's parent
   * array, so splitting a question inside a block that had page breaks put the
   * "new block" into that block's `children` and produced another page break
   * while toasting "Block split".
   *
   * It now works at block level, and it means the same thing as the "split
   * block" control on a page break: this page's tail AND every page below it
   * in the block leave together. Anything else would be a split that left half
   * the block on the far side of the new one.
   */
  const splitBlock = (pageId: string, pos: number) => {
    s.update((d) => {
      const b = listBlocks(d.flow as any[]).find((x) => x.pages.some((p) => p.node.id === pageId));
      if (!b) return;
      const pi = b.pages.findIndex((p) => p.node.id === pageId);
      const page: any = b.pages[pi].node;
      const moved = (page.questionIds ?? []).slice(pos);
      /* nothing to move is not a split — leave the flow exactly as it was */
      if (!moved.length) return;
      page.questionIds = page.questionIds.slice(0, pos);

      const tailPage: any = { type: "page", id: uid("page"), questionIds: moved };

      if (!b.wrapped) {
        /* a bare page: the new block is simply its next sibling */
        b.parent.splice(b.parent.indexOf(b.node) + 1, 0, tailPage);
        return;
      }

      /* wrapped: the tail page and every page after it leave the wrapper */
      const kids: any[] = b.node.children;
      const below = b.pages.slice(pi + 1).map((p) => p.node as any);
      for (const p of below) kids.splice(kids.indexOf(p), 1);
      const tail = [tailPage, ...below];
      const node = tail.length === 1
        ? tail[0]
        : { type: "block", id: uid("block"), children: tail };
      b.parent.splice(b.parent.indexOf(b.node) + 1, 0, node);
      unwrapIfSingle(b);
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
      reidentify(copy);
      d.questions.push(copy);
      for (const pg of listPages(d.flow as any[])) {
        const k = pg.node.questionIds.indexOf(id);
        if (k >= 0) { pg.node.questionIds.splice(k + 1, 0, copy.id); return; }
      }
    });

  /**
   * DELETING IS A CHANGE TO THE WHOLE SURVEY, so it is shown as one.
   *
   * `referencesTo` finds everything that names this question and says what
   * pruning does to each; the dialog shows that list; confirming runs
   * `pruneReferencesTo` — the same function — inside the same `update`, so
   * the question and every rule that depended on it go in one undo step.
   *
   * Before this, delete removed the question and left the references behind
   * pointing at an id nothing could resolve: the rule rendered as an unset
   * row, so it read as unfinished rather than broken, and the survey silently
   * behaved differently in the field.
   */
  const [pendingDelete, setPendingDelete] = React.useState<
    { id?: string; ids?: string[]; blockId?: string; code: string; refs: QuestionReference[] } | null
  >(null);

  const remove = (id: string) => {
    const q = s.def.questions.find((x) => x.id === id);
    setPendingDelete({ id, code: q?.code ?? "this question", refs: referencesTo(s.def, id) });
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.blockId) {
      confirmDeleteBlock(pendingDelete.blockId, pendingDelete.ids ?? [], pendingDelete.code);
      return;
    }
    const id = pendingDelete.id;
    if (!id) return;
    setPendingDelete(null);
    s.labelNextEdit(`delete ${pendingDelete.code}`);
    s.update((d) => {
      pruneReferencesTo(d, id);
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
        data-testid="qcard" data-qid={q.id}
        onClick={() => s.select(isSelected ? null : q.id)}>
        {isSelected && <EscapeCloses onClose={close} />}
        <div className="qlist-item">
          <strong className="mono">{q.code}</strong>
          <span className="qtype-badge">{q.variant?.split(".")[1] ?? q.type}</span>
          <span className={`grow qcard-text${stripHtmlText(q.text) ? "" : " muted"}`}>
            {stripHtmlText(q.text) || "untitled"}
          </span>
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
              data-testid="split-block" data-command={BLOCK_COMMANDS.SPLIT_BLOCK}
              onClick={(e) => { e.stopPropagation(); splitBlock(pageId, indexInPage); }}>⤵</button>
          )}
          {isSelected && (
            <button className="btn small primary" data-testid="close-question"
              title="Done editing — close this question (Esc)"
              onClick={(e) => { e.stopPropagation(); close(); }}>Done</button>
          )}
          <button className="btn small danger" data-testid="delete-question" title="Delete this question" onClick={(e) => { e.stopPropagation(); remove(q.id); }}>×</button>
        </div>
        {isSelected && selected && (
          <div style={{ marginTop: 14 }} onClick={(e) => e.stopPropagation()}>
            <QuestionEditor q={selected} />
            <div className="row qcard-foot">
              <span className="muted" style={{ fontSize: 12.5 }}>Changes save automatically.</span>
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
      {pendingDelete && (
        <DeleteQuestionDialog
          code={pendingDelete.code}
          refs={pendingDelete.refs}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Questions</h2>
        <span className="chip">{s.def.questions.length} question{s.def.questions.length === 1 ? "" : "s"}</span>
        <span className="chip">{blocks.length} block{blocks.length === 1 ? "" : "s"}</span>
        <span className="grow" />
        <button className="btn" onClick={addBlock}
          data-testid="add-block" data-command={BLOCK_COMMANDS.ADD_BLOCK}>+ Add block</button>
        <button className="btn primary" data-testid="add-question-top" onClick={() => {
          const last = blocks[blocks.length - 1]?.pages.slice(-1)[0];
          setPickerAt(last ? { pageId: last.node.id, pos: last.node.questionIds.length } : { pageId: "", pos: 0 });
        }}>+ Add question</button>
        {pickerAt && (
          <VariantPickerModal
            onPick={(v) => { insertQuestion(pickerAt.pageId, pickerAt.pos, v); setPickerAt(null); }}
            onMode={(m) => { s.update((d) => { m.apply(d.branding as Record<string, unknown>); }); s.toast(m.toast); setPickerAt(null); }}
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
                      data-command={BLOCK_COMMANDS.DUPLICATE_BLOCK} data-testid="duplicate-block"
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
                        data-command={BLOCK_COMMANDS.MERGE_BLOCK_UP} data-testid="merge-block-up"
                        onClick={() => { setMenuFor(null); mergeUp(b.id); }}>⇧ Merge into block above</button>
                    )}
                    <div className="menu-sep" />
                    <button className="menu-item" data-testid="block-media-toggle"
                      onClick={() => { setMenuFor(null); setMediaFor(mediaFor === b.id ? null : b.id); }}>
                      🖼 {(b.node as any).mediaUrl ? "Edit block media" : "Add block media (image / video / URL)"}
                    </button>
                    <div className="menu-sep" />
                    <button className="menu-item danger"
                      data-command={BLOCK_COMMANDS.DELETE_BLOCK} data-testid="delete-block"
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
                      <button className="btn small" data-testid="break-to-block" data-command={BLOCK_COMMANDS.SPLIT_BLOCK_AT_BREAK}
                        title="Make this page and everything below it a separate block"
                        onClick={() => splitBlockAtBreak(b.id, pgi - 1)}>split block</button>
                      <button className="btn small danger" data-testid="remove-page-break" data-command={BLOCK_COMMANDS.REMOVE_PAGE_BREAK}
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
                      <span className="muted" style={{ fontSize: 12.5 }}>
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

      <button className="btn add-block-btn" onClick={addBlock}
        data-testid="add-block-footer" data-command={BLOCK_COMMANDS.ADD_BLOCK}>+ Add block</button>

      {unplaced.length > 0 && (
        <div className="block warn-block">
          <div className="block-head">
            <span className="block-badge" style={{ background: "var(--amber)" }}>NOT IN ANY BLOCK</span>
            <span className="muted" style={{ fontSize: 12.5 }}>
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
