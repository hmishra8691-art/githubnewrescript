/**
 * THE LOGIC WORKSPACE'S DRAFT — the part of `LogicDialog` that has nothing to
 * do with React, so it can be tested in Node.
 *
 * A logic dialog edits a COPY. The saved value (a display-logic condition, a
 * list of skip rules, a flow branch …) is cloned when the dialog opens; every
 * edit lands on the clone; Save hands the clone back through the caller's
 * ordinary `onChange`, and Cancel throws it away. Nothing here knows what the
 * value is — the same state machine serves every rule type in the Studio.
 *
 * Why a draft and not live commits: the inline builders commit on every
 * keystroke (and always will — a programmer editing in place expects that).
 * A workspace is different: it invites a longer edit of something complex,
 * and losing a stray click's worth of half-built nested logic to the
 * autosave — or to a collaborator's screen — is worse than asking for a Save.
 */

export interface DraftState<T> {
  /** what the survey holds — the value Cancel returns to */
  saved: T;
  /** what the dialog is editing */
  draft: T;
  /** a discard confirmation is being shown (the dialog was asked to close while dirty) */
  confirmingDiscard: boolean;
}

/**
 * A structural copy. `structuredClone` where it exists (Node 17+, every
 * browser the Studio supports); JSON otherwise. Both lose functions, which a
 * stored survey value never carries — the schema is plain data.
 */
export function cloneValue<T>(v: T): T {
  if (v === undefined) return v;
  if (typeof structuredClone === "function") return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * JSON with keys in a fixed order, so `{a:1,b:2}` and `{b:2,a:1}` compare
 * equal — a builder that rebuilds an object on edit must not count as a change
 * when it rebuilt the same thing. `undefined` members are dropped, as JSON
 * does, so `{ when: undefined }` equals `{}`: both mean "no condition".
 */
export function stableKey(v: unknown): string {
  if (v === undefined) return "undefined";
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = walk(o[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

export function openDraft<T>(saved: T): DraftState<T> {
  return { saved: cloneValue(saved), draft: cloneValue(saved), confirmingDiscard: false };
}

/** An edit: a value, or an updater over the current draft (the React setState shape). */
export function editDraft<T>(s: DraftState<T>, next: T | ((draft: T) => T)): DraftState<T> {
  const draft = typeof next === "function" ? (next as (d: T) => T)(s.draft) : next;
  /* an edit withdraws a pending "discard?" — the person chose to keep working */
  return { ...s, draft, confirmingDiscard: false };
}

export function isDirty<T>(s: DraftState<T>): boolean {
  return stableKey(s.saved) !== stableKey(s.draft);
}

/**
 * Why Save is disabled, or `null` when it is enabled. Nothing to save when
 * nothing changed; otherwise whatever the caller's validator objects to.
 */
export function saveBlockedReason<T>(s: DraftState<T>, validate?: (draft: T) => string | null | undefined): string | null {
  if (!isDirty(s)) return "No changes to save";
  const problem = validate?.(s.draft);
  return problem ? problem : null;
}

/**
 * The dialog was asked to close — Escape, the backdrop, the Cancel button.
 * Clean: it closes. Dirty: it asks first, and the second request (or the
 * explicit Discard) closes it.
 */
export function requestClose<T>(s: DraftState<T>): { state: DraftState<T>; close: boolean } {
  if (!isDirty(s)) return { state: s, close: true };
  if (s.confirmingDiscard) return { state: s, close: true };
  return { state: { ...s, confirmingDiscard: true }, close: false };
}

export function keepEditing<T>(s: DraftState<T>): DraftState<T> {
  return s.confirmingDiscard ? { ...s, confirmingDiscard: false } : s;
}

/** The value Save commits: the draft, and the state the dialog would reopen on. */
export function commitDraft<T>(s: DraftState<T>): { value: T; state: DraftState<T> } {
  return { value: s.draft, state: openDraft(s.draft) };
}

/**
 * The saved value changed UNDERNEATH an open dialog — a collaborator, an undo,
 * the copilot. The draft is kept when the person has edits in it (their work
 * is not thrown away silently); it follows the new value when they have not
 * started yet, so a clean dialog never shows a stale copy.
 */
export function reconcileSaved<T>(s: DraftState<T>, saved: T): DraftState<T> {
  if (stableKey(saved) === stableKey(s.saved)) return s;
  if (!isDirty(s)) return openDraft(saved);
  return { ...s, saved: cloneValue(saved) };
}
