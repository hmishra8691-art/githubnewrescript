"use client";
import React from "react";
import "./aiInterview.css";
import { RecordingUploader } from "@rescript/storage/uploader";
import { readNdjson } from "@/lib/aiInterview/ndjson";

/**
 * THE PARTICIPANT'S SIDE OF AN AI-MODERATED INTERVIEW (2026-10-22).
 *
 *   consent      the guide's consent statement, recording disclosure and data use; "I agree" is required;
 *                recording is a separate, optional choice (required only when the study says so)
 *   screener     the study's qualifying questions (which answers qualify is decided on the server)
 *   interview    a chat with the AI moderator. TEXT: type, Enter sends. VOICE: tap to speak, tap to stop →
 *                the speech is transcribed in ≤ 55-second pieces and shown for correction → Send; the
 *                moderator's reply streams as text and is spoken (the study's voice, else the browser's).
 *                VOICE + CAMERA: the same, with each answer's camera recording stored privately (consented).
 *   resilience   the resume token is kept in this browser: a reload carries on; a dropped reply is re-asked
 *                with the same position and the server replays it (never answered twice); silence gets a
 *                nudge; Stop ends politely at any time.
 *   access       a live log region (aria-live), labelled controls, keyboard only works, phone layout.
 *
 * Test seam (fake provider only, honoured by the server): `window.__aiInterviewScript = [reply | "fail", …]`
 * — each request takes the next as the stand-in model's reply.
 */

type Mode = "text" | "voice" | "video";
interface Stimulus { name: string; kind: "image" | "video" | "text"; url?: string; text?: string; alt?: string }
interface Turn { seq: number; speaker: "moderator" | "participant"; text: string; stimuli?: Stimulus[] }
interface Info { title: string; persona: string; modes: Mode[]; languages: string[]; targetMinutes: number; consent: { statement: string; recordingDisclosure?: string; dataUse?: string }; recordingConsent: "optional" | "required"; screener: { id: string; text: string; kind: "single" | "multi" | "number"; options: string[] }[]; incentive?: string; silenceSeconds: number }
interface Interview { participant: string; mode: Mode; language: string; status: string; done: boolean; turns: Turn[]; redirect: string | null; lastSeq: number; silenceSeconds: number; recording: boolean; note?: string }

const LANG_NAMES: Record<string, string> = { en: "English", hi: "हिन्दी (Hindi)", mr: "मराठी (Marathi)", bn: "বাংলা (Bengali)", ta: "தமிழ் (Tamil)", te: "తెలుగు (Telugu)", kn: "ಕನ್ನಡ (Kannada)", ml: "മലയാളം (Malayalam)", gu: "ગુજરાતી (Gujarati)", pa: "ਪੰਜਾਬੀ (Punjabi)", ur: "اردو (Urdu)", es: "Español", fr: "Français", de: "Deutsch", pt: "Português", it: "Italiano", ar: "العربية", zh: "中文", ja: "日本語", ko: "한국어" };
const MODE_WORDS: Record<Mode, string> = { text: "Type my answers", voice: "Speak my answers", video: "Speak, with my camera on" };
const storeKey = (token: string) => `rescript.aiInterview.${token}`;
const safeGet = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const safeSet = (k: string, v: string | null) => { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch { /* private window */ } };
const takeScript = (): unknown => { const w = window as unknown as { __aiInterviewScript?: unknown[] }; return Array.isArray(w.__aiInterviewScript) && w.__aiInterviewScript.length ? w.__aiInterviewScript.shift() : undefined; };
const pickMime = (video: boolean) => { const MR = (window as unknown as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder; const list = video ? ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"] : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]; return list.find((t) => MR?.isTypeSupported?.(t)) ?? ""; };

async function call(url: string, body: unknown, onText?: (t: string, replace?: boolean) => void): Promise<{ status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: onText ? "application/x-ndjson, application/json" : "application/json" }, body: JSON.stringify(body) });
    const r = await readNdjson(res, (e) => { if (e.type === "text" && onText) onText(String(e.delta ?? ""), !!e.replace); });
    return { status: r.status, body: (r.body as Record<string, unknown> | null) ?? null };
  } catch { return { status: 0, body: null }; }
}

