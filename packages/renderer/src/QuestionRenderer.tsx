"use client";
import React from "react";
import type { Question, Option, SurveyDefinition, QuestionColumn, QuestionRow } from "@rescript/schema";
import { resolveVariant, questionTypeRegistry } from "@rescript/schema";
import {
  effectiveQuestion,
  resolveQuestionMedia, questionMediaList,
  designRowsFor,
  shuffleAlternatives,
  resolvePiping,
  evaluateExpression,
  flattenVariables,
  toggleMultiValue,
  normalizeMultiValue,
  fieldInputProps,
  type EvalContext,
  type ResponseState,
  type LoopContext,
  stripHtmlText,
  sanitizeHtml,
  layoutColumns,
  customAffix,
  numericBoxCh,
  renderRichContent,
  hasStyleBlock,
  SCOPE_ATTR,
  selectedOtherCodes,
  headerRepeatApplies,
  headerRepeatEvery,
  headerRepeatsBefore,
  fieldIsRequired,
  requiredFieldsNote,
  isOtherRow,
  rowOtherCode,
  uiText,
  effectiveScale,
  affixFor,
  DIAL_CODES,
  PHONE_PICK,
  formatDateAs,
  parseDateAs,
  datePlaceholder,
  type DateFormat,
  initialDateValue,
  initialTimeValue,
  type ValidationError,
} from "@rescript/engine";
import { variantRenderers } from "./variants/registry";
import { DualResponseFollowUp } from "./variants/conjointSuite";
import { MediaEmbed, SafeImage } from "./Media";
import { SpeechInputButton, SpeechCell } from "./SpeechInput";
import { anchor, cellAnchor, type AuthoringAnchor } from "./authoring";
import { announceSelection } from "./optionPopup";
import { CellMultiDropdown } from "./cellMultiDropdown";
import { TimeSelects } from "./TimeSelects";
import { enhanceMediaCarousels } from "./mediaCarousel";
import { CardFace, cardFrameClass } from "./CardFace";
// side-effect: every family registers its renderers
import "./variants";

export interface QRProps {
  def: SurveyDefinition;
  q: Question;
  state: ResponseState;
  loop: LoopContext | null;
  value: unknown;
  /**
   * "OTHER, SPECIFY" TEXT, PER OPTION.
   *
   * A question can carry several flagged options and therefore several boxes,
   * each with its own answer. `otherValue` — one string for the whole
   * question — is what made typing "Apple" into the first box put "Apple"
   * into the other two: every box rendered the same binding. It is kept only
   * so that callers with a single box keep working, and it is read for the
   * FIRST flagged option alone.
   */
  otherValues?: Record<string, string>;
  /** @deprecated the first flagged option's text; use `otherValues` */
  otherValue?: string;
  /**
   * THE WHOLE ERROR, NOT ITS SENTENCE.
   *
   * This was `string[]`, and the Runner flattened `validatePage`'s output
   * with `.map((e) => e.message)` on the way in — throwing away `rowCode`,
   * `columnId`, `severity` and the loop iteration. The renderers that needed
   * a row's own error back then reconstructed it by matching the message
   * against the row's label as a text prefix, which the engine had
   * string-concatenated on for exactly that purpose.
   *
   * That worked until a message stopped being plain text. It is also how a
   * row whose label is a prefix of another row's could take the wrong
   * error. `rowCode` has been on the error object all along; this prop is
   * widened so the renderer can read it instead of parsing it back out of a
   * sentence.
   */
  errors: ValidationError[];
  onChange(value: unknown): void;
  /** `code` names the box. Absent means the first flagged option. */
  onOtherChange?(text: string, code?: string | number): void;
  /** the respondent's language's interface strings (engine `uiStringsFor`); absent = English */
  ui?: Record<string, string>;
  /**
   * A value stored BESIDE the answer, at `<answer key>__<suffix>` — the same
   * convention as `__voice` and `__probe_n`. Video Rating's optional comment
   * is `__comment`, so the rating stays a number and every report that reads
   * it as one keeps working. Absent outside a Runner (nothing to store into).
   */
  onExtraChange?(suffix: string, value: unknown): void;
}

/**
 * One validation message, rendered the way its author wrote it.
 *
 * Every error the engine raises from its own wording is plain text and is
 * escaped, exactly as before. Only a message an author marked as markup is
 * put through `dangerouslySetInnerHTML`, and it is sanitised again here even
 * though the engine sanitised it at the point it was raised: the rule is
 * that nothing reaches the DOM without passing a sanitiser on this side of
 * the wire, because this component can be handed an error by anything —
 * a test harness, the Studio canvas, a future caller that assembled one
 * itself — and "the engine already did it" is an assumption about a caller
 * rather than a property of this function.
 *
 * `.rs-error-msg::before` puts the "! " on, so the markup does not have to.
 */
export function ValidationMessageText({ error }: { error: ValidationError }): React.ReactElement {
  if (!error.html) return <div className="rs-error-msg">{error.message}</div>;
  return (
    <div className="rs-error-msg rs-error-rich"
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(error.message) }} />
  );
}

/**
 * The block of messages for one question, in the place the author chose.
 *
 * Kept as one region wherever it goes: a single `role="alert"` with a single
 * id, so a screen reader announces the failures as one group belonging to
 * this question and `aria-describedby` has something to point at. That is
 * the reason the position is a property of the QUESTION rather than of each
 * rule — two positions would mean two regions and a description that can
 * only name one of them.
 */
function ValidationBlock({ id, errors }: { id: string; errors: ValidationError[] }) {
  if (!errors.length) return null;
  return (
    <div id={id} role="alert" className="rs-errors" data-testid="rs-errors">
      {errors.map((e, i) => <ValidationMessageText key={i} error={e} />)}
    </div>
  );
}

export const OTHER = (o: Option) => o.flags?.includes("other_specify");

/**
 * The text belonging to ONE box.
 *
 * `otherValues` wins; `otherValue` answers only for the first flagged option,
 * which is the only box a caller that knows about one box could have meant.
 * Every input below reads through this, so no two boxes can share a binding
 * by accident again.
 */
export function otherTextOfOption(p: QRProps, code: string | number): string {
  const own = p.otherValues?.[String(code)];
  if (own != null) return own;
  const first = (p.q.options ?? []).find(OTHER);
  return first && String(first.code) === String(code) ? (p.otherValue ?? "") : "";
}

/** One box. Named by its option, so React never reuses another box's state. */
function OtherInput(p: QRProps & { option: Option; below?: boolean }) {
  const code = String(p.option.code);
  const text = otherTextOfOption(p, code);
  return (
    <>
    <input
      className={`rs-input rs-other-input${p.below ? " rs-other-below" : ""}`}
      data-testid="rs-other-input"
      data-other-code={code}
      id={`${p.q.id}__other__${code}`}
      name={`${p.q.id}__other__${code}`}
      aria-label={`${stripTags(String(p.option.label ?? ""))} — ${uiOf(p, "other_specify")}`}
      placeholder={uiOf(p, "other_specify")}
      /* the format the author asked for, told to the keyboard as well as to
         the validator — a numeric box should open a number pad on a phone */
      inputMode={p.q.settings.otherSpecifyFormat === "numeric" ? "decimal" : undefined}
      value={text}
      disabled={p.q.settings.readOnly}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => p.onOtherChange?.(e.target.value, code)}
    />
    {/* dictation into THIS box, through its own writer and key (on by default; never on a numeric box) */}
    {p.onOtherChange && (
      <SpeechInputButton def={p.def} q={p.q} value={text} field={{ kind: "other" }} compact
        label={stripTags(String(p.option.label ?? ""))} onChange={(t) => p.onOtherChange?.(t, code)} />
    )}
    </>
  );
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").trim();

/**
 * A GRID ROW'S LABEL — and, on a row flagged "Other, please specify", the box
 * that says what the row is (07-10 review, Suraj #1 / Oweas #1).
 *
 * The flag was offered on matrix rows and drawn by no grid, so a row reading
 * "Other, please describe" took a rating or a number with nowhere to type
 * what it was. Every tabular grid renderer draws its row label through this
 * one component, so the box appears the same way on a Single / Multi Matrix,
 * a Likert, a Rating Matrix, a Star or Slider Matrix, a Mixed or Constant-Sum
 * Matrix and an editable table — and binds to the engine's per-box key
 * (`rowOtherCode`), the same plumbing an option's box uses. The box is always
 * shown; the validator holds the row and its text to each other.
 */
export function RowLabel(p: QRProps & { row: QuestionRow; labelClass?: string }) {
  const rc = String(p.row.code);
  const label = <span className={p.labelClass ?? "rs-rowlabel-text"} dangerouslySetInnerHTML={{ __html: p.row.label }} />;
  if (!isOtherRow(p.row)) return label;
  const code = rowOtherCode(rc);
  const plain = stripTags(String(p.row.label ?? ""));
  return (
    <span className="rs-rowlabel-other">
      {label}
      <input
        className="rs-input rs-other-input rs-row-other-input"
        data-testid="rs-row-other-input"
        data-other-code={code}
        id={`${p.q.id}__other__${code}`}
        name={`${p.q.id}__other__${code}`}
        aria-label={`${plain} — ${uiOf(p, "other_specify")}`}
        placeholder={uiOf(p, "other_specify")}
        inputMode={p.q.settings.otherSpecifyFormat === "numeric" ? "decimal" : undefined}
        value={otherTextOfOption(p, code)}
        disabled={p.q.settings.readOnly}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => p.onOtherChange?.(e.target.value, code)}
      />
      {p.onOtherChange && (
        <SpeechInputButton def={p.def} q={p.q} value={otherTextOfOption(p, code)} field={{ kind: "other" }} compact
          label={plain} onChange={(t) => p.onOtherChange?.(t, code)} />
      )}
    </span>
  );
}

/**
 * THE "OTHER, SPECIFY" BOX FOR A LAYOUT THAT CANNOT NEST ONE.
 *
 * A radio list puts the input inside the selected option's label. A button,
 * card, tile or icon grid cannot — an `<input>` inside a `<button>` is not
 * typeable — so those layouts rendered no box at all: a respondent who chose
 * "Other" on a tile question had nowhere to say what they meant, and the
 * validator then refused to let them past a question it gave them no way to
 * answer. This renders the box BELOW the choices instead, on exactly the same
 * condition (a selected option carrying the flag) and against exactly the same
 * stored value, so every layout of the same question behaves the same way.
 */
export function OtherSpecifyBox(p: QRProps & { options: Option[]; selected: (string | number)[] }) {
  /*
   * EVERY selected flagged option, not the first one. `.find(...)` meant that
   * a respondent who ticked two "Other" options on a tile question got one
   * box and no way to answer the second — while the validator, which checks
   * each selection, refused to let them past.
   */
  const chosen = p.options.filter((o) => OTHER(o) && p.selected.some((v) => String(v) === String(o.code)));
  if (!chosen.length) return null;
  return (
    <>
      {chosen.map((o) => <OtherInput key={String(o.code)} {...p} option={o} below />)}
    </>
  );
}
/**
 * THE BOX APPEARS WHEREVER THE FLAG DOES — the dead-end fix.
 *
 * `other_specify` is a flag on an OPTION, so the Studio offers it on any
 * question that has options. Rendering it, though, was each variant's own
 * business: `SingleSelect`, `MultiSelect` and `Dropdown` nest the input in
 * the chosen option's label, `ChoiceButtons` and `ChoiceCards` call
 * `OtherSpecifyBox` — and the other twenty-odd option variants rendered
 * nothing at all.
 *
 * That is not a cosmetic gap. `validate.ts` requires text for every selected
 * flagged option, on every variant, because emptiness is a property of the
 * ANSWER and not of the layout. So on a searchable dropdown, an adaptive
 * question, a carousel, an image grid — a respondent who selected "Other"
 * was shown "Please specify", given nowhere to specify it, and could not go
 * forward or back out of it. A dead-end interview: the worst failure a
 * runtime has, because the respondent is lost and the data never arrives.
 *
 * Rather than adding a box to twenty-odd variant files — twenty-odd chances
 * to write it differently — the dispatcher renders one CENTRALLY for every
 * variant that does not already render its own. `selectedOtherCodes` is the
 * engine's own reading of which flagged options an answer selects, so it
 * handles a scalar, a multi-select array and a grid object identically, and
 * it is the same function the validator asks. The box binds to the same
 * per-option key everything else uses; nothing about the data changes.
 */
const OWN_OTHER_BOX_RENDERERS = new Set(["buttons", "cards"]);
const OWN_OTHER_BOX_TYPES = new Set(["single_select", "multi_select", "dropdown"]);

export function rendersOwnOtherBox(q: Question, renderer: string | undefined): boolean {
  return renderer ? OWN_OTHER_BOX_RENDERERS.has(renderer) : OWN_OTHER_BOX_TYPES.has(q.type);
}

/** Every box this answer needs that the variant did not draw. */
export function OtherSpecifyFallback(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const q = options === p.q.options ? p.q : { ...p.q, options };
  const codes = selectedOtherCodes(q, p.value);
  if (!codes.length) return null;
  return (
    <>
      {codes.map((c) => {
        const o = options.find((x) => String(x.code) === c);
        return o ? <OtherInput key={c} {...p} option={o} below /> : null;
      })}
    </>
  );
}

