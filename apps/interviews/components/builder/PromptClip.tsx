"use client";
import React from "react";
import { RecordingUploader, pickRecordingMime, type UploadState } from "@/lib/uploader";

/**
 * THE INTERVIEWER, ASKING THE QUESTION ON CAMERA.
 *
 * Record it here, watch it back, record it again, or upload a clip that was
 * made elsewhere. Whatever is kept is stored against this one question and is
 * what the candidate sees — auto-played, un-skippable — when they reach it.
 *
 * ## Parts leave while recording, same as everywhere else
 *
 * This is the same `RecordingUploader` the candidate uses, pointed at the
 * question's own endpoints. Chunks are pushed as the recorder produces them, so
 * a two-minute clip has mostly arrived by the time the interviewer presses
 * Stop, and a browser that closes mid-way leaves an `uploading` row for the
 * abandoned-upload sweep rather than a lost take. The question keeps pointing
 * at its previous clip until the new one is verified stored — a replace that
 * fails leaves the interview exactly as it was.
 *
 * ## The bitrate is capped
 *
 * 900 kbps video, 96 kbps audio — the candidate recorder's numbers. A prompt
 * clip is also transcribed, through a provider that accepts 25 MB, and a
 * browser-default 720p bitrate crosses that in a minute or two. The
 * interviewer does not need to know this; the number does.
 */
