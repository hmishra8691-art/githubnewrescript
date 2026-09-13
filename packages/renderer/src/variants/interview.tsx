"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { liveSessionId } from "./upload";
import {
  foldWatchTick, interviewState, requiresWatch, requiresAudioAnswer, transcribes,
  savesAudio, allowsSeek, retakeLimit, videoCompleted, formatSeconds,
  type InterviewState,
} from "@rescript/engine";
import type { InterviewAnswer } from "@rescript/schema";

/**
 * THE VIDEO INTERVIEW — a researcher asks on camera, a respondent answers
 * out loud, and the recording is transcribed.
 *
 * ## Why this player is hand-built
 *
 * Every other media variant in this platform uses a native `<video controls>`
 * and accepts that a respondent can drag the scrubber. That is right for a
 * video rating — what matters there is the rating — and wrong here, where the
 * question is IN the clip and an unwatched clip means an answer to a question
 * that was never asked.
 *
 * Native controls cannot be partly disabled. `controlsList` is advisory,
 * Chrome-only and ignored in a picture-in-picture window; fighting a seek by
 * snapping the position back works but reads as a broken page. So the native
 * controls are off and the transport is drawn here: play, pause, a progress
 * bar with no handle, and — once the clip has finished — replay.
 *
 * ## Two locks, not one
 *
 * `video.currentTime >= duration - tolerance` is the brief's condition and is
 * not enough on its own: a programmatic jump to the end satisfies it and
 * fires `ended` just as honestly as watching does. So seconds are SUMMED FROM
 * PLAYBACK — a tick larger than a second and a half is a seek and adds
 * nothing — and `completed` requires both the end AND the seconds. The engine
 * owns that arithmetic (`foldWatchTick`), so the gate cannot be re-derived
 * differently here than it is in validation.
 *
 * ## Why the gate survives a refresh
 *
 * The watch record lives in the ANSWER, not in component state. A respondent
 * who refreshes mid-interview does not have to watch a two-minute clip again
 * — and equally cannot unlock the answer area by refreshing, because what is
 * restored is the same record that locked it. The video-rating variant keeps
 * its gate in `useState` and loses it on remount; that is a bug this type
 * cannot afford.
 *
 * ## Nothing here blocks on the network
 *
 * The recording is uploaded and transcribed by one call. If it fails, or
 * there is no provider, or the wallet refuses, the clip is kept where it can
 * be and the transcript is absent — never an interview that will not finish.
 */

const EMPTY: InterviewAnswer = {};

const answerOf = (p: QRProps): InterviewAnswer =>
  (p.value && typeof p.value === "object" && !Array.isArray(p.value) ? p.value : EMPTY) as InterviewAnswer;

const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** What the respondent is told, per state. One sentence, never a code. */
const SAY: Record<InterviewState, string> = {
  VIDEO_NOT_STARTED: "Please watch the whole clip before answering.",
  VIDEO_PLAYING: "Please watch the whole clip before answering.",
  VIDEO_COMPLETED: "Thanks — you can record your answer now.",
  WAITING_FOR_ANSWER: "Record your answer in your own words.",
  RECORDING: "Recording…",
  PROCESSING: "Saving your answer…",
  TRANSCRIBING: "Writing up what you said…",
  ANSWER_COMPLETED: "Your answer is saved.",
  ERROR: "Something went wrong.",
};