export const EXCLUSIVE = (o: Option) => !!o.flags?.includes("exclusive");

export function ctxOf(p: QRProps): EvalContext {
  return { def: p.def, state: p.state, loop: p.loop, ui: p.ui };
}

/** An interface string in the respondent's language ("Please specify", "Search 40 options…"). */
export function uiOf(p: QRProps, id: string, params?: Record<string, unknown>, fallback?: string): string {
  return uiText(p.ui, id, params, fallback);
}

/** N-column option layout (req §10) with a mobile fallback in CSS. */
export function optionsClass(p: QRProps): string {
  /*
   * "Horizontal" is a layout, not a second setting fighting the first. The
   * review asked for a Horizontal / Vertical choice on Radio and Button
   * Select so a 0–10 scale can be built from them; it is the same question as
   * "how many columns", so the Studio offers one list and choosing one
   * clears the other. A question that has neither is a vertical list, exactly
   * as it always was.
   */
  if (p.q.settings.optionOrientation === "horizontal") return "rs-options horizontal";
  /*
   * ALWAYS A NUMBER OF COLUMNS, AND ONE BY DEFAULT (October 2026 review:
   * "remove Auto (Fit Width) … set Columns: 1 as the default"). The old
   * "auto" flowed five short options into three columns on its own; the
   * engine's `layoutColumns` is now the one answer the builder shows and
   * every renderer draws.
   */
  const n = layoutColumns(p.q, resolveVariant(p.q.variant)?.renderer);
  return n > 1 ? `rs-options cols-${n}` : "rs-options";
}

/**
 * The Question Layout setting only ever reached the radio/checkbox list, the
 * button select and the card grid — every other grid renderer hardcoded its
 * own `auto-fill` track list, so choosing "3 columns" on an image select or a
 * comparison did nothing at all. This turns the setting into an override any
 * grid can apply.
 */
export function gridColumnsStyle(p: QRProps, _fallback?: string): React.CSSProperties {
  /* a number of columns always (`layoutColumns`) — the designed count when none is stored */
  const n = layoutColumns(p.q, resolveVariant(p.q.variant)?.renderer);
  /*
   * `n > 1` was the bug: one column fell through to the fallback, which for
   * an image grid is `repeat(auto-fill, minmax(150px, 1fr))` — as many
   * columns as fit. Choosing "1 column" on an image select therefore did
   * nothing visible, while 2, 3 and 4 worked. The fallback is now only for
   * questions that have chosen nothing at all.
   */
  return { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
}

/**
 * Search box for long option lists (req §9).
 *
 * `mode` is the author's choice (`settings.optionSearch`). It used to be the
 * threshold alone, hard-coded at every call site, so a list of twenty-six
 * options grew a search field nobody asked for and a list of twenty-four did
 * not — the review reported exactly that. "auto" keeps the old rule, which is
 * why no question already in field changes.
 */
export function useOptionFilter(
  options: Option[],
  threshold = 25,
  ui?: Record<string, string>,
  mode?: "auto" | "always" | "never",
) {
  const [filter, setFilter] = React.useState("");
  const filtered = React.useMemo(() => {
    if (!filter.trim()) return options;
    const f = filter.toLowerCase();
    return options.filter((o) =>
      o.label.replace(/<[^>]*>/g, "").toLowerCase().includes(f),
    );
  }, [options, filter]);
  const wanted =
    mode === "never" ? false
      : mode === "always" ? true
        : options.length > threshold;
  const searchBox =
    wanted ? (
      <input
        className="rs-input rs-optfilter"
        placeholder={uiText(ui, "search_options", { n: options.length })}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
    ) : null;
  return { filtered, searchBox };
}

/* ------------------------------------------------ single select / dropdown */
export function SingleSelect(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const { filtered, searchBox } = useOptionFilter(options, 25, p.ui, p.q.settings.optionSearch);
  return (
    <div>
    {searchBox}
    <div className={optionsClass(p)} role="radiogroup">
      {filtered.map((o) => {
        const sel = String(p.value) === String(o.code);
        return (
          <label key={String(o.code)} className={`rs-option ${sel ? "selected" : ""} ${o.meta?.disabled ? "disabled" : ""}`} {...anchor("option", o.code)}>
            <input
              type="radio"
              name={p.q.id}
              value={String(o.code)}
              checked={sel}
              onChange={() => p.onChange(o.code)}
              disabled={p.q.settings.readOnly || !!o.meta?.disabled}
            />
            <span className="lbl" dangerouslySetInnerHTML={{ __html: o.label }} />
            {OTHER(o) && sel && <OtherInput {...p} option={o} />}
          </label>
        );
      })}
    </div>
    </div>
  );
}

export function MultiSelect(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const { filtered, searchBox } = useOptionFilter(options, 25, p.ui, p.q.settings.optionSearch);
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
          <label key={String(o.code)} {...anchor("option", o.code)}
            className={`rs-option ${sel ? "selected" : ""} ${o.meta?.disabled ? "disabled" : ""}`}
            title={atMax ? `You have already chosen ${p.q.settings.maxSelections}.` : undefined}
            style={atMax ? { opacity: 0.5 } : undefined}>
            {/* At the cap the engine silently ignored the click, so the last
                option — conventionally "Other" — looked broken. Disabling the
                control says so instead of failing quietly. */}
            <input type="checkbox" value={String(o.code)} checked={sel} onChange={() => toggle(o)}
              disabled={p.q.settings.readOnly || atMax || !!o.meta?.disabled} />
            <span className="lbl" dangerouslySetInnerHTML={{ __html: o.label }} />
            {OTHER(o) && sel && <OtherInput {...p} option={o} />}
          </label>
        );
      })}
    </div>
    </div>
  );
}

export function Dropdown(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  // an other-specify option is meaningless without somewhere to type
  const otherOpt = options.find(
    (o) => OTHER(o) && String(o.code) === String(p.value),
  );
  return (
    <>
    <select
      className="rs-select"
      value={p.value == null ? "" : String(p.value)}
      onChange={(e) => p.onChange(e.target.value === "" ? null : e.target.value)}
      disabled={p.q.settings.readOnly}
    >
      <option value="">— Select —</option>
      {options.map((o) => (
        <option key={String(o.code)} value={String(o.code)} {...anchor("option", o.code)}>{o.label.replace(/<[^>]*>/g, "")}</option>
      ))}
    </select>
    {/* a dropdown selects one option, so at most one box — but it is still
        THAT option's box, addressed by its own code */}
    {otherOpt && (
      <div style={{ marginTop: 8 }}><OtherInput {...p} option={otherOpt} /></div>
    )}
    </>
  );
}

/**
 * Real multi-select dropdown (req §1): chips for current selections, a
 * searchable checkbox list, select all / clear all, min/max enforcement and
 * shared exclusive-option semantics.
 */
