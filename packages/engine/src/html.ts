/**
 * HTML safety for programmer-authored formatted content (req §15).
 *
 * Two distinct trust levels:
 *  - Definition content (question text, option labels) is programmer-authored.
 *    It may legitimately contain formatting HTML, so it is SANITIZED — script
 *    vectors removed, formatting preserved.
 *  - Respondent-derived values piped back into text (answers, calculations,
 *    embedded URL data) are UNTRUSTED and are HTML-ESCAPED entirely, so a
 *    respondent typing "<img onerror=…>" can never execute in a later page.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BLOCKED_TAGS = /<\s*\/?\s*(script|iframe|object|embed|form|meta|link|base)\b[^>]*>/gi;
const EVENT_HANDLERS = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URLS = /(href|src|xlink:href|formaction|action)\s*=\s*(["']?)\s*(javascript|vbscript|data\s*:\s*text\/html)[^"'\s>]*\2/gi;
const STYLE_EXPRESSION = /expression\s*\(/gi;

/**
 * Microsoft Word paste residue.
 *
 * Copying from Word into a contentEditable surface brings along its
 * compatibility/proofing-language metadata — `<!--[if gte mso 9]><xml>
 * <w:WordDocument><w:View>Normal</w:View><w:Zoom>0</w:Zoom>…
 * <w:SaveIfXMLInvalid>false</w:SaveIfXMLInvalid>…
 * <w:LidThemeAsian>TH</w:LidThemeAsian>…</w:WordDocument></xml><![endif]-->`
 * plus an `mso-*` `<style>` block — wrapped in tags a browser treats as
 * perfectly ordinary (unlike `<script>`/`<style>` for scripts), so a plain
 * "strip every `<tag>`" pass deletes the delimiters and leaves their TEXT
 * CONTENT ("Normal 0 false false false EN-US X-NONE TH", literally the
 * values of those `<w:*>` elements) sitting there as visible garbage. These
 * three block kinds are never legitimate question-text formatting, so they
 * are removed whole — tag and enclosed payload together — rather than
 * unwrapped into plain text.
 */
const MSO_CONDITIONAL_COMMENT = /<!--\s*\[if[\s\S]*?<!\[endif\]\s*-->/gi;
const MSO_XML_ISLAND = /<xml[^>]*>[\s\S]*?<\/xml>/gi;
const STYLE_BLOCK = /<style[^>]*>[\s\S]*?<\/style>/gi;
const ANY_TAG = /<[^>]*>/g;

function stripMsoArtifacts(html: string): string {
  if (!html || !html.includes("<")) return html;
  return html
    .replace(MSO_CONDITIONAL_COMMENT, "")
    .replace(MSO_XML_ISLAND, "")
    .replace(STYLE_BLOCK, "");
}

/**
 * Strip script vectors from formatting HTML while keeping legitimate markup.
 * Regex-based by design: dependency-free, works identically in the editor,
 * on the server and in the runtime. Applied on save in the rich-text editor
 * and again at render time (defence in depth).
 *
 * Also strips Word/MSO paste residue (see `stripMsoArtifacts`) — not an XSS
 * vector, but never legitimate content either, and this is the one function
 * every rich-text save path already runs through, so it's the input-time
 * fix that stops the artifact from ever being stored in the first place.
 */
export function sanitizeHtml(html: string): string {
  if (!html || !html.includes("<")) return html;
  let out = html;
  // iterate until stable so nested/overlapping payloads can't re-emerge
  for (let i = 0; i < 5; i++) {
    const before = out;
    out = stripMsoArtifacts(out)
      .replace(BLOCKED_TAGS, "")
      .replace(EVENT_HANDLERS, "")
      .replace(JS_URLS, '$1=$2#$2')
      .replace(STYLE_EXPRESSION, "blocked(");
    if (out === before) break;
  }
  return out;
}

/**
 * Plain-text preview of programmer-authored rich content — block lists,
 * navigators, pickers, autocomplete, logic summaries. Unlike `sanitizeHtml`,
 * the goal here is a short label, not preserved formatting, so every
 * remaining tag is removed rather than kept; unlike a naive
 * `s.replace(/<[^>]*>/g, "")`, it also drops Word/MSO paste residue whole
 * (see `stripMsoArtifacts`) instead of leaving its enclosed text behind —
 * which is what makes this safe to use even for already-stored content that
 * predates the `sanitizeHtml` input-time fix, with no data rewrite needed.
 */
export function stripHtmlText(html: string | null | undefined): string {
  if (!html) return "";
  return stripMsoArtifacts(html).replace(ANY_TAG, "").trim();
}
