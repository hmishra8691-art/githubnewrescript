"use client";
import React from "react";
import { useStudio } from "../store";
import { runtimeBaseUrl } from "@/lib/runtime-url";
import type { WorkspaceView } from "./qualApi";
import type { SynthesisApi, GroupListItem, GroupLive } from "./synthesisApi";

/**
 * TEXT GROUP SESSIONS (2026-10-22) — a Remesh-style live conversation: the moderator (a person, or the session
 * itself in autonomous mode) asks the guide's prompts; participants join by link in the respondent app, answer,
 * and rate a sample of others' answers; the answers are clustered (AI, or by words without a model) and the votes
 * read by code (consensus / polarising); the AI proposes follow-ups the moderator approves (or, autonomous, asks
 * within the guide's limit). Closing makes the session a qualitative source. Text only — no audio or video.
 */
type Run = <T>(label: string, fn: () => Promise<T>, done?: (v: T) => void) => Promise<T | undefined>;
const READING: Record<string, string> = { consensus: "Consensus", rejected: "Broadly rejected", polarising: "Polarising", mixed: "Mixed", too_few_votes: "Too few votes" };

export function GroupsTab({ ws, api, run, setWs }: { ws: WorkspaceView; api: SynthesisApi; run: Run; setWs: (w: WorkspaceView) => void }) {
  const s = useStudio();
  const [list, setList] = React.useState<GroupListItem[]>([]);
  const [open, setOpen] = React.useState<string | null>(null);
  const [live, setLive] = React.useState<GroupLive | null>(null);
  const [form, setForm] = React.useState({ title: "", mode: "moderated" as "moderated" | "autonomous", prompts: "" });
  const [ask, setAsk] = React.useState("");
  const guidePrompts = (s.def.qualStudy?.sections ?? []).flatMap((x) => x.questions.map((q) => q.text));
  const reload = React.useCallback(() => run("Loading group sessions", () => api.groups(), setList), [api, run]);
  React.useEffect(() => { void reload(); }, [reload]);
  /* the console polls every two seconds; in autonomous mode it also clusters and asks the AI for follow-ups as answers arrive */
  const lastAi = React.useRef<string>("");
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    const tick = async () => {
      try {
        const g = await api.group(open);
        if (!alive) return;
        setLive(g);
        if (g.state.mode === "autonomous" && g.state.status === "live" && g.current && ws.can.manage) {
          const key = `${g.current.id}:${g.state.phase}`;
          if (g.state.phase === "voting" && lastAi.current !== key && g.current.answered >= g.state.settings.minAnswersToCluster) {
            lastAi.current = key;
            await api.groupAi(g.id, "cluster").catch(() => null);
            if (g.state.settings.autoFollowups && g.state.prompts[g.state.current]?.source === "guide") await api.groupAi(g.id, "followup").catch(() => null);
          }
        }
      } catch { /* the next poll tries again */ }
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => { alive = false; clearInterval(t); };
  }, [open, api, ws.can.manage]);
  const op = (o: Record<string, unknown>) => live && run("Updating the session", () => api.groupOp(live, o).then(() => api.group(live.id)), setLive);
  const link = live ? `${runtimeBaseUrl()}/g/${live.joinCode}` : "";
  const cur = live?.state.current != null && live.state.current >= 0 ? live.state.prompts[live.state.current] : null;
  const results = cur && live ? live.results[cur.id] : null;
  const clusters = cur && live ? live.state.clusters[cur.id] : undefined;
  const handleOf = (answerId: string) => live?.answers.find((a) => a.id === answerId);
  return (
    <div data-testid="qual-groups">
      <p className="ql-muted">Text-only live group conversations: participants join by link and type their answers; there is no audio or video conferencing.</p>
      {ws.can.manage && (
        <div className="card ql-section" data-testid="gs-form">
          <div className="eyebrow">New group session</div>
          <div className="ql-row">
            <input className="input small" placeholder="Title" value={form.title} data-testid="gs-title" onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <label><input type="radio" checked={form.mode === "moderated"} onChange={() => setForm({ ...form, mode: "moderated" })} /> Moderated (you advance it)</label>
            <label><input type="radio" checked={form.mode === "autonomous"} data-testid="gs-autonomous" onChange={() => setForm({ ...form, mode: "autonomous" })} /> Autonomous (timed, within the guide)</label>
          </div>
          <textarea className="ta" rows={3} placeholder={guidePrompts.length ? `Prompts — one per line (empty: the guide's ${guidePrompts.length} questions)` : "Prompts — one per line"} value={form.prompts} data-testid="gs-prompts" onChange={(e) => setForm({ ...form, prompts: e.target.value })} />
          <button type="button" className="btn primary small" data-testid="gs-create" disabled={!form.title.trim() || (!form.prompts.trim() && !guidePrompts.length)} onClick={() => run("Creating", () => api.createGroup({ title: form.title, mode: form.mode, ...(form.prompts.trim() ? { prompts: form.prompts.split("\n").map((x) => x.trim()).filter(Boolean) } : {}) }), (id) => { setOpen(id); void reload(); setForm({ title: "", mode: "moderated", prompts: "" }); })}>Create</button>
        </div>
      )}
      <div className="ql-row">{list.map((g) => <button key={g.id} type="button" className={`chip ${open === g.id ? "on" : ""}`} data-testid="gs-item" data-title={g.title} data-id={g.id} onClick={() => setOpen(g.id)}>{g.title} · {g.status}</button>)}</div>
      {live && (
        <div className="card ql-section" data-testid="gs-console" data-status={live.state.status} data-phase={live.state.phase} data-mode={live.state.mode} data-join={live.joinCode}>
          <div className="ql-row">
            <b>{live.state.title}</b><span className="badge neutral">{live.state.status}</span><span className="chip">{live.state.mode}</span><span className="chip" data-testid="gs-phase">{live.state.phase}</span>
            <span className="ql-muted" data-testid="gs-count">{live.participants.length} participants · {live.answers.length} answers · {live.votes} ratings</span>
          </div>
          <p className="ql-muted">Participants join at <a href={link} target="_blank" rel="noreferrer" data-testid="gs-link">{link}</a></p>
          {ws.can.manage && live.state.status !== "closed" && (
            <div className="ql-row">
              {live.state.status === "draft" && <button type="button" className="btn primary small" data-testid="gs-start" onClick={() => op({ op: "start" })}>Start</button>}
              {live.state.phase === "answering" && <button type="button" className="btn small" data-testid="gs-voting" onClick={() => op({ op: "voting" })}>Open rating</button>}
              {live.state.status === "live" && live.state.phase !== "ended" && <button type="button" className="btn small" data-testid="gs-next" onClick={() => op({ op: "next" })}>Next question</button>}
              {live.state.status === "live" && <button type="button" className="btn small" data-testid="gs-cluster" onClick={() => run("Clustering the answers", () => api.groupAi(live.id, "cluster").then(() => api.group(live.id)), setLive)}>Cluster answers</button>}
              {live.state.status === "live" && <button type="button" className="btn small" data-testid="gs-followup" onClick={() => run("Asking the AI for a follow-up", () => api.groupAi(live.id, "followup").then(() => api.group(live.id)), setLive)}>Suggest a follow-up</button>}
              <button type="button" className="btn small" onClick={() => op({ op: "set_mode", mode: live.state.mode === "autonomous" ? "moderated" : "autonomous" })}>Switch to {live.state.mode === "autonomous" ? "moderated" : "autonomous"}</button>
              <button type="button" className="btn small danger" data-testid="gs-close" onClick={() => run("Closing — making it a source", () => api.closeGroup(live.id), (r) => { if (r.ws) setWs(r.ws); void api.group(live.id).then(setLive); void reload(); })}>Close and make a transcript</button>
            </div>
          )}
          {ws.can.manage && live.state.status === "live" && <div className="ql-row"><input className="input small" style={{ minWidth: 360 }} placeholder="Ask the group your own question" value={ask} data-testid="gs-ask" onChange={(e) => setAsk(e.target.value)} /><button type="button" className="btn small" data-testid="gs-ask-go" disabled={!ask.trim()} onClick={() => { void op({ op: "ask", text: ask }); setAsk(""); }}>Ask now</button></div>}
          {cur && (
            <div className="ql-section" data-testid="gs-current" data-prompt={cur.id}>
              <div className="eyebrow">Now: {cur.source === "guide" ? "guide question" : cur.source === "moderator" ? "your question" : "AI follow-up (approved)"} </div>
              <p><b>{cur.text}</b></p>
              <ul className="ql-list">{live.answers.filter((a) => a.promptId === cur.id).map((a) => { const t = results?.byAnswer[a.id]; return <li key={a.id} data-testid="gs-answer" data-reading={t?.reading ?? ""}><b>{a.handle}</b>: {a.text} {t && <span className="ql-muted">· {t.agree} agree, {t.disagree} disagree{t.pass ? `, ${t.pass} pass` : ""} — {READING[t.reading]}</span>}</li>; })}</ul>
              {clusters && (
                <div data-testid="gs-clusters" data-origin={clusters.origin}>
                  <div className="eyebrow">{clusters.origin === "ai" ? "Clusters (AI-made — check them)" : "Grouped by shared words (no model)"}</div>
                  {clusters.clusters.map((c) => { const t = results?.byCluster[c.id]; return <div key={c.id} className="ql-row" data-testid="gs-cluster-row" data-size={c.answerIds.length}><b>{c.label}</b><span className="chip">{c.answerIds.length} answers</span>{t && <span className="ql-muted">{READING[t.reading]}{t.agreeShare != null ? ` (${t.agreeShare}% agree of ${t.agree + t.disagree})` : ""}</span>}{c.summary && <span className="ql-muted">— {c.summary.text} [{c.summary.answerIds.map((id) => handleOf(id)?.handle ?? "?").join(", ")}]</span>}</div>; })}
                  {clusters.unclustered.length > 0 && <p className="ql-muted">{clusters.unclustered.length} answer(s) in no cluster.</p>}
                </div>
              )}
              {results && <p className="ql-muted" title={results.note}>{results.consensus.length} answer(s) reached consensus, {results.polarising.length} polarising. {results.note}</p>}
            </div>
          )}
          {live.state.followups.filter((f) => f.status === "proposed").map((f) => (
            <div key={f.id} className="ql-excerpt" data-testid="gs-followup-card" data-problems={f.problems.length}>
              <div className="eyebrow">AI-proposed follow-up</div>
              <p>{f.text}</p>
              {f.problems.length > 0 && <p className="alert warning">Held back: {f.problems.join(", ")}.</p>}
              {ws.can.manage && <div className="ql-row">
                <button type="button" className="btn small primary" data-testid="gs-approve" disabled={f.problems.length > 0} onClick={() => op({ op: "approve_followup", id: f.id, askNow: true })}>Approve and ask</button>
                <button type="button" className="btn small" data-testid="gs-queue" disabled={f.problems.length > 0} onClick={() => op({ op: "approve_followup", id: f.id })}>Approve (ask next)</button>
                <button type="button" className="btn small" data-testid="gs-reject" onClick={() => op({ op: "reject_followup", id: f.id })}>Reject</button>
              </div>}
            </div>
          ))}
          <details><summary className="ql-muted">Participants ({live.participants.length})</summary>
            {live.participants.map((p) => <div key={p.id} className="ql-row" data-testid="gs-participant" data-handle={p.handle}><b>{p.handle}</b><input className="input small" placeholder="participant group" defaultValue={p.group ?? ""} disabled={!ws.can.manage} data-testid="gs-segment" onBlur={(e) => { if ((e.target.value || null) !== p.group) void run("Saving", () => api.groupSegment(live.id, p.id, e.target.value)); }} /></div>)}
          </details>
          <details><summary className="ql-muted">Prompts ({live.state.prompts.length})</summary><ol className="ql-list">{live.state.prompts.map((p) => <li key={p.id} className={p.id === cur?.id ? "on" : ""}>{p.text} <span className="ql-muted">{p.source}{p.askedAt ? " · asked" : ""}</span></li>)}</ol></details>
        </div>
      )}
    </div>
  );
}
