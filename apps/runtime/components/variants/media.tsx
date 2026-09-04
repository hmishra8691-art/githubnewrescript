"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { StarRating } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { MediaEmbed } from "../Media";
import { resolveMediaUrl } from "@rescript/engine";
import { useOptions } from "./shared";
import { uploadFile, liveSessionId, filesOf, commitFiles, fmtSize, tooBig } from "./upload";

/**
 * Video / Audio family: Video Rating, Video Hotspot / Timeline, Watch-Time
 * Tracking and Audio Recording. The stimulus is always `settings.mediaUrl`
 * played by a plain `<video>` element — which happily plays an audio-only
 * source too, so an audio stimulus needs no second code path.
 *
 * Media that will not load is treated as a fact of the respondent's device,
 * never as a dead end: the controls stay, a note says the media is
 * unavailable, and any gate that depended on watching it opens. A respondent
 * whose network dropped a clip must still be able to finish the survey.
 */

/* ------------------------------------------------------------------ shared */

interface MediaHandlers {
  onLoadedMetadata?(el: HTMLVideoElement): void;
  onTimeUpdate?(el: HTMLVideoElement): void;
  onEnded?(el: HTMLVideoElement): void;
  onPlay?(el: HTMLVideoElement): void;
  onPause?(el: HTMLVideoElement): void;
  onSeeked?(el: HTMLVideoElement): void;
  onError?(): void;
}

