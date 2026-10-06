"use client";
import React from "react";
import { MediaUrlInput } from "../MediaUrlInput";
import { resolveMediaUrl, videoList, watchTimeRows, type VideoClip } from "@rescript/engine";
import type { Question } from "@rescript/schema";
import { registerVariantSettings, type VariantSettingsProps } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the video / audio family — see docs/VARIANT-BATCH.md §4.
 *
 * Everything here hangs off one setting the three video variants share,
 * `settings.mediaUrl`, plus the gate (`requireComplete`) that decides whether
 * a respondent may answer before the clip has finished.
 */

/*
 * THE CLIPS (October 2026 review: "Video — Add Video, Upload Video / Video
 * URL, Video Title, Optional Video Description, Replace Video, Delete Video …
 * + Add Video"). Stored as `settings.videos`; `mediaUrl` is kept equal to the
 * first clip so everything that read the single URL before still finds it.
 */
function VideoListEditor({ q, patch, multiple, reactions, onCount }: VariantSettingsProps & {
  multiple: boolean;
  /** Video Hotspot: which reactions each clip offers */
  reactions?: boolean;
  /** called with the new clip list, for questions whose fields follow it (Watch-Time) */
  onCount?(clips: VideoClip[]): Partial<Question>;
}) {
  const clips: VideoClip[] = videoList(q).length ? videoList(q) : [{ url: "" }];
  const write = (next: VideoClip[]) => {
    const kept = next.length ? next : [{ url: "" }];
    patch({
      settings: { ...q.settings, videos: kept, mediaUrl: kept[0]?.url || undefined },
      ...(onCount ? onCount(kept) : {}),
    });
  };
  const set = (i: number, c: Partial<VideoClip>) => write(clips.map((x, j) => (j === i ? { ...x, ...c } : x)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= clips.length) return;
    const next = [...clips];
    [next[i], next[j]] = [next[j], next[i]];
    write(next);
  };
  return (
    <div data-testid="video-list">
      <h3 className="sec">{multiple ? "Videos" : "Video"}</h3>
      {clips.map((c, i) => (
        <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }} data-testid={`video-${i}`}>
          <div className="row" style={{ alignItems: "center", marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>{multiple ? `Video ${i + 1}` : "Clip"}</strong>
            <span className="spacer" />
            {multiple && clips.length > 1 && (
              <>
                <button type="button" className="btn small" onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                <button type="button" className="btn small" onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                <button type="button" className="btn small danger" data-testid={`video-remove-${i}`}
                  onClick={() => write(clips.filter((_, j) => j !== i))}>delete video</button>
              </>
            )}
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label className="f" style={{ minWidth: 220 }}><span>Video title</span>
              <input className="input" data-testid={`video-title-${i}`} placeholder="e.g. Product demo"
                value={c.title ?? ""} onChange={(e) => set(i, { title: e.target.value || undefined })} /></label>
            <label className="f grow" style={{ minWidth: 260 }}><span>Description (optional)</span>
              <input className="input" data-testid={`video-desc-${i}`}
                value={c.description ?? ""} onChange={(e) => set(i, { description: e.target.value || undefined })} /></label>
          </div>
          <MediaUrlInput label="Upload video / video URL" testId={`video-url-${i}`} accept={["video", "audio"]}
            placeholder="https://…/clip.mp4" value={c.url || undefined}
            onChange={(v) => set(i, { url: v ?? "" })} />
          {resolveMediaUrl(c.url).kind === "embed" && (
            <div className="chip warn" data-testid={`media-embed-warn-${i}`}>
              Embedded players (YouTube, Vimeo, Drive) cannot report playback position — autoplay, the
              “must finish” gate and timestamps need a direct .mp4 / .webm URL.
            </div>
          )}
          {reactions && q.options.length > 0 && (
            <div className="row" style={{ flexWrap: "wrap", gap: "4px 12px", marginTop: 6 }} data-testid={`video-reactions-${i}`}>
              <span className="muted" style={{ fontSize: 12.5 }}>Hotspots / reactions on this video:</span>
              {q.options.map((o) => {
                const on = !c.reactions || c.reactions.map(String).includes(String(o.code));
                return (
                  <label key={String(o.code)} className="row" style={{ gap: 4, fontSize: 13 }}>
                    <input type="checkbox" checked={on} data-testid={`video-reaction-${i}-${o.code}`}
                      onChange={(e) => {
                        const cur = c.reactions ? c.reactions.map(String) : q.options.map((x) => String(x.code));
                        const next = e.target.checked ? [...new Set([...cur, String(o.code)])] : cur.filter((x) => x !== String(o.code));
                        set(i, { reactions: next.length === q.options.length ? undefined : next });
                      }} />
                    <span dangerouslySetInnerHTML={{ __html: o.label }} />
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {multiple && (
        <button type="button" className="btn small" data-testid="video-add" onClick={() => write([...clips, { url: "" }])}>
          + Add video
        </button>
      )}
      {!clips.some((c) => c.url) && (
        <div className="chip warn" data-testid="media-no-url">Without a clip the respondent sees a note instead of a player.</div>
      )}
    </div>
  );
}

/*
 * PLAYBACK — the review's list: "Show Play/Pause Controls, Allow Fullscreen,
 * Allow Volume Control, Autoplay, Show Video Progress Bar, Allow Replay …
 * Require Video to Be Watched". Unset means allowed (and autoplay off, except
 * where the variant defaults it on), which is how every clip played before.
 */
function PlaybackSettings({ q, patchSettings, autoplayDefault, requireLabel }: VariantSettingsProps & {
  autoplayDefault: boolean; requireLabel: string;
}) {
  const box = (key: keyof Question["settings"], label: string, def: boolean, testid: string) => {
    const v = (q.settings as Record<string, unknown>)[key as string];
    const on = typeof v === "boolean" ? v : def;
    return (
      <label className="row" style={{ gap: 6, fontSize: 13 }}>
        <input type="checkbox" checked={on} data-testid={testid}
          /* the gate is stored as said, on or off, as it always was; the player's switches drop back to "unset" at their default */
          onChange={(e) => patchSettings({ [key]: key !== "requireComplete" && e.target.checked === def ? undefined : e.target.checked } as Partial<Question["settings"]>)} />
        {label}
      </label>
    );
  };
  return (
    <div data-testid="playback-settings">
      <h3 className="sec">Playback settings</h3>
      <div className="row" style={{ flexWrap: "wrap", gap: "6px 16px" }}>
        {box("autoPlayVideo", "auto-play video", autoplayDefault, "pb-autoplay")}
        {box("playerControls", "show play / pause controls", true, "pb-controls")}
        {box("showProgress", "show progress bar", true, "pb-progress")}
        {box("allowVolume", "allow volume control", true, "pb-volume")}
        {box("allowFullscreen", "allow full screen", true, "pb-fullscreen")}
        {box("allowReplay", "allow replay", true, "pb-replay")}
        {box("requireComplete", requireLabel, false, "media-require-complete")}
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Browsers only start a video on its own when it is muted; the player then says so and the respondent can turn the sound on.
      </p>
    </div>
  );
}

/* the rating types, and the range each can draw */
const RATING_TYPES: { value: string; label: string; max: number }[] = [
  { value: "stars", label: "Star rating", max: 10 },
  { value: "numeric", label: "Numeric rating (number buttons)", max: 10 },
  { value: "emoji", label: "Emoji / smiley rating", max: 10 },
  { value: "slider", label: "Slider", max: 10 },
  { value: "likert", label: "Likert scale (labelled points)", max: 10 },
];

registerVariantSettings("videorating", (p) => {
  const { q, patch, patchSettings } = p;
  const type = q.settings.ratingType ?? "stars";
  const min = q.settings.minValue ?? 1;
  const max = q.settings.maxValue ?? 5;
  const points = Array.from({ length: Math.max(0, Math.min(max, 10) - min + 1) }, (_, i) => min + i);
  return (
    <>
      <VideoListEditor {...p} multiple={false} />
      <p className="muted" style={{ fontSize: 12.5, marginTop: -2 }} data-testid="video-rating-one-clip">
        One clip per rating — the answer is a single score. To rate several clips, add one Video Rating per clip.
      </p>
      <h3 className="sec">Rating scale</h3>
      <div className="row" style={{ flexWrap: "wrap", gap: 12 }} data-testid="rating-scale">
        <label className="f" style={{ width: 240 }}><span>Rating type</span>
          <select className="select" data-testid="rating-type" value={type}
            onChange={(e) => patchSettings({ ratingType: e.target.value as never })}>
            {RATING_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select></label>
        <label className="f" style={{ width: 130 }}><span>{type === "stars" ? "Number of stars from" : "Minimum"}</span>
          <CountInput min={0} max={9} allowEmpty={false} value={min} data-testid="rating-min"
            onChange={(v) => patchSettings({ minValue: v ?? 1 })} /></label>
        <label className="f" style={{ width: 130 }}><span>{type === "stars" ? "to" : "Maximum"}</span>
          <CountInput min={1} max={10} allowEmpty={false} value={max} data-testid="rating-max"
            onChange={(v) => patchSettings({ maxValue: v ?? 5 })} /></label>
      </div>
      <h3 className="sec">Labels</h3>
      <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
        <label className="f" style={{ minWidth: 220 }}><span>Minimum / left label</span>
          <input className="input" data-testid="rating-left-label" placeholder="e.g. Very Poor"
            value={q.settings.sliderLeftLabel ?? ""} onChange={(e) => patchSettings({ sliderLeftLabel: e.target.value || undefined })} /></label>
        <label className="f" style={{ minWidth: 220 }}><span>Maximum / right label</span>
          <input className="input" data-testid="rating-right-label" placeholder="e.g. Excellent"
            value={q.settings.sliderRightLabel ?? ""} onChange={(e) => patchSettings({ sliderRightLabel: e.target.value || undefined })} /></label>
      </div>
      {type === "likert" && (
        <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 6 }} data-testid="likert-point-labels">
          {points.map((n) => (
            <label key={n} className="f" style={{ width: 130 }}><span>Point {n}</span>
              <input className="input" placeholder={n === min ? q.settings.sliderLeftLabel ?? "" : n === Math.min(max, 10) ? q.settings.sliderRightLabel ?? "" : ""}
                value={q.settings.scalePointLabels?.[String(n)] ?? ""}
                onChange={(e) => {
                  const next = { ...(q.settings.scalePointLabels ?? {}) };
                  if (e.target.value) next[String(n)] = e.target.value; else delete next[String(n)];
                  patchSettings({ scalePointLabels: Object.keys(next).length ? next : undefined });
                }} /></label>
          ))}
        </div>
      )}
      <h3 className="sec">Response settings</h3>
      <div className="row" style={{ flexWrap: "wrap", gap: "6px 16px" }} data-testid="rating-response">
        <label className="row" style={{ gap: 6, fontSize: 13 }}>
          <input type="checkbox" data-testid="rating-required" checked={!!q.required}
            onChange={(e) => patch({ required: e.target.checked })} />
          required response
        </label>
        <label className="row" style={{ gap: 6, fontSize: 13 }}>
          <input type="checkbox" data-testid="rating-allow-comment" checked={!!q.settings.allowComment}
            onChange={(e) => patchSettings({ allowComment: e.target.checked || undefined })} />
          allow additional comment
        </label>
        {q.settings.allowComment && (
          <input className="input" style={{ minWidth: 300 }} data-testid="rating-comment-prompt"
            placeholder="What did you think about this video?"
            value={q.settings.commentPrompt ?? ""} onChange={(e) => patchSettings({ commentPrompt: e.target.value || undefined })} />
        )}
      </div>
      <PlaybackSettings {...p} autoplayDefault={false} requireLabel="require the video to be watched before rating" />
    </>
  );
});

registerVariantSettings("videotimeline", (p) => (
  <>
    <VideoListEditor {...p} multiple reactions />
    <label className="f"><span>Reaction mode</span>
      <select className="select" value={p.q.settings.timelineMode ?? "options"}
        data-testid="timeline-mode"
        onChange={(e) => p.patchSettings({ timelineMode: e.target.value as "tap" | "options" })}>
        <option value="options">Options — one button per option, stored with the reaction</option>
        <option value="tap">Tap — a single “React now” button, time only</option>
      </select></label>
    {(p.q.settings.timelineMode ?? "options") === "options" && p.q.options.length === 0 && (
      <div className="chip warn" data-testid="timeline-no-options">
        Options mode needs options — add the reactions respondents may tap.
      </div>
    )}
    <PlaybackSettings {...p} autoplayDefault requireLabel="require complete video watch (Next waits until every video has ended)" />
  </>
));

registerVariantSettings("watchtime", (p) => (
  <>
    <VideoListEditor {...p} multiple onCount={(clips) => ({ rows: watchTimeRows(clips.length) as Question["rows"] })} />
    <PlaybackSettings {...p} autoplayDefault={false} requireLabel="cannot continue until the clip has finished" />
    <div className="chip" data-testid="watchtime-fields">
      Records automatically, per video: seconds watched, clip duration, percent watched and whether it finished
      ({p.q.rows.map((r) => String(r.code)).join(", ")}). These are system variables — the respondent sees only the player.
    </div>
  </>
));

registerVariantSettings("audiorec", (p) => (
  <>
    <div className="row">
      <label className="f"><span>Maximum size (MB)</span>
        <CountInput min={1} max={100} value={p.q.settings.maxSizeMb ?? 10}
          onChange={(v) => p.patchSettings({ maxSizeMb: v ?? 10 })} /></label>
      <label className="f"><span>Accepted files (fallback upload)</span>
        <input className="input" value={p.q.settings.accept ?? "audio/*"}
          onChange={(e) => p.patchSettings({ accept: e.target.value || undefined })} /></label>
    </div>
    <div className="chip" data-testid="audiorec-note">
      Records with the device microphone where the browser allows it; respondents who
      refuse or have no microphone upload an audio file instead. Either way the answer
      is one file.
    </div>
  </>
));
