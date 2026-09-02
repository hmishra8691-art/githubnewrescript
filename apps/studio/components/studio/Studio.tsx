"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { StudioProvider, useStudio } from "./store";
import { QuestionsPanel } from "./QuestionsPanel";
import { PropertiesPanel } from "./PropertiesPanel";
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
  | "quotas" | "designs" | "branding" | "scripts" | "data" | "versions" | "json";

const NAV: { key: Tab; label: string; icon: string }[] = [
  { key: "questions", label: "Questions", icon: "▤" },
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

function StudioShell() {
  const s = useStudio();
  const [tab, setTab] = React.useState<Tab>("questions");
  React.useEffect(() => { s.setGoToTab((t) => setTab(t as Tab)); }, [s]);
  const [saving, setSaving] = React.useState(false);

  const counts: Partial<Record<Tab, number>> = {
    questions: s.def.questions.length,
    quotas: s.def.quotas.length,
    calculations: s.def.calculations.length,
    designs: s.def.designs.length,
    scripts: s.def.scripts.length,
  };

  const save = async (label?: string): Promise<string | null> => {
    setSaving(true);
    try {
      const def = structuredClone(s.def);
      // The server resolves the version number from what is actually stored,
      // so a restored-then-saved survey can never collide.
      const r = await fetch(`/api/surveys/${s.surveyDbId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: def, label }),
      });
      const d = await r.json();
      if (!r.ok) {
        s.toast(d.error ?? "save failed", "err");
        return null;
      }
      def.meta.version = d.version;
      s.replace({ ...def });
      s.markSaved(d.id);
      s.toast(`Saved version ${d.version} (${d.variables} variables)`);
      return d.id as string;
    } finally {
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
  const defRef = React.useRef(s.def);
  defRef.current = s.def;

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
  };

  const testSurvey = async () => {
    const versionId = await save("test build");
    if (!versionId) return;
    const r = await fetch(`/api/surveys/${s.surveyDbId}/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        versionId,
        clientSlug: s.def.deployment.clientSlug || "client",
        studySlug: s.def.deployment.studySlug || "study-001",
        mode: "test",
      }),
    });
    const d = await r.json();
    if (d.url) window.open(d.url, "_blank");
    else s.toast(d.error ?? "test deploy failed", "err");
  };

  return (
    <div className="ide">
      <div className="topbar">
        <a href="/" className="logo-mark" style={{ width: 26, height: 26, fontSize: 14 }}>R</a>
        <span className="title">{s.def.meta.title}</span>
        <span className="ver">{s.def.meta.code} · v{s.def.meta.version}</span>
        {s.dirty && <span className="dirty-dot" title="unsaved changes" />}
        <span className="spacer" />
        <button className="btn" onClick={preview} title="Instant in-memory preview (no save)">▶ Preview</button>
        <button className="btn" onClick={testSurvey} title="Save + deploy test URL with inspector">🧪 Test Survey</button>
        <a className="btn" href={`/api/surveys/${s.surveyDbId}/export/xlsx`} target="_blank">⬇ Variables .xlsx</a>
        <button className="btn" onClick={() => setTab("data")} title="Browse test and live responses">▦ Data</button>
        <button className="btn primary" disabled={saving} onClick={() => save()}
          title="Save an immutable snapshot; the next version number is assigned by the server">
          {saving ? "Saving…" : "Save version"}
        </button>
      </div>
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

export function Studio({ definition, surveyDbId, versionId }: {
  definition: SurveyDefinition; surveyDbId: string; versionId: string | null;
}) {
  return (
    <StudioProvider initial={definition} surveyDbId={surveyDbId} versionId={versionId}>
      <StudioShell />
    </StudioProvider>
  );
}
