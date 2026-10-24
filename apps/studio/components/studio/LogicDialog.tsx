"use client";
import React from "react";
import { createPortal } from "react-dom";
import {
  type DraftState, openDraft, editDraft, isDirty, saveBlockedReason, requestClose, keepEditing, commitDraft, reconcileSaved,
} from "@/lib/logicDialog/draft";
import { type LogicSurface, LOGIC_SURFACE_EVENT, DEFAULT_LOGIC_SURFACE, readLogicSurface, writeLogicSurface } from "@/lib/logicDialog/surface";
import "./logicDialog.css";

/**
 * The per-browser preference: does the Properties panel keep its inline
 * builders ("inline", the default) or show summaries only and edit everything
 * in the workspace ("workspace")? See lib/logicDialog/surface.ts. Read after
 * mount (SSR renders the default), re-read when any dialog changes it.
 */
export function useLogicSurface(): LogicSurface {
  const [surface, setSurface] = React.useState<LogicSurface>(DEFAULT_LOGIC_SURFACE);
  React.useEffect(() => {
    const read = () => setSurface(readLogicSurface(typeof localStorage === "undefined" ? null : localStorage));
    read();
    window.addEventListener(LOGIC_SURFACE_EVENT, read);
    window.addEventListener("storage", read);
    return () => { window.removeEventListener(LOGIC_SURFACE_EVENT, read); window.removeEventListener("storage", read); };
  }, []);
  return surface;
}

export function setLogicSurface(next: LogicSurface): void {
  writeLogicSurface(typeof localStorage === "undefined" ? null : localStorage, next);
  window.dispatchEvent(new Event(LOGIC_SURFACE_EVENT));
}

/**
 * THE NARROW SURFACES. The Properties panel (and the Architect inspector that
 * hosts it) and the Survey Flow node cards wrap themselves in this; inside it,
 * with the default "workspace" preference, a rule builder renders as its
 * summary + "Edit logic ⤢" (`useCompactLogic`). The dialog body resets it to
 * `false`, so the workspace always shows the full builders.
 */
const CompactScope = React.createContext(false);
export function CompactLogicScope({ on = true, children }: { on?: boolean; children: React.ReactNode }) {
  return <CompactScope.Provider value={on}>{children}</CompactScope.Provider>;
}
export function useCompactLogic(): boolean {
  const surface = useLogicSurface();
  return React.useContext(CompactScope) && surface === "workspace";
}

/**
 * THE LOGIC WORKSPACE — one centred dialog for every rule builder in the Studio.
 *
 * The client's review (23 Oct 2026, item 3, with the Qualtrics "Display logic
 * (…)" dialog as the sample): "when we select a question and open the
 * Properties section to apply logic, the logic configuration box appears in
 * the right corner, making it difficult to manage complex logic and nested
 * conditions. Display the logic configuration box in the centre of the frame
 * as a pop-up or modal window with more space."
 *
 * This is that window, and it is deliberately generic: it knows nothing about
 * conditions, skip rules or auto-punch. It owns
 *
 *   · the DRAFT — `value` is cloned on open, edits land on the clone, Save
 *     hands it back through the caller's own `onSave` (the same `onChange` /
 *     `patch` the inline editor uses, so the stored shape and the engine are
 *     untouched), Cancel discards it (lib/logicDialog/draft.ts);
 *   · the FRAME — `role="dialog"`, `aria-modal`, a focus trap, Escape and the
 *     backdrop ask "discard?" when the draft is dirty, the body scrolls on its
 *     own inside a box that never outgrows the viewport, and under 720px it
 *     becomes a full-screen sheet;
 *   · the CHROME — a feature title plus the subject ("Display logic — Q5: Which
 *     brand do you use?"), one line of explanation, a footer slot for the
 *     feature's own extras, and Cancel / Save (Save enabled once something
 *     changed and the caller's `validate` has no objection).
 *
 * What goes INSIDE is the existing builder, rendered through the `children`
 * render-prop with the draft and its setter — `ConditionEditor` in its wide
 * layout, the skip-rule list, the validation-rule list, the punch rules, a
 * flow branch's paths. The dialog is portalled to <body>, so it is centred on
 * the window whatever panel opened it; React context (the Studio store, the
 * loop scope) crosses the portal.
 */

