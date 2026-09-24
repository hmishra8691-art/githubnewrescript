"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { StudioProvider, useStudio, selectedQuestion } from "./store";
import { openPreview, pushPreview, previewWindowOpen, setPreviewDefinition, setPreviewRevision } from "./previewWindow";
import { ExportDialog } from "./ExportDialog";
import { QuestionsPanel } from "./QuestionsPanel";
import { CanvasProvider } from "../canvas/CanvasContext";
import { PropertiesPanel, SurveySettings } from "./PropertiesPanel";
import { FlowPanel } from "./FlowPanel";
import { TestsPanel } from "./TestsPanel";
import { LogicPanel, CalcPanel } from "./LogicPanel";
import { VariablesPanel } from "./VariablesPanel";
import { QuotaDashboard } from "./QuotaDashboard";
import { ListFillPanel } from "./ListFillPanel";
import { CollabBar, ReadOnlyNotice } from "./CollabBar";
import { CollaboratorsPanel } from "./CollaboratorsPanel";
import { NotesPanel, ActivityPanel } from "./NotesPanel";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { useCollab } from "@/lib/useCollab";
import { useSession } from "@/lib/useSession";
import { DesignsPanel } from "./DesignsPanel";
import { BrandingPanel, ScriptsPanel, ThemeLivePreview } from "./BrandingPanel";
import { AssetsPanel } from "./AssetsPanel";
import { VersionsPanel } from "./VersionsPanel";
import { JsonPanel } from "./JsonPanel";
import { DataPanel } from "./DataPanel";
import { FieldworkPanel } from "./FieldworkPanel";
import { DistributionPanel } from "./DistributionPanel";
import { ProjectPanel } from "./ProjectPanel";
import { runtimeBaseUrl, surveyBaseUrl } from "@/lib/runtime-url";
import { Icon, type IconName } from "@/components/ui/Icon";
import { LocalizationPanel } from "./localization/LocalizationPanel";
import { UsagePanel, useMeterView } from "./UsagePanel";
import { fmtMoney } from "@/components/billing/shared";
import { ModeProvider } from "./ModeContext";
import { SelectionProvider } from "./SelectionContext";
import { CommandProvider, useCommands, type ShellActions } from "./CommandContext";
import { CommandPalette } from "./CommandPalette";
import { ModeSelector } from "./ModeSelector";
import { useMode } from "./ModeContext";
import { GridView } from "../grid/GridView";
import { ArchitectView } from "../architect/ArchitectView";

type Tab =
  | "questions" | "flow" | "logic" | "variables" | "calculations"
  | "quotas" | "listfill" | "designs" | "branding" | "assets" | "localization" | "scripts" | "tests" | "data" | "fieldwork"
  | "distribution" | "project" | "usage" | "versions" | "json"
  | "collaborators" | "notes" | "activity"
  | "settings";

/**
 * The tabs whose controls must be inert in read-only mode (§19).
 *
 * Everything else stays live on purpose: a reviewer reads responses, browses
 * versions, and leaves internal notes without holding the edit lock — those
 * are the point of the role, not a loophole.
 */
const EDITING_TABS = new Set<Tab>([
  "questions", "settings", "flow", "logic", "variables", "calculations",
  "quotas", "listfill", "designs", "branding", "assets", "localization", "scripts", "json",
]);

/*
 * The sidebar. Every tab the Studio has always had, in the same order, now
 * grouped so a programmer can find "the thing that edits the survey" versus
 * "the thing that ships it" at a glance. Grouping is presentation: keys,
 * order within the list and the click behaviour are unchanged.
 */
const NAV: { key: Tab; label: string; icon: IconName; group: string }[] = [
  { key: "questions", label: "Questions", icon: "questions", group: "Programming" },
  { key: "settings", label: "Survey Settings", icon: "settings", group: "Programming" },
  { key: "flow", label: "Survey Flow", icon: "flow", group: "Programming" },
  { key: "logic", label: "Logic", icon: "logic", group: "Programming" },
  { key: "variables", label: "Variables", icon: "variables", group: "Programming" },
  { key: "calculations", label: "Calculations", icon: "calc", group: "Programming" },
  { key: "quotas", label: "Quotas", icon: "quotas", group: "Programming" },
  { key: "listfill", label: "List Fill", icon: "listfill", group: "Programming" },
  { key: "designs", label: "Design Generators", icon: "designs", group: "Research tools" },
  { key: "branding", label: "Branding", icon: "branding", group: "Research tools" },
  { key: "assets", label: "Assets", icon: "assets", group: "Research tools" },
  /*
   * Translation & Localization — every language version of the survey (text
   * and audio) over the one language-neutral definition. In Research tools
   * beside Branding: it changes what a respondent reads and hears, never what
   * the survey asks or stores. In EDITING_TABS: a translation is authorship.
   */
  { key: "localization", label: "Translation", icon: "layers", group: "Research tools" },
  { key: "scripts", label: "Scripts", icon: "scripts", group: "Research tools" },
  /*
   * §55/§56. In Research tools rather than Programming, and deliberately NOT
   * in EDITING_TABS: a reviewer checking whether a programmer's change broke
   * path C must not have to take the edit lock away from them to do it. The
   * route gates it on `survey.edit` without the lock, for the same reason.
   */
  { key: "tests", label: "Tests", icon: "check", group: "Research tools" },
  { key: "data", label: "Data", icon: "data", group: "Results" },
  /*
   * Not in EDITING_TABS: a fieldwork manager watching supplier delivery is
   * reading response data, and must not need the edit lock to do it — the
   * same reasoning that keeps Data and Versions live for a reviewer.
   */
  { key: "fieldwork", label: "Fieldwork", icon: "chart", group: "Results" },
  /*
   * §24. Beside Versions & Deploy, because sending a study is the step after
   * shipping it — and gated on `deploy.manage` at the route, not here: the
   * roles separate the programmer who edits from the manager who sends.
   */
  /*
   * §60. First in Management, because it is the project — the thing every
   * other tab is about. Not in EDITING_TABS: recording a due date is not an
   * act on the questionnaire and must not need the edit lock (the route
   * gates it on `survey.edit` without the lock, and on
   * `project.lock_settings` for the freeze).
   */
  { key: "project", label: "Project", icon: "home", group: "Management" },
  /*
   * Metered usage & wallet (billing brief §11). Beside Project, because the
   * wallet belongs to the project, not the questionnaire. Not in
   * EDITING_TABS: reading what the project has spent, and asking for
   * credits, never needs the edit lock.
   */
  { key: "usage", label: "Usage & Wallet", icon: "chart", group: "Management" },
  { key: "distribution", label: "Distribution", icon: "share", group: "Management" },
  { key: "versions", label: "Versions & Deploy", icon: "versions", group: "Management" },
  { key: "json", label: "JSON", icon: "json", group: "Management" },
  { key: "collaborators", label: "Collaborators", icon: "collaborators", group: "Management" },
  { key: "notes", label: "Internal notes", icon: "notes", group: "Management" },
  { key: "activity", label: "Activity", icon: "activity", group: "Management" },
];

