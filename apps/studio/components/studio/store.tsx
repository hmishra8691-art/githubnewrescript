"use client";
import React from "react";
import type { SurveyDefinition, Question } from "@rescript/schema";

/**
 * Central Studio state — the single source of truth for the survey being
 * edited.
 *
 * The editing model has two levels, deliberately:
 *
 *   DRAFT    what you are editing. Autosaved to `surveys.draft_definition`
 *            about a second after you stop typing. Never served to a
 *            respondent. Survives refresh, navigation and browser crashes.
 *
 *   VERSION  an immutable snapshot, cut when you press "Save version". Only a
 *            version can be deployed, and a deployed version can never change
 *            — a respondent mid-survey must not have the questionnaire move
 *            under them.
 *
 * Before this split, the only persistence was the explicit save, so any edit
 * not followed by a click was lost silently on refresh, and every settings
 * tweak had to become a publishable version.
 */

export type SaveState =
  | { kind: "clean"; savedAt: string | null }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; savedAt: string }
  | { kind: "error"; message: string }
  /**
   * The server refused the write because this editor is behind. Nothing was
   * overwritten. Autosave STOPS until the programmer decides what to do —
   * retrying would be the very thing that loses work.
   */
  | { kind: "conflict"; message: string; serverRevision: number | null }
  /**
   * THE SAVE WAS REFUSED BECAUSE THIS SESSION NO LONGER HOLDS THE PROJECT —
   * not because anybody's work disagrees. Distinct from `conflict`, and that
   * distinction is a bug fix.
   *
   * Both arrive as HTTP 409, and this store used to treat every 409 as a
   * revision conflict. So an editor who lost the lock for a moment — which is
   * exactly what happens when the same person signs in from a second machine
   * (P0-2) — was told "this survey was changed somewhere else", which was
   * false, and had autosave permanently blocked until they reloaded the page,
   * which is where the reports of "I signed in on my laptop and then could
   * not save at all" come from.
   *
   * Nothing is overwritten and nothing is discarded: the draft in this editor
   * is still the newest version of the work. `recoverable` says whether taking
   * editing back is possible from here, so the UI can offer a button rather
   * than an apology.
   */
  | { kind: "lock_lost"; message: string; recoverable: boolean; heldByName: string | null }
  /**
   * The session ended mid-edit. Also NOT data loss, and the message must say
   * so first: the person's fear on reading any of this is that their work is
   * gone (§24).
   */
  | { kind: "signed_out"; message: string }
  /** the draft columns are missing — migration 0003 has not been applied */
  | { kind: "unavailable"; message: string };

