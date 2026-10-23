"use client";
import React from "react";
import "./aiInterview.css";
import { RecordingUploader } from "@rescript/storage/uploader";
import {
  BUILTIN_INTERVIEW_LANGUAGES, formatMessage, isRtlLanguage, nativeLanguageName, parseAcceptLanguage, participantMessages, pickInterviewLanguage, realtimeVerbatimInstructions,
  type LocalizedPublicText, type ParticipantMessages,
} from "@rescript/engine";
import { readNdjson } from "@/lib/aiInterview/ndjson";
import { conversationSupport, DuplexController } from "@/lib/voice/duplex";
import type { DuplexPhase } from "@/lib/voice/bargeIn";
import { RealtimeClient } from "@/lib/voice/realtimeClient";

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
 *                CONVERSATION (G1): hands-free — voice-activity detection, each utterance sent at the end of
 *                the turn, the reply spoken sentence by sentence as it streams, barge-in (lib/voice/duplex.ts).
 *                REALTIME (G1, when the runtime has a provider): speech-to-speech over WebRTC, every turn
 *                decided and recorded by the runtime (lib/voice/realtimeClient.ts).
 *   languages    (G1) every label from the participant-page catalog (20 built-in languages; others from the
 *                study's translated labels), the language picked from the study's languages and the
 *                browser's (Accept-Language), right-to-left for Urdu, Arabic and the other RTL scripts.
 *   resilience   the resume token is kept in this browser: a reload carries on; a dropped reply is re-asked
 *                with the same position and the server replays it (never answered twice); silence gets a
 *                nudge; Stop ends politely at any time.
 *   access       a live log region (aria-live), labelled controls, keyboard only works, phone layout.
 *
 * Test seam (fake provider only, honoured by the server): `window.__aiInterviewScript = [reply | "fail", …]`
 * — each request takes the next as the stand-in model's reply.
 */

type Mode = "text" | "voice" | "video";
type Choice = "text" | "voice" | "conversation" | "realtime" | "video";
type Style = "turn_based" | "conversation" | "realtime";
interface Stimulus { name: string; kind: "image" | "video" | "text"; url?: string; text?: string; alt?: string }
interface Turn { seq: number; speaker: "moderator" | "participant"; text: string; stimuli?: Stimulus[] }
interface Info { title: string; persona: string; modes: Mode[]; languages: string[]; targetMinutes: number; consent: { statement: string; recordingDisclosure?: string; dataUse?: string }; recordingConsent: "optional" | "required"; screener: { id: string; text: string; kind: "single" | "multi" | "number"; options: string[] }[]; incentive?: string; silenceSeconds: number; voiceStyles?: Style[] }
interface Interview { participant: string; mode: Mode; language: string; status: string; done: boolean; turns: Turn[]; redirect: string | null; lastSeq: number; silenceSeconds: number; recording: boolean; note?: string; code?: string | null; voice?: Style }
interface I18n { guideLanguage: string; texts: Record<string, LocalizedPublicText>; builtin: string[] }
type EventSink = (e: Record<string, unknown>) => void;

const storeKey = (token: string) => `rescript.aiInterview.${token}`;
const safeGet = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const safeSet = (k: string, v: string | null) => { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch { /* private window */ } };
const takeScript = (): unknown => { const w = window as unknown as { __aiInterviewScript?: unknown[] }; return Array.isArray(w.__aiInterviewScript) && w.__aiInterviewScript.length ? w.__aiInterviewScript.shift() : undefined; };
const pickMime = (video: boolean) => { const MR = (window as unknown as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder; const list = video ? ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"] : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]; return list.find((t) => MR?.isTypeSupported?.(t)) ?? ""; };
/* G1: a server error's code → the participant's language */
const ERROR_KEY: Record<string, keyof ParticipantMessages> = { consent_required: "errConsent", recording_consent: "errRecording", closed: "notTaking", unknown_link: "notActive" };
const errorText = (t: ParticipantMessages, b: Record<string, unknown> | null | undefined, fallback: keyof ParticipantMessages, lang: string): string => { const k = ERROR_KEY[String(b?.code ?? "")]; return k ? t[k] : lang === "en" && b?.error ? String(b.error) : t[fallback]; };
const REASON_KEY: Record<string, keyof ParticipantMessages> = { no_mic: "reasonNoMic", no_audio: "reasonNoAudio", insecure: "reasonInsecure" };

async function call(url: string, body: unknown, onText?: (t: string, replace?: boolean) => void, onEvent?: EventSink): Promise<{ status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: onText || onEvent ? "application/x-ndjson, application/json" : "application/json" }, body: JSON.stringify(body) });
    const r = await readNdjson(res, (e) => { if (e.type === "text" && onText) onText(String(e.delta ?? ""), !!e.replace); else if (onEvent) onEvent(e); });
    return { status: r.status, body: (r.body as Record<string, unknown> | null) ?? null };
  } catch { return { status: 0, body: null }; }
}

