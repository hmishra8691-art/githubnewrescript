"use client";
import React from "react";
import { resolveMediaUrl } from "@rescript/engine";
import { ASSET_ACCEPT, uploadAsset, type AssetSummary, type UploadProgress } from "@/lib/assets";
import { AssetPicker } from "./AssetPicker";
import { useStudio } from "./store";

/**
 * One input for any media URL — image, mp4, YouTube, Google Drive — with the
 * engine's verdict printed under it as it is typed, so a programmer learns
 * "this will embed as a YouTube player" or "Drive files must be shared" while
 * they are still looking at the field, not in the preview.
 *
 * Three ways to fill it: paste a URL, **Choose** from the survey's asset
 * library (or the customer's shared assets), or **Upload** a file straight
 * into that library. Upload and Choose are the same library — a file
 * uploaded here appears in the Assets tab and in every other Choose.
 */
export function MediaUrlInput({ value, onChange, placeholder, compact, testId, label, questionId, accept }: {
  value: string | undefined;
  onChange(next: string | undefined, asset?: AssetSummary): void;
  placeholder?: string;
  compact?: boolean;
  testId?: string;
  label?: string;
  /**
   * The question this media is FOR. It no longer files the asset under the
   * question (a library asset belongs to the survey — see the ticket route);
   * it is kept for the piping picker and future per-question defaults.
   */
  questionId?: string;
  /** what this slot takes, for the picker's filter and the file dialog */
  accept?: AssetSummary["family"][];
}) {
  const media = React.useMemo(() => resolveMediaUrl(value), [value]);
  const studio = useStudioOptional();
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = React.useState<UploadProgress | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState(false);
  const canUpload = !!studio && studio.surveyDbId !== "sandbox";
  const tid = testId ?? "media-url";
  void questionId;

  const upload = async (file: File) => {
    if (!studio) return;
    setUploadError(null);
    const out = await uploadAsset(studio.surveyDbId, file, { onProgress: setProgress });
    setProgress(null);
    if (fileRef.current) fileRef.current.value = "";
    if (!out.ok) { setUploadError(out.error); return; }
    onChange(out.asset.url, out.asset);
  };

  const verdict = !value?.trim()
    ? null
    : media.kind === "unsupported"
      ? { tone: "bad", text: media.reason ?? "Not supported" }
      : media.kind === "embed"
        ? { tone: "ok", text: `${PROVIDER[media.provider] ?? media.provider} · embedded player${media.note ? " · " + media.note : ""}` }
        : media.kind === "video"
          ? { tone: "ok", text: media.mimeType?.startsWith("audio/") ? `Audio (${media.mimeType})` : `Video (${media.mimeType ?? "direct"})` }
          : { tone: "ok", text: `Image${media.provider === "data" ? " (inline)" : ""}` };

  const fileAccept = accept?.length
    ? accept.map((f) => (f === "document" ? ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv" : `${f}/*`)).join(",")
    : ASSET_ACCEPT;

  const input = (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <input className="input grow" data-testid={tid} placeholder={placeholder ?? "Image, video, YouTube or Google Drive URL — or choose / upload an asset"}
        value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} />
      {canUpload && (
        <>
          <button type="button" className="btn ghost small" data-testid={`${tid}-choose`} onClick={() => setPicking(true)}
            title="Choose from this survey's asset library">Choose</button>
          <input ref={fileRef} type="file" accept={fileAccept} style={{ display: "none" }} data-testid={`${tid}-file`}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <button type="button" className="btn ghost small" disabled={!!progress} data-testid={`${tid}-upload`}
            onClick={() => fileRef.current?.click()} title="Upload a file into the asset library and use it here">
            {progress ? progress.label : "Upload"}
          </button>
        </>
      )}
    </div>
  );
  return (
    <div className={compact ? "" : "f"} style={compact ? { display: "flex", flexDirection: "column", gap: 2 } : undefined}>
      {label && <span>{label}</span>}
      {input}
      {progress && <div className="asset-progress" data-testid={`${tid}-progress`}><div style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>}
      {uploadError && (
        <span className="muted" data-testid={`${tid}-upload-error`} style={{ fontSize: 12.5, color: "var(--danger, #b91c1c)" }}>⚠ {uploadError}</span>
      )}
      {verdict && (
        <span className="muted" data-testid={`${tid}-verdict`} data-tone={verdict.tone}
          style={{ fontSize: 12.5, color: verdict.tone === "bad" ? "var(--danger, #b91c1c)" : undefined }}>
          {verdict.tone === "bad" ? "⚠ " : "✓ "}{verdict.text}
        </span>
      )}
      {!compact && media.kind === "image" && value && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media.url} alt="" style={{ maxWidth: 240, maxHeight: 140, borderRadius: 8, border: "1px solid var(--border)", marginTop: 4 }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
      )}
      {canUpload && (
        <AssetPicker open={picking} onClose={() => setPicking(false)} accept={accept}
          onPick={(a) => onChange(a.url, a)} />
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
