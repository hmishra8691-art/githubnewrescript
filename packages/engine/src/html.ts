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
/*
 * INLINE CSS IS ALLOWED — it is how a sized picture, a centred option or a
 * coloured word is written — but a few constructions inside a `style`
 * attribute are executable or exfiltrating in some engines and never
 * legitimate formatting: `url(javascript:…)`, `url(data:text/html…)`,
 * IE's `behavior:` and `expression()`, Gecko's `-moz-binding`, and
 * `@import`. `sanitizeCss` removes those declarations and nothing else, so
 * the "custom CSS" a researcher types keeps working.
 */
const STYLE_ATTR = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
const CSS_BLOCKED = /(behavior|-moz-binding)\s*:[^;]*;?|@import[^;]*;?|url\s*\(\s*["']?\s*(javascript|vbscript|data\s*:\s*(?!image\/))[^)]*\)|expression\s*\([^)]*\)/gi;

/** A declaration list (`a: b; c: d`) with the executable constructions removed. */
export function sanitizeCss(css: string | null | undefined): string {
  if (!css) return "";
  let out = css;
  for (let i = 0; i < 3; i++) {
    const before = out;
    out = out.replace(CSS_BLOCKED, "");
    if (out === before) break;
  }
  // a declaration list, not a stylesheet: braces and comments have no business here
  return out.replace(/\/\*[\s\S]*?\*\//g, "").replace(/[{}]/g, "").replace(/\s+/g, " ").replace(/;\s*;/g, ";").trim().replace(/;$/, "");
}

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
/* a script's body is code, not text: removed with its tags, not left behind as "alert(1)" */
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
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
      .replace(SCRIPT_BLOCK, "")
      .replace(BLOCKED_TAGS, "")
      .replace(EVENT_HANDLERS, "")
      .replace(JS_URLS, '$1=$2#$2')
      .replace(STYLE_EXPRESSION, "blocked(")
      .replace(STYLE_ATTR, (_m, _q, dq, sq) => {
        const clean = sanitizeCss(dq ?? sq ?? "");
        return clean ? ` style="${clean.replace(/"/g, "'")}"` : "";
      });
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
  /*
   * A picture stands for its alt text — an option that is only a logo reads
   * as the brand's name in a block list, a logic summary or an export, not
   * as an empty string.
   */
  const stripped = stripMsoArtifacts(html);
  if (/<img\b/i.test(stripped)) {
    const withAlts = stripped.replace(/<img\b[^>]*\balt\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (_m, _q, dq, sq) => ` ${dq ?? sq ?? ""} `);
    return withAlts.replace(ANY_TAG, "").replace(/\s+/g, " ").trim();
  }
  return stripped.replace(ANY_TAG, "").trim();
}