export function AiInterview({ token, test, pid }: { token: string; test: string | null; pid: string | null }) {
  const [phase, setPhase] = React.useState<"loading" | "closed" | "consent" | "starting" | "chat" | "screened" | "error">("loading");
  const [info, setInfo] = React.useState<Info | null>(null);
  const [isTest, setIsTest] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<{ agreed: boolean; recording: boolean; mode: Mode; language: string; screener: Record<string, string | string[]> }>({ agreed: false, recording: false, mode: "text", language: "", screener: {} });
  const [iv, setIv] = React.useState<Interview | null>(null);
  const [sessionToken, setSessionToken] = React.useState<string | null>(null);
  const [live, setLive] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [original, setOriginal] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [muted, setMuted] = React.useState(false);
  const [rec, setRec] = React.useState<"idle" | "recording" | "transcribing">("idle");
  const [mediaIds, setMediaIds] = React.useState<{ audio?: string; video?: string }>({});
  const [voiceNote, setVoiceNote] = React.useState<string | null>(null);
  const typing = React.useRef<{ start: number | null; pasted: boolean }>({ start: null, pasted: false });
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const lastActivity = React.useRef(Date.now());
  const spokenSeq = React.useRef(0);

  /* load: a stored resume token carries on; otherwise the study's consent screen */
  React.useEffect(() => {
    let gone = false;
    (async () => {
      const saved = safeGet(storeKey(token));
      if (saved) {
        const r = await fetch(`/api/ai-interview/session?token=${encodeURIComponent(saved)}`).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })).catch(() => ({ status: 0, body: null }));
        if (!gone && r.status === 200 && r.body?.interview) { setInfo(r.body.info); setIv(r.body.interview); setSessionToken(saved); setPhase("chat"); return; }
        if (r.status === 404 || r.status === 400) safeSet(storeKey(token), null);
      }
      const q = new URLSearchParams({ token, ...(test ? { test } : {}) });
      const r = await fetch(`/api/ai-interview/study?${q}`).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })).catch(() => ({ status: 0, body: null }));
      if (gone) return;
      if (r.status !== 200 || !r.body?.view) { setMessage(r.body?.error ?? "This interview link could not be opened. Please check the address."); setPhase("error"); return; }
      const v = r.body.view as Info;
      setInfo(v); setIsTest(!!r.body.test);
      if (!r.body.open) { setMessage(r.body.closedReason ?? "This study is not open."); setPhase("closed"); return; }
      const browser = (navigator.language || "en").toLowerCase().split("-")[0];
      setForm((f) => ({ ...f, mode: v.modes[0], language: v.languages.length ? (v.languages.includes(browser) ? browser : v.languages[0]) : browser }));
      setPhase("consent");
    })();
    return () => { gone = true; };
  }, [token, test]);

  /* keep the newest turn in view, and speak new moderator turns in voice modes */
  React.useEffect(() => { logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight }); }, [iv?.turns.length, live]);
  const speak = React.useCallback(async (t: Turn, mode: Mode, language: string) => {
    if (muted || mode === "text" || !sessionToken || t.seq <= spokenSeq.current) return;
    spokenSeq.current = t.seq;
    try {
      const r = await fetch("/api/ai-interview/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken, seq: t.seq }) });
      if (r.status === 200) { const url = URL.createObjectURL(await r.blob()); const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); await a.play().catch(() => {}); return; }
    } catch { /* the browser's voice below */ }
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (synth && typeof window.SpeechSynthesisUtterance === "function") { const u = new SpeechSynthesisUtterance(t.text); u.lang = language; synth.cancel(); synth.speak(u); }
  }, [muted, sessionToken]);
  React.useEffect(() => {
    if (!iv || iv.mode === "text") return;
    const last = [...iv.turns].reverse().find((t) => t.speaker === "moderator");
    if (last) void speak(last, iv.mode, iv.language);
  }, [iv, speak]);

  /* silence: a nudge after the study's seconds with no typing, speaking or sending */
  React.useEffect(() => {
    if (phase !== "chat" || !iv || iv.done) return;
    const t = setInterval(() => {
      if (busy || rec !== "idle" || draft.trim()) return;
      if (Date.now() - lastActivity.current > (iv.silenceSeconds || 120) * 1000) { lastActivity.current = Date.now(); void send({ kind: "silence" }); }
    }, 1000);
    return () => clearInterval(t);
  });

  const start = async () => {
    if (!info) return;
    setError(null); setPhase("starting"); setLive("");
    const r = await call("/api/ai-interview/begin", { token, ...(test ? { test } : {}), consent: { agreed: form.agreed, recording: form.recording }, screener: form.screener, mode: form.mode, language: form.language, pid, script: takeScript() }, (t, replace) => setLive((cur) => (replace ? t : (cur ?? "") + t)));
    setLive(null);
    const b = r.body;
    if (r.status !== 200 || !b) { setError(String(b?.error ?? "The interview could not start — please try again.")); setPhase("consent"); return; }
    if (b.kind === "screened_out" || b.kind === "full") { setMessage(String(b.message)); setPhase("screened"); return; }
    safeSet(storeKey(token), String(b.sessionToken));
    setSessionToken(String(b.sessionToken)); setIv(b.interview as Interview); setPhase("chat");
    lastActivity.current = Date.now();
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const send = async (input: { kind: "answer" | "silence" | "stop"; text?: string }) => {
    if (!iv || !sessionToken || busy) return;
    setBusy(true); setError(null);
    const text = input.text?.trim() ?? "";
    const pending: Turn[] = input.kind === "answer" ? [{ seq: iv.lastSeq + 1, speaker: "participant", text }] : [];
    setIv({ ...iv, turns: [...iv.turns, ...pending] });
    setLive("");
    const meta = input.kind === "answer" ? { typingMs: typing.current.start ? Date.now() - typing.current.start : undefined, pasted: typing.current.pasted, spoken: iv.mode !== "text" && original !== null } : undefined;
    const body = { sessionToken, afterSeq: iv.lastSeq, input: { ...input, ...(meta ? { meta } : {}) }, ...(original !== null && input.kind === "answer" ? { original } : {}), ...(mediaIds.audio ? { audioMediaId: mediaIds.audio } : {}), ...(mediaIds.video ? { videoMediaId: mediaIds.video } : {}), script: takeScript() };
    let r = await call("/api/ai-interview/turn", body, (t, replace) => setLive((cur) => (replace ? t : (cur ?? "") + t)));
    /* a dropped connection: ask again from the same position — the server replays what it already answered */
    if (r.status === 0) r = await call("/api/ai-interview/turn", { ...body, script: undefined }, (t, replace) => setLive((cur) => (replace ? t : (cur ?? "") + t)));
    setLive(null); setBusy(false);
    if (r.status !== 200 || !r.body?.interview) {
      setIv(iv);
      setError(String(r.body?.error ?? "Your answer could not be sent — check your connection and try again."));
      return;
    }
    setIv(r.body.interview as Interview);
    if (input.kind === "answer") { setDraft(""); setOriginal(null); setMediaIds({}); typing.current = { start: null, pasted: false }; }
    lastActivity.current = Date.now();
    if ((r.body.interview as Interview).done) safeSet(storeKey(token), null);
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  /* ---------------------------------------------------------------- voice */
  const recRef = React.useRef<{ stream: MediaStream; stt: MediaRecorder | null; store: MediaRecorder | null; chunks: Blob[]; started: number; pieceStarted: number; storeChunks: Blob[]; timer: ReturnType<typeof setInterval> | null } | null>(null);
  const beginPiece = (r: NonNullable<typeof recRef.current>) => {
    const mime = pickMime(false);
    const audioOnly = new MediaStream(r.stream.getAudioTracks());
    const m = new MediaRecorder(audioOnly, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 64_000 });
    const parts: Blob[] = [];
    m.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    m.onstop = () => { if (parts.length) r.chunks.push(new Blob(parts, { type: m.mimeType || "audio/webm" })); };
    m.start();
    r.stt = m; r.pieceStarted = Date.now();
  };
  const startRecording = async () => {
    if (!iv) return;
    setError(null); setVoiceNote(null);
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: iv.mode === "video" ? { width: 640, height: 360 } : false }); }
    catch { setVoiceNote("The microphone could not be opened — you can type your answer instead."); return; }
    const r = { stream, stt: null as MediaRecorder | null, store: null as MediaRecorder | null, chunks: [] as Blob[], started: Date.now(), pieceStarted: Date.now(), storeChunks: [] as Blob[], timer: null as ReturnType<typeof setInterval> | null };
    recRef.current = r;
    beginPiece(r);
    /* standalone pieces of at most 55 s: each one is a file the speech-to-text service can read on its own */
    r.timer = setInterval(() => { if (r.stt && Date.now() - r.pieceStarted > 55_000) { r.stt.stop(); beginPiece(r); } }, 1000);
    if (iv.recording) {
      const video = iv.mode === "video";
      const mime = pickMime(video);
      const s = new MediaRecorder(video ? stream : new MediaStream(stream.getAudioTracks()), { ...(mime ? { mimeType: mime } : {}), ...(video ? { videoBitsPerSecond: 900_000 } : { audioBitsPerSecond: 64_000 }) });
      s.ondataavailable = (e) => { if (e.data.size) r.storeChunks.push(e.data); };
      s.start(5000);
      r.store = s;
    }
    const v = document.getElementById("ai-camera") as HTMLVideoElement | null;
    if (v && iv.mode === "video") { v.srcObject = stream; void v.play().catch(() => {}); }
    setRec("recording"); lastActivity.current = Date.now();
  };
  const stopRecording = async () => {
    const r = recRef.current;
    if (!r || !iv || !sessionToken) return;
    if (r.timer) clearInterval(r.timer);
    const stopped = (m: MediaRecorder | null) => new Promise<void>((res) => { if (!m || m.state === "inactive") return res(); m.addEventListener("stop", () => setTimeout(res, 0), { once: true }); m.stop(); });
    await Promise.all([stopped(r.stt), stopped(r.store)]);
    r.stream.getTracks().forEach((t) => t.stop());
    recRef.current = null;
    setRec("transcribing");
    const durationMs = Date.now() - r.started;
    const texts: string[] = [];
    for (const blob of r.chunks) {
      const res = await fetch("/api/ai-interview/transcribe", { method: "POST", headers: { "content-type": blob.type || "audio/webm", "x-session-token": sessionToken, "x-duration-ms": String(Math.min(durationMs, 60_000)) }, body: blob }).catch(() => null);
      const j = res ? await res.json().catch(() => null) : null;
      if (res?.status === 200 && j?.text) texts.push(String(j.text));
      else if (res && [501, 502, 402].includes(res.status)) { setVoiceNote(String(j?.error ?? "Voice is not available — please type your answer.")); break; }
    }
    const said = texts.join(" ").trim();
    setDraft(said); setOriginal(said || null);
    if (!said && !voiceNote) setVoiceNote("I couldn't hear anything — try again, or type your answer.");
    /* the consented recording, stored privately in the background; the turn names it when it is ready */
    if (iv.recording && r.storeChunks.length) {
      const kind = iv.mode === "video" ? "video" : "audio";
      const blob = new Blob(r.storeChunks, { type: r.storeChunks[0].type });
      const up = new RecordingUploader({ endpoints: { begin: "/api/ai-interview/media/ticket", parts: "/api/ai-interview/media/parts", complete: "/api/ai-interview/media/confirm" }, mimeType: blob.type || (kind === "video" ? "video/webm" : "audio/webm"), estimatedBytes: blob.size, beginExtra: { sessionToken, kind, durationSeconds: Math.round(durationMs / 1000) }, completeExtra: { sessionToken }, onState: () => {} });
      void (async () => { try { await up.begin(); up.push(blob); const done = await up.finish(Math.round(durationMs / 1000)); if (done.ok) setMediaIds((m) => ({ ...m, [kind]: done.mediaId })); } catch { /* the words are the answer; a lost recording is not */ } })();
    }
    setRec("idle"); lastActivity.current = Date.now();
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  /* ---------------------------------------------------------------- render */
  if (phase === "loading") return <Shell><div className="ai-card" aria-busy="true"><p className="ai-muted">Loading…</p></div></Shell>;
  if (phase === "error" || phase === "closed" || phase === "screened") return <Shell><div className="ai-card" data-testid={`ai-${phase}`}><h1 className="ai-h1">{info?.title ?? "Interview"}</h1><p>{message}</p></div></Shell>;

  if (phase === "consent" || phase === "starting") {
    if (!info) return null;
    const voice = form.mode !== "text";
    const ready = form.agreed && (!voice || info.recordingConsent !== "required" || form.recording) && (form.mode !== "video" || form.recording) && info.screener.every((q) => { const v = form.screener[q.id]; return Array.isArray(v) ? v.length > 0 : !!v && String(v).trim() !== ""; });
    return (
      <Shell>
        <form className="ai-card" data-testid="ai-consent" onSubmit={(e) => { e.preventDefault(); if (ready) void start(); }}>
          {isTest && <p className="ai-test" data-testid="ai-test-badge">Test interview — it does not count towards the study.</p>}
          <h1 className="ai-h1">{info.title}</h1>
          <p className="ai-muted">A conversation with {info.persona}, an AI interviewer — about {info.targetMinutes} minutes.{info.incentive ? ` ${info.incentive}` : ""}</p>
          <section aria-labelledby="ai-consent-h"><h2 id="ai-consent-h" className="ai-h2">Before we start</h2>
            <p data-testid="ai-consent-statement">{info.consent.statement}</p>
            {info.consent.recordingDisclosure && <p className="ai-muted">{info.consent.recordingDisclosure}</p>}
            {info.consent.dataUse && <p className="ai-muted">{info.consent.dataUse}</p>}
            <p className="ai-muted">You are talking to an AI, not a person. Please don't share contact details or other personal information. You can stop at any time.</p>
            <label className="ai-check"><input type="checkbox" data-testid="ai-agree" checked={form.agreed} onChange={(e) => setForm({ ...form, agreed: e.target.checked })} /> I have read this and agree to take part</label>
          </section>
          {info.modes.length > 1 && (
            <fieldset className="ai-fieldset"><legend className="ai-h2">How would you like to answer?</legend>
              {info.modes.map((m) => <label key={m} className="ai-check"><input type="radio" name="ai-mode" value={m} data-testid={`ai-mode-${m}`} checked={form.mode === m} onChange={() => setForm({ ...form, mode: m })} /> {MODE_WORDS[m]}</label>)}
            </fieldset>
          )}
          {voice && (
            <div className="ai-fieldset">
              <p className="ai-muted">Your voice is turned into text by a speech-to-text service so you can check it before sending.{form.mode === "video" ? " Each answer is recorded with your camera." : ""}</p>
              <label className="ai-check"><input type="checkbox" data-testid="ai-recording" checked={form.recording} onChange={(e) => setForm({ ...form, recording: e.target.checked })} /> {form.mode === "video" ? "I agree to my camera and voice being recorded for the research team" : `I agree to my voice being recorded for the research team${info.recordingConsent === "required" ? "" : " (optional)"}`}</label>
            </div>
          )}
          {info.languages.length !== 1 && (
            <label className="ai-field"><span>Language</span>
              {info.languages.length ? <select className="ai-input" data-testid="ai-language" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>{info.languages.map((l) => <option key={l} value={l}>{LANG_NAMES[l] ?? l}</option>)}</select>
                : <input className="ai-input" data-testid="ai-language" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} aria-describedby="ai-lang-help" />}
              {!info.languages.length && <small id="ai-lang-help" className="ai-muted">A language code such as en, hi or es — the interviewer will speak it.</small>}
            </label>
          )}
          {info.screener.length > 0 && <section aria-labelledby="ai-screener-h" data-testid="ai-screener"><h2 id="ai-screener-h" className="ai-h2">A few questions first</h2>
            {info.screener.map((q) => (
              <fieldset key={q.id} className="ai-fieldset" data-testid="ai-screener-question"><legend>{q.text}</legend>
                {q.kind === "number" ? <input className="ai-input" type="number" inputMode="numeric" value={String(form.screener[q.id] ?? "")} onChange={(e) => setForm({ ...form, screener: { ...form.screener, [q.id]: e.target.value } })} />
                  : q.options.map((o) => {
                    const cur = form.screener[q.id];
                    const on = Array.isArray(cur) ? cur.includes(o) : cur === o;
                    return <label key={o} className="ai-check"><input type={q.kind === "multi" ? "checkbox" : "radio"} name={`ai-${q.id}`} checked={on} onChange={(e) => setForm({ ...form, screener: { ...form.screener, [q.id]: q.kind === "multi" ? (e.target.checked ? [...(Array.isArray(cur) ? cur : []), o] : (Array.isArray(cur) ? cur : []).filter((x) => x !== o)) : o } })} /> {o}</label>;
                  })}
              </fieldset>
            ))}
          </section>}
          {error && <p className="ai-error" role="alert" data-testid="ai-error">{error}</p>}
          {live !== null && <p className="ai-muted" aria-live="polite">{live || "Starting…"}</p>}
          <button type="submit" className="ai-btn primary" data-testid="ai-start" disabled={!ready || phase === "starting"}>{phase === "starting" ? "Starting…" : "Start the interview"}</button>
        </form>
      </Shell>
    );
  }

  if (!iv || !info) return null;
  const voice = iv.mode !== "text";
  return (
    <Shell>
      <div className="ai-chat" data-testid="ai-chat" data-mode={iv.mode} data-status={iv.status} data-done={iv.done ? "1" : "0"}>
        <header className="ai-head">
          <div><b>{info.title}</b><div className="ai-muted">{info.persona} · AI interviewer{isTest ? " · test" : ""}</div></div>
          <span className="ai-grow" />
          {voice && <button type="button" className="ai-btn small" aria-pressed={muted} onClick={() => setMuted(!muted)} data-testid="ai-mute">{muted ? "Unmute" : "Mute"}</button>}
          {!iv.done && <button type="button" className="ai-btn small" data-testid="ai-stop" onClick={() => { if (window.confirm("Stop the interview here? What you've said so far is kept.")) void send({ kind: "stop" }); }} disabled={busy}>Stop</button>}
        </header>
        <div className="ai-log" role="log" aria-live="polite" aria-relevant="additions" ref={logRef} data-testid="ai-log">
          {iv.turns.map((t) => (
            <div key={t.seq} className={`ai-turn ${t.speaker}`} data-testid={`ai-turn-${t.speaker}`} data-seq={t.seq}>
              <span className="ai-sr">{t.speaker === "moderator" ? `${info.persona}: ` : "You: "}</span>
              <p>{t.text}</p>
              {t.stimuli?.map((s, i) => <StimulusView key={i} s={s} />)}
            </div>
          ))}
          {live !== null && <div className="ai-turn moderator pending" data-testid="ai-live"><p>{live || "…"}</p></div>}
          {iv.note && <div className="ai-turn moderator" data-testid="ai-note"><p>{iv.note}</p></div>}
        </div>
        {iv.done ? (
          <div className="ai-done" data-testid="ai-done">
            <p><b>Thank you — the interview is complete.</b></p>
            {iv.redirect && <p><a className="ai-btn primary" href={iv.redirect} rel="noopener noreferrer" data-testid="ai-redirect">Continue</a></p>}
          </div>
        ) : (
          <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void send({ kind: "answer", text: draft }); }}>
            {iv.mode === "video" && <video id="ai-camera" className="ai-camera" muted playsInline aria-label="Your camera" hidden={rec !== "recording"} />}
            {voice && (
              <div className="ai-voice">
                {rec === "recording"
                  ? <button type="button" className="ai-btn danger" data-testid="ai-rec-stop" onClick={() => void stopRecording()}>■ Stop and check</button>
                  : <button type="button" className="ai-btn" data-testid="ai-rec-start" onClick={() => void startRecording()} disabled={busy || rec === "transcribing"}>{rec === "transcribing" ? "Turning your answer into text…" : "🎤 Speak your answer"}</button>}
                {voiceNote && <span className="ai-muted" role="status" data-testid="ai-voice-note">{voiceNote}</span>}
              </div>
            )}
            <label className="ai-sr" htmlFor="ai-input">{voice ? "Your answer (check and correct the transcript)" : "Your answer"}</label>
            <textarea id="ai-input" ref={inputRef} className="ai-input" data-testid="ai-input" rows={voice ? 3 : 2} value={draft} placeholder={voice ? "Your words appear here to check before you send — or type" : "Type your answer…"}
              onChange={(e) => { if (!typing.current.start) typing.current.start = Date.now(); setDraft(e.target.value); lastActivity.current = Date.now(); }}
              onPaste={() => { typing.current.pasted = true; }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (draft.trim()) void send({ kind: "answer", text: draft }); } }} disabled={busy} maxLength={8000} />
            <div className="ai-row">
              {error && <span className="ai-error" role="alert" data-testid="ai-error">{error}</span>}
              <span className="ai-grow" />
              <button type="submit" className="ai-btn primary" data-testid="ai-send" disabled={busy || !draft.trim() || rec !== "idle"}>{busy ? "…" : "Send"}</button>
            </div>
          </form>
        )}
      </div>
    </Shell>
  );
}

function StimulusView({ s }: { s: Stimulus }) {
  if (s.kind === "image" && s.url) return <figure className="ai-stim" data-testid="ai-stimulus"><img src={s.url} alt={s.alt ?? s.name} referrerPolicy="no-referrer" /><figcaption>{s.name}</figcaption></figure>;
  if (s.kind === "video" && s.url) return <figure className="ai-stim" data-testid="ai-stimulus"><video src={s.url} controls playsInline preload="metadata" aria-label={s.name} /><figcaption>{s.name}</figcaption></figure>;
  return <blockquote className="ai-stim text" data-testid="ai-stimulus"><b>{s.name}</b>{s.text && s.text !== s.name ? <p>{s.text}</p> : null}</blockquote>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="ai-shell">{children}</main>;
}
