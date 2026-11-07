"use client";
import React from "react";
import { applySurveyActions, type SurveyAction } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";
import type { ClientTask } from "../../lib/copilot/taskStore";
import { LAUNCHERS, launchMessage, type Launcher } from "../../lib/agents/launch";
import { ResearchOutput } from "./ResearchOutput";

/**
 * WHAT A RESEARCHER CAN DO FROM THE AGENT WORKSPACE (ResLens agents, phase 1 — 2026-11-07).
 *
 *   START      pick an agent, say what you want in its own fields; the request goes to the same planner the Copilot
 *              uses (POST /api/copilot/tasks with the planner named), so there is one engine and one set of agents.
 *   CONTROL    Run (this page drives the task one slice at a time while it is open), Pause, Resume, Retry a failed
 *              step, Cancel — the existing task routes, each answering with the persisted state.
 *   REVIEW     a finished questionnaire task's changes are previewed against the survey as it is open now
 *              (applySurveyActions: what applies, what is refused, what the quality check says, what is destructive)
 *              and applied only when the researcher says so — one undoable edit.
 *
 * Every number on screen comes back from the server; nothing here guesses progress.
 */

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; d: Record<string, unknown> | null }> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, d: await r.json().catch(() => null) };
  } catch { return { status: 0, d: null }; }
}

