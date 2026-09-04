"use client";
import React from "react";
import { MediaUrlInput } from "../MediaUrlInput";
import { resolveMediaUrl } from "@rescript/engine";
import { registerVariantSettings, type VariantSettingsProps } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the video / audio family — see docs/VARIANT-BATCH.md §4.
 *
 * Everything here hangs off one setting the three video variants share,
 * `settings.mediaUrl`, plus the gate (`requireComplete`) that decides whether
 * a respondent may answer before the clip has finished.
 */

function MediaUrl({ q, patchSettings, hint }: VariantSettingsProps & { hint?: string }) {
  return (
    <>
      <MediaUrlInput label="Video / audio URL" testId="media-url" placeholder="https://…/clip.mp4"
        value={q.settings.mediaUrl} onChange={(v) => patchSettings({ mediaUrl: v })} />
      {resolveMediaUrl(q.settings.mediaUrl).kind === "embed" && (
        <div className="chip warn" data-testid="media-embed-warn">
          Embedded players (YouTube, Vimeo, Drive) cannot report playback position — the “must finish”
          gate and timestamps need a direct .mp4 / .webm URL.
        </div>
      )}
      {!q.settings.mediaUrl && (
        <div className="chip warn" data-testid="media-no-url">
          {hint ?? "Without a clip the respondent sees a note instead of a player."}
        </div>
      )}
    </>
  );
}

function RequireComplete({ q, patchSettings, label }: VariantSettingsProps & { label: string }) {
  return (
    <label className="f" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <input type="checkbox" checked={!!q.settings.requireComplete}
        data-testid="media-require-complete"
        onChange={(e) => patchSettings({ requireComplete: e.target.checked })} />
      <span>{label}</span>
    </label>
  );
}

registerVariantSettings("videorating", (p) => (
  <>
    <MediaUrl {...p} />
    <RequireComplete {...p} label="Must watch to the end before rating" />
    <div className="row">
      <label className="f"><span>Lowest star</span>
        <CountInput min={0} max={10} value={p.q.settings.minValue ?? 1}
          onChange={(v) => p.patchSettings({ minValue: v ?? 1 })} /></label>
      <label className="f"><span>Highest star</span>
        <CountInput min={1} max={10} value={p.q.settings.maxValue ?? 5}
          onChange={(v) => p.patchSettings({ maxValue: v ?? 5 })} /></label>
    </div>
  </>
));

registerVariantSettings("videotimeline", (p) => (
  <>
    <MediaUrl {...p} />
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
  </>
));

registerVariantSettings("watchtime", (p) => (
  <>
    <MediaUrl {...p} hint="Without a clip there is no watch time to record." />
    <RequireComplete {...p} label="Cannot continue until the clip has finished" />
    <div className="chip" data-testid="watchtime-fields">
      Records four fields automatically: seconds watched, clip duration, percent watched
      and whether it finished. The respondent sees only the player.
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