/**
 * Hand the user their own work as a file.
 *
 * The escape hatch behind every "not saved" state. §24 forbids discarding
 * unsaved changes when a save is refused, and the honest way to keep that
 * promise through anything — a conflict, an ended session, a browser about to
 * be closed by someone who has run out of patience — is to let them take the
 * draft with them. It is the same JSON the JSON tab shows and the same shape
 * the importer accepts, so nothing about it is a dead end.
 */
function downloadDraft(def: SurveyDefinition, code: string) {
  const blob = new Blob([JSON.stringify(def, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${code || "survey"}-unsaved-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoked on a later tick: revoking synchronously races the download in
  // some browsers and silently produces an empty file
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The save indicator is the honest answer to "is my work safe?".
 *
 * It reports the DRAFT autosave, not the version — that is what protects a
 * refresh — and says plainly when autosave is unavailable rather than showing
 * a reassuring tick over unsaved work.
 *
 * Every failure state here obeys one rule (§24): NOTHING it offers throws the
 * user's work away without them choosing it in so many words. The conflict
 * state used to offer a single "Reload" button, which would have loaded the
 * newer server draft straight over the top of whatever was in the editor —
 * the exact thing the P0 spec forbids. It now offers to hand the work back as
 * a file first, and names the destructive option for what it is.
 */
function SaveIndicator() {
  const s = useStudio();
  const st = s.saveState;
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  switch (st.kind) {
    case "saving":
      return <span className="save-state saving" data-testid="save-state">Saving…</span>;
    case "saved":
      return (
        <span className="save-state ok" data-testid="save-state" title={`Draft autosaved at ${time(st.savedAt)}`}>
          ✓ All changes saved
        </span>
      );
    case "dirty":
      return <span className="save-state dirty" data-testid="save-state">● Unsaved changes</span>;
    case "error":
      return (
        <span className="save-state err" data-testid="save-state" title={st.message}>
          ⚠ Save failed — {st.message.slice(0, 60)}{" "}
          <button className="btn small" style={{ marginLeft: 6 }} data-testid="save-retry"
            onClick={() => void s.flushDraft()}>Retry</button>
        </span>
      );
    case "unavailable":
      return (
        <span className="save-state warn" data-testid="save-state" title={st.message}>
          ⚠ Autosave off — use Save version
        </span>
      );
    /*
     * SOMEBODY ELSE HAS THE LOCK, OR THIS SESSION LOST IT.
     *
     * Not a conflict and not terminal. The draft is intact, autosave is still
     * running, and the collaboration poll takes the lock back as soon as the
     * project is free — so the honest report is "waiting", with the work
     * offered as a file for anyone who would rather not wait.
     */
    case "lock_lost":
      return (
        <span className="save-state warn" data-testid="save-state" title={st.message}>
          ⚠ Not saved — {st.heldByName ? `${st.heldByName} is editing` : "no edit lock"}. Your changes are still here
          {st.recoverable ? " and will save when editing returns to you" : ""}.{" "}
          <button className="btn small" style={{ marginLeft: 6 }} data-testid="save-retry"
            onClick={() => void s.flushDraft()}>Try again</button>
          <button className="btn small" style={{ marginLeft: 4 }} data-testid="save-download"
            onClick={() => downloadDraft(s.def, s.def.meta.code ?? "")}>Download my copy</button>
        </span>
      );

    /*
     * The session ended mid-edit. Signing back in happens in ANOTHER TAB on
     * purpose: navigating this one away is what would destroy the draft, and
     * this is precisely the moment the user has the most to lose.
     */
    case "signed_out":
      return (
        <span className="save-state err" data-testid="save-state" title={st.message}>
          ⚠ Not saved — {st.message}{" "}
          <strong>Your changes are still on this screen.</strong>{" "}
          <a className="btn small" style={{ marginLeft: 6 }} href="/login" target="_blank" rel="noreferrer"
            data-testid="save-signin">Sign in (new tab)</a>
          <button className="btn small" style={{ marginLeft: 4 }} data-testid="save-retry"
            onClick={() => void s.flushDraft()}>Then save again</button>
          <button className="btn small" style={{ marginLeft: 4 }} data-testid="save-download"
            onClick={() => downloadDraft(s.def, s.def.meta.code ?? "")}>Download my copy</button>
        </span>
      );

    case "conflict":
      /*
       * Deliberately loud, and autosave has stopped — writing again is the
       * one thing that would overwrite whatever is newer on the server.
       *
       * What it must NOT do is offer only "Reload". Reloading fetches the
       * newer draft and paints it over everything in this editor; for someone
       * who has been working for twenty minutes that is the data loss the
       * whole P0 list is about. So the work comes back as a file first, and
       * the destructive choice is spelled out as discarding.
       */
      return (
        <span className="save-state err" data-testid="save-state" title={st.message}>
          ⚠ Changed elsewhere — {st.message}{" "}
          <strong>Nothing was overwritten.</strong>{" "}
          <button className="btn small" style={{ marginLeft: 6 }} data-testid="save-download"
            onClick={() => downloadDraft(s.def, s.def.meta.code ?? "")}>Download my copy</button>
          <button className="btn small" style={{ marginLeft: 4 }} data-testid="save-discard"
            title="Loads the newer version from the server. Anything you have changed here since will be lost."
            onClick={() => {
              if (window.confirm(
                "Load the newer version from the server?\n\n"
                + "The changes you have made in this editor since the conflict will be discarded. "
                + "Download your copy first if you are not sure.",
              )) window.location.reload();
            }}>Discard mine and reload</button>
        </span>
      );
    case "clean":
    default:
      return st.savedAt ? (
        <span className="save-state ok" data-testid="save-state" title={`Last saved ${time(st.savedAt)}`}>
          ✓ Saved
        </span>
      ) : (
        <span className="save-state" data-testid="save-state" />
      );
  }
}

/**
 * THE RIGHT PANEL IS CONTEXTUAL, NOT GLOBAL (Sept 21 follow-up: "Context-Aware
 * Right Panel & Live Preview UI Fix").
 *
 * Before this, `<aside className="rightpanel"><PropertiesPanel /></aside>`
 * rendered unconditionally on every tab. `PropertiesPanel` itself already
 * handles "no question selected" — it falls back to a "Select a question…"
 * message plus a second, duplicate `<SurveySettings/>` — which is exactly
 * the bug: that fallback appeared on Survey Settings (already showing its
 * own settings in `main`), on Branding (where a generic Properties panel is
 * irrelevant clutter), and on Survey Flow / Logic (which already do their
 * own contextual editing inline — `NodeEditor` in `FlowPanel`, the
 * `ConditionEditor`/`RuleEditor` family in `LogicPanel` — and never read
 * from this aside at all).
 *
 * Now the aside is context-aware:
 *   - Questions, with a question selected → `PropertiesPanel`, visible.
 *   - Questions, nothing selected, or any other non-Branding tab → the same
 *     `PropertiesPanel` aside stays MOUNTED but is hidden with `.rp-hidden`
 *     (`display: none`) rather than unmounted. Not a cosmetic choice: its
 *     children hold real, unsaved-anywhere UI state — which accordion
 *     sections are expanded, whether the display/skip-logic editor is in
 *     Visual or Expression mode, the properties search box — and unmounting
 *     it on every trip through, say, the JSON tab reset all of that on the
 *     way back, which broke flows as ordinary as "peek at the JSON, then
 *     keep editing logic" the moment that peek round-tripped through a
 *     re-render. Keeping it mounted (as it always was pre-Sept-21, just
 *     never hidden) preserves that state exactly as it did before; only its
 *     visibility is new.
 *   - Branding → the live theme preview, moved here from `BrandingPanel`'s
 *     own scrolling column (see `ThemeLivePreview`'s export comment) so
 *     controls and preview sit side by side instead of stacked with a
 *     scroll between them. A second, separate `<aside>` — `PropertiesPanel`
 *     is still mounted (and hidden) underneath it, for the same reason.
 *
 * `.ide-body`'s grid stops reserving the right column's width when no
 * *visible* `.rightpanel` exists (see
 * `.ide-body:not(:has(> .rightpanel:not(.rp-hidden)))` in
 * design-system.css — a `display: none` element takes no grid track
 * regardless, so the hidden Properties aside never reserves one on its
 * own), so `main` actually uses the freed space instead of leaving a blank
 * gutter where the panel used to be.
 */
function RightPanel({ tab, hidden = false }: { tab: Tab; hidden?: boolean }) {
  const s = useStudio();
  /*
   * COLLAPSED BY THE AUTHOR, as distinct from hidden because nothing is
   * selected. "Allow users to collapse the Properties panel when it is not in
   * use and reopen it when required" — a wide question (a long matrix, a
   * conjoint grid) wants the whole width for a moment without the author
   * having to deselect and lose their place. Deliberately NOT persisted to
   * the definition: it is a view state, like a scroll position.
   */
  const [collapsed, setCollapsed] = React.useState(false);
  const selected = !!selectedQuestion(s);
  const showProperties = tab === "questions" && selected && !collapsed && !hidden;
  const asideRef = React.useRef<HTMLElement>(null);

  /*
   * CLICKING AWAY CLOSES IT.
   *
   * "When we click on Properties for any question type, the properties
   * options open correctly. However, when we want to close the Properties
   * panel, we currently have to click on Properties again. Please fix this
   * behavior so that the Properties panel automatically closes whenever we
   * click anywhere outside the Properties section."
   *
   * The panel is open because a question is selected, so closing it is
   * deselecting — but only for a click on genuinely empty editor space. A
   * click on another question card selects that one (the card's own handler
   * runs, and deselecting here would fight it), and a click on the toolbar,
   * the left nav, a modal or any menu is a command rather than a dismissal.
   * `pointerdown` in the capture phase so the decision is made before a
   * re-render can move the element out from under the event.
   */
  React.useEffect(() => {
    if (!selected || tab !== "questions" || hidden) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (asideRef.current?.contains(t)) return;             // inside the panel
      // the Grid owns its own selection (rows, ranges, toggles) — a click there is never a dismissal
      if (t.closest(".qcard, .leftnav, .topbar, .modal, dialog, [role='dialog'], .rs-card, .sg")) return;
      if (t.closest("input, textarea, select, button, a, [contenteditable='true']")) return;
      s.select(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [selected, tab, s, hidden]);

  return (
    <>
      <aside ref={asideRef} className={`rightpanel${showProperties ? "" : " rp-hidden"}`} data-testid="rightpanel-properties">
        <button className="rp-collapse" data-testid="rightpanel-collapse"
          title="Collapse the properties panel — the question stays selected"
          aria-label="Collapse properties panel"
          onClick={() => setCollapsed(true)}>›</button>
        <PropertiesPanel />
      </aside>
      {/* reopening it: only worth offering while a question is actually
          selected, which is the only time it has anything to show */}
      {tab === "questions" && selected && collapsed && (
        <button className="rp-reopen" data-testid="rightpanel-reopen"
          title="Show the properties panel"
          onClick={() => setCollapsed(false)}>‹ Properties</button>
      )}
      {tab === "branding" && (
        <aside className="rightpanel rightpanel-preview" data-testid="rightpanel-preview">
          <h2>Live preview</h2>
          <ThemeLivePreview branding={s.def.branding} logoUrl={s.def.branding.logoUrl} />
        </aside>
      )}
    </>
  );
}

function StudioShell({ collaboration }: { collaboration: boolean }) {
  const s = useStudio();
  /*
   * NOT `redirectOnSignOut`. Two reasons, and the second is the important one:
   *
   *   - the middleware already sends a visitor with no session to /login, so a
   *     second client-side redirect is redundant, and it fires on the
   *     `/sandbox` fixture, which has no session by design.
   *   - navigating away from the editor because a heartbeat came back 401
   *     would discard whatever is unsaved. §28 says warn before leaving with
   *     unsaved changes; silently leaving is the opposite of that. So an
   *     expired session shows a banner here and lets the programmer copy their
   *     work out, rather than deciding for them.
   */
  const session = useSession();
  // ?tab=data lets the dashboard link straight to a survey's responses
  const [exportOpen, setExportOpen] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>(() => {
    if (typeof window === "undefined") return "questions";
    const t = new URLSearchParams(window.location.search).get("tab");
    return (NAV.some((n) => n.key === t) ? t : "questions") as Tab;
  });
  React.useEffect(() => { s.setGoToTab((t) => setTab(t as Tab)); }, [s]);

  /*
   * The collaboration poll drives presence, the lock and read-only mode. The
   * section is reported so a future section-level lock (§18) already has the
   * information it needs — today it only annotates "editing Survey Flow" in
   * the banner and the audit trail.
   *
   * INTENT COMES FROM THE TAB, and that is what removed the "Enter edit mode"
   * step. Someone on the Questions tab is there to change questions, so the
   * poll asks for the lock and gets it if the project is free; someone on the
   * Activity or Data tab is not, so it never touches the lock and cannot take
   * editing away from a colleague by looking at a response table. The
   * acquisition itself is still the atomic claim in SQL, so "ask for it
   * automatically" cannot produce two editors — a client that asks while
   * somebody else holds it is simply refused and goes read-only naming them.
   *
   * The old flow — open a project, find it read-only, hunt for a button — is
   * what the P0 report describes as "the project became read-only
   * unexpectedly" and "my changes did not persist".
   */
  const collab = useCollab(collaboration ? s.surveyDbId : null, {
    section: null,
    intent: EDITING_TABS.has(tab) ? "edit" : "view",
  });

  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  /**
   * WHY THE LAST SAVE WAS REFUSED, KEPT ON SCREEN.
   *
   * The server has always said exactly what was wrong. A version cut refused
   * by the publish gate returns up to twenty blocking problems in `lint`; a
   * definition that fails the schema returns the offending paths in `issues`.
   * Every one of them was dropped on the floor: `save()` raised a toast
   * carrying only `d.error`, and a toast clears itself after 3.5 seconds.
   *
   * So the gate's own message — "Fix them in the Quality panel, or see the
   * list below" — was shown with no list below it, and `testSurvey` then
   * replaced even that with "could not be saved, please retry", which for a
   * lint failure is advice that can never work: retrying a survey with a
   * blocking problem fails identically every time.
   *
   * This holds the refusal until the programmer dismisses it.
   */
  const [blocker, setBlocker] = React.useState<
    { title: string; message: string; problems: { area: string; message: string }[]; retryable: boolean } | null
  >(null);

  const [publishState, setPublishState] = React.useState<
    { mode: string; version: string; client_slug: string; study_slug: string }[] | null
  >(null);

  // always the CURRENT definition — every async path reads through this ref so
  // nothing can act on a snapshot captured before an await
  const defRef = React.useRef(s.def);
  defRef.current = s.def;

  const counts: Partial<Record<Tab, number>> = {
    questions: s.def.questions.length,
    quotas: s.def.quotas.length,
    listfill: s.def.listFills.length,
    calculations: s.def.calculations.length,
    designs: s.def.designs.length,
    scripts: s.def.scripts.length,
  };

  /**
   * Cut an immutable version from the current draft.
   *
   * This used to snapshot the definition BEFORE awaiting the network, then
   * write that snapshot back afterwards — so any edit made during the
   * round-trip was silently reverted, the dirty flag cleared, and a "Saved"
   * toast shown. Now nothing is written back except the version NUMBER, and
   * that is merged into whatever the definition has become.
   */
  const save = async (label?: string): Promise<string | null> => {
    /*
     * A save already running is NOT a failed save. This returned a bare
     * `null`, indistinguishable from a refusal, so a click that arrived while
     * autosave was mid-flight was reported to the user as "your changes could
     * not be saved" when nothing had gone wrong at all.
     */
    if (savingRef.current) {
      s.toast("A save is already running — give it a moment and try again.", "err");
      return null;
    }
    setBlocker(null);
    /*
     * A conflict means this editor is BEHIND the server: someone (or another
     * tab) saved newer work. Cutting a version from here would write this
     * editor's older state over it — the one thing the revision guard exists
     * to prevent — so a save is refused until the editor reloads.
     *
     * Asked of the store's ref, not of `saveState`: the click that reaches
     * this button first blurs whatever field was being edited, that commit
     * marks the editor "dirty", and React renders that before the click
     * handler runs — so the visible state said "dirty" while the editor was
     * in fact behind. That is how a stale editor got to cut version 1.1.
     */
    if (s.hasConflict()) {
      s.toast("This survey changed elsewhere. Reload to pick up the newer work before saving.", "err");
      return null;
    }
    savingRef.current = true;
    setSaving(true);
    const startedAt = Date.now();
    const baseRevision = s.revision;
    try {
      // make sure the draft on the server matches what we are about to version
      await s.flushDraft();
      /*
       * ASK AGAIN, AFTER THE FLUSH.
       *
       * The check above catches an editor that ALREADY knew it was behind.
       * But a tab that has been sitting idle knows nothing: it has no pending
       * autosave, so `hasConflict()` is false, and the flush on this very line
       * is the first write in hours — the moment the conflict is discovered.
       * The old code awaited that flush and ignored what it learned, then went
       * on to cut a version; and the version route forces past the database's
       * revision guard on purpose (`p_base_revision: -1`), so this tab's
       * hours-old definition became the current version over newer work. The
       * guard has to read the fact at the moment the fact is known.
       */
      if (s.hasConflict()) {
        console.warn("[rescript:save] version REFUSED (this editor is behind)", { surveyId: s.surveyDbId, baseRevision, serverRevision: s.currentRevision(), ms: Date.now() - startedAt });
        s.toast(
          "This survey was changed elsewhere while this tab was open, so nothing was saved. " +
          "Reload to pick up the newer work — any unsaved edits in this tab will be lost.",
          "err",
        );
        return null;
      }
      console.debug("[rescript:save] version start", { surveyId: s.surveyDbId, baseRevision, flushedRevision: s.currentRevision(), label });
      /* the exact object being versioned, kept so `markSaved` can tell whether
         anything was typed while the request was in flight */
      const posted = defRef.current;
      const r = await fetch(`/api/surveys/${s.surveyDbId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // the revision this editor is working on top of, so the DATABASE can
        // refuse the finalize too — the client's check is the fast path, not
        // the guarantee
        body: JSON.stringify({ definition: posted, label, baseRevision: s.currentRevision() }),
        cache: "no-store",
      });
      const d = await r.json().catch(() => ({}));
      /*
       * A 409 here is two completely different events, exactly as
       * `store.tsx`'s `persistDraft` already discriminates for autosave (see
       * its comment on this same distinction). Only a genuine revision
       * conflict carries `conflict: true` — that's this editor being behind
       * newer work, and IS the case that must stop further saves. A lock
       * refusal (this session's own edit lock merely lapsed; no `conflict`
       * field, just `code`/`keepChanges`/`lock`) is not that: nobody's work
       * is stale, nothing external changed, and treating it as a conflict
       * used to call `noteConflict()` and permanently block autosave/Save
       * version/Test Survey/Publish over a momentary lock hiccup the
       * collaboration poll would have recovered from on its own.
       */
      if (r.status === 409 && d.conflict === true) {
        console.warn("[rescript:save] version REFUSED by the server (stale)", { surveyId: s.surveyDbId, baseRevision, serverRevision: d.revision, ms: Date.now() - startedAt });
        s.noteConflict(typeof d.revision === "number" ? d.revision : null, d.error);
        s.toast(d.error ?? "This survey changed elsewhere, so nothing was saved. Reload before saving again.", "err");
        return null;
      }
      if (r.status === 409 || (r.status === 403 && d.code === "no_capability")) {
        console.warn("[rescript:save] version REFUSED (lock)", { surveyId: s.surveyDbId, code: d.code, ms: Date.now() - startedAt });
        s.toast(d.error ?? "This session does not currently hold the edit lock. Try again in a moment.", "err");
        return null;
      }
      if (!r.ok) {
        console.warn("[rescript:save] version FAILED", { surveyId: s.surveyDbId, baseRevision, status: r.status, error: d.error, ms: Date.now() - startedAt });
        /*
         * 422 is the server saying the definition is wrong, not that the
         * network is. It carries the detail — `lint.problems` from the publish
         * gate, `issues` from the schema — and neither is retryable, so both
         * get the panel rather than a toast that tells the user to try again.
         */
        const problems: { area: string; message: string }[] = Array.isArray(d.lint?.problems)
          ? d.lint.problems
          : Array.isArray(d.issues)
            ? d.issues.map((i: unknown) =>
                typeof i === "string"
                  ? { area: "definition", message: i }
                  : { area: ((i as { path?: unknown[] }).path ?? []).join(".") || "definition", message: String((i as { message?: unknown }).message ?? i) })
            : [];
        if (problems.length || r.status === 422) {
          setBlocker({
            title: r.status === 422 ? "This version was not saved" : `Save failed (${r.status})`,
            message: d.error ?? "The server refused this definition.",
            problems,
            retryable: r.status !== 422,
          });
        } else {
          s.toast(d.error ?? `save failed (${r.status})`, "err");
        }
        return null;
      }
      console.debug("[rescript:save] version done", { surveyId: s.surveyDbId, baseRevision, newRevision: d.revision, version: d.version, versionId: d.id, ms: Date.now() - startedAt });
      /* the assigned version number is merged by `markSaved` — going through
         `update()` would push an undo entry and mark the editor dirty for a
         number the server chose, and it has to happen after the comparison
         that decides whether anything ELSE is pending */
      s.markSaved(d.id, typeof d.revision === "number" ? d.revision : null, { saved: posted, version: d.version });
      setPublishState(null); // the gap to live has changed
      s.toast(`Saved version ${d.version} (${d.variables} variables)`);
      return d.id as string;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  /**
   * Live preview.
   *
   * This used to capture `s.def` in a closure at click time and re-post that
   * one snapshot ten times over five seconds. Every edit after the click —
   * switching a question to Side-by-Side, pasting an image URL, changing the
   * column layout — never reached the open tab, so the preview kept showing
   * the old question and the change looked broken. Three separate bug reports
   * traced back to it.
   *
   * Now the open window is remembered and the current definition is pushed on
   * every change, debounced.
   */
  // the window handle and the entry point (whole survey / a block) live in
  // previewWindow.ts so the block headers in the Questions panel share them
  React.useEffect(() => {
    const onReady = (e: MessageEvent) => {
      if (e.data?.type === "rescript:preview-ready") pushPreview(defRef.current);
    };
    window.addEventListener("message", onReady);
    return () => window.removeEventListener("message", onReady);
  }, []);

  // and every subsequent edit follows it across
  React.useEffect(() => {
    setPreviewDefinition(s.def);
    if (!previewWindowOpen()) return;
    const t = setTimeout(() => pushPreview(defRef.current), 250);
    return () => clearTimeout(t);
  }, [s.def]);

  const preview = () => {
    if (!openPreview(runtimeBaseUrl(), defRef.current, {})) return;
    // persist what is being previewed, so a crash mid-test loses nothing
    void s.flushDraft().then(() => setPreviewRevision(s.currentRevision()));
  };

  /** The build the last Test Survey click produced — shown beside the button. */
  const [lastTest, setLastTest] = React.useState<{ version: string; revision: number | null } | null>(null);

  /**
   * Test Survey = save, then run EXACTLY what was saved.
   *
   *   unsaved changes → flush the draft → cut a version → deploy the slug →
   *   open /t/<client>/<study>?v=<that version id>
   *
   * The `?v=` is the handshake: the runtime loads that version or shows an
   * error — it never quietly serves whatever the test deployment pointed at
   * before. The tab is opened synchronously, inside the click, because a
   * `window.open` after two awaits is what popup blockers exist to stop; when
   * it was blocked here the save still happened, nothing opened, and the
   * tester reached for an old tab or bookmark and tested an older build.
   *
   * The slugs are read from `defRef` AFTER the save resolves — reading `s.def`
   * from the closure deployed to whatever the slugs were when the button was
   * clicked, which is how a renamed study ended up serving an old deployment.
   */
  const testSurvey = async () => {
    if (s.hasConflict()) {
      s.toast("This survey changed elsewhere. Reload before testing, or you would be testing an older state.", "err");
      return;
    }
    const tab = window.open("", "rescript_test");
    // the named window is reused across clicks; once it holds the runtime it
    // is cross-origin and its document is off limits — only its location is not
    try {
      tab?.document.write("<title>Rescript — saving…</title><p style='font:14px system-ui;padding:24px'>Saving your latest changes, then opening the test survey…</p>");
    } catch { /* already showing a previous build; it will be navigated below */ }
    const fail = (msg: string) => {
      console.warn("[rescript:test] refused", { surveyId: s.surveyDbId, reason: msg });
      s.toast(msg, "err");
      if (tab && !tab.closed) tab.close();
    };
    const versionId = await save("test build");
    if (!versionId) {
      /*
       * `save()` has already said why — in the blocker panel for a refused
       * definition, or in a toast for everything else. Raising a second,
       * vaguer message here OVERWROTE it: the toast is a single slot, so the
       * specific reason lived for a few milliseconds before "could not be
       * saved, please retry" replaced it. That is the message in the bug
       * report, and it is the one message that cannot be acted on.
       */
      console.warn("[rescript:test] refused", { surveyId: s.surveyDbId, reason: "save did not produce a version" });
      if (tab && !tab.closed) tab.close();
      return;
    }
    const dep = defRef.current.deployment;
    const r = await fetch(`/api/surveys/${s.surveyDbId}/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        versionId,
        clientSlug: dep.clientSlug || "client",
        studySlug: dep.studySlug || "study-001",
        customDomain: dep.customDomain ?? null,
        mode: "test",
      }),
      cache: "no-store",
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.url) {
      const problems = Array.isArray(d.lint?.problems) ? d.lint.problems : [];
      if (problems.length) {
        // the deploy gate has no override, so this is never "retry"
        setBlocker({
          title: "The test link was not deployed",
          message: d.error ?? "This survey has problems that would reach respondents.",
          problems,
          retryable: false,
        });
        console.warn("[rescript:test] refused", { surveyId: s.surveyDbId, reason: "deploy gate" });
        if (tab && !tab.closed) tab.close();
        return;
      }
      fail(d.error ?? "The test link could not be deployed. Your version was saved; please retry.");
      return;
    }
    /*
     * THE TEST LINK NO LONGER PINS A VERSION, AND THAT IS THE WHOLE FIX FOR
     * "I HAVE TO RESTART THE RUNTIME TO SEE MY CHANGE".
     *
     * It used to append `?v=<versionId>`. That is branch ONE of
     * `decideTestBuild` — an explicit version, which the database enforces as
     * immutable (`rescript_versions_are_immutable`). So every later edit wrote
     * `surveys.draft_definition` and bumped the revision while the test tab,
     * reloaded any number of times, kept resolving the same frozen snapshot.
     * Nothing was stale and no cache was at fault: the URL was asking for the
     * old build, and the runtime was correctly giving it.
     *
     * Without the pin the same link falls to branch TWO — the autosaved draft,
     * read straight from Postgres on every request and deliberately excluded
     * from the version cache because it changes on every autosave. A reload
     * now shows the latest work, and the runtime's resume pointer puts the
     * tester back on the page they were on.
     *
     * The version is still cut, still deployed and still logged: that is what
     * makes the state reproducible and is what the Versions panel pins with
     * `?v=` when somebody genuinely wants to test one exact build.
     */
    const url = d.url;
    console.info("[rescript:test] opening", { surveyId: s.surveyDbId, versionId, version: defRef.current.meta.version, revision: s.revision, url, pinned: false });
    setLastTest({ version: defRef.current.meta.version, revision: s.revision });
    if (tab && !tab.closed) tab.location.href = url;
    else {
      // the popup was blocked after all — give the tester the link instead of silence
      const win = window.open(url, "_blank");
      if (!win) s.toast(`Pop-up blocked. Open the test survey here: ${url}`, "err");
    }
  };

  /** What each deployment mode is actually serving, so the gap is visible. */
  const loadPublishState = React.useCallback(async () => {
    // read-only probe: safe everywhere, including the /sandbox fixture where
    // it simply returns nothing
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/publish`, { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      setPublishState(d.deployments ?? []);
    } catch { /* the banner is additive — never block the editor on it */ }
  }, [s.surveyDbId]);
  React.useEffect(() => { void loadPublishState(); }, [loadPublishState]);

  const publishLive = async () => {
    const versionId = await save("publish");
    if (!versionId) return;
    const dep = defRef.current.deployment;
    const r = await fetch(`/api/surveys/${s.surveyDbId}/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        versionId,
        clientSlug: dep.clientSlug || "client",
        studySlug: dep.studySlug || "study-001",
        customDomain: dep.customDomain ?? null,
        mode: "live",
      }),
      cache: "no-store",
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      s.toast(`Published v${defRef.current.meta.version} to the live link`);
      void loadPublishState();
    } else {
      s.toast(d.error ?? "publish failed", "err");
    }
  };

  /*
   * THE handover from server truth to editor behaviour.
   *
   * Every poll, the server's verdict is pushed into the store, which refuses
   * `update`/`replace` and stops the autosave while it holds. So losing the
   * lock — to a stale timeout, an owner's takeover, or a role change — drops
   * this editor into read-only within one interval, with no refresh (§38),
   * instead of letting it keep accepting edits that the backend will reject.
   *
   * The sandbox has no project row and no lock, so it stays editable: it is a
   * fixture for the browser suites, not a real project.
   */
  React.useEffect(() => {
    if (!collaboration) { s.setReadOnly(false); return; }
    if (collab.status !== "ready" || !collab.state) return;
    const { me, lock } = collab.state;
    /*
     * The reason has to be actionable, and the three cases send the user to
     * three different places. Naming the role alone was the unhelpful version:
     * a colleague whose access came from a workspace default would be told
     * "your role on this project is viewer" and go looking for themselves in a
     * member list that has never mentioned them (P0-1).
     */
    const reason = !me.canEdit
      ? me.roleSource === "workspace"
        ? `${me.roleSourceNote ?? "Your workspace grants you read access to this project."} That does not include editing — ask the owner to share it with you directly.`
        : `Your role on this project (${me.role}) does not allow changes.`
      : lock.heldBy && !lock.mine
        ? lock.heldBy.sessionLive === false
          ? `${lock.heldBy.name} left this project open but is no longer signed in. Editing will become available in a moment.`
          : `${lock.heldBy.name} is editing this project. You have read-only access until the editing lock is released.`
        : "Preparing edit mode…";
    s.setReadOnly(me.readOnly, reason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab.status, collab.state?.me.readOnly, collab.state?.lock.heldBy?.userId, collab.state?.me.role, s.surveyDbId]);

  /* read-only AND on a tab that edits the survey: the controls go inert */
  const roPanel = collaboration && collab.readOnly && EDITING_TABS.has(tab);
  /* saving a version or a test build IS a change, whatever tab you are on */
  const roWrite = collaboration && collab.readOnly;

  const live = publishState?.find((p) => p.mode === "live");
  const liveIsBehind = !!live && live.version !== s.def.meta.version;

  /*
   * The command layer sits over the whole shell: the palette and the
   * keyboard handler need the tab and its setter, and the shell's own
   * actions (save, test, preview) are handed to it below so "Save version"
   * in the palette is the same function as the button.
   */
  const navTabs = React.useMemo(() => NAV.map((n) => ({ key: n.key, label: n.label, group: n.group })), []);
  const programmingMode = useMode()?.mode ?? "studio";
  const setTabGuarded = React.useCallback((t: string) => {
    if (t === tab || s.canLeaveTab()) setTab(t as Tab);
  }, [tab, s]);
  const shellActions: ShellActions = { save: async () => { await save(); }, testSurvey, preview };

  return (
    <CommandProvider tab={tab} setTab={setTabGuarded} tabs={navTabs}>
    <ShellBridge actions={shellActions} />
    <CommandPalette />
    <div className="ide">
      <div className="topbar">
        <a href="/" className="logo-mark" style={{ width: 30, height: 30, fontSize: 15 }} title="Dashboard">R</a>
        <div className="ctx" data-testid="project-context">
          <span className="ctx-title title">{s.def.meta.title}</span>
          <span className="ctx-meta">
            <span className="mono">{s.def.meta.code}</span>
            <span className="ctx-sep">·</span>
            <span className="ver" title="Version number of the last saved version, and the row revision every save is based on">
              v{s.def.meta.version}{s.revision != null && <span className="muted"> · rev {s.revision}</span>}
            </span>
            {live && <><span className="ctx-sep">·</span><span className={`badge ${liveIsBehind ? "warning" : "success"}`} title={liveIsBehind ? `Live link runs v${live.version}` : "Live link is on this version"}>Live v{live.version}</span></>}
          </span>
        </div>
        <SaveIndicator />
        <ModeSelector />
        <span className="spacer" />
        <PaletteButton />
        <button className="btn" onClick={preview} disabled={saving}
          title="Full-page preview of the survey you are editing right now"><Icon name="play" size={15} /> Preview</button>
        <button className="btn" onClick={testSurvey} disabled={saving || roWrite} data-testid="test-survey"
          {...(roWrite ? { title: "Enter edit mode to save a test build" } : {})}
          title={lastTest
            ? `Saves your latest changes as a new version and opens exactly that. Last test build: v${lastTest.version}${lastTest.revision != null ? ` (rev ${lastTest.revision})` : ""}`
            : "Saves your latest changes as a new version, deploys it to the test link and opens exactly that version with the inspector"}>
          <Icon name="flask" size={15} /> {saving ? "Saving…" : "Test Survey"}
        </button>
        <a className="btn" href={`/api/surveys/${s.surveyDbId}/export/xlsx`} target="_blank"><Icon name="download" size={15} /> Variables .xlsx</a>
        <button className="btn" data-testid="export-survey" onClick={() => setExportOpen(true)}
          title="Export the survey you are editing as Word or JSON"><Icon name="export" size={15} /> Export</button>
        <WalletBadge surveyId={s.surveyDbId} onOpen={() => setTab("usage")} />
        <button className="btn" onClick={() => setTab("data")} title="Browse test and live responses"><Icon name="data" size={15} /> Data</button>
        {session.state.kind === "signed_in" && (
          <span className="row" style={{ gap: 6 }} data-testid="studio-user">
            <span
              className="avatar sm"
              style={{ background: `hsl(${[...session.state.user.userId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)} 62% 45%)` }}
              title={`${session.state.user.name} · ${session.state.user.userCode}`}
              aria-hidden="true"
            >
              {session.state.user.name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?"}
            </span>
            <a className="btn" href="/profile" title={`${session.state.user.name} (${session.state.user.userCode})`}>Account</a>
          </span>
        )}
        <button className="btn primary" disabled={saving || roWrite} onClick={() => save()}
          {...(roWrite ? { title: "Enter edit mode to save a version" } : {})}
          title="Save an immutable snapshot; the next version number is assigned by the server">
          {saving ? "Saving…" : "Save version"}
        </button>
      </div>
      {blocker && (
        <div className="save-blocker" role="alert" data-testid="save-blocker">
          <div className="save-blocker-head">
            <strong>{blocker.title}</strong>
            <button className="btn small" data-testid="save-blocker-close" onClick={() => setBlocker(null)}>Dismiss</button>
          </div>
          <p className="save-blocker-msg">{blocker.message}</p>
          {blocker.problems.length > 0 && (
            <ul className="save-blocker-list" data-testid="save-blocker-problems">
              {blocker.problems.map((pb, i) => (
                <li key={`${pb.area}:${i}`}>
                  <span className="save-blocker-area">{pb.area}</span> {pb.message}
                </li>
              ))}
            </ul>
          )}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            {/* the survey lint lives in the Logic panel — a button, not an instruction */}
            <button className="btn small" data-testid="save-blocker-checks"
              onClick={() => { setTab("logic"); setBlocker(null); }}>Open the logic checks</button>
            {blocker.retryable && (
              <button className="btn small" data-testid="save-blocker-retry"
                onClick={() => { setBlocker(null); void save(); }}>Try again</button>
            )}
          </div>
        </div>
      )}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      <ReadOnlyBar surveyId={s.surveyDbId} onOpen={() => setTab("usage")} />
      {liveIsBehind && (
        <div className="publish-bar" data-testid="publish-bar">
          <span className="publish-dot" />
          The live link is running <strong>v{live!.version}</strong> — you are editing{" "}
          <strong>v{s.def.meta.version}</strong>. Respondents will not see your changes until you
          publish.
          <span className="grow" />
          <a className="btn small" target="_blank" rel="noreferrer"
            href={`${surveyBaseUrl(s.def.deployment.customDomain)}/s/${live!.client_slug}/${live!.study_slug}`}>open live link</a>
          <button className="btn small primary" disabled={saving || roWrite} onClick={publishLive}>
            Publish v{s.def.meta.version} to live
          </button>
        </div>
      )}
      {session.state.kind === "signed_out" && collaboration && (
        <div className="lockbar other" data-testid="session-ended">
          <span aria-hidden="true">⚠</span>
          <span className="lb-title">
            {session.state.reason || "Your session has ended."} Anything unsaved is still on this page.
          </span>
          <span className="grow" />
          <a className="btn small primary" href="/login">Sign in again</a>
        </div>
      )}
      {collaboration && (
        <CollabBar
          collab={collab.state}
          readOnly={collab.readOnly}
          busy={collab.busy}
          onEnter={async () => {
            const r = await collab.enterEditMode();
            if (!r.ok) s.toast(r.error, "err");
          }}
          onExit={async () => { await collab.exitEditMode(); }}
          onForce={async (reason) => {
            const r = await collab.forceRelease(reason);
            s.toast(r.ok ? "Edit lock released." : r.error, r.ok ? "ok" : "err");
          }}
          onRequest={async (message) => {
            const r = await collab.requestAccess(message);
            s.toast(r.ok ? "The current editor has been asked for access." : r.error, r.ok ? "ok" : "err");
          }}
          onOpenPanel={(panel) => setTab(panel)}
        />
      )}
      {/* The centre column and the right panel are siblings, so the question
          editor cannot tell the property panel which element is selected.
          The provider sits above both and carries exactly that — the view the
          open question is in, and what is selected inside it. It holds no
          question data: the definition remains the store's, and there is one
          of it. */}
      <CanvasProvider>
      <div className={`ide-body ${collab.readOnly && s.surveyDbId !== "sandbox" ? "is-readonly" : ""}`}>
        <nav className="leftnav" aria-label="Studio">
          {NAV.map((n, i) => (
            <React.Fragment key={n.key}>
              {(i === 0 || NAV[i - 1].group !== n.group) && <div className="nav-group">{n.group}</div>}
              <button className={`nav-item ${tab === n.key ? "active" : ""}`} aria-current={tab === n.key ? "page" : undefined} onClick={() => { if (n.key === tab || s.canLeaveTab()) setTab(n.key); }}>
                <Icon name={n.icon} />
                {n.label}
                {counts[n.key] != null && <span className="nav-count">{counts[n.key]}</span>}
              </button>
              {/* Data Analytics is its own top-level workspace; this is a link out, not a Studio tab — nothing here changes. */}
              {n.key === "data" && (
                <a className="nav-item" href={s.surveyDbId ? `/analytics?survey=${encodeURIComponent(s.surveyDbId)}` : "/analytics"} data-testid="nav-analytics" title="Open Data Analytics for this survey">
                  <Icon name="analytics" />
                  Data Analytics
                </a>
              )}
            </React.Fragment>
          ))}
        </nav>
        <main className={`center${roPanel ? " ro" : ""}`} data-readonly={roPanel ? "1" : "0"}>
          {collaboration && !["collaborators", "notes", "activity", "data"].includes(tab) && (
            <ReadOnlyNotice
              collab={collab.state}
              busy={collab.busy}
              onEnter={async () => {
                const r = await collab.enterEditMode();
                if (!r.ok) s.toast(r.error, "err");
              }}
            />
          )}
          {/*
            * THE MODE RENDERERS. Each programming mode is another way of
            * looking at the same survey; here is where the centre column
            * chooses which. Studio is the Questions panel as it has always
            * been. Grid shows the same questions as rows. Both read and
            * write the same store, so switching is a re-render, not a load.
            */}
          {tab === "questions" && (
            programmingMode === "grid" ? <GridView />
            : programmingMode === "architect" ? <ArchitectView />
            : <QuestionsPanel />
          )}
          {tab === "settings" && (
            /*
             * Sept 21 follow-up ("Priority UI Fix: Survey Flow & Survey
             * Settings — Right Panel Layout"): this used to be capped at a
             * flat 620px — reasonable back when the right panel reserved
             * ~390-440px beside it, a dead cap once that panel is hidden on
             * this tab (see RightPanel in this file) and `main` has the
             * space to itself. `.settings-wrap` widens the cap to match the
             * same generous-but-bounded width this app already uses for its
             * other "uses available space well" pages (`.dash`, `.ax-page`
             * in globals.css), and `SurveySettings`'s own fields now sit in
             * a responsive grid (`.settings-grid`) that reflows into more
             * columns as space allows, rather than one field stretched
             * edge to edge.
             */
            <div className="settings-wrap">
              <h2 style={{ margin: "0 0 14px", fontSize: 17 }}>Survey settings</h2>
              <SurveySettings />
            </div>
          )}
          {tab === "flow" && <FlowPanel />}
          {tab === "logic" && <LogicPanel />}
          {tab === "tests" && <TestsPanel />}
          {tab === "variables" && <VariablesPanel />}
          {tab === "calculations" && <CalcPanel />}
          {tab === "quotas" && <QuotaDashboard />}
          {tab === "listfill" && <ListFillPanel />}
          {tab === "designs" && <DesignsPanel />}
          {tab === "branding" && <BrandingPanel />}
          {tab === "assets" && <AssetsPanel />}
          {tab === "localization" && <LocalizationPanel />}
          {tab === "scripts" && <ScriptsPanel />}
          {tab === "data" && <DataPanel />}
          {tab === "fieldwork" && <FieldworkPanel />}
          {tab === "project" && <ProjectPanel />}
          {tab === "usage" && <UsagePanel />}
          {tab === "distribution" && <DistributionPanel />}
          {tab === "versions" && <VersionsPanel />}
          {tab === "json" && <JsonPanel />}
          {tab === "collaborators" && <CollaboratorsPanel canShare={!!collab.state?.me.canShare} />}
          {tab === "notes" && <NotesPanel canComment={!!collab.state?.me.canComment} canResolve={!!collab.state?.me.canComment} />}
          {tab === "activity" && (
            <>
              <ActivityPanel />
              {/*
                * Diagnostics live under Activity because that is where somebody
                * already goes to ask "what happened to this project" — and the
                * panel renders nothing at all when diagnostics are switched
                * off, so this costs a signed-out or production viewer nothing.
                */}
              {collaboration && <DiagnosticsPanel />}
            </>
          )}
        </main>
        {/* Architect carries its own inspector, so the outer property panel steps aside there */}
        <RightPanel tab={tab} hidden={programmingMode === "architect" && tab === "questions"} />
      </div>
      </CanvasProvider>
    </div>
    </CommandProvider>
  );
}

/** Hands the shell's save/test/preview to the command layer once they exist. */
function ShellBridge({ actions }: { actions: ShellActions }) {
  const api = useCommands();
  const ref = React.useRef(actions);
  ref.current = actions;
  const setShell = api?.setShell;
  React.useEffect(() => {
    // register once (setShell is stable); the ref keeps the latest closures
    setShell?.({
      save: () => ref.current.save?.(),
      testSurvey: () => ref.current.testSurvey?.(),
      preview: () => ref.current.preview?.(),
    });
  }, [setShell]);
  return null;
}

/** The ⌘K affordance in the top bar — for people who do not know the key yet. */
function PaletteButton() {
  const api = useCommands();
  if (!api) return null;
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button className="btn palette-open" onClick={api.openPalette} data-testid="palette-open"
      title="Commands, questions and variables — everything, one search">
      <Icon name="search" size={15} /> <kbd className="palette-kbd">{mac ? "⌘K" : "Ctrl+K"}</kbd>
    </button>
  );
}

export function Studio({ definition, surveyDbId, versionId, draftSavedAt, revision, collaboration = true }: {
  definition: SurveyDefinition; surveyDbId: string; versionId: string | null;
  /**
   * Whether this editor participates in presence, the edit lock and read-only
   * mode. On by default — a real project always does.
   *
   * The `/sandbox` fixture turns it OFF: it drives the Studio with no session
   * and no project row, so a collaboration poll would answer 401 and leave the
   * editor permanently read-only for reasons that have nothing to do with
   * collaboration. The fixture opts back in with `?collab=1`, which is how the
   * collaboration suite exercises this layer.
   */
  collaboration?: boolean;
  /** set when the loaded definition came from an autosaved draft */
  draftSavedAt?: string | null;
  /** the row revision this editor loaded on top of */
  revision?: number | null;
}) {
  return (
    <StudioProvider initial={definition} surveyDbId={surveyDbId} versionId={versionId}
      draftSavedAt={draftSavedAt} revision={revision}
      readOnly={collaboration}>
      {/* the programming mode and the shared selection sit above the shell:
          both survive a tab change, and every environment reads them */}
      <ModeProvider>
        <SelectionProvider>
          <StudioShell collaboration={collaboration} />
        </SelectionProvider>
      </ModeProvider>
    </StudioProvider>
  );
}


/**
 * THE WALLET IN THE HEADER (billing brief §10, §13): the remaining balance,
 * coloured by level, one click from the Usage tab. Reads once per Studio
 * load and again when the Usage tab changes something; a Studio without the
 * billing tables (migration 0023 not applied) simply shows nothing here.
 */
function WalletBadge({ surveyId, onOpen }: { surveyId: string; onOpen: () => void }) {
  const { view } = useMeterView(surveyId);
  if (!view) return null;
  const level = view.wallet.state === "suspended" ? "locked" : view.level;
  return (
    <button className={`bl-wallet-badge ${level}`} onClick={onOpen} data-testid="wallet-badge" data-level={level} title="Project wallet — open Usage & Wallet">
      <Icon name="chart" size={13} /> {fmtMoney(view.summary.remaining, view.wallet.currency)}
    </button>
  );
}

/** The sentence the brief specifies, across the top of a project at its usage limit (§14). */
function ReadOnlyBar({ surveyId, onOpen }: { surveyId: string; onOpen: () => void }) {
  const { view } = useMeterView(surveyId);
  if (!view || (view.wallet.state !== "read_only" && view.wallet.state !== "suspended")) return null;
  return (
    <div className="bl-readonly-bar" data-testid="wallet-readonly-bar">
      <span aria-hidden="true">⚠</span>
      <span>{view.wallet.state === "suspended" ? "This project's wallet is suspended. Please contact your administrator." : view.message || "Your project has reached its usage limit. Please request additional credits from your administrator."}</span>
      <span className="grow" />
      <button className="btn small" onClick={onOpen}>Usage &amp; Wallet</button>
    </div>
  );
}
