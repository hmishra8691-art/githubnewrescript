"use client";
import React from "react";
import "./liveSession.css";
import { RecordingUploader } from "@rescript/storage/uploader";
import { LiveSession, type RecordedChunk, type SessionSnapshot, type RemoteTile } from "@rescript/analytics/live";

/**
 * A LIVE HUMAN-MODERATED SESSION — THE PARTICIPANT'S (OR AN EXTERNAL OBSERVER'S) PAGE (2026-10-22, G2).
 *
 *   1  consent: the statement, the recording disclosure, the data use. "I agree" and — when the session is recorded
 *      — "I agree to the recording" are required: no consent, no room. An observer confirms confidentiality.
 *   2  device check (participants): the camera preview, a microphone level meter, the devices to use; joining with
 *      the camera off is allowed (and without devices at all, to listen)
 *   3  the waiting room, then the room: the moderator and the other participants (handles only — P1, P2 …), a
 *      stimulus the moderator shows, the spotlight; your microphone / camera / screen; leave. With consent your own
 *      audio is recorded in this browser while the session is live, in short chunks, each uploaded as it ends.
 *   4  reconnection: a reload rejoins the same place (the member token is kept in this tab); a dropped connection
 *      reconnects by itself.
 */

type Preview = { role: "participant" | "observer"; title: string; kind: string; status: string; scheduledAt: string | null; timeZone: string | null; durationMinutes: number; record: boolean; recordVideo: boolean; consent: { statement: string; recordingDisclosure: string; dataUse: string } | null };
type Joined = { token: string; memberId: string; role: "participant" | "observer"; handle: string; connection: { iceServers: RTCIceServer[]; warning?: string } };
declare global { interface Window { __rescriptLive?: LiveSession } }