export function VideoInterview(p: QRProps) {
  const a = answerOf(p);
  const video = p.q.settings.interviewVideo;
  const ro = !!p.q.settings.readOnly;

  /* ---------------------------------------------------------- live state */

  const [playing, setPlaying] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [busy, setBusy] = React.useState<null | "uploading" | "transcribing">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [broken, setBroken] = React.useState(false);
  const [secs, setSecs] = React.useState(0);
  const [at, setAt] = React.useState(0);
  const [localUrl, setLocalUrl] = React.useState<string | null>(null);

  const vref = React.useRef<HTMLVideoElement>(null);
  const lastT = React.useRef(0);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const tick = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = React.useRef(0);
  const elapsed = React.useRef(0);

  const stopTick = () => { if (tick.current) { clearInterval(tick.current); tick.current = null; } };
  React.useEffect(() => () => {
    stopTick();
    recRef.current?.stream?.getTracks().forEach((t) => t.stop());
    if (localUrl) URL.revokeObjectURL(localUrl);
  }, [localUrl]);

  const gateOpen = broken || !requiresWatch(p.q) || videoCompleted(p.q, a);
  const state = interviewState(p.q, a, {
    playing, recording,
    uploading: busy === "uploading",
    transcribing: busy === "transcribing",
    error,
  });

  const patch = (next: Partial<InterviewAnswer>) => p.onChange({ ...a, ...next });

  /* ------------------------------------------------------------ the player */

  const duration = a.watch?.durationSeconds ?? video?.durationSeconds ?? 0;
  const pct = duration > 0 ? Math.min(100, (at / duration) * 100) : 0;

  const onTime = () => {
    const el = vref.current;
    if (!el) return;
    const pos = el.currentTime;
    setAt(pos);
    const delta = pos - lastT.current;
    lastT.current = pos;
    /* the engine decides what a tick means — a jump is a seek, not watching */
    patch({ watch: foldWatchTick(a.watch, { delta, position: pos, duration: el.duration || duration }) });
  };

  const onEnded = () => {
    const el = vref.current;
    setPlaying(false);
    if (!el) return;
    const d = el.duration || duration;
    patch({ watch: foldWatchTick(a.watch, { delta: 0, position: d, duration: d }) });
  };

  /*
   * A forward seek the respondent managed anyway — a keyboard shortcut, a
   * media-key, an extension. The position is put back and the attempt is
   * counted, so the watch record stays honest rather than silently
   * accumulating a completion nobody earned.
   */
  const onSeeking = () => {
    const el = vref.current;
    if (!el || allowsSeek(p.q) || !requiresWatch(p.q)) return;
    if (el.currentTime > lastT.current + 1.5) {
      el.currentTime = lastT.current;
      patch({ watch: { ...(a.watch ?? {}), seeks: (a.watch?.seeks ?? 0) + 1 } });
    }
  };

  const play = () => {
    const el = vref.current;
    if (!el) return;
    void el.play().then(() => setPlaying(true)).catch(() => setError("The clip could not be played. Please check your connection."));
  };
  const pausePlayback = () => { vref.current?.pause(); setPlaying(false); };
  const replay = () => {
    const el = vref.current;
    if (!el) return;
    el.currentTime = 0;
    lastT.current = 0;
    patch({ watch: { ...(a.watch ?? {}), replays: (a.watch?.replays ?? 0) + 1 } });
    play();
  };

  /* --------------------------------------------------------- the recorder */

  const limit = retakeLimit(p.q);
  const used = a.audio?.retakes ?? 0;
  const canRetake = !ro && used < limit;
  const maxSecs = p.q.settings.maxAnswerSeconds;
  const minSecs = p.q.settings.minAnswerSeconds;

  const upload = React.useCallback(async (blob: Blob, seconds: number, retakes: number) => {
    const sessionId = liveSessionId(p);
    const local = URL.createObjectURL(blob);
    setLocalUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return local; });

    /*
     * A PREVIEW KEEPS THE CLIP IN THE BROWSER. There is no session to attach
     * it to and no respondent whose data it is, so nothing is uploaded — the
     * object URL is the answer, and the programmer still sees the whole flow
     * work. The same rule the upload variants follow.
     */
    if (!sessionId) {
      patch({
        audio: { url: local, mimeType: blob.type || "audio/webm", bytes: blob.size, durationSeconds: seconds, recordedAt: new Date().toISOString(), retakes },
        transcript: { source: "none" },
      });
      return;
    }

    setBusy("uploading");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", blob, "answer.webm");
      form.append("sessionId", sessionId);
      form.append("questionId", p.q.id);
      form.append("durationSeconds", String(seconds));
      form.append("retakes", String(retakes));
      if (transcribes(p.q)) setBusy("transcribing");

      const r = await fetch("/api/session/transcribe", { method: "POST", body: form });
      if (!r.ok) {
        /*
         * The clip did not reach the server. This is the ONE failure the
         * respondent must be told about, because unlike a missing transcript
         * it cannot be repaired later — so it is said plainly, the local
         * recording is kept playable, and Try again is offered.
         */
        setError("Your recording could not be saved. Please check your connection and try again.");
        return;
      }
      const j = (await r.json()) as { audio?: Record<string, unknown> | null; transcript?: Record<string, unknown> };
      patch({
        audio: (j.audio as InterviewAnswer["audio"]) ?? { url: local, mimeType: blob.type, bytes: blob.size, durationSeconds: seconds, retakes },
        transcript: (j.transcript as InterviewAnswer["transcript"]) ?? { source: "none" },
      });
    } catch {
      setError("Your recording could not be saved. Please check your connection and try again.");
    } finally {
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.q.id, p.value]);

  const startRecording = async () => {
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Recording is not supported by this browser. Please try Chrome, Edge, Firefox or Safari.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      elapsed.current = 0;
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopTick();
        setRecording(false);
        setPaused(false);
        const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
        const seconds = Math.round(elapsed.current * 10) / 10;
        if (!blob.size) { setError("Nothing was recorded. Please try again."); return; }
        void upload(blob, seconds, a.audio ? used + 1 : 0);
      };
      recRef.current = rec;
      rec.start();
      startedAt.current = Date.now();
      setSecs(0);
      setRecording(true);
      setPaused(false);
      tick.current = setInterval(() => {
        elapsed.current += 0.25;
        setSecs(Math.floor(elapsed.current));
        if (maxSecs != null && elapsed.current >= maxSecs) stopRecording();
      }, 250);
    } catch {
      setError("No microphone was available, or permission was refused. Please allow microphone access and try again.");
    }
  };

  const pauseRecording = () => {
    const rec = recRef.current;
    if (!rec || rec.state !== "recording") return;
    rec.pause();
    stopTick();
    setPaused(true);
  };
  const resumeRecording = () => {
    const rec = recRef.current;
    if (!rec || rec.state !== "paused") return;
    rec.resume();
    setPaused(false);
    tick.current = setInterval(() => {
      elapsed.current += 0.25;
      setSecs(Math.floor(elapsed.current));
      if (maxSecs != null && elapsed.current >= maxSecs) stopRecording();
    }, 250);
  };
  const stopRecording = () => {
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    stopTick();
  };
  const discard = () => {
    setError(null);
    patch({ audio: undefined, transcript: undefined });
  };

  const tooShort = minSecs != null && (a.audio?.durationSeconds ?? 0) + 0.5 < minSecs && !!a.audio;

  /* ------------------------------------------------------------- rendering */

  const playbackUrl = a.audio?.url || localUrl || undefined;
  const transcriptText = a.transcript?.text ?? "";
  const showTranscript = p.q.settings.transcriptVisibility === "respondent" || p.q.settings.transcriptVisibility === "editable";
  const editableTranscript = p.q.settings.transcriptVisibility === "editable";

  return (
    <div className="rs-interview" data-testid="interview" data-state={state}>
      {/* ------------------------------------------------ the researcher's video */}
      {video?.url ? (
        <div className={`rs-iv-video${gateOpen ? " done" : ""}`} data-testid="interview-video">
          <video
            ref={vref}
            src={video.url}
            playsInline
            preload="metadata"
            /* no `controls`: the transport below is the whole interface, and
               a native scrub bar is exactly what this type cannot have */
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              if (el.duration > 0) patch({ watch: { ...(a.watch ?? {}), durationSeconds: el.duration } });
              if (p.q.settings.autoPlayVideo && !videoCompleted(p.q, a)) play();
            }}
            onTimeUpdate={onTime}
            onSeeking={onSeeking}
            onEnded={onEnded}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => setBroken(true)}
          />
          {broken && (
            <div className="rs-media-note" data-testid="interview-video-broken">
              This clip could not be played, so you can answer without watching it.
            </div>
          )}

          <div className="rs-iv-transport">
            {!videoCompleted(p.q, a) || !p.q.settings.allowReplay ? (
              <button type="button" className="btn" data-testid="interview-play"
                disabled={broken || ro}
                onClick={() => (playing ? pausePlayback() : play())}>
                {playing ? "Pause" : (a.watch?.started ? "Resume" : "Play")}
              </button>
            ) : (
              <button type="button" className="btn" data-testid="interview-replay" disabled={ro} onClick={replay}>
                Watch again
              </button>
            )}

            {p.q.settings.showProgress !== false && (
              <div className="rs-iv-bar" data-testid="interview-progress"
                role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
                aria-label="Video progress">
                {/* a bar, deliberately not an <input type="range"> — there is
                    nothing here to grab, which is the point */}
                <span style={{ width: `${pct}%` }} />
              </div>
            )}
            {p.q.settings.showProgress !== false && duration > 0 && (
              <span className="rs-iv-time mono">{clock(at)} / {clock(duration)}</span>
            )}
            {videoCompleted(p.q, a) && <span className="rs-iv-done" data-testid="interview-watched">✓ Watched</span>}
          </div>
        </div>
      ) : (
        <div className="rs-media-note" data-testid="interview-video-missing">
          No video recorded yet — record or upload the question in the editor.
        </div>
      )}

      {/* ------------------------------------------------------ the answer area */}
      <div className="rs-iv-answer">
        <div className="rs-iv-head">
          <span className="rs-iv-label">Your response</span>
          <span className="rs-iv-say" data-testid="interview-say">{error ?? SAY[state]}</span>
        </div>

        {!gateOpen ? (
          <div className="rs-iv-locked" data-testid="interview-locked">
            <span aria-hidden="true">🔒</span> Available once the clip has finished
          </div>
        ) : (
          <fieldset className="rs-iv-controls" disabled={ro} data-testid="interview-controls">
            {!a.audio && !recording && (
              <button type="button" className="btn primary" data-testid="interview-record"
                disabled={busy != null} onClick={startRecording}>
                🎤 Start recording
              </button>
            )}

            {recording && (
              <div className="rs-iv-live" data-testid="interview-recording">
                <span className="rs-iv-dot" aria-hidden="true" />
                <span className="mono" data-testid="interview-elapsed">{clock(secs)}</span>
                {maxSecs != null && <span className="muted">of {formatSeconds(maxSecs)}</span>}
                {p.q.settings.allowAnswerPause !== false && (
                  paused
                    ? <button type="button" className="btn" data-testid="interview-resume" onClick={resumeRecording}>Resume</button>
                    : <button type="button" className="btn" data-testid="interview-pause" onClick={pauseRecording}>Pause</button>
                )}
                <button type="button" className="btn primary" data-testid="interview-stop" onClick={stopRecording}>Stop</button>
              </div>
            )}

            {busy && (
              <div className="rs-iv-busy" data-testid="interview-busy">
                {busy === "uploading" ? "Saving your response…" : "Processing your response…"}
              </div>
            )}

            {a.audio && !recording && !busy && (
              <div className="rs-iv-saved" data-testid="interview-saved">
                {p.q.settings.reviewBeforeSubmit !== false && playbackUrl && (
                  <audio controls src={playbackUrl} data-testid="interview-playback" />
                )}
                {a.audio.durationSeconds != null && (
                  <span className="muted mono">{clock(a.audio.durationSeconds)}</span>
                )}
                {canRetake && (
                  <button type="button" className="btn" data-testid="interview-retake"
                    onClick={() => { discard(); }}>
                    Record again{limit < 99 ? ` (${limit - used} left)` : ""}
                  </button>
                )}
                {!canRetake && used >= limit && (
                  <span className="muted" data-testid="interview-no-retakes">No re-records left.</span>
                )}
              </div>
            )}

            {error && (
              <button type="button" className="btn" data-testid="interview-retry" onClick={startRecording}>
                Try again
              </button>
            )}

            {tooShort && (
              <div className="rs-iv-note" data-testid="interview-too-short">
                That was very short — please record at least {formatSeconds(minSecs!)}.
              </div>
            )}

            {a.transcript?.failed && a.audio && (
              <div className="rs-iv-note muted" data-testid="interview-no-transcript">
                Your recording is saved. We could not write it up automatically, which does not
                affect your answer.
              </div>
            )}

            {showTranscript && transcriptText && (
              <div className="rs-iv-transcript" data-testid="interview-transcript">
                <span className="rs-iv-label">What we heard</span>
                {editableTranscript ? (
                  <textarea
                    className="input" rows={4} value={transcriptText}
                    data-testid="interview-transcript-edit"
                    onChange={(e) => patch({ transcript: { ...(a.transcript ?? {}), text: e.target.value, source: "manual" } })}
                  />
                ) : (
                  <p>{transcriptText}</p>
                )}
              </div>
            )}
          </fieldset>
        )}
      </div>
    </div>
  );
}

registerVariantRenderer("videointerview", VideoInterview);
registerVariantRenderer("base:video_interview", VideoInterview);
