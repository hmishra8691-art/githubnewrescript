"use client";
import React from "react";
import {
  RecordingUploader, pickAudioMime, pickRecordingMime, type UploadState,
} from "@/lib/uploader";
import { expectedBytes, PERMISSION_SAY, permissionAdvice, RESPONSE_SAY } from "@rescript/interviews";

/**
 * THE CANDIDATE'S INTERVIEW.
 *
 * §9's eleven steps, in order, with one rule above all of them: **nobody is
 * told an answer is safe until the store has confirmed it.** The word "Saved"
 * appears in exactly one place in this file, and it is downstream of a
 * verification the server performed by asking the object store.
 *
 * ## What this screen is competing with
 *
 * A person about to be judged, usually on a phone, often on a connection that
 * is already carrying their own upload. So: one thing on screen at a time,
 * no navigation away from a take in progress, a clock they can see, and an
 * upload that has already half-finished by the time they stop talking.
 *
 * ## The pieces
 *
 *  1. a device check BEFORE the consent screen, because discovering a blocked
 *     microphone after agreeing to be recorded is a wasted step and a bad
 *     first impression;
 *  2. consent, whose text is snapshotted server-side;
 *  3. per question: read, optional thinking time, record, stop, verify;
 *  4. a finish the SERVER agrees to, having re-read the rows.
 *
 * Telemetry is collected throughout and flushed in batches. It is a courtesy
 * to whoever reviews this later and is never allowed to interrupt anything.
 */

type Phase = "loading" | "gate" | "devices" | "consent" | "question" | "done" | "error";

interface Question {
  responseId: string; questionId: string; code: string; position: number;
  prompt: string; guidance: string; kind: "video" | "audio" | "text";
  required: boolean; minSeconds: number | null; maxSeconds: number;
  maxRetries: number; thinkSeconds: number; status: string; retries: number;
}

