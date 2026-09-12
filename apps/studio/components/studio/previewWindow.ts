import type { SurveyDefinition } from "@rescript/schema";

/**
 * The one preview tab, shared by "Preview" (whole survey) and "Preview block".
 *
 * The runtime's /preview page is postMessage-driven: it renders whatever
 * definition it was last sent. This module owns the window handle and the
 * current ENTRY — where the preview starts (`startAt`, a flow node id) and the
 * test values it starts with (`answers`) — so every push carries them and a
 * live edit never silently drops a tester back to page one.
 *
 * The Studio pushes on every edit (debounced) and on the tab's ready message;
 * both go through `pushPreview`, so there is exactly one message shape.
 */

export interface PreviewEntry {
  startAt?: string;
  answers?: Record<string, unknown>;
  /** the draft revision the pushed definition was flushed as (shown in the preview bar) */
  revision?: number | null;
  /** the language to preview in — becomes `?lang=` on the preview URL, so the runtime's own routing serves it */
  language?: string;
}

let win: Window | null = null;
let entry: PreviewEntry = {};
let latestDef: SurveyDefinition | null = null;
/**
 * WHICH SURVEY THIS TAB IS SHOWING.
 *
 * These three are module globals, and the Studio is a single-page app: moving
 * from one survey to another does not reload the module, so the handle, the
 * entry point and the definition all survived the move. A programmer who
 * previewed survey A and then opened survey B had B's definition pushed into
 * A's preview tab — same window, same entry point, different questionnaire —
 * and the tab went on updating from B for the rest of the session.
 *
 * Owning the survey id makes the state belong to something. A push for a
 * different survey than the tab was opened for is dropped, and opening a
 * preview for a new survey starts its own state.
 */
let owner: string | null = null;

export function previewWindowOpen(): boolean {
  return !!win && !win.closed;
}

/** Forget a tab that belongs to another survey, rather than feeding it. */
function claim(def: SurveyDefinition): void {
  const id = (def as any)?.id ?? null;
  if (owner !== null && id !== owner) {
    win = null;
    entry = {};
    latestDef = null;
  }
  owner = id;
}

export function setPreviewDefinition(def: SurveyDefinition): void {
  claim(def);
  latestDef = def;
}

export function pushPreview(def?: SurveyDefinition): void {
  if (def) { claim(def); latestDef = def; }
  if (!win || win.closed || !latestDef) return;
  win.postMessage({ type: "rescript:preview", definition: latestDef, ...entry }, "*");
}

/**
 * Open (or re-focus) the preview tab and set the entry point. Must be called
 * synchronously inside the click — a `window.open` after an await is what
 * popup blockers exist to stop. Returns false when the popup was blocked.
 */
export function openPreview(base: string, def: SurveyDefinition, next: PreviewEntry = {}): boolean {
  claim(def);
  latestDef = def;
  entry = { ...next };
  const w = window.open(`${base}/preview${next.language ? `?lang=${encodeURIComponent(next.language)}` : ""}`, next.language ? `rescript_preview_${next.language}` : "rescript_preview");
  if (!w) return false;
  win = w;
  w.focus();
  // the tab may already be open and past its ready message: nudge it a few times
  let n = 0;
  const t = setInterval(() => { pushPreview(); if (++n > 6) clearInterval(t); }, 400);
  return true;
}

/** Update the revision stamp after the draft flush resolves, and re-push. */
export function setPreviewRevision(revision: number | null): void {
  entry = { ...entry, revision };
  pushPreview();
}
