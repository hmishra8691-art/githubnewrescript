"use client";
import React from "react";
import type { InterviewVideo } from "@rescript/schema";
import {
  RECORDING_CONSTRAINTS, MEDIA_KINDS, withinLimit, TRANSCRIPT_SAY, transcriptPending,
  type MediaKind, type TranscriptStatus,
} from "@rescript/media";
import { registerVariantSettings, type VariantSettingsProps } from "./registry";
import { CountInput } from "../CountInput";
import { useStudio } from "../store";

/**
 * Studio authoring for the Video Interview.
 *
 * Three groups, because a researcher configures three separable things: the
 * question they recorded, the answer they want back, and what happens to it
 * afterwards. The defaults are the qualitative ones — watch it through,
 * answer out loud, transcribe, keep both — so a researcher who changes
 * nothing gets a depth interview rather than a video with a microphone
 * underneath it.
 *
 * ## The recorder
 *
 * Camera and microphone are previewed BEFORE recording starts, with device
 * pickers, because the commonest way to waste a take is to discover
 * afterwards that the wrong microphone was live. Recording is in-browser
 * `MediaRecorder`; pause and resume are offered where the browser supports
 * them and hidden where it does not, rather than shown and failing.
 *
 * ### Why a five-minute take used to fail
 *
 * Not because a limit was too low. Because nothing had ever said how big a
 * recording should be. The old recorder asked for `{video: true}` and
 * whatever bitrate the browser felt like — on a 1080p webcam that is 2.5–5
 * Mbps, so five minutes was 95–190 MB, held in the tab as an array of Blobs
 * AND a concatenated copy AND a third copy inside a FormData, then POSTed
 * through our own server to storage. Three things then went wrong at once: a
 * serverless host refuses a request body over 4.5 MB, the function times out
 * long before 100 MB has moved, and a low-memory laptop crashes the tab
 * before either. The error a researcher saw was "The video could not be saved
 * (413)", because a platform error page has no JSON body for the route's own
 * careful message to arrive in.
 *
 * So: the stream is constrained to 720p, the recorder is given an explicit
 * bitrate, chunks are flushed every few seconds and released once the take is
 * assembled, and the bytes go straight from the browser to object storage on
 * a signed URL that never passes through this application. Five minutes is
 * ~36 MB and the upload is the browser's problem, which is the one part of
 * this that was never broken.
 *
 * ### And why a 0.2-second take then failed
 *
 * The fourth limit, which none of the above touches: a Supabase PROJECT has a
 * global upload ceiling — 50 MB by default — and no bucket may declare one
 * above it. Creating the video bucket with a 150 MB `fileSizeLimit` was
 * refused with "The object exceeded the maximum allowed size", a sentence
 * about a bucket that reads like a sentence about a file. Nothing had been
 * uploaded at all; the bucket did not exist.
 *
 * So the ceiling is now asked for rather than assumed. This component fetches
 * it before the camera opens, shows it, and stops the recording there — a
 * limit discovered at upload time is a limit discovered after the interview.
 *
 * The microphone is recorded TWICE — once into the video, once on its own at
 * 64 kbps. That second track is the audio extraction: transcription services
 * take 25 MB and a 36 MB video is not something to hand them, and doing it
 * here costs nothing because the browser already has the track. Five minutes
 * of it is 2.4 MB.
 *
 * The sandbox has no survey row and so no storage: there, the recording
 * stays an object URL on the definition and the panel says so. That is the
 * same carve-out the localization audio library has, for the same reason.
 */

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/* ----------------------------------------------------------- the recorder */

