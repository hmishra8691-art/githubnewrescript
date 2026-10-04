import type { Question } from "@rescript/schema";
import { questionMediaList } from "./carryforward.js";
import { mediaHtml, type InsertableMediaKind } from "./mediaDisplay.js";
import { resolveMediaUrl } from "./media.js";

/**
 * THE OLD "MEDIA SHOWN UNDER THE QUESTION TEXT", AS QUESTION-TEXT MARKUP.
 *
 * The 1-10-26 review folded that separate field into Insert media. Questions
 * written before it still carry `settings.mediaUrl` / `mediaItems` (and the
 * renderer still draws them, unchanged); the Studio offers to move them into
 * the text, where each item gets its own size and alignment. This is the
 * markup that move produces: every item, in order, with the question's one
 * `mediaDisplay` applied to each, a YouTube / Vimeo / Drive link as a player,
 * and "side by side" kept as a wrapping row. A piped URL (`{{ImageURL}}`)
 * stays piped.
 */
export function legacyQuestionMediaHtml(q: Pick<Question, "settings">): string {
  const items = questionMediaList(q);
  if (!items.length) return "";
  const html = items.map((m) => {
    const url = m.url.trim();
    const r = resolveMediaUrl(url);
    const kind: InsertableMediaKind = /\{\{[^}]+\}\}/.test(url)
      ? "image"
      : r.kind === "embed" ? "embed"
      : r.kind === "video" ? (r.mimeType?.startsWith("audio/") ? "audio" : "video")
      : "image";
    return mediaHtml(kind, url, q.settings.mediaDisplay, { alt: m.alt ?? m.title ?? "", mimeType: kind === "audio" || kind === "video" ? r.mimeType : undefined });
  }).join("");
  return q.settings.mediaLayout === "horizontal" && items.length > 1
    ? `<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start">${html}</div>`
    : `<div>${html}</div>`;
}
