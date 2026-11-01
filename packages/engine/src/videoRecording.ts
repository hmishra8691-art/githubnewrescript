import type { Question } from "@rescript/schema";

/**
 * S5a item 3 — RESPONDENT VIDEO RECORDING (audit MM2-09), `media.video_recording`: the question's recording rules,
 * read by the renderer (limits, consent, fallback) and the runtime's media routes (the size cap).
 *
 *   maxSeconds   settings.maxAnswerSeconds, 5–600 (default 60) — the recorder stops itself there
 *   maxSizeMb    settings.maxSizeMb, 1–50 (default 50) — never above the respondent-video ceiling (media answerVideo.ts)
 *   maxRetakes   settings.maxRetakes (absent = unlimited)
 *   consentText  settings.consentText — shown with a checkbox; the camera stays off until it is ticked
 *   allowUpload  settings.allowFileUpload !== false — the file fallback (always offered when there is no camera)
 */
export const VIDEO_RECORDING_DEFAULT_SECONDS = 60;
export const VIDEO_RECORDING_MAX_SECONDS = 600;
export const VIDEO_RECORDING_MAX_MB = 50;

export interface VideoRecordingConfig { maxSeconds: number; maxSizeMb: number; maxRetakes: number | null; consentText: string; allowUpload: boolean }

export function isVideoRecording(q: Pick<Question, "variant">): boolean { return q.variant === "media.video_recording"; }

export function videoRecordingConfig(q: Pick<Question, "settings">): VideoRecordingConfig {
  const st = q.settings as Question["settings"] & { consentText?: string; allowFileUpload?: boolean };
  const secs = Number(st.maxAnswerSeconds);
  const mb = Number(st.maxSizeMb);
  return {
    maxSeconds: Number.isFinite(secs) && secs > 0 ? Math.min(VIDEO_RECORDING_MAX_SECONDS, Math.max(5, Math.round(secs))) : VIDEO_RECORDING_DEFAULT_SECONDS,
    maxSizeMb: Number.isFinite(mb) && mb > 0 ? Math.min(VIDEO_RECORDING_MAX_MB, mb) : VIDEO_RECORDING_MAX_MB,
    maxRetakes: Number.isInteger(st.maxRetakes) ? Number(st.maxRetakes) : null,
    consentText: (st.consentText ?? "").trim(),
    allowUpload: st.allowFileUpload !== false,
  };
}

/** the recorder's container, in order of preference, from what the browser says it supports */
export function pickRecorderMime(supported: (mime: string) => boolean): string | null {
  for (const m of ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4"]) if (supported(m)) return m;
  return null;
}

export function lintVideoRecording(q: Pick<Question, "settings" | "code">): string[] {
  const out: string[] = [];
  const st = q.settings as Question["settings"] & { consentText?: string };
  if (Number(st.maxAnswerSeconds) > VIDEO_RECORDING_MAX_SECONDS) out.push(`${q.code}: a video answer is at most ${VIDEO_RECORDING_MAX_SECONDS} s — the recorder stops there`);
  if (Number(st.maxSizeMb) > VIDEO_RECORDING_MAX_MB) out.push(`${q.code}: a video answer is stored up to ${VIDEO_RECORDING_MAX_MB} MB — a larger cap is not used`);
  if (!(st.consentText ?? "").trim()) out.push(`${q.code}: no consent text — respondents are asked to turn on their camera without being told how the video is used`);
  return out;
}
