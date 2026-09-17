"use client";
import React from "react";
import type { MediaDisplay } from "@rescript/schema";
import { mediaDisplayCss, resolveMediaUrl } from "@rescript/engine";

/**
 * SIZE, FIT, ALIGNMENT AND PLAYBACK — WITHOUT WRITING CSS.
 *
 * The same panel wherever media is shown: a question's stimulus, the
 * branding logo, a picture or player inserted into rich text. It edits a
 * `MediaDisplay` (schema) and shows the CSS it means, read-only, so a
 * programmer who wants to know what "Fit: contain, Align: center" does can
 * see it — and a "Custom CSS" line for the declaration the controls do not
 * have. The CSS is computed by the engine's `mediaDisplayCss`, the same
 * function the renderer uses, so the preview here is the respondent's view.
 *
 * `kind` decides which controls make sense: an image has no autoplay, an
 * audio clip has no fit.
 */
export type DisplayKind = "image" | "video" | "audio";

const FITS: { value: NonNullable<MediaDisplay["fit"]>; label: string; hint: string }[] = [
  { value: "contain", label: "Contain", hint: "whole picture visible, letterboxed if the box has another shape" },
  { value: "cover", label: "Cover", hint: "fills the box, cropping the edges" },
  { value: "fill", label: "Stretch", hint: "fills the box, distorting if needed" },
  { value: "scale-down", label: "Scale down", hint: "never larger than natural size" },
  { value: "none", label: "Natural", hint: "natural size, cropped to the box" },
];

