import type { MediaDisplay } from "@rescript/schema";
import { escapeHtml, sanitizeCss } from "./html.js";

/**
 * ONE COMPUTATION FROM "HOW SHOULD THIS LOOK" TO CSS.
 *
 * The Studio's sizing controls, the renderer's `<MediaEmbed display>` and the
 * markup a picture inserted into rich text carries all go through here, so
 * the builder, the preview, the test link and the live survey agree — the
 * brief's "consistent between Builder, Preview, Testing and the live
 * respondent experience" is one function, not four renderers agreeing.
 *
 * Rules:
 *   - a bare number is pixels; a string is taken as written (`60%`, `auto`)
 *   - `keepRatio` (default on) leaves the unset dimension `auto`; off, and
 *     both set, the picture is stretched unless `fit` says otherwise
 *   - `responsive` (default on) caps the box at the container's width so a
 *     300px logo is 300px on a desktop and the screen's width on a phone
 *   - `align` is a block alignment — the element becomes `display:block`
 *     with auto margins — because inline alignment of a picture depends on
 *     the text around it and never quite lands where the author pointed
 *   - `css` is appended last, sanitised, so it can override anything above
 */
export function mediaDisplayDeclarations(d: MediaDisplay | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!d) return out;
  const len = (v: string | number | undefined): string | undefined =>
    v === undefined || v === null || v === "" ? undefined : typeof v === "number" ? `${v}px` : /^\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}px` : v.trim();
  const w = len(d.width), h = len(d.height), mw = len(d.maxWidth), mh = len(d.maxHeight);
  if (w) out.width = w;
  if (h) out.height = h;
  if (d.keepRatio !== false) {
    if (w && !h) out.height = "auto";
    if (h && !w) out.width = "auto";
  }
  if (mw) out["max-width"] = mw;
  else if (d.responsive !== false) out["max-width"] = "100%";
  if (mh) out["max-height"] = mh;
  if (d.fit) out["object-fit"] = d.fit;
  if (d.align) {
    out.display = "block";
    out["margin-left"] = d.align === "left" ? "0" : "auto";
    out["margin-right"] = d.align === "right" ? "0" : "auto";
  }
  if (d.css) {
    for (const decl of sanitizeCss(d.css).split(";")) {
      const i = decl.indexOf(":");
      if (i <= 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      if (/^[a-z-]+$/.test(prop) && val) out[prop] = val;
    }
  }
  return out;
}

/** The same declarations as one `style` attribute value. */
export function mediaDisplayCss(d: MediaDisplay | null | undefined): string {
  return Object.entries(mediaDisplayDeclarations(d)).map(([k, v]) => `${k}: ${v}`).join("; ");
}

/** The same declarations as a React style object (`max-width` → `maxWidth`). */
export function mediaDisplayStyle(d: MediaDisplay | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(mediaDisplayDeclarations(d))) {
    out[k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

/**
 * The declarations read back from a `style` attribute — what the editor needs
 * to reopen a picture it inserted earlier with the controls showing what was
 * chosen. Only the properties the controls own come back; anything else is
 * kept verbatim in `css`, so a hand-written declaration survives a round trip.
 */
export function mediaDisplayFromCss(style: string | null | undefined): MediaDisplay {
  const d: MediaDisplay = {};
  const extra: string[] = [];
  let sawMaxWidth = false;
  let sawAlign = false;
  for (const decl of (style ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i <= 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    switch (prop) {
      case "width": if (val !== "auto") d.width = val; break;
      case "height": if (val !== "auto") d.height = val; break;
      case "max-width": sawMaxWidth = true; if (val !== "100%") d.maxWidth = val; break;
      case "max-height": d.maxHeight = val; break;
      case "object-fit": d.fit = val as MediaDisplay["fit"]; break;
      case "display": if (val === "block") sawAlign = true; else extra.push(`${prop}: ${val}`); break;
      case "margin-left": if (val === "0") d.align = "left"; break;
      case "margin-right": if (val === "0") d.align = "right"; break;
      default: extra.push(`${prop}: ${val}`);
    }
  }
  if (sawAlign && !d.align) d.align = "center";
  if (!sawMaxWidth) d.responsive = false;
  if (extra.length) d.css = extra.join("; ");
  return d;
}

export type InsertableMediaKind = "image" | "video" | "audio";

/**
 * THE MARKUP A PICTURE OR PLAYER INSERTED INTO RICH TEXT CARRIES.
 *
 * Built here, from the same display object the controls edit, so the HTML
 * tab of the editor shows exactly what the controls mean and the sanitiser
 * (which keeps `style`, `width`, `controls`, `autoplay`, `muted`, `loop`,
 * `poster`, `playsinline`, and strips scripts and handlers) lets it through
 * unchanged. Every attribute value is escaped; the URL is escaped and never
 * allowed to be a script scheme.
 */
export function mediaHtml(kind: InsertableMediaKind, url: string, d: MediaDisplay | null | undefined, opts: { alt?: string; mimeType?: string } = {}): string {
  const safeUrl = /^\s*(javascript|vbscript|data\s*:\s*(?!image\/))/i.test(url) ? "#" : url;
  const style = mediaDisplayCss(kind === "audio" ? { ...(d ?? {}), fit: undefined, height: undefined, maxHeight: undefined } : d);
  const styleAttr = style ? ` style="${escapeHtml(style)}"` : "";
  const media = ` data-rs-media="${kind}"`;
  if (kind === "image") {
    return `<img src="${escapeHtml(safeUrl)}" alt="${escapeHtml(opts.alt ?? "")}"${styleAttr}${media}>`;
  }
  const flags = [
    d?.controls === false ? "" : " controls",
    d?.autoplay ? " autoplay" : "",
    d?.muted || (kind === "video" && d?.autoplay) ? " muted" : "",
    d?.loop ? " loop" : "",
    kind === "video" ? " playsinline" : "",
    kind === "video" && d?.poster ? ` poster="${escapeHtml(d.poster)}"` : "",
  ].join("");
  const source = opts.mimeType ? `<source src="${escapeHtml(safeUrl)}" type="${escapeHtml(opts.mimeType)}">` : "";
  return `<${kind} src="${escapeHtml(safeUrl)}"${flags} preload="metadata"${styleAttr}${media}>${source}</${kind}>`;
}