export interface LogicDialogProps<T> {
  /** the feature: "Display logic", "Skip logic", "Validation rules" … */
  title: string;
  /** what it is about: "Q5 — Which brand do you use?" */
  subject?: string;
  /** one line under the title: "Display this question only if the following condition is met:" */
  description?: React.ReactNode;
  /** the saved value the draft starts from (and reopens on) */
  value: T;
  /** Save: commit the draft through the caller's own updater */
  onSave(next: T): void;
  /** called after Save and after Cancel/Discard — the caller unmounts the dialog */
  onClose(): void;
  /** the builder, over the draft */
  children(draft: T, setDraft: (next: T | ((d: T) => T)) => void): React.ReactNode;
  /** a reason Save must stay disabled, or nothing */
  validate?(draft: T): string | null | undefined;
  /** feature-specific footer extras (left of Cancel / Save) */
  footer?: React.ReactNode | ((draft: T, setDraft: (next: T | ((d: T) => T)) => void) => React.ReactNode);
  testId?: string;
  saveLabel?: string;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function LogicDialog<T>(props: LogicDialogProps<T>) {
  const { title, subject, description, value, onSave, onClose, children, validate, footer, testId = "logic-dialog", saveLabel = "Save" } = props;
  const [state, setState] = React.useState<DraftState<T>>(() => openDraft(value));
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const opener = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const descId = React.useId();

  /* the saved value changed under us (undo, a collaborator): a clean draft follows it, a dirty one is kept */
  React.useEffect(() => { setState((s) => reconcileSaved(s, value)); }, [value]);

  const setDraft = React.useCallback((next: T | ((d: T) => T)) => setState((s) => editDraft(s, next)), []);
  const dirty = isDirty(state);
  const blocked = saveBlockedReason(state, validate);

  const close = React.useCallback(() => onClose(), [onClose]);
  const askClose = React.useCallback(() => {
    setState((s) => {
      const r = requestClose(s);
      if (r.close) queueMicrotask(close);
      return r.state;
    });
  }, [close]);
  const discard = () => close();
  const save = () => {
    if (blocked) return;
    const { value: next } = commitDraft(state);
    onSave(next);
    close();
  };

  /*
   * FOCUS: remember who opened us, move focus inside, keep it inside, give
   * it back on close. Tab from the last control wraps to the first and
   * Shift+Tab from the first wraps to the last; Escape asks to close.
   */
  React.useEffect(() => {
    opener.current = (document.activeElement as HTMLElement | null) ?? null;
    const first = bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      opener.current?.focus?.();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    /* a workspace opened FROM this one (a count's "each item must meet") is portalled
       to <body>, but React still bubbles its keys here — they are its business, not ours */
    if (!dialogRef.current?.contains(e.target as Node)) return;
    /* a plain modal opened from inside the workspace (the validation message's text editor) owns its own keys */
    if ((e.target as HTMLElement).closest?.(".modal-back")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); askClose(); return; }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) { e.preventDefault(); dialogRef.current.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  const surface = useLogicSurface();

  if (typeof document === "undefined") return null;

  const footerNode = typeof footer === "function" ? (footer as (d: T, s: typeof setDraft) => React.ReactNode)(state.draft, setDraft) : footer;

  return createPortal(
    <div className="ld-back" data-testid={`${testId}-backdrop`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) askClose(); }}>
      <div ref={dialogRef} className="ld" role="dialog" aria-modal="true" tabIndex={-1}
        aria-labelledby={titleId} aria-describedby={description ? descId : undefined}
        data-testid={testId} data-dirty={dirty ? "1" : "0"} onKeyDown={onKeyDown}>
        <div className="ld-head">
          <div className="ld-head-text">
            <h2 className="ld-title" id={titleId} data-testid={`${testId}-title`}>
              {title}{subject ? <span className="ld-subject"> — {subject}</span> : null}
            </h2>
            {description && <p className="ld-desc" id={descId}>{description}</p>}
          </div>
          {dirty && <span className="chip ld-dirty" data-testid={`${testId}-dirty`} title="Changes here are not in the survey until you save">● unsaved changes</span>}
          <button type="button" className="ld-x" data-testid={`${testId}-close`} aria-label="Close" title="Close (Esc)" onClick={askClose}>×</button>
        </div>
        <div ref={bodyRef} className="ld-body logic-wide" data-testid={`${testId}-body`}>
          <CompactLogicScope on={false}>{children(state.draft, setDraft)}</CompactLogicScope>
        </div>
        <div className="ld-foot">
          {state.confirmingDiscard ? (
            <div className="ld-confirm" data-testid={`${testId}-confirm`} role="alertdialog" aria-live="assertive">
              <span>Discard unsaved changes?</span>
              <button type="button" className="btn small" data-testid={`${testId}-keep`} autoFocus
                onClick={() => setState((s) => keepEditing(s))}>Keep editing</button>
              <button type="button" className="btn small danger" data-testid={`${testId}-discard`} onClick={discard}>Discard</button>
            </div>
          ) : (
            <>
              <div className="ld-foot-extra">
                {footerNode}
                {/* the one preference: keep the Properties panel to summaries and edit logic here */}
                <label className="row ld-surface-pref" style={{ gap: 5, fontSize: 12.5 }}
                  title="Off (the default): the Properties panel and the flow cards show each rule set as a read-only summary with “Edit logic ⤢”; all logic is edited in this workspace. On: the narrow builders are shown in the panel as well.">
                  <input type="checkbox" data-testid={`${testId}-surface-pref`} checked={surface === "inline"}
                    onChange={(e) => setLogicSurface(e.target.checked ? "inline" : "workspace")} />
                  Also show the builders in the Properties panel
                </label>
              </div>
              <button type="button" className="btn" data-testid={`${testId}-cancel`} onClick={askClose}>
                {dirty ? "Cancel" : "Close"}
              </button>
              <button type="button" className="btn primary" data-testid={`${testId}-save`} disabled={!!blocked}
                title={blocked ?? "Save these changes to the survey"} onClick={save}>
                {saveLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The button that opens a workspace — the same glyph and wording everywhere,
 * so a programmer learns it once. `compact` is the icon-only form for a
 * crowded header row.
 */
export function WorkspaceButton({ onClick, label = "Edit logic", title, testId = "logic-workspace-open", compact, className }: {
  onClick(): void; label?: string; title?: string; testId?: string; compact?: boolean; className?: string;
}) {
  return (
    <button type="button" className={`btn small ld-open${className ? ` ${className}` : ""}`} data-testid={testId}
      title={title ?? "Open this logic in a larger, centred workspace — edits are saved when you press Save"}
      aria-label={compact ? label : undefined} onClick={onClick}>
      {compact ? null : <>{label} </>}<span aria-hidden="true" className="ld-open-glyph">⤢</span>
    </button>
  );
}

/**
 * The compact strip a Properties section shows for a feature whose editing
 * surface is the workspace: a one-line reading, a count, and the button.
 */
export function WorkspaceSummary({ text, count, countNoun, onOpen, testId = "logic-summary-strip", openLabel, children }: {
  text?: string; count?: number; countNoun?: string; onOpen(): void; testId?: string; openLabel?: string; children?: React.ReactNode;
}) {
  return (
    <div className="ld-strip" data-testid={testId}>
      <div className="ld-strip-text">
        {count !== undefined && <span className="ld-strip-count" data-testid={`${testId}-count`}>{count} {countNoun ?? (count === 1 ? "rule" : "rules")}</span>}
        {text ? <span className="ld-strip-sentence">{text}</span> : null}
        {children}
      </div>
      <WorkspaceButton onClick={onOpen} label={openLabel} />
    </div>
  );
}