export function MediaDisplayControls({ value, onChange, kind, compact }: {
  value: MediaDisplay | undefined;
  onChange(next: MediaDisplay | undefined): void;
  kind: DisplayKind;
  /** fewer labels, for a popover */
  compact?: boolean;
}) {
  const d: MediaDisplay = value ?? {};
  const patch = (p: Partial<MediaDisplay>) => {
    const next: MediaDisplay = { ...d, ...p };
    for (const k of Object.keys(next) as (keyof MediaDisplay)[]) {
      if (next[k] === undefined || next[k] === "" || next[k] === null) delete next[k];
    }
    onChange(Object.keys(next).length ? next : undefined);
  };
  const len = (k: "width" | "height" | "maxWidth" | "maxHeight", label: string, placeholder: string) => (
    <label className="f" key={k}><span>{label}</span>
      <input className="input mono" style={{ width: compact ? 84 : 100 }} data-testid={`mdisp-${k}`} placeholder={placeholder}
        value={d[k] === undefined ? "" : String(d[k])}
        onChange={(e) => patch({ [k]: e.target.value.trim() || undefined } as Partial<MediaDisplay>)} /></label>
  );
  const isAv = kind !== "image";
  return (
    <div className="mdisp" data-testid="media-display-controls">
      <div className="mdisp-row">
        {len("width", "Width", "auto")}
        {len("height", "Height", "auto")}
        {len("maxWidth", "Max width", "100%")}
        {len("maxHeight", "Max height", "none")}
      </div>
      <div className="mdisp-row">
        {kind !== "audio" && (
          <label className="f"><span>Fit</span>
            <select className="select" data-testid="mdisp-fit" value={d.fit ?? ""} title={FITS.find((f) => f.value === d.fit)?.hint}
              onChange={(e) => patch({ fit: (e.target.value || undefined) as MediaDisplay["fit"] })}>
              <option value="">default</option>
              {FITS.map((f) => <option key={f.value} value={f.value} title={f.hint}>{f.label}</option>)}
            </select></label>
        )}
        <label className="f"><span>Align</span>
          <div className="row" style={{ gap: 2 }}>
            {(["left", "center", "right"] as const).map((a) => (
              <button key={a} type="button" className={`btn small ${d.align === a ? "primary" : ""}`} data-testid={`mdisp-align-${a}`}
                title={`Align ${a}`} onClick={() => patch({ align: d.align === a ? undefined : a })}>{a === "left" ? "⇤" : a === "center" ? "⇔" : "⇥"}</button>
            ))}
          </div></label>
        <label className="f qs-check-field"><span>Keep proportions</span>
          <span className="qs-check-inline"><input type="checkbox" checked={d.keepRatio !== false} onChange={(e) => patch({ keepRatio: e.target.checked ? undefined : false })} /><span className="muted">{d.keepRatio !== false ? "on" : "off"}</span></span></label>
        <label className="f qs-check-field"><span>Shrink on small screens</span>
          <span className="qs-check-inline"><input type="checkbox" data-testid="mdisp-responsive" checked={d.responsive !== false} onChange={(e) => patch({ responsive: e.target.checked ? undefined : false })} /><span className="muted">{d.responsive !== false ? "on" : "off"}</span></span></label>
      </div>
      {isAv && (
        <div className="mdisp-row">
          {([["controls", "Player controls", d.controls !== false], ["autoplay", "Autoplay", !!d.autoplay], ["muted", "Muted", !!d.muted || (!!d.autoplay && kind === "video")], ["loop", "Loop", !!d.loop]] as [keyof MediaDisplay, string, boolean][]).map(([k, label, on]) => (
            <label key={k} className="f qs-check-field"><span>{label}</span>
              <span className="qs-check-inline">
                <input type="checkbox" data-testid={`mdisp-${k}`} checked={on}
                  onChange={(e) => patch(k === "controls" ? { controls: e.target.checked ? undefined : false } : { [k]: e.target.checked ? true : undefined } as Partial<MediaDisplay>)} />
                <span className="muted">{on ? "on" : "off"}</span>
              </span></label>
          ))}
          {kind === "video" && (
            <label className="f qs-wide"><span>Poster (still before play)</span>
              <input className="input" data-testid="mdisp-poster" placeholder="image URL — or pick one from Assets" value={d.poster ?? ""} onChange={(e) => patch({ poster: e.target.value.trim() || undefined })} /></label>
          )}
          {d.autoplay && kind === "video" && !d.muted && <span className="muted" style={{ fontSize: 12 }}>Browsers only autoplay muted video — it will start muted.</span>}
        </div>
      )}
      <details className="qs-details">
        <summary>Custom CSS · what this means</summary>
        <label className="f qs-wide"><span>Extra declarations</span>
          <input className="input mono" data-testid="mdisp-css" placeholder="border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.2)" value={d.css ?? ""} onChange={(e) => patch({ css: e.target.value || undefined })} /></label>
        <div className="muted mono" style={{ fontSize: 12, marginTop: 4 }} data-testid="mdisp-css-out">{mediaDisplayCss(d) || "(the stylesheet decides)"}</div>
      </details>
    </div>
  );
}

/** A live preview of a URL under a display — the respondent's view, in a box. */
export function MediaDisplayPreview({ url, display, kind }: { url: string; display: MediaDisplay | undefined; kind: DisplayKind }) {
  const media = resolveMediaUrl(url);
  const style = { ...cssObject(mediaDisplayCss(display)) } as React.CSSProperties;
  if (!media.url) return <div className="muted" style={{ fontSize: 12.5 }}>{media.reason ?? "Nothing to preview."}</div>;
  return (
    <div className="mdisp-preview" data-testid="media-display-preview">
      {kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media.url} alt="" style={style} />
      )}
      {kind === "video" && <video src={media.url} style={style} controls={display?.controls !== false} muted={!!display?.muted || !!display?.autoplay} loop={!!display?.loop} autoPlay={!!display?.autoplay} poster={display?.poster} playsInline />}
      {kind === "audio" && <audio src={media.url} style={style} controls={display?.controls !== false} muted={!!display?.muted} loop={!!display?.loop} autoPlay={!!display?.autoplay} />}
    </div>
  );
}

function cssObject(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i <= 0) continue;
    out[decl.slice(0, i).trim().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = decl.slice(i + 1).trim();
  }
  return out;
}
