"use client";
import React from "react";
import { THEME_PRESETS } from "@/lib/defaults";

interface SurveyRow {
  id: string; code: string; title: string; status: string; updated_at: string;
}

export default function Dashboard() {
  const [surveys, setSurveys] = React.useState<SurveyRow[] | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [code, setCode] = React.useState("");
  const [theme, setTheme] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    fetch("/api/surveys").then((r) => r.json()).then((d) => setSurveys(d.surveys ?? []))
      .catch(() => setError("Could not reach the database. Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY."));
  }, []);
  React.useEffect(load, [load]);

  const create = async () => {
    setError(null);
    const preset = THEME_PRESETS.find((t) => t.name === theme);
    const body: Record<string, unknown> = { title: title || "Untitled survey", code: code || undefined };
    if (preset) {
      body.definition = {
        meta: { id: "tmp", code: code || "SURVEY", title: title || "Untitled survey", version: "1.0" },
        branding: preset.branding,
        flow: [
          { type: "page", id: "page_1", title: "Welcome", questionIds: [] },
          { type: "end", id: "end_complete", status: "complete" },
        ],
      };
    }
    const r = await fetch("/api/surveys", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.id) window.location.href = `/studio/${d.id}`;
    else setError(d.error ?? "create failed");
  };

  return (
    <div className="dash">
      <h1><span className="logo-mark">R</span> Rescript Studio</h1>
      <p className="muted">Professional survey programming &amp; runtime platform — JSON-driven, versioned, extensible.</p>

      <div className="row" style={{ margin: "22px 0" }}>
        <button className="btn primary" onClick={() => setCreating(true)}>+ New survey</button>
        <span className="grow" />
      </div>

      {error && <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{error}</div>}

      {surveys === null && !error && <p className="muted">Loading…</p>}
      {surveys?.length === 0 && <p className="muted">No surveys yet — create your first one.</p>}
      {surveys?.map((s) => (
        <div key={s.id} className="card selectable" onClick={() => (window.location.href = `/studio/${s.id}`)}>
          <div className="card-title">
            {s.title} <span className={`chip ${s.status === "live" ? "on" : ""}`}>{s.status}</span>
          </div>
          <div className="card-sub">{s.code} · updated {new Date(s.updated_at).toLocaleString()}</div>
        </div>
      ))}

      {creating && (
        <div className="modal-back" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New survey</h2>
            <label className="f"><span>Title</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Customer Study 2026" /></label>
            <label className="f"><span>Survey code</span>
              <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="STUDY_001" /></label>
            <label className="f"><span>Template / theme</span>
              <select className="select" value={theme} onChange={(e) => setTheme(e.target.value)}>
                <option value="">Blank</option>
                {THEME_PRESETS.map((t) => <option key={t.name} value={t.name}>{t.name} — {t.description}</option>)}
              </select></label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn primary" onClick={create}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