interface StartReply {
  ok: boolean;
  interview: { id: string; status: string; candidateName: string | null; consentGivenAt: string | null; isTest: boolean };
  project: { name: string; instructions: string; consentText: string };
  questions: Question[];
  canRecord: boolean;
  error?: string;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function Interview({ token }: { token: string }) {
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [fatal, setFatal] = React.useState<string | null>(null);
  const [data, setData] = React.useState<StartReply | null>(null);
  const [index, setIndex] = React.useState(0);
  const [agreed, setAgreed] = React.useState(false);

  /* devices */
  const [camera, setCamera] = React.useState<"granted" | "denied" | "prompt" | "unavailable">("prompt");
  const [mic, setMic] = React.useState<"granted" | "denied" | "prompt" | "unavailable">("prompt");
  const streamRef = React.useRef<MediaStream | null>(null);
  const monitorRef = React.useRef<HTMLVideoElement>(null);

  /* recording */
  const [recording, setRecording] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [thinking, setThinking] = React.useState(0);
  const [upload, setUpload] = React.useState<UploadState | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const audioRecorderRef = React.useRef<MediaRecorder | null>(null);
  const uploaderRef = React.useRef<RecordingUploader | null>(null);
  const startedAtRef = React.useRef(0);
  const tickRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  /* telemetry, batched */
  const queue = React.useRef<{ kind: string; detail?: Record<string, unknown>; clientAt: string; responseId?: string }[]>([]);
  const tell = React.useCallback((kind: string, detail?: Record<string, unknown>) => {
    queue.current.push({ kind, detail, clientAt: new Date().toISOString() });
    if (queue.current.length > 30) void flush();
  }, []);
  const flush = React.useCallback(async () => {
    const events = queue.current.splice(0, queue.current.length);
    if (!events.length) return;
    try {
      await fetch("/api/candidate/telemetry", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, events }), keepalive: true,
      });
    } catch { /* never a reason a candidate sees anything */ }
  }, [token]);

  /* ------------------------------------------------------------- boot */

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/candidate/start", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const reply = (await res.json()) as StartReply;
        if (cancelled) return;
        if (!res.ok || !reply.ok) { setFatal(reply.error ?? "This interview could not be opened."); setPhase("gate"); return; }
        setData(reply);
        const first = reply.questions.findIndex((q) => q.status !== "stored" && q.status !== "skipped");
        setIndex(first < 0 ? Math.max(0, reply.questions.length - 1) : first);
        setPhase(reply.interview.consentGivenAt ? "devices" : "devices");
        setAgreed(!!reply.interview.consentGivenAt);
      } catch {
        if (!cancelled) { setFatal("We could not reach the server. Please check your connection and reload."); setPhase("gate"); }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  /* the browser's account of itself */
  React.useEffect(() => {
    const hidden = () => tell(document.hidden ? "visibility_hidden" : "visibility_visible");
    const blur = () => tell("window_blurred");
    const focus = () => tell("window_focused");
    const copy = () => tell("copy");
    const paste = () => tell("paste");
    const offline = () => { tell("network_offline"); void uploaderRef.current?.resume(); };
    const online = () => { tell("network_online"); void uploaderRef.current?.resume(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    document.addEventListener("copy", copy);
    document.addEventListener("paste", paste);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    tell("page_reloaded");
    const beat = setInterval(() => void flush(), 20_000);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("copy", copy);
      document.removeEventListener("paste", paste);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      clearInterval(beat);
      void flush();
    };
  }, [tell, flush]);

  /*
   * Leaving mid-take is the one thing worth interrupting somebody for. The
   * browser only honours this after an interaction, which a candidate who has
   * pressed Record has certainly had.
   */
  React.useEffect(() => {
    if (!recording && upload?.phase !== "uploading") return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recording, upload?.phase]);

  /* --------------------------------------------------------- devices */

  const openDevices = React.useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: true,
      });
      streamRef.current = stream;
      if (monitorRef.current) {
        monitorRef.current.srcObject = stream;
        monitorRef.current.muted = true;
        await monitorRef.current.play().catch(() => {});
      }
      setCamera(stream.getVideoTracks().length ? "granted" : "unavailable");
      setMic(stream.getAudioTracks().length ? "granted" : "unavailable");
      tell("camera_permission", { state: "granted" });
      tell("microphone_permission", { state: "granted" });
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () =>
          tell(track.kind === "video" ? "camera_lost" : "microphone_lost"));
      }
    } catch (e) {
      const name = (e as Error)?.name ?? "";
      const state = name === "NotFoundError" ? "unavailable" : "denied";
      setCamera(state); setMic(state);
      tell("camera_permission", { state });
    }
  }, [tell]);

  React.useEffect(() => () => {
    for (const t of streamRef.current?.getTracks() ?? []) t.stop();
  }, []);

  /* --------------------------------------------------------- consent */

  async function giveConsent() {
    const res = await fetch("/api/candidate/consent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, agreed: true }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok || !reply.ok) { setFatal(reply.error ?? "We could not record your agreement."); return; }
    setAgreed(true);
    setPhase("question");
  }

  /* ------------------------------------------------------- recording */

  const current = data?.questions[index] ?? null;

  async function startRecording() {
    if (!current || !streamRef.current) return;
    const mime = pickRecordingMime();
    const uploader = new RecordingUploader({
      token,
      responseId: current.responseId,
      mimeType: mime,
      estimatedBytes: expectedBytes(current.maxSeconds),
      onState: setUpload,
      onTelemetry: tell,
    });
    uploaderRef.current = uploader;
    try {
      await uploader.begin();
    } catch {
      return;   // the uploader has already set a message
    }

    const recorder = new MediaRecorder(streamRef.current, {
      mimeType: mime, videoBitsPerSecond: 900_000, audioBitsPerSecond: 96_000,
    });
    recorder.ondataavailable = (e) => { if (e.data.size) uploader.push(e.data); };
    recorderRef.current = recorder;

    /*
     * A SECOND, AUDIO-ONLY RECORDER over the same microphone track.
     *
     * That companion IS the audio extraction, and it is what gets sent to the
     * transcription provider — handing a provider that accepts 25 MB a 36 MB
     * video is how transcription silently stops working on long answers.
     * Doing it in the browser costs nothing because the track is already
     * there, and avoids ffmpeg in a serverless function.
     *
     * Wrapped, because a browser that refuses a second recorder must still
     * produce a video: losing the transcript is a degradation, losing the
     * answer is a failure.
     */
    try {
      const audioMime = pickAudioMime();
      const audio = new MediaRecorder(new MediaStream(streamRef.current.getAudioTracks()), {
        mimeType: audioMime, audioBitsPerSecond: 64_000,
      });
      audioRecorderRef.current = audio;
      audio.start(5000);
    } catch { audioRecorderRef.current = null; }

    recorder.start(5000);
    startedAtRef.current = Date.now();
    setElapsed(0);
    setRecording(true);
    tell("recording_started", { responseId: current.responseId, code: current.code });

    tickRef.current = setInterval(() => {
      const s = (Date.now() - startedAtRef.current) / 1000;
      setElapsed(s);
      if (s >= current.maxSeconds) void stopRecording();
    }, 250);
  }

  async function stopRecording() {
    if (!recorderRef.current || !current) return;
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    const seconds = (Date.now() - startedAtRef.current) / 1000;
    setRecording(false);
    tell("recording_stopped", { seconds: Math.round(seconds) });

    await new Promise<void>((resolve) => {
      const r = recorderRef.current!;
      r.onstop = () => resolve();
      try { r.stop(); } catch { resolve(); }
    });
    try { audioRecorderRef.current?.stop(); } catch { /* the video is the answer */ }

    if (current.minSeconds && seconds < current.minSeconds) {
      tell("recording_too_short", { seconds: Math.round(seconds), minimum: current.minSeconds });
      await uploaderRef.current?.abandon();
      setUpload({
        phase: "failed", progress: 0, partsDone: 0, partsTotal: 0, attempt: 0, mediaId: null,
        message: `That answer was ${fmt(seconds)} — this question asks for at least ${fmt(current.minSeconds)}. Please record again.`,
      });
      return;
    }

    const out = await uploaderRef.current?.finish(seconds);
    if (out?.ok) {
      setData((d) => d && ({
        ...d,
        questions: d.questions.map((q) =>
          q.responseId === current.responseId ? { ...q, status: "stored" } : q),
      }));
      tell("question_answered", { code: current.code, seconds: Math.round(seconds) });
    }
  }

  async function retake() {
    if (!current) return;
    await uploaderRef.current?.abandon();
    uploaderRef.current = null;
    setUpload(null);
    setElapsed(0);
    tell("recording_discarded", { code: current.code });
    setData((d) => d && ({
      ...d,
      questions: d.questions.map((q) =>
        q.responseId === current.responseId ? { ...q, status: "pending", retries: q.retries + 1 } : q),
    }));
  }

  function next() {
    setUpload(null);
    uploaderRef.current = null;
    setElapsed(0);
    setIndex((i) => Math.min((data?.questions.length ?? 1) - 1, i + 1));
  }

  async function finish() {
    await flush();
    const res = await fetch("/api/candidate/finish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok || !reply.ok) {
      const first = reply?.outstanding?.[0];
      setFatal(reply.error ?? "Some answers are still missing.");
      if (first) {
        const at = data?.questions.findIndex((q) => q.responseId === first.responseId) ?? -1;
        if (at >= 0) { setIndex(at); setFatal(`${reply.error} Let's go back to ${first.code}.`); }
      }
      return;
    }
    setPhase("done");
  }

  /* ------------------------------------------------------------ views */

  if (phase === "loading") {
    return <main className="wrap"><div className="card"><p className="muted">Opening your interview…</p></div></main>;
  }

  if (phase === "gate" || (fatal && !data)) {
    return (
      <main className="wrap">
        <div className="card">
          <h1>We could not open this interview</h1>
          <p data-testid="gate-error">{fatal}</p>
          <p className="muted small">
            If you believe this is a mistake, contact the company that invited you and ask them to send a new link.
          </p>
        </div>
      </main>
    );
  }

  if (!data) return null;

  if (phase === "done") {
    return (
      <main className="wrap">
        <div className="card" data-testid="interview-done">
          <h1>Thank you — that is everything</h1>
          <p>Your answers have been saved and sent to {data.project.name}.</p>
          <p className="muted small">You can close this page. There is nothing else to do.</p>
        </div>
      </main>
    );
  }

  /* ---- the device check, before anybody agrees to be recorded ---- */
  if (phase === "devices") {
    const ready = camera === "granted" && mic === "granted";
    return (
      <main className="wrap">
        <div className="card">
          <h1>{data.project.name}</h1>
          {data.interview.candidateName && <p className="muted">Hello {data.interview.candidateName}.</p>}
          {data.project.instructions && <p style={{ whiteSpace: "pre-wrap" }}>{data.project.instructions}</p>}
          <p className="muted small">
            {data.questions.length} question{data.questions.length === 1 ? "" : "s"}. You record each answer
            in turn, and can see exactly when each one has been saved.
          </p>
        </div>

        {!data.canRecord && (
          <div className="note bad" data-testid="cannot-record">
            This interview cannot accept recordings at the moment. Please contact the company that
            invited you — please do not record your answers until this is resolved, because we would
            not be able to keep them.
          </div>
        )}

        <div className="card">
          <h2>Check your camera and microphone</h2>
          <video ref={monitorRef} playsInline data-testid="monitor" style={{ aspectRatio: "16 / 9" }} />
          <div className="row" style={{ marginTop: 12 }}>
            <span className={`pill ${camera === "granted" ? "ok" : camera === "denied" ? "bad" : ""}`} data-testid="camera-state">
              Camera: {PERMISSION_SAY[camera]}
            </span>
            <span className={`pill ${mic === "granted" ? "ok" : mic === "denied" ? "bad" : ""}`} data-testid="mic-state">
              Microphone: {PERMISSION_SAY[mic]}
            </span>
          </div>
          {permissionAdvice("camera", camera) && (
            <p className="small muted" style={{ marginTop: 10 }}>{permissionAdvice("camera", camera)}</p>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn secondary" onClick={openDevices} data-testid="check-devices">
              {ready ? "Check again" : "Allow camera and microphone"}
            </button>
            <button
              className="btn" disabled={!ready || !data.canRecord}
              onClick={() => setPhase(agreed ? "question" : "consent")}
              data-testid="devices-continue"
            >Continue</button>
          </div>
        </div>
      </main>
    );
  }

  /* ---- consent ---- */
  if (phase === "consent") {
    return (
      <main className="wrap">
        <div className="card">
          <h1>Before you start</h1>
          <p style={{ whiteSpace: "pre-wrap" }} data-testid="consent-text">{data.project.consentText}</p>
          <label className="row" style={{ marginTop: 16, alignItems: "flex-start" }}>
            <input
              type="checkbox" style={{ width: 20, marginTop: 3 }} checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)} data-testid="consent-check"
            />
            <span className="grow" style={{ margin: 0, color: "inherit", fontSize: 15 }}>
              I have read this and I agree to be recorded.
            </span>
          </label>
          <button className="btn big" disabled={!agreed} onClick={giveConsent} data-testid="consent-continue">
            Start the interview
          </button>
        </div>
      </main>
    );
  }

  /* ---- the interview ---- */
  const q = current!;
  const done = data.questions.filter((x) => x.status === "stored" || x.status === "skipped").length;
  const stored = q.status === "stored";
  const last = index >= data.questions.length - 1;
  const busy = recording || upload?.phase === "uploading" || upload?.phase === "finishing" || upload?.phase === "waiting";

  return (
    <main className="wrap">
      <div className="steps" aria-label={`Question ${index + 1} of ${data.questions.length}`}>
        {data.questions.map((x, i) => (
          <i key={x.responseId} className={x.status === "stored" || x.status === "skipped" ? "done" : i === index ? "now" : ""} />
        ))}
      </div>
      <p className="tiny muted" data-testid="progress">
        Question {index + 1} of {data.questions.length} · {done} saved
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }} data-testid="question-code">{q.code}</h2>
          <span className="tiny muted">
            {q.required ? "Required" : "Optional"} · up to {fmt(q.maxSeconds)}
            {q.minSeconds ? ` · at least ${fmt(q.minSeconds)}` : ""}
          </span>
        </div>
        <p style={{ fontSize: 18, marginTop: 10 }} data-testid="question-prompt">{q.prompt}</p>
        {q.guidance && <p className="small muted">{q.guidance}</p>}
      </div>

      <div className="card">
        <video ref={monitorRef} playsInline muted data-testid="monitor" style={{ aspectRatio: "16 / 9" }} />

        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <span className="row" style={{ gap: 8 }}>
            {recording && <span className="dot live" />}
            <strong data-testid="clock">{fmt(elapsed)}</strong>
            <span className="tiny muted">of {fmt(q.maxSeconds)}</span>
          </span>
          <span className={`pill ${stored ? "ok" : upload?.phase === "failed" ? "bad" : ""}`} data-testid="answer-status">
            {stored ? RESPONSE_SAY.stored : upload ? uploadWord(upload) : RESPONSE_SAY.pending}
          </span>
        </div>

        {upload && upload.phase !== "idle" && (
          <div style={{ marginTop: 12 }}>
            <div className="bar"><i style={{ width: `${Math.round(upload.progress * 100)}%` }} /></div>
            <p className="tiny muted" style={{ marginTop: 6 }} data-testid="upload-detail">
              {upload.partsTotal > 1
                ? `${upload.partsDone} of ${upload.partsTotal} parts safely stored`
                : upload.phase === "stored" ? "Confirmed in storage" : "Sending"}
              {upload.message ? ` — ${upload.message}` : ""}
            </p>
          </div>
        )}

        {upload?.phase === "failed" && (
          <div className="note bad" style={{ marginTop: 12 }} data-testid="upload-failed">
            {upload.message ?? "Your answer could not be saved."}{" "}
            <button className="btn secondary" style={{ marginTop: 8 }}
              onClick={() => void uploaderRef.current?.resume()} data-testid="upload-retry">
              Try again
            </button>
          </div>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          {!recording && !stored && (
            <button className="btn big" onClick={startRecording} disabled={busy} data-testid="record">
              {q.retries > 0 ? "Record again" : "Start recording"}
            </button>
          )}
          {recording && (
            <button className="btn big" onClick={stopRecording} data-testid="stop">Stop and save</button>
          )}
          {stored && q.retries < q.maxRetries && (
            <button className="btn secondary" onClick={retake} data-testid="retake">
              Record again ({q.maxRetries - q.retries} left)
            </button>
          )}
          {stored && !last && <button className="btn" onClick={next} data-testid="next">Next question</button>}
          {stored && last && <button className="btn big" onClick={finish} data-testid="finish">Finish the interview</button>}
          {!q.required && !stored && !recording && (
            <button className="btn secondary" onClick={next} data-testid="skip">Skip this one</button>
          )}
        </div>

        {fatal && <p className="note warn" style={{ marginTop: 12 }} data-testid="inline-error">{fatal}</p>}
      </div>

      <p className="tiny muted">
        Your answer is only marked as saved once it has been confirmed in storage. If your connection
        drops, it will pick up where it left off rather than starting again.
      </p>
    </main>
  );
}

function uploadWord(s: UploadState): string {
  switch (s.phase) {
    case "preparing": return "Getting ready";
    case "uploading": return RESPONSE_SAY.uploading;
    case "waiting": return "Reconnecting";
    case "finishing": return "Confirming";
    case "stored": return RESPONSE_SAY.stored;
    case "failed": return RESPONSE_SAY.failed;
    default: return RESPONSE_SAY.pending;
  }
}
