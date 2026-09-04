/**
 * One place that decides what a media URL IS and how it is rendered.
 *
 * A programmer pastes whatever they have — a YouTube watch link, a Google
 * Drive share link, a CDN image with a signed query string, an mp4 — into the
 * media field of a question, an option or a block. Every renderer used to make
 * its own guess (an `<img>` for anything, mostly), so a YouTube link showed as
 * a broken image. Now every renderer asks `resolveMediaUrl()` and gets back a
 * normalised description: the provider, the kind of element to render and the
 * exact URL to give it.
 *
 * Safety is part of the same decision. Only known providers are embedded in an
 * iframe (an iframe to an arbitrary host is a phishing surface inside the
 * survey), `javascript:` and non-image `data:` URLs are refused outright, and
 * anything unrecognised is returned as `kind: "unsupported"` with a reason the
 * Studio can show — never silently rendered as something else.
 *
 * Pure and dependency-free so the Studio, the runtime, the exporters and the
 * linter all share it.
 */

export type MediaKind = "image" | "video" | "embed" | "unsupported";

export interface ResolvedMedia {
  /** what the renderer should build */
  kind: MediaKind;
  /** "youtube" | "vimeo" | "google_drive" | "direct" | "data" | "unknown" */
  provider: string;
  /** the URL to hand the element (`src`); absent when unsupported */
  url?: string;
  /** provider-specific id where there is one (YouTube video id, Drive file id) */
  id?: string;
  /** `video/mp4` etc. for direct video */
  mimeType?: string;
  /** why this URL cannot be rendered — for the Studio's inline message */
  reason?: string;
  /** a human note the renderer may show under an embed (e.g. Drive sharing) */
  note?: string;
  /** the input, trimmed */
  original: string;
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|bmp)$/i;
const VIDEO_EXT: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogg: "video/ogg", ogv: "video/ogg", mov: "video/quicktime",
};

/** Hosts we are willing to put in an iframe. Anything else is never embedded. */
export const EMBED_ALLOWLIST: readonly string[] = [
  "www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "youtu.be", "m.youtube.com",
  "player.vimeo.com", "vimeo.com",
  "drive.google.com", "docs.google.com",
];

