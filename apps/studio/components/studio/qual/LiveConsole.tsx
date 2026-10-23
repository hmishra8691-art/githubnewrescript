"use client";
import React from "react";
import { LiveSession, type SessionSnapshot, type LiveView, type MemberSummary, type RemoteTile } from "@rescript/analytics/live";
import type { LiveApi, JoinResult, LiveDetail } from "./liveApi";

/**
 * THE LIVE-SESSION CONSOLE (2026-10-22, G2) — the moderator's room, or a member observer's back room, in the
 * Studio. The moderator: a camera / microphone check, then the room — the waiting room (admit / do not admit),
 * the people in it (mute, spotlight, remove), the guide's stimuli pushed to everyone, the guide's sections with
 * a timer, the back-room chat with observers and their timestamped notes, the recording's progress, the rolling
 * transcript and the AI assist panel (suggestions for YOU; the AI never speaks to participants). An observer
 * watches the room relayed by the moderator's browser, chats with the moderator and takes notes — participants
 * never see or hear them.
 */

type Snap = SessionSnapshot;
declare global { interface Window { __rescriptLive?: LiveSession } }

function VideoTile({ stream, label, muted, member, kind, big, testid = "live-tile" }: { stream: MediaStream | null; label: string; muted?: boolean; member: string; kind: string; big?: boolean; testid?: string }) {
  const ref = React.useRef<HTMLVideoElement | null>(null);
  React.useEffect(() => { if (ref.current && ref.current.srcObject !== stream) { ref.current.srcObject = stream; void ref.current.play().catch(() => {}); } }, [stream]);
  return (
    <figure className={`lv-tile${big ? " big" : ""}`} data-testid={testid} data-member={member} data-kind={kind}>
      <video ref={ref} autoPlay playsInline muted={muted} />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function useMicLevel(stream: MediaStream | null): number {
  const [level, setLevel] = React.useState(0);
  React.useEffect(() => {
    if (!stream || !stream.getAudioTracks().length || typeof AudioContext === "undefined") return;
    const ctx = new AudioContext();
    /* a context made outside a click starts suspended in some browsers: the page had a click (Continue), so resume */
    void ctx.resume().catch(() => {});
    const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    /* sampled ~15 times a second with a slow decay, so a short sound stays visible on the meter */
    let shown = 0;
    const t = setInterval(() => { an.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128)); shown = Math.max(Math.min(1, peak / 64), shown * 0.85); setLevel(shown < 0.005 ? 0 : shown); }, 66);
    return () => { clearInterval(t); void ctx.close().catch(() => {}); };
  }, [stream]);
  return level;
}

const mmss = (s: number) => `${s < 0 ? "-" : ""}${String(Math.floor(Math.abs(s) / 60)).padStart(2, "0")}:${String(Math.floor(Math.abs(s) % 60)).padStart(2, "0")}`;

