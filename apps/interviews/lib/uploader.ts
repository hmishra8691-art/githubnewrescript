"use client";
export {
  RecordingUploader,
  type UploadPhase, type UploadState, type UploaderOptions,
} from "@rescript/interviews/uploader";

/**
 * What this browser can actually record in.
 *
 * Preference order is real: VP9 is smaller than VP8 at the same quality, and
 * `mp4` is last because Safari's `MediaRecorder` produces it and nothing else
 * — so a list that did not end there would return nothing on a Mac. §10 is
 * explicit that browsers do not agree here, and the answer is to ask rather
 * than to assume.
 */
export function pickRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") return "video/webm";
  for (const type of [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "video/webm";
}

export function pickAudioMime(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "audio/webm";
}
