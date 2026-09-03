"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { StudioProvider, useStudio } from "./store";
import { ExportDialog } from "./ExportDialog";
import { QuestionsPanel } from "./QuestionsPanel";
import { PropertiesPanel, SurveySettings } from "./PropertiesPanel";
import { FlowPanel } from "./FlowPanel";
import { LogicPanel, CalcPanel } from "./LogicPanel";
import { VariablesPanel } from "./VariablesPanel";
import { QuotasPanel } from "./QuotasPanel";
import { DesignsPanel } from "./DesignsPanel";
import { BrandingPanel, ScriptsPanel } from "./BrandingPanel";
import { VersionsPanel } from "./VersionsPanel";
import { JsonPanel } from "./JsonPanel";
import { DataPanel } from "./DataPanel";
import { runtimeBaseUrl } from "@/lib/runtime-url";

type Tab =
  | "questions" | "flow" | "logic" | "variables" | "calculations"
  | "quotas" | "designs" | "branding" | "scripts" | "data" | "versions" | "json"
  | "settings";

const NAV: { key: Tab; label: string; icon: string }[] = [
  { key: "questions", label: "Questions", icon: "▤" },
  { key: "settings", label: "Survey Settings", icon: "⚙" },
  { key: "flow", label: "Survey Flow", icon: "⇉" },
  { key: "logic", label: "Logic", icon: "⑂" },
  { key: "variables", label: "Variables", icon: "𝑥" },
  { key: "calculations", label: "Calculations", icon: "∑" },
  { key: "quotas", label: "Quotas", icon: "◔" },
  { key: "designs", label: "Design Generators", icon: "⚗" },
  { key: "branding", label: "Branding", icon: "◩" },
  { key: "scripts", label: "Scripts", icon: "{}" },
  { key: "data", label: "Data", icon: "▦" },
  { key: "versions", label: "Versions & Deploy", icon: "⎌" },
  { key: "json", label: "JSON", icon: "≡" },
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
          ⚠ Save failed — {st.message.slice(0, 60)}
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

function StudioShell() {
  const s = useStudio();
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
    savingRef.current = true;
    setSaving(true);
    try {
      // make sure the draft on the server matches what we are about to version
      await s.flushDraft();
      const r = await fetch(`/api/surveys/${s.surveyDbId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: defRef.current, label }),
        cache: "no-store",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        s.toast(d.error ?? "save failed", "err");
        return null;
      }
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
  const previewWin = React.useRef<Window | null>(null);

  const pushPreview = React.useCallback(() => {
    const win = previewWin.current;
    if (!win || win.closed) return;
    win.postMessage({ type: "rescript:preview", definition: defRef.current }, "*");
  }, []);

  // the preview tab announces itself when it mounts or reloads
  React.useEffect(() => {
    const onReady = (e: MessageEvent) => {
      if (e.data?.type === "rescript:preview-ready") pushPreview();
    };
    window.addEventListener("message", onReady);
    return () => window.removeEventListener("message", onReady);
  }, [pushPreview]);

  // and every subsequent edit follows it across
  React.useEffect(() => {
    if (!previewWin.current || previewWin.current.closed) return;
    const t = setTimeout(pushPreview, 250);
    return () => clearTimeout(t);
  }, [s.def, pushPreview]);

  const preview = () => {
    const base = runtimeBaseUrl();
    const win = window.open(`${base}/preview`, "rescript_preview");
    if (!win) return;
    previewWin.current = win;
    win.focus();
    // the tab may already be open and past its ready message
    let n = 0;
    const t = setInterval(() => { pushPreview(); if (++n > 6) clearInterval(t); }, 400);
    // persist what is being previewed, so a crash mid-test loses nothing
    void s.flushDraft();
  };

  /**
   * Test always runs the newest save. The slugs are read from `defRef` AFTER
   * the save resolves — reading `s.def` from the closure deployed to whatever
   * the slugs were when the button was clicked, which is how a renamed study
   * ended up serving an old deployment.
   */
  const testSurvey = async () => {
    const versionId = await save("test build");
    if (!versionId) return;
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
    if (d.url) window.open(d.url, "_blank");
    else s.toast(d.error ?? "test deploy failed", "err");
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

  const live = publishState?.find((p) => p.mode === "live");
  const liveIsBehind = !!live && live.version !== s.def.meta.version;

  return (
    <div className="ide">
      <div className="topbar">
        <a href="/" className="logo-mark" style={{ width: 26, height: 26, fontSize: 14 }}>R</a>
        <span className="title">{s.def.meta.title}</span>
        <span className="ver">{s.def.meta.code} · v{s.def.meta.version}</span>
        <SaveIndicator />
        <span className="spacer" />
        <button className="btn" onClick={preview} disabled={saving}
          title="Full-page preview of the survey you are editing right now">▶ Preview</button>
        <button className="btn" onClick={testSurvey} disabled={saving}
          title="Save a version, deploy it to the test link and open it with the inspector">
          {saving ? "Saving…" : "🧪 Test Survey"}
        </button>
        <a className="btn" href={`/api/surveys/${s.surveyDbId}/export/xlsx`} target="_blank">⬇ Variables .xlsx</a>
        <button className="btn" data-testid="export-survey" onClick={() => setExportOpen(true)}
          title="Export the survey you are editing as Word or JSON">⬇ Export</button>
        <button className="btn" onClick={() => setTab("data")} title="Browse test and live responses">▦ Data</button>
        <button className="btn primary" disabled={saving} onClick={() => save()}
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
          <button className="btn small primary" disabled={saving} onClick={publishLive}>
            Publish v{s.def.meta.version} to live
          </button>
        </div>
      )}
      <div className="ide-body">
        <nav className="leftnav">
          {NAV.map((n) => (
            <button key={n.key} className={`nav-item ${tab === n.key ? "active" : ""}`} onClick={() => setTab(n.key)}>
              <span style={{ width: 16, textAlign: "center" }}>{n.icon}</span>
              {n.label}
              {counts[n.key] != null && <span className="nav-count">{counts[n.key]}</span>}
            </button>
          ))}
        </nav>
        <main className="center">
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
          {tab === "designs" && <DesignsPanel />}
          {tab === "branding" && <BrandingPanel />}
          {tab === "scripts" && <ScriptsPanel />}
          {tab === "data" && <DataPanel />}
          {tab === "versions" && <VersionsPanel />}
          {tab === "json" && <JsonPanel />}
        </main>
        <aside className="rightpanel">
          <PropertiesPanel />
        </aside>
      </div>
    </div>
  );
}

export function Studio({ definition, surveyDbId, versionId, draftSavedAt, revision }: {
  definition: SurveyDefinition; surveyDbId: string; versionId: string | null;
  /** set when the loaded definition came from an autosaved draft */
  draftSavedAt?: string | null;
  /** the row revision this editor loaded on top of */
  revision?: number | null;
}) {
  return (
    <StudioProvider initial={definition} surveyDbId={surveyDbId} versionId={versionId}
      draftSavedAt={draftSavedAt} revision={revision}>
      <StudioShell />
    </StudioProvider>
  );
}