export function LiveConsole({ api, detail, role, onLeave, onFinalized }: { api: LiveApi; detail: LiveDetail; role: "moderator" | "observer"; onLeave: () => void; onFinalized: (r: Record<string, unknown>) => void }) {
  const [local, setLocal] = React.useState<MediaStream | null>(null);
  const [deviceError, setDeviceError] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<LiveSession | null>(null);
  const [join, setJoin] = React.useState<JoinResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const level = useMicLevel(local);

  /* the device check: the moderator's camera and microphone (an observer needs none) */
  React.useEffect(() => {
    if (role !== "moderator") return;
    let stream: MediaStream | null = null;
    navigator.mediaDevices?.getUserMedia({ audio: true, video: { width: { ideal: 640 }, height: { ideal: 360 } } })
      .then((s) => { stream = s; setLocal(s); })
      .catch((e) => setDeviceError(`The camera or microphone could not be opened (${(e as Error).name}). You can still run the room, but participants will not see or hear you.`));
    return () => { if (!session) for (const t of stream?.getTracks() ?? []) t.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const enter = async () => {
    setBusy(true); setError(null);
    try {
      const j = await api.join(detail.room.id, role);
      const s = new LiveSession({ call: api.roomCall(j.token), memberId: j.memberId, role, iceServers: j.connection.iceServers, local: role === "moderator" ? local : null, upload: role === "moderator" ? api.uploader(j.token) : undefined });
      window.__rescriptLive = s;
      s.start();
      setJoin(j); setSession(s);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  React.useEffect(() => () => { void session?.stop(); }, [session]);

  if (!session || !join) {
    return (
      <div className="lv-console lv-preview" data-testid="live-console" data-phase="preview" data-role={role}>
        <h3>{role === "moderator" ? "Moderate" : "Observe"}: {detail.room.title}</h3>
        {role === "moderator" ? (
          <>
            <p className="ql-muted">Check your camera and microphone. Participants see you once you admit them from the waiting room.</p>
            <div className="lv-check">
              <VideoTile stream={local} label="You (preview)" muted member="self" kind="camera" testid="live-preview" />
              <div className="lv-meter" data-testid="live-mic-level" data-level={level.toFixed(2)} aria-label="Microphone level"><span style={{ width: `${Math.round(level * 100)}%` }} /></div>
            </div>
            {deviceError && <div className="alert warning">{deviceError}</div>}
          </>
        ) : <p className="ql-muted">You will watch from the back room: participants cannot see or hear you. You can chat with the moderator and take timestamped notes.</p>}
        {detail.transport.turn === "none" && <p className="ql-muted" data-testid="live-turn-warning">{detail.transport.turnWarning}</p>}
        {error && <div className="alert error">{error}</div>}
        <div className="ql-row">
          <button type="button" className="btn primary" disabled={busy || (role === "moderator" && !local && !deviceError)} data-testid="live-enter" onClick={enter}>{role === "moderator" ? "Enter the room" : "Enter the back room"}</button>
          <button type="button" className="btn" onClick={() => { for (const t of local?.getTracks() ?? []) t.stop(); onLeave(); }}>Back</button>
        </div>
      </div>
    );
  }
  return <Room api={api} session={session} join={join} detail={detail} role={role} onLeave={async () => { await session.stop(); window.__rescriptLive = undefined; onLeave(); }} onFinalized={onFinalized} />;
}

function Room({ api, session, join, detail, role, onLeave, onFinalized }: { api: LiveApi; session: LiveSession; join: JoinResult; detail: LiveDetail; role: "moderator" | "observer"; onLeave: () => Promise<void>; onFinalized: (r: Record<string, unknown>) => void }) {
  const snap: Snap = React.useSyncExternalStore(session.subscribe, () => session.snapshot, () => session.snapshot);
  const view = snap.view;
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const [err, setErr] = React.useState<string | null>(null);
  const op = async (o: Record<string, unknown>) => { setErr(null); try { await session.op(o); } catch (e) { setErr((e as Error).message); } };
  const members = view?.members ?? [];
  const nameOf = (id: string) => { const m = members.find((x) => x.id === id); return m ? `${m.handle}${m.label && m.role !== "moderator" ? ` · ${m.label}` : ""}` : id === join.memberId ? "You" : "…"; };
  const mod = role === "moderator";
  const status = view?.room.status ?? "…";
  const serverNow = now + session.client.offset;
  const elapsed = view?.room.startedAt ? (serverNow - Date.parse(view.room.startedAt)) / 1000 : null;
  const sec = view?.stage.section ?? null;
  const secLeft = sec ? sec.minutes * 60 - (serverNow - Date.parse(sec.startedAt)) / 1000 : null;

  /* the moderator's console: transcription of recorded chunks + the rolling transcript, every 8 s */
  const [work, setWork] = React.useState<{ stt: { ready: boolean; reason?: string }; recording: { chunks: number; transcribed: number; stored: number; uploading: number; failed: number }; transcript: { id: string; speaker: string; start: number; text: string }[]; warnings: string[] } | null>(null);
  const callRoom = React.useMemo(() => api.roomCall(join.token), [api, join.token]);
  React.useEffect(() => {
    if (!mod) return;
    let alive = true;
    const tick = async () => { try { const r = await callRoom({ action: "work" }); if (alive) setWork(r as never); } catch { /* next tick */ } };
    void tick();
    const t = setInterval(() => void tick(), 8000);
    return () => { alive = false; clearInterval(t); };
  }, [mod, callRoom]);
  const [assist, setAssist] = React.useState<Record<string, unknown> | null>(null);
  const [assistBusy, setAssistBusy] = React.useState(false);
  const [autoAssist, setAutoAssist] = React.useState(false);
  const runAssist = React.useCallback(async () => {
    setAssistBusy(true);
    try { const r = await callRoom({ action: "assist" }); setAssist(r.assist as Record<string, unknown>); } catch (e) { setAssist({ error: (e as Error).message }); } finally { setAssistBusy(false); }
  }, [callRoom]);
  React.useEffect(() => { if (!autoAssist) return; const t = setInterval(() => void runAssist(), 90_000); return () => clearInterval(t); }, [autoAssist, runAssist]);

  const [chat, setChat] = React.useState("");
  const [note, setNote] = React.useState("");
  const chatList = (snap.extra.chat ?? []) as { id: string; author: string; text: string; at: string }[];
  const notes = (snap.extra.notes ?? []) as { id: string; author: string; text: string; offsetSeconds: number | null }[];
  const [finalizing, setFinalizing] = React.useState<string | null>(null);

  const tiles = snap.tiles;
  const spotlight = view?.stage.spotlight ?? null;
  const stim = view?.stage.stimulus ?? null;
  const waiting = members.filter((m) => m.role === "participant" && m.state === "waiting");
  const inRoom = members.filter((m) => m.state === "admitted");

  if (snap.gone && snap.gone !== "ended") {
    return <div className="lv-console" data-testid="live-console" data-phase="gone"><div className="alert warning">{snap.gone === "replaced" ? "This console was opened somewhere else." : snap.gone === "removed" ? "You were removed from the session." : `The session is ${snap.gone}.`}</div><button type="button" className="btn" onClick={() => void onLeave()}>Back</button></div>;
  }
  return (
    <div className="lv-console" data-testid="live-console" data-phase="in" data-role={role} data-status={status} data-member={join.memberId}>
      <div className="ql-row lv-bar">
        <h3 style={{ margin: 0 }}>{view?.room.title ?? detail.room.title}</h3>
        <span className={`badge ${status === "live" ? "success" : status === "ended" ? "" : "warning"}`} data-testid="live-status">{status}</span>
        {elapsed != null && status === "live" && <span className="chip" data-testid="live-elapsed">{mmss(elapsed)} / {view?.room.durationMinutes} min</span>}
        {view?.room.record && <span className={`chip${snap.recording.active ? " on" : ""}`} data-testid="live-rec" data-active={snap.recording.active ? "1" : "0"} data-uploaded={snap.recording.uploaded}>{snap.recording.active ? "● Recording" : "Recording off"}{mod ? ` · ${snap.recording.uploaded} chunk${snap.recording.uploaded === 1 ? "" : "s"} saved${snap.recording.pending ? `, ${snap.recording.pending} sending` : ""}` : ""}</span>}
        {snap.error && <span className="chip" data-testid="live-reconnecting" title={snap.error}>reconnecting…</span>}
        <span className="grow" />
        {mod && status === "scheduled" && <button type="button" className="btn" data-testid="live-open-room" onClick={() => op({ op: "open" })}>Open the waiting room</button>}
        {mod && (status === "scheduled" || status === "open") && <button type="button" className="btn primary" data-testid="live-start" onClick={() => op({ op: "start" })}>Start the session{view?.room.record ? " (recording)" : ""}</button>}
        {mod && status === "live" && <button type="button" className="btn danger" data-testid="live-end" onClick={() => { if (confirm("End the session for everyone?")) void op({ op: "end" }); }}>End the session</button>}
        {mod && status === "ended" && <button type="button" className="btn primary" data-testid="live-finalize" disabled={!!finalizing} onClick={async () => { setFinalizing("Transcribing…"); try { const r = await api.finalize(detail.room.id, (p) => setFinalizing(`Transcribing… ${(p as { transcribed?: number; chunks?: number })?.transcribed ?? 0} of ${(p as { chunks?: number })?.chunks ?? "?"} chunks`)); setFinalizing(null); onFinalized(r); } catch (e) { setFinalizing(null); setErr((e as Error).message); } }}>{finalizing ?? "Finalize → transcript"}</button>}
        <button type="button" className="btn" data-testid="live-leave" onClick={() => void onLeave()}>Leave</button>
      </div>
      {err && <div className="alert error" data-testid="live-error">{err}</div>}
      {view?.message && role === "observer" && status !== "live" && <p className="ql-muted">{view.message}</p>}

      <div className="lv-main">
        <div className="lv-stage" data-testid="live-stage" data-spotlight={spotlight ?? ""}>
          {stim && (
            <div className="lv-stimulus" data-testid="live-stimulus" data-id={stim.id}>
              <b>{stim.name}</b>
              {stim.kind === "image" && stim.url ? <img src={stim.url} alt={stim.name} /> : stim.kind === "video" && stim.url ? <video src={stim.url} controls playsInline /> : <p>{stim.text}</p>}
            </div>
          )}
          <div className="lv-tiles">
            {mod && <VideoTile stream={session.localStream} label={`You (moderator)${snap.audio ? "" : " · muted"}`} muted member={join.memberId} kind="camera" big={spotlight === join.memberId} />}
            {session.screenStream && <VideoTile stream={session.screenStream} label="Your screen" muted member={join.memberId} kind="screen" />}
            {tiles.map((t: RemoteTile) => <VideoTile key={t.stream.id} stream={t.stream} label={`${nameOf(t.memberId)}${t.kind === "screen" ? " · screen" : ""}`} member={t.memberId} kind={t.kind} big={spotlight === t.memberId && t.kind === "camera"} />)}
            {!tiles.length && <p className="ql-muted" data-testid="live-empty">{mod ? (waiting.length ? `${waiting.length} waiting — admit them from the waiting room.` : "Nobody has joined yet. Participants join from their links.") : "Waiting for the moderator's video…"}</p>}
          </div>
          {mod && (
            <div className="ql-row">
              <button type="button" className="btn" data-testid="live-mic" aria-pressed={snap.audio} onClick={() => void session.setAudio(!snap.audio)}>{snap.audio ? "Mute me" : "Unmute me"}</button>
              <button type="button" className="btn" data-testid="live-cam" aria-pressed={snap.video} onClick={() => void session.setVideo(!snap.video)}>{snap.video ? "Camera off" : "Camera on"}</button>
              <button type="button" className="btn" data-testid="live-share" onClick={async () => { if (session.screenStream) await session.shareScreen(null); else { try { await session.shareScreen(await navigator.mediaDevices.getDisplayMedia({ video: true })); } catch { /* cancelled */ } } }}>{snap.screen ? "Stop sharing" : "Share screen"}</button>
            </div>
          )}
          {mod && work && (
            <div className="lv-transcript" data-testid="live-transcript">
              <div className="eyebrow">Rolling transcript {work.stt.ready ? "" : `— ${work.stt.reason ?? "speech-to-text is not configured"}`}</div>
              {work.transcript.slice(-12).map((s) => <p key={s.id} data-testid="live-transcript-turn" data-speaker={s.speaker}><b>{s.speaker}</b> <span className="ql-muted">{mmss(s.start)}</span> {s.text}</p>)}
              {!work.transcript.length && <p className="ql-muted">Turns appear here as recorded chunks are transcribed ({work.recording.chunks} chunk{work.recording.chunks === 1 ? "" : "s"} so far, {work.recording.transcribed} transcribed).</p>}
            </div>
          )}
        </div>

        <aside className="lv-side">
          {mod && (
            <section className="card lv-panel" data-testid="live-waiting">
              <div className="eyebrow">Waiting room ({waiting.length})</div>
              {waiting.map((m) => (
                <div key={m.id} className="ql-row" data-testid="live-waiting-item" data-handle={m.handle}>
                  <span>{m.handle}{m.label ? ` · ${m.label}` : ""}{m.segment ? ` (${m.segment})` : ""}{m.device && !m.device.camera ? " · no camera" : ""}</span>
                  <button type="button" className="btn sm primary" data-testid="live-admit" onClick={() => op({ op: "admit", member: m.id })}>Admit</button>
                  <button type="button" className="btn sm" data-testid="live-deny" onClick={() => op({ op: "deny", member: m.id })}>Not now</button>
                </div>
              ))}
              {waiting.length > 1 && <button type="button" className="btn sm" data-testid="live-admit-all" onClick={() => op({ op: "admit_all" })}>Admit all</button>}
            </section>
          )}
          <section className="card lv-panel" data-testid="live-people">
            <div className="eyebrow">In the room ({inRoom.filter((m) => m.role === "participant").length} participants{mod ? `, ${inRoom.filter((m) => m.role === "observer").length} observers` : ""})</div>
            {inRoom.map((m: MemberSummary) => (
              <div key={m.id} className="ql-row" data-testid="live-member" data-handle={m.handle} data-role={m.role} data-online={m.online ? "1" : "0"}>
                <span>{m.handle}{m.label && m.role !== "moderator" ? ` · ${m.label}` : ""}{m.segment ? ` (${m.segment})` : ""}{!m.online ? " · reconnecting" : ""}{m.role === "participant" && !m.media.audio ? " · muted" : ""}</span>
                {mod && m.role === "participant" && <>
                  <button type="button" className="btn sm" data-testid="live-mute" disabled={!m.media.audio} onClick={() => op({ op: "mute", member: m.id })}>Mute</button>
                  <button type="button" className="btn sm" data-testid="live-spotlight" onClick={() => op({ op: "spotlight", member: spotlight === m.id ? null : m.id })}>{spotlight === m.id ? "Unspotlight" : "Spotlight"}</button>
                  <button type="button" className="btn sm" data-testid="live-remove" onClick={() => { if (confirm(`Remove ${m.handle} from the session?`)) void op({ op: "remove", member: m.id }); }}>Remove</button>
                </>}
              </div>
            ))}
          </section>
          {mod && (
            <section className="card lv-panel" data-testid="live-stimuli">
              <div className="eyebrow">Stimuli from the guide</div>
              {(view?.stimuli ?? []).map((s) => (
                <div key={s.id} className="ql-row" data-testid="live-stimulus-item" data-id={s.id}>
                  <span>{s.name} <span className="ql-muted">({s.kind})</span></span>
                  <button type="button" className="btn sm" data-testid="live-show" disabled={stim?.id === s.id} onClick={() => op({ op: "stimulus", id: s.id })}>{stim?.id === s.id ? "Showing" : "Show to everyone"}</button>
                </div>
              ))}
              {!(view?.stimuli ?? []).length && <p className="ql-muted">The guide has no stimuli. Share your screen to show something.</p>}
              {stim && <button type="button" className="btn sm" data-testid="live-stimulus-clear" onClick={() => op({ op: "stimulus", id: null })}>Take it down</button>}
            </section>
          )}
          <section className="card lv-panel" data-testid="live-sections">
            <div className="eyebrow">Guide sections {sec && secLeft != null && <span className={`chip${secLeft < 0 ? " on" : ""}`} data-testid="live-section-timer" data-section={sec.id}>{sec.title}: {secLeft >= 0 ? `${mmss(secLeft)} left` : `${mmss(-secLeft)} over`}</span>}</div>
            {(view?.sections ?? []).map((s) => (
              <div key={s.id} className="ql-row" data-testid="live-section" data-id={s.id}>
                <span>{s.title} <span className="ql-muted">{s.minutes} min</span></span>
                {mod && <button type="button" className="btn sm" data-testid="live-section-start" onClick={() => op({ op: "section", id: s.id })}>{sec?.id === s.id ? "Restart timer" : "Start timer"}</button>}
              </div>
            ))}
          </section>
          <section className="card lv-panel" data-testid="live-backroom">
            <div className="eyebrow">Back room — {mod ? "observers" : "the moderator"} (participants never see this)</div>
            <div className="lv-chat">{chatList.map((c) => <p key={c.id} data-testid="live-chat-msg"><b>{c.author}:</b> {c.text}</p>)}</div>
            <div className="ql-row"><input className="input" value={chat} onChange={(e) => setChat(e.target.value)} placeholder="Message" data-testid="live-chat-input" onKeyDown={(e) => { if (e.key === "Enter" && chat.trim()) { void session.chat(chat).then(() => setChat("")); } }} /><button type="button" className="btn sm" data-testid="live-chat-send" disabled={!chat.trim()} onClick={() => void session.chat(chat).then(() => setChat(""))}>Send</button></div>
            <div className="eyebrow">Notes (timestamped)</div>
            {notes.map((n) => <p key={n.id} data-testid="live-note-item" data-offset={n.offsetSeconds ?? ""}><span className="ql-muted">{n.offsetSeconds != null ? mmss(n.offsetSeconds) : "before start"}</span> <b>{n.author}:</b> {n.text}</p>)}
            <div className="ql-row"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note at this moment" data-testid="live-note-input" /><button type="button" className="btn sm" data-testid="live-note-send" disabled={!note.trim()} onClick={() => void session.note(note).then(() => setNote(""))}>Note</button></div>
          </section>
          {mod && view?.room.assist && (
            <section className="card lv-panel" data-testid="live-assist">
              <div className="eyebrow">AI assist — suggestions for you only (the AI never speaks)</div>
              <div className="ql-row">
                <button type="button" className="btn sm" data-testid="live-assist-run" disabled={assistBusy} onClick={() => void runAssist()}>{assistBusy ? "Thinking…" : "Suggest probes"}</button>
                <label className="ql-muted"><input type="checkbox" checked={autoAssist} onChange={(e) => setAutoAssist(e.target.checked)} /> every 90 s (one metered call each)</label>
              </div>
              {assist && <AssistView a={assist} />}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function AssistView({ a }: { a: Record<string, unknown> }) {
  if (a.error) return <div className="alert warning" data-testid="live-assist-error">{String(a.error)}</div>;
  const probes = (a.probes ?? []) as { text: string; basedOn: string[] }[];
  const missed = (a.missedObjectives ?? []) as { number: number; text: string }[];
  const held = (a.heldBack ?? []) as { text: string; problems: string[] }[];
  const progress = a.progress as { questions: { id: string; text: string; asked: boolean }[]; section: { title: string; over: boolean } | null } | undefined;
  return (
    <div data-testid="live-assist-result" data-origin={String(a.origin ?? "")}>
      {progress && <p className="ql-muted" data-testid="live-assist-progress">{progress.questions.filter((q) => q.asked).length} of {progress.questions.length} guide questions asked{progress.section ? ` · ${progress.section.title}${progress.section.over ? " (over time)" : ""}` : ""}</p>}
      {probes.map((p, i) => <p key={i} data-testid="live-assist-probe">→ {p.text} <span className="ql-muted">[{p.basedOn.join(", ")}]</span></p>)}
      {missed.length > 0 && <p data-testid="live-assist-missed">Not covered yet: {missed.map((m) => `O${m.number} ${m.text}`).join("; ")}</p>}
      {a.note ? <p className="ql-muted">{String(a.note)}</p> : null}
      {held.length > 0 && <p className="ql-muted">{held.length} suggestion{held.length === 1 ? "" : "s"} held back by the checks.</p>}
    </div>
  );
}

export type { LiveView };
