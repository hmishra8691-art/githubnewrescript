"use client";
import React from "react";
import type { MediaDisplay } from "@rescript/schema";
import { mediaHtml, mediaDisplayFromCss, resolveMediaUrl, type InsertableMediaKind } from "@rescript/engine";
import { AssetPicker } from "./AssetPicker";
import { MediaDisplayControls, MediaDisplayPreview } from "./MediaDisplayControls";
import { useStudio } from "./store";
import type { AssetSummary } from "@/lib/assets";

/**
 * INSERT (OR EDIT) A PICTURE, VIDEO OR AUDIO CLIP IN RICH TEXT.
 *
 * Opened from the editor's "Insert media" button, and again when an
 * already-inserted picture is clicked: the dialog reads the element's URL,
 * alt text and `style` back into the controls (`mediaDisplayFromCss`), so
 * "make the logo smaller" is a number changed, not HTML edited. It produces
 * the markup through the engine's `mediaHtml` — the same object the
 * renderer sizes a question's stimulus with — so the picture in the option
 * label looks the same in the builder, the preview and the live survey.
 */
export interface MediaInsertValue {
  kind: InsertableMediaKind;
  url: string;
  alt: string;
  display: MediaDisplay | undefined;
  mimeType?: string;
}

export function MediaInsertDialog({ open, initial, onClose, onInsert }: {
  open: boolean;
  /** what an existing element carried, when editing */
  initial?: Partial<MediaInsertValue> | null;
  onClose(): void;
  onInsert(html: string, value: MediaInsertValue): void;
}) {
  const s = useStudio();
  const [kind, setKind] = React.useState<InsertableMediaKind>(initial?.kind ?? "image");
  const [url, setUrl] = React.useState(initial?.url ?? "");
  const [alt, setAlt] = React.useState(initial?.alt ?? "");
  const [display, setDisplay] = React.useState<MediaDisplay | undefined>(initial?.display ?? { maxWidth: "100%" });
  const [mime, setMime] = React.useState<string | undefined>(initial?.mimeType);
  const [picking, setPicking] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setKind(initial?.kind ?? "image"); setUrl(initial?.url ?? ""); setAlt(initial?.alt ?? "");
    setDisplay(initial?.display ?? (initial?.kind ? undefined : { maxWidth: "100%" })); setMime(initial?.mimeType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !picking) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, picking, onClose]);

  if (!open) return null;
  const media = resolveMediaUrl(url);
  const urlOk = !!url.trim() && media.kind !== "unsupported" && media.kind !== "embed";
  const pick = (a: AssetSummary) => {
    setUrl(a.url);
    setMime(a.mimeType ?? undefined);
    if (a.family === "image" || a.family === "video" || a.family === "audio") setKind(a.family);
    if (!alt && a.altText) setAlt(a.altText);
  };
  const insert = () => {
    const value: MediaInsertValue = { kind, url: url.trim(), alt: alt.trim(), display, mimeType: mime };
    onInsert(mediaHtml(kind, value.url, display, { alt: value.alt, mimeType: mime }), value);
    onClose();
  };
  const canUse = s.surveyDbId && s.surveyDbId !== "sandbox";

  return (
    <div className="modal-back" onClick={onClose} data-testid="media-insert">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Insert media" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>{initial?.url ? "Edit media" : "Insert media"}</h2>
          <div className="row" style={{ gap: 2, marginLeft: 8 }}>
            {(["image", "video", "audio"] as const).map((k) => (
              <button key={k} type="button" className={`btn small ${kind === k ? "primary" : ""}`} data-testid={`media-insert-kind-${k}`} onClick={() => setKind(k)}>{k}</button>
            ))}
          </div>
          <span className="grow" />
          <button type="button" className="btn small" onClick={onClose}>close</button>
        </div>

        <label className="f" style={{ marginTop: 8 }}><span>Source</span>
          <div className="row" style={{ gap: 6 }}>
            <input className="input grow" data-testid="media-insert-url" placeholder={`${kind} URL — or choose from the asset library`} value={url} onChange={(e) => setUrl(e.target.value)} />
            <button type="button" className="btn small" disabled={!canUse} onClick={() => setPicking(true)} data-testid="media-insert-choose" title={canUse ? "Pick from this survey's assets, or upload" : "Save the survey first"}>Choose asset…</button>
          </div>
          {url.trim() && !urlOk && <span className="muted" style={{ fontSize: 12.5, color: "var(--danger, #b91c1c)" }}>⚠ {media.kind === "embed" ? "Embedded players (YouTube, Vimeo, Drive) go in the question's media field, not inside text." : media.reason ?? "Not a media URL."}</span>}
        </label>
        {kind === "image" && (
          <label className="f"><span>Alt text <span className="muted">(what a screen reader says)</span></span>
            <input className="input" data-testid="media-insert-alt" placeholder="e.g. Acme logo" value={alt} onChange={(e) => setAlt(e.target.value)} /></label>
        )}

        <h3 className="sec" style={{ marginTop: 10 }}>Size &amp; layout</h3>
        <MediaDisplayControls kind={kind} value={display} onChange={setDisplay} compact />

        {urlOk && (
          <>
            <h3 className="sec">Preview</h3>
            <MediaDisplayPreview url={url} display={display} kind={kind} />
          </>
        )}

        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!urlOk} onClick={insert} data-testid="media-insert-ok">{initial?.url ? "Apply" : "Insert"}</button>
        </div>
      </div>
      <AssetPicker open={picking} onClose={() => setPicking(false)} onPick={pick}
        accept={kind === "image" ? ["image"] : kind === "video" ? ["video"] : ["audio"]} title={`Choose ${kind === "image" ? "an image" : `a ${kind} file`}`} />
    </div>
  );
}

/** Read an inserted element back into dialog values — what the editor passes as `initial` on click. */
export function mediaValueFromElement(el: HTMLElement): Partial<MediaInsertValue> | null {
  const tag = el.tagName.toLowerCase();
  if (tag !== "img" && tag !== "video" && tag !== "audio") return null;
  const kind = tag as InsertableMediaKind;
  const display = mediaDisplayFromCss(el.getAttribute("style"));
  if (kind !== "image") {
    display.controls = el.hasAttribute("controls") ? undefined : false;
    if (el.hasAttribute("autoplay")) display.autoplay = true;
    if (el.hasAttribute("muted")) display.muted = true;
    if (el.hasAttribute("loop")) display.loop = true;
    const poster = el.getAttribute("poster");
    if (poster) display.poster = poster;
  }
  const source = el.querySelector("source");
  return {
    kind,
    url: el.getAttribute("src") ?? source?.getAttribute("src") ?? "",
    alt: el.getAttribute("alt") ?? "",
    display: Object.keys(display).length ? display : undefined,
    mimeType: source?.getAttribute("type") ?? undefined,
  };
}
