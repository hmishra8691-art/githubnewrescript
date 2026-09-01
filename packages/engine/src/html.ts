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
 * Strip script vectors from formatting HTML while keeping legitimate markup.
 * Regex-based by design: dependency-free, works identically in the editor,
 * on the server and in the runtime. Applied on save in the rich-text editor
 * and again at render time (defence in depth).
 */
export function sanitizeHtml(html: string): string {
  if (!html || !html.includes("<")) return html;
  let out = html;
  // iterate until stable so nested/overlapping payloads can't re-emerge
  for (let i = 0; i < 5; i++) {
    const before = out;
    out = out
      .replace(BLOCKED_TAGS, "")
      .replace(EVENT_HANDLERS, "")
      .replace(JS_URLS, '$1=$2#$2')
      .replace(STYLE_EXPRESSION, "blocked(");
    if (out === before) break;
  }
  return out;
}
