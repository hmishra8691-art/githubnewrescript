"use client";
import React from "react";
import type { AskItem, AskOp, AskProposal, DatasetSpec, UndoRecord } from "@rescript/analytics";
import { AxApi, type Row } from "./api";
import { ReportBuilderDialog } from "./ReportBuilderDialog";

/**
 * ASK — Intelligent Mode for analytics.
 *
 * You say what you want in words; the server answers with a PROPOSAL: concrete
 * items, each with the reason it was proposed, what it would do, and anything
 * that blocks it. Nothing has happened yet — an item says "Proposed" until you
 * apply it, and then "Done" / "Blocked" / "Failed" with the server's reason
 * (every item is validated again against the live data when applied). Charts can
 * be swapped for another that suits the result; reports go through the report
 * builder's review. The last batch can be undone. History lives in this browser
 * (and every applied change is in the project's audit log).
 */
type Status = "proposed" | "done" | "blocked" | "failed";
interface Shown { item: AskItem; status: Status; message?: string; checked: boolean }
interface HistoryEntry { at: string; request: string; done: number; blocked: number; items: { title: string; status: Status }[] }

const EXAMPLES = ["Create cross-tabs of satisfaction by age and gender", "Remove redundant analyses", "Choose the best chart for each question", "Prepare a management summary", "Make an animated report of the key findings"];
const FOCUS_EXAMPLES = ["Cross-tab this by gender", "Test whether this differs by region", "Use a horizontal bar for this"];
const histKey = (id: string) => `ax-ask-history:${id}`;
const loadHistory = (id: string): HistoryEntry[] => { try { const r = JSON.parse(localStorage.getItem(histKey(id)) ?? "[]"); return Array.isArray(r) ? r.slice(0, 20) : []; } catch { return []; } };
const saveHistory = (id: string, h: HistoryEntry[]) => { try { localStorage.setItem(histKey(id), JSON.stringify(h.slice(0, 20))); } catch { /* history is a convenience */ } };
const BADGE: Record<Status, { text: string; color: string }> = { proposed: { text: "Proposed — not applied", color: "#2563eb" }, done: { text: "Done", color: "#15803d" }, blocked: { text: "Blocked", color: "#b45309" }, failed: { text: "Failed", color: "#b91c1c" } };