export function AiInterview({ token, test, pid, params, acceptLanguage, forcedLanguage }: { token: string; test: string | null; pid: string | null; params?: Record<string, string>; acceptLanguage?: string; forcedLanguage?: string | null }) {
  /* G3: a panel's way back for an interview that did not start (screened out, quota full, over quota) */
  const [exit, setExit] = React.useState<{ url: string | null; code: string | null } | null>(null);
  const [phase, setPhase] = React.useState<"loading" | "closed" | "consent" | "starting" | "chat" | "screened" | "error">("loading");
  const [info, setInfo] = React.useState<Info | null>(null);
  const [i18n, setI18n] = React.useState<I18n | null>(null);
  const [isTest, setIsTest] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<{ agreed: boolean; recording: boolean; mode: Choice; language: string; screener: Record<string, string | string[]> }>({ agreed: false, recording: false, mode: "text", language: "", screener: {} });
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
  /* G1: the hands-free conversation and the realtime voice */
  const [conv, setConv] = React.useState<{ phase: DuplexPhase; latencyMs: number | null; interruptions: number; on: boolean }>({ phase: "idle", latencyMs: null, interruptions: 0, on: false });
  const [fallback, setFallback] = React.useState<{ reason: string; to: Style } | null>(null);
  const [rtState, setRtState] = React.useState<"off" | "connecting" | "on">("off");
  const typing = React.useRef<{ start: number | null; pasted: boolean }>({ start: null, pasted: false });
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const lastActivity = React.useRef(Date.now());
  const spokenSeq = React.useRef(0);
  const ivRef = React.useRef<Interview | null>(null); ivRef.current = iv;
  const tokenRef = React.useRef<string | null>(null); tokenRef.current = sessionToken;
  const busyRef = React.useRef(false);
  const duplexRef = React.useRef<DuplexController | null>(null);
  const pendingVoice = React.useRef<{ interrupted?: { heardChars: number }; latencyMs?: number; fallback?: { reason: string; to: Style } }>({});
  const rtRef = React.useRef<{ client: RealtimeClient; expectVerbatim: boolean; lastVerbatim: string | null; pending: string | null } | null>(null);

  /* G1: the page's language — the chosen interview language, else the one picked from the study and the browser */
  const lang = (phase === "chat" && iv?.language) || form.language || forcedLanguage || "en";
  const t = React.useMemo(() => participantMessages(lang, i18n?.texts?.[lang]?.ui), [lang, i18n]);
  const local = i18n?.texts?.[lang] ?? {};
  const dir = isRtlLanguage(lang) ? "rtl" : "ltr";

  /* load: a stored resume token carries on; otherwise the study's consent screen */
  React.useEffect(() => {
    let gone = false;
    (async () => {
      const saved = safeGet(storeKey(token));
      if (saved) {
        const r = await fetch(`/api/ai-interview/session?token=${encodeURIComponent(saved)}`).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })).catch(() => ({ status: 0, body: null }));
        if (!gone && r.status === 200 && r.body?.interview) { setInfo(r.body.info); if (r.body.i18n) setI18n(r.body.i18n); setIv(r.body.interview); setSessionToken(saved); setPhase("chat"); return; }
        if (r.status === 404 || r.status === 400) safeSet(storeKey(token), null);
      }
      const q = new URLSearchParams({ token, ...(test ? { test } : {}) });
      const r = await fetch(`/api/ai-interview/study?${q}`).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })).catch(() => ({ status: 0, body: null }));
      if (gone) return;
      const browser = [...(typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : []), ...parseAcceptLanguage(acceptLanguage)];
      if (r.status !== 200 || !r.body?.view) {
        const l = forcedLanguage || pickInterviewLanguage({ studyLanguages: [], preferences: browser });
        setForm((f) => ({ ...f, language: l }));
        setMessage(r.status === 404 ? participantMessages(l).notActive : participantMessages(l).linkError); setPhase("error"); return;
      }
      const v = r.body.view as Info;
      const intl = (r.body.i18n as I18n | undefined) ?? null;
      setInfo(v); setIsTest(!!r.body.test); setI18n(intl);
      const language = pickInterviewLanguage({ studyLanguages: v.languages, preferences: [forcedLanguage, ...browser], guideLanguage: intl?.guideLanguage });
      if (!r.body.open) { setForm((f) => ({ ...f, language })); const m = participantMessages(language, intl?.texts?.[language]?.ui); setMessage(/paused/i.test(String(r.body.closedReason ?? "")) ? m.paused : m.closed); setPhase("closed"); return; }
      setForm((f) => ({ ...f, mode: choicesOf(v)[0] ?? "text", language }));
      setPhase("consent");
    })();
    return () => { gone = true; };
  }, [token, test]); // eslint-disable-line react-hooks/exhaustive-deps

  /* keep the newest turn in view, and speak new moderator turns in turn-based voice */
  React.useEffect(() => { logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight }); }, [iv?.turns.length, live]);
  const speak = React.useCallback(async (turn: Turn, mode: Mode, language: string) => {
    if (muted || mode === "text" || !sessionToken || turn.seq <= spokenSeq.current) return;
    spokenSeq.current = turn.seq;
    try {
      const r = await fetch("/api/ai-interview/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionToken, seq: turn.seq }) });
      if (r.status === 200) { const url = URL.createObjectURL(await r.blob()); const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); await a.play().catch(() => {}); return; }
    } catch { /* the browser's voice below */ }
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (synth && typeof window.SpeechSynthesisUtterance === "function") { const u = new SpeechSynthesisUtterance(turn.text); u.lang = language; synth.cancel(); synth.speak(u); }
  }, [muted, sessionToken]);
  const handsFree = !!iv && iv.mode === "voice" && ((iv.voice === "conversation" && fallback?.to !== "turn_based") || (iv.voice === "realtime" && !fallback));
  React.useEffect(() => {
    if (!iv || iv.mode === "text" || handsFree || conv.on) return;
    const last = [...iv.turns].reverse().find((x) => x.speaker === "moderator");
    if (last) void speak(last, iv.mode, iv.language);
  }, [iv, speak, handsFree, conv.on]);
  React.useEffect(() => { if (duplexRef.current) duplexRef.current.muted = muted; }, [muted]);
  React.useEffect(() => () => { duplexRef.current?.stop(); rtRef.current?.client.close(); }, []);

  /* silence: a nudge after the study's seconds with no typing, speaking or sending */
  React.useEffect(() => {
    if (phase !== "chat" || !iv || iv.done) return;
    const tm = setInterval(() => {
      if (busy || rec !== "idle" || draft.trim()) return;
      if (conv.on && conv.phase !== "listening") { lastActivity.current = Date.now(); return; }
      if (Date.now() - lastActivity.current > (iv.silenceSeconds || 120) * 1000) { lastActivity.current = Date.now(); void send({ kind: "silence" }); }
    }, 1000);
    return () => clearInterval(tm);
  });

  /* ---------------------------------------------------------------- G1: the hands-free conversation */
  const startDuplex = async (language: string): Promise<boolean> => {
    const sup = conversationSupport();
    if (!sup.ok) { const f = { reason: sup.reason, to: "turn_based" as Style }; setFallback(f); pendingVoice.current.fallback = f; return false; }
    const d = new DuplexController({
      onUtterance: (wav, inf) => { void onUtterance(wav, inf); },
      onPhase: (p) => { lastActivity.current = Date.now(); setConv((c) => ({ ...c, phase: p })); },
      onLatency: (ms) => { pendingVoice.current.latencyMs = ms; setConv((c) => ({ ...c, latencyMs: ms })); },
      onInterrupted: (x) => { pendingVoice.current.interrupted = { heardChars: x.heardChars }; setConv((c) => ({ ...c, interruptions: c.interruptions + 1 })); },
    }, { language });
    try { await d.start(); }
    catch { const f = { reason: "no_mic", to: "turn_based" as Style }; setFallback(f); pendingVoice.current.fallback = f; d.stop(); return false; }
    d.muted = muted;
    duplexRef.current = d;
    setConv((c) => ({ ...c, on: true, phase: d.phase }));
    return true;
  };
  /** the stream's speech events → the player */
  const speechEvents = (d: DuplexController): EventSink => (e) => {
    if (e.type === "speak") d.speakChunk(Number(e.i), String(e.text ?? ""));
    else if (e.type === "audio") d.audioChunk(Number(e.i), e.none || !e.b64 ? null : { mime: String(e.mime ?? "audio/mpeg"), b64: String(e.b64) });
  };
  const onUtterance = async (wav: Uint8Array, inf: { durationMs: number; endAt: number }) => {
    const d = duplexRef.current, tok = tokenRef.current, cur = ivRef.current;
    if (!d || !tok || !cur || cur.done) return;
    d.sent();
    lastActivity.current = Date.now();
    const blob = new Blob([new Uint8Array(wav)], { type: "audio/wav" });
    /* the consented recording uploads while speech-to-text runs; it is named on the turn if it is ready by then */
    let mediaId: string | null = null;
    const upload = cur.recording ? (async () => { try { const up = new RecordingUploader({ endpoints: { begin: "/api/ai-interview/media/ticket", parts: "/api/ai-interview/media/parts", complete: "/api/ai-interview/media/confirm" }, mimeType: "audio/wav", estimatedBytes: blob.size, beginExtra: { sessionToken: tok, kind: "audio", durationSeconds: Math.max(1, Math.round(inf.durationMs / 1000)) }, completeExtra: { sessionToken: tok }, onState: () => {} }); await up.begin(); up.push(blob); const done = await up.finish(Math.round(inf.durationMs / 1000)); if (done.ok) mediaId = done.mediaId; } catch { /* the words are the answer */ } })() : null;
    const res = await fetch("/api/ai-interview/transcribe", { method: "POST", headers: { "content-type": "audio/wav", "x-session-token": tok, "x-duration-ms": String(Math.min(inf.durationMs, 120_000)) }, body: blob }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    const text = res?.status === 200 && j?.text ? String(j.text).trim() : "";
    if (!text) { d.replyDone(false); setVoiceNote(res && [501, 502, 402].includes(res.status) ? t.voiceUnavailable : t.notHeard); return; }
    setVoiceNote(null);
    if (upload) await Promise.race([upload, new Promise((r) => setTimeout(r, 50))]);
    const ok = await send({ kind: "answer", text }, { original: text, durationMs: inf.durationMs, sentByDuplex: true, ...(mediaId ? { audioMediaId: mediaId } : {}) }, d);
    if (!ok) d.replyDone(false);
  };

  /* ---------------------------------------------------------------- G1: the realtime voice */
  const startRealtime = async (tok: string, opening: Interview): Promise<boolean> => {
    if (!RealtimeClient.supported()) return false;
    setRtState("connecting");
    const s = await call("/api/ai-interview/realtime/session", { sessionToken: tok });
    if (s.status !== 200 || !s.body?.clientSecret) { setRtState("off"); return false; }
    const client = new RealtimeClient({
      onUserTranscript: (text) => { void realtimeTurn(text); },
      onResponseDone: (transcript, fnCall) => { void realtimeSpoken(transcript, fnCall); },
      onSpeaking: () => { lastActivity.current = Date.now(); },
      onError: () => { /* recorded by the turns; the participant can still type */ },
    });
    try { await client.connect({ clientSecret: String(s.body.clientSecret), callUrl: String(s.body.callUrl), model: String(s.body.model) }); }
    catch { client.close(); setRtState("off"); return false; }
    rtRef.current = { client, expectVerbatim: true, lastVerbatim: null, pending: null };
    setRtState("on");
    const first = [...opening.turns].reverse().find((x) => x.speaker === "moderator");
    if (first) client.respond(realtimeVerbatimInstructions(first.text), { verbatim: true });
    return true;
  };
  const realtimeTurn = async (text: string) => {
    const rt = rtRef.current, tok = tokenRef.current, cur = ivRef.current;
    if (!rt || !tok || !cur || cur.done) return;
    const r = await call("/api/ai-interview/turn", { sessionToken: tok, afterSeq: cur.lastSeq, input: { kind: "answer", text, meta: { spoken: true } }, original: text, realtime: { prepare: true, ...(rt.lastVerbatim ? { lastVerbatim: rt.lastVerbatim } : {}) } });
    rt.lastVerbatim = null;
    const out = r.body?.realtime as { action?: string; instructions?: string } | undefined;
    if (r.body?.interview) setIv(r.body.interview as Interview);
    if (out?.action === "respond" && out.instructions) { rt.pending = text; rt.expectVerbatim = false; rt.client.respond(out.instructions, { verbatim: false }); }
    else if (out?.action === "say" && out.instructions) { rt.expectVerbatim = true; rt.client.respond(out.instructions, { verbatim: true }); }
  };
  const realtimeSpoken = async (transcript: string, fnCall: { name: string; arguments: string } | null) => {
    const rt = rtRef.current, tok = tokenRef.current, cur = ivRef.current;
    if (!rt || !tok || !cur) return;
    if (rt.expectVerbatim) { rt.lastVerbatim = transcript; return; }
    const text = rt.pending; rt.pending = null;
    if (!text) return;
    const r = await call("/api/ai-interview/turn", { sessionToken: tok, afterSeq: cur.lastSeq, input: { kind: "answer", text, meta: { spoken: true } }, original: text, realtime: { transcript, call: fnCall } });
    if (r.body?.interview) setIv(r.body.interview as Interview);
    const out = r.body?.realtime as { action?: string; instructions?: string } | undefined;
    if (out?.action === "say" && out.instructions) { rt.expectVerbatim = true; rt.client.respond(out.instructions, { verbatim: true }); }
  };

  /* ---------------------------------------------------------------- start and send */
  const start = async () => {
    if (!info) return;
    setError(null); setPhase("starting"); setLive("");
    /* G1: the hands-free conversation opens the microphone NOW (this click is the gesture mobile browsers need for audio) */
    let choice = form.mode;
    let d: DuplexController | null = null;
    if (choice === "conversation" && (await startDuplex(form.language))) d = duplexRef.current;
    else if (choice === "conversation") choice = "voice";
    const mode = choice;
    d?.sent();
    const r = await call("/api/ai-interview/begin", { token, ...(test ? { test } : {}), consent: { agreed: form.agreed, recording: form.recording }, screener: form.screener, mode, language: form.language, pid, params: params ?? {}, script: takeScript(), ...(d ? { speak: true } : {}) }, (x, replace) => setLive((cur) => (replace ? x : (cur ?? "") + x)), d ? speechEvents(d) : undefined);
    d?.replyDone(r.status === 200);
    setLive(null);
    const b = r.body;
    if (r.status !== 200 || !b) { d?.stop(); duplexRef.current = null; setConv((c) => ({ ...c, on: false })); setError(errorText(t, b, "startFailed", lang)); setPhase("consent"); return; }
    if (b.kind === "screened_out" || b.kind === "full" || b.kind === "refused") { d?.stop(); duplexRef.current = null; const p = b.panel as { url?: string | null; code?: string | null; showCode?: boolean } | null | undefined; setExit(p ? { url: p.url ?? null, code: p.showCode ? p.code ?? null : null } : null); setMessage(b.kind === "screened_out" ? t.screenedOut : b.kind === "full" ? t.full : String(b.message)); setPhase("screened"); return; }
    safeSet(storeKey(token), String(b.sessionToken));
    const started = b.interview as Interview;
    setSessionToken(String(b.sessionToken)); tokenRef.current = String(b.sessionToken); setIv(started); ivRef.current = started; setPhase("chat");
    if (d) spokenSeq.current = started.lastSeq;
    if (choice === "realtime" && !(await startRealtime(String(b.sessionToken), started))) {
      /* G1: no realtime connection → the hands-free conversation, and the page says so */
      const f = { reason: "realtime", to: "conversation" as Style };
      setFallback(f); pendingVoice.current.fallback = f;
      if (await startDuplex(form.language)) {
        /* the opening, spoken by the browser's voice (it was written before the fallback) */
        const d2 = duplexRef.current!, last = [...started.turns].reverse().find((x) => x.speaker === "moderator");
        d2.sent(); if (last) { d2.speakChunk(0, last.text); d2.audioChunk(0, null); } d2.replyDone(true);
      }
      else { setFallback({ reason: "realtime", to: "turn_based" }); pendingVoice.current.fallback = { reason: "realtime", to: "turn_based" }; }
    }
    lastActivity.current = Date.now();
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const send = async (input: { kind: "answer" | "silence" | "stop"; text?: string }, extra: { original?: string; durationMs?: number; audioMediaId?: string; sentByDuplex?: boolean } = {}, duplex: DuplexController | null = duplexRef.current): Promise<boolean> => {
    const cur = ivRef.current, tok = tokenRef.current;
    if (!cur || !tok || busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError(null);
    const text = input.text?.trim() ?? "";
    const pending: Turn[] = input.kind === "answer" ? [{ seq: cur.lastSeq + 1, speaker: "participant", text }] : [];
    setIv({ ...cur, turns: [...cur.turns, ...pending] });
    setLive("");
    const orig = extra.original ?? original;
    const meta = input.kind === "answer" ? { typingMs: typing.current.start ? Date.now() - typing.current.start : undefined, pasted: typing.current.pasted, spoken: cur.mode !== "text" && orig !== null } : undefined;
    /* G1: the conversation's voice bookkeeping rides with the turn (what was cut short, the last reply's latency, a fallback) */
    const pv = pendingVoice.current; pendingVoice.current = {};
    const d = duplex;
    const voice = cur.mode !== "text" && (d || pv.fallback || pv.interrupted || pv.latencyMs !== undefined) ? { ...(d ? { speak: true } : {}), ...(pv.interrupted ? { interrupted: pv.interrupted } : {}), ...(pv.latencyMs !== undefined ? { latencyMs: pv.latencyMs } : {}), ...(pv.fallback ? { style: pv.fallback.to, fallback: pv.fallback.reason } : {}) } : undefined;
    const body = { sessionToken: tok, afterSeq: cur.lastSeq, input: { ...input, ...(meta ? { meta } : {}) }, ...(orig !== null && orig !== undefined && input.kind === "answer" ? { original: orig } : {}), ...(extra.durationMs ? { durationMs: extra.durationMs } : {}), ...(extra.audioMediaId ?? mediaIds.audio ? { audioMediaId: extra.audioMediaId ?? mediaIds.audio } : {}), ...(mediaIds.video ? { videoMediaId: mediaIds.video } : {}), ...(voice ? { voice } : {}), script: takeScript() };
    /* the player expects this reply's sentences (an utterance already told it; a typed answer, a nudge or Stop tells it here) */
    if (d && !extra.sentByDuplex) d.sent();
    const onEvent = d ? speechEvents(d) : undefined;
    let r = await call("/api/ai-interview/turn", body, (x, replace) => setLive((c) => (replace ? x : (c ?? "") + x)), onEvent);
    /* a dropped connection: ask again from the same position — the server replays what it already answered */
    if (r.status === 0) r = await call("/api/ai-interview/turn", { ...body, script: undefined }, (x, replace) => setLive((c) => (replace ? x : (c ?? "") + x)), onEvent);
    setLive(null); busyRef.current = false; setBusy(false);
    if (r.status !== 200 || !r.body?.interview) {
      setIv(cur);
      if (d) d.replyDone(false);
      setError(errorText(t, r.body, "sendFailed", lang));
      return false;
    }
    const next = r.body.interview as Interview;
    setIv(next); ivRef.current = next;
    if (d) { spokenSeq.current = next.lastSeq; d.replyDone(true); }
    if (input.kind === "answer") { setDraft(""); setOriginal(null); setMediaIds({}); typing.current = { start: null, pasted: false }; }
    lastActivity.current = Date.now();
    if (next.done) { safeSet(storeKey(token), null); setTimeout(() => { if (duplexRef.current && duplexRef.current.phase !== "speaking") { duplexRef.current.stop(); } rtRef.current?.client.close(); }, 15_000); }
    setTimeout(() => inputRef.current?.focus(), 30);
    return true;
  };

  /* ---------------------------------------------------------------- turn-based voice */
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
    if (typeof window.MediaRecorder !== "function") { setVoiceNote(t.voiceUnavailable); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: iv.mode === "video" ? { width: 640, height: 360 } : false }); }
    catch { setVoiceNote(t.micFailed); return; }
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
    r.stream.getTracks().forEach((x) => x.stop());
    recRef.current = null;
    setRec("transcribing");
    const durationMs = Date.now() - r.started;
    const texts: string[] = [];
    let note: string | null = null;
    for (const blob of r.chunks) {
      const res = await fetch("/api/ai-interview/transcribe", { method: "POST", headers: { "content-type": blob.type || "audio/webm", "x-session-token": sessionToken, "x-duration-ms": String(Math.min(durationMs, 60_000)) }, body: blob }).catch(() => null);
      const j = res ? await res.json().catch(() => null) : null;
      if (res?.status === 200 && j?.text) texts.push(String(j.text));
      else if (res && [501, 502, 402].includes(res.status)) { note = res.status === 502 ? t.sttFailed : t.voiceUnavailable; break; }
    }
    const said = texts.join(" ").trim();
    setDraft(said); setOriginal(said || null);
    setVoiceNote(note ?? (said ? null : t.notHeard));
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
  if (phase === "loading") return <Shell lang={lang} dir={dir}><div className="ai-card" aria-busy="true"><p className="ai-muted">{t.loading}</p></div></Shell>;
  if (phase === "error" || phase === "closed" || phase === "screened") return <Shell lang={lang} dir={dir}><div className="ai-card" data-testid={`ai-${phase}`}><h1 className="ai-h1">{local.title ?? info?.title ?? ""}</h1><p>{message}</p>{exit?.code && <p data-testid="ai-code">{t.yourCode} <b>{exit.code}</b></p>}{exit?.url && <p><a className="ai-btn primary" href={exit.url} rel="noopener noreferrer" data-testid="ai-redirect">{t.continue}</a></p>}</div></Shell>;

  if (phase === "consent" || phase === "starting") {
    if (!info) return null;
    const choices = choicesOf(info);
    const voice = form.mode !== "text";
    const ready = form.agreed && (!voice || info.recordingConsent !== "required" || form.recording) && (form.mode !== "video" || form.recording) && info.screener.every((q) => { const v = form.screener[q.id]; return Array.isArray(v) ? v.length > 0 : !!v && String(v).trim() !== ""; });
    const consent = { ...info.consent, ...(local.consent ?? {}) };
    const support = form.mode === "conversation" ? conversationSupport() : null;
    const languageOptions = info.languages.length ? info.languages : [...new Set([...BUILTIN_INTERVIEW_LANGUAGES, form.language].filter(Boolean))];
    return (
      <Shell lang={lang} dir={dir}>
        <form className="ai-card" data-testid="ai-consent" data-lang={lang} onSubmit={(e) => { e.preventDefault(); if (ready) void start(); }}>
          {isTest && <p className="ai-test" data-testid="ai-test-badge">{t.testBadge}</p>}
          <h1 className="ai-h1">{local.title ?? info.title}</h1>
          <p className="ai-muted" data-testid="ai-about">{formatMessage(t.about, { persona: info.persona, minutes: info.targetMinutes })}{info.incentive ? ` ${local.incentive ?? info.incentive}` : ""}</p>
          {info.languages.length !== 1 && (
            <label className="ai-field"><span>{t.language}</span>
              <select className="ai-input" data-testid="ai-language" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} aria-describedby="ai-lang-help">{languageOptions.map((l) => <option key={l} value={l}>{nativeLanguageName(l)}</option>)}</select>
              <small id="ai-lang-help" className="ai-muted">{t.languageHelp}</small>
            </label>
          )}
          <section aria-labelledby="ai-consent-h"><h2 id="ai-consent-h" className="ai-h2">{t.beforeStart}</h2>
            <p data-testid="ai-consent-statement" dir="auto">{consent.statement}</p>
            {consent.recordingDisclosure && <p className="ai-muted" dir="auto">{consent.recordingDisclosure}</p>}
            {consent.dataUse && <p className="ai-muted" dir="auto">{consent.dataUse}</p>}
            <p className="ai-muted">{t.aiNotice}</p>
            <label className="ai-check"><input type="checkbox" data-testid="ai-agree" checked={form.agreed} onChange={(e) => setForm({ ...form, agreed: e.target.checked })} /> {t.agree}</label>
          </section>
          {choices.length > 1 && (
            <fieldset className="ai-fieldset"><legend className="ai-h2">{t.howAnswer}</legend>
              {choices.map((m) => <label key={m} className="ai-check"><input type="radio" name="ai-mode" value={m} data-testid={`ai-mode-${m}`} checked={form.mode === m} onChange={() => setForm({ ...form, mode: m })} /> {t[MODE_KEY[m]]}</label>)}
            </fieldset>
          )}
          {voice && (
            <div className="ai-fieldset">
              <p className="ai-muted">{form.mode === "conversation" ? t.conversationInfo : form.mode === "realtime" ? t.realtimeInfo : t.voiceInfo}{form.mode === "video" ? ` ${t.videoInfo}` : ""}</p>
              {(form.mode === "conversation" || form.mode === "realtime") && <p className="ai-muted" data-testid="ai-headphones">🎧 {t.headphones}</p>}
              {support && !support.ok && <p className="ai-muted" role="status" data-testid="ai-fallback-note">{formatMessage(t.fallbackTurnBased, { reason: t[REASON_KEY[support.reason]] })}</p>}
              <label className="ai-check"><input type="checkbox" data-testid="ai-recording" checked={form.recording} onChange={(e) => setForm({ ...form, recording: e.target.checked })} /> {form.mode === "video" ? t.recordVideo : `${t.recordVoice}${info.recordingConsent === "required" ? "" : ` ${t.optional}`}`}</label>
            </div>
          )}
          {info.screener.length > 0 && <section aria-labelledby="ai-screener-h" data-testid="ai-screener"><h2 id="ai-screener-h" className="ai-h2">{t.screener}</h2>
            {info.screener.map((q) => {
              const lq = local.screener?.[q.id];
              return (
                <fieldset key={q.id} className="ai-fieldset" data-testid="ai-screener-question"><legend dir="auto">{lq?.text ?? q.text}</legend>
                  {q.kind === "number" ? <input className="ai-input" type="number" inputMode="numeric" value={String(form.screener[q.id] ?? "")} onChange={(e) => setForm({ ...form, screener: { ...form.screener, [q.id]: e.target.value } })} />
                    : q.options.map((o, i) => {
                      const cur = form.screener[q.id];
                      const on = Array.isArray(cur) ? cur.includes(o) : cur === o;
                      /* the label shown is the participant's language; the value sent is the guide's (the server checks it) */
                      return <label key={o} className="ai-check" data-option={o}><input type={q.kind === "multi" ? "checkbox" : "radio"} name={`ai-${q.id}`} value={o} checked={on} onChange={(e) => setForm({ ...form, screener: { ...form.screener, [q.id]: q.kind === "multi" ? (e.target.checked ? [...(Array.isArray(cur) ? cur : []), o] : (Array.isArray(cur) ? cur : []).filter((x) => x !== o)) : o } })} /> <span dir="auto">{lq?.options?.[i] || o}</span></label>;
                    })}
                </fieldset>
              );
            })}
          </section>}
          {error && <p className="ai-error" role="alert" data-testid="ai-error">{error}</p>}
          {live !== null && <p className="ai-muted" aria-live="polite" dir="auto">{live || t.starting}</p>}
          <button type="submit" className="ai-btn primary" data-testid="ai-start" disabled={!ready || phase === "starting"}>{phase === "starting" ? t.starting : t.start}</button>
        </form>
      </Shell>
    );
  }

  if (!iv || !info) return null;
  const voice = iv.mode !== "text";
  const convWord: Record<DuplexPhase, string> = { idle: t.convPaused, listening: t.listening, userSpeaking: t.hearing, processing: t.thinking, speaking: formatMessage(t.speaking, { persona: info.persona }), paused: t.convPaused, ended: t.done };
  const showConv = conv.on && fallback?.to !== "turn_based";
  const showRealtime = iv.voice === "realtime" && rtState !== "off" && !fallback;
  const turnBasedVoice = voice && !showConv && !showRealtime;
  return (
    <Shell lang={lang} dir={dir}>
      <div className="ai-chat" data-testid="ai-chat" data-mode={iv.mode} data-voice={iv.voice ?? ""} data-status={iv.status} data-done={iv.done ? "1" : "0"} data-lang={lang} data-dir={dir}>
        <header className="ai-head">
          <div><b>{local.title ?? info.title}</b><div className="ai-muted">{info.persona} · {t.aiInterviewer}{isTest ? ` · ${t.test}` : ""}</div></div>
          <span className="ai-grow" />
          {voice && <button type="button" className="ai-btn small" aria-pressed={muted} onClick={() => setMuted(!muted)} data-testid="ai-mute">{muted ? t.unmute : t.mute}</button>}
          {!iv.done && <button type="button" className="ai-btn small" data-testid="ai-stop" onClick={() => { if (window.confirm(t.stopConfirm)) void send({ kind: "stop" }); }} disabled={busy}>{t.stop}</button>}
        </header>
        <div className="ai-log" role="log" aria-live="polite" aria-relevant="additions" ref={logRef} data-testid="ai-log">
          {iv.turns.map((x) => (
            <div key={x.seq} className={`ai-turn ${x.speaker}`} data-testid={`ai-turn-${x.speaker}`} data-seq={x.seq}>
              <span className="ai-sr">{x.speaker === "moderator" ? `${info.persona}: ` : `${t.you}: `}</span>
              <p dir="auto">{x.text}</p>
              {x.stimuli?.map((s, i) => <StimulusView key={i} s={s} />)}
            </div>
          ))}
          {live !== null && <div className="ai-turn moderator pending" data-testid="ai-live"><p dir="auto">{live || "…"}</p></div>}
          {iv.note && <div className="ai-turn moderator" data-testid="ai-note"><p>{iv.status === "ended" ? t.endedByTeam : iv.note}</p></div>}
        </div>
        {iv.done ? (
          <div className="ai-done" data-testid="ai-done">
            <p><b>{t.done}</b></p>
            {iv.code && <p data-testid="ai-code">{t.completionCode} <b>{iv.code}</b></p>}
            {iv.redirect && <p><a className="ai-btn primary" href={iv.redirect} rel="noopener noreferrer" data-testid="ai-redirect">{t.continue}</a></p>}
          </div>
        ) : (
          <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void send({ kind: "answer", text: draft }); }}>
            {iv.mode === "video" && <video id="ai-camera" className="ai-camera" muted playsInline aria-label="camera" hidden={rec !== "recording"} />}
            {fallback && <p className="ai-muted" role="status" data-testid="ai-fallback-note" data-reason={fallback.reason}>{fallback.reason === "realtime" ? t.realtimeFailed : formatMessage(t.fallbackTurnBased, { reason: t[REASON_KEY[fallback.reason] ?? "reasonNoAudio"] })}</p>}
            {showConv && (
              <div className="ai-conv" data-testid="ai-conv" data-phase={conv.phase} data-latency-ms={conv.latencyMs ?? ""} data-interruptions={conv.interruptions}>
                <span className={`ai-dot ${conv.phase}`} aria-hidden="true" />
                <span role="status" data-testid="ai-conv-status">{convWord[conv.phase]}</span>
                <span className="ai-grow" />
                <button type="button" className="ai-btn small" data-testid="ai-conv-pause" onClick={() => { const d = duplexRef.current; if (!d) return; if (d.phase === "paused") d.resume(); else d.pause(); }}>{conv.phase === "paused" ? t.resume : t.pause}</button>
              </div>
            )}
            {!conv.on && iv.voice === "conversation" && !fallback && (
              <div className="ai-voice"><button type="button" className="ai-btn primary" data-testid="ai-conv-start" onClick={() => void startDuplex(iv.language)}>🎙 {t.startTalking}</button></div>
            )}
            {showRealtime && <div className="ai-conv" data-testid="ai-realtime" data-state={rtState}><span className={`ai-dot ${rtState === "on" ? "listening" : "processing"}`} aria-hidden="true" /><span role="status">{rtState === "on" ? t.listening : t.realtimeConnecting}</span></div>}
            {turnBasedVoice && (
              <div className="ai-voice">
                {rec === "recording"
                  ? <button type="button" className="ai-btn danger" data-testid="ai-rec-stop" onClick={() => void stopRecording()}>{t.stopAndCheck}</button>
                  : <button type="button" className="ai-btn" data-testid="ai-rec-start" onClick={() => void startRecording()} disabled={busy || rec === "transcribing"}>{rec === "transcribing" ? t.transcribing : t.speak}</button>}
              </div>
            )}
            {voiceNote && <span className="ai-muted" role="status" data-testid="ai-voice-note">{voiceNote}</span>}
            <label className="ai-sr" htmlFor="ai-input">{turnBasedVoice ? t.answerLabelVoice : t.answerLabel}</label>
            <textarea id="ai-input" ref={inputRef} className="ai-input" data-testid="ai-input" dir="auto" rows={turnBasedVoice ? 3 : 2} value={draft} placeholder={turnBasedVoice ? t.placeholderVoice : t.placeholder}
              onChange={(e) => { if (!typing.current.start) typing.current.start = Date.now(); setDraft(e.target.value); lastActivity.current = Date.now(); }}
              onPaste={() => { typing.current.pasted = true; }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (draft.trim()) void send({ kind: "answer", text: draft }); } }} disabled={busy} maxLength={8000} />
            <div className="ai-row">
              {error && <span className="ai-error" role="alert" data-testid="ai-error">{error}</span>}
              <span className="ai-grow" />
              <button type="submit" className="ai-btn primary" data-testid="ai-send" disabled={busy || !draft.trim() || rec !== "idle"}>{busy ? "…" : t.send}</button>
            </div>
          </form>
        )}
      </div>
    </Shell>
  );
}