function VideoRecorder({ q, patchSettings }: VariantSettingsProps) {
  const s = useStudio();
  const current = q.settings.interviewVideo;

  const [mode, setMode] = React.useState<"idle" | "preview" | "recording" | "paused" | "review">("idle");
  const [devices, setDevices] = React.useState<{ cams: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>({ cams: [], mics: [] });
  const [camId, setCamId] = React.useState("");
  const [micId, setMicId] = React.useState("");
  const [secs, setSecs] = React.useState(0);
  const [note, setNote] = React.useState<string | null>(null);
  const [takeUrl, setTakeUrl] = React.useState<string | null>(null);
  const [takeBytes, setTakeBytes] = React.useState(0);
  /**
   * The upload's own state, spelled as the brief asks: recording, processing,
   * uploading, uploaded, failed. `busy` used to be a boolean, which is why
   * every one of those looked like the word "Uploading…".
   */
  const [phase, setPhase] = React.useState<"idle" | "processing" | "uploading" | "uploaded" | "failed">("idle");
  const [pct, setPct] = React.useState(0);
  /*
   * What storage will actually accept, asked for before the camera opens.
   *
   * A Supabase project has a global upload limit — 50 MB by default — and no
   * bucket may exceed it, so the ceiling this recorder would like is not
   * necessarily the one that applies. Discovering it at upload time meant
   * discovering it after the interview.
   */
  const [limits, setLimits] = React.useState<{ maxBytes: number; maxSeconds: number }>({
    maxBytes: MEDIA_KINDS.question_video.maxBytes,
    maxSeconds: RECORDING_CONSTRAINTS.maxSeconds,
  });

  const monitorRef = React.useRef<HTMLVideoElement>(null);
  const reviewRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const audioRecRef = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const audioChunks = React.useRef<Blob[]>([]);
  const blobRef = React.useRef<Blob | null>(null);
  const audioBlobRef = React.useRef<Blob | null>(null);
  const tick = React.useRef<ReturnType<typeof setInterval> | null>(null);
  /** What the last attempt was trying to do, so Retry does not need the camera. */
  const pendingRef = React.useRef<{ blob: Blob; audio: Blob | null; fileName: string; source: "recorded" | "uploaded" } | null>(null);

  const busy = phase === "processing" || phase === "uploading";
  const supported = typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const canPause = supported && typeof MediaRecorder.prototype.pause === "function";

  React.useEffect(() => {
    if (s.surveyDbId === "sandbox") return;
    let live = true;
    void (async () => {
      try {
        const r = await fetch(`/api/surveys/${s.surveyDbId}/media/ticket`);
        const j = await r.json().catch(() => ({}));
        if (live && r.ok && j?.video?.maxBytes) {
          setLimits({ maxBytes: j.video.maxBytes, maxSeconds: j.maxSeconds ?? j.video.maxSeconds });
        }
      } catch { /* the constants are a sane fallback, and the server still judges */ }
    })();
    return () => { live = false; };
  }, [s.surveyDbId]);

  const stopTick = () => { if (tick.current) { clearInterval(tick.current); tick.current = null; } };
  const dropStream = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  React.useEffect(() => () => { stopTick(); dropStream(); if (takeUrl) URL.revokeObjectURL(takeUrl); }, [takeUrl]);

  /** Turn the camera on and show what it sees, before anything is recorded. */
  const openPreview = async (nextCam?: string, nextMic?: string) => {
    setNote(null);
    setPhase("idle");
    if (!supported) { setNote("This browser cannot record video. You can still upload a file or paste a URL."); return; }
    dropStream();
    try {
      const cam = nextCam ?? camId;
      const mic = nextMic ?? micId;
      /*
       * 720p at 30fps, asked for as `ideal` rather than `exact`: a camera
       * that cannot do it should give its closest mode, not refuse to open.
       * This single constraint is most of the fix — an unconstrained 1080p
       * stream is four times the pixels and roughly three times the bytes.
       */
      const video: MediaTrackConstraints = {
        width: { ideal: RECORDING_CONSTRAINTS.video.width },
        height: { ideal: RECORDING_CONSTRAINTS.video.height },
        frameRate: { ideal: RECORDING_CONSTRAINTS.video.frameRate },
      };
      if (cam) video.deviceId = { exact: cam };
      const stream = await navigator.mediaDevices.getUserMedia({
        video,
        audio: mic ? { deviceId: { exact: mic } } : true,
      });
      streamRef.current = stream;
      if (monitorRef.current) { monitorRef.current.srcObject = stream; void monitorRef.current.play().catch(() => {}); }
      setMode("preview");
      /* labels are blank until permission is granted, so the list is read
         AFTER the first getUserMedia rather than before it */
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices({ cams: all.filter((d) => d.kind === "videoinput"), mics: all.filter((d) => d.kind === "audioinput") });
    } catch {
      setNote("No camera or microphone was available, or permission was refused. Allow access in your browser and try again.");
      setMode("idle");
    }
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream) return;
    chunks.current = [];
    audioChunks.current = [];
    stage("recording_started", { questionId: q.id });

    const rec = new MediaRecorder(stream, {
      ...pickMime(),
      videoBitsPerSecond: RECORDING_CONSTRAINTS.videoBitsPerSecond,
      audioBitsPerSecond: RECORDING_CONSTRAINTS.audioBitsPerSecond,
    });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    rec.onstop = () => {
      stopTick();
      /*
       * The chunk array is released as soon as the take is assembled. Keeping
       * both — which is what happened before — meant a five-minute recording
       * was resident twice over for no reason at all.
       */
      const blob = new Blob(chunks.current, { type: rec.mimeType || "video/webm" });
      chunks.current = [];
      blobRef.current = blob;
      setTakeBytes(blob.size);
      stage("recording_completed", { questionId: q.id, bytes: blob.size, seconds: secs });
      stage("blob_created", { questionId: q.id, bytes: blob.size });
      setTakeUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
      setMode("review");
      dropStream();
    };

    /*
     * The audio companion. A second recorder over the same microphone track,
     * at a bitrate chosen so that even a ten-minute take stays well under
     * what a transcription service will read.
     */
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length && typeof MediaStream !== "undefined") {
      try {
        const aRec = new MediaRecorder(new MediaStream(audioTracks), {
          ...pickAudioMime(),
          audioBitsPerSecond: RECORDING_CONSTRAINTS.answerAudioBitsPerSecond,
        });
        aRec.ondataavailable = (e) => { if (e.data.size) audioChunks.current.push(e.data); };
        aRec.onstop = () => {
          const a = new Blob(audioChunks.current, { type: aRec.mimeType || "audio/webm" });
          audioChunks.current = [];
          audioBlobRef.current = a.size ? a : null;
          if (a.size) stage("audio_extracted", { questionId: q.id, bytes: a.size });
        };
        audioRecRef.current = aRec;
        aRec.start(RECORDING_CONSTRAINTS.timesliceMs);
      } catch {
        /* a browser that will not give us a second recorder still records the
           video; the transcript then reads the video itself, size permitting */
        audioRecRef.current = null;
      }
    }

    recRef.current = rec;
    /* a timeslice, so nothing is held for the whole take */
    rec.start(RECORDING_CONSTRAINTS.timesliceMs);
    setSecs(0);
    setMode("recording");
    setPhase("idle");
    tick.current = setInterval(() => {
      setSecs((n) => {
        const next = n + 1;
        /* stop on its own rather than let a forgotten recorder run for an hour */
        if (next >= limits.maxSeconds) { stopBoth(); setNote(`Recording stopped at ${clock(limits.maxSeconds)}, which is the longest take this project's storage accepts.`); }
        return next;
      });
    }, 1000);
  };

  const stopBoth = () => {
    const r = recRef.current;
    const a = audioRecRef.current;
    if (a && a.state !== "inactive") a.stop();
    if (r && r.state !== "inactive") r.stop();
  };

  const pause = () => { recRef.current?.pause(); audioRecRef.current?.pause(); stopTick(); setMode("paused"); };
  const resume = () => {
    recRef.current?.resume(); audioRecRef.current?.resume();
    setMode("recording");
    tick.current = setInterval(() => setSecs((n) => n + 1), 1000);
  };
  const stop = () => stopBoth();

  const discardTake = () => {
    blobRef.current = null;
    audioBlobRef.current = null;
    pendingRef.current = null;
    setTakeBytes(0);
    setPct(0);
    setPhase("idle");
    setTakeUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setMode("idle");
  };

  /**
   * Put one object into storage and confirm it.
   *
   * The bytes go to a signed URL, direct from here. Nothing about this
   * request passes through the application, which is the whole reason a
   * recording longer than twenty seconds can now be saved at all.
   */
  const putOne = async (
    kind: MediaKind,
    blob: Blob,
    fileName: string,
    extra: { durationSeconds?: number; width?: number; height?: number; source?: string },
  ): Promise<{ mediaId: string; video?: InterviewVideo; transcriptStatus?: TranscriptStatus | null }> => {
    const limit = withinLimit(kind, blob.size, kind === "question_video" ? limits.maxBytes : undefined);
    if (!limit.ok) throw new Error(limit.message);

    const ticketRes = await fetch(`/api/surveys/${s.surveyDbId}/media/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, questionId: q.id, fileName, mimeType: blob.type, bytes: blob.size, ...extra }),
    });
    const ticket = await ticketRes.json().catch(() => ({}));
    if (!ticketRes.ok || !ticket?.uploadUrl) throw new Error(ticket?.error ?? `The upload could not be opened (${ticketRes.status}).`);
    stage("upload_url_issued", { questionId: q.id, kind, mediaId: ticket.mediaId });

    stage("upload_started", { questionId: q.id, kind, mediaId: ticket.mediaId, bytes: blob.size });
    const put = await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { "content-type": blob.type || "application/octet-stream", "x-upsert": "false" },
      body: blob,
    });
    if (!put.ok) throw new Error(`The recording could not be uploaded (${put.status}). Your take is still here — press Retry.`);
    stage("upload_completed", { questionId: q.id, kind, mediaId: ticket.mediaId });

    const confirmRes = await fetch(`/api/surveys/${s.surveyDbId}/media/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaId: ticket.mediaId, questionId: q.id, bytes: blob.size, ...extra }),
    });
    const confirmed = await confirmRes.json().catch(() => ({}));
    if (!confirmRes.ok) throw new Error(confirmed?.error ?? `The recording did not reach storage (${confirmRes.status}).`);
    stage("storage_confirmed", { questionId: q.id, kind, mediaId: ticket.mediaId });
    return { mediaId: ticket.mediaId, video: confirmed.video, transcriptStatus: confirmed.transcriptStatus ?? null };
  };

  /** Store the take (or an uploaded file) and write it onto the question. */
  const save = async (blob: Blob, audio: Blob | null, fileName: string, source: "recorded" | "uploaded") => {
    pendingRef.current = { blob, audio, fileName, source };
    setPhase("processing");
    setNote(null);
    setPct(0);
    try {
      const duration = await probeDuration(blob);
      const seconds = duration.seconds ?? (source === "recorded" && secs > 0 ? secs : undefined);
      /*
       * SANDBOX: no survey row, so no bucket to write to. The clip lives as
       * an object URL for the length of the session — enough to build and
       * preview the question, and honestly labelled as not saved.
       */
      if (s.surveyDbId === "sandbox") {
        patchSettings({
          interviewVideo: {
            url: URL.createObjectURL(blob), mimeType: blob.type || "video/webm", bytes: blob.size,
            durationSeconds: seconds, width: duration.width, height: duration.height,
            recordedAt: new Date().toISOString(), source, status: "ready", fileName,
          } as InterviewVideo,
        });
        setNote("Saved for this sandbox session only — a real project stores the file.");
        discardTake();
        return;
      }

      setPhase("uploading");
      setPct(10);
      const main = await putOne("question_video", blob, fileName, {
        durationSeconds: seconds, width: duration.width, height: duration.height, source,
      });
      setPct(70);

      /*
       * The audio companion, and with it the transcription job. A failure
       * here is not a failure of the recording: the video is stored, the
       * question is fieldable, and the transcript can be retried. So it is
       * caught rather than thrown.
       */
      let audioMediaId: string | undefined;
      let transcriptStatus: TranscriptStatus | undefined;
      if (audio && audio.size) {
        try {
          const companion = await putOne("question_audio", audio, fileName.replace(/\.[^.]+$/, "") + ".webm", { durationSeconds: seconds });
          audioMediaId = companion.mediaId;
          transcriptStatus = (companion.transcriptStatus ?? "waiting") as TranscriptStatus;
        } catch (e) {
          setNote(`The video is saved. The audio for the transcript could not be stored (${(e as Error).message}) — you can retry the transcript below.`);
        }
      }
      setPct(100);

      patchSettings({
        interviewVideo: {
          ...(main.video as InterviewVideo),
          mediaId: main.mediaId,
          audioMediaId,
          transcriptStatus,
        } as InterviewVideo,
      });
      /*
       * The take this one replaces. Removed only once the new one is stored,
       * so a failure anywhere above leaves the researcher with a video rather
       * than with neither. Every take used to be kept forever: the path is
       * timestamped and nothing ever deleted one.
       */
      const replaced = [current?.mediaId, current?.audioMediaId].filter((x): x is string => !!x);
      if (replaced.length) void removeMediaIds(replaced);
      setPhase("uploaded");
      pendingRef.current = null;
      if (audioMediaId) void kickTranscript(audioMediaId);
      discardTake();
    } catch (e) {
      setPhase("failed");
      setNote((e as Error).message || "The video could not be saved.");
    }
  };

  /** Delete objects by id, best-effort — a storage hiccup must not block an edit. */
  const removeMediaIds = async (ids: string[]) => {
    if (s.surveyDbId === "sandbox" || !ids.length) return;
    try {
      await fetch(`/api/surveys/${s.surveyDbId}/media/remove`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaIds: ids }),
      });
    } catch { /* the survey-delete sweep is the backstop */ }
  };

  /**
   * Delete the stored recording, not merely the reference to it.
   *
   * By question rather than by id, so that takes from earlier attempts go
   * too. "Delete" that leaves a 50 MB file in the bucket is not a delete.
   */
  const removeCurrent = async () => {
    patchSettings({ interviewVideo: undefined });
    if (s.surveyDbId === "sandbox") return;
    try {
      await fetch(`/api/surveys/${s.surveyDbId}/media/remove`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: q.id }),
      });
    } catch { /* the survey-delete sweep is the backstop */ }
  };

  /** Start the transcription now rather than waiting for the first poll. */
  const kickTranscript = async (mediaId: string) => {
    try {
      await fetch(`/api/surveys/${s.surveyDbId}/media/transcript`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaId }),
      });
    } catch { /* the poller will drive it instead */ }
  };

  /** Try the same take again, without asking the researcher to re-record it. */
  const retryUpload = () => {
    const p = pendingRef.current;
    if (!p) return;
    void save(p.blob, p.audio, p.fileName, p.source);
  };

  const onPick = async (f: File | undefined) => {
    if (!f) return;
    if (!/^video\//.test(f.type)) { setNote(`“${f.name}” is ${f.type || "an unknown type"} — please choose a video file.`); return; }
    const limit = withinLimit("question_video", f.size, limits.maxBytes);
    if (!limit.ok) { setNote(limit.message!); return; }
    await save(f, null, f.name, "uploaded");
  };

  return (
    <div className="iv-recorder" data-testid="iv-recorder">
      {/* ------------------------------------------------- what is stored now */}
      {current?.url && mode === "idle" && (
        <div className="iv-current" data-testid="iv-current">
          <video src={current.url} controls preload="metadata" data-testid="iv-current-video" />
          <div className="iv-meta mono" data-testid="iv-meta">
            {current.durationSeconds ? `${clock(current.durationSeconds)} · ` : ""}
            {current.bytes ? `${mb(current.bytes)} · ` : ""}
            {(current.mimeType ?? "video").replace("video/", "")}
            {current.width && current.height ? ` · ${current.width}×${current.height}` : ""}
            {current.source === "recorded" ? " · recorded here" : current.source === "url" ? " · external link" : " · uploaded"}
          </div>
          {/*
            Proof that the file is really in storage, without showing anybody a
            bucket path. "Stored" here means a row said so after listing the
            object — not that a browser reported success.
          */}
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span className={`chip ${current.mediaId ? "ok" : "warn"}`} data-testid="iv-stored">
              {current.mediaId ? "Stored" : current.url.startsWith("blob:") ? "This session only" : "External link"}
            </span>
            {current.recordedAt && <span className="muted" style={{ fontSize: 12 }}>saved {new Date(current.recordedAt).toLocaleString()}</span>}
          </div>
          <TranscriptPanel q={q} patchSettings={patchSettings} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small" data-testid="iv-rerecord" onClick={() => void openPreview()}>Re-record</button>
            <label className="btn small" style={{ cursor: "pointer" }}>
              Replace with a file
              <input type="file" accept="video/*" hidden data-testid="iv-replace"
                onChange={(e) => void onPick(e.target.files?.[0])} />
            </label>
            <button className="btn small danger" data-testid="iv-delete"
              onClick={() => void removeCurrent()}>Delete</button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- recording */}
      {(mode === "preview" || mode === "recording" || mode === "paused") && (
        <div className="iv-stage" data-testid="iv-stage">
          <video ref={monitorRef} muted playsInline data-testid="iv-monitor" />
          {mode === "preview" && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="f" style={{ minWidth: 160 }}><span>Camera</span>
                <select className="select" data-testid="iv-camera" value={camId}
                  onChange={(e) => { setCamId(e.target.value); void openPreview(e.target.value, undefined); }}>
                  <option value="">Default camera</option>
                  {devices.cams.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Camera"}</option>)}
                </select></label>
              <label className="f" style={{ minWidth: 160 }}><span>Microphone</span>
                <select className="select" data-testid="iv-mic" value={micId}
                  onChange={(e) => { setMicId(e.target.value); void openPreview(undefined, e.target.value); }}>
                  <option value="">Default microphone</option>
                  {devices.mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Microphone"}</option>)}
                </select></label>
            </div>
          )}
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            {mode === "preview" && (
              <>
                <button className="btn primary" data-testid="iv-start" onClick={startRecording}>● Start recording</button>
                <button className="btn" data-testid="iv-cancel" onClick={() => { dropStream(); setMode("idle"); }}>Cancel</button>
              </>
            )}
            {(mode === "recording" || mode === "paused") && (
              <>
                <span className="chip warn mono" data-testid="iv-elapsed">
                  {mode === "paused" ? "paused" : "●"} {clock(secs)} / {clock(limits.maxSeconds)}
                </span>
                {canPause && (mode === "recording"
                  ? <button className="btn" data-testid="iv-pause" onClick={pause}>Pause</button>
                  : <button className="btn" data-testid="iv-resume" onClick={resume}>Resume</button>)}
                <button className="btn primary" data-testid="iv-stop" onClick={stop}>Stop</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- review */}
      {mode === "review" && takeUrl && (
        <div className="iv-stage" data-testid="iv-review">
          <video ref={reviewRef} src={takeUrl} controls playsInline data-testid="iv-take" />
          <div className="iv-meta mono" data-testid="iv-take-meta">{clock(secs)} · {mb(takeBytes)}</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" data-testid="iv-save" disabled={busy}
              onClick={() => blobRef.current && void save(blobRef.current, audioBlobRef.current, "question.webm", "recorded")}>
              {busy ? PHASE_SAY[phase] : "Use this take"}
            </button>
            <button className="btn" data-testid="iv-retake" disabled={busy} onClick={() => void openPreview()}>Record again</button>
            <button className="btn" data-testid="iv-discard" disabled={busy} onClick={discardTake}>Discard</button>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------- empty state */}
      {!current?.url && mode === "idle" && (
        <div className="iv-empty" data-testid="iv-empty">
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
            Record the question yourself, or upload one you already have. Without a video this
            question cannot be fielded. Takes up to {clock(limits.maxSeconds)} are stored.
          </p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary" data-testid="iv-open-camera" disabled={!supported || busy}
              onClick={() => void openPreview()}>🎥 Record a video</button>
            <label className="btn" style={{ cursor: busy ? "default" : "pointer" }}>
              Upload a file
              <input type="file" accept="video/*" hidden data-testid="iv-upload" disabled={busy}
                onChange={(e) => void onPick(e.target.files?.[0])} />
            </label>
          </div>
          {!supported && (
            <div className="chip warn" style={{ marginTop: 8 }} data-testid="iv-unsupported">
              This browser cannot record video — upload a file instead.
            </div>
          )}
        </div>
      )}

      {/*
        One chip, five words. The brief asks the researcher to be able to tell
        recording from processing from uploading from stored from failed, and
        a boolean called `busy` could only ever say one of them.
      */}
      {phase !== "idle" && (
        <div className={`chip ${phase === "failed" ? "warn" : phase === "uploaded" ? "ok" : ""}`} data-testid="iv-phase" data-phase={phase}>
          {PHASE_SAY[phase]}{phase === "uploading" && pct ? ` ${pct}%` : ""}
        </div>
      )}
      {phase === "failed" && pendingRef.current && (
        <button className="btn small" data-testid="iv-retry-upload" onClick={retryUpload}>
          Retry upload
        </button>
      )}
      {note && <div className="chip warn" data-testid="iv-note">{note}</div>}
    </div>
  );
}

const PHASE_SAY: Record<"idle" | "processing" | "uploading" | "uploaded" | "failed", string> = {
  idle: "",
  processing: "Processing…",
  uploading: "Uploading…",
  uploaded: "Uploaded",
  failed: "Upload failed",
};

/**
 * One line per stage, so that "it failed" has an answer.
 *
 * The same stage names the server logs, so a recording can be followed across
 * both halves by its media id.
 */
function stage(name: string, detail: Record<string, unknown>): void {
  try { console.info(`[rescript:media] ${name}`, JSON.stringify(detail)); } catch { /* never break a recording to log it */ }
}

/** The first container this browser will actually record. */
function pickMime(): MediaRecorderOptions {
  const want = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  for (const t of want) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(t)) return { mimeType: t };
  }
  return {};
}

/** The same, for the audio-only companion track. */
function pickAudioMime(): MediaRecorderOptions {
  const want = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const t of want) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(t)) return { mimeType: t };
  }
  return {};
}

/* ------------------------------------------------------------- transcript */

/**
 * What the transcription is doing, and the transcript once it is done.
 *
 * Polls only while the answer can still change on its own. A completed or
 * failed transcript is a settled fact and polling it forever would be a
 * request every two seconds for as long as the panel is open.
 */
function TranscriptPanel({ q, patchSettings }: Pick<VariantSettingsProps, "q" | "patchSettings">) {
  const s = useStudio();
  const video = q.settings.interviewVideo;
  const mediaId = video?.audioMediaId;
  const [status, setStatus] = React.useState<TranscriptStatus | null>((video?.transcriptStatus as TranscriptStatus) ?? null);
  const [text, setText] = React.useState<string | null>(video?.transcript ?? null);
  const [error, setError] = React.useState<string | null>(video?.transcriptError ?? null);
  const [working, setWorking] = React.useState(false);

  const read = React.useCallback(async () => {
    if (!mediaId || s.surveyDbId === "sandbox") return;
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/media/transcript?mediaId=${encodeURIComponent(mediaId)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.transcript) return;
      const t = j.transcript as { status: TranscriptStatus | null; text: string | null; error: string | null };
      setStatus(t.status);
      setText(t.text);
      setError(t.error);
      /*
       * A settled transcript is written back onto the question so that
       * reading it later needs no round trip, and so it travels with the
       * definition into versions, clones and exports.
       */
      if (t.status === "completed" || t.status === "failed") {
        patchSettings({
          interviewVideo: {
            ...(video as InterviewVideo),
            transcriptStatus: t.status,
            transcript: t.text ?? undefined,
            transcriptError: t.error ?? undefined,
          },
        });
      }
    } catch { /* a poll that fails keeps the last known state rather than blanking it */ }
  }, [mediaId, s.surveyDbId, patchSettings, video]);

  React.useEffect(() => {
    if (!mediaId) return;
    void read();
    if (!transcriptPending(status ?? undefined)) return;
    const t = setInterval(() => void read(), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, status]);

  const retry = async () => {
    if (!mediaId) return;
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/media/transcript`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error ?? `The transcription could not be started (${r.status}).`); return; }
      if (j?.transcript) { setStatus(j.transcript.status); setText(j.transcript.text); setError(j.transcript.error); }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (!mediaId) {
    if (!video?.url || video.url.startsWith("blob:")) return null;
    return (
      <div className="iv-transcript" data-testid="iv-transcript" data-status="none">
        <span className="muted" style={{ fontSize: 12 }}>
          No transcript for this video. Re-record it here and the audio is transcribed automatically.
        </span>
      </div>
    );
  }

  return (
    <div className="iv-transcript" data-testid="iv-transcript" data-status={status ?? "none"}>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <span className={`chip ${status === "completed" ? "ok" : status === "failed" ? "warn" : ""}`} data-testid="iv-transcript-status">
          {status ? TRANSCRIPT_SAY[status] : "Waiting to transcribe"}
        </span>
        {(status === "failed" || status === "completed") && (
          <button className="btn small" data-testid="iv-transcript-retry" disabled={working} onClick={() => void retry()}>
            {working ? "Working…" : status === "failed" ? "Retry transcription" : "Transcribe again"}
          </button>
        )}
      </div>
      {error && <div className="chip warn" data-testid="iv-transcript-error">{error}</div>}
      {text && (
        <p className="iv-transcript-text" data-testid="iv-transcript-text" style={{ fontSize: 13, margin: "6px 0 0", whiteSpace: "pre-wrap" }}>
          {text}
        </p>
      )}
    </div>
  );
}

/**
 * Duration and frame size, read from the blob before it is uploaded — so the
 * metadata the brief asks for is real rather than guessed server-side from a
 * byte count. A clip whose header the browser cannot read still uploads; the
 * fields are simply absent.
 */
function probeDuration(blob: Blob): Promise<{ seconds?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") { resolve({}); return; }
    const url = URL.createObjectURL(blob);
    const el = document.createElement("video");
    let settled = false;
    const done = (r: { seconds?: number; width?: number; height?: number }) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(r);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => done({
      seconds: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined,
      width: el.videoWidth || undefined,
      height: el.videoHeight || undefined,
    });
    el.onerror = () => done({});
    setTimeout(() => done({}), 4000);
    el.src = url;
  });
}

/* ------------------------------------------------------------- the settings */

function Check({ label, hint, checked, onChange, testId }: {
  label: string; hint?: string; checked: boolean; onChange(v: boolean): void; testId: string;
}) {
  return (
    <label className="f iv-check">
      <span className="row" style={{ gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={checked} data-testid={testId} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </span>
      {hint && <span className="muted" style={{ fontSize: 12, marginLeft: 24 }}>{hint}</span>}
    </label>
  );
}

registerVariantSettings("videointerview", (p) => {
  const { q, patchSettings } = p;
  const st = q.settings;
  /* the defaults are the qualitative ones, so an unset flag reads as ON —
     `!== false` rather than `=== true` everywhere it matters */
  const on = (v: boolean | undefined) => v !== false;
  const collectsNothing = st.saveAnswerAudio === false && st.saveTranscript === false;

  return (
    <>
      <h3 className="sec">The question you are asking</h3>
      <VideoRecorder {...p} />

      <h3 className="sec">Watching</h3>
      <Check testId="iv-require-watch" label="Must watch the whole clip before answering"
        hint="The reason this question type exists. Off turns it into an ordinary prompted voice answer."
        checked={on(st.requireWatch)} onChange={(v) => patchSettings({ requireWatch: v })} />
      <Check testId="iv-allow-seek" label="Allow skipping forward"
        hint="Off hides the drag handle entirely rather than fighting the respondent for it."
        checked={st.allowSeek === true} onChange={(v) => patchSettings({ allowSeek: v })} />
      <Check testId="iv-allow-replay" label="Allow watching again"
        checked={on(st.allowReplay)} onChange={(v) => patchSettings({ allowReplay: v })} />
      <Check testId="iv-show-progress" label="Show progress and time"
        checked={on(st.showProgress)} onChange={(v) => patchSettings({ showProgress: v })} />
      <Check testId="iv-autoplay" label="Try to start playing automatically"
        hint="Browsers refuse unmuted autoplay without a tap, so this is a preference — the Play button always works."
        checked={st.autoPlayVideo === true} onChange={(v) => patchSettings({ autoPlayVideo: v })} />

      <h3 className="sec">Their answer</h3>
      <Check testId="iv-require-answer" label="A spoken answer is required"
        checked={on(st.requireAudioAnswer)} onChange={(v) => patchSettings({ requireAudioAnswer: v })} />
      <div className="row">
        <label className="f" style={{ width: 150 }}><span>Shortest answer (sec)</span>
          <CountInput min={0} max={600} value={st.minAnswerSeconds}
            onChange={(v) => patchSettings({ minAnswerSeconds: v ?? undefined })} /></label>
        <label className="f" style={{ width: 150 }}><span>Longest answer (sec)</span>
          <CountInput min={5} max={1800} value={st.maxAnswerSeconds}
            onChange={(v) => patchSettings({ maxAnswerSeconds: v ?? undefined })} /></label>
        <label className="f" style={{ width: 150 }}><span>Re-records allowed</span>
          <CountInput min={0} max={20} value={st.maxRetakes}
            onChange={(v) => patchSettings({ maxRetakes: v ?? undefined })} /></label>
      </div>
      <Check testId="iv-allow-pause" label="Allow pausing while recording"
        checked={on(st.allowAnswerPause)} onChange={(v) => patchSettings({ allowAnswerPause: v })} />
      <Check testId="iv-review" label="Let them play their answer back before moving on"
        checked={on(st.reviewBeforeSubmit)} onChange={(v) => patchSettings({ reviewBeforeSubmit: v })} />

      <h3 className="sec">Transcription</h3>
      <Check testId="iv-transcribe" label="Write up the answer automatically"
        hint="Needs a transcription provider. Without one the recording is still kept — nothing about the interview breaks."
        checked={on(st.transcribeAnswer)} onChange={(v) => patchSettings({ transcribeAnswer: v })} />
      <div className="row">
        <label className="f" style={{ width: 170 }}><span>Language</span>
          <input className="input" data-testid="iv-language" placeholder="survey language"
            value={st.transcriptLanguage ?? ""}
            onChange={(e) => patchSettings({ transcriptLanguage: e.target.value || undefined })} /></label>
        <label className="f" style={{ width: 210 }}><span>Who sees the transcript</span>
          <select className="select" data-testid="iv-transcript-visibility"
            value={st.transcriptVisibility ?? "respondent"}
            onChange={(e) => patchSettings({ transcriptVisibility: e.target.value as never })}>
            <option value="hidden">Only the research team</option>
            <option value="respondent">Shown back to the respondent</option>
            <option value="editable">Respondent can correct it</option>
          </select></label>
      </div>
      <Check testId="iv-save-audio" label="Keep the recording"
        checked={on(st.saveAnswerAudio)} onChange={(v) => patchSettings({ saveAnswerAudio: v })} />
      <Check testId="iv-save-transcript" label="Keep the transcript"
        checked={on(st.saveTranscript)} onChange={(v) => patchSettings({ saveTranscript: v })} />

      {collectsNothing && (
        <div className="chip warn" data-testid="iv-collects-nothing">
          With both the recording and the transcript off, this question stores nothing a
          respondent said. Turn one of them back on.
        </div>
      )}
      {!q.settings.interviewVideo?.url && (
        <div className="chip warn" data-testid="iv-no-video">
          No video yet — record or upload the question above before fielding this survey.
        </div>
      )}
    </>
  );
});
