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

type Tab =
  | "questions" | "flow" | "logic" | "variables" | "calculations"
  | "quotas" | "designs" | "branding" | "scripts" | "versions" | "json";

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
  { key: "versions", label: "Versions & Deploy", icon: "⎌" },
  { key: "json", label: "JSON", icon: "≡" },
];

function bumpVersion(v: string): string {
  const m = v.match(/^(\d+)\.(\d+)$/);
  if (!m) return v + ".1";
  return `${m[1]}.${Number(m[2]) + 1}`;
}

function StudioShell() {
  const s = useStudio();
  const [tab, setTab] = React.useState<Tab>("questions");
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
      const version = bumpVersion(s.def.meta.version);
      const def = structuredClone(s.def);
      def.meta.version = version;
      const r = await fetch(`/api/surveys/${s.surveyDbId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: def, version, label }),
      });
      const d = await r.json();
      if (!r.ok) {
        s.toast(d.error ?? "save failed", "err");
        return null;
      }
      s.replace({ ...def });
      s.markSaved(d.id);
      s.toast(`Saved version ${d.version} (${d.variables} variables)`);
      return d.id as string;
    } finally {
      setSaving(false);
    }
  };

  const preview = () => {
    const base = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:3001";
    const win = window.open(`${base}/preview`, "rescript_preview");
    if (!win) return;
    const send = () => win.postMessage({ type: "rescript:preview", definition: s.def }, "*");
    const onReady = (e: MessageEvent) => {
      if (e.data?.type === "rescript:preview-ready") { send(); }
    };
    window.addEventListener("message", onReady);
    // also push a few times in case ready was missed
    let n = 0;
    const t = setInterval(() => { send(); if (++n > 10) { clearInterval(t); window.removeEventListener("message", onReady); } }, 500);
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
        <a className="btn" href={`/api/surveys/${s.surveyDbId}/responses?format=csv`} target="_blank">⬇ Responses .csv</a>
        <button className="btn primary" disabled={saving} onClick={() => save()}>
          {saving ? "Saving…" : `Save v${bumpVersion(s.def.meta.version)}`}
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