const MODE_KEY: Record<Choice, keyof ParticipantMessages> = { text: "modeText", voice: "modeVoice", conversation: "modeConversation", realtime: "modeRealtime", video: "modeVideo" };
/** the ways of answering the study offers, in the page's order (G1: voice splits into its styles) */
function choicesOf(info: Info): Choice[] {
  const styles = info.voiceStyles ?? ["turn_based", "conversation"];
  return info.modes.flatMap((m): Choice[] => (m !== "voice" ? [m] : (["conversation", "turn_based", "realtime"] as const).filter((s) => styles.includes(s)).map((s) => (s === "turn_based" ? "voice" : s))));
}

function StimulusView({ s }: { s: Stimulus }) {
  if (s.kind === "image" && s.url) return <figure className="ai-stim" data-testid="ai-stimulus"><img src={s.url} alt={s.alt ?? s.name} referrerPolicy="no-referrer" /><figcaption dir="auto">{s.name}</figcaption></figure>;
  if (s.kind === "video" && s.url) return <figure className="ai-stim" data-testid="ai-stimulus"><video src={s.url} controls playsInline preload="metadata" aria-label={s.name} /><figcaption dir="auto">{s.name}</figcaption></figure>;
  return <blockquote className="ai-stim text" data-testid="ai-stimulus" dir="auto"><b>{s.name}</b>{s.text && s.text !== s.name ? <p>{s.text}</p> : null}</blockquote>;
}

function Shell({ children, lang, dir }: { children: React.ReactNode; lang: string; dir: "ltr" | "rtl" }) {
  /* G1: the document follows the page's language and direction (screen readers, Urdu / Arabic layout) */
  React.useEffect(() => { try { document.documentElement.lang = lang; document.documentElement.dir = dir; } catch { /* no document */ } }, [lang, dir]);
  return <main className="ai-shell" lang={lang} dir={dir} data-testid="ai-shell">{children}</main>;
}