async function api(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch("/api/live", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw Object.assign(new Error(String(d.error ?? `HTTP ${r.status}`)), { code: d.code, status: r.status });
  return d;
}

function VideoTile({ stream, label, muted, member, kind, big, self }: { stream: MediaStream | null; label: string; muted?: boolean; member: string; kind: string; big?: boolean; self?: boolean }) {
  const ref = React.useRef<HTMLVideoElement | null>(null);
  React.useEffect(() => { if (ref.current && ref.current.srcObject !== stream) { ref.current.srcObject = stream; void ref.current.play().catch(() => {}); } }, [stream]);
  return <figure className={`lv-tile${big ? " big" : ""}${self ? " self" : ""}`} data-testid={self ? "live-self" : "live-tile"} data-member={member} data-kind={kind}><video ref={ref} autoPlay playsInline muted={muted} /><figcaption>{label}</figcaption></figure>;
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

const fmtWhen = (iso: string | null, tz: string | null) => { if (!iso) return ""; try { return new Intl.DateTimeFormat(undefined, { timeZone: tz || undefined, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso)); } catch { return iso; } };

function uploader(token: string) {
  return async (c: RecordedChunk) => {
    const up = new RecordingUploader({
      endpoints: { begin: "/api/live/media/ticket", parts: "/api/live/media/parts", complete: "/api/live/media/confirm" },
      token, mimeType: c.mimeType, estimatedBytes: c.blob.size, clientToken: `live:${c.track}:${c.seq}`,
      beginExtra: { track: c.track, seq: c.seq, startMs: c.startMs, durationMs: c.durationMs }, completeExtra: { track: c.track, seq: c.seq },
      onState: () => {},
    });
    await up.begin();
    up.push(c.blob);
    const out = await up.finish(Math.round(c.durationMs / 1000));
    if (!out.ok) throw new Error(out.error);
  };
}

export function LiveSessionPage({ invite }: { invite: string }) {
  const key = `rs-live-${invite.slice(0, 24)}`;
  const [step, setStep] = React.useState<"loading" | "error" | "consent" | "device" | "joining" | "room">("loading");
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [agree, setAgree] = React.useState(false);
  const [recAgree, setRecAgree] = React.useState(false);
  const [confidential, setConfidential] = React.useState(false);
  const [local, setLocal] = React.useState<MediaStream | null>(null);
  const [deviceNote, setDeviceNote] = React.useState<string | null>(null);
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = React.useState("");
  const [micId, setMicId] = React.useState("");
  const [camOff, setCamOff] = React.useState(false);
  const [session, setSession] = React.useState<LiveSession | null>(null);
  const [joined, setJoined] = React.useState<Joined | null>(null);
  const level = useMicLevel(step === "device" ? local : null);

  const enterRoom = React.useCallback((j: Joined, stream: MediaStream | null) => {
    const s = new LiveSession({ call: (b) => api({ ...b, token: j.token }), memberId: j.memberId, role: j.role, iceServers: j.connection.iceServers, local: j.role === "participant" ? stream : null, upload: j.role === "participant" ? uploader(j.token) : undefined });
    window.__rescriptLive = s;
    s.start();
    setJoined(j); setSession(s); setStep("room");
  }, []);

  /* a reload in the same tab takes the same place back */
  React.useEffect(() => {
    let alive = true;
    (async () => {
      let saved: { token: string; memberId: string; role: "participant" | "observer"; handle: string } | null = null;
      try { saved = JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch { /* private window */ }
      if (saved?.token) {
        try {
          const r = await api({ action: "ice", token: saved.token });
          let stream: MediaStream | null = null;
          if (saved.role === "participant") stream = await navigator.mediaDevices?.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices?.getUserMedia({ audio: true }).catch(() => null)) ?? null;
          if (!alive) return;
          enterRoom({ ...saved, connection: r.connection as Joined["connection"] }, stream);
          return;
        } catch { try { sessionStorage.removeItem(key); } catch { /* */ } }
      }
      try { const p = await api({ action: "join", invite }); if (!alive) return; setPreview(p as unknown as Preview); setStep("consent"); }
      catch (e) { if (alive) { setError((e as Error).message); setStep("error"); } }
    })();
    return () => { alive = false; };
  }, [invite, key, enterRoom]);

  /* the device check */
  const openDevices = React.useCallback(async (cam: string, mic: string, noCam: boolean) => {
    for (const t of local?.getTracks() ?? []) t.stop();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: mic ? { deviceId: { exact: mic } } : true, video: noCam ? false : cam ? { deviceId: { exact: cam }, width: { ideal: 640 }, height: { ideal: 360 } } : { width: { ideal: 640 }, height: { ideal: 360 } } });
      setLocal(s); setDeviceNote(null);
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch (e) {
      setLocal(null);
      setDeviceNote((e as Error).name === "NotAllowedError" ? "Your browser did not allow the camera or microphone. Allow them in the address bar and try again — or join to listen only." : "No camera or microphone could be opened. You can join to listen only, or try another device.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);
  React.useEffect(() => { if (step === "device") void openDevices(camId, micId, camOff); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [step]);

  const join = async () => {
    setStep("joining"); setError(null);
    try {
      const r = await api({ action: "join", invite, consent: { agree, recording: recAgree, confidentiality: confidential }, device: { camera: !!local?.getVideoTracks().length, microphone: !!local?.getAudioTracks().length }, /* G3: a panel's id on the link (PROLIFIC_PID, RID …) */ params: Object.fromEntries(new URLSearchParams(window.location.search).entries()) }) as unknown as Joined;
      try { sessionStorage.setItem(key, JSON.stringify({ token: r.token, memberId: r.memberId, role: r.role, handle: r.handle })); } catch { /* */ }
      enterRoom(r, preview?.role === "participant" ? local : null);
    } catch (e) { setError((e as Error).message); setStep(preview?.role === "observer" ? "consent" : "device"); }
  };

  if (step === "loading" || step === "joining") return <main className="lv-shell" data-testid="live-page" data-step={step}><div className="lv-card"><p className="lv-muted">{step === "joining" ? "Joining…" : "Loading…"}</p></div></main>;
  if (step === "error") return <main className="lv-shell" data-testid="live-page" data-step="error"><div className="lv-card"><h1>This link does not work</h1><p role="alert" data-testid="live-error">{error}</p></div></main>;
  if (step === "consent" && preview) {
    const p = preview;
    return (
      <main className="lv-shell" data-testid="live-page" data-step="consent" data-role={p.role}>
        <div className="lv-card">
          <h1>{p.title}</h1>
          <p className="lv-muted">{p.role === "observer" ? "You are invited to observe a live research session from the back room." : `A live research ${p.kind === "interview" ? "interview" : "group discussion"} with a moderator`}{p.scheduledAt ? ` · ${fmtWhen(p.scheduledAt, p.timeZone)}` : ""} · about {p.durationMinutes} minutes</p>
          {p.role === "participant" && p.consent ? (
            <>
              <div className="lv-box" data-testid="live-consent-statement">{p.consent.statement || "The research team has not written a consent statement yet, so you cannot join. Please contact them."}</div>
              {p.record && <div className="lv-box" data-testid="live-recording-disclosure"><b>Recording.</b> {p.consent.recordingDisclosure} {p.recordVideo ? "Your camera and microphone are recorded while the session is live." : "Your microphone is recorded while the session is live (not your camera)."}</div>}
              {p.consent.dataUse && <div className="lv-box"><b>How your answers are used.</b> {p.consent.dataUse}</div>}
              <p className="lv-muted">Others in the session see you as a number (P1, P2 …), not by name. Members of the research team may observe. You can leave at any time.</p>
              <label className="lv-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} data-testid="live-consent-agree" /> I have read this and agree to take part.</label>
              {p.record && <label className="lv-check"><input type="checkbox" checked={recAgree} onChange={(e) => setRecAgree(e.target.checked)} data-testid="live-consent-recording" /> I agree to the session being recorded. (You cannot join without it.)</label>}
              <button type="button" className="lv-btn" disabled={!agree || (p.record && !recAgree) || !p.consent.statement} onClick={() => setStep("device")} data-testid="live-consent-continue">Continue</button>
            </>
          ) : (
            <>
              <div className="lv-box">You will watch and listen from the back room. Participants cannot see or hear you, and do not know who is observing. You can chat with the moderator and write notes with the time they refer to.</div>
              <label className="lv-check"><input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} data-testid="live-confidential" /> I will keep what I see and hear confidential, and I will not record it.</label>
              <button type="button" className="lv-btn" disabled={!confidential} onClick={() => void join()} data-testid="live-join">Enter the back room</button>
            </>
          )}
          {error && <p role="alert" className="lv-error" data-testid="live-error">{error}</p>}
        </div>
      </main>
    );
  }
  if (step === "device") {
    const cams = devices.filter((d) => d.kind === "videoinput"), mics = devices.filter((d) => d.kind === "audioinput");
    return (
      <main className="lv-shell" data-testid="live-page" data-step="device">
        <div className="lv-card">
          <h1>Check your camera and microphone</h1>
          <p className="lv-muted">Say something: the bar should move. Then join — the moderator will let you in.</p>
          <div className="lv-tiles"><VideoTile stream={local} label="You" muted member="self" kind="camera" self /></div>
          <div className="lv-meter" data-testid="live-mic-level" data-level={level.toFixed(2)} aria-label="Microphone level"><span style={{ width: `${Math.round(level * 100)}%` }} /></div>
          <div className="lv-row">
            {cams.length > 1 && <select className="lv-select" value={camId} onChange={(e) => { setCamId(e.target.value); void openDevices(e.target.value, micId, camOff); }} aria-label="Camera">{cams.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}</select>}
            {mics.length > 1 && <select className="lv-select" value={micId} onChange={(e) => { setMicId(e.target.value); void openDevices(camId, e.target.value, camOff); }} aria-label="Microphone">{mics.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}</select>}
            <label className="lv-check" style={{ margin: 0 }}><input type="checkbox" checked={camOff} onChange={(e) => { setCamOff(e.target.checked); void openDevices(camId, micId, e.target.checked); }} /> Join with my camera off</label>
          </div>
          {deviceNote && <div className="lv-alert" data-testid="live-device-note">{deviceNote}</div>}
          {preview?.record && !local?.getAudioTracks().length && <p className="lv-muted">Without a microphone nothing of yours is recorded.</p>}
          <div className="lv-row"><button type="button" className="lv-btn" onClick={() => void join()} data-testid="live-join">{local ? "Join" : "Join to listen only"}</button></div>
          {error && <p role="alert" className="lv-error" data-testid="live-error">{error}</p>}
        </div>
      </main>
    );
  }
  if (step === "room" && session && joined) return <Room session={session} joined={joined} />;
  return null;
}

function Room({ session, joined }: { session: LiveSession; joined: Joined }) {
  const snap: SessionSnapshot = React.useSyncExternalStore(session.subscribe, () => session.snapshot, () => session.snapshot);
  const v = snap.view;
  const observer = joined.role === "observer";
  const nameOf = (id: string) => (observer ? v?.members?.find((m) => m.id === id)?.handle : v?.peers.find((p) => p.id === id)?.handle) ?? (id === joined.memberId ? "You" : "…");
  const roleOf = (id: string) => (observer ? v?.members?.find((m) => m.id === id)?.role : v?.peers.find((p) => p.id === id)?.role) ?? "";
  const spotlight = v?.stage.spotlight ?? null;
  const stim = v?.stage.stimulus ?? null;
  const [chat, setChat] = React.useState("");
  const [note, setNote] = React.useState("");
  const chatList = (snap.extra.chat ?? []) as { id: string; author: string; text: string }[];
  const notes = (snap.extra.notes ?? []) as { id: string; author: string; text: string; offsetSeconds: number | null }[];
  const ended = snap.gone || v?.room.status === "ended" || v?.room.status === "cancelled";
  React.useEffect(() => { if (ended) { try { for (const k of Object.keys(sessionStorage)) if (k.startsWith("rs-live-")) sessionStorage.removeItem(k); } catch { /* */ } } }, [ended]);
  /* G3: a panel participant goes back to the panel once the session has ended */
  const [panelExit, setPanelExit] = React.useState<{ url: string | null; code: string | null } | null>(null);
  React.useEffect(() => { if (ended && !observer && !panelExit) void api({ action: "panel", token: joined.token }).then((d) => setPanelExit((d.panel as { url: string | null; code: string | null } | null) ?? { url: null, code: null })).catch(() => {}); }, [ended]); // eslint-disable-line react-hooks/exhaustive-deps

  if (ended) {
    const msg = snap.gone === "removed" ? "The moderator has removed you from the session." : snap.gone === "replaced" ? "You joined from another tab or device, so this one has left the session." : snap.gone === "left" ? "You left the session. Thank you." : v?.message ?? "The session has ended. Thank you for taking part.";
    return <main className="lv-shell" data-testid="live-page" data-step="ended"><div className="lv-card"><h1>{v?.room.title ?? "Session"}</h1><p data-testid="live-message">{msg}</p>{panelExit?.code && <p data-testid="live-panel-code">Your code: <b>{panelExit.code}</b></p>}{panelExit?.url && <p><a className="lv-btn" href={panelExit.url} rel="noopener noreferrer" data-testid="live-panel-redirect">Continue</a></p>}{snap.recording.pending > 0 && <p className="lv-muted">Saving the last part of the recording… please keep this page open a moment.</p>}</div></main>;
  }
  const waiting = v?.me.state === "waiting";
  return (
    <main className="lv-shell" data-testid="live-page" data-step="room">
      <div className="lv-card lv-wide" data-testid="live-room" data-state={v?.me.state ?? ""} data-status={v?.room.status ?? ""} data-handle={joined.handle} data-role={joined.role} data-member={joined.memberId}>
        <div className="lv-row">
          <h1 style={{ margin: 0 }}>{v?.room.title ?? "…"}</h1>
          <span className="lv-grow" />
          {observer ? <span className="lv-muted">Back room — participants cannot see or hear you</span> : <span className="lv-muted">You are <b data-testid="live-handle">{joined.handle}</b>{v ? ` · ${v.counts.participants} taking part` : ""}</span>}
          {!observer && snap.recording.active && <span className="lv-rec" data-testid="live-rec-indicator" data-uploaded={snap.recording.uploaded}>● Recording</span>}
        </div>
        {snap.error && <div className="lv-alert" data-testid="live-reconnecting">Reconnecting…</div>}
        {joined.connection.warning && !observer && v?.room.status === "live" && !snap.tiles.length && <p className="lv-muted">If nobody appears after a minute, your network may block live video ({joined.connection.warning.replace(/^No TURN relay is configured \(WEBRTC_TURN_URLS\): /, "")}).</p>}
        {v?.message && <div className="lv-alert" data-testid="live-message">{v.message}{waiting && v.counts.waiting ? ` (you are number ${v.counts.waiting} in the queue)` : ""}</div>}
        {!observer && v?.me.mutedByModerator && <div className="lv-alert" data-testid="live-muted-notice">The moderator muted you. Unmute yourself when you want to speak.</div>}
        {stim && <div className="lv-stimulus" data-testid="live-stimulus" data-id={stim.id}><b>{stim.name}</b>{stim.kind === "image" && stim.url ? <img src={stim.url} alt={stim.name} /> : stim.kind === "video" && stim.url ? <video src={stim.url} controls playsInline /> : <p>{stim.text}</p>}</div>}
        <div className="lv-tiles">
          {snap.tiles.map((t: RemoteTile) => <VideoTile key={t.stream.id} stream={t.stream} label={`${nameOf(t.memberId)}${roleOf(t.memberId) === "moderator" ? " (moderator)" : ""}${t.kind === "screen" ? " · screen" : ""}`} member={t.memberId} kind={t.kind} big={spotlight === t.memberId && t.kind === "camera"} />)}
          {!observer && session.localStream && <VideoTile stream={session.localStream} label={`You${snap.audio ? "" : " · muted"}${snap.video ? "" : " · camera off"}`} muted member={joined.memberId} kind="camera" self />}
          {!snap.tiles.length && !waiting && <p className="lv-muted" data-testid="live-empty">{observer ? "Waiting for the moderator's video…" : "Connecting to the others…"}</p>}
        </div>
        {!observer && (
          <div className="lv-row">
            <button type="button" className="lv-btn ghost" aria-pressed={snap.audio} disabled={!session.localStream?.getAudioTracks().length} onClick={() => void session.setAudio(!snap.audio)} data-testid="live-mic">{snap.audio ? "Mute" : "Unmute"}</button>
            <button type="button" className="lv-btn ghost" aria-pressed={snap.video} disabled={!session.localStream?.getVideoTracks().length} onClick={() => void session.setVideo(!snap.video)} data-testid="live-cam">{snap.video ? "Camera off" : "Camera on"}</button>
            {!waiting && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && <button type="button" className="lv-btn ghost" onClick={async () => { if (session.screenStream) await session.shareScreen(null); else { try { await session.shareScreen(await navigator.mediaDevices.getDisplayMedia({ video: true })); } catch { /* cancelled */ } } }} data-testid="live-share">{snap.screen ? "Stop sharing" : "Share screen"}</button>}
            <span className="lv-grow" />
            <button type="button" className="lv-btn danger" onClick={() => { if (confirm("Leave the session?")) void session.leave(); }} data-testid="live-leave">Leave</button>
          </div>
        )}
        {observer && (
          <div className="lv-row" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <b>Chat with the moderator</b>
              <div className="lv-chat">{chatList.map((c) => <p key={c.id} data-testid="live-chat-msg"><b>{c.author}:</b> {c.text}</p>)}</div>
              <div className="lv-row"><input className="lv-input" value={chat} onChange={(e) => setChat(e.target.value)} data-testid="live-chat-input" placeholder="Message to the moderator" /><button type="button" className="lv-btn" disabled={!chat.trim()} onClick={() => void session.chat(chat).then(() => setChat(""))} data-testid="live-chat-send">Send</button></div>
            </div>
            <div style={{ flex: 1, minWidth: 260 }}>
              <b>Your notes (timestamped)</b>
              <div className="lv-chat">{notes.map((n) => <p key={n.id} data-testid="live-note-item">{n.offsetSeconds != null ? `${Math.floor(n.offsetSeconds / 60)}:${String(n.offsetSeconds % 60).padStart(2, "0")}` : "—"} {n.author}: {n.text}</p>)}</div>
              <div className="lv-row"><input className="lv-input" value={note} onChange={(e) => setNote(e.target.value)} data-testid="live-note-input" placeholder="A note at this moment" /><button type="button" className="lv-btn" disabled={!note.trim()} onClick={() => void session.note(note).then(() => setNote(""))} data-testid="live-note-send">Note</button></div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