export function AskPanel({ api, dataset, analyses, canEdit, onChanged, focus = null, embedded = false }: { api: AxApi; dataset: DatasetSpec; analyses: Row[]; canEdit: boolean; onChanged: () => Promise<void> | void;
  /** the analysis open in Explore: "this" in a request means it (Phase 5) */ focus?: { analysisId: string; name: string } | null; /** shown in the side panel, which has its own heading */ embedded?: boolean }) {
  const [request, setRequest] = React.useState("");
  const [proposal, setProposal] = React.useState<AskProposal & { model?: { status: string; detail: string } } | null>(null);
  const [shown, setShown] = React.useState<Shown[]>([]);
  const [busy, setBusy] = React.useState<null | "propose" | "apply" | "undo">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [undo, setUndo] = React.useState<UndoRecord[]>([]);
  const [history, setHistory] = React.useState<HistoryEntry[]>([]);
  const [builder, setBuilder] = React.useState<Extract<AskOp, { op: "build_report" }> | null>(null);
  const [asked, setAsked] = React.useState("");
  React.useEffect(() => { setHistory(loadHistory(api.surveyId)); }, [api.surveyId]);

  const propose = async (text = request) => {
    if (!text.trim() || busy) return;
    setBusy("propose"); setError(null); setMsg(null); setUndo([]);
    try {
      const p = await api.askPropose({ request: text, dataset, ...(focus ? { focus: { analysisId: focus.analysisId } } : {}) });
      setProposal(p); setAsked(text);
      setShown(p.items.map((item) => ({ item, status: "proposed", checked: !item.blocked.length && item.op.op !== "build_report" })));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const apply = async () => {
    const picked = shown.map((s, i) => ({ s, i })).filter(({ s }) => s.checked && s.status === "proposed" && !s.item.blocked.length && s.item.op.op !== "build_report");
    if (!picked.length || busy) return;
    setBusy("apply"); setError(null); setMsg(null);
    try {
      const r = await api.askApply({ request: asked, dataset, ops: picked.map(({ s }) => s.item.op) });
      const next = shown.slice();
      const records: UndoRecord[] = [];
      for (const a of r.applied) {
        const at = picked[a.index]?.i; if (at == null) continue;
        next[at] = { ...next[at], status: a.status, message: a.message, checked: false };
        if (a.status === "done" && a.undo) records.push(a.undo);
      }
      setShown(next); setUndo(records);
      const done = r.applied.filter((a) => a.status === "done").length, blocked = r.applied.length - done;
      setMsg(`${done} applied${blocked ? `, ${blocked} not applied (see the reason on each item)` : ""}.`);
      const entry: HistoryEntry = { at: new Date().toISOString(), request: asked, done, blocked, items: r.applied.map((a) => ({ title: a.name, status: a.status })) };
      const h = [entry, ...history].slice(0, 20); setHistory(h); saveHistory(api.surveyId, h);
      if (done) await onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const doUndo = async () => {
    if (!undo.length || busy) return;
    setBusy("undo"); setError(null);
    try {
      const r = await api.askUndo(undo);
      const ok = r.undone.filter((u) => u.status === "undone").length;
      setMsg(`${ok} change${ok === 1 ? "" : "s"} undone${ok < r.undone.length ? `; ${r.undone.length - ok} left as they are (${r.undone.filter((u) => u.status === "skipped").map((u) => u.message).join(" ")})` : ""}.`);
      setUndo([]); setShown((s) => s.map((x) => (x.status === "done" ? { ...x, status: "proposed", message: "Undone.", checked: true } : x)));
      await onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const swapChart = (i: number, chart: string) => setShown((all) => all.map((s, k) => (k === i && s.item.op.op === "set_chart" ? { ...s, item: { ...s.item, op: { ...s.item.op, chart: chart as never }, title: s.item.title.replace(/ as [a-z0-9 ]+(?= \(now|$)/, ` as ${chart.replace(/_/g, " ")}`) , options: [...(s.item.options ?? []).filter((o) => o.chart !== chart), ...(s.item.op.op === "set_chart" ? [{ chart: s.item.op.chart, reason: "the first proposal" }] : [])] } } : s)));

  const selected = shown.filter((s) => s.checked && s.status === "proposed" && !s.item.blocked.length && s.item.op.op !== "build_report").length;
  return (
    <div className="ax-panel" data-testid="ax-ask">
      {!embedded && <h3 style={{ marginTop: 0 }}>Ask</h3>}
      <div className="ax-ask-focus muted" data-testid="ax-ask-focus" data-open={focus ? "1" : "0"} style={{ fontSize: 13, marginBottom: 6 }}>{focus ? <>Looking at <b>{focus.name}</b> — say “this” to mean it.</> : <>No analysis is open. Open one in Explore to say “this”, or name the question.</>}</div>
      <p className="muted" style={{ marginTop: 0 }}>Say what you want done with the analyses. You get a proposal to review first — nothing changes until you apply it, and no number is ever written for you: every statistic comes from your data.</p>
      <textarea className="input" rows={2} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="e.g. Create cross-tabs of satisfaction by age and gender" disabled={!canEdit} data-testid="ax-ask-input"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void propose(); }} />
      <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: "wrap" }}>
        {(focus ? FOCUS_EXAMPLES : EXAMPLES).map((x) => <button key={x} type="button" className="ax-chip" onClick={() => setRequest(x)} disabled={!canEdit}>{x}</button>)}
        <span className="grow" />
        <button className="btn primary" onClick={() => void propose()} disabled={!canEdit || !request.trim() || busy !== null} data-testid="ax-ask-propose">{busy === "propose" ? "Reading your request…" : "Propose"}</button>
      </div>
      {!canEdit && <div className="ax-warn" style={{ marginTop: 8 }}>You can read analyses here but not change them.</div>}
      {error && <div className="ax-error" style={{ marginTop: 8 }} data-testid="ax-ask-error">{error}</div>}

      {proposal && <div style={{ marginTop: 14 }} data-testid="ax-ask-review">
        {proposal.model && proposal.model.status !== "not_asked" && <div className="muted" style={{ fontSize: 13, marginBottom: 6 }} data-testid="ax-ask-model" data-status={proposal.model.status}>{proposal.model.detail}</div>}
        {proposal.notes.map((n, i) => <div key={i} className="ax-warn" style={{ marginBottom: 6 }} data-testid="ax-ask-note">{n}</div>)}
        {proposal.unread.map((u, i) => <div key={i} className="ax-warn" style={{ marginBottom: 6 }} data-testid="ax-ask-unread">Not understood: {u}</div>)}
        {!shown.length && !proposal.unread.length && !proposal.notes.length && <div className="muted">Nothing to propose for that request.</div>}
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {shown.map((s, i) => {
            const b = BADGE[s.status]; const op = s.item.op;
            return (
              <li key={s.item.id} className="card" style={{ padding: "8px 10px", marginBottom: 6, opacity: s.item.blocked.length && s.status === "proposed" ? 0.85 : 1 }} data-testid="ax-ask-item" data-status={s.status} data-op={op.op}>
                <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                  {op.op !== "build_report" && <input type="checkbox" checked={s.checked} disabled={s.status !== "proposed" || s.item.blocked.length > 0} onChange={(e) => setShown((all) => all.map((x, k) => (k === i ? { ...x, checked: e.target.checked } : x)))} data-testid="ax-ask-check" aria-label={`Apply: ${s.item.title}`} />}
                  <b style={{ flex: 1 }}>{s.item.title}</b>
                  <span style={{ fontSize: 12, color: b.color, whiteSpace: "nowrap" }} data-testid="ax-ask-status">{b.text}</span>
                </div>
                <div className="muted" style={{ fontSize: 12.5, marginLeft: 24 }}>{s.item.why}</div>
                {s.item.blocked.map((t, k) => <div key={k} style={{ fontSize: 12.5, marginLeft: 24, color: "#b91c1c" }} data-testid="ax-ask-blocked">Cannot be applied: {t}</div>)}
                {s.item.warnings.map((t, k) => <div key={k} style={{ fontSize: 12.5, marginLeft: 24, color: "#b45309" }}>{t}</div>)}
                {s.message && <div style={{ fontSize: 12.5, marginLeft: 24, color: b.color }} data-testid="ax-ask-result">{s.message}</div>}
                {op.op === "set_chart" && s.status === "proposed" && !!s.item.options?.length && !s.item.blocked.length && (
                  <label className="ax-toggle" style={{ marginLeft: 24, fontSize: 12.5 }}>Or use <select className="select small" value="" onChange={(e) => e.target.value && swapChart(i, e.target.value)} data-testid="ax-ask-alt"><option value="">another chart that suits it…</option>{s.item.options!.map((o) => <option key={o.chart} value={o.chart}>{o.chart.replace(/_/g, " ")} — {o.reason}</option>)}</select></label>)}
                {op.op === "build_report" && !s.item.blocked.length && <div style={{ marginLeft: 24, marginTop: 4 }}><button className="btn" onClick={() => setBuilder(op)} data-testid="ax-ask-builder">Review in the report builder</button> <span className="muted" style={{ fontSize: 12.5 }}>— you see what it includes and leaves out before anything is created.</span></div>}
              </li>);
          })}
        </ul>
        {shown.length > 0 && <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <button className="btn" onClick={() => void propose(asked)} disabled={busy !== null} data-testid="ax-ask-regenerate">Propose again</button>
          <span className="grow" />
          {undo.length > 0 && <button className="btn" onClick={() => void doUndo()} disabled={busy !== null} data-testid="ax-ask-undo">{busy === "undo" ? "Undoing…" : `Undo these ${undo.length}`}</button>}
          <button className="btn primary" onClick={() => void apply()} disabled={busy !== null || selected === 0} data-testid="ax-ask-apply">{busy === "apply" ? "Applying…" : `Apply ${selected} selected`}</button>
        </div>}
        {msg && <div className="muted" style={{ marginTop: 8 }} data-testid="ax-ask-msg">{msg}</div>}
      </div>}

      {history.length > 0 && <details style={{ marginTop: 16 }} data-testid="ax-ask-history"><summary className="muted">Earlier requests on this device ({history.length})</summary>
        <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>{history.map((h, i) => <li key={i} style={{ fontSize: 13 }} data-testid="ax-ask-history-item"><button type="button" className="ax-chip" onClick={() => setRequest(h.request)}>{h.request}</button> <span className="muted">— {new Date(h.at).toLocaleString()} · {h.done} applied{h.blocked ? `, ${h.blocked} not applied` : ""}</span></li>)}</ul>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Kept in this browser only. Every applied change is also in the project's audit log, with the request text.</div></details>}

      {builder && <ReportBuilderDialog api={api} analyses={analyses} initial={{ objective: builder.brief.objective, audience: builder.brief.audience, tone: builder.brief.tone, title: builder.brief.title, story: builder.story }} onClose={() => setBuilder(null)} onCreated={() => { setBuilder(null); setMsg("Report created — find it under Reports."); void onChanged(); }} />}
    </div>
  );
}
