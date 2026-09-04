"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { StudioProvider, useStudio } from "./store";
import { openPreview, pushPreview, previewWindowOpen, setPreviewDefinition, setPreviewRevision } from "./previewWindow";
import { ExportDialog } from "./ExportDialog";
import { QuestionsPanel } from "./QuestionsPanel";
import { PropertiesPanel, SurveySettings } from "./PropertiesPanel";
import { FlowPanel } from "./FlowPanel";
import { LogicPanel, CalcPanel } from "./LogicPanel";
import { VariablesPanel } from "./VariablesPanel";
import { QuotasPanel } from "./QuotasPanel";
import { ListFillPanel } from "./ListFillPanel";
import { CollabBar, ReadOnlyNotice } from "./CollabBar";
import { CollaboratorsPanel } from "./CollaboratorsPanel";
import { NotesPanel, ActivityPanel } from "./NotesPanel";
import { useCollab } from "@/lib/useCollab";
import { useSession } from "@/lib/useSession";
import { DesignsPanel } from "./DesignsPanel";
import { BrandingPanel, ScriptsPanel } from "./BrandingPanel";
import { VersionsPanel } from "./VersionsPanel";
import { JsonPanel } from "./JsonPanel";
import { DataPanel } from "./DataPanel";
import { runtimeBaseUrl } from "@/lib/runtime-url";

type Tab =
  | "questions" | "flow" | "logic" | "variables" | "calculations"
  | "quotas" | "listfill" | "designs" | "branding" | "scripts" | "data" | "versions" | "json"
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
  "quotas", "listfill", "designs", "branding", "scripts", "json",
]);

const NAV: { key: Tab; label: string; icon: string }[] = [
  { key: "questions", label: "Questions", icon: "▤" },
  { key: "settings", label: "Survey Settings", icon: "⚙" },
  { key: "flow", label: "Survey Flow", icon: "⇉" },
  { key: "logic", label: "Logic", icon: "⑂" },
  { key: "variables", label: "Variables", icon: "𝑥" },
  { key: "calculations", label: "Calculations", icon: "∑" },
  { key: "quotas", label: "Quotas", icon: "◔" },
  { key: "listfill", label: "List Fill", icon: "⇲" },
  { key: "designs", label: "Design Generators", icon: "⚗" },
  { key: "branding", label: "Branding", icon: "◩" },
  { key: "scripts", label: "Scripts", icon: "{}" },
  { key: "data", label: "Data", icon: "▦" },
  { key: "versions", label: "Versions & Deploy", icon: "⎌" },
  { key: "json", label: "JSON", icon: "≡" },
  { key: "collaborators", label: "Collaborators", icon: "◉" },
  { key: "notes", label: "Internal notes", icon: "✎" },
  { key: "activity", label: "Activity", icon: "⏱" },
];

