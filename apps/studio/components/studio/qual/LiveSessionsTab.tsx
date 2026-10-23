"use client";
import React from "react";
import "./live.css";
import { useStudio } from "../store";
import type { QualApi, WorkspaceView } from "./qualApi";
import { liveApi, formatWhen, zonedInputToIso, type LiveList, type LiveDetail, type LiveInviteView } from "./liveApi";
import { LiveConsole } from "./LiveConsole";

/**
 * LIVE SESSIONS (2026-10-22, G2) — Research Tools → Qualitative → Live sessions: live human-moderated focus groups
 * and in-depth interviews in the browser. Schedule a session (time and time zone, participant slots with unique
 * links, segment, recording, AI assist), invite people (links to copy, or e-mail when it is configured), then run
 * it from the console (Moderate) or watch from the back room (Observe). After it ends, Finalize turns everyone's
 * recorded chunks into one transcript with the moderator and the participants as speakers.
 */
type Run = <T>(label: string, fn: () => Promise<T>, done?: (v: T) => void) => Promise<T | undefined>;
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const ZONES = [...new Set([TZ, "Asia/Kolkata", "UTC", "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Singapore", "Asia/Dubai", "Australia/Sydney"])];

export function LiveSessionsTab({ ws, api, run, setWs, setNote }: { ws: WorkspaceView; api: QualApi; run: Run; setWs: (w: WorkspaceView) => void; setNote: (n: string | null) => void }) {
  const s = useStudio();
  const lapi = React.useMemo(() => liveApi(s.surveyDbId), [s.surveyDbId]);
  const [list, setList] = React.useState<LiveList | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<LiveDetail | null>(null);
  const [consoleRole, setConsoleRole] = React.useState<"moderator" | "observer" | null>(null);
  const tomorrow = React.useMemo(() => { const d = new Date(Date.now() + 86_400_000); d.setMinutes(0, 0, 0); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T18:00`; }, []);
  const [form, setForm] = React.useState({ title: "", kind: (s.def.qualStudy?.kind === "interview" ? "interview" : "focus_group") as "focus_group" | "interview", when: tomorrow, tz: TZ, duration: 90, max: 6, slots: 6, segment: "", record: true, video: false, assist: true, waiting: true });
  const [newLinks, setNewLinks] = React.useState<LiveInviteView[]>([]);

  const reload = React.useCallback(() => run("Loading live sessions", () => lapi.list(), setList), [lapi, run]);
  React.useEffect(() => { void reload(); }, [reload]);
  const loadDetail = React.useCallback(async (id: string) => { const d = await lapi.detail(id); setDetail(d); return d; }, [lapi]);
  React.useEffect(() => { if (open && !consoleRole) void loadDetail(open).catch(() => null); }, [open, consoleRole, loadDetail]);
  /* the session list follows what happens in rooms (joins, no-shows) while this tab is open */
  React.useEffect(() => { if (consoleRole) return; const t = setInterval(() => { void lapi.list().then(setList).catch(() => null); if (open) void loadDetail(open).catch(() => null); }, 5000); return () => clearInterval(t); }, [consoleRole, open, lapi, loadDetail]);

  const guide = s.def.qualStudy ?? null;
  const schedule = () => run("Scheduling", async () => {
    const at = zonedInputToIso(form.when, form.tz);
    const r = await lapi.schedule([{ title: form.title || `${guide?.title ?? s.def.meta.title} — ${form.kind === "focus_group" ? "focus group" : "interview"}`, kind: form.kind, scheduledAt: at, timeZone: form.tz, segment: form.segment || null, slots: form.slots, settings: { maxParticipants: form.max, durationMinutes: form.duration, record: form.record, recordVideo: form.video, assist: form.assist, waitingRoom: form.waiting } }], api.sandbox ? guide : undefined);
    setNewLinks(r.rooms[0]?.invites ?? []);
    setOpen(r.rooms[0]?.id ?? null);
    return lapi.list();
  }, setList);

  const finalized = (r: Record<string, unknown>) => {
    /* the sandbox: the transcript joins the page's workspace (a saved project's routes wrote the rows) */
    if (r.sandbox && api.sandboxHandle) {
      const tr = r.transcript as { title: string; segments: { id: string; index: number; speaker: string; start: number; end: number; text: string }[]; speakers: Record<string, { role: "moderator" | "participant"; group?: string }>; participants: { id: string; label: string; segment?: string }[]; meta: Record<string, unknown> };
      const sess = r.session as Record<string, unknown>;
      const h = api.sandboxHandle;
      const sid = h.addSession({ ...sess, scheduled_at: sess.scheduledAt, title: String(sess.title) });
      h.addTranscript({ ok: true, value: { title: tr.title, source: "stt", format: "stt", segments: tr.segments, speakers: tr.speakers, char_count: tr.segments.reduce((n, x) => n + x.text.length, 0), meta: { ...tr.meta, warnings: (tr.meta.warnings as string[]) ?? [] }, session_id: sid } });
      setWs(h.view());
      setNote(`The live session is now a source: “${tr.title}” (${tr.segments.length} turns, speakers from separate recordings). Code it in the Coding tab.`);
    } else {
      setNote(`Finalized: one transcript of ${r.turns ?? "?"} turns${r.already ? " (already done)" : ""}. It is in Transcripts, and the session record is completed.`);
      void api.load().then(setWs).catch(() => null);
    }
    setConsoleRole(null);
    /* not through run(): it clears the note just set */
    void lapi.list().then(setList).catch(() => null);
  };

  if (consoleRole && detail) return <LiveConsole api={lapi} detail={detail} role={consoleRole} onLeave={() => { setConsoleRole(null); void reload(); }} onFinalized={finalized} />;

  const t = list?.transport;
  const can = list?.can;
  return (
    <div data-testid="live-panel">
      <p className="ql-muted">Live, human-moderated focus groups and in-depth interviews in the browser: you moderate from here, participants join from their own link (consent, then a camera and microphone check), observers watch from a back room participants never see. With consent, each person's audio is recorded in their own browser and transcribed per speaker into one transcript for coding.</p>
      {t && (
        <div className="ql-row" data-testid="live-transport" data-turn={t.turn} data-sfu={t.sfu ? "1" : "0"}>
          <span className="chip">Built-in browser connection: up to {t.mesh.maxParticipants} participants + 3 observers</span>
          <span className={`chip${t.turn === "none" ? "" : " on"}`}>{t.turn === "none" ? "No TURN relay" : `TURN relay (${t.turn === "rest" ? "time-limited credentials" : "static credentials"})`}</span>
          <span className="chip">{t.sfu ? `LiveKit configured${t.sfuClient ? "" : " (browser client not set: LIVEKIT_CLIENT_URL)"}` : "LiveKit not configured"}</span>
          {!list?.mail.configured && <span className="chip">{list?.sandbox ? "Sandbox: no e-mail" : "E-mail not configured: copy the links"}</span>}
        </div>
      )}
      {t?.turnWarning && <p className="ql-muted" data-testid="live-turn-warning">{t.turnWarning} Set WEBRTC_TURN_URLS with WEBRTC_TURN_SECRET (or a username and credential).</p>}

      {can?.manage && (
        <div className="card ql-section" data-testid="live-schedule-form">
          <div className="eyebrow">Schedule a session</div>
          <div className="ql-grid">
            <label>Title<input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={`${guide?.title ?? "Focus group"} 1`} data-testid="live-title" /></label>
            <label>Kind<select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "focus_group" | "interview", max: e.target.value === "interview" ? 1 : form.max, slots: e.target.value === "interview" ? 1 : form.slots })} data-testid="live-kind"><option value="focus_group">Focus group</option><option value="interview">In-depth interview</option></select></label>
            <label>When<input className="input" type="datetime-local" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} data-testid="live-when" /></label>
            <label>Time zone<select className="input" value={form.tz} onChange={(e) => setForm({ ...form, tz: e.target.value })} data-testid="live-tz">{ZONES.map((z) => <option key={z}>{z}</option>)}</select></label>
            <label>Minutes<input className="input" type="number" min={15} max={240} value={form.duration} onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })} data-testid="live-duration" /></label>
            <label>Participants (at most)<input className="input" type="number" min={1} max={t?.sfu ? 30 : 6} value={form.max} onChange={(e) => setForm({ ...form, max: Number(e.target.value) })} data-testid="live-max" /></label>
            <label>Links to create<input className="input" type="number" min={0} max={20} value={form.slots} onChange={(e) => setForm({ ...form, slots: Number(e.target.value) })} data-testid="live-slots" /></label>
            <label>Segment<input className="input" value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })} placeholder="e.g. Mumbai" data-testid="live-segment" /></label>
          </div>
          <div className="ql-row">
            <label><input type="checkbox" checked={form.record} onChange={(e) => setForm({ ...form, record: e.target.checked })} data-testid="live-record" /> Record audio (each person consents; transcribed per speaker)</label>
            <label><input type="checkbox" checked={form.video} disabled={!form.record} onChange={(e) => setForm({ ...form, video: e.target.checked })} data-testid="live-video" /> Also record video</label>
            <label><input type="checkbox" checked={form.assist} onChange={(e) => setForm({ ...form, assist: e.target.checked })} data-testid="live-assist-on" /> AI assist for me</label>
            <label><input type="checkbox" checked={form.waiting} onChange={(e) => setForm({ ...form, waiting: e.target.checked })} /> Waiting room</label>
          </div>
          {!guide && <p className="ql-muted">There is no guide yet: the consent text, stimuli and sections come from the guide (Guide tab, or ask Intelligent Mode for one). Participants cannot join without a consent statement.</p>}
          <button type="button" className="btn primary" data-testid="live-schedule" onClick={() => void schedule()}>Schedule</button>
          <span className="ql-muted"> Or say it in Intelligent Mode: “schedule two focus groups of 6 next Tuesday 6 pm IST with Mumbai and Delhi segments”.</span>
        </div>
      )}

      <div data-testid="live-rooms">
        {(list?.rooms ?? []).map((r) => (
          <div key={r.id} className={`card ql-section lv-room${open === r.id ? " on" : ""}`} data-testid="live-room" data-id={r.id} data-status={r.status} data-title={r.title}>
            <div className="ql-row">
              <b>{r.title}</b>
              <span className="badge">{r.status}</span>
              <span className="ql-muted">{formatWhen(r.scheduledAt, r.timeZone)} · {r.settings.durationMinutes} min{r.segment ? ` · ${r.segment}` : ""}</span>
              <span className="ql-muted">{r.counts.invited} invited · {r.counts.joined} joined · {r.counts.inRoom} in the room{r.counts.waiting ? ` · ${r.counts.waiting} waiting` : ""}{r.counts.noShow ? ` · ${r.counts.noShow} no-show` : ""}</span>
              {r.transcriptId && <span className="chip on" data-testid="live-has-transcript">transcript ready</span>}
              <span className="grow" />
              <button type="button" className="btn sm" data-testid="live-details" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Close" : "Details"}</button>
              {can?.manage && r.status !== "cancelled" && r.status !== "ended" && <button type="button" className="btn sm primary" data-testid="live-moderate" onClick={async () => { await loadDetail(r.id); setOpen(r.id); setConsoleRole("moderator"); }}>Moderate</button>}
              {(r.status === "open" || r.status === "live") && <button type="button" className="btn sm" data-testid="live-observe" onClick={async () => { await loadDetail(r.id); setOpen(r.id); setConsoleRole("observer"); }}>Observe</button>}
              {can?.manage && r.status === "ended" && !r.transcriptId && <button type="button" className="btn sm primary" data-testid="live-finalize-row" onClick={() => run("Finalizing", () => lapi.finalize(r.id), finalized)}>Finalize → transcript</button>}
            </div>
            {r.problems.length > 0 && <div className="alert warning" data-testid="live-problems">{r.problems.join(" ")}</div>}
            {open === r.id && detail?.room.id === r.id && <RoomDetail detail={detail} lapi={lapi} run={run} reload={() => loadDetail(r.id)} fresh={newLinks} />}
          </div>
        ))}
        {list && !list.rooms.length && <p className="ql-muted" data-testid="live-none">No live sessions yet.</p>}
      </div>
    </div>
  );
}

function RoomDetail({ detail, lapi, run, reload, fresh }: { detail: LiveDetail; lapi: ReturnType<typeof liveApi>; run: Run; reload: () => Promise<unknown>; fresh: LiveInviteView[] }) {
  const r = detail.room;
  const [people, setPeople] = React.useState("");
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}); };
  const parts = detail.invites.filter((i) => i.role === "participant");
  const obs = detail.invites.filter((i) => i.role === "observer");
  const row = (i: LiveInviteView) => (
    <tr key={i.id} data-testid="live-invite" data-role={i.role} data-status={i.status}>
      <td>{i.label ?? "—"}{i.email ? ` <${i.email}>` : ""}</td><td>{i.segment ?? ""}</td><td><span className="badge">{i.status.replace("_", "-")}</span></td>
      <td>{i.link ? <><input className="input lv-link" readOnly value={i.link} data-testid="live-invite-link" data-role={i.role} onFocus={(e) => e.currentTarget.select()} /><button type="button" className="btn sm" onClick={() => copy(i.link!)}>Copy</button></> : "—"}</td>
      <td>{detail.can.manage && i.status !== "revoked" && <button type="button" className="btn sm" onClick={() => run("Revoking", () => lapi.revoke(r.id, i.id), () => void reload())}>Revoke</button>}{detail.can.manage && <button type="button" className="btn sm" onClick={() => run("New link", () => lapi.relink(r.id, i.id), () => void reload())}>New link</button>}</td>
    </tr>
  );
  return (
    <div className="lv-detail" data-testid="live-detail">
      {fresh.length > 0 && fresh[0] && detail.invites.some((i) => i.id === fresh[0].id) && <p className="ql-muted">The links below are each person's own — share one per person. They can be shown again here at any time.</p>}
      <table className="table"><thead><tr><th>Participant</th><th>Segment</th><th>Status</th><th>Link</th><th /></tr></thead><tbody>{parts.map(row)}</tbody></table>
      {detail.can.manage && (
        <div className="ql-row">
          <input className="input" style={{ minWidth: 340 }} value={people} onChange={(e) => setPeople(e.target.value)} placeholder="Names / e-mails, one per line or comma (optional)" data-testid="live-invite-people" />
          <button type="button" className="btn sm" data-testid="live-add-participant" onClick={() => run("Adding links", () => lapi.invite(r.id, "participant", people.trim() ? { people: people.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).map((x) => (/@/.test(x) ? { email: x } : { label: x })) } : { count: 1 }), () => { setPeople(""); void reload(); })}>Add participant link{people.trim() ? "s" : ""}</button>
          <button type="button" className="btn sm" data-testid="live-add-observer" onClick={() => run("Adding an observer link", () => lapi.invite(r.id, "observer", { count: 1 }), () => void reload())}>Add observer link (client)</button>
          {detail.mail.configured && <><button type="button" className="btn sm" data-testid="live-send-invites" onClick={() => run("Sending invitations", () => lapi.send(r.id, "invite"), () => void reload())}>E-mail invitations</button><button type="button" className="btn sm" data-testid="live-send-reminders" onClick={() => run("Sending reminders", () => lapi.send(r.id, "reminder"), () => void reload())}>E-mail reminders</button></>}
          {r.status === "scheduled" && <button type="button" className="btn sm" data-testid="live-cancel" onClick={() => { if (confirm("Cancel this session?")) void run("Cancelling", () => lapi.cancel(r.id), () => void reload()); }}>Cancel the session</button>}
        </div>
      )}
      {obs.length > 0 && <><div className="eyebrow">Observer links (the back room)</div><table className="table"><tbody>{obs.map(row)}</tbody></table></>}
      <div className="ql-row ql-muted" data-testid="live-recording-summary">Recording: {detail.recording.chunks} chunk{detail.recording.chunks === 1 ? "" : "s"} · {detail.recording.transcribed} transcribed{detail.recording.failed ? ` · ${detail.recording.failed} failed` : ""}{detail.recording.people.length ? ` (${detail.recording.people.map((p) => `${p.handle} ${p.chunks}`).join(", ")})` : ""}</div>
      {detail.notes.length > 0 && <><div className="eyebrow">Observer notes</div>{detail.notes.map((n) => <p key={n.id} className="ql-muted">{n.offsetSeconds != null ? `${Math.floor(n.offsetSeconds / 60)}:${String(n.offsetSeconds % 60).padStart(2, "0")}` : "—"} {n.author}: {n.text}</p>)}</>}
    </div>
  );
}