export function PromptClip({ projectId, questionId, promptMediaId, onChange }: {
  projectId: string;
  questionId: string;
  promptMediaId: string | null;
  onChange: (mediaId: string | null) => void;
}) {
  type Phase = "idle" | "arming" | "ready" | "recording" | "review" | "uploading" | "stored" | "failed";
  const [phase, setPhase] = React.useState<Phase>(promptMediaId ? "stored" : "idle");
  const [error, setError] = React.useState<string | null>(null);
  const [seconds, setSeconds] = React.useState(0);
  const [upload, setUpload] = React.useState<UploadState | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [playbackUrl, setPlaybackUrl] = React.useState<string | null>(null);

  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const uploaderRef = React.useRef<RecordingUploader | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const startedAt = React.useRef(0);
  const tick = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const endpoints = React.useMemo(() => {
    const base = `/api/projects/${projectId}/questions/${questionId}/prompt`;
    return { begin: `${base}?step=begin`, parts: `${base}?step=parts`, complete: `${base}?step=complete` };
  }, [projectId, questionId]);

  React.useEffect(() => () => {
    for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* the existing clip, for review — through the staff playback route */
  React.useEffect(() => {
    if (phase !== "stored" || !promptMediaId) { setPlaybackUrl(null); return; }
    let cancelled = false;
    fetch(`/api/media/${promptMediaId}/url`).then((r) => r.json()).then((j) => {
      if (!cancelled && j?.url) setPlaybackUrl(j.url);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [phase, promptMediaId]);

  async function arm() {
    setError(null); setPhase("arming");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 1280, height: 720 } });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.muted = true; await videoRef.current.play().catch(() => {}); }
      setPhase("ready");
    } catch (e) {
      setPhase("idle");
      setError((e as Error).name === "NotAllowedError"
        ? "Your browser blocked the camera. Allow it in the address bar, then press Set up again."
        : `The camera could not be opened: ${(e as Error).message}`);
    }
  }

  /**
   * Record and upload at once. The uploader is begun first so the first
   * chunk has somewhere to go; chunks are ALSO kept locally so the clip can be
   * played back for review before it is kept.
   */
  async function start() {
    if (!streamRef.current) return;
    setError(null);
    const mime = pickRecordingMime();
    const uploader = new RecordingUploader({
      endpoints, mimeType: mime,
      /* a generous ceiling: ten minutes of prompt is more than anybody records */
      estimatedBytes: Math.ceil(((900_000 + 96_000) / 8) * 600 * 1.15),
      onState: setUpload,
    });
    uploaderRef.current = uploader;
    try { await uploader.begin(); } catch { setPhase("ready"); return; }

    chunksRef.current = [];
    const rec = new MediaRecorder(streamRef.current, { mimeType: mime, videoBitsPerSecond: 900_000, audioBitsPerSecond: 96_000 });
    rec.ondataavailable = (e) => { if (e.data.size) { chunksRef.current.push(e.data); uploader.push(e.data); } };
    recorderRef.current = rec;
    rec.start(5000);
    startedAt.current = Date.now();
    setSeconds(0);
    setPhase("recording");
    tick.current = setInterval(() => setSeconds((Date.now() - startedAt.current) / 1000), 250);
  }

  async function stop() {
    if (!recorderRef.current) return;
    if (tick.current) { clearInterval(tick.current); tick.current = null; }
    await new Promise<void>((resolve) => {
      const r = recorderRef.current!;
      r.onstop = () => resolve();
      try { r.stop(); } catch { resolve(); }
    });
    recorderRef.current = null;
    const blob = new Blob(chunksRef.current, { type: pickRecordingMime() });
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    if (videoRef.current) { videoRef.current.srcObject = null; videoRef.current.muted = false; videoRef.current.src = url; }
    setPhase("review");
  }

  /** Keep this take: finish the upload, verify, attach. */
  async function keep() {
    if (!uploaderRef.current) return;
    setPhase("uploading");
    const out = await uploaderRef.current.finish(seconds);
    if (!out.ok) { setPhase("failed"); setError(out.error); return; }
    onChange(out.mediaId);
    for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    streamRef.current = null;
    setPhase("stored");
  }

  /** Discard this take and record another. */
  async function again() {
    await uploaderRef.current?.abandon();
    uploaderRef.current = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setUpload(null);
    if (videoRef.current && streamRef.current) {
      videoRef.current.src = ""; videoRef.current.srcObject = streamRef.current; videoRef.current.muted = true;
      void videoRef.current.play().catch(() => {});
    }
    setPhase("ready");
  }

  /** A clip made elsewhere — pushed through the same uploader as one part stream. */
  async function uploadFile(file: File) {
    setError(null);
    if (!/^video\//.test(file.type)) { setError("That is not a video file."); return; }
    if (file.size > 200 * 1024 * 1024) { setError("That file is over 200 MB — please trim or compress it first."); return; }
    setPhase("uploading");
    const uploader = new RecordingUploader({ endpoints, mimeType: file.type || "video/mp4", estimatedBytes: file.size, onState: setUpload });
    uploaderRef.current = uploader;
    try { await uploader.begin(); } catch { setPhase("idle"); return; }
    /* fed in slices so the accumulator releases parts as it would for a recorder */
    const slice = 4 * 1024 * 1024;
    for (let at = 0; at < file.size; at += slice) uploader.push(file.slice(at, Math.min(file.size, at + slice), file.type));
    const out = await uploader.finish(0);
    if (!out.ok) { setPhase("failed"); setError(out.error); return; }
    onChange(out.mediaId);
    setPhase("stored");
  }

  async function remove() {
    const res = await fetch(`/api/projects/${projectId}/questions/${questionId}/prompt`, { method: "DELETE" });
    if (res.ok) { onChange(null); setPhase("idle"); setPlaybackUrl(null); }
    else setError("The clip could not be removed.");
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div data-testid="prompt-clip" data-phase={phase} style={{ marginTop: 12 }}>
      <span className="small" style={{ display: "block", marginBottom: 6 }}>You, asking the question (optional)</span>

      {phase === "stored" ? (
        <>
          {playbackUrl
            ? <video src={playbackUrl} controls playsInline style={{ width: "100%", maxWidth: 480, aspectRatio: "16 / 9", background: "#000", borderRadius: 8 }} />
            : <p className="tiny muted">A clip is attached. Loading it for review…</p>}
          <p className="tiny muted" style={{ marginTop: 6 }}>
            Candidates watch this before they can answer. It plays automatically and cannot be skipped.
          </p>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="btn small secondary" onClick={() => setPhase("idle")} data-testid="prompt-replace">Replace</button>
            <button type="button" className="btn small secondary" onClick={() => void remove()} data-testid="prompt-remove">Remove</button>
          </div>
        </>
      ) : (
        <>
          {(phase === "ready" || phase === "recording" || phase === "review") && (
            <video ref={videoRef} playsInline controls={phase === "review"}
              style={{ width: "100%", maxWidth: 480, aspectRatio: "16 / 9", background: "#000", borderRadius: 8 }} />
          )}

          <div className="row" style={{ gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            {phase === "idle" && (
              <>
                <button type="button" className="btn small" onClick={() => void arm()} data-testid="prompt-setup">Record a clip</button>
                <label className="btn small secondary" style={{ cursor: "pointer" }}>
                  Upload a video
                  <input type="file" accept="video/*" style={{ display: "none" }} data-testid="prompt-file"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }} />
                </label>
                {promptMediaId && <button type="button" className="btn small secondary" onClick={() => setPhase("stored")}>Keep the current clip</button>}
              </>
            )}
            {phase === "arming" && <span className="muted small">Opening the camera…</span>}
            {phase === "ready" && (
              <button type="button" className="btn small" onClick={() => void start()} data-testid="prompt-record">Start recording</button>
            )}
            {phase === "recording" && (
              <>
                <span className="dot live" /><strong>{fmt(seconds)}</strong>
                <button type="button" className="btn small" onClick={() => void stop()} data-testid="prompt-stop">Stop</button>
              </>
            )}
            {phase === "review" && (
              <>
                <button type="button" className="btn small" onClick={() => void keep()} data-testid="prompt-keep">Keep this take</button>
                <button type="button" className="btn small secondary" onClick={() => void again()} data-testid="prompt-again">Record again</button>
                <span className="tiny muted">{fmt(seconds)}</span>
              </>
            )}
            {phase === "uploading" && (
              <span className="muted small" data-testid="prompt-uploading">
                Saving… {upload && upload.partsTotal > 1 ? `${upload.partsDone} of ${upload.partsTotal} parts` : ""}
              </span>
            )}
            {phase === "failed" && (
              <button type="button" className="btn small secondary" onClick={() => setPhase("idle")}>Start over</button>
            )}
          </div>
          {error && <p className="note bad" style={{ marginTop: 8 }} data-testid="prompt-error">{error}</p>}
        </>
      )}
    </div>
  );
}