export function resolveMediaUrl(input: string | null | undefined): ResolvedMedia {
  const original = (input ?? "").trim();
  if (!original) return { kind: "unsupported", provider: "unknown", reason: "No media URL.", original };

  // --- refuse the dangerous schemes before parsing anything -------------
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(original)?.[1]?.toLowerCase();
  if (scheme === "javascript" || scheme === "vbscript" || scheme === "file") {
    return { kind: "unsupported", provider: "unknown", reason: `“${scheme}:” URLs are not allowed in media.`, original };
  }
  if (scheme === "data") {
    // an inline image is fine (the Studio's preview uses them); anything else is not
    const m = /^data:(image\/(?:png|jpe?g|gif|webp|avif|svg\+xml));/i.exec(original);
    if (m) return { kind: "image", provider: "data", url: original, mimeType: m[1].toLowerCase(), original };
    return { kind: "unsupported", provider: "data", reason: "Only image data: URLs are allowed.", original };
  }
  if (scheme === "blob") return { kind: "image", provider: "data", url: original, original };

  // relative and protocol-relative URLs are direct assets on our own host
  let u: URL;
  try {
    u = new URL(original, "https://rescript.local/");
  } catch {
    return { kind: "unsupported", provider: "unknown", reason: "Not a valid URL.", original };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { kind: "unsupported", provider: "unknown", reason: `“${u.protocol}” URLs are not allowed in media.`, original };
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  // --- YouTube ------------------------------------------------------------
  const yt = youtubeId(host, path, u.searchParams);
  if (yt) {
    const start = u.searchParams.get("t") ?? u.searchParams.get("start");
    const qs = new URLSearchParams({ rel: "0" });
    const secs = parseStart(start);
    if (secs) qs.set("start", String(secs));
    return { kind: "embed", provider: "youtube", id: yt, url: `https://www.youtube-nocookie.com/embed/${yt}?${qs}`, original };
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") {
    return { kind: "unsupported", provider: "youtube", reason: "This YouTube link has no video id — paste the link of a single video.", original };
  }

  // --- Vimeo --------------------------------------------------------------
  if (host === "vimeo.com" || host === "www.vimeo.com" || host === "player.vimeo.com") {
    const m = /\/(?:video\/)?(\d+)(?:\/|$)/.exec(path);
    if (m) return { kind: "embed", provider: "vimeo", id: m[1], url: `https://player.vimeo.com/video/${m[1]}`, original };
    return { kind: "unsupported", provider: "vimeo", reason: "This Vimeo link has no video id.", original };
  }

  // --- Google Drive -------------------------------------------------------
  if (host === "drive.google.com" || host === "docs.google.com") {
    const id = driveId(path, u.searchParams);
    if (id) {
      return {
        kind: "embed", provider: "google_drive", id,
        url: `https://drive.google.com/file/d/${id}/preview`,
        note: "Google Drive files must be shared as “Anyone with the link can view” to appear for respondents.",
        original,
      };
    }
    return { kind: "unsupported", provider: "google_drive", reason: "This Google Drive link has no file id — use the file's “Share → Copy link”.", original };
  }

  // --- direct files: decide by the path's extension, query string ignored --
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext && VIDEO_EXT[ext]) {
    return { kind: "video", provider: "direct", url: original, mimeType: VIDEO_EXT[ext], original };
  }
  if (IMAGE_EXT.test(path)) {
    return { kind: "image", provider: "direct", url: original, original };
  }
  // an explicit type hint on the URL (`?format=jpg`, `&type=image`) — CDNs do this
  const hinted = (u.searchParams.get("format") ?? u.searchParams.get("fm") ?? u.searchParams.get("type") ?? "").toLowerCase();
  if (/^(jpe?g|png|gif|webp|avif|image)$/.test(hinted)) {
    return { kind: "image", provider: "direct", url: original, original };
  }

  // an http(s) URL with no extension: most likely an image served by a CDN
  // (signed URLs, `/image/upload/...`, `photos/123`). Render it as one; the
  // renderer's onError shows "Unable to load image" when it is not.
  return { kind: "image", provider: "direct", url: original, original };
}

/** True when `resolveMediaUrl` would render something. */
export function isRenderableMedia(input: string | null | undefined): boolean {
  return resolveMediaUrl(input).kind !== "unsupported";
}

/** Whether the resolved embed is on a host we allow in an iframe. */
export function isAllowedEmbed(url: string): boolean {
  try {
    return EMBED_ALLOWLIST.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function youtubeId(host: string, path: string, qs: URLSearchParams): string | null {
  const valid = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null);
  if (host === "youtu.be") return valid(path.split("/")[1]);
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")) {
    if (path === "/watch" || path === "/watch/") return valid(qs.get("v"));
    const m = /^\/(?:embed|shorts|v|live|e)\/([A-Za-z0-9_-]+)/.exec(path);
    if (m) return valid(m[1]);
    // /watch/ID (rare) and attribution links carrying ?u=/watch?v=ID
    const m2 = /^\/watch\/([A-Za-z0-9_-]+)/.exec(path);
    if (m2) return valid(m2[1]);
    const u = qs.get("u");
    if (u) {
      const v = /[?&]v=([A-Za-z0-9_-]+)/.exec(u);
      if (v) return valid(v[1]);
    }
  }
  return null;
}

function driveId(path: string, qs: URLSearchParams): string | null {
  const valid = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null);
  const m = /\/file\/d\/([A-Za-z0-9_-]+)/.exec(path);
  if (m) return valid(m[1]);
  if (/^\/(open|uc|thumbnail)\/?$/.test(path)) return valid(qs.get("id"));
  const m2 = /\/(?:document|presentation|spreadsheets)\/d\/([A-Za-z0-9_-]+)/.exec(path);
  if (m2) return valid(m2[1]);
  return null;
}

function parseStart(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
