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
  update(mutator: (draft: SurveyDefinition) => void): void;
  /** switch the centre panel — lets one panel point at another */
  goToTab?(tab: string): void;
  setGoToTab(fn: (tab: string) => void): void;
  replace(def: SurveyDefinition): void;
  select(questionId: string | null): void;
  markSaved(versionId: string, revision?: number | null): void;
  /** flush any pending autosave now; resolves when the draft is stored */
  flushDraft(): Promise<boolean>;
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
  initial, surveyDbId, versionId, draftSavedAt, revision: initialRevision, children,
}: {
  initial: SurveyDefinition;
  surveyDbId: string;
  versionId: string | null;
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
  const goToTabRef = React.useRef<((tab: string) => void) | undefined>(undefined);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const body = JSON.stringify({
      definition: latest.current,
      baseVersionId: versionId,
      baseRevision: revisionRef.current,
    });
    setSaveState({ kind: "saving" });
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
        if (r.status === 409) {
          blocked.current = true;
          setSaveState({
            kind: "conflict",
            message: d.error ?? "this survey changed elsewhere; your save was refused",
            serverRevision: typeof d.revision === "number" ? d.revision : null,
          });
          return false;
        }
        if (!r.ok) {
          setSaveState({ kind: "error", message: d.error ?? `save failed (${r.status})` });
          return false;
        }
        if (typeof d.revision === "number") {
          revisionRef.current = d.revision;
          setRevision(d.revision);
        }
        if (d.unguarded) setUnguarded(true);
        if (d.droppedFields) {
          // the server's schema did not recognise part of what we sent, so it
          // was not stored — better said than silently dropped
          setSaveState({
            kind: "error",
            message:
              "Saved, but some settings were not recognised by the server and were NOT stored. " +
              "The deployed build is older than this editor — reload the page.",
          });
          return false;
        }
        setSaveState({ kind: "saved", savedAt: d.savedAt ?? new Date().toISOString() });
        return true;
      } catch (e) {
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
    setSaveState({ kind: "dirty" });
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
    update(mutator) {
      setDef((prev) => {
        const draft = structuredClone(prev);
        mutator(draft);
        latest.current = draft;
        return draft;
      });
      touched();
    },
    replace(next) {
      setDef(next);
      latest.current = next;
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
    toast(msg, kind = "ok") {
      setToastMsg({ msg, kind });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToastMsg(null), 3500);
    },
  };

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