export interface StudioState {
  def: SurveyDefinition;
  surveyDbId: string;
  currentVersionId: string | null;
  /** true when the draft differs from the last saved version */
  dirty: boolean;
  /** autosave status, for the header indicator */
  saveState: SaveState;
  selectedQuestionId: string | null;
  /**
   * True once this survey has collected responses. Code re-sequencing rewrites
   * references across the definition, but it cannot rewrite data already
   * stored against the old codes — so once this is true, codes freeze.
   */
  hasResponses: boolean;
  /**
   * READ-ONLY MODE (§19).
   *
   * True whenever this session does not hold the project's edit lock — the
   * starting assumption, and the settled state for a viewer, a reviewer, and
   * an editor whose lock a colleague holds or took away. An edit-capable user
   * who opens a free project leaves it within one collaboration tick, without
   * pressing anything.
   *
   * It is a MIRROR of the server's answer, refreshed by the collaboration
   * poll, never a decision made here. `update` and `replace` refuse while it
   * is set, and the autosave will not run — so a client that somehow keeps
   * editing cannot silently queue a write that the backend is going to reject
   * anyway. The backend refusing is what makes it safe; this makes it kind.
   */
  readOnly: boolean;
  readOnlyReason: string | null;
  setReadOnly(readOnly: boolean, reason?: string | null): void;
  update(mutator: (draft: SurveyDefinition) => void): void;
  /**
   * Undo / redo across every edit that went through `update` or `replace`
   * (req §21). Structural drags move a lot at once, so being able to take one
   * back is what makes dragging safe to try.
   */
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  /** What undo would take back, for the button's tooltip. */
  undoLabel: string | null;
  redoLabel: string | null;
  /** Name the edit the next `update` performs, so undo can describe it. */
  labelNextEdit(label: string): void;
  /** switch the centre panel — lets one panel point at another */
  goToTab?(tab: string): void;
  setGoToTab(fn: (tab: string) => void): void;
  /**
   * A panel with unsaved local edits (the Quota Dashboard's inline edit, for
   * one) registers a guard; the leftnav asks it before switching tabs and the
   * guard may refuse. Null when nothing is pending.
   */
  setLeaveGuard(fn: (() => boolean) | null): void;
  canLeaveTab(): boolean;
  replace(def: SurveyDefinition): void;
  select(questionId: string | null): void;
  markSaved(versionId: string, revision?: number | null): void;
  /**
   * True once a write has been refused because this editor is behind the
   * server. Read the REF, not `saveState`: any edit after the conflict (even
   * the blur-commit a button click causes) flips the visible state to "dirty"
   * for a render, and a guard on the visible state let a stale editor cut a
   * version right over newer work.
   */
  hasConflict(): boolean;
  /**
   * Record that the server refused a write because this editor is behind.
   * The draft autosave sets this itself on a 409; cutting a VERSION can be
   * refused the same way, and must land the editor in the same terminal
   * state — otherwise the programmer keeps clicking a button that will never
   * work and is told only by a toast that fades.
   */
  noteConflict(serverRevision: number | null, message?: string): void;
  /** flush any pending autosave now; resolves when the draft is stored */
  flushDraft(): Promise<boolean>;
  /** the revision right now — for code that runs after an await */
  currentRevision(): number | null;
  /**
   * The revision this editor is working on top of. Sent with every write so
   * the server can refuse one that is behind; null means migration 0004 is
   * not applied and writes are unguarded.
   */
  revision: number | null;
  /** true when stale-write protection is NOT active, so the header can say so */
  unguarded: boolean;
  toast(msg: string, kind?: "ok" | "err"): void;
}

const Ctx = React.createContext<StudioState | null>(null);
export const useStudio = () => {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useStudio outside provider");
  return v;
};

/** How long to wait after the last edit before autosaving. */
const AUTOSAVE_DEBOUNCE_MS = 900;

