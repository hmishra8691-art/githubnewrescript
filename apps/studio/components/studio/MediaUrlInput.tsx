"use client";
import React from "react";
import { resolveMediaUrl } from "@rescript/engine";

/**
 * One input for any media URL — image, mp4, YouTube, Google Drive — with the
 * engine's verdict printed under it as it is typed, so a programmer learns
 * "this will embed as a YouTube player" or "Drive files must be shared" while
 * they are still looking at the field, not in the preview.
 */
export function MediaUrlInput({ value, onChange, placeholder, compact, testId, label }: {
  value: string | undefined;
  onChange(next: string | undefined): void;
  placeholder?: string;
  compact?: boolean;
  testId?: string;
  label?: string;
}) {
  const media = React.useMemo(() => resolveMediaUrl(value), [value]);
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
    <input className="input grow" data-testid={testId ?? "media-url"} placeholder={placeholder ?? "Image, video, YouTube or Google Drive URL"}
      value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} />
  );
  return (
    <div className={compact ? "" : "f"} style={compact ? { display: "flex", flexDirection: "column", gap: 2 } : undefined}>
      {label && <span>{label}</span>}
      {input}
      {verdict && (
        <span className="muted" data-testid={`${testId ?? "media-url"}-verdict`} data-tone={verdict.tone}
          style={{ fontSize: 11, color: verdict.tone === "bad" ? "var(--danger, #b91c1c)" : undefined }}>
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
