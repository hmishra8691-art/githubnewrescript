"use client";
import React from "react";
import type { InterviewVideo } from "@rescript/schema";
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
  const [busy, setBusy] = React.useState(false);
  const [takeUrl, setTakeUrl] = React.useState<string | null>(null);

  const monitorRef = React.useRef<HTMLVideoElement>(null);
  const reviewRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const blobRef = React.useRef<Blob | null>(null);
  const tick = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const supported = typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const canPause = supported && typeof MediaRecorder.prototype.pause === "function";

  const stopTick = () => { if (tick.current) { clearInterval(tick.current); tick.current = null; } };
  const dropStream = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  React.useEffect(() => () => { stopTick(); dropStream(); if (takeUrl) URL.revokeObjectURL(takeUrl); }, [takeUrl]);

  /** Turn the camera on and show what it sees, before anything is recorded. */
  const openPreview = async (nextCam?: string, nextMic?: string) => {
    setNote(null);
    if (!supported) { setNote("This browser cannot record video. You can still upload a file or paste a URL."); return; }
    dropStream();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: nextCam ?? camId ? { deviceId: { exact: nextCam ?? camId } } : true,
        audio: nextMic ?? micId ? { deviceId: { exact: nextMic ?? micId } } : true,
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
    const rec = new MediaRecorder(stream, pickMime());
    rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    rec.onstop = () => {
      stopTick();
      const blob = new Blob(chunks.current, { type: rec.mimeType || "video/webm" });
      blobRef.current = blob;
      setTakeUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
      setMode("review");
      dropStream();
    };
    recRef.current = rec;
    rec.start();
    setSecs(0);
    setMode("recording");
    tick.current = setInterval(() => setSecs((n) => n + 1), 1000);
  };

  const pause = () => { recRef.current?.pause(); stopTick(); setMode("paused"); };
  const resume = () => { recRef.current?.resume(); setMode("recording"); tick.current = setInterval(() => setSecs((n) => n + 1), 1000); };
  const stop = () => { const r = recRef.current; if (r && r.state !== "inactive") r.stop(); };

  const discardTake = () => {
    blobRef.current = null;
    setTakeUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setMode("idle");
  };

  /** Store the take (or an uploaded file) and write it onto the question. */
  const save = async (blob: Blob, fileName: string, source: "recorded" | "uploaded") => {
    setBusy(true);
    setNote(null);
    try {
      const duration = await probeDuration(blob);
      /*
       * SANDBOX: no survey row, so no bucket to write to. The clip lives as
       * an object URL for the length of the session — enough to build and
       * preview the question, and honestly labelled as not saved.
       */
      if (s.surveyDbId === "sandbox") {
        patchSettings({
          interviewVideo: {
            url: URL.createObjectURL(blob), mimeType: blob.type || "video/webm", bytes: blob.size,
            durationSeconds: duration.seconds, width: duration.width, height: duration.height,
            recordedAt: new Date().toISOString(), source, status: "ready", fileName,
          } as InterviewVideo,
        });
        setNote("Saved for this sandbox session only — a real project stores the file.");
        discardTake();
        return;
      }

      const form = new FormData();
      form.append("file", blob, fileName);
      form.append("questionId", q.id);
      form.append("source", source);
      if (duration.seconds) form.append("durationSeconds", String(duration.seconds));
      if (duration.width) form.append("width", String(duration.width));
      if (duration.height) form.append("height", String(duration.height));

      const r = await fetch(`/api/surveys/${s.surveyDbId}/media`, { method: "POST", body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.video) { setNote(j?.error ?? `The video could not be saved (${r.status}).`); return; }
      patchSettings({ interviewVideo: j.video as InterviewVideo });
      discardTake();
    } catch (e) {
      setNote((e as Error).message || "The video could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const onPick = async (f: File | undefined) => {
    if (!f) return;
    if (!/^video\//.test(f.type)) { setNote(`“${f.name}” is ${f.type || "an unknown type"} — please choose a video file.`); return; }
    await save(f, f.name, "uploaded");
  };

  return (
    <div className="iv-recorder" data-testid="iv-recorder">
      {/* ------------------------------------------------- what is stored now */}
      {current?.url && mode === "idle" && (
        <div className="iv-current" data-testid="iv-current">
          <video src={current.url} controls preload="metadata" data-testid="iv-current-video" />
          <div className="iv-meta mono">
            {current.durationSeconds ? `${clock(current.durationSeconds)} · ` : ""}
            {current.bytes ? `${mb(current.bytes)} · ` : ""}
            {(current.mimeType ?? "video").replace("video/", "")}
            {current.source === "recorded" ? " · recorded here" : current.source === "url" ? " · external link" : " · uploaded"}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small" data-testid="iv-rerecord" onClick={() => void openPreview()}>Re-record</button>
            <label className="btn small" style={{ cursor: "pointer" }}>
              Replace with a file
              <input type="file" accept="video/*" hidden data-testid="iv-replace"
                onChange={(e) => void onPick(e.target.files?.[0])} />
            </label>
            <button className="btn small danger" data-testid="iv-delete"
              onClick={() => patchSettings({ interviewVideo: undefined })}>Delete</button>
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
                <span className="chip warn mono" data-testid="iv-elapsed">{mode === "paused" ? "paused" : "●"} {clock(secs)}</span>
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
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" data-testid="iv-save" disabled={busy}
              onClick={() => blobRef.current && void save(blobRef.current, "question.webm", "recorded")}>
              {busy ? "Saving…" : "Use this take"}
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
            question cannot be fielded.
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

      {busy && <div className="chip" data-testid="iv-busy">Uploading…</div>}
      {note && <div className="chip warn" data-testid="iv-note">{note}</div>}
    </div>
  );
}

/** The first container this browser will actually record. */
function pickMime(): MediaRecorderOptions {
  const want = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  for (const t of want) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(t)) return { mimeType: t };
  }
  return {};
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
