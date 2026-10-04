import type { MediaDisplay } from "@rescript/schema";
import { escapeHtml, sanitizeCss } from "./html.js";
import { isAllowedEmbed, resolveMediaUrl } from "./media.js";

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
  const pad = len(d.padding), gap = len(d.spacing);
  if (pad) out.padding = pad;
  if (gap) { out["margin-top"] = gap; out["margin-bottom"] = gap; }
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
  let mt: string | undefined, mb: string | undefined;
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
      case "padding": d.padding = val; break;
      case "margin-top": mt = val; break;
      case "margin-bottom": mb = val; break;
      case "margin-left": if (val === "0") d.align = "left"; break;
      case "margin-right": if (val === "0") d.align = "right"; break;
      default: extra.push(`${prop}: ${val}`);
    }
  }
  /* "spacing" is the same space above and below; one-sided margins stay custom CSS */
  if (mt !== undefined && mt === mb) d.spacing = mt;
  else {
    if (mt !== undefined) extra.push(`margin-top: ${mt}`);
    if (mb !== undefined) extra.push(`margin-bottom: ${mb}`);
  }
  if (sawAlign && !d.align) d.align = "center";
  if (!sawMaxWidth) d.responsive = false;
  if (extra.length) d.css = extra.join("; ");
  return d;
}

/** what the Insert-media dialog can put into rich text; `embed` is a YouTube / Vimeo / Google Drive player */
export type InsertableMediaKind = "image" | "video" | "audio" | "embed";

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
  if (kind === "embed") {
    /*
     * A PLAYER IN TEXT, WITHOUT AN IFRAME IN THE STORED HTML.
     *
     * Rich text never keeps an <iframe> (the sanitiser removes every one), so
     * a YouTube, Vimeo or Drive player is stored as a placeholder naming its
     * URL, and the renderer turns it into the player at display time — only
     * for a URL the engine recognises as one of those players
     * (`expandMediaEmbeds`). In the editor it is a labelled box that can be
     * clicked to edit, like a picture.
     */
    const label = opts.alt?.trim() || "Embedded video";
    return `<div class="rs-embed-slot" contenteditable="false" data-rs-src="${escapeHtml(safeUrl)}"${styleAttr}${media}>▶ ${escapeHtml(label)}</div>`;
  }
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

const EMBED_SLOT = /<div\b(?=[^>]*\bdata-rs-media\s*=\s*["']embed["'])[^>]*>[\s\S]*?<\/div>/gi;
const EMPTY_SRC_MEDIA = /<(img|video|audio)\b(?=[^>]*\bsrc\s*=\s*(""|''))[^>]*>(?:\s*<\/\1>)?/gi;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? "") : null;
}

/** `&amp;` → `&` — for a value that was escaped for HTML and is about to be used as a URL. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" } as Record<string, string>)[e]);
}

/**
 * RICH TEXT AS THE RESPONDENT SEES IT — after piping and sanitising.
 *
 *   - an embed placeholder (`mediaHtml("embed", …)`) becomes the player, with
 *     its size and alignment, when its URL is a YouTube / Vimeo / Google Drive
 *     player URL; anything else is removed rather than framed
 *   - a picture or player whose source piped to nothing (`src="{{ImageURL}}"`
 *     for a respondent who arrived without the parameter) is removed, instead
 *     of showing a broken-image icon
 *
 * Runs AFTER `sanitizeHtml`: the only frame that can appear is the one built
 * here, from a URL `resolveMediaUrl` accepted.
 */
export function expandMediaEmbeds(html: string): string {
  if (!html || !html.includes("data-rs-media") && !/src\s*=\s*(""|'')/.test(html)) return html;
  return html
    .replace(EMBED_SLOT, (slot) => {
      const open = slot.slice(0, slot.indexOf(">") + 1);
      const raw = unescapeHtml(attr(open, "data-rs-src") ?? "").trim();
      if (!raw) return "";
      const m = resolveMediaUrl(raw);
      if (m.kind !== "embed" || !m.url || !isAllowedEmbed(m.url)) return "";
      const style = attr(open, "style");
      const label = slot.slice(open.length).replace(/<[^>]*>/g, "").replace(/^\s*▶\s*/, "").trim();
      return `<div class="rs-embed-frame rs-embed-inline" data-rs-media="embed"${style ? ` style="${escapeHtml(unescapeHtml(style))}"` : ""}>` +
        `<iframe src="${escapeHtml(m.url)}" title="${escapeHtml(label || `${m.provider ?? "embedded"} media`)}" ` +
        `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen ` +
        `referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" loading="lazy"></iframe></div>`;
    })
    .replace(EMPTY_SRC_MEDIA, "");
}
