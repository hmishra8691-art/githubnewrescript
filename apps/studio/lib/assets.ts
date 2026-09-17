"use client";
import { RecordingUploader } from "@rescript/storage/uploader";
import { ASSET_MAX_BYTES, ASSET_MIME_TYPES, assetFamilyFor, assetWithinLimit, type AssetSummary } from "@rescript/media";

/**
 * THE ASSET LIBRARY, FROM THE BROWSER.
 *
 * One upload path for every place in the Studio that takes a file — the
 * Assets tab, the "Choose asset" picker's upload button, the media URL
 * field's Upload, the rich-text editor's Insert media. It is the same
 * browser-direct, resumable `RecordingUploader` the interview recorder uses,
 * against the survey's ticket / parts / confirm routes, with two things in
 * front of it:
 *
 *   - validation the server also does (type allowlist, per-family size),
 *     so a refusal is instant and worded, not a 413 after 200 MB
 *   - a content hash and a lookup, so the same file uploaded again is the
 *     same asset — nothing is stored twice
 *
 * Progress is a number (0–1) for a bar, plus a sentence for the label.
 */

export type { AssetSummary };

export const ASSET_ACCEPT = Object.values(ASSET_MIME_TYPES).flat().join(",");

export interface UploadProgress {
  /** 0–1 */
  fraction: number;
  /** "Checking for a copy…", "Uploading 3 of 8 parts…", "Checking it arrived…" */
  label: string;
  phase: "hashing" | "lookup" | "uploading" | "finishing" | "done";
}

export interface UploadOutcome {
  ok: true;
  asset: AssetSummary;
  /** true when an identical file already existed and was reused */
  duplicate: boolean;
}
export interface UploadFailure { ok: false; error: string }

/** The reason a file cannot be uploaded, before any byte moves — or null when it can. */
export function refuseFile(file: File): string | null {
  const type = file.type || guessType(file.name);
  if (!assetFamilyFor(type)) return `“${file.name}” is ${type || "of an unknown type"} — the library takes images, video, audio, PDF and Office documents.`;
  const size = assetWithinLimit(type, file.size);
  if (!size.ok) return size.message ?? "That file is too large.";
  return null;
}

/** A MIME type from an extension, for the browsers that report none. */
export function guessType(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp",
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", oga: "audio/ogg", ogg: "audio/ogg", flac: "audio/flac", weba: "audio/webm",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext] ?? "";
}

export function familyLimitMb(family: keyof typeof ASSET_MAX_BYTES): number {
  return Math.round(ASSET_MAX_BYTES[family] / 1048576);
}

/** Hex SHA-256 of a file. Skipped (null) above 256 MB, where hashing would take longer than the upload. */
export async function sha256Of(file: File): Promise<string | null> {
  if (file.size > 256 * 1024 * 1024 || typeof crypto === "undefined" || !crypto.subtle) return null;
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The picture's natural size, for the row — images only. */
async function dimensionsOf(file: File): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith("image/") || typeof Image === "undefined") return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

export async function fetchAssets(surveyDbId: string): Promise<AssetSummary[]> {
  const r = await fetch(`/api/surveys/${surveyDbId}/media`, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Could not load the asset library (${r.status})`);
  return (j.assets ?? []) as AssetSummary[];
}

export async function fetchAssetUsage(surveyDbId: string, mediaId: string): Promise<{ asset: AssetSummary; usage: { surveyId: string; code: string; title: string; inDraft: boolean; inLive: boolean }[] }> {
  const r = await fetch(`/api/surveys/${surveyDbId}/media/${mediaId}`, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Could not read the asset (${r.status})`);
  return j;
}

export async function patchAsset(surveyDbId: string, mediaId: string, patch: { displayName?: string | null; altText?: string | null; shared?: boolean }): Promise<AssetSummary> {
  const r = await fetch(`/api/surveys/${surveyDbId}/media/${mediaId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Could not update the asset (${r.status})`);
  return j.asset as AssetSummary;
}

