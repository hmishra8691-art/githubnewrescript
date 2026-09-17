/**
 * A RESPONDENT'S FILE, FROM THEIR BROWSER TO OBJECT STORAGE, DIRECTLY.
 *
 * One client for every upload a respondent makes — a recorded answer, an
 * attached file, a photo, a signature. It speaks the survey runtime's three
 * media routes (`ticket`, `parts`, `confirm`) through the same
 * `RecordingUploader` the interviews product uses, and so gets the same
 * guarantees: the bytes go straight to storage on signed URLs; a large file
 * goes in 8 MB parts and an interruption resumes from the parts the store
 * has; a retry after a refresh with the same `clientToken` finds the same
 * upload rather than opening a second one; and nothing is called saved until
 * the server has asked the store whether it is there.
 *
 * What it replaced: `/api/upload`, a multipart POST of the whole file
 * THROUGH the serverless function — 25 MB allowed by the route, 4.5 MB
 * allowed by the platform, and no session check at all.
 */
import { RecordingUploader, type UploadState, type UploaderEndpoints } from "@rescript/storage/uploader";

export const SESSION_MEDIA_ENDPOINTS: UploaderEndpoints = {
  begin: "/api/session/media/ticket",
  parts: "/api/session/media/parts",
  complete: "/api/session/media/confirm",
};

export type SessionUploadKind = "answer_audio" | "answer_upload";

export interface SessionUploadArgs {
  sessionId: string;
  kind: SessionUploadKind;
  questionId: string;
  /** the answer key inside a loop, `<questionId>__<iteration>`; the question id otherwise */
  answerKey?: string | null;
  fileName?: string | null;
  mimeType: string;
  bytes: number;
  durationSeconds?: number | null;
  /** anything else the confirm route wants to know (retakes, …) */
  completeExtra?: Record<string, unknown>;
  /** a name for the take that survives a reload, so a retry resumes rather than restarts */
  clientToken?: string;
  onState?: (s: UploadState) => void;
}

export function sessionUploader(args: SessionUploadArgs): RecordingUploader {
  return new RecordingUploader({
    endpoints: SESSION_MEDIA_ENDPOINTS,
    mimeType: args.mimeType,
    estimatedBytes: Math.max(1, args.bytes),
    clientToken: args.clientToken,
    beginExtra: {
      sessionId: args.sessionId,
      kind: args.kind,
      questionId: args.questionId,
      answerKey: args.answerKey ?? undefined,
      fileName: args.fileName ?? undefined,
      durationSeconds: args.durationSeconds ?? undefined,
    },
    completeExtra: {
      sessionId: args.sessionId,
      questionId: args.questionId,
      ...(args.completeExtra ?? {}),
    },
    onState: args.onState ?? (() => {}),
  });
}

/**
 * Send one whole blob — a file the respondent picked, a take that has
 * finished recording — and return the server's confirmation body.
 */
export async function uploadBlobForSession(
  blob: Blob, args: SessionUploadArgs,
): Promise<{ ok: true; mediaId: string; reply: Record<string, unknown> } | { ok: false; error: string }> {
  const up = sessionUploader({ ...args, bytes: blob.size });
  try {
    await up.begin();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  up.push(blob);
  return up.finish(args.durationSeconds ?? 0);
}

/**
 * A playback URL for THIS session. A recording stored in Cloudflare is kept
 * in the answer as the stable `/api/media/<id>`; the runtime serves it only
 * to the session that made it, named in `?s=`. A legacy signed URL, a data
 * URL or an object URL is returned unchanged.
 */
export function playbackUrl(url: string | null | undefined, sessionId: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (!/^\/api\/media\/[^/?#]+(?:\/[^/?#]+)?$/.test(url)) return url;
  return sessionId ? `${url}?s=${encodeURIComponent(sessionId)}` : url;
}

/** The words for an upload state, for the small status line under a control. */
export function uploadStateSay(s: UploadState): string {
  switch (s.phase) {
    case "idle": return "";
    case "uploading": return s.partsTotal > 1 ? `Uploading… ${s.partsDone} of ${s.partsTotal} parts` : "Uploading…";
    case "waiting": return s.message ?? "Reconnecting…";
    case "finishing": return "Checking it arrived…";
    case "stored": return "Saved";
    case "failed": return s.message ?? "The upload failed.";
    default: return "";
  }
}