export function StudioProvider({
  initial, surveyDbId, versionId, draftSavedAt, revision: initialRevision,
  readOnly: initialReadOnly, children,
}: {
  initial: SurveyDefinition;
  surveyDbId: string;
  versionId: string | null;
  /**
   * Start read-only, and stay that way until the SERVER says otherwise.
   *
   * This is a safe default, not a workflow: the collaboration poll asks for
   * the lock as soon as the editor mounts on an editing tab and clears this
   * within a tick if the project is free. What it prevents is the window in
   * between — a client that assumed it could edit, let someone type, and then
   * discovered at save time that a colleague had the lock.
   *
   * It used to be a workflow, and that was the bug: the editor opened in view
   * mode and waited for the user to find an "Enter edit mode" button, which
   * reads as "the project became read-only on its own" and, for anyone who
   * started typing first, as "my changes did not persist".
   */
  readOnly?: boolean;
  /** when the loaded draft was last autosaved, if it came from a draft */
  draftSavedAt?: string | null;
  /** the row revision this editor loaded; null before migration 0004 */
  revision?: number | null;
  children: React.ReactNode;
}) {
  const [def, setDef] = React.useState<SurveyDefinition>(initial);
  const [dirty, setDirty] = React.useState(!!draftSavedAt);
  const [saveState, setSaveState] = React.useState<SaveState>(
    draftSavedAt ? { kind: "clean", savedAt: draftSavedAt } : { kind: "clean", savedAt: null },
  );
  const [selectedQuestionId, setSelected] = React.useState<string | null>(null);
  const [currentVersionId, setVersionId] = React.useState<string | null>(versionId);
  const [toastMsg, setToastMsg] = React.useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const [hasResponses, setHasResponses] = React.useState(false);
  const [revision, setRevision] = React.useState<number | null>(initialRevision ?? null);
  const [unguarded, setUnguarded] = React.useState(false);
  const [readOnly, setReadOnlyState] = React.useState(initialReadOnly ?? true);
  const [readOnlyReason, setReadOnlyReason] = React.useState<string | null>(null);
  /* refs, because `update` and the autosave read this from closures that were
     created before the poll changed it */
  const readOnlyRef = React.useRef(readOnly);
  readOnlyRef.current = readOnly;
  const readOnlyReasonRef = React.useRef(readOnlyReason);
  readOnlyReasonRef.current = readOnlyReason;
  const goToTabRef = React.useRef<((tab: string) => void) | undefined>(undefined);
  const leaveGuardRef = React.useRef<(() => boolean) | null>(null);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /* a standalone raiser: `value.toast` cannot be called from inside the object
     literal that defines it */
  const showToast = React.useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    setToastMsg({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3500);
  }, []);

  /**
   * Undo history.
   *
   * Each entry is the WHOLE definition as it was before an edit, which is
   * affordable because the definition is already cloned on every update and
   * bounded because only the last 50 are kept. Storing deltas instead would
   * mean a second model of what an edit is, and the two would drift.
   */
  const [past, setPast] = React.useState<{ def: SurveyDefinition; label: string }[]>([]);
  const [future, setFuture] = React.useState<{ def: SurveyDefinition; label: string }[]>([]);
  const nextLabel = React.useRef<string | null>(null);
  const UNDO_LIMIT = 50;

  // The autosave always sends the LATEST definition, never a snapshot taken
  // when the timer was set — that distinction is the whole bug class this
  // replaces.
  const latest = React.useRef(def);
  latest.current = def;
  /** the revision every write is based on; kept in a ref so no save closes
   *  over a stale one */
  const revisionRef = React.useRef<number | null>(initialRevision ?? null);
  /** set once a write has been refused — no further autosave may run */
  const blocked = React.useRef(false);
  const autosaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = React.useRef<Promise<boolean> | null>(null);
  const sandbox = surveyDbId === "sandbox";

  const persistDraft = React.useCallback(async (): Promise<boolean> => {
    if (sandbox) return true; // the /sandbox fixture has no database row
    // never overlap two writes to the same row
    if (inFlight.current) await inFlight.current.catch(() => false);
    // A conflict means this editor is behind. Writing again would overwrite
    // whatever is newer, so autosave stops until the programmer resolves it.
    if (blocked.current) return false;
    /*
     * Never autosave without the lock. The route refuses it (409) regardless,
     * but attempting it would flip the header into an error state on every
     * debounce tick for a viewer who happened to trigger a mutation — noise
     * that describes a client bug rather than anything the user can act on.
     */
    if (readOnlyRef.current) return false;
    // the exact object being sent — compared after the round trip, so a save
    // that lands while newer edits exist never reports "all changes saved"
    const sent = latest.current;
    const baseRevision = revisionRef.current;
    const body = JSON.stringify({
      definition: sent,
      baseVersionId: versionId,
      baseRevision,
    });
    setSaveState({ kind: "saving" });
    const startedAt = Date.now();
    console.debug("[rescript:save] draft start", { surveyId: surveyDbId, baseRevision, questions: sent.questions.length });
    const run = (async () => {
      try {
        const r = await fetch(`/api/surveys/${surveyDbId}/draft`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body,
          cache: "no-store",
        });
        const d = await r.json().catch(() => ({}));
        if (r.status === 501) {
          setSaveState({ kind: "unavailable", message: d.error ?? "autosave unavailable" });
          return false;
        }
        /*
         * A 409 is two completely different events and they must not be
         * confused (see the `lock_lost` note on SaveState). The revision
         * conflict is the one that carries `conflict: true`; a lock refusal
         * carries `keepChanges` and a lock `code`. Discriminating on the body
         * rather than the status is the fix.
         */
        if (r.status === 409 && d.conflict === true) {
          console.warn("[rescript:save] draft REFUSED (stale)", { surveyId: surveyDbId, baseRevision, serverRevision: d.revision, ms: Date.now() - startedAt });
          blocked.current = true;
          setSaveState({
            kind: "conflict",
            message: d.error ?? "this survey changed elsewhere; your save was refused",
            serverRevision: typeof d.revision === "number" ? d.revision : null,
          });
          return false;
        }
        if (r.status === 409 || (r.status === 403 && d.code === "no_capability")) {
          console.warn("[rescript:save] draft REFUSED (lock)", { surveyId: surveyDbId, code: d.code, ms: Date.now() - startedAt });
          /*
           * Autosave is NOT blocked here. The lock is very often coming back
           * — the collaboration poll re-acquires it as soon as it is free —
           * and a save that succeeds thirty seconds later without the user
           * doing anything is the outcome they want. Blocking would turn a
           * momentary hiccup into a dead editor needing a reload, which is
           * the P0-2 behaviour being removed.
           */
          setSaveState({
            kind: "lock_lost",
            message: d.error ?? "This session is not currently holding the edit lock for the project.",
            recoverable: d.recoverable !== false,
            heldByName: d.lock?.name ?? null,
          });
          return false;
        }
        if (r.status === 401 || d.signedOut === true) {
          console.warn("[rescript:save] draft REFUSED (session)", { surveyId: surveyDbId, code: d.code });
          setSaveState({
            kind: "signed_out",
            message: d.error ?? "Your session has ended, so this save was not accepted.",
          });
          return false;
        }
        if (r.status === 423) {
          // the owner froze the project. Not recoverable by this user, and not
          // a conflict — their work is intact and they need to be told why.
          setSaveState({ kind: "error", message: d.error ?? "This project has been locked by its owner and cannot be changed." });
          return false;
        }
        if (!r.ok) {
          console.warn("[rescript:save] draft FAILED", { surveyId: surveyDbId, baseRevision, status: r.status, error: d.error, ms: Date.now() - startedAt });
          setSaveState({ kind: "error", message: d.error ?? `save failed (${r.status})` });
          return false;
        }
        console.debug("[rescript:save] draft done", { surveyId: surveyDbId, baseRevision, newRevision: d.revision, ms: Date.now() - startedAt });
        if (typeof d.revision === "number") {
          revisionRef.current = d.revision;
          setRevision(d.revision);
        }
        if (d.unguarded) setUnguarded(true);
        /*
         * The server's schema did not recognise part of what we sent, so that
         * part was not stored — better said than silently dropped.
         *
         * Newer servers send the list of paths; older ones sent `true`. An
         * empty list never reaches here (the server omits the key), because an
         * empty array is truthy and used to turn every lossless save into a
         * reported failure.
         */
        const lost = Array.isArray(d.droppedFields)
          ? d.droppedFields
          : d.droppedFields === true
            ? []
            : null;
        if (lost) {
          setSaveState({
            kind: "error",
            message:
              "Saved, but the server did not recognise " +
              (lost.length ? lost.join(", ") : "some settings") +
              ", so that part was NOT stored. This editor is newer than the " +
              "deployed build — reload the page to match it.",
          });
          return false;
        }
        // edits made during the round trip are not saved yet — say so; the
        // debounced autosave they scheduled will pick them up
        if (latest.current !== sent) setSaveState({ kind: "dirty" });
        else setSaveState({ kind: "saved", savedAt: d.savedAt ?? new Date().toISOString() });
        return true;
      } catch (e) {
        console.warn("[rescript:save] draft FAILED", { surveyId: surveyDbId, baseRevision, error: (e as Error).message });
        setSaveState({ kind: "error", message: (e as Error).message || "network error" });
        return false;
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [sandbox, surveyDbId, versionId]);

  /** Debounced autosave, rescheduled on every edit. */
  const scheduleDraftSave = React.useCallback(() => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => { void persistDraft(); }, AUTOSAVE_DEBOUNCE_MS);
  }, [persistDraft]);

  const flushDraft = React.useCallback(async (): Promise<boolean> => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    if (inFlight.current) await inFlight.current.catch(() => false);
    return persistDraft();
  }, [persistDraft]);

  /**
   * Last line of defence: if work is still unsaved when the tab closes, warn.
   * Autosave makes this rare, but "rare" is not "never" — a save can be in
   * flight, or offline.
   */
  React.useEffect(() => {
    const unsaved = () =>
      saveState.kind === "dirty" || saveState.kind === "saving" ||
      saveState.kind === "error" || saveState.kind === "conflict" ||
      // a refused save is unsaved work, and these two are the states where
      // the user is most likely to close the tab believing it went through
      saveState.kind === "lock_lost" || saveState.kind === "signed_out" ||
      (saveState.kind === "unavailable" && dirty);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!unsaved()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveState, dirty]);

  // one cheap probe on mount; a survey with data must not have its codes moved
  React.useEffect(() => {
    let cancelled = false;
    if (sandbox) return;
    fetch(`/api/surveys/${surveyDbId}/responses?limit=1`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const n = Array.isArray(d) ? d.length : (d.total ?? d.rows?.length ?? 0);
        setHasResponses(n > 0);
      })
      .catch(() => { /* offline / not deployed yet — treat as no data */ });
    return () => { cancelled = true; };
  }, [surveyDbId, sandbox]);

  const touched = () => {
    setDirty(true);
    /*
     * A conflict is terminal until reload, and a signed-out session cannot be
     * recovered by typing — an edit made after either must not relabel the
     * header "Unsaved changes" as if autosave were still running.
     *
     * `lock_lost` deliberately is NOT sticky: it usually resolves itself
     * within one poll, autosave keeps trying, and going back to "Unsaved
     * changes" is the truth while it does.
     */
    setSaveState((prev) =>
      prev.kind === "conflict" || prev.kind === "signed_out" ? prev : { kind: "dirty" });
    scheduleDraftSave();
  };

  const value: StudioState = {
    def,
    surveyDbId,
    revision,
    unguarded,
    currentVersionId,
    dirty,
    saveState,
    selectedQuestionId,
    hasResponses,
    goToTab: (tab) => goToTabRef.current?.(tab),
    setGoToTab(fn) { goToTabRef.current = fn; },
    setLeaveGuard(fn) { leaveGuardRef.current = fn; },
    canLeaveTab: () => (leaveGuardRef.current ? leaveGuardRef.current() : true),
    /**
     * `latest.current` is the previous definition, not `setDef`'s argument.
     *
     * Pushing onto the undo stack from inside a state updater would run twice
     * under React's development double-invocation and record every edit twice,
     * so one ⌘Z would appear to do nothing. The ref is kept in step on every
     * render and on every mutation below, which makes it the safe source.
     */
    readOnly,
    readOnlyReason,
    setReadOnly(next, reason) {
      setReadOnlyState(next);
      setReadOnlyReason(next ? reason ?? null : null);
      // leaving read-only clears a stale "refused" toast; entering it stops
      // the debounced save that an in-flight edit may already have scheduled
      if (next && autosaveTimer.current) {
        clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
    },
    update(mutator) {
      if (readOnlyRef.current) {
        showToast(readOnlyReasonRef.current ?? "This project is read-only. Your changes have not been made.", "err");
        return;
      }
      const label = nextLabel.current ?? "edit";
      nextLabel.current = null;
      const prev = latest.current;
      const draft = structuredClone(prev);
      mutator(draft);
      latest.current = draft;
      setPast((p) => [...p, { def: prev, label }].slice(-UNDO_LIMIT));
      setFuture([]);
      setDef(draft);
      touched();
    },
    replace(next) {
      if (readOnlyRef.current) {
        showToast(readOnlyReasonRef.current ?? "This project is read-only. Your changes have not been made.", "err");
        return;
      }
      const label = nextLabel.current ?? "replace survey";
      nextLabel.current = null;
      const prev = latest.current;
      latest.current = next;
      setPast((p) => [...p, { def: prev, label }].slice(-UNDO_LIMIT));
      setFuture([]);
      setDef(next);
      touched();
    },
    labelNextEdit(label) { nextLabel.current = label; },
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undoLabel: past.length ? past[past.length - 1].label : null,
    redoLabel: future.length ? future[future.length - 1].label : null,
    undo() {
      if (past.length === 0) return;
      const entry = past[past.length - 1];
      const current = latest.current;
      latest.current = entry.def;
      setPast((p) => p.slice(0, -1));
      setFuture((f) => [...f, { def: current, label: entry.label }]);
      setDef(entry.def);
      touched();
    },
    redo() {
      if (future.length === 0) return;
      const entry = future[future.length - 1];
      const current = latest.current;
      latest.current = entry.def;
      setFuture((f) => f.slice(0, -1));
      setPast((p) => [...p, { def: current, label: entry.label }].slice(-UNDO_LIMIT));
      setDef(entry.def);
      touched();
    },
    select: setSelected,
    markSaved(vid, nextRevision) {
      setDirty(false);
      setVersionId(vid);
      if (typeof nextRevision === "number") {
        revisionRef.current = nextRevision;
        setRevision(nextRevision);
      }
      // cutting a version clears the draft server-side, so there is nothing
      // pending any more — cancel a queued autosave rather than letting it
      // recreate a draft that differs from the version by nothing at all
      if (autosaveTimer.current) {
        clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
      blocked.current = false;
      setSaveState({ kind: "clean", savedAt: new Date().toISOString() });
    },
    flushDraft,
    currentRevision: () => revisionRef.current,
    hasConflict: () => blocked.current,
    noteConflict(serverRevision, message) {
      blocked.current = true;
      setSaveState({
        kind: "conflict",
        message: message ?? "this survey changed elsewhere; your save was refused",
        serverRevision,
      });
    },
    toast(msg, kind = "ok") { showToast(msg, kind); },
  };

  /**
   * ⌘Z / ⌘⇧Z, except while typing.
   *
   * A text field has its own undo stack and the programmer expects it, so a
   * keystroke inside one is left to the browser; taking it over would make
   * undo mean two different things depending on focus.
   */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (
        el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable
      );
      if (typing) return;
      e.preventDefault();
      if (e.shiftKey) value.redo();
      else value.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Ctx.Provider value={value}>
      {children}
      {toastMsg && <div className={`toast ${toastMsg.kind}`}>{toastMsg.msg}</div>}
    </Ctx.Provider>
  );
}

export function selectedQuestion(s: StudioState): Question | null {
  return s.def.questions.find((q) => q.id === s.selectedQuestionId) ?? null;
}

let seq = 0;
export const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

/** All references usable in conditions / piping, for pickers. */
export function refOptions(def: SurveyDefinition): { value: string; label: string }[] {
  return [
    ...def.questions.map((q) => ({ value: q.id, label: `${q.code} — ${q.variableName}` })),
    ...def.calculations.map((c) => ({ value: c.targetVariable, label: `calc: ${c.targetVariable}` })),
    ...def.embeddedData.map((e) => ({ value: e.name, label: `embedded: ${e.name}` })),
  ];
}
