/**
 * S5a item 3 — RESPONDENT VIDEO (audit MM2-09): what a respondent's recorded video may be, checked in the browser
 * before the upload, on the ticket route before a URL is handed out, and on the confirm route against the stored
 * bytes themselves.
 *
 * A respondent video is stored as an `answer_upload` (the bucket, the path per session, the deletion and the
 * delivery of every other respondent file — no new kind, no migration) with three extra rules when the question is
 * a video recording (`media.video_recording`):
 *
 *   type     video/webm, video/mp4 or video/quicktime only (what MediaRecorder and phone cameras write)
 *   size     ≤ the question's maxSizeMb, never above ANSWER_VIDEO_MAX_BYTES (50 MB — the store's default global
 *            limit; at the recorder's ~1 Mbit/s that is about six minutes)
 *   sniffed  the stored object's first bytes must BE a video container (EBML for WebM, an ISO-BMFF `ftyp` box for
 *            MP4 / MOV) — a renamed file with a video content type is refused and removed
 *
 * STORAGE COST. One minute at the recorder's bitrate (RESPONDENT_VIDEO_BITS_PER_SECOND, video + audio) is about
 * 7.5 MB; 1,000 respondents answering one 60-second video question store ≈ 7.5 GB in the uploads bucket (kept a
 * year, like every respondent file). `answerVideoStorageEstimate` gives the number for a plan.
 */
import type { SizeVerdict } from "./plan.js";

export const ANSWER_VIDEO_MIME_TYPES: readonly string[] = ["video/webm", "video/mp4", "video/quicktime"];
export const ANSWER_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
/** what the respondent recorder asks MediaRecorder for (video 900 kbit/s + audio 96 kbit/s) */
export const RESPONDENT_VIDEO_BITS_PER_SECOND = { video: 900_000, audio: 96_000 } as const;

const base = (m: string | null | undefined) => (m ?? "").toLowerCase().split(";")[0].trim();

/** the type and size rule for one respondent video (`maxSizeMb` = the question's own cap, if smaller) */
export function answerVideoRule(mimeType: string | null | undefined, bytes: number | null | undefined, maxSizeMb?: number | null): SizeVerdict {
  const m = base(mimeType);
  if (!ANSWER_VIDEO_MIME_TYPES.includes(m)) {
    return { ok: false, message: `That file is ${m || "an unknown type"} — a video answer must be WebM, MP4 or MOV.` };
  }
  const cap = Math.min(ANSWER_VIDEO_MAX_BYTES, maxSizeMb && maxSizeMb > 0 ? maxSizeMb * 1024 * 1024 : Infinity);
  if (typeof bytes === "number" && bytes > cap) {
    return { ok: false, message: `That video is ${(bytes / 1024 / 1024).toFixed(1)} MB and this question accepts ${Math.round(cap / 1024 / 1024)} MB. Record a shorter take.` };
  }
  if (typeof bytes === "number" && bytes <= 0) return { ok: false, message: "That video is empty — record again." };
  return { ok: true };
}

/** the container the bytes really are, from their first 12 bytes */
export function sniffVideo(b: Uint8Array): "webm" | "mp4" | "mov" | null {
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    return brand === "qt  " ? "mov" : "mp4";
  }
  return null;
}

/** do the stored bytes agree with a video answer? (the declared type may be any of the three: browsers disagree on mp4 / mov) */
export function sniffedVideoOk(b: Uint8Array): SizeVerdict {
  return sniffVideo(b) ? { ok: true } : { ok: false, message: "The uploaded file is not a video (its contents are not WebM, MP4 or MOV) — record again." };
}

/** bytes for `respondents` answers of `seconds` each at the recorder's bitrate */
export function answerVideoStorageEstimate(seconds: number, respondents = 1): number {
  const perSecond = (RESPONDENT_VIDEO_BITS_PER_SECOND.video + RESPONDENT_VIDEO_BITS_PER_SECOND.audio) / 8;
  return Math.round(Math.max(0, seconds) * perSecond * Math.max(0, respondents));
}