export function AgentLauncher({ surveyId, def, canEdit, onStarted }: { surveyId: string; def: SurveyDefinition; canEdit: boolean; onStarted: (task: ClientTask) => void }) {
  const [open, setOpen] = React.useState<Launcher["id"] | null>(null);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const L = LAUNCHERS.find((l) => l.id === open) ?? null;
  const message = L ? launchMessage(L, fields) : "";
  const missing = L ? L.fields.filter((f) => f.required && !(fields[f.key] ?? "").trim()) : [];

  const start = async () => {
    if (!L || missing.length) return;
    setBusy(true); setMsg(null);
    const r = await post("/api/copilot/tasks", { surveyId, message, definition: def, planner: L.planner, ...(L.options ? { options: L.options(fields) } : {}) });
    setBusy(false);
    if (r.status === 200 && r.d?.task) { onStarted(r.d.task as ClientTask); setOpen(null); setFields({}); return; }
    setMsg(String(r.d?.error ?? (r.status === 404 ? "This agent could not plan that request — say a little more about what you want." : r.status === 403 ? "You need edit access to start an agent on this survey." : `The agent could not start (${r.status || "network"}).`)));
  };

  return (
    <div className="agw-launch" data-testid="agw-launcher">
      <div className="agw-launch-head"><b>Start an agent</b><span className="muted">The agent plans the work in steps you can watch, pause and review. Nothing changes the survey until you apply it.</span></div>
      <div className="agw-launch-grid">
        {LAUNCHERS.map((l) => (
          <button key={l.id} type="button" className={`agw-launch-card a-${l.agent} ${open === l.id ? "on" : ""}`} disabled={!canEdit} onClick={() => { setOpen(open === l.id ? null : l.id); setMsg(null); }} data-testid={`agw-launch-${l.id}`} aria-expanded={open === l.id}>
            <b>{l.title}</b><span>{l.blurb}</span>
          </button>
        ))}
      </div>
      {!canEdit && <div className="muted" style={{ fontSize: 12.5 }}>Starting an agent needs edit access to this survey.</div>}
      {L && (
        <form className="agw-launch-form" onSubmit={(e) => { e.preventDefault(); void start(); }} data-testid="agw-launch-form">
          {L.fields.map((f) => (
            <label key={f.key} className="ax-field">
              <span>{f.label}{f.required ? " *" : ""}</span>
              {f.type === "textarea" ? <textarea className="ta" rows={3} value={fields[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} data-testid={`agw-field-${f.key}`} />
                : f.type === "select" ? <select className="select small" value={fields[f.key] ?? f.options![0][0]} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} data-testid={`agw-field-${f.key}`}>{f.options!.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
                : <input className="input small" value={fields[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} data-testid={`agw-field-${f.key}`} />}
            </label>
          ))}
          <div className="agw-launch-preview"><span className="muted">The agent is asked:</span> {message || "—"}</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary small" type="submit" disabled={busy || missing.length > 0} data-testid="agw-start">{busy ? "Planning…" : "Plan and start"}</button>
            <button className="btn small ghost" type="button" onClick={() => setOpen(null)}>Close</button>
            {msg && <span className="agw-launch-err" role="alert">{msg}</span>}
          </div>
        </form>
      )}
    </div>
  );
}

type Ctl = "advance" | "pause" | "resume" | "retry" | "cancel";

/** the selected task's controls; `driving` is this page running the task slice by slice */
export function TaskControls({ task, surveyId, canEdit, onTask }: { task: ClientTask; surveyId: string; canEdit: boolean; onTask: (t: ClientTask) => void }) {
  const [driving, setDriving] = React.useState(false);
  const [busy, setBusy] = React.useState<Ctl | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const stop = React.useRef(false);
  const failed = task.steps.filter((s) => s.status === "failed" || s.status === "blocked");

  const act = React.useCallback(async (a: Ctl, extra: Record<string, unknown> = {}) => {
    const r = await post(`/api/copilot/tasks/${encodeURIComponent(task.id)}/${a}`, { surveyId, ...extra });
    if (r.d?.task) onTask(r.d.task as ClientTask);
    if (r.status !== 200) setNote(String(r.d?.error ?? `That did not work (${r.status || "network"}).`));
    return r;
  }, [task.id, surveyId, onTask]);

  /* Run: slices until the server says there is nothing left to claim, the task stops, or the person pauses */
  const run = async () => {
    setDriving(true); stop.current = false; setNote(null);
    let idle = 0;
    while (!stop.current) {
      const r = await act("advance");
      const t = r.d?.task as (ClientTask & { drive?: string }) | undefined;
      if (r.status !== 200 || !t || t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "needs_attention") break;
      const built = Number((r.d?.slice as { built?: number } | null)?.built ?? 0);
      idle = built > 0 ? 0 : idle + 1;
      if (t.drive === "stop" || idle > 6) break;
      await new Promise((res) => setTimeout(res, built > 0 ? 200 : Math.min(15000, 1500 * idle)));
    }
    setDriving(false);
  };
  React.useEffect(() => () => { stop.current = true; }, []);

  const open = task.status === "pending" || task.status === "running";
  const btn = (a: Ctl, label: string, show: boolean, onClick: () => void, primary = false) => show ? <button key={a} type="button" className={`btn small ${primary ? "primary" : ""}`} disabled={!canEdit || busy != null} onClick={async () => { setBusy(a); try { await onClick(); } finally { setBusy(null); } }} data-testid={`agw-ctl-${a}`}>{busy === a ? "…" : label}</button> : null;
  return (
    <div className="agw-ctl" data-testid="agw-controls">
      {open && !driving && btn("advance", "Run", true, () => void run(), true)}
      {driving && <button type="button" className="btn small" onClick={() => { stop.current = true; }} data-testid="agw-ctl-stop">Stop running here</button>}
      {btn("pause", "Pause", open, () => { stop.current = true; return act("pause"); })}
      {btn("resume", task.status === "failed" ? "Try again" : "Resume", task.status === "needs_attention" || task.status === "failed", () => act("resume"))}
      {btn("retry", `Retry ${failed.length === 1 ? "failed step" : `${failed.length} failed steps`}`, failed.length > 0 && task.status !== "cancelled" && task.status !== "completed", () => act("retry"))}
      {btn("cancel", "Cancel", task.status !== "completed" && task.status !== "cancelled", () => { stop.current = true; return act("cancel"); })}
      {driving && <span className="agw-ctl-note">Running from this page — leave it open, or let the Copilot or the background runner carry on.</span>}
      {note && <span className="agw-launch-err" role="alert">{note}</span>}
    </div>
  );
}

/** a finished task's survey changes: previewed against the survey as open now, applied on the researcher's word */
export function TaskResultReview({ task, surveyId, def, canEdit, onApply }: { task: ClientTask; surveyId: string; def: SurveyDefinition; canEdit: boolean; onApply: (next: SurveyDefinition, label: string) => void }) {
  const [actions, setActions] = React.useState<SurveyAction[] | null>(null);
  const [data, setData] = React.useState<Record<string, unknown> | null>(null);
  const [applied, setApplied] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    let off = false;
    setActions(null); setApplied(false); setErr(null);
    if (task.status !== "completed") return;
    (async () => {
      try {
        const r = await fetch(`/api/copilot/tasks/${encodeURIComponent(task.id)}?surveyId=${encodeURIComponent(surveyId)}&result=1`, { cache: "no-store" });
        const j = await r.json();
        if (off) return;
        const res = j?.result as { actions?: SurveyAction[]; data?: Record<string, unknown> } | null;
        if (!res) { setErr("The result could not be read."); return; }
        setActions(Array.isArray(res.actions) ? res.actions : []);
        setData(res.data ?? null);
      } catch { if (!off) setErr("The result could not be read."); }
    })();
    return () => { off = true; };
  }, [task.id, task.status, surveyId]);
  const preview = React.useMemo(() => (actions && actions.length ? applySurveyActions(def, actions) : null), [actions, def]);
  if (task.status !== "completed") return null;
  if (err) return <div className="agw-review"><span className="agw-launch-err">{err}</span></div>;
  if (!actions) return <div className="agw-review muted">Reading the result…</div>;
  return (
    <div className="agw-review" data-testid="agw-review">
      {actions.length === 0 ? (data && Object.keys(data).length ? <ResearchOutput data={data} surveyId={surveyId} /> : <div><b>Finished.</b> <span className="muted">This task proposed no change to the questionnaire.</span></div>) : preview && (
        <>
          <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
            <b>{actions.length} change{actions.length === 1 ? "" : "s"} ready to review</b>
            <span className="muted">{preview.results.filter((r) => r.ok).length} apply cleanly to the survey as it is now{preview.errors.length ? ` · ${preview.errors.length} refused` : ""}</span>
          </div>
          {preview.destructive.length > 0 && <div className="agw-warn">Removes or overwrites: {preview.destructive.slice(0, 5).join("; ")}{preview.destructive.length > 5 ? "…" : ""}</div>}
          {preview.errors.length > 0 && <details><summary>Refused ({preview.errors.length})</summary><ul>{preview.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul></details>}
          {preview.warnings.length > 0 && <details><summary>Quality check after applying ({preview.warnings.length})</summary><ul>{preview.warnings.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul></details>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small primary" disabled={!canEdit || applied} onClick={() => { if (preview.destructive.length && !window.confirm(`This removes or overwrites ${preview.destructive.length} thing(s). Apply anyway? You can undo it.`)) return; onApply(preview.def, `Agent task: ${actions.length} changes`); setApplied(true); }} data-testid="agw-apply">{applied ? "Applied — undo with Ctrl+Z" : "Apply to survey"}</button>
            <span className="muted" style={{ fontSize: 12.5 }}>One undoable edit. Review it in Questions before you save a version.</span>
          </div>
        </>
      )}
    </div>
  );
}
