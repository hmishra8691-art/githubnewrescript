"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { StarRating, EmojiRating, Slider } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { MediaEmbed } from "../Media";
import { resolveMediaUrl, videoList, watchFieldCode, answerKey, effectiveScale, type VideoClip } from "@rescript/engine";
import { useMediaHold } from "../mediaGate";
import { useOptions } from "./shared";
import { uploadFile, liveSessionId, filesOf, commitFiles, fmtSize, tooBig } from "./upload";
import { anchor } from "../authoring";

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

type Settings = QRProps["q"]["settings"];

const round1 = (n: number) => Math.round(n * 10) / 10;
const mmss = (s: number) => {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

/** A clip's title and description, above its player, when the programmer gave them. */
function ClipHead({ clip, index, count }: { clip: VideoClip; index: number; count: number }) {
  if (!clip.title && !clip.description && count < 2) return null;
  return (
    <div className="rs-clip-head" data-testid={`clip-head-${index}`}>
      <div className="rs-clip-title">{clip.title || `Video ${index + 1}`}</div>
      {clip.description && <div className="rs-clip-desc">{clip.description}</div>}
    </div>
  );
}

/**
 * THE PLAYER, AS THE PROGRAMMER SET IT UP (October 2026 review: "Show
 * Play/Pause Controls, Allow Fullscreen, Allow Volume Control, Autoplay, Show
 * Video Progress Bar, Allow Replay"; Video Hotspot "should have Auto-Play
 * enabled by default … subject to normal browser autoplay restrictions").
 *
 * With every control allowed it is the browser's own player, as before. Turn
 * any of them off and it draws its own small control bar instead, because the
 * native bar cannot hide its volume or progress. Autoplay tries with sound and,
 * where the browser refuses that, plays muted with a note — the browser's rule,
 * not ours. Replay off stops a finished clip from starting again.
 *
 * Media that will not load is treated as a fact of the respondent's device,
 * never as a dead end: a note says so, and any gate that depended on watching
 * it opens.
 */
function VideoPlayer({ clip, settings, vref, handlers, autoplayDefault, testid }: {
  clip: VideoClip | undefined; settings: Settings; vref: React.RefObject<HTMLVideoElement>;
  handlers: MediaHandlers; autoplayDefault?: boolean; testid?: string;
}) {
  const [playing, setPlaying] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  const [mutedForAutoplay, setMutedForAutoplay] = React.useState(false);
  const [ended, setEnded] = React.useState(false);
  const [t, setT] = React.useState(0);
  const [dur, setDur] = React.useState(0);
  const url = clip?.url;
  const autoplay = settings.autoPlayVideo ?? !!autoplayDefault;
  const controls = settings.playerControls !== false;
  const progress = settings.showProgress !== false;
  const fullscreen = settings.allowFullscreen !== false;
  const volume = settings.allowVolume !== false;
  const replay = settings.allowReplay !== false;
  const seek = settings.allowSeek !== false;
  const native = controls && progress && fullscreen && volume && seek;

  React.useEffect(() => {
    if (!autoplay || !url) return;
    const el = vref.current;
    if (!el) return;
    el.play().catch(() => {
      /* the browser refused sound without a gesture: play muted, and say so */
      el.muted = true;
      setMuted(true);
      el.play().then(() => setMutedForAutoplay(true)).catch(() => { /* not even muted — the Play control stays */ });
    });
  }, [autoplay, url]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const toggle = () => {
    const el = vref.current;
    if (!el) return;
    if (el.paused) {
      if (ended && !replay) return;
      void el.play().catch(() => {});
    } else el.pause();
  };
  return (
    <div className="rs-player" data-testid={testid ?? "media-player"} data-native={native ? "1" : "0"}
      data-autoplay={autoplay ? "1" : "0"}>
      <video
        ref={vref}
        className="rs-media-el"
        data-testid="media-el"
        src={url}
        controls={native}
        controlsList={fullscreen ? undefined : "nofullscreen"}
        disablePictureInPicture={!fullscreen || undefined}
        autoPlay={autoplay}
        muted={muted}
        playsInline
        preload="metadata"
        onClick={!native && controls ? toggle : undefined}
        onLoadedMetadata={(e) => { setDur(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0); handlers.onLoadedMetadata?.(e.currentTarget); }}
        onTimeUpdate={(e) => { setT(e.currentTarget.currentTime); handlers.onTimeUpdate?.(e.currentTarget); }}
        onEnded={(e) => { setEnded(true); setPlaying(false); handlers.onEnded?.(e.currentTarget); }}
        onPlay={(e) => {
          /* replay not allowed: a finished clip does not start again, from any control */
          if (ended && !replay) { e.currentTarget.pause(); return; }
          setPlaying(true); handlers.onPlay?.(e.currentTarget);
        }}
        onPause={(e) => { setPlaying(false); handlers.onPause?.(e.currentTarget); }}
        onSeeked={h(handlers.onSeeked)}
        onVolumeChange={(e) => { if (!volume && !mutedForAutoplay && e.currentTarget.volume !== 1) e.currentTarget.volume = 1; }}
        onError={() => handlers.onError?.()}
      />
      {!native && (
        <div className="rs-player-bar" data-testid="player-bar">
          {controls ? (
            <button type="button" className="rs-player-btn" data-testid="player-toggle"
              disabled={ended && !replay}
              aria-label={playing ? "Pause" : ended ? "Replay" : "Play"} onClick={toggle}>
              {playing ? "❚❚" : ended ? (replay ? "↻" : "✓") : "▶"}
            </button>
          ) : !playing && !ended && !autoplay ? (
            <button type="button" className="rs-player-btn" data-testid="player-start" aria-label="Play" onClick={toggle}>▶</button>
          ) : null}
          {progress && (
            seek ? (
              <input type="range" className="rs-player-seek" min={0} max={dur || 0} step={0.1} value={t}
                aria-label="Position" data-testid="player-seek"
                onChange={(e) => { const el = vref.current; if (el) el.currentTime = Number(e.target.value); }} />
            ) : (
              <div className="rs-player-progress" data-testid="player-progress" aria-hidden>
                <div style={{ width: `${dur ? Math.min(100, (t / dur) * 100) : 0}%` }} />
              </div>
            )
          )}
          {progress && <span className="rs-player-time">{mmss(t)} / {mmss(dur)}</span>}
          {volume && (
            <button type="button" className="rs-player-btn" data-testid="player-mute" aria-label={muted ? "Unmute" : "Mute"}
              onClick={() => { const el = vref.current; if (el) { el.muted = !el.muted; setMuted(el.muted); setMutedForAutoplay(false); } }}>
              {muted ? "🔇" : "🔊"}
            </button>
          )}
          {fullscreen && (
            <button type="button" className="rs-player-btn" data-testid="player-fullscreen" aria-label="Full screen"
              onClick={() => { void vref.current?.requestFullscreen?.().catch(() => {}); }}>⛶</button>
          )}
        </div>
      )}
      {mutedForAutoplay && (
        <div className="rs-media-note rs-media-note-small" data-testid="autoplay-muted">
          Playing without sound — your browser only lets videos start on their own when muted. Tap 🔊 or the player to hear it.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ video rating */

/**
 * Video Rating — a clip, then a rating. The `numeric` base type, so it
 * reports as any other rating scale, whichever way it is drawn (October 2026
 * review: "Rating Type: Star Rating, Numeric Rating, Emoji/Smiley Rating,
 * Slider, Likert Scale … Labels … Required Response … Allow Additional
 * Comment"). With `settings.requireComplete` the rating stays disabled until
 * the clip ends; the fieldset does the disabling, so the controls are
 * genuinely inert rather than merely dimmed.
 */
export function VideoRating(p: QRProps) {
  const vref = React.useRef<HTMLVideoElement>(null);
  const [ended, setEnded] = React.useState(false);
  const [pct, setPct] = React.useState(0);
  const [broken, setBroken] = React.useState(false);
  const clip = videoList(p.q)[0];
  /*
   * Seconds actually watched, accumulated the way Watch-Time Tracking below
   * already does it: only small forward steps count, so dragging the scrubber
   * to the end does not earn the whole clip.
   */
  const watched = React.useRef({ total: 0, last: 0 });
  /*
   * A gate that cannot be measured is not applied: a YouTube / Vimeo embed
   * cannot report its position, and a clip that will not load cannot be
   * finished — the respondent must always be able to answer.
   */
  const embedded = resolveMediaUrl(clip?.url).kind === "embed";
  const gate = !!p.q.settings.requireComplete && !!clip?.url && !broken && !embedded;
  const locked = gate && !ended;
  const commentKey = `${answerKey(p.q.id, p.loop)}__comment`;
  const comment = p.state.answers[commentKey];

  return (
    <div className="rs-media">
      {clip && <ClipHead clip={clip} index={0} count={1} />}
      <VideoPlayer clip={clip} settings={p.q.settings} vref={vref} handlers={{
        onTimeUpdate: (el) => {
          const d = el.currentTime - watched.current.last;
          if (d > 0 && d < 1.5) watched.current.total += d;
          watched.current.last = el.currentTime;
          if (el.duration > 0) setPct(Math.min(100, Math.round((watched.current.total / el.duration) * 100)));
          // some browsers never fire `ended` when the last frame is dropped
          if (el.duration > 0 && el.currentTime >= el.duration - 0.25) setEnded(true);
        },
        onSeeked: (el) => { watched.current.last = el.currentTime; },
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
      <fieldset className="rs-media-rate" disabled={locked} data-testid="rating-fieldset"
        data-rating-type={p.q.settings.ratingType ?? "stars"}>
        <RatingInput p={p} />
      </fieldset>
      {p.q.settings.allowComment && (
        <label className="rs-rate-comment" data-testid="rating-comment">
          <span>{p.q.settings.commentPrompt || "What did you think about this video?"}</span>
          <textarea className="rs-textarea" disabled={locked || !!p.q.settings.readOnly}
            placeholder="Enter your response…"
            value={typeof comment === "string" ? comment : ""}
            onChange={(e) => p.onExtraChange?.("comment", e.target.value === "" ? null : e.target.value)} />
        </label>
      )}
    </div>
  );
}

/**
 * The rating, drawn the way `ratingType` says. The answer is the same number
 * every way; the end labels are `sliderLeftLabel` / `sliderRightLabel`, one
 * pair whichever control shows them.
 */
function RatingInput({ p }: { p: QRProps }) {
  const type = p.q.settings.ratingType ?? "stars";
  const left = p.q.settings.sliderLeftLabel;
  const right = p.q.settings.sliderRightLabel;
  const labels = (left || right) ? (
    <div className="rs-nps-labels" data-testid="rating-labels"><span>{left}</span><span>{right}</span></div>
  ) : null;
  if (type === "stars") return <div className="rs-rate-wrap"><StarRating {...p} />{labels}</div>;
  if (type === "emoji") {
    const q = { ...p.q, settings: { ...p.q.settings, npsLeftLabel: left, npsRightLabel: right } };
    return <EmojiRating {...p} q={q as typeof p.q} />;
  }
  if (type === "slider") return <Slider {...p} />;
  const { min, max } = effectiveScale(p.q, { min: 1, max: 10 });
  const points = Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i);
  if (type === "numeric") {
    return (
      <div className="rs-nps-wrap" data-testid="rating-numeric">
        <div className="rs-nps">
          {points.map((n) => (
            <span key={n} className="rs-nps-point">
              <button type="button" {...anchor("scalepoint", n)} className={String(p.value) === String(n) ? "selected" : ""}
                onClick={() => p.onChange(n)}>{n}</button>
            </span>
          ))}
        </div>
        {labels}
      </div>
    );
  }
  /* likert: a labelled point per step — its own label where the programmer gave one, else the ends' */
  return (
    <div className="rs-likert" role="radiogroup" data-testid="rating-likert">
      {points.map((n, i) => {
        const lab = p.q.settings.scalePointLabels?.[String(n)] ?? (i === 0 ? left : i === points.length - 1 ? right : undefined);
        const sel = String(p.value) === String(n);
        return (
          <label key={n} className={`rs-likert-point ${sel ? "selected" : ""}`} {...anchor("scalepoint", n)}>
            <input type="radio" name={`${p.q.id}-likert`} checked={sel} onChange={() => p.onChange(n)} />
            <span className="rs-likert-n">{n}</span>
            {lab && <span className="rs-likert-lab">{lab}</span>}
          </label>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------- video timeline */

interface Mark { t: number; code?: string | number; v?: number }

function readMarks(v: unknown): Mark[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((m) => {
      const o = m as { t?: unknown; code?: unknown; v?: unknown };
      const t = Number(o?.t);
      const vi = Number(o?.v);
      return Number.isFinite(t)
        ? { t: round1(t), ...(o.code == null ? {} : { code: o.code as string | number }), ...(Number.isFinite(vi) && vi > 0 ? { v: vi } : {}) }
        : null;
    })
    .filter((m): m is Mark => m != null)
    .sort((a, b) => (a.v ?? 0) - (b.v ?? 0) || a.t - b.t);
}

/**
 * Video Hotspot / Annotation — reactions pinned to moments of a clip
 * (`media_timeline`: `{t, code?, v?}[]`). Two modes: `tap` is one big React
 * button, `options` offers the question's options.
 *
 * SEVERAL CLIPS (October 2026 review: "+ Add Video … each video should have
 * its own hotspot/annotation configuration"). Each clip has its own reactions
 * (`videos[i].reactions`, all of them when unset) and its own strip; a
 * reaction records which clip it was made on in `v` (absent for the first,
 * so every answer collected before reads the same). Auto-play is on by
 * default here, and "Require Complete Video Watch" holds the page's Next
 * button until every clip has finished — independently of Required.
 */
export function VideoTimeline(p: QRProps) {
  const options = useOptions(p);
  const clips = videoList(p.q);
  const [active, setActive] = React.useState(0);
  const [ended, setEnded] = React.useState<Set<number>>(() => new Set());
  const [broken, setBroken] = React.useState<Set<number>>(() => new Set());
  const marks = readMarks(p.value);
  const ro = !!p.q.settings.readOnly;
  const n = Math.max(1, clips.length);
  const unobservable = (i: number) => broken.has(i) || resolveMediaUrl(clips[i]?.url).kind === "embed" || !clips[i]?.url;
  const finished = Array.from({ length: n }, (_, i) => i).every((i) => ended.has(i) || unobservable(i));
  useMediaHold(`watch:${p.q.id}`, !!p.q.settings.requireComplete && !finished,
    n > 1 ? "Please watch every video to the end to continue." : "Please watch the video to the end to continue.");

  return (
    <div className="rs-media" data-testid="timeline">
      {n > 1 && (
        <div className="rs-clip-tabs" role="tablist" data-testid="clip-tabs">
          {clips.map((c, i) => (
            <button key={i} type="button" role="tab" aria-selected={active === i}
              className={`rs-clip-tab ${active === i ? "on" : ""}`} data-testid={`clip-tab-${i}`}
              onClick={() => setActive(i)}>
              {c.title || `Video ${i + 1}`}{ended.has(i) ? " ✓" : ""}
            </button>
          ))}
        </div>
      )}
      {Array.from({ length: n }, (_, i) => i).map((i) => (
        <div key={i} hidden={active !== i} data-testid={`clip-${i}`}>
          <TimelineClip p={p} clip={clips[i]} index={i} count={n} options={options} ro={ro}
            marks={marks} active={active === i}
            onEnded={() => setEnded((s) => new Set([...s, i]))}
            onBroken={() => setBroken((s) => new Set([...s, i]))} />
        </div>
      ))}
      {p.q.settings.requireComplete && !finished && (
        <div className="rs-media-note" data-testid="watch-required">
          {n > 1 ? `Watch every video to the end to continue — ${ended.size} of ${n} done.` : "Watch the video to the end to continue."}
        </div>
      )}
    </div>
  );
}

function TimelineClip({ p, clip, index, count, options: all, ro, marks: allMarks, active, onEnded, onBroken }: {
  p: QRProps; clip: VideoClip | undefined; index: number; count: number; options: ReturnType<typeof useOptions>;
  ro: boolean; marks: Mark[]; active: boolean; onEnded(): void; onBroken(): void;
}) {
  const vref = React.useRef<HTMLVideoElement>(null);
  const [dur, setDur] = React.useState(0);
  const [at, setAt] = React.useState(0);
  const [broken, setBroken] = React.useState(false);
  const allowed = clip?.reactions?.length ? new Set(clip.reactions.map(String)) : null;
  const options = allowed ? all.filter((o) => allowed.has(String(o.code))) : all;
  const mode = p.q.settings.timelineMode ?? (options.length > 0 ? "options" : "tap");
  const mine = allMarks.filter((m) => (m.v ?? 0) === index);
  /* only the clip on screen plays by itself: the first one on arrival, each next one when it is opened */
  const settings = { ...p.q.settings, autoPlayVideo: active ? p.q.settings.autoPlayVideo : false };

  const span = dur > 0 ? dur : Math.max(1, ...mine.map((m) => m.t + 1));
  const add = (code?: string | number) => {
    if (ro) return;
    const t = round1(vref.current?.currentTime ?? at);
    const mark: Mark = { t, ...(code == null ? {} : { code }), ...(index > 0 ? { v: index } : {}) };
    p.onChange(readMarks([...allMarks, mark]));
  };
  const remove = (m: Mark) => {
    const i = allMarks.indexOf(m);
    const next = allMarks.filter((_, j) => j !== i);
    p.onChange(next.length ? next : null);
  };
  const seek = (t: number) => { if (vref.current) vref.current.currentTime = t; };
  const labelOf = (m: Mark) => {
    const o = all.find((x) => String(x.code) === String(m.code));
    return o ? o.label.replace(/<[^>]*>/g, "") : "Reaction";
  };

  return (
    <>
      {clip && <ClipHead clip={clip} index={index} count={count} />}
      <VideoPlayer clip={clip} settings={settings} vref={vref} autoplayDefault={active} testid={`media-player-${index}`} handlers={{
        onLoadedMetadata: (el) => setDur(Number.isFinite(el.duration) ? el.duration : 0),
        onTimeUpdate: (el) => {
          setAt(el.currentTime);
          if (el.duration > 0 && el.currentTime >= el.duration - 0.25) onEnded();
        },
        onEnded: () => onEnded(),
        onError: () => { setBroken(true); onBroken(); },
      }} />
      {broken && (
        <div className="rs-media-note" data-testid="media-broken">
          This clip could not be played on your device — you can still leave reactions.
        </div>
      )}

      <div className="rs-tl-strip" data-testid="timeline-strip">
        <div className="rs-tl-played" style={{ width: `${span ? Math.min(100, (at / span) * 100) : 0}%` }} />
        {mine.map((m, i) => (
          <button key={`${m.t}-${i}`} type="button"
            className="rs-tl-mark"
            style={{ left: `${Math.min(100, (m.t / span) * 100)}%` }}
            data-mark={i}
            data-t={m.t}
            data-code={m.code == null ? "" : String(m.code)} {...anchor("option", m.code == null ? "" : String(m.code))}
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
              data-code={String(o.code)} {...anchor("option", String(o.code))}
              onClick={() => add(o.code)}>
              <span dangerouslySetInnerHTML={{ __html: o.label }} />
            </button>
          ))
        )}
      </div>

      {mine.length > 0 && (
        <ul className="rs-tl-list" data-testid="timeline-list">
          {mine.map((m, i) => (
            <li key={`${m.t}-${i}`} data-row={i} {...anchor("row", i)}>
              <button type="button" className="rs-tl-jump" onClick={() => seek(m.t)}>{mmss(m.t)}</button>
              <span className="rs-tl-label">{labelOf(m)}</span>
              <button type="button" className="rs-tl-x" data-testid={`timeline-remove-${i}`}
                aria-label={`Remove the ${labelOf(m)} reaction at ${mmss(m.t)}`}
                onClick={() => remove(m)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/* ------------------------------------------------------------- watch time */

/**
 * Video Watch-Time Tracking — passive telemetry, no input for the respondent
 * to fill in. Stored as fixed `numeric_list` fields per clip — `watched`
 * (seconds actually played, summed from playback rather than read off
 * `currentTime`, so scrubbing to the end does not count as watching),
 * `duration`, `percent`, `completed`, and `…_2`, `…_3` for further clips
 * (engine `watchTimeRows`). The builder does not show these fields: they are
 * the system's (October 2026 review).
 *
 * `settings.requireComplete` turns "watched to the end" into a validation
 * rule in the engine, for every clip, so the runtime, the preview and the
 * inspector all agree about it.
 */
export function WatchTime(p: QRProps) {
  const clips = videoList(p.q);
  const n = Math.max(1, clips.length);
  const vals = (p.value ?? {}) as Record<string, number>;
  /* one shared object, so each clip's write keeps the others' fields */
  const latest = React.useRef<Record<string, number>>({ ...vals });
  latest.current = { ...vals, ...latest.current };
  const write = (fields: Record<string, number>) => {
    latest.current = { ...latest.current, ...fields };
    p.onChange({ ...latest.current });
  };
  return (
    <div className="rs-media" data-testid="watchtime">
      {Array.from({ length: n }, (_, i) => i).map((i) => (
        <WatchClip key={i} p={p} clip={clips[i]} index={i} count={n} vals={vals} write={write} />
      ))}
    </div>
  );
}

function WatchClip({ p, clip, index, count, vals, write }: {
  p: QRProps; clip: VideoClip | undefined; index: number; count: number;
  vals: Record<string, number>; write(fields: Record<string, number>): void;
}) {
  const vref = React.useRef<HTMLVideoElement>(null);
  const [broken, setBroken] = React.useState(false);
  const st = React.useRef({ watched: 0, lastT: 0, duration: 0, completed: 0, wroteAt: 0 });
  const k = (f: string) => watchFieldCode(f, index);

  const emit = (throttle: boolean) => {
    const s = st.current;
    const now = Date.now();
    if (throttle && now - s.wroteAt < 400) return;
    s.wroteAt = now;
    const duration = round1(s.duration);
    const watched = round1(duration > 0 ? Math.min(s.watched, duration) : s.watched);
    const percent = duration > 0 ? Math.min(100, Math.round((watched / duration) * 100)) : 0;
    write({ [k("watched")]: watched, [k("duration")]: duration, [k("percent")]: percent, [k("completed")]: s.completed });
  };

  const watched = Number(vals[k("watched")] ?? 0);
  const duration = Number(vals[k("duration")] ?? 0);
  const percent = Number(vals[k("percent")] ?? 0);

  return (
    <div className="rs-watchclip" data-testid={`watch-clip-${index}`}>
      {clip && <ClipHead clip={clip} index={index} count={count} />}
      <VideoPlayer clip={clip} settings={{ ...p.q.settings, autoPlayVideo: index === 0 ? p.q.settings.autoPlayVideo : false }}
        vref={vref} testid={`media-player-${index}`} handlers={{
        onLoadedMetadata: (el) => {
          st.current.duration = Number.isFinite(el.duration) ? el.duration : 0;
          st.current.lastT = el.currentTime;
          // record a zero straight away: an unwatched clip is a finding, and
          // it keeps the fields present rather than half-missing
          emit(false);
        },
        onPlay: (el) => { st.current.lastT = el.currentTime; },
        onSeeked: (el) => { st.current.lastT = el.currentTime; },
        onTimeUpdate: (el) => {
          const d = el.currentTime - st.current.lastT;
          // a jump bigger than a tick is a seek, not watching
          if (d > 0 && d < 1.5) st.current.watched += d;
          st.current.lastT = el.currentTime;
          if (!st.current.duration && Number.isFinite(el.duration)) st.current.duration = el.duration;
          emit(true);
        },
        onPause: () => emit(false),
        onEnded: (el) => {
          st.current.completed = 1;
          if (Number.isFinite(el.duration) && st.current.watched > el.duration) st.current.watched = el.duration;
          emit(false);
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
      <div className="rs-annot-status" data-testid={index === 0 ? "watch-status" : `watch-status-${index}`}>
        Watched {watched}s of {duration || "?"}s ({percent}%)
        {Number(vals[k("completed")]) === 1 && <span className="rs-wt-done"> · complete ✓</span>}
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
