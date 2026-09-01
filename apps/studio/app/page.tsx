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
  const [deleting, setDeleting] = React.useState<SurveyRow | null>(null);
  const [confirmText, setConfirmText] = React.useState("");
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const ENV_HINT =
      "Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in THIS Vercel project's environment variables, then redeploy.";
    setError(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch("/api/surveys", { signal: ctrl.signal });
      const raw = await r.text();
      let d: { surveys?: SurveyRow[]; error?: string } = {};
      try {
        d = raw ? JSON.parse(raw) : {};
      } catch {
        setError(`Server returned ${r.status} (not JSON). ${ENV_HINT}`);
        return;
      }
      if (!r.ok) {
        setError(`${d.error ?? `Server returned ${r.status}`}. ${ENV_HINT}`);
        return;
      }
      setSurveys(d.surveys ?? []);
    } catch (e) {
      setError(
        (e as Error)?.name === "AbortError"
          ? `Timed out after 15s — the server could not reach Supabase. ${ENV_HINT}`
          : `Could not reach the API. ${ENV_HINT}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

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
            <span className="grow" />
            <button className="btn small danger" title="Delete this survey project"
              onClick={(e) => { e.stopPropagation(); setDeleting(s); setConfirmText(""); }}>
              delete
            </button>
          </div>
          <div className="card-sub">{s.code} · updated {new Date(s.updated_at).toLocaleString()}</div>
        </div>
      ))}

      {deleting && (
        <div className="modal-back" onClick={() => setDeleting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete “{deleting.title}”?</h2>
            <p className="muted" style={{ fontSize: 13 }}>
              This permanently deletes the survey project, <strong>all its versions, deployments,
              test sessions and collected responses</strong>. Live links stop working immediately.
              This cannot be undone — export the data first if you need it.
            </p>
            <label className="f"><span>Type the survey code <strong>{deleting.code}</strong> to confirm</span>
              <input className="input mono" autoFocus value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)} /></label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setDeleting(null)}>Cancel</button>
              <button className="btn danger" disabled={confirmText !== deleting.code || deleteBusy}
                style={confirmText === deleting.code ? { borderColor: "var(--red)" } : undefined}
                onClick={async () => {
                  setDeleteBusy(true);
                  try {
                    const r = await fetch(`/api/surveys/${deleting.id}`, { method: "DELETE" });
                    const d = await r.json().catch(() => ({}));
                    if (!r.ok) setError(d.error ?? "delete failed");
                    setDeleting(null);
                    await load();
                  } finally {
                    setDeleteBusy(false);
                  }
                }}>
                {deleteBusy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

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
