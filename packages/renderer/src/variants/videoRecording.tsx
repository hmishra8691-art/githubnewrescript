"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { videoRecordingConfig, pickRecorderMime, transcribesVideo, answerKey } from "@rescript/engine";
import { uploadBlobForSession } from "../lib/sessionUpload";
import { answerVideoRule } from "@rescript/media";
import { uploadFile, liveSessionId, filesOf, commitFiles, fmtSize, type UploadedFile } from "./upload";

/**
 * S5a item 3 — RESPONDENT VIDEO RECORDING (audit MM2-09), renderer key `videorecording` (`media.video_recording`).
 *
 * Consent first (the question's consentText, a checkbox the camera waits for), then getUserMedia({video, audio}) with
 * a live, muted preview; Record / Stop with the elapsed and the limit (maxAnswerSeconds — the recorder stops itself
 * there); the take plays back with Re-record (up to maxRetakes). The take is uploaded through the same resumable
 * session pipeline as every respondent file (`uploadFile` → /api/session/media/ticket, parts, confirm) and is checked
 * three times: here (answerVideoRule), on the ticket route and against the stored bytes (sniffVideo). No camera, a
 * refused permission or no MediaRecorder → a video file input (the fallback), with the same rules. The answer is the
 * upload base type's [{url, name, size, type}], so exports, delivery and deletion treat it like any other file.
 *
 * Q7 — WHAT WAS SAID. While the camera records, a second recorder takes the AUDIO track alone (a few hundred KB a
 * minute, what a speech-to-text service reads); after the video is stored it is uploaded as the take's audio
 * (`answer_audio`, the same pipeline as a voice answer) and transcribed. The transcript is written onto the video
 * file's answer (`transcript`) by the server when the job ends, and here as soon as this page sees it, so a page
 * save never drops it. An uploaded video file (no live audio track) is transcribed from the file itself when it is
 * small enough for the service. When no transcription service is configured the answer is complete without one.
 */
type Phase = "consent" | "idle" | "preview" | "recording" | "saving";

