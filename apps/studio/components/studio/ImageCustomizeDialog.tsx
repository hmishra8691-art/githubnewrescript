"use client";
import React from "react";
import type { MediaDisplay } from "@rescript/schema";
import { mediaDisplayStyle, resolveMediaUrl } from "@rescript/engine";
import { MediaDisplayControls } from "./MediaDisplayControls";

/**
 * THE IMAGE POP-UP FOR AN ANSWER OPTION (1-10-26 review, Oweas 1–2, Prince).
 *
 * Choosing or uploading a picture for an option used to drop it straight
 * into the row. Now the pick opens this first: width and height in px, scale,
 * fit, alignment, proportions, padding and spacing, alt text, and a live
 * preview of the picture in an option-sized frame — and nothing reaches the
 * row until Apply. Cancel leaves the row exactly as it was.
 *
 * It edits the option's `imageDisplay` (a `MediaDisplay`, the same object
 * the renderer sizes every picture with), so what the preview shows is what
 * the respondent gets. It is deliberately smaller than Insert media: an
 * option has one picture in one place, so there is no position and no
 * several-items list here.
 */
export function ImageCustomizeDialog({ open, url, display, alt, label, onApply, onCancel }: {
  open: boolean;
  url: string;
  display: MediaDisplay | undefined;
  alt: string | undefined;
  /** the option's label, shown in the preview frame */
  label?: string;
  onApply(display: MediaDisplay | undefined, alt: string | undefined): void;
  onCancel(): void;
}) {
  const [d, setD] = React.useState<MediaDisplay | undefined>(display);
  const [a, setA] = React.useState(alt ?? "");
  React.useEffect(() => {
    if (!open) return;
    setD(display); setA(alt ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url]);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);
  if (!open) return null;
  const media = resolveMediaUrl(url);
  const piped = /\{\{[^}]+\}\}/.test(url);
  return (
    <div className="modal-back" onClick={onCancel} data-testid="image-customize">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Customize image" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Customize image</h2>
          <span className="muted mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 420 }} title={url}>{url.startsWith("data:") ? "inline image" : url}</span>
          <span className="grow" />
          <button type="button" className="btn small" onClick={onCancel}>close</button>
        </div>
        <div className="imgc-body">
          <div className="imgc-controls">
            <label className="f"><span>Alt text <span className="muted">(what a screen reader says — blank uses the option label)</span></span>
              <input className="input" data-testid="image-customize-alt" value={a} placeholder={label ? label.replace(/<[^>]*>/g, "") : "e.g. Acme logo"} onChange={(e) => setA(e.target.value)} /></label>
            <h3 className="sec" style={{ marginTop: 6 }}>Size &amp; layout</h3>
            <MediaDisplayControls kind="image" value={d} onChange={setD} compact />
          </div>
          <div className="imgc-preview-col">
            <h3 className="sec" style={{ marginTop: 0 }}>Preview</h3>
            <div className="imgc-frame" data-testid="image-customize-preview">
              {piped
                ? <div className="imgc-piped" style={mediaDisplayStyle(d) as React.CSSProperties}>{url}</div>
                : media.kind === "image" && media.url
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={media.url} alt="" style={mediaDisplayStyle(d) as React.CSSProperties} />
                  : <div className="muted" style={{ fontSize: 12.5 }}>{media.reason ?? "Not an image URL."}</div>}
              {label && <div className="imgc-label" dangerouslySetInnerHTML={{ __html: label.replace(/<(?!\/?(b|i|u|em|strong|br)\b)[^>]*>/gi, "") }} />}
            </div>
            <p className="muted" style={{ fontSize: 12 }}>The option&apos;s own layout (card, list row, icon…) frames the picture; these settings size and place it inside that frame.</p>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <span className="grow" />
          <button type="button" className="btn" onClick={onCancel} data-testid="image-customize-cancel">Cancel</button>
          <button type="button" className="btn primary" data-testid="image-customize-apply"
            onClick={() => onApply(d && Object.keys(d).length ? d : undefined, a.trim() || undefined)}>Apply</button>
        </div>
      </div>
    </div>
  );
}
