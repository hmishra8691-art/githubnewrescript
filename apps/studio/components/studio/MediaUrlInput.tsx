"use client";
import React from "react";
import { resolveMediaUrl } from "@rescript/engine";
import { RecordingUploader } from "@rescript/storage/uploader";
import { useStudio } from "./store";

/**
 * One input for any media URL — image, mp4, YouTube, Google Drive — with the
 * engine's verdict printed under it as it is typed, so a programmer learns
 * "this will embed as a YouTube player" or "Drive files must be shared" while
 * they are still looking at the field, not in the preview.
 */
/** What may be attached to a question as a stored asset. */
const ASSET_ACCEPT = "image/*,video/*,audio/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv";
const ASSET_MAX_MB = 50;

export function MediaUrlInput({ value, onChange, placeholder, compact, testId, label, questionId }: {
  value: string | undefined;
  onChange(next: string | undefined): void;
  placeholder?: string;
  compact?: boolean;
  testId?: string;
  label?: string;
  /** the question this asset belongs to, so its row can be found and cleaned up with the question */
  questionId?: string;
}) {
  const media = React.useMemo(() => resolveMediaUrl(value), [value]);
  const studio = useStudioOptional();
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = React.useState<string | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const canUpload = !!studio && studio.surveyDbId !== "sandbox";

  /*
   * UPLOAD, NOT PASTE. An image or a PDF a researcher attaches used to be a
   * URL to somewhere else — a personal Drive, a CDN, a link that expires or
   * moves. It is a stored object now, straight from the browser to storage
   * as a `survey_asset`, kept as the survey's own `/api/media/<id>/<name>`
   * and deleted with the survey like everything else it owns.
   */
  const uploadAsset = async (file: File) => {
    if (!studio) return;
    setUploadError(null);
    if (file.size > ASSET_MAX_MB * 1024 * 1024) { setUploadError(`That file is ${Math.round(file.size / 1048576)} MB — the limit is ${ASSET_MAX_MB} MB.`); return; }
    setUploading("Uploading…");
    try {
      const up = new RecordingUploader({
        endpoints: {
          begin: `/api/surveys/${studio.surveyDbId}/media/ticket`,
          parts: `/api/surveys/${studio.surveyDbId}/media/parts`,
          complete: `/api/surveys/${studio.surveyDbId}/media/confirm`,
        },
        mimeType: file.type || "application/octet-stream", estimatedBytes: file.size,
        beginExtra: { kind: "survey_asset", questionId: questionId ?? "asset", fileName: file.name },
        completeExtra: { questionId: questionId ?? "asset" },
        onState: (st) => setUploading(st.partsTotal > 1 ? `Uploading… ${st.partsDone} of ${st.partsTotal} parts` : st.phase === "finishing" ? "Checking it arrived…" : "Uploading…"),
      });
      await up.begin();
      up.push(file);
      const out = await up.finish(0);
      if (!out.ok) { setUploadError(out.error); return; }
      const stored = out.reply.video as { url?: string } | undefined;
      if (!stored?.url) { setUploadError("The file was stored but no URL came back."); return; }
      onChange(stored.url);
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const verdict = !value?.trim()
    ? null
    : media.kind === "unsupported"
      ? { tone: "bad", text: media.reason ?? "Not supported" }
      : media.kind === "embed"
        ? { tone: "ok", text: `${PROVIDER[media.provider] ?? media.provider} · embedded player${media.note ? " · " + media.note : ""}` }
        : media.kind === "video"
          ? { tone: "ok", text: `Video (${media.mimeType ?? "direct"})` }
          : { tone: "ok", text: `Image${media.provider === "data" ? " (inline)" : ""}` };

  const input = (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <input className="input grow" data-testid={testId ?? "media-url"} placeholder={placeholder ?? "Image, video, YouTube or Google Drive URL — or upload a file"}
        value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} />
      {canUpload && (
        <>
          <input ref={fileRef} type="file" accept={ASSET_ACCEPT} style={{ display: "none" }} data-testid={`${testId ?? "media-url"}-file`}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAsset(f); }} />
          <button type="button" className="btn ghost small" disabled={!!uploading} data-testid={`${testId ?? "media-url"}-upload`}
            onClick={() => fileRef.current?.click()} title={`Upload an image, video, audio, PDF or document (up to ${ASSET_MAX_MB} MB) — stored with the survey`}>
            {uploading ?? "Upload"}
          </button>
        </>
      )}
    </div>
  );
  return (
    <div className={compact ? "" : "f"} style={compact ? { display: "flex", flexDirection: "column", gap: 2 } : undefined}>
      {label && <span>{label}</span>}
      {input}
      {uploadError && (
        <span className="muted" data-testid={`${testId ?? "media-url"}-upload-error`} style={{ fontSize: 12.5, color: "var(--danger, #b91c1c)" }}>⚠ {uploadError}</span>
      )}
      {verdict && (
        <span className="muted" data-testid={`${testId ?? "media-url"}-verdict`} data-tone={verdict.tone}
          style={{ fontSize: 12.5, color: verdict.tone === "bad" ? "var(--danger, #b91c1c)" : undefined }}>
          {verdict.tone === "bad" ? "⚠ " : "✓ "}{verdict.text}
        </span>
      )}
      {!compact && media.kind === "image" && value && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media.url} alt="" style={{ maxWidth: 240, maxHeight: 140, borderRadius: 8, border: "1px solid var(--border)", marginTop: 4 }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
      )}
    </div>
  );
}

const PROVIDER: Record<string, string> = { youtube: "YouTube", vimeo: "Vimeo", google_drive: "Google Drive" };

/** The Studio store when this input is inside one; null in a canvas or a test that renders it alone. */
function useStudioOptional(): { surveyDbId: string } | null {
  try {
    return useStudio() as unknown as { surveyDbId: string };
  } catch {
    return null;
  }
}