export async function deleteAsset(surveyDbId: string, mediaId: string, force = false): Promise<{ ok: true } | { ok: false; error: string; usage?: { surveyId: string; code: string; title: string; inDraft: boolean; inLive: boolean }[] }> {
  const r = await fetch(`/api/surveys/${surveyDbId}/media/${mediaId}${force ? "?force=1" : ""}`, { method: "DELETE" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: j.error ?? `Could not delete (${r.status})`, usage: j.usage };
  return { ok: true };
}

/**
 * Upload one file into the survey's library. Resolves with the asset — the
 * one just stored, or the identical one that was already there.
 */
export async function uploadAsset(
  surveyDbId: string,
  file: File,
  opts: { onProgress?: (p: UploadProgress) => void; displayName?: string; altText?: string; questionId?: string } = {},
): Promise<UploadOutcome | UploadFailure> {
  const refused = refuseFile(file);
  if (refused) return { ok: false, error: refused };
  const type = file.type || guessType(file.name);
  const progress = (p: UploadProgress) => opts.onProgress?.(p);

  progress({ fraction: 0, label: "Checking for a copy…", phase: "hashing" });
  const sha256 = await sha256Of(file);
  if (sha256) {
    progress({ fraction: 0.02, label: "Checking for a copy…", phase: "lookup" });
    try {
      const r = await fetch(`/api/surveys/${surveyDbId}/media/lookup`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha256, bytes: file.size }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.asset) {
        progress({ fraction: 1, label: "Already in the library", phase: "done" });
        return { ok: true, asset: j.asset as AssetSummary, duplicate: true };
      }
    } catch { /* a failed lookup is not a failed upload */ }
  }

  const dims = await dimensionsOf(file);
  progress({ fraction: 0.05, label: "Uploading…", phase: "uploading" });
  try {
    const up = new RecordingUploader({
      endpoints: {
        begin: `/api/surveys/${surveyDbId}/media/ticket`,
        parts: `/api/surveys/${surveyDbId}/media/parts`,
        complete: `/api/surveys/${surveyDbId}/media/confirm`,
      },
      mimeType: type || "application/octet-stream",
      estimatedBytes: file.size,
      beginExtra: {
        kind: "survey_asset", fileName: file.name, sha256, displayName: opts.displayName ?? null, altText: opts.altText ?? null,
        ...(opts.questionId ? { questionId: opts.questionId } : {}),
        ...(dims ?? {}),
      },
      completeExtra: { ...(opts.questionId ? { questionId: opts.questionId } : {}), ...(dims ?? {}) },
      onState: (st) => {
        if (st.phase === "finishing") progress({ fraction: 0.97, label: "Checking it arrived…", phase: "finishing" });
        else if (st.partsTotal > 1) progress({ fraction: 0.05 + 0.9 * (st.partsDone / st.partsTotal), label: `Uploading ${st.partsDone} of ${st.partsTotal} parts…`, phase: "uploading" });
        else progress({ fraction: 0.5, label: "Uploading…", phase: "uploading" });
      },
    });
    await up.begin();
    up.push(file);
    const out = await up.finish(0);
    if (!out.ok) return { ok: false, error: out.error };
    const stored = out.reply.video as { url?: string; mediaId?: string; fileName?: string; mimeType?: string; bytes?: number } | undefined;
    if (!stored?.url || !stored.mediaId) return { ok: false, error: "The file was stored but no URL came back." };
    progress({ fraction: 1, label: "Stored", phase: "done" });
    /* the row as the library will list it — fetched so display name / family come from the server's one summariser */
    try {
      const { asset } = await fetchAssetUsage(surveyDbId, stored.mediaId);
      return { ok: true, asset, duplicate: false };
    } catch {
      return {
        ok: true, duplicate: false,
        asset: {
          id: stored.mediaId, surveyId: surveyDbId, customerId: "", name: opts.displayName ?? file.name, fileName: file.name, altText: opts.altText ?? null,
          mimeType: type, family: (assetFamilyFor(type) ?? "document"), bytes: file.size, width: dims?.width ?? null, height: dims?.height ?? null,
          durationSeconds: null, sha256, shared: false, fromOtherSurvey: false, createdAt: new Date().toISOString(), url: stored.url,
        },
      };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
}

export const FAMILY_LABEL: Record<AssetSummary["family"], string> = { image: "Image", video: "Video", audio: "Audio", document: "Document" };
export const FAMILY_ICON: Record<AssetSummary["family"], string> = { image: "🖼", video: "🎬", audio: "🎧", document: "📄" };