/** The stimulus player, or a clear note when there is nothing to play. */
function Stimulus({
  p, vref, handlers,
}: { p: QRProps; vref: React.RefObject<HTMLVideoElement>; handlers: MediaHandlers }) {
  const url = p.q.settings.mediaUrl;
  if (!url) {
    return (
      <div className="rs-media-note" data-testid="media-missing">
        No media configured — set the video or audio URL in the editor.
      </div>
    );
  }
  /*
   * Playback tracking needs an HTML5 <video>. A YouTube / Vimeo / Drive link
   * is embedded through the shared resolver instead — it plays, but the
   * player's timeline is not observable from here, so the "must finish" gate
   * and the timestamps are unavailable and the editor is told so (lintCounts).
   */
  const media = resolveMediaUrl(url);
  if (media.kind === "embed") {
    return (
      <div data-testid="media-el-embed">
        <MediaEmbed url={url} className="rs-media-el" />
        <div className="rs-media-note rs-media-note-small">
          Embedded players cannot report playback position — use a direct .mp4 / .webm URL for timeline questions.
        </div>
      </div>
    );
  }
  if (media.kind === "unsupported") {
    return <div className="rs-media-note" data-testid="media-unsupported">{media.reason}</div>;
  }
  const h = (fn?: (el: HTMLVideoElement) => void) => (e: React.SyntheticEvent<HTMLVideoElement>) =>
    fn?.(e.currentTarget);
  return (
    <video
      ref={vref}
      className="rs-media-el"
      data-testid="media-el"
      src={url}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={h(handlers.onLoadedMetadata)}
      onTimeUpdate={h(handlers.onTimeUpdate)}
      onEnded={h(handlers.onEnded)}
      onPlay={h(handlers.onPlay)}
      onPause={h(handlers.onPause)}
      onSeeked={h(handlers.onSeeked)}
      onError={() => handlers.onError?.()}
    />
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mmss = (s: number) => {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

/* ------------------------------------------------------------ video rating */

/**
 * Video Rating — a clip, then a star rating (the `numeric` base type, so it
 * reports as any other rating scale). With `settings.requireComplete` the
 * stars stay disabled until the clip ends; the fieldset does the disabling,
 * so the buttons are genuinely inert rather than merely dimmed.
 */
export function VideoRating(p: QRProps) {
  const vref = React.useRef<HTMLVideoElement>(null);
  const [ended, setEnded] = React.useState(false);
  const [pct, setPct] = React.useState(0);
  const [broken, setBroken] = React.useState(false);

  const gate = !!p.q.settings.requireComplete && !!p.q.settings.mediaUrl && !broken;
  const locked = gate && !ended;

  return (
    <div className="rs-media">
      <Stimulus p={p} vref={vref} handlers={{
        onTimeUpdate: (el) => {
          if (el.duration > 0) setPct(Math.min(100, Math.round((el.currentTime / el.duration) * 100)));
          // some browsers never fire `ended` when the last frame is dropped
          if (el.duration > 0 && el.currentTime >= el.duration - 0.25) setEnded(true);
        },
        onEnded: () => { setEnded(true); setPct(100); },
        onError: () => setBroken(true),
      }} />
      {broken && (
        <div className="rs-media-note" data-testid="media-broken">
          This clip could not be played on your device — please answer as best you can.
        </div>
      )}
      {locked && (
        <div className="rs-media-note" data-testid="rating-locked">
          Watch to the end to rate — {pct}% watched
        </div>
      )}
      <fieldset className="rs-media-rate" disabled={locked} data-testid="rating-fieldset">
        <StarRating {...p} />
      </fieldset>
    </div>
  );
}

/* ---------------------------------------------------------- video timeline */

interface Mark { t: number; code?: string | number }

function readMarks(v: unknown): Mark[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((m) => {
      const o = m as { t?: unknown; code?: unknown };
      const t = Number(o?.t);
      return Number.isFinite(t) ? { t: round1(t), ...(o.code == null ? {} : { code: o.code as string | number }) } : null;
    })
    .filter((m): m is Mark => m != null)
    .sort((a, b) => a.t - b.t);
}

/**
 * Video Hotspot / Annotation — reactions pinned to moments of the clip
 * (`media_timeline`: `{t, code?}[]`, always sorted by time). Two modes:
 * `tap` is one big React button, `options` offers the question's options.
 * Every reaction also appears as a marker on the strip under the video —
 * click it to jump back there, × to take it back.
 */
export function VideoTimeline(p: QRProps) {
  const options = useOptions(p);
  const vref = React.useRef<HTMLVideoElement>(null);
  const [dur, setDur] = React.useState(0);
  const [at, setAt] = React.useState(0);
  const [broken, setBroken] = React.useState(false);
  const marks = readMarks(p.value);
  const mode = p.q.settings.timelineMode ?? (options.length > 0 ? "options" : "tap");
  const ro = !!p.q.settings.readOnly;

  const span = dur > 0 ? dur : Math.max(1, ...marks.map((m) => m.t + 1));
  const add = (code?: string | number) => {
    if (ro) return;
    const t = round1(vref.current?.currentTime ?? at);
    p.onChange([...marks, code == null ? { t } : { t, code }].sort((a, b) => a.t - b.t));
  };
  const remove = (i: number) => {
    const next = marks.filter((_, j) => j !== i);
    p.onChange(next.length ? next : null);
  };
  const seek = (t: number) => { if (vref.current) vref.current.currentTime = t; };
  const labelOf = (m: Mark) => {
    const o = options.find((x) => String(x.code) === String(m.code));
    return o ? o.label.replace(/<[^>]*>/g, "") : "Reaction";
  };

  return (
    <div className="rs-media">
      <Stimulus p={p} vref={vref} handlers={{
        onLoadedMetadata: (el) => setDur(Number.isFinite(el.duration) ? el.duration : 0),
        onTimeUpdate: (el) => setAt(el.currentTime),
        onError: () => setBroken(true),
      }} />
      {broken && (
        <div className="rs-media-note" data-testid="media-broken">
          This clip could not be played on your device — you can still leave reactions.
        </div>
      )}

      <div className="rs-tl-strip" data-testid="timeline-strip">
        <div className="rs-tl-played" style={{ width: `${span ? Math.min(100, (at / span) * 100) : 0}%` }} />
        {marks.map((m, i) => (
          <button key={`${m.t}-${i}`} type="button"
            className="rs-tl-mark"
            style={{ left: `${Math.min(100, (m.t / span) * 100)}%` }}
            data-mark={i}
            data-t={m.t}
            data-code={m.code == null ? "" : String(m.code)}
            title={`${labelOf(m)} at ${mmss(m.t)} — click to jump here`}
            aria-label={`${labelOf(m)} at ${mmss(m.t)} — jump here`}
            onClick={() => seek(m.t)}>
            <span aria-hidden>▾</span>
          </button>
        ))}
      </div>
      <div className="rs-tl-time">{mmss(at)} / {mmss(span)}</div>

      <div className="rs-tl-bar">
        {mode === "tap" || options.length === 0 ? (
          <button type="button" className="rs-btn rs-tl-react" disabled={ro}
            data-testid="timeline-react" onClick={() => add()}>
            React now
          </button>
        ) : (
          options.map((o) => (
            <button key={String(o.code)} type="button"
              className="rs-tl-opt" disabled={ro}
              data-code={String(o.code)}
              onClick={() => add(o.code)}>
              <span dangerouslySetInnerHTML={{ __html: o.label }} />
            </button>
          ))
        )}
      </div>

      {marks.length > 0 && (
        <ul className="rs-tl-list" data-testid="timeline-list">
          {marks.map((m, i) => (
            <li key={`${m.t}-${i}`} data-row={i}>
              <button type="button" className="rs-tl-jump" onClick={() => seek(m.t)}>{mmss(m.t)}</button>
              <span className="rs-tl-label">{labelOf(m)}</span>
              <button type="button" className="rs-tl-x" data-testid={`timeline-remove-${i}`}
                aria-label={`Remove the ${labelOf(m)} reaction at ${mmss(m.t)}`}
                onClick={() => remove(i)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- watch time */

/**
 * Video Watch-Time Tracking — passive telemetry, no input for the respondent
 * to fill in. Stored as the `numeric_list` fields `watched` (seconds actually
 * played, summed from playback rather than read off `currentTime`, so
 * scrubbing to the end does not count as watching), `duration`, `percent` and
 * `completed`.
 *
 * `settings.requireComplete` turns "watched to the end" into a validation
 * rule in the engine (validate.ts, media family block), so the runtime, the
 * preview and the inspector all agree about it.
 */
export function WatchTime(p: QRProps) {
  const vref = React.useRef<HTMLVideoElement>(null);
  const [broken, setBroken] = React.useState(false);
  const st = React.useRef({ watched: 0, lastT: 0, duration: 0, completed: 0, wroteAt: 0 });
  const [, force] = React.useReducer((n: number) => n + 1, 0);

  const write = (throttle: boolean) => {
    const s = st.current;
    const now = Date.now();
    if (throttle && now - s.wroteAt < 400) return;
    s.wroteAt = now;
    const duration = round1(s.duration);
    const watched = round1(duration > 0 ? Math.min(s.watched, duration) : s.watched);
    const percent = duration > 0 ? Math.min(100, Math.round((watched / duration) * 100)) : 0;
    p.onChange({ watched, duration, percent, completed: s.completed });
    force();
  };

  const vals = (p.value ?? {}) as Record<string, number>;
  const watched = Number(vals.watched ?? 0);
  const duration = Number(vals.duration ?? 0);
  const percent = Number(vals.percent ?? 0);

  return (
    <div className="rs-media">
      <Stimulus p={p} vref={vref} handlers={{
        onLoadedMetadata: (el) => {
          st.current.duration = Number.isFinite(el.duration) ? el.duration : 0;
          st.current.lastT = el.currentTime;
          // record a zero straight away: an unwatched clip is a finding, and
          // it keeps the fields present rather than half-missing
          write(false);
        },
        onPlay: (el) => { st.current.lastT = el.currentTime; },
        onSeeked: (el) => { st.current.lastT = el.currentTime; },
        onTimeUpdate: (el) => {
          const d = el.currentTime - st.current.lastT;
          // a jump bigger than a tick is a seek, not watching
          if (d > 0 && d < 1.5) st.current.watched += d;
          st.current.lastT = el.currentTime;
          if (!st.current.duration && Number.isFinite(el.duration)) st.current.duration = el.duration;
          write(true);
        },
        onPause: () => write(false),
        onEnded: (el) => {
          st.current.completed = 1;
          if (Number.isFinite(el.duration) && st.current.watched > el.duration) st.current.watched = el.duration;
          write(false);
        },
        onError: () => setBroken(true),
      }} />
      {broken && (
        <div className="rs-media-note" data-testid="media-broken">
          This clip could not be played on your device — please continue.
        </div>
      )}
      <div className="rs-wt-bar" aria-hidden>
        <div className="rs-wt-fill" style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <div className="rs-annot-status" data-testid="watch-status">
        Watched {watched}s of {duration || "?"}s ({percent}%)
        {Number(vals.completed) === 1 && <span className="rs-wt-done"> · complete ✓</span>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- audio recording */

/**
 * Audio Recording / Voice Response — MediaRecorder when the browser gives us
 * a microphone, and an audio file input when it does not (no device, refused
 * permission, an embedded webview that blocks capture). Either path stores
 * the `upload` base type's `{url, name, size, type}`, so a recording and an
 * uploaded voice memo are the same answer.
 */
export function AudioRecording(p: QRProps) {
  const saved = filesOf(p)[0];
  const [state, setState] = React.useState<"idle" | "recording" | "saving">("idle");
  const [secs, setSecs] = React.useState(0);
  const [note, setNote] = React.useState<string | null>(null);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const tick = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const ro = !!p.q.settings.readOnly;

  const stopTick = () => { if (tick.current) { clearInterval(tick.current); tick.current = null; } };
  React.useEffect(() => () => { stopTick(); recRef.current?.stream?.getTracks().forEach((t) => t.stop()); }, []);

  const store = async (blob: Blob, name: string) => {
    const big = tooBig(p, blob);
    if (big) { setNote(big); setState("idle"); return; }
    setState("saving");
    try {
      const up = await uploadFile(blob, { sessionId: liveSessionId(p), questionId: p.q.id, fileName: name });
      commitFiles(p, [{ ...up, name: up.name || name }]);
      setNote(null);
    } catch (e) {
      setNote((e as Error).message || "Could not save the recording.");
    } finally {
      setState("idle");
    }
  };

  const start = async () => {
    setNote(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setNote("Recording is not supported by this browser — please upload an audio file instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
        if (blob.size) void store(blob, "recording.webm");
        else { setState("idle"); setNote("Nothing was recorded — please try again."); }
      };
      recRef.current = rec;
      rec.start();
      setSecs(0);
      setState("recording");
      tick.current = setInterval(() => setSecs((s) => s + 1), 1000);
    } catch {
      setNote("No microphone available (or permission was refused) — please upload an audio file instead.");
    }
  };

  const stop = () => {
    stopTick();
    recRef.current?.stop();
    recRef.current = null;
  };

  return (
    <div className="rs-rec">
      {saved ? (
        <>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio className="rs-rec-play" controls src={saved.url} data-testid="audio-playback" />
          <div className="rs-up-actions">
            <span className="rs-up-size">{saved.name} · {fmtSize(saved.size)}</span>
            <button type="button" className="rs-btn secondary" disabled={ro}
              data-testid="audio-redo" onClick={() => commitFiles(p, [])}>Re-record</button>
          </div>
        </>
      ) : (
        <>
          <div className="rs-up-actions">
            {state === "recording" ? (
              <button type="button" className="rs-btn rs-rec-stop" data-testid="audio-stop" onClick={stop}>
                ■ Stop ({mmss(secs)})
              </button>
            ) : (
              <button type="button" className="rs-btn rs-rec-start" disabled={ro || state === "saving"}
                data-testid="audio-record" onClick={() => void start()}>
                ● {state === "saving" ? "Saving…" : "Record"}
              </button>
            )}
            <span className="rs-rec-or">or</span>
            <button type="button" className="rs-btn secondary" disabled={ro}
              onClick={() => inputRef.current?.click()}>Upload an audio file</button>
          </div>
          <input
            ref={inputRef}
            className="rs-up-input"
            type="file"
            accept={p.q.settings.accept ?? "audio/*"}
            disabled={ro}
            data-testid="audio-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void store(f, f.name || "recording");
            }}
          />
        </>
      )}
      {state === "recording" && <div className="rs-rec-live" data-testid="audio-live">Recording… {mmss(secs)}</div>}
      {note && <div className="rs-media-note" data-testid="audio-note">{note}</div>}
    </div>
  );
}

registerVariantRenderer("videorating", VideoRating);
registerVariantRenderer("videotimeline", VideoTimeline);
registerVariantRenderer("base:media_timeline", VideoTimeline);
registerVariantRenderer("watchtime", WatchTime);
registerVariantRenderer("audiorec", AudioRecording);