export function MultiDropdown(p: QRProps) {
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
          <span key={String(o.code)} className="rs-msd-chip" {...anchor("option", o.code)}>
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
              placeholder={uiOf(p, "search_options", { n: options.length })}
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
                  {...anchor("option", o.code)}
                  className={`rs-msd-item ${disabled ? "disabled" : ""}`}
                  role="option"
                  aria-selected={sel}
                  onClick={() => !disabled && toggle(o)}
                >
                  <input type="checkbox" readOnly checked={sel} disabled={disabled} />
                  <span dangerouslySetInnerHTML={{ __html: o.label }} />
                  {/*
                    * There used to be an "exclusive" label here, printed to
                    * the RESPONDENT next to the option. `exclusive` is a
                    * programming instruction — it says what selecting the
                    * option does to the other selections — and it leaked into
                    * the survey, so a respondent reading a multi-select
                    * dropdown saw the word beside "Don't know". The review
                    * asked for it to go and for the behaviour to stay, which
                    * is what `toggle` below does.
                    */}
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

/**
 * A numeric field that survives being typed into.
 *
 * A controlled `<input type="number">` whose model is `Number(raw)` and whose
 * displayed value is `String(model)` destroys any transient text that isn't a
 * canonical number. Typing "90.09" goes "90" → "90." (invalid, reads as "")
 * → "90.0" → Number → 90 → React writes "90" back, eating the ".0" — and the
 * next keystroke lands as "909". The decimal point can never survive.
 *
 * So the field owns the raw string while it is focused and only commits a
 * number outward; the model is echoed back in only when the value changed
 * from somewhere else (a calculation, a reset, another respondent action).
 */
export function NumberField({
  value, onChange, className = "rs-input sm", min, max, step, placeholder, readOnly, ariaLabel, disabled, decimals, style, id, ariaRequired,
}: {
  /** for a `<label htmlFor>` — a form field's own label */
  id?: string;
  ariaRequired?: boolean;
  value: unknown;
  onChange(v: number | null): void;
  className?: string;
  /** the box's own width, when the system sizes it (`numericBoxCh`) */
  style?: React.CSSProperties;
  min?: number; max?: number; step?: number | string;
  placeholder?: string; readOnly?: boolean; disabled?: boolean; ariaLabel?: string;
  /**
   * The most decimal places the question accepts — 0 for whole numbers.
   * Refused at the keystroke, like the minus sign below, so the rule the
   * validator holds is the rule the respondent meets while typing.
   */
  decimals?: number;
}) {
  const external = value == null || value === "" ? "" : String(value);
  const [raw, setRaw] = React.useState(external);
  const focused = React.useRef(false);

  React.useEffect(() => {
    // don't yank the text out from under someone mid-keystroke
    if (focused.current) return;
    if (Number(raw) !== Number(external) || (raw === "") !== (external === "")) setRaw(external);
  }, [external]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (text: string) => {
    setRaw(text);
    if (text === "" || text === "-") return onChange(null);
    const n = Number(text);
    // "90." and "1e" are legitimate mid-typing states — keep them on screen
    // and simply don't push a value out until they parse
    if (Number.isFinite(n)) onChange(n);
  };

  return (
    <input
      className={className}
      style={style}
      type="text"
      inputMode={decimals === 0 ? "numeric" : "decimal"}
      id={id}
      aria-label={ariaLabel}
      aria-required={ariaRequired || undefined}
      value={raw}
      placeholder={placeholder}
      readOnly={readOnly}
      disabled={disabled}
      onFocus={() => { focused.current = true; }}
      onBlur={() => {
        focused.current = false;
        // normalise on the way out, so the stored value and the display agree
        const n = Number(raw);
        if (raw !== "" && Number.isFinite(n)) setRaw(String(n));
        else if (!Number.isFinite(n)) { setRaw(""); onChange(null); }
      }}
      onChange={(e) => {
        const t = e.target.value;
        // reject letters, keep the caret; a whole-number field takes digits only (no "1e2" — QT-02)
        if (t !== "" && !(decimals === 0 ? /^-?\d*$/ : /^-?\d*\.?\d*(e-?\d*)?$/i).test(t)) return;
        /*
         * A minus sign where the scale starts at zero or above. Currency and
         * Quantity seed `minValue: 0` precisely because a negative price or a
         * negative number of items is not a thing, and the validator refuses
         * it — but only after the respondent has typed it and pressed Next.
         * Refusing the keystroke is the same rule said earlier.
         */
        if (t.startsWith("-") && min != null && min >= 0) return;
        if (decimals != null) {
          const frac = /\.(\d*)/.exec(t)?.[1];
          if (frac != null && (decimals === 0 || frac.length > decimals)) return;
        }
        commit(t);
      }}
      data-decimals={decimals}
      data-min={min}
      data-max={max}
      data-step={step}
    />
  );
}

export function NumericInput(p: QRProps) {
  /*
   * A CURRENCY QUESTION NOW LOOKS LIKE ONE.
   *
   * The five numeric subtypes — open, integer, currency, percentage,
   * quantity — shared this renderer and differed only in their seeded min and
   * max, which is what the review meant by "most question types look and
   * function almost the same, with no clear differentiation". A currency
   * question drew no symbol at all and a percentage question drew no per
   * cent sign. One affix mechanism serves both, and `symbolSide` answers the
   * other half of the request: "₹ 1,000" or "1,000 ₹".
   */
  /*
   * A FIXED SYMBOL is the variant's, not the question's: a Percentage shows
   * "%" whatever its settings hold (only its side may be chosen), so a
   * percentage question saved before the symbol was seeded is still one.
   */
  const policy = resolveVariant(p.q.variant)?.numberInput;
  const affix = policy?.symbol === "fixed" && policy.fixedSymbol
    ? { text: policy.fixedSymbol, side: p.q.settings.symbolSide ?? "right" }
    : affixFor(p.q.settings);
  /*
   * THE AUTHOR'S TEXT BESIDE THE BOX — "kg [ 50 ]" or "[ 50 ] kg", any word
   * or symbol, in every Numeric subtype (October 2026 review). A Quantity's
   * older Unit is the same thing on the right (`customAffix`).
   */
  const custom = customAffix(p.q.settings);
  const customEl = (side: "left" | "right") => custom?.side === side
    ? <span className={`rs-affix-text ${side}`} data-testid={`numeric-affix-${side}`}>{custom.text}</span> : null;
  /*
   * FORMAT AND SIGN, said at the keystroke (October 2026 review). Whole
   * numbers are the `integer` rule or zero decimal places; "zero or more"
   * raises the floor the minus-sign refusal already reads.
   */
  const whole = p.q.validation.some((r) => r.kind === "integer") || p.q.settings.decimalPlaces === 0;
  const decimals = whole ? 0 : p.q.settings.decimalPlaces;
  const floor = p.q.settings.numberSign === "positive" ? Math.max(p.q.settings.minValue ?? 0, 0) : p.q.settings.minValue;
  /*
   * A STEPPER, for a question that counts things. The review asked for a
   * "dedicated quantity-style input design" with optional − / + buttons,
   * because a quantity in a plain number box is indistinguishable from every
   * other number in the survey. The buttons move by `step` and stop at the
   * question's own bounds, so they cannot produce a value the validator will
   * then refuse.
   */
  if (p.q.settings.stepper) {
    const step = p.q.settings.step ?? 1;
    const lo = floor;
    const hi = p.q.settings.maxValue;
    const cur = p.value == null || p.value === "" ? null : Number(p.value);
    const nudge = (dir: -1 | 1) => {
      if (p.q.settings.readOnly) return;
      const from = cur ?? (dir > 0 ? (lo ?? 0) - step : (hi ?? 0) + step);
      let next = from + dir * step;
      if (lo != null) next = Math.max(lo, next);
      if (hi != null) next = Math.min(hi, next);
      p.onChange(next);
    };
    return (
      <span className="rs-affixed" data-testid="numeric-affixed">
      {customEl("left")}
      <span className="rs-stepper" data-testid="numeric-stepper">
        <button type="button" aria-label="Decrease" data-testid="stepper-down"
          disabled={p.q.settings.readOnly || (cur != null && lo != null && cur <= lo)}
          onClick={() => nudge(-1)}>−</button>
        <NumberField
          className="rs-input rs-stepper-in"
          value={p.value}
          min={floor}
          max={hi}
          step={step}
          decimals={decimals}
          placeholder={p.q.settings.placeholder}
          readOnly={p.q.settings.readOnly}
          onChange={p.onChange}
        />
        <button type="button" aria-label="Increase" data-testid="stepper-up"
          disabled={p.q.settings.readOnly || (cur != null && hi != null && cur >= hi)}
          onClick={() => nudge(1)}>+</button>
      </span>
      {customEl("right")}
      </span>
    );
  }
  const field = (
    <NumberField
      value={p.value}
      min={floor}
      max={p.q.settings.maxValue}
      step={p.q.settings.step ?? (whole ? 1 : "any")}
      decimals={decimals}
      placeholder={p.q.settings.placeholder}
      readOnly={p.q.settings.readOnly}
      onChange={p.onChange}
    />
  );
  if (!affix && !custom) return field;
  return (
    <span className="rs-affixed" data-testid="numeric-affixed">
      {customEl("left")}
      {affix?.side === "left" && <span className="rs-prefix">{affix.text}</span>}
      {field}
      {affix?.side === "right" && <span className="rs-prefix">{affix.text}</span>}
      {customEl("right")}
    </span>
  );
}

/**
 * A PHONE NUMBER WITH ITS COUNTRY (October 2026 review). With a country
 * configured in the builder the respondent sees that country's code as a
 * fixed prefix and types the number — "the country-code dropdown should be
 * hidden because the country has already been configured". Without one they
 * pick their dialing code from a list, and the answer is stored as
 * "+<code> <number>", which the validator reads to apply that country's
 * format.
 */
export function PhoneInput({ value, onChange, country, readOnly, placeholder, ariaLabel, testid }: {
  value: unknown; onChange(v: string | null): void; country?: string;
  readOnly?: boolean; placeholder?: string; ariaLabel?: string; testid?: string;
}) {
  const text = value == null ? "" : String(value);
  /* no setting: the plain box every question authored before had, checked loosely */
  if (!country) {
    return (
      <input className="rs-input" type="tel" inputMode="tel" aria-label={ariaLabel} readOnly={readOnly}
        data-testid={testid ?? "phone-input"} placeholder={placeholder} value={text}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />
    );
  }
  const fixed = country !== PHONE_PICK ? DIAL_CODES.find((c) => c.code === country) : undefined;
  if (country !== PHONE_PICK) {
    return (
      <span className="rs-phone" data-testid={testid ?? "phone-input"} data-country={country}>
        {fixed && <span className="rs-prefix rs-phone-fixed" data-testid="phone-fixed-code">{fixed.flag} +{fixed.dial}</span>}
        <input className="rs-input" type="tel" inputMode="tel" aria-label={ariaLabel} readOnly={readOnly}
          placeholder={placeholder} value={text}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />
      </span>
    );
  }
  /* "+91 98765…" → the code and the rest; the longest dialing code that fits wins */
  const parsed = (() => {
    const m = /^\+(\d+)\s*(.*)$/.exec(text.trim());
    if (!m) return { code: "", number: text };
    const hit = [...DIAL_CODES].sort((a, b) => b.dial.length - a.dial.length).find((c) => m[1].startsWith(c.dial));
    return hit ? { code: hit.code, number: (m[1].slice(hit.dial.length) + (m[2] ? ` ${m[2]}` : "")).trim() } : { code: "", number: text };
  })();
  const [pick, setPick] = React.useState(parsed.code);
  React.useEffect(() => { if (parsed.code) setPick(parsed.code); }, [parsed.code]);
  const emit = (code: string, num: string) => {
    const dial = DIAL_CODES.find((c) => c.code === code)?.dial;
    const n = num.trim();
    onChange(n === "" ? null : dial ? `+${dial} ${n}` : n);
  };
  return (
    <span className="rs-phone" data-testid={testid ?? "phone-input"}>
      <select className="rs-select rs-phone-code" aria-label="Country code" disabled={readOnly}
        data-testid="phone-country-code" value={pick}
        onChange={(e) => { setPick(e.target.value); emit(e.target.value, parsed.number); }}>
        <option value="">Code</option>
        {DIAL_CODES.map((c) => <option key={c.code} value={c.code}>{c.flag} +{c.dial} {c.name}</option>)}
      </select>
      <input className="rs-input" type="tel" inputMode="tel" aria-label={ariaLabel} readOnly={readOnly}
        placeholder={placeholder ?? "Phone number"} value={parsed.number}
        onChange={(e) => emit(pick, e.target.value)} />
    </span>
  );
}

export function TextInput(p: QRProps) {
  const text = p.value == null ? "" : String(p.value);
  /* dictation gives focus back to the field when it ends (#16) */
  const ref = React.useRef<HTMLInputElement>(null);
  /* a question validated as a phone number with a country (or the code list) takes one the way a phone field does */
  if (p.q.validation.some((r) => r.kind === "phone") && p.q.settings.phoneCountry) {
    return (
      <PhoneInput value={p.value} onChange={p.onChange} country={p.q.settings.phoneCountry}
        readOnly={p.q.settings.readOnly} placeholder={p.q.settings.placeholder} />
    );
  }
  return (
    <div className="rs-textfield">
      <input
        ref={ref}
        className="rs-input"
        type="text"
        value={text}
        placeholder={p.q.settings.placeholder}
        readOnly={p.q.settings.readOnly}
        onChange={(e) => p.onChange(e.target.value)}
      />
      {/* `speech_input`, on by default: dictation writes into the SAME value, through the same onChange (the control decides whether it belongs here) */}
      <SpeechInputButton def={p.def} q={p.q} value={text} onChange={p.onChange} target={ref} />
    </div>
  );
}

export function LongText(p: QRProps) {
  const text = p.value == null ? "" : String(p.value);
  // Essay variants carry a min_length rule. Without a counter a respondent
  // types a sentence, is refused, and has no idea what the survey wants.
  const minLen = p.q.validation?.find((v) => v.kind === "min_length")?.value;
  const maxLen = p.q.validation?.find((v) => v.kind === "max_length")?.value;
  const min = Number(minLen);
  const short = Number.isFinite(min) && text.length < min;
  const ref = React.useRef<HTMLTextAreaElement>(null);
  return (
    <div>
      <textarea
        ref={ref}
        className="rs-textarea"
        value={text}
        placeholder={p.q.settings.placeholder}
        readOnly={p.q.settings.readOnly}
        maxLength={Number.isFinite(Number(maxLen)) ? Number(maxLen) : undefined}
        onChange={(e) => p.onChange(e.target.value)}
      />
      <SpeechInputButton def={p.def} q={p.q} value={text} onChange={p.onChange} target={ref} />
      {(Number.isFinite(min) || Number.isFinite(Number(maxLen))) && (
        <div className={`rs-counter ${short ? "short" : ""}`} data-testid="char-counter">
          {text.length}
          {Number.isFinite(min) ? ` / ${min} characters minimum` : ` / ${maxLen} characters`}
        </div>
      )}
    </div>
  );
}

/**
 * A DEFAULT VALUE, set once when the question is first shown with no answer
 * (Date Picker "Current Date / Custom Date", Time Picker "Current Time /
 * Custom Time" — October 2026 review). Read at that moment, so "current" is
 * the respondent's own day and clock. An answer already there — typed,
 * resumed, piped — is never replaced.
 */
function useInitialAnswer(p: QRProps, initial: () => string | null) {
  const done = React.useRef(false);
  React.useEffect(() => {
    if (done.current) return;
    done.current = true;
    if (p.value != null && p.value !== "") return;
    const v = initial();
    if (v) p.onChange(v);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * DATE PICKER. With a Date Format chosen, the date is shown and typed in that
 * format ("23/09/2026", "Sep 23, 2026") and a calendar button opens the
 * browser's picker; the answer is stored as YYYY-MM-DD either way. With no
 * format the native field stays exactly as it was.
 */
export function DateInput(p: QRProps) {
  useInitialAnswer(p, () => initialDateValue(p.q.settings));
  const fmt = p.q.settings.dateFormat;
  const stored = p.value == null ? "" : String(p.value);
  if (!fmt) {
    return (
      <input className="rs-input sm" type="date" value={stored} data-testid="date-input"
        min={p.q.settings.minDate} max={p.q.settings.maxDate}
        readOnly={p.q.settings.readOnly} onChange={(e) => p.onChange(e.target.value || null)} style={{ maxWidth: 190 }} />
    );
  }
  return (
    <FormattedDateField value={p.value} fmt={fmt} onChange={(v) => p.onChange(v)} readOnly={p.q.settings.readOnly}
      min={p.q.settings.minDate} max={p.q.settings.maxDate} testid="date-input" />
  );
}

/**
 * A DATE TYPED IN THE CHOSEN FORMAT, with the calendar one click away. Stored
 * as YYYY-MM-DD whatever is shown. The Date Picker and the From / To of a
 * Date/Time Range draw this same field, so the format chosen in the builder
 * is the format the respondent sees in both (October 2026 review: "the
 * current hard-coded MM/DD/YYYY should be removed").
 */
export function FormattedDateField({ value, fmt, onChange, readOnly, min, max, testid, label }: {
  value: unknown; fmt: DateFormat; onChange(v: string | null): void; readOnly?: boolean;
  min?: string; max?: string; testid: string; label?: string;
}) {
  const stored = value == null ? "" : String(value);
  const [text, setText] = React.useState(() => formatDateAs(stored, fmt));
  const [bad, setBad] = React.useState(false);
  const focused = React.useRef(false);
  const nativeRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (!focused.current) { setText(formatDateAs(stored, fmt)); setBad(false); }
  }, [stored, fmt]);
  return (
    <span className="rs-datefield" data-testid={testid} data-format={fmt}>
      <input className="rs-input sm" type="text" inputMode={/MMM/.test(fmt) ? "text" : "numeric"}
        placeholder={datePlaceholder(fmt)} aria-label={`${label ? `${label} — ` : ""}Date (${fmt})`} value={text}
        readOnly={readOnly} data-testid={`${testid === "date-input" ? "date" : testid}-text`}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; setBad(text.trim() !== "" && parseDateAs(text, fmt) == null); }}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const iso = parseDateAs(t, fmt);
          /* an unfinished or impossible date is no answer — never the previous one left standing */
          onChange(iso);
          if (iso) setBad(false);
        }} />
      <button type="button" className="rs-date-btn" aria-label="Open calendar" data-testid={`${testid === "date-input" ? "date" : testid}-calendar`}
        disabled={readOnly}
        onClick={() => {
          const el = nativeRef.current;
          if (!el) return;
          try { (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.(); } catch { el.focus(); }
        }}>📅</button>
      <input ref={nativeRef} type="date" className="rs-date-native" tabIndex={-1} aria-hidden
        min={min} max={max} value={stored}
        onChange={(e) => { const v = e.target.value || null; onChange(v); setText(formatDateAs(v, fmt)); setBad(false); }} />
      {bad && <span className="rs-date-hint" data-testid={`${testid === "date-input" ? "date" : testid}-format-hint`}>Please enter the date as {datePlaceholder(fmt)}.</span>}
    </span>
  );
}

/**
 * TIME PICKER. With a Time Format chosen, hour / minute (/ seconds) selectors
 * in 12- or 24-hour form; stored as 24-hour HH:MM(:SS). With no format the
 * native field stays exactly as it was.
 */
export function TimeInput(p: QRProps) {
  useInitialAnswer(p, () => initialTimeValue(p.q.settings));
  const fmt = p.q.settings.timeFormat;
  if (!fmt) {
    return (
      <input className="rs-input sm" type="time" value={p.value == null ? "" : String(p.value)} data-testid="time-input"
        step={p.q.settings.showSeconds ? 1 : undefined}
        readOnly={p.q.settings.readOnly} onChange={(e) => p.onChange(e.target.value || null)} style={{ maxWidth: 150 }} />
    );
  }
  return (
    <TimeSelects testid="time-input" label="Time" value={p.value} readOnly={p.q.settings.readOnly}
      hour12={fmt === "12"} seconds={!!p.q.settings.showSeconds}
      onChange={(v) => p.onChange(v)} />
  );
}