export function VideoRecording(p: QRProps) {
  const cfg = videoRecordingConfig(p.q);
  const saved = filesOf(p)[0];
  const ro = !!p.q.settings.readOnly;
  const [phase, setPhase] = React.useState<Phase>(cfg.consentText ? "consent" : "idle");
  const [agreed, setAgreed] = React.useState(!cfg.consentText);
  const [secs, setSecs] = React.useState(0);
  const [note, setNote] = React.useState<string | null>(null);
  const [fallback, setFallback] = React.useState(false);
  const [takes, setTakes] = React.useState(0);
  const preview = React.useRef<HTMLVideoElement>(null);
  const stream = React.useRef<MediaStream | null>(null);
  const rec = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const audioRec = React.useRef<MediaRecorder | null>(null);
  const audioChunks = React.useRef<Blob[]>([]);
  const savedRef = React.useRef<UploadedFile | null>(saved ?? null);
  savedRef.current = saved ?? null;
  const [transcribing, setTranscribing] = React.useState(false);
  const wantsTranscript = transcribesVideo(p.q);
  const tick = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const live = React.useRef<HTMLDivElement>(null);

  const stopTick = () => { if (tick.current) { clearInterval(tick.current); tick.current = null; } };
  const release = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  /* the live preview: attached once the <video> exists (after the phase change commits), never before */
  React.useEffect(() => {
    const v = preview.current, s = stream.current;
    if ((phase === "preview" || phase === "recording") && v && s && v.srcObject !== s) { v.srcObject = s; void v.play().catch(() => {}); }
  }, [phase]);
  React.useEffect(() => () => { stopTick(); try { rec.current?.state === "recording" && rec.current.stop(); } catch { /* gone */ } try { audioRec.current?.state === "recording" && audioRec.current.stop(); } catch { /* gone */ } release(); }, []);

  /* Q7: follow a transcription job and put what it says onto the video answer (the server writes it too) */
  const transcribe = async (sessionId: string, mediaId: string, takeUrl: string) => {
    setTranscribing(true);
    const write = (t: Record<string, unknown>) => {
      /* only onto the take it was made from — never onto a re-recording that replaced it */
      const cur = savedRef.current; if (!cur || cur.url !== takeUrl) return;
      commitFiles(p, [{ ...cur, transcript: { text: (t.text as string) || undefined, language: (t.language as string) ?? undefined, status: (t.status as string) ?? undefined, source: t.text ? "provider" : "none", mediaId, ...(t.completedAt ? { transcribedAt: String(t.completedAt) } : {}) } } as UploadedFile]);
    };
    try {
      const r = await fetch("/api/session/media/transcript", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, mediaId, questionId: p.q.id }) });
      const j = await r.json().catch(() => ({}));
      if (j?.transcript?.status) write(j.transcript);
      for (let i = 0; i < 40 && j?.transcript?.pending; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const poll = await fetch(`/api/session/media/transcript?sessionId=${encodeURIComponent(sessionId)}&mediaId=${encodeURIComponent(mediaId)}`);
        const pj = await poll.json().catch(() => ({}));
        if (!pj?.transcript) break;
        write(pj.transcript);
        if (!pj.transcript.pending) break;
      }
    } catch { /* the video is stored; a transcript that never arrives is retried by the server's sweep or by a researcher */ }
    finally { setTranscribing(false); }
  };

  const store = async (blob: Blob, name: string, audio?: Blob | null) => {
    const verdict = answerVideoRule(blob.type || "video/webm", blob.size, cfg.maxSizeMb);
    if (!verdict.ok) { setNote(verdict.message!); setPhase("idle"); return; }
    setPhase("saving");
    const sessionId = liveSessionId(p);
    try {
      const up = await uploadFile(blob, { sessionId, questionId: p.q.id, fileName: name });
      const file = { ...up, name: up.name || name, type: up.type || blob.type };
      savedRef.current = file;
      commitFiles(p, [file]);
      setNote(null);
      if (sessionId && wantsTranscript) {
        let mediaId: string | null = null;
        if (audio && audio.size) {
          /* the take's audio track: what the transcription service reads */
          const a = await uploadBlobForSession(audio, { sessionId, kind: "answer_audio", questionId: p.q.id, answerKey: answerKey(p.q.id, p.loop), fileName: "take-audio.webm", mimeType: audio.type || "audio/webm", bytes: audio.size });
          if (a.ok) mediaId = a.mediaId;
        } else if (up.mediaId && blob.size <= 25 * 1024 * 1024 && !/quicktime/.test(blob.type)) {
          mediaId = up.mediaId; // an uploaded file: transcribed from the file itself
        }
        if (mediaId) void transcribe(sessionId, mediaId, file.url);
      }
    } catch (e) {
      setNote((e as Error).message || "Could not save the video.");
    } finally {
      setPhase("idle");
    }
  };

  const openCamera = async () => {
    setNote(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setFallback(true);
      setNote("Video recording is not supported by this browser — please upload a video file instead.");
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: true });
      stream.current = s;
      setPhase("preview");
    } catch {
      setFallback(true);
      setNote("No camera available (or permission was refused) — please upload a video file instead.");
    }
  };

  const start = () => {
    const s = stream.current;
    if (!s) return;
    const mimeType = pickRecorderMime((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m) === true);
    let r: MediaRecorder;
    try { r = new MediaRecorder(s, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 900_000, audioBitsPerSecond: 96_000 }); }
    catch { r = new MediaRecorder(s); }
    chunks.current = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = async () => {
      stopTick();
      const type = (r.mimeType || "video/webm").split(";")[0];
      const blob = new Blob(chunks.current, { type });
      /* the audio recorder hands over its last chunk on stop: wait for it before the stream is released */
      const ar = audioRec.current;
      const audio = ar ? await new Promise<Blob | null>((res) => { ar.onstop = () => res(new Blob(audioChunks.current, { type: (ar.mimeType || "audio/webm").split(";")[0] })); try { ar.state !== "inactive" ? ar.stop() : res(null); } catch { res(null); } }) : null;
      release();
      if (blob.size) void store(blob, type === "video/mp4" ? "recording.mp4" : "recording.webm", audio);
      else { setPhase("idle"); setNote("Nothing was recorded — please try again."); }
    };
    /* Q7: the audio track alone, recorded beside the video, for the transcript */
    audioChunks.current = [];
    audioRec.current = null;
    if (wantsTranscript && s.getAudioTracks().length) {
      const am = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported?.(m));
      try {
        const ar = new MediaRecorder(new MediaStream(s.getAudioTracks()), { ...(am ? { mimeType: am } : {}), audioBitsPerSecond: 64_000 });
        ar.ondataavailable = (e) => { if (e.data.size) audioChunks.current.push(e.data); };
        ar.start(1000);
        audioRec.current = ar;
      } catch { /* no separate audio recorder in this browser: the video is still kept */ }
    }
    rec.current = r;
    r.start(1000);
    setSecs(0);
    setPhase("recording");
    tick.current = setInterval(() => setSecs((n) => {
      const next = n + 1;
      if (next >= cfg.maxSeconds) { try { r.state === "recording" && r.stop(); } catch { /* stopped */ } }
      return next;
    }), 1000);
  };
  const stop = () => { stopTick(); try { rec.current?.state === "recording" && rec.current.stop(); } catch { /* stopped */ } rec.current = null; };
  const reRecord = () => { commitFiles(p, []); setTakes((t) => t + 1); setPhase("idle"); };
  const retakesLeft = cfg.maxRetakes == null ? Infinity : Math.max(0, cfg.maxRetakes - takes);
  const mmss = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;

  return (
    <div className="rs-vrec" data-testid="vrec">
      {cfg.consentText && (
        <label className="rs-vrec-consent" data-testid="vrec-consent">
          <input type="checkbox" checked={agreed} disabled={ro || !!saved} data-testid="vrec-consent-box"
            onChange={(e) => { setAgreed(e.target.checked); if (e.target.checked && phase === "consent") setPhase("idle"); if (!e.target.checked) { release(); setPhase("consent"); } }} />
          <span>{cfg.consentText}</span>
        </label>
      )}
      {saved ? (
        <>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video className="rs-vrec-play" controls playsInline src={saved.url} data-testid="vrec-playback" aria-label="Your recorded answer" />
          <div className="rs-up-actions">
            <span className="rs-up-size" data-testid="vrec-saved">{saved.name} · {fmtSize(saved.size)}{transcribing ? " · transcribing…" : ""}</span>
            {retakesLeft > 0 && (
              <button type="button" className="rs-btn secondary" disabled={ro} data-testid="vrec-redo" onClick={reRecord}>Re-record</button>
            )}
          </div>
        </>
      ) : (
        <>
          {(phase === "preview" || phase === "recording") && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video ref={preview} className="rs-vrec-preview" muted playsInline autoPlay data-testid="vrec-preview" aria-label="Camera preview" />
          )}
          <div className="rs-up-actions">
            {phase === "recording" ? (
              <button type="button" className="rs-btn rs-rec-stop" data-testid="vrec-stop" onClick={stop}>■ Stop ({mmss(secs)} / {mmss(cfg.maxSeconds)})</button>
            ) : phase === "preview" ? (
              <button type="button" className="rs-btn rs-rec-start" data-testid="vrec-record" disabled={ro} onClick={start}>● Start recording</button>
            ) : !fallback ? (
              <button type="button" className="rs-btn rs-rec-start" data-testid="vrec-camera" disabled={ro || !agreed || phase === "saving"}
                aria-describedby={cfg.consentText && !agreed ? `${p.q.id}-vrec-why` : undefined}
                onClick={() => void openCamera()}>{phase === "saving" ? "Saving…" : "🎥 Turn on the camera"}</button>
            ) : null}
            {cfg.allowUpload && (
              <>
                <span className="rs-rec-or">or</span>
                <button type="button" className="rs-btn secondary" disabled={ro || !agreed || phase === "recording" || phase === "saving"}
                  data-testid="vrec-upload" onClick={() => fileRef.current?.click()}>Upload a video file</button>
              </>
            )}
          </div>
          {cfg.consentText && !agreed && <div id={`${p.q.id}-vrec-why`} className="rs-media-note">Tick the consent box above to turn on the camera.</div>}
          <input ref={fileRef} className="rs-up-input" type="file" accept="video/webm,video/mp4,video/quicktime" capture="user"
            disabled={ro} data-testid="vrec-input"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void store(f, f.name || "video"); }} />
        </>
      )}
      <div ref={live} className="rs-sr-only" aria-live="polite" data-testid="vrec-live">
        {phase === "recording" ? "Recording" : phase === "saving" ? "Saving your video" : saved ? "Video saved" : ""}
      </div>
      {phase === "recording" && <div className="rs-rec-live" aria-hidden="true">● REC {mmss(secs)} / {mmss(cfg.maxSeconds)}</div>}
      {note && <div className="rs-media-note" role="status" data-testid="vrec-note">{note}</div>}
    </div>
  );
}

registerVariantRenderer("videorecording", VideoRecording);