/**
 * The save indicator is the honest answer to "is my work safe?".
 *
 * It reports the DRAFT autosave, not the version — that is what protects a
 * refresh — and says plainly when autosave is unavailable rather than showing
 * a reassuring tick over unsaved work.
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
    case "conflict":
      // deliberately loud and deliberately terminal: autosave has stopped, and
      // the one safe action is to reload, because this editor is behind
      return (
        <span className="save-state err" data-testid="save-state" title={st.message}>
          ⚠ Changed elsewhere — not saved.{" "}
          <button className="btn small" style={{ marginLeft: 6 }}
            onClick={() => window.location.reload()}>Reload</button>
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
  /*
   * The collaboration poll drives presence, the lock and read-only mode. The
   * section is reported so a future section-level lock (§18) already has the
   * information it needs — today it only annotates "editing Survey Flow" in
   * the banner and the audit trail.
   */
  const collab = useCollab(collaboration ? s.surveyDbId : null, { section: null });
  // ?tab=data lets the dashboard link straight to a survey's responses
  const [exportOpen, setExportOpen] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>(() => {
    if (typeof window === "undefined") return "questions";
    const t = new URLSearchParams(window.location.search).get("tab");
    return (NAV.some((n) => n.key === t) ? t : "questions") as Tab;
  });
  React.useEffect(() => { s.setGoToTab((t) => setTab(t as Tab)); }, [s]);
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
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
    if (savingRef.current) return null; // one save at a time
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
      const r = await fetch(`/api/surveys/${s.surveyDbId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // the revision this editor is working on top of, so the DATABASE can
        // refuse the finalize too — the client's check is the fast path, not
        // the guarantee
        body: JSON.stringify({ definition: defRef.current, label, baseRevision: s.currentRevision() }),
        cache: "no-store",
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409) {
        console.warn("[rescript:save] version REFUSED by the server (stale)", { surveyId: s.surveyDbId, baseRevision, serverRevision: d.revision, ms: Date.now() - startedAt });
        s.noteConflict(typeof d.revision === "number" ? d.revision : null, d.error);
        s.toast(d.error ?? "This survey changed elsewhere, so nothing was saved. Reload before saving again.", "err");
        return null;
      }
      if (!r.ok) {
        console.warn("[rescript:save] version FAILED", { surveyId: s.surveyDbId, baseRevision, status: r.status, error: d.error, ms: Date.now() - startedAt });
        s.toast(d.error ?? "save failed", "err");
        return null;
      }
      console.debug("[rescript:save] version done", { surveyId: s.surveyDbId, baseRevision, newRevision: d.revision, version: d.version, versionId: d.id, ms: Date.now() - startedAt });
      // merge ONLY the assigned version number into the live state
      s.update((draft) => { draft.meta.version = d.version; });
      s.markSaved(d.id, typeof d.revision === "number" ? d.revision : null);
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
      fail("Your latest changes could not be saved. Please retry before starting the test survey.");
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
        mode: "test",
      }),
      cache: "no-store",
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.url) {
      fail(d.error ?? "The test link could not be deployed. Your version was saved; please retry.");
      return;
    }
    const url = `${d.url}${d.url.includes("?") ? "&" : "?"}v=${encodeURIComponent(versionId)}`;
    console.info("[rescript:test] opening", { surveyId: s.surveyDbId, versionId, version: defRef.current.meta.version, revision: s.revision, url });
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
    const reason = !me.canEdit
      ? `Your role on this project (${me.role}) does not allow changes.`
      : lock.heldBy && !lock.mine
        ? `${lock.heldBy.name} is editing this project. You have read-only access until the editing lock is released.`
        : "You are in view mode. Enter edit mode to make changes.";
    s.setReadOnly(me.readOnly, reason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab.status, collab.state?.me.readOnly, collab.state?.lock.heldBy?.userId, collab.state?.me.role, s.surveyDbId]);

  /* read-only AND on a tab that edits the survey: the controls go inert */
  const roPanel = collaboration && collab.readOnly && EDITING_TABS.has(tab);
  /* saving a version or a test build IS a change, whatever tab you are on */
  const roWrite = collaboration && collab.readOnly;

  const live = publishState?.find((p) => p.mode === "live");
  const liveIsBehind = !!live && live.version !== s.def.meta.version;

  return (
    <div className="ide">
      <div className="topbar">
        <a href="/" className="logo-mark" style={{ width: 26, height: 26, fontSize: 14 }}>R</a>
        <span className="title">{s.def.meta.title}</span>
        <span className="ver" title="Version number of the last saved version, and the row revision every save is based on">
          {s.def.meta.code} · v{s.def.meta.version}{s.revision != null && <span className="muted"> · rev {s.revision}</span>}
        </span>
        <SaveIndicator />
        <span className="spacer" />
        <button className="btn" onClick={preview} disabled={saving}
          title="Full-page preview of the survey you are editing right now">▶ Preview</button>
        <button className="btn" onClick={testSurvey} disabled={saving || roWrite} data-testid="test-survey"
          {...(roWrite ? { title: "Enter edit mode to save a test build" } : {})}
          title={lastTest
            ? `Saves your latest changes as a new version and opens exactly that. Last test build: v${lastTest.version}${lastTest.revision != null ? ` (rev ${lastTest.revision})` : ""}`
            : "Saves your latest changes as a new version, deploys it to the test link and opens exactly that version with the inspector"}>
          {saving ? "Saving…" : "🧪 Test Survey"}
        </button>
        <a className="btn" href={`/api/surveys/${s.surveyDbId}/export/xlsx`} target="_blank">⬇ Variables .xlsx</a>
        <button className="btn" data-testid="export-survey" onClick={() => setExportOpen(true)}
          title="Export the survey you are editing as Word or JSON">⬇ Export</button>
        <button className="btn" onClick={() => setTab("data")} title="Browse test and live responses">▦ Data</button>
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
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {liveIsBehind && (
        <div className="publish-bar" data-testid="publish-bar">
          <span className="publish-dot" />
          The live link is running <strong>v{live!.version}</strong> — you are editing{" "}
          <strong>v{s.def.meta.version}</strong>. Respondents will not see your changes until you
          publish.
          <span className="grow" />
          <a className="btn small" target="_blank" rel="noreferrer"
            href={`${runtimeBaseUrl()}/s/${live!.client_slug}/${live!.study_slug}`}>open live link</a>
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
      <div className={`ide-body ${collab.readOnly && s.surveyDbId !== "sandbox" ? "is-readonly" : ""}`}>
        <nav className="leftnav">
          {NAV.map((n) => (
            <button key={n.key} className={`nav-item ${tab === n.key ? "active" : ""}`} onClick={() => setTab(n.key)}>
              <span style={{ width: 16, textAlign: "center" }}>{n.icon}</span>
              {n.label}
              {counts[n.key] != null && <span className="nav-count">{counts[n.key]}</span>}
            </button>
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
          {tab === "questions" && <QuestionsPanel />}
          {tab === "settings" && (
            <div style={{ maxWidth: 620 }}>
              <h2 style={{ margin: "0 0 14px", fontSize: 17 }}>Survey settings</h2>
              <SurveySettings />
            </div>
          )}
          {tab === "flow" && <FlowPanel />}
          {tab === "logic" && <LogicPanel />}
          {tab === "variables" && <VariablesPanel />}
          {tab === "calculations" && <CalcPanel />}
          {tab === "quotas" && <QuotasPanel />}
          {tab === "listfill" && <ListFillPanel />}
          {tab === "designs" && <DesignsPanel />}
          {tab === "branding" && <BrandingPanel />}
          {tab === "scripts" && <ScriptsPanel />}
          {tab === "data" && <DataPanel />}
          {tab === "versions" && <VersionsPanel />}
          {tab === "json" && <JsonPanel />}
          {tab === "collaborators" && <CollaboratorsPanel canShare={!!collab.state?.me.canShare} />}
          {tab === "notes" && <NotesPanel canComment={!!collab.state?.me.canComment} canResolve={!!collab.state?.me.canComment} />}
          {tab === "activity" && <ActivityPanel />}
        </main>
        <aside className="rightpanel">
          <PropertiesPanel />
        </aside>
      </div>
    </div>
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
      <StudioShell collaboration={collaboration} />
    </StudioProvider>
  );
}