/**
 * Form-style list questions (reqs §3–5): labeled rows, each with its own
 * field type (email, phone, currency, date…) and validation. Answers store
 * keyed by row code; surveys without rows keep the legacy numbered inputs.
 */
export function ListInput(p: QRProps & { numeric: boolean }) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const cols = layoutColumns(p.q, resolveVariant(p.q.variant)?.renderer);
  /*
   * DATE/TIME RANGE (October 2026 review): the From / To ends use the range's
   * chosen format — a date format (MM/DD/YYYY by default) or 12 / 24-hour
   * time — instead of the browser's own mm/dd/yyyy. A form field outside a
   * range keeps its native input unless the author chose a format.
   */
  const isRange = p.q.variant === "datetime.date_range";
  const rangeFormats = {
    date: (p.q.settings.dateFormat ?? (isRange ? "MM/DD/YYYY" : undefined)) as DateFormat | undefined,
    time: p.q.settings.timeFormat ?? (isRange ? "12" : undefined),
  };

  if (view.rows.length > 0) {
    const vals = (p.value ?? {}) as Record<string, unknown>;
    const setField = (rc: string, v: unknown) => p.onChange({ ...vals, [rc]: v });
    /*
     * LABEL AND BOX (07-10 review, Suraj #6). The label column was a fixed
     * 150px, so "Age" sat a hand's width from its box. It is now as wide as
     * the longest label on this question (capped, so a sentence-long label
     * wraps rather than squeezing the boxes), and every box still starts in
     * one line. The author picks where the label goes: left of the box (the
     * layout surveys already had), right of it, or above it.
     */
    const labelPos = p.q.settings.fieldLabelPosition ?? "left";
    const longest = Math.max(1, ...view.rows.map((r) => stripTags(String(r.label ?? "")).length));
    const note = requiredFieldsNote(p.q, view.rows, p.ui);
    return (
      <div className="rs-fields" data-label-pos={labelPos}
        style={{ ["--rs-flab-ch" as string]: `${Math.min(longest, 28)}ch` }}>
        {/* the rule in words, not a star beside each label (Suraj #4) */}
        {note && <div className="rs-fields-note" data-testid="fields-required-note">{note}</div>}
      <div
        className={cols > 1 ? `rs-options cols-${cols}` : "rs-options"}
        style={{ maxWidth: cols > 1 ? undefined : 520 }}
      >
        {view.rows.map((row) => {
          const rc = String(row.code);
          const ft = row.fieldType ?? (p.numeric ? "number" : "text");
          const ip = fieldInputProps(ft, p.q.settings);
          const v = vals[rc];
          /*
           * BY ROW CODE, which the engine has always set on exactly these
           * errors — not by matching the row's label against the front of
           * the message.
           *
           * The old test was `e.startsWith(row.label)`, reading back a
           * prefix the validator had string-concatenated on. Two rows called
           * "Other" and "Other (please say)" took each other's errors, and
           * a message containing markup would not have matched at all.
           */
          const err = p.errors.find((e) => e.rowCode === rc);
          /*
           * A NUMERIC FIELD'S OWN TEXT AND A BOX ITS SIZE (October 2026
           * review, Numeric List): "Amount: [ 100 ] USD", "$ [ 250 ]" — per
           * field, left or right — and a box as wide as the number it takes,
           * worked out from the field's own bounds and decimals rather than
           * stretched across the card or set by hand.
           */
          const isNumeric = ["number", "decimal", "integer", "currency"].includes(ft);
          const own = isNumeric ? customAffix(row.meta as never) : null;
          const bound = (k: string) => { const r = (row.validation ?? []).find((x) => x.kind === k) as { value?: unknown } | undefined; const n = Number(r?.value); return r && Number.isFinite(n) ? n : null; };
          const boxCh = isNumeric ? numericBoxCh({ min: bound("min_value"), max: bound("max_value"), whole: ft === "integer", decimals: ft === "currency" ? 2 : null }) : null;
          return (
            <div key={rc} {...anchor("row", rc)}>
              <div className="rs-field-row" data-required={fieldIsRequired(p.q, row) || undefined}>
                <label className="flab" htmlFor={`${p.q.id}__f__${rc}`} id={`${p.q.id}__flab__${rc}`}>
                  <span dangerouslySetInnerHTML={{ __html: row.label }} />
                </label>
                <span className="rs-field-ctl">
                {own?.side === "left" && <span className="rs-affix-text left" data-testid={`field-affix-left-${rc}`}>{own.text}</span>}
                {ip.prefix && <span className="rs-prefix">{ip.prefix}</span>}
                {ip.multiline ? (
                  <textarea
                    className="rs-textarea"
                    id={`${p.q.id}__f__${rc}`}
                    aria-required={fieldIsRequired(p.q, row) || undefined}
                    style={{ minHeight: 60 }}
                    placeholder={row.placeholder}
                    value={v == null ? "" : String(v)}
                    readOnly={p.q.settings.readOnly}
                    onChange={(e) => setField(rc, e.target.value || null)}
                  />
                ) : ft === "phone" ? (
                  <PhoneInput value={v} onChange={(x) => setField(rc, x)}
                    country={typeof row.meta?.phoneCountry === "string" ? row.meta.phoneCountry : p.q.settings.phoneCountry}
                    readOnly={p.q.settings.readOnly} placeholder={row.placeholder}
                    ariaLabel={row.label.replace(/<[^>]*>/g, "")} testid={`phone-input-${rc}`} />
                ) : ft === "date" && rangeFormats.date ? (
                  /* a Date/Time Range draws both ends in its one chosen format */
                  <FormattedDateField value={v} fmt={rangeFormats.date} testid={`range-date-${rc}`}
                    label={row.label.replace(/<[^>]*>/g, "")} readOnly={p.q.settings.readOnly}
                    min={p.q.settings.minDate} max={p.q.settings.maxDate}
                    onChange={(x) => setField(rc, x)} />
                ) : ft === "time" && rangeFormats.time ? (
                  <TimeSelects testid={`range-time-${rc}`} label={row.label.replace(/<[^>]*>/g, "")}
                    value={v} readOnly={p.q.settings.readOnly}
                    hour12={rangeFormats.time === "12"} seconds={!!p.q.settings.showSeconds}
                    onChange={(x) => setField(rc, x)} />
                ) : ["number", "decimal", "integer", "currency"].includes(ft) ? (
                  <NumberField
                    className="rs-input rs-numbox"
                    id={`${p.q.id}__f__${rc}`}
                    ariaRequired={fieldIsRequired(p.q, row)}
                    placeholder={row.placeholder}
                    value={v}
                    readOnly={p.q.settings.readOnly}
                    decimals={ft === "integer" ? 0 : undefined}
                    style={{ width: `calc(${boxCh}ch + 26px)` }}
                    onChange={(n) => setField(rc, n)}
                  />
                ) : (
                  <input
                    className="rs-input"
                    id={`${p.q.id}__f__${rc}`}
                    aria-required={fieldIsRequired(p.q, row) || undefined}
                    type={ip.inputType}
                    inputMode={ip.inputMode as any}
                    placeholder={row.placeholder}
                    value={v == null ? "" : String(v)}
                    readOnly={p.q.settings.readOnly}
                    onChange={(e) => setField(rc, e.target.value === "" ? null : e.target.value)}
                  />
                )}
                {/* dictation into a text / long-text field, under the field's own key (the control skips every formatted field) */}
                <SpeechInputButton def={p.def} q={p.q} value={v == null ? "" : String(v)} compact
                  field={{ kind: "field", fieldType: ft, row }} label={stripTags(String(row.label ?? ""))}
                  onChange={(x) => setField(rc, x === "" ? null : x)} />
                {/* a symbol on the right when the author put it there */}
                {ip.suffix && <span className="rs-prefix">{ip.suffix}</span>}
                {own?.side === "right" && <span className="rs-affix-text right" data-testid={`field-affix-right-${rc}`}>{own.text}</span>}
                </span>
              </div>
              {err && <ValidationMessageText error={err} />}
            </div>
          );
        })}
      </div>
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
          {p.numeric ? (
            <NumberField
              className="rs-input"
              value={arr[i]}
              onChange={(n) => {
                const next = [...arr];
                while (next.length <= i) next.push(null);
                next[i] = n;
                p.onChange(next);
              }}
            />
          ) : (
            <>
            <input
              className="rs-input"
              type="text"
              value={arr[i] == null ? "" : String(arr[i])}
              onChange={(e) => {
                const next = [...arr];
                while (next.length <= i) next.push(null);
                next[i] = e.target.value === "" ? null : e.target.value;
                p.onChange(next);
              }}
            />
            <SpeechInputButton def={p.def} q={p.q} value={arr[i] == null ? "" : String(arr[i])} compact
              field={{ kind: "field", fieldType: "text" }} label={`${i + 1}`}
              onChange={(x) => {
                const cur: unknown[] = Array.isArray(p.value) ? [...(p.value as unknown[])] : [];
                while (cur.length <= i) cur.push(null);
                cur[i] = x === "" ? null : x;
                p.onChange(cur);
              }} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- NPS / slider */
export function Nps(p: QRProps) {
  /*
   * The scale comes from the variant's declared range, not straight from the
   * settings: an NPS is fixed 0–10 and a Likelihood Scale may be 0–15. Before
   * this, `maxValue` was whatever the editor had been allowed to store, so a
   * value of 50 drew fifty-one buttons.
   */
  const { min, max } = effectiveScale(p.q, { min: 0, max: 10 });
  // The label row has to be the same width as the button row, or the right
  // label drifts to the card edge — badly on short scales, where the buttons
  // occupy half the width. Wrapping both in one inline-block sizes the labels
  // to the scale rather than to the card.
  return (
    <div className="rs-nps-wrap">
      <div className="rs-nps">
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => {
          /*
           * A label on THIS point. The end labels say what the extremes
           * mean; the review asked to be able to say what 5 means too, which
           * is what a scale with a labelled midpoint needs.
           */
          const pointLabel = p.q.settings.scalePointLabels?.[String(n)];
          return (
            <span key={n} className={`rs-nps-point ${pointLabel ? "labelled" : ""}`}>
              <button
                type="button"
                {...anchor("scalepoint", n)}
                className={String(p.value) === String(n) ? "selected" : ""}
                aria-label={pointLabel ? `${n} — ${pointLabel}` : undefined}
                onClick={() => p.onChange(n)}
              >
                {n}
              </button>
              {pointLabel && <span className="rs-nps-point-label">{pointLabel}</span>}
            </span>
          );
        })}
      </div>
      <div className="rs-nps-labels">
        <span>{p.q.settings.npsLeftLabel ?? "Not at all likely"}</span>
        <span>{p.q.settings.npsRightLabel ?? "Extremely likely"}</span>
      </div>
    </div>
  );
}

/**
 * THE END LABELS GO UNDER THE ENDS, AND THE NUMBERS STAY.
 *
 * Both were wrong in the same line. `sliderLeftLabel ?? min` meant naming an
 * end REPLACED its number, and both sat inline on the track's own row, so a
 * label of any length ate the slider's width from both sides. The review:
 *
 *   "Currently, if the user sets Left Label: Not Satisfied and Right Label:
 *    Very Satisfied, the labels are displayed at the 0 and 100 positions of
 *    the slider. The labels should appear below the slider, aligned with
 *    their corresponding endpoints … the label text should not overlap or
 *    appear directly on top of the slider."
 *
 * So the track gets a row to itself at full width, the scale ends print
 * underneath it where they belong, and a named end prints under its number
 * rather than instead of it.
 */
export function Slider(p: QRProps) {
  const min = p.q.settings.minValue ?? 0;
  const max = p.q.settings.maxValue ?? 100;
  const val = p.value == null ? Math.round((min + max) / 2) : Number(p.value);
  const unit = affixFor(p.q.settings);
  const leftLabel = p.q.settings.sliderLeftLabel;
  const rightLabel = p.q.settings.sliderRightLabel;
  return (
    <div className="rs-slider">
      <div className="rs-slider-row">
        <input
          type="range" min={min} max={max} step={p.q.settings.step ?? 1} value={val}
          onChange={(e) => p.onChange(Number(e.target.value))}
        />
        {/*
          * The unit the review asked for when it proposed keeping one slider:
          * "add a unit/symbol toggle in Single Slider so the programmer can
          * optionally add %, points, or other symbols as required". It is the
          * same affix mechanism the numeric questions use, so there is one
          * place to set a symbol and one place that draws it.
          */}
        <span className="rs-slider-val">
          {unit?.side === "left" && <span className="rs-prefix">{unit.text}</span>}
          {p.value == null ? "—" : String(p.value)}
          {unit?.side === "right" && <span className="rs-prefix">{unit.text}</span>}
        </span>
      </div>
      <div className="rs-slider-scale" aria-hidden="true">
        <span className="rs-slider-end left">
          <span className="n">{min}</span>
          {leftLabel && <span className="lab">{leftLabel}</span>}
        </span>
        <span className="rs-slider-end right">
          <span className="n">{max}</span>
          {rightLabel && <span className="lab">{rightLabel}</span>}
        </span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- ranking */
/**
 * One component, three behaviours, driven by `settings.rankMode`:
 *
 *   click   rank as many as you like (the original behaviour)
 *   all     every item must be ranked — progress is shown
 *   top_n   only `maxSelections` items may be ranked; the rest lock once full
 *
 * Before this the three ranking variants were three labels over one identical
 * tap-to-rank list, and a required Rank-Top-N could never be completed because
 * validation demanded every item.
 */
export function Ranking(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const ranked: (string | number)[] = Array.isArray(p.value) ? (p.value as any) : [];
  const unranked = options.filter((o) => !ranked.some((r) => String(r) === String(o.code)));
  const mode = p.q.settings.rankMode ?? "all";
  const topN =
    mode === "top_n"
      ? Math.min(p.q.settings.maxSelections ?? options.length, options.length)
      : null;
  const full = topN != null && ranked.length >= topN;
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
      {(topN != null || mode === "all") && (
        <div className="rs-rank-progress" data-testid="rank-progress">
          {topN != null
            ? `${ranked.length} of ${topN} ranked`
            : `${ranked.length} of ${options.length} ranked`}
        </div>
      )}
      {ranked.map((code, i) => {
        const o = options.find((x) => String(x.code) === String(code));
        if (!o) return null;
        return (
          <div key={String(code)} className="rs-rank-item" {...anchor("option", code)}>
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
          {...anchor("option", o.code)}
          className={`rs-rank-item ${full ? "rs-rank-locked" : ""}`}
          style={{ cursor: full ? "not-allowed" : "pointer", opacity: full ? 0.45 : 0.85 }}
          aria-disabled={full}
          onClick={() => { if (!full) p.onChange([...ranked, o.code]); }}
        >
          <span className="rs-rank-num empty">–</span>
          <span dangerouslySetInnerHTML={{ __html: o.label }} />
          <span style={{ marginLeft: "auto", fontSize: "0.8em", color: "var(--rs-subtle)" }}>
            {full ? `top ${topN} chosen` : "tap to rank"}
          </span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- allocation */
export function Allocation(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const vals = (p.value ?? {}) as Record<string, number | null>;
  const total = Object.values(vals).reduce((a: number, b) => a + (Number(b) || 0), 0);
  const target = p.q.settings.sumTarget;
  return (
    <div style={{ maxWidth: 460 }}>
      {options.map((o) => (
        <div key={String(o.code)} className="rs-alloc-row" {...anchor("option", o.code)}>
          <span className="lbl" dangerouslySetInnerHTML={{ __html: o.label }} />
          <NumberField
            min={0}
            ariaLabel={o.label.replace(/<[^>]*>/g, "")}
            value={vals[String(o.code)]}
            onChange={(n) => p.onChange({ ...vals, [String(o.code)]: n })}
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
export function ImageSelect(p: QRProps & { multi?: boolean; ranking?: boolean }) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const vals: (string | number)[] = Array.isArray(p.value) ? (p.value as any) : p.value == null ? [] : [p.value as any];
  const click = (o: Option) => {
    if (p.ranking) {
      const on = vals.some((v) => String(v) === String(o.code));
      p.onChange(on ? vals.filter((v) => String(v) !== String(o.code)) : [...vals, o.code]);
    } else if (p.multi) {
      /*
       * `toggleMultiValue`, like every other multi-select path in this file.
       * This branch was a raw push/filter, which is why the review found
       * that an Exclusive option on an Image Multi-Select could be held
       * alongside other answers: exclusivity lives in `toggleMultiValue`,
       * and this was the one selection path that never called it. The same
       * omission meant `maxSelections` was not enforced here either — the
       * setting was read only to decide single versus multi.
       */
      p.onChange(toggleMultiValue(vals, o.code, options, p.q.settings.maxSelections));
    } else {
      p.onChange(o.code);
    }
  };
  return (
    <div className="rs-imggrid" style={gridColumnsStyle(p, "repeat(auto-fill, minmax(150px, 1fr))")}>
      {options.map((o) => {
        const idx = vals.findIndex((v) => String(v) === String(o.code));
        const sel = idx >= 0;
        return (
          <div key={String(o.code)} className={`rs-imgopt ${sel ? "selected" : ""}`} onClick={() => click(o)} {...anchor("option", o.code)}>
            {o.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <SafeImage src={o.imageUrl} display={o.imageDisplay} alt={o.imageAlt ?? o.label.replace(/<[^>]*>/g, "")} />
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
/**
 * A GRID'S HEADER, DRAWN AGAIN EVERY N ROWS (07-10 review, Prince #2) — see
 * the engine's `headerRepeatEvery`. Every grid with a header row uses these
 * two, so the setting means the same thing on all of them. The repeat is
 * the same header cells, hidden from assistive technology (the real header
 * still labels every cell); no column and no data is added.
 */
export function headerEveryFor(p: QRProps, rowCount: number): number | null {
  return headerRepeatApplies(p.q) ? headerRepeatEvery(p.q.settings.headerRepeat, rowCount) : null;
}
export function RepeatedHeaderRow({ index, every, count, children }: { index: number; every: number | null; count: number; children: React.ReactNode }) {
  if (!headerRepeatsBefore(index, every, count)) return null;
  return <tr className="rs-header-repeat" aria-hidden="true" data-testid="header-repeat">{children}</tr>;
}

/** A categorical grid with at most this many scale points stacks on a phone (OR-02). */
export const MATRIX_STACK_MAX = 7;

export function Matrix(p: QRProps) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const colOpts = view.columns[0]?.options?.length ? view.columns[0].options : view.options;
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const setRow = (row: string, v: unknown) => p.onChange({ ...vals, [row]: v });
  const type = p.q.type;

  const headCells = (repeat: boolean) => (
    <>
      <th className="rowlabel"></th>
      {type === "matrix_numeric" || type === "matrix_text" || type === "matrix_dropdown"
        ? <th scope="col">{view.columns[0]?.label ?? "Answer"}</th>
        : colOpts.map((o) => <th key={String(o.code)} scope="col" {...(repeat ? {} : anchor("column", o.code))} dangerouslySetInnerHTML={{ __html: o.label }} />)}
    </>
  );
  const every = headerEveryFor(p, view.rows.length);
  /*
   * OR-02: on a phone a categorical grid cannot stay a grid — at 390 px the
   * scale columns past the third were clipped inside `.rs-table-wrap` with
   * nothing to say they were there. A single/multi-select matrix of up to
   * MATRIX_STACK_MAX scale points therefore STACKS at <= 480 px (each row a
   * block, every control carrying its own caption); a wider one keeps the
   * grid, with a sticky row label and a "scroll" hint instead.
   */
  const categorical = type === "matrix_single" || type === "matrix_multi";
  const stack = categorical && colOpts.length <= MATRIX_STACK_MAX;
  const plainLabel = (s: string) => s.replace(/<[^>]*>/g, "");
  const cellLabel = (rowLabel: string, o: Option) => `${plainLabel(rowLabel)}: ${plainLabel(o.label)}`;
  return (
    <div className="rs-table-wrap" data-matrix-scroll={categorical && !stack ? "hint" : undefined}>
      {categorical && !stack && <div className="rs-scrollhint" aria-hidden="true" data-testid="matrix-scroll-hint">Scroll sideways to see every option →</div>}
      <table className={`rs-matrix${stack ? " rs-matrix-stack" : ""}`} data-stack={stack ? "true" : undefined}>
        <thead>
          <tr>{headCells(false)}</tr>
        </thead>
        <tbody>
          {view.rows.map((row, ri) => {
            const rc = String(row.code);
            const rowVal = vals[rc];
            return (
              <React.Fragment key={rc}>
              <RepeatedHeaderRow index={ri} every={every} count={view.rows.length}>{headCells(true)}</RepeatedHeaderRow>
              <tr {...anchor("row", rc)}>
                {/* RUNTIME-09: a td (not th) so the cell keeps its look; role="rowheader" gives it th scope="row" semantics */}
                <td className="rowlabel" role="rowheader" {...anchor("row", rc)}><RowLabel {...p} row={row} /></td>
                {type === "matrix_single" &&
                  colOpts.map((o) => (
                    <td key={String(o.code)} {...cellAnchor(rc, o.code)}>
                      <label className="rs-mcell">
                        <input type="radio" name={`${p.q.id}_${rc}`}
                          aria-label={cellLabel(row.label, o)}
                          checked={String(rowVal) === String(o.code)}
                          onChange={() => setRow(rc, o.code)} />
                        <span className="rs-mcap" aria-hidden="true">{plainLabel(o.label)}</span>
                      </label>
                    </td>
                  ))}
                {type === "matrix_multi" &&
                  colOpts.map((o) => {
                    const arr = (Array.isArray(rowVal) ? rowVal : []) as (string | number)[];
                    const on = arr.some((v) => String(v) === String(o.code));
                    return (
                      <td key={String(o.code)} {...cellAnchor(rc, o.code)}>
                        <label className="rs-mcell">
                          <input type="checkbox" checked={on}
                            aria-label={cellLabel(row.label, o)}
                            onChange={() => setRow(rc, toggleMultiValue(arr, o.code, colOpts))} />
                          <span className="rs-mcap" aria-hidden="true">{plainLabel(o.label)}</span>
                        </label>
                      </td>
                    );
                  })}
                {type === "matrix_numeric" && (
                  <td>
                    <NumberField className="rs-input"
                      ariaLabel={`${plainLabel(row.label)}: ${plainLabel(view.columns[0]?.label ?? "Answer")}`}
                      value={rowVal}
                      onChange={(n) => setRow(rc, n)} />
                  </td>
                )}
                {type === "matrix_text" && (
                  <td>
                    {/* dictation per cell, shown while the cell has focus (#16) — the column keeps its width */}
                    <SpeechCell def={p.def} q={p.q} value={rowVal == null ? "" : String(rowVal)} onChange={(x) => setRow(rc, x)}
                      label={plainLabel(row.label)} columnType="text">
                      {(ref) => (
                        <input ref={ref} className="rs-input" type="text"
                          aria-label={`${plainLabel(row.label)}: ${plainLabel(view.columns[0]?.label ?? "Answer")}`}
                          value={rowVal == null ? "" : String(rowVal)}
                          onChange={(e) => setRow(rc, e.target.value)} />
                      )}
                    </SpeechCell>
                  </td>
                )}
                {type === "matrix_dropdown" && (
                  <td>
                    <select className="rs-select" value={rowVal == null ? "" : String(rowVal)}
                      aria-label={`${plainLabel(row.label)}: ${plainLabel(view.columns[0]?.label ?? "Answer")}`}
                      onChange={(e) => setRow(rc, e.target.value || null)}>
                      <option value="">—</option>
                      {colOpts.map((o) => (
                        <option key={String(o.code)} value={String(o.code)} {...anchor("option", o.code)}>{o.label.replace(/<[^>]*>/g, "")}</option>
                      ))}
                    </select>
                  </td>
                )}
              </tr>
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------- composite (multi-column, §3) */
/**
 * A SLIDER COLUMN THAT IS A SLIDER.
 *
 * `slider` has been an offered column response type since the column editor
 * was written, and both cell renderers sent it to a number box — so an author
 * who chose Column Slider, set Min 0 and Max 100 and pressed Preview got an
 * empty text field indistinguishable from the Numeric column next to it. The
 * review reported it as "it shows an empty input box where the respondent can
 * manually enter a value", which is precisely what it did.
 *
 * The range needs both ends to mean anything, so a column that has not been
 * given them keeps the number box rather than drawing a 0–100 slider the
 * author never asked for.
 */
export function SliderCell({
  min, max, step, value, onChange, label, readOnly,
}: {
  min?: number; max?: number; step?: number;
  value: unknown; onChange(v: unknown): void; label: string; readOnly?: boolean;
}) {
  const lo = min ?? 0;
  const hi = max ?? 100;
  const current = value == null || value === "" ? null : Number(value);
  return (
    <span className="rs-cellslider">
      <input
        type="range" aria-label={label}
        min={lo} max={hi} step={step ?? 1}
        disabled={readOnly}
        value={current ?? Math.round((lo + hi) / 2)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="rs-cellslider-val">{current == null ? "—" : String(current)}</span>
    </span>
  );
}

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
            <option key={String(o.code)} value={String(o.code)} {...anchor("option", o.code)}>{o.label.replace(/<[^>]*>/g, "")}</option>
          ))}
        </select>
      );
    case "multi_dropdown":
      /* checkboxes in a popover that stays open — see cellMultiDropdown.tsx */
      return <CellMultiDropdown col={col} readOnly={ro} label={col.label.replace(/<[^>]*>/g, "")} value={value} onChange={onChange} />;
    case "slider":
      if (col.min != null && col.max != null) {
        return (
          <SliderCell label={col.label.replace(/<[^>]*>/g, "")} readOnly={ro}
            min={col.min} max={col.max} step={col.step}
            value={value} onChange={onChange} />
        );
      }
    // falls through: a slider with no bounds has nothing to slide between
    case "numeric":
      return (
        <NumberField className="rs-input" readOnly={ro} min={col.min} max={col.max}
          placeholder={col.placeholder}
          value={value}
          onChange={onChange} />
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
    case "text":
    default: {
      const long = col.responseType === "longtext";
      const text = value == null ? "" : String(value);
      /* dictation per cell (#16); a read-only column never takes it */
      if (ro) return long
        ? <textarea className="rs-textarea" style={{ minHeight: 50 }} readOnly value={text} onChange={(e) => onChange(e.target.value)} />
        : <input className="rs-input" type="text" readOnly placeholder={col.placeholder} value={text} onChange={(e) => onChange(e.target.value)} />;
      return (
        <SpeechCell def={p.def} q={p.q} value={text} onChange={(x) => onChange(x)} label={col.label.replace(/<[^>]*>/g, "")}
          columnType={long ? "longtext" : "text"} validation={col.validation ?? []}>
          {(ref) => long
            ? <textarea ref={ref} className="rs-textarea" style={{ minHeight: 50 }} value={text} onChange={(e) => onChange(e.target.value)} />
            : <input ref={ref} className="rs-input" type="text" placeholder={col.placeholder} value={text} onChange={(e) => onChange(e.target.value)} />}
        </SpeechCell>
      );
    }
  }
}

export function Composite(p: QRProps) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const vals = (p.value ?? {}) as Record<string, Record<string, unknown>>;
  const setCell = (row: string, col: string, v: unknown) =>
    p.onChange({ ...vals, [row]: { ...(vals[row] ?? {}), [col]: v } });
  const headCells = (repeat: boolean) => (
    <>
      <th className="rowlabel"></th>
      {view.columns.map((c) => (
        <th key={c.id} scope="col" {...(repeat ? {} : anchor("column", c.id))} style={c.width ? { width: c.width } : undefined}
          dangerouslySetInnerHTML={{ __html: c.label }} />
      ))}
    </>
  );
  const every = headerEveryFor(p, view.rows.length);
  return (
    <div className="rs-table-wrap">
      <table className="rs-matrix">
        <thead>
          <tr>{headCells(false)}</tr>
        </thead>
        <tbody>
          {view.rows.map((row, ri) => (
            <React.Fragment key={String(row.code)}>
            <RepeatedHeaderRow index={ri} every={every} count={view.rows.length}>{headCells(true)}</RepeatedHeaderRow>
            <tr {...anchor("row", row.code)}>
              <td className="rowlabel" role="rowheader"><RowLabel {...p} row={row} /></td>
              {view.columns.map((c) => (
                <td key={c.id} {...cellAnchor(String(row.code), c.id)}>
                  <CompositeCell col={c} p={p}
                    value={vals[String(row.code)]?.[c.id]}
                    onChange={(v) => setCell(String(row.code), c.id, v)} />
                </td>
              ))}
            </tr>
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------- design-driven task questions */
function DesignTasks(p: QRProps) {
  /* MaxDiff: the last best/worst conflict the respondent ran into, per task (MD-P1, see the radios below) */
  const [mdNotice, setMdNotice] = React.useState<Record<string, string>>({});
  const design = p.def.designs.find((d) => d.id === p.q.settings.designRef);
  if (!design?.file?.rows?.length) {
    return <div className="rs-error-msg">Design file “{p.q.settings.designRef}” not generated yet.</div>;
  }
  // a menu design is a menu, whichever variant the question stored
  if (design.kind === "menu" && variantRenderers.menutasks) {
    const Menu = variantRenderers.menutasks;
    return <Menu {...p} />;
  }
  /* F4 2026-10-22: a rating-based (CVA) design is rated, not chosen from — whichever variant the question stored */
  if (design.kind === "cva" && variantRenderers.cvatasks) {
    const Cva = variantRenderers.cvatasks;
    return <Cva {...p} />;
  }
  const allRows = design.file.rows as Record<string, unknown>[];
  /*
   * THE VERSION THIS RESPONDENT ANSWERS.
   *
   * This used to be `String(r.version ?? "1") === "1"` — hardcoded — so a
   * design generated in four blocks fielded only the first one, and the
   * analysis's version lookup always fell through to "1". The engine now
   * derives it from the response seed (designVersion.ts), which is why it
   * survives a resume and is recoverable from the stored response.
   */
  const rows = designRowsFor(p.q, allRows, p.state.seed, p.state.calculated);
  const tasks = [...new Set(rows.map((r) => String(r.task)))];
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const isMaxdiff = p.q.type === "maxdiff_task";
  /*
   * Whether this design is anchored is a property of the DESIGN, not of the
   * question — the generator decides it and the analysis has to agree — so it
   * is read from the design's own config, which is the schema's declared home
   * for generator configuration. An imported design that says nothing is
   * standard, which is what every design before this was.
   */
  const anchorCfg = (design.config ?? {}) as { anchored?: boolean; anchorPrompt?: string };
  const anchored = isMaxdiff && anchorCfg.anchored === true;
  const anchorPrompt =
    (anchorCfg.anchorPrompt ?? "").trim() ||
    "Thinking about the items in this set, how many of them are important to you?";
  const attrCols = design.file.columns.filter(
    (c) => !["version", "task", "alt", "is_holdout", "none_option", "position", "item_index", "item_label", "practice"].includes(c),
  );
  /*
   * MAXDIFF METHOD AND WORDING (MD-P1), from the design's config like the
   * anchor: best-only or best-and-worst, the column labels, instructions, and
   * the practice task (task rows with `practice` = 1). Absent keys are the
   * standard best-worst task this has always rendered.
   */
  const mdCfg = (design.config ?? {}) as { responseMode?: string; bestLabel?: string; worstLabel?: string; instructions?: string };
  const bestOnly = isMaxdiff && mdCfg.responseMode === "best_only";
  const bestLabel = (mdCfg.bestLabel ?? "").trim() || "Most";
  const worstLabel = (mdCfg.worstLabel ?? "").trim() || "Least";
  const mdInstructions = isMaxdiff ? (mdCfg.instructions ?? "").trim() : "";
  const practiceTasks = new Set(rows.filter((r) => Number(r.practice) === 1).map((r) => String(r.task)));
  const realTasks = tasks.filter((t) => !practiceTasks.has(t));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {mdInstructions && <div className="rs-md-instructions" data-testid="md-instructions">{mdInstructions}</div>}
      {tasks.map((t) => {
        // the design fixes which concepts share a task, not the order they
        // appear in; position effects are real, so the order is rolled per
        // respondent per task and the None option stays last
        const alts = shuffleAlternatives(
          rows.filter((r) => String(r.task) === t),
          p.state.seed,
          `${p.q.id}:${t}`,
        );
        return (
          <div key={t} className="rs-card" style={{ margin: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 10 }} data-testid={isMaxdiff ? `md-task-${t}` : undefined}>
              {isMaxdiff && practiceTasks.has(t) ? "Practice task (not counted)"
                : isMaxdiff ? `Task ${realTasks.indexOf(t) + 1} of ${realTasks.length}` : `Task ${tasks.indexOf(t) + 1} of ${tasks.length}`}
            </div>
            <div className="rs-table-wrap">
              <table className={isMaxdiff ? "rs-matrix rs-md" : "rs-matrix rs-matrix-stack rs-cbc"} data-testid={isMaxdiff ? `md-table-${t}` : `cbc-task-${t}`}>
                <thead>
                  <tr>
                    {isMaxdiff ? (
                      <>
                        {!bestOnly && <th>{worstLabel}</th>}<th className="rowlabel">Item</th><th>{bestLabel}</th>
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
                      /*
                       * An item cannot be both best and worst. The opposite radio used to
                       * be DISABLED for the chosen item, which prevented the pair but said
                       * nothing, and made "I meant this one as least" a two-step undo. Now
                       * the new pick wins, the other side is cleared, and the task says
                       * why (MD-P1). The engine refuses the pair regardless (METHOD-01).
                       */
                      const isBest = cur.best != null && String(cur.best) === altKey;
                      const isWorst = cur.worst != null && String(cur.worst) === altKey;
                      const label = String(alt.item_label ?? altKey);
                      const pick = (side: "best" | "worst") => {
                        const other = side === "best" ? "worst" : "best";
                        const next: Record<string, unknown> = { ...cur, [side]: altKey };
                        let notice = "";
                        if (cur[other] != null && String(cur[other]) === altKey) {
                          delete next[other];
                          notice = `“${label}” can't be both ${bestLabel} and ${worstLabel}. It is now your ${side === "best" ? bestLabel : worstLabel} choice — pick a different item for ${other === "best" ? bestLabel : worstLabel}.`;
                        }
                        setMdNotice((m) => ({ ...m, [t]: notice }));
                        p.onChange({ ...vals, [t]: next });
                      };
                      return (
                        <tr key={altKey} data-testid="md-item" data-task={t} data-item={altKey} data-position={i + 1}>
                          {!bestOnly && (
                            <td>
                              <label className="rs-md-pick">
                                <input type="radio" name={`${p.q.id}_${t}_worst`}
                                  aria-label={`${worstLabel}: ${label}`}
                                  checked={isWorst}
                                  onChange={() => pick("worst")} />
                              </label>
                            </td>
                          )}
                          <td className="rowlabel">{label}</td>
                          <td>
                            <label className="rs-md-pick">
                              <input type="radio" name={`${p.q.id}_${t}_best`}
                                aria-label={`${bestLabel}: ${label}`}
                                checked={isBest}
                                onChange={() => pick("best")} />
                            </label>
                          </td>
                        </tr>
                      );
                    }
                    /*
                     * CBC (conjoint audit 2026-10-17). The STORED value is the design
                     * alternative (`alt`) — the concept's identity — while the LABEL is
                     * the screen position (Option A, B, C…). It used to print the design
                     * number, so a shuffled task read "Option 3, Option 1, Option 2".
                     * Each attribute cell carries its attribute name for the phone layout
                     * (rs-matrix-stack: one card per alternative, every level captioned).
                     */
                    const isNone = Number(alt.none_option) === 1;
                    const noneText = String((design.config as { noneLabel?: unknown } | undefined)?.noneLabel ?? "").trim() || "None of these";
                    /* F4 2026-10-22: a LABELLED design names each alternative by its brand */
                    const lab = design.config as { labelled?: boolean; brandAttribute?: string } | undefined;
                    const brandCol = lab?.labelled ? (attrCols.find((c) => c === lab.brandAttribute) ?? attrCols.find((c) => /^brand/i.test(c)) ?? attrCols[0]) : undefined;
                    const optLabel = isNone ? noneText : brandCol && alt[brandCol] ? String(alt[brandCol]) : `Option ${i < 26 ? String.fromCharCode(65 + i) : i + 1}`;
                    const isChosen = vals[t] != null && String(vals[t]) === altKey;
                    return (
                      <tr key={altKey} className={isChosen ? "rs-cbc-chosen" : undefined} data-testid="cbc-alt"
                        data-task={t} data-alt={altKey} data-position={i + 1} data-none={isNone ? "1" : undefined}>
                        <td className="rowlabel">{optLabel}</td>
                        {attrCols.map((a) => <td key={a} data-label={a}>{isNone || alt[a] === "" ? "—" : String(alt[a] ?? "")}</td>)}
                        <td className="rs-cbc-choose">
                          <label className="rs-cbc-pick">
                            <input type="radio" name={`${p.q.id}_${t}`} aria-label={`Choose ${optLabel}`}
                              data-testid={`cbc-choose-${t}-${altKey}`}
                              checked={isChosen}
                              onChange={() => p.onChange({ ...vals, [t]: altKey })} />
                            <span className="rs-mcap" aria-hidden="true">Choose</span>
                          </label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!isMaxdiff && <DualResponseFollowUp def={p.def} q={p.q} task={t} value={vals} onChange={p.onChange} readOnly={!!p.q.settings.readOnly} />}
            {isMaxdiff && mdNotice[t] && (
              <div role="status" className="rs-md-notice rs-error-msg" data-testid={`md-conflict-${t}`} style={{ marginTop: 8 }}>
                {mdNotice[t]}
              </div>
            )}
            {isMaxdiff && anchored && (
              /*
               * ANCHORED (DUAL-RESPONSE) MAXDIFF (§17).
               *
               * Best-worst scaling is purely relative: an item can top the
               * ranking and still matter to nobody. This follow-up places an
               * absolute threshold at utility zero, so the analysis can say
               * which items clear the bar. It is asked per task, immediately
               * under the set it refers to — "these" has to mean the items
               * the respondent is still looking at.
               */
              <div className="rs-anchor" style={{ marginTop: 12 }}>
                <div style={{ marginBottom: 6 }}>{anchorPrompt}</div>
                <div role="radiogroup" aria-label={anchorPrompt} style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                  {ANCHOR_CHOICES.map((choice) => {
                    const cur = (vals[t] ?? {}) as { anchor?: string };
                    return (
                      <label key={choice.value} className="rs-anchor-choice" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="radio" name={`${p.q.id}_${t}_anchor`}
                          value={choice.value}
                          checked={cur.anchor === choice.value}
                          data-testid={`md-anchor-${t}-${choice.value}`}
                          onChange={() => p.onChange({ ...vals, [t]: { ...(vals[t] as object ?? {}), anchor: choice.value } })}
                        />
                        <span>{choice.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The dual-response scale.
 *
 * Three points rather than a rating, because that is what identifies the
 * anchor without adding a scale to model: "all" says every item in the set
 * beat the threshold, "none" says none did, and "some" — the common answer —
 * says the best one did and the worst one did not. Each is a constraint the
 * choice model can use directly.
 */
export const ANCHOR_CHOICES: { value: string; label: string }[] = [
  { value: "all", label: "All of them are important to me" },
  { value: "some", label: "Some of them are" },
  { value: "none", label: "None of them are" },
];

/* ------------------------------------------- variant renderers (families) */

/** Button Select / Button Multi-Select — large tap targets, exclusive-aware. */
export function ChoiceButtons(p: QRProps & { multi: boolean }) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const { filtered, searchBox } = useOptionFilter(options, 25, p.ui, p.q.settings.optionSearch);
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
      {/* the same layout as the radio/checkbox list above: a number of columns, one by default,
          or "horizontal row" — the buttons' own wrapping row */}
      <div className={`rs-choicebtns ${
        p.q.settings.optionOrientation === "horizontal" ? "horizontal" : `cols-${layoutColumns(p.q, "buttons")}`
      }`}>
        {filtered.map((o) => {
          const sel = vals.some((v) => String(v) === String(o.code));
          return (
            <button key={String(o.code)} type="button" {...anchor("option", o.code)}
              className={`rs-choicebtn ${sel ? "selected" : ""}`}
              aria-pressed={sel}
              onClick={() => pick(o)}>
              <span dangerouslySetInnerHTML={{ __html: o.label }} />
            </button>
          );
        })}
      </div>
      <OtherSpecifyBox {...p} options={options} selected={vals} />
    </div>
  );
}

/** Card / Tile Select — title, optional description (option.meta.description)
 *  and optional image, single or multi. */
export function ChoiceCards(p: QRProps & { multi: boolean }) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const vals: (string | number)[] = p.multi
    ? Array.isArray(p.value) ? (p.value as any) : []
    : p.value == null ? [] : [p.value as any];
  const pick = (o: Option) => {
    if (p.q.settings.readOnly) return;
    if (p.multi) p.onChange(toggleMultiValue(vals, o.code, options, p.q.settings.maxSelections));
    else p.onChange(String(p.value) === String(o.code) ? null : o.code);
  };
  const cols = layoutColumns(p.q, "cards");
  return (
    <div>
    <div className={`rs-cardgrid cols-${cols}`}>
      {options.map((o) => {
        const sel = vals.some((v) => String(v) === String(o.code));
        const desc = (o.meta?.description as string) ?? "";
        return (
          <div key={String(o.code)} {...anchor("option", o.code)}
            className={`rs-cardopt ${sel ? "selected" : ""}`}
            role={p.multi ? "checkbox" : "radio"}
            aria-checked={sel}
            tabIndex={0}
            onClick={() => pick(o)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(o); } }}>
            {o.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <SafeImage src={o.imageUrl} display={o.imageDisplay} alt={o.imageAlt ?? o.label.replace(/<[^>]*>/g, "")} />
            )}
            <div className="rs-cardopt-title" dangerouslySetInnerHTML={{ __html: o.label }} />
            {desc && <div className="rs-cardopt-desc" dangerouslySetInnerHTML={{ __html: desc }} />}
            <span className="rs-cardopt-check">{sel ? "✓" : ""}</span>
          </div>
        );
      })}
    </div>
    <OtherSpecifyBox {...p} options={options} selected={vals} />
    </div>
  );
}

/** Star Rating — numeric 1..max. */
export function StarRating(p: QRProps) {
  /*
   * This used to be `Math.min(maxValue ?? 5, 10)` — a silent clamp. The
   * editor accepted 50, the renderer drew 10, the counter said "/ 10" and
   * the validator accepted up to 50. The clamp is the same; what changed is
   * that the editor now refuses the value in the first place, and the
   * validator asks for the same pair of numbers this does.
   */
  const { min, max } = effectiveScale(p.q, { min: 1, max: 10 });
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

/**
 * Emoji scales, hand-picked per length so the expressions read as an even
 * progression rather than a mechanical interpolation. Anything longer than
 * the largest curated set falls back to sampling the 11-point scale.
 */
const EMOJI_SCALES: Record<number, string[]> = {
  2: ["😠", "😍"],
  3: ["😠", "😐", "😍"],
  4: ["😠", "😕", "🙂", "😍"],
  /* the 5- and 10-point progressions the September review specified by name:
     "1 to 5  😡 → 😞 → 😐 → 🙂 → 😍" and the ten-row table running
     Very Dissatisfied → Extremely Happy */
  5: ["😡", "😞", "😐", "🙂", "😍"],
  6: ["😡", "😠", "😕", "😐", "🙂", "😍"],
  7: ["😡", "😠", "😕", "😐", "🙂", "😃", "😍"],
  8: ["😡", "😠", "☹️", "😕", "😐", "🙂", "😃", "😍"],
  9: ["😡", "😠", "☹️", "😕", "😐", "🙂", "😊", "😃", "😍"],
  10: ["😡", "😠", "😞", "😕", "😐", "🙂", "😊", "😃", "😄", "🤩"],
  11: ["😡", "😠", "☹️", "😕", "😟", "😐", "🙂", "😊", "😃", "🤩", "😍"],
};

export function emojiScale(count: number): string[] {
  if (count <= 1) return ["😐"];
  const exact = EMOJI_SCALES[count];
  if (exact) return exact;
  const base = EMOJI_SCALES[11];
  return Array.from({ length: count }, (_, i) =>
    base[Math.round((i / (count - 1)) * (base.length - 1))],
  );
}

/**
 * Emoji / Smiley Rating. The face count follows the configured min–max, so a
 * 1–10 scale renders ten faces; it previously drew a hardcoded five whatever
 * the editor said, which made the bounds fields quietly meaningless.
 */
export function EmojiRating(p: QRProps) {
  const { min, max } = effectiveScale(p.q, { min: 1, max: 10 });
  const count = Math.max(1, Math.min(11, max - min + 1));
  const faces = emojiScale(count);
  const val = p.value == null ? null : Number(p.value);
  return (
    <div className="rs-emoji" role="radiogroup" aria-label="Rating">
      {faces.map((e, i) => {
        const score = min + i;
        /*
         * "The user should be able to configure or edit the emoji labels if
         * required." The per-point label editor the Studio already offers for
         * this renderer writes `settings.scalePointLabels`, so an author who
         * types their own face (or a word) for a point gets it drawn here
         * instead of the built-in progression. Unset points keep the default.
         */
        const custom = p.q.settings.scalePointLabels?.[String(score)];
        const face = custom?.trim() ? custom : e;
        return (
          <button key={score} type="button" {...anchor("scalepoint", score)}
            className={val === score ? "on" : ""}
            aria-label={custom?.trim() ? `${custom} (${score} of ${max})` : `${score} of ${max}`}
            title={custom?.trim() ? `${score} — ${custom}` : String(score)}
            onClick={() => p.onChange(val === score ? null : score)}>
            {face}
          </button>
        );
      })}
      {(p.q.settings.npsLeftLabel || p.q.settings.npsRightLabel) && (
        <div className="rs-nps-labels" style={{ width: "100%" }}>
          <span>{p.q.settings.npsLeftLabel}</span>
          <span>{p.q.settings.npsRightLabel}</span>
        </div>
      )}
    </div>
  );
}

/** Searchable single-select dropdown (autocomplete / combobox). */
export function SearchableSingle(p: QRProps) {
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
            placeholder={uiOf(p, "search_options", { n: options.length })}
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="rs-msd-list" role="listbox">
            {filtered.length === 0 && <div style={{ padding: 8, color: "var(--rs-subtle)" }}>No matches</div>}
            {filtered.map((o) => (
              <div key={String(o.code)} {...anchor("option", o.code)}
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
export function SwipeDeck(p: QRProps) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const remaining = view.rows.filter((r) => vals[String(r.code)] === undefined);
  const current = remaining[0];
  const done = view.rows.length - remaining.length;
  const [drag, setDrag] = React.useState<{ x: number; active: boolean }>({ x: 0, active: false });
  const startX = React.useRef(0);

  const leftOpt = view.options[0];
  const rightOpt = view.options[view.options.length - 1];

  // The deck's cards ARE the question's rows. With none configured the "done"
  // branch below rendered the notorious "All 0 cards judged ✓" instead of
  // saying what is missing.
  if (view.rows.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="swipe-no-cards">
        This swipe deck has no cards yet — add them in the question’s
        <strong> Rows </strong> section. Each row becomes one card; the options
        are the two verdicts.
      </div>
    );
  }

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

  const tilt = Math.max(-14, Math.min(14, drag.x / 10));
  const verdict = drag.x > 40 ? rightOpt : drag.x < -40 ? leftOpt : null;
  /*
   * THE CARD'S CONTENT (October 2026 review): image, title, subtitle,
   * description, price and extra fields — `CardFace`, shared with the other
   * two decks. The interaction is unchanged; a card that only has a label
   * draws as it always did. A sized / proportioned frame is applied once the
   * programmer chooses one, or once the card carries more than its label.
   */
  const framed = !!(p.q.settings.cardAspect || p.q.settings.cardSize || current.meta?.subtitle || current.meta?.description || current.meta?.price || (current.meta?.fields as unknown[] | undefined)?.length);
  const showButtons = p.q.settings.swipeButtons !== false;

  return (
    <div className="rs-swipe">
      <div className="rs-swipe-progress">{done + 1} / {view.rows.length}</div>
      <div className={`rs-swipe-stack ${framed ? "framed" : ""}`}>
        {remaining[1] && <div className="rs-swipe-card behind" />}
        <div
          className={`rs-swipe-card ${framed ? cardFrameClass(p.q.settings, "3:4") : ""}`}
          data-testid="swipe-card"
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
          <CardFace row={current} settings={p.q.settings} />
          {verdict && (
            <div className={`rs-swipe-verdict ${drag.x > 0 ? "right" : "left"}`}>
              {verdict.label.replace(/<[^>]*>/g, "")}
            </div>
          )}
        </div>
      </div>
      <div className="rs-swipe-actions">
        {showButtons && leftOpt && (
          <button type="button" className="rs-swipe-btn left"
            onClick={() => judge(String(current.code), leftOpt.code)}>
            <span dangerouslySetInnerHTML={{ __html: leftOpt.label }} />
          </button>
        )}
        {done > 0 && (
          <button type="button" className="rs-swipe-btn undo" onClick={undo} title="Undo last">↩</button>
        )}
        {showButtons && rightOpt && rightOpt !== leftOpt && (
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
export function DragRank(p: QRProps) {
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
          <div key={String(code)} {...anchor("option", code)}
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
export function SemanticDifferential(p: QRProps) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const setRow = (rc: string, v: unknown) => p.onChange({ ...vals, [rc]: v });
  /*
   * THE SCALE POINTS, NAMED ABOVE THEIR COLUMNS (07-10 review). A bipolar
   * grid drew its points as bare radios with no header at all, so there was
   * nothing to keep in view on a long one (Prince #2) and nothing telling a
   * respondent which circle was 4.
   */
  const headCells = (repeat: boolean) => (
    <>
      <th className="rowlabel" />
      {view.options.map((o) => <th key={String(o.code)} scope="col" {...(repeat ? {} : anchor("column", o.code))} className="rs-semantic-head" dangerouslySetInnerHTML={{ __html: o.label }} />)}
      <th className="rowlabel" />
    </>
  );
  const every = headerEveryFor(p, view.rows.length);
  return (
    <div className="rs-table-wrap">
      <table className="rs-matrix rs-semantic">
        <thead><tr>{headCells(false)}</tr></thead>
        <tbody>
          {view.rows.map((row, ri) => {
            const rc = String(row.code);
            const [left, right] = row.label.split("|").map((x) => x.trim());
            return (
              <React.Fragment key={rc}>
              <RepeatedHeaderRow index={ri} every={every} count={view.rows.length}>{headCells(true)}</RepeatedHeaderRow>
              <tr {...anchor("row", rc)}>
                <td className="rowlabel" style={{ textAlign: "right" }} {...anchor("row", rc)}
                  dangerouslySetInnerHTML={{ __html: left ?? row.label }} />
                {view.options.map((o) => (
                  <td key={String(o.code)} {...cellAnchor(rc, o.code)}>
                    <label style={{ display: "block", cursor: "pointer", padding: 2 }} title={o.label.replace(/<[^>]*>/g, "")}>
                      <input type="radio" name={`${p.q.id}_${rc}`}
                        aria-label={`${[left, right].filter(Boolean).map((x) => String(x).replace(/<[^>]*>/g, "")).join(" – ") || row.label.replace(/<[^>]*>/g, "")}: ${o.label.replace(/<[^>]*>/g, "")}`}
                        checked={String(vals[rc]) === String(o.code)}
                        onChange={() => setRow(rc, o.code)} />
                    </label>
                  </td>
                ))}
                <td className="rowlabel"
                  dangerouslySetInnerHTML={{ __html: right ?? "" }} />
              </tr>
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Single-item carousel: browse option cards one at a time, select one. */
export function CarouselSelect(p: QRProps) {
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
            <SafeImage src={o.imageUrl} display={o.imageDisplay} alt={o.imageAlt ?? o.label.replace(/<[^>]*>/g, "")} />
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

/**
 * Image hotspot / click heatmap (coordinates model): click up to N points on
 * the stimulus image; each point stores as {x, y} percentages so results are
 * resolution-independent. Click a marker to remove it.
 */
export function HotspotClick(p: QRProps) {
  const pts: { x: number; y: number }[] = Array.isArray(p.value) ? (p.value as any) : [];
  const max = p.q.settings.maxSelections ?? 1;
  const img = p.q.settings.imageUrl;
  if (!img) {
    return <div className="rs-error-msg">No stimulus image configured — set the image URL in the editor.</div>;
  }
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (p.q.settings.readOnly) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    const next = [...pts, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }];
    p.onChange(max === 1 ? next.slice(-1) : next.slice(0, max));
  };
  const removeAt = (i: number, e: React.MouseEvent) => {
    e.stopPropagation();
    p.onChange(pts.filter((_, j) => j !== i));
  };
  return (
    <div>
      <div className="rs-hotspot" onClick={onClick} role="img" aria-label="Click to place a point">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <SafeImage src={img} alt="" draggable={false} imageOnly />
        {pts.map((pt, i) => (
          <span key={i} className="rs-hotspot-pin"
            style={{ left: `${pt.x}%`, top: `${pt.y}%` }}
            title="click to remove"
            onClick={(e) => removeAt(i, e)}>
            {max > 1 ? i + 1 : ""}
          </span>
        ))}
      </div>
      <div className="rs-hotspot-status">
        {pts.length} / {max} point{max > 1 ? "s" : ""} placed
        {pts.length > 0 && (
          <button type="button" className="rs-hotspot-clear" onClick={() => p.onChange([])}>clear</button>
        )}
      </div>
    </div>
  );
}

/** Side-by-side image comparison: large image cards, pick one. */
export function CompareImages(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  return (
    <div className="rs-compare"
      style={gridColumnsStyle(p, `repeat(${Math.min(options.length, 4)}, 1fr)`)}>
      {options.map((o) => {
        const sel = String(p.value) === String(o.code);
        return (
          <div key={String(o.code)} {...anchor("option", o.code)}
            className={`rs-cardopt rs-compare-card ${sel ? "selected" : ""}`}
            role="radio" aria-checked={sel} tabIndex={0}
            onClick={() => p.onChange(sel ? null : o.code)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onChange(sel ? null : o.code); } }}>
            {o.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <SafeImage src={o.imageUrl} display={o.imageDisplay} alt={o.imageAlt ?? o.label.replace(/<[^>]*>/g, "")} style={{ height: 220 }}/>
            ) : (
              <div className="rs-compare-noimg">🖼</div>
            )}
            <div className="rs-cardopt-title" dangerouslySetInnerHTML={{ __html: o.label }} />
            <span className="rs-cardopt-check">{sel ? "✓" : ""}</span>
          </div>
        );
      })}
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

/**
 * THE MEDIA UNDER A QUESTION — one image or video, or several.
 *
 * `questionMediaList` decides what is shown (several `mediaItems`, else the
 * single `mediaUrl`), so the builder, the Studio preview, Test Survey and the
 * live survey draw the same list. Several items sit side by side
 * (`mediaLayout: "horizontal"`, wrapping on a narrow screen) or stacked.
 *
 * The stimulus is described by what the programmer wrote, and only silently
 * when they said it is decorative: an item's own alt, else the question's
 * alt text, else the question text.
 */
function QuestionMedia({ q, anchor: a, decorative, altText }: {
  q: Question; anchor: AuthoringAnchor; decorative: boolean; altText?: string;
}) {
  const list = questionMediaList(q);
  if (!list.length) return null;
  const fallbackAlt = decorative ? "" : (altText ?? stripHtmlText(q.text));
  const layout = list.length > 1 ? (q.settings.mediaLayout ?? "vertical") : "single";
  return (
    <div className={`rs-qmedia rs-qmedia-${layout}`} data-testid="rs-qmedia" data-count={list.length} {...a}>
      {list.map((m, i) => (
        <div key={`${i}:${m.url}`} className="rs-qmedia-item" data-testid="rs-qmedia-item">
          <MediaEmbed
            url={m.url}
            display={q.settings.mediaDisplay}
            title={m.title ?? stripHtmlText(q.text)}
            alt={m.alt ?? fallbackAlt}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Renderers that display `settings.mediaUrl` themselves as their stimulus
 * (the media family tracks playback on it); every other question shows the
 * media under its text through one MediaEmbed.
 */
const MEDIA_OWNING_RENDERERS = new Set(["videorating", "videotimeline", "watchtime", "audiorec", "base:media_timeline", "videointerview", "base:video_interview"]);

/**
 * The question with its media URLs piped.
 *
 * Every variant reads `q.settings.imageUrl` / `mediaUrl` straight off the
 * question, so resolving the tokens once here is what makes a personalised
 * stimulus work everywhere at once — a hotspot image, a video, a pack shot —
 * rather than in whichever renderer someone remembered to change. Option
 * images are piped in the engine's own pipeline, beside their labels.
 */
function withPipedMedia(p: QRProps, ctx: EvalContext): QRProps {
  const media = resolveQuestionMedia(p.q, ctx);
  if (media.imageUrl === p.q.settings.imageUrl && media.mediaUrl === p.q.settings.mediaUrl && media.mediaItems === p.q.settings.mediaItems) return p;
  return { ...p, q: { ...p.q, settings: { ...p.q.settings, ...media } } };
}

/* ------------------------------------------------------------------ shell */
export function QuestionRenderer(props: QRProps) {
  /*
   * A MESSAGE WHEN AN OPTION IS SELECTED, FOR EVERY CHOICE RENDERER AT ONCE.
   * The change handler is wrapped here, once, so a radio list, a checkbox
   * list, a dropdown, buttons, cards and an image select all announce a
   * selected option the same way without any of them knowing. The selection
   * is made first and is never undone; only options ADDED by the change are
   * looked at, so deselecting says nothing.
   */
  const gated: QRProps = React.useMemo(() => ({
    ...props,
    onChange: (v: unknown) => {
      const before = props.value;
      props.onChange(v);
      announceSelection(props.def, props.q, props.state, props.loop, before, v);
    },
  }), [props]);
  const p = withPipedMedia(gated, ctxOf(gated));
  const ctx = ctxOf(p);
  /*
   * `settings.accessibility` has been in the schema, and in the properties
   * panel, since the variant batch — and no renderer had ever read it. It is
   * read here, once, for every question type.
   */
  const a11y = p.q.settings.accessibility;
  /*
   * Sanitised at render as well as at save (the "defence in depth" html.ts
   * promised and this file never did): a definition written by an API
   * client, an import, or before the editor sanitised is injected raw
   * otherwise. Piped values are already escaped by resolvePiping; a text
   * with no markup is returned untouched.
   */
  /*
   * sanitised (the author's own stylesheet kept), unwrapped, its CSS scoped to
   * this question, then players placed and pictures that piped to nothing
   * dropped — `renderRichContent`, the one pipeline for a question's content
   */
  const textScope = `${p.q.id}-text`;
  const instructionScope = `${p.q.id}-instruction`;
  const text = renderRichContent(resolvePiping(p.q.text, ctx), textScope, { allowFrames: p.q.type === "html" });
  const instruction = p.q.instruction ? renderRichContent(resolvePiping(p.q.instruction, ctx), instructionScope) : null;
  /*
   * A TEXT THAT CARRIES ITS OWN STYLESHEET IS A DOCUMENT, NOT A HEADING.
   * The question text normally reads as a heading (weight, size, colour);
   * an author who writes `<style>` beside a chess board or a table has
   * styled it themselves, and inherits plain body text instead — the same
   * result a Text / HTML block gives the same HTML (October 2026 review).
   */
  const textIsDocument = hasStyleBlock(text);
  /* inserted media laid out as a carousel gets its ← → and dots (`mediaCarousel.ts`) */
  const cardRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => enhanceMediaCarousels(cardRef.current?.closest<HTMLElement>(".rs-card") ?? cardRef.current), [text, instruction]);

  // Variant renderer dispatch (family/variant architecture). Questions
  // without a variant — every pre-existing survey — fall through to the
  // base-type switch below unchanged.
  const variantDef = resolveVariant(p.q.variant);
  const variantBody = ((): React.ReactNode | null => {
    // 2026-09 batch: renderers live in ./variants/<family>.tsx and register
    // themselves by key, so adding one never touches this file. A base type
    // with no variant (a legacy question, or one created from JSON) finds its
    // default renderer under `base:<type>`.
    const Registered =
      (variantDef?.renderer && variantRenderers[variantDef.renderer]) ||
      variantRenderers[`base:${p.q.type}`];
    if (Registered) return <Registered {...p} />;
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
      case "hotspotclick":
        return <HotspotClick {...p} />;
      case "compare":
        return <CompareImages {...p} />;
      default:
        return null;
    }
  })();

  /*
   * The central "Other, specify" box — see `rendersOwnOtherBox`. It is a
   * no-op (null) unless the answer actually selects a flagged option, so it
   * costs nothing on the questions that have none.
   */
  const otherFallback = rendersOwnOtherBox(p.q, variantDef?.renderer)
    ? null
    : <OtherSpecifyFallback {...p} />;

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
    case "hotspot": body = <HotspotClick {...p} />; break;
    case "conjoint_task":
    case "maxdiff_task": body = <DesignTasks {...p} />; break;
    case "custom_component": body = <CustomComponent {...p} />; break;
    case "html":
      return (
        <div
      className="rs-card"
      data-qid={p.q.id}
      role="group"
      aria-label={a11y?.ariaLabel}
      aria-describedby={a11y?.describedBy ?? (p.errors.length ? `${p.q.id}__err` : undefined)}
      aria-invalid={p.errors.length > 0 || undefined}
      {...anchor("question", p.q.id)}
    >
          {/* the block's content IS its text (`normalizeQuestionContent` moved any legacy HTML Content there) */}
          <div {...anchor("text")} className="rs-qhtml" ref={cardRef} {...{ [SCOPE_ATTR]: textScope }} dangerouslySetInnerHTML={{ __html: text }} />
          {/* a content block's media was configured in the builder and never drawn (Prince 11 §4) */}
          <QuestionMedia q={p.q} anchor={anchor("media")} decorative={!!a11y?.decorative} altText={a11y?.altText} />
        </div>
      );
    default:
      /*
       * OR-01: a type nothing registered (a typo, `constant_sum`, a plugin
       * that is not loaded) used to fall through to a TEXT BOX, collecting
       * free text for a question that was meant to be something else. Say so
       * instead. A registered type with no dedicated component keeps the text
       * input it has always had.
       */
      body = questionTypeRegistry.has(p.q.type)
        ? <TextInput {...p} />
        : (
          <div className="rs-unsupported" role="note" data-testid="rs-unsupported" data-qtype={p.q.type}>
            This question type is not supported by this version.
          </div>
        );
  }

  // one place, after every dispatch path — see `rendersOwnOtherBox`
  if (otherFallback) body = <>{body}{otherFallback}</>;

  return (
    <div
      className="rs-card"
      data-qid={p.q.id}
      role="group"
      aria-label={a11y?.ariaLabel}
      aria-describedby={a11y?.describedBy ?? (p.errors.length ? `${p.q.id}__err` : undefined)}
      aria-invalid={p.errors.length > 0 || undefined}
      {...anchor("question", p.q.id)}
    >
      {p.q.customCss && <style dangerouslySetInnerHTML={{ __html: p.q.customCss }} />}
      <span ref={cardRef} hidden aria-hidden />
      {/*
        * ABOVE THE QUESTION, when the author asked for it.
        *
        * The default is unchanged and stays at the bottom, which is where a
        * respondent who has just pressed Next is looking. "above" is for the
        * long grid whose foot is off the screen by the time the page comes
        * back with an error on it — there, the message below is a message
        * nobody sees.
        */}
      {p.q.settings.validationPosition === "above" && (
        <ValidationBlock id={`${p.q.id}__err`} errors={p.errors} />
      )}
      {textIsDocument ? (
        <div className="rs-qtext rs-qhtml" {...anchor("text")}>
          <div {...{ [SCOPE_ATTR]: textScope }} dangerouslySetInnerHTML={{ __html: text }} />
          {p.q.required && <span className="rs-required">*</span>}
        </div>
      ) : (
        <p className="rs-qtext" {...anchor("text")}>
          <span {...{ [SCOPE_ATTR]: textScope }} dangerouslySetInnerHTML={{ __html: text }} />
          {p.q.required && <span className="rs-required">*</span>}
        </p>
      )}
      {instruction && (hasStyleBlock(instruction)
        ? <div className="rs-qinstruction rs-qhtml" {...anchor("instruction")} {...{ [SCOPE_ATTR]: instructionScope }} dangerouslySetInnerHTML={{ __html: instruction }} />
        : <p className="rs-qinstruction" {...anchor("instruction")} {...{ [SCOPE_ATTR]: instructionScope }} dangerouslySetInnerHTML={{ __html: instruction }} />)}
      {!MEDIA_OWNING_RENDERERS.has(variantDef?.renderer ?? `base:${p.q.type}`) && (
        <QuestionMedia q={p.q} anchor={anchor("media")} decorative={!!a11y?.decorative} altText={a11y?.altText} />
      )}
      {body}
      {/* announced when it appears, and named by the question that owns it */}
      {p.q.settings.validationPosition !== "above" && (
        <ValidationBlock id={`${p.q.id}__err`} errors={p.errors} />
      )}
    </div>
  );
}
