import { sanitizeHtml, sanitizeStylesheet } from "./html.js";
import { expandMediaEmbeds } from "./mediaDisplay.js";

/**
 * AN AUTHOR'S HTML AND CSS, DRAWN AS WRITTEN AND KEPT TO ITS QUESTION
 * (October 2026 review, "Content / Hidden → Text / HTML Block" and "Question
 * Text → Rich Text / HTML").
 *
 * Two faults, one cause. A `<style>` written into the question text was
 * deleted (the sanitizer took every style block for Word residue), so a chess
 * board built from `.chess-board { display: grid }` fell apart into one
 * column; and a style written into the HTML Content field was kept but
 * applied to the whole page, so `body { display: flex }` re-laid the preview
 * around the question. The fix is one function both paths use:
 *
 *   - the document wrapper a pasted page brings (`<!DOCTYPE>`, `<html>`,
 *     `<head>`, `<body>`, `<title>`) is unwrapped — its content stays;
 *   - every `<style>` is made safe (`sanitizeStylesheet`) and each of its
 *     rules is scoped under the question's own container, so `body`, `html`,
 *     `:root` and `*` mean "this question", and `.square` means "a .square in
 *     this question" — never another question, never the survey chrome.
 *
 * Pure, dependency-free, the same in the Studio's editor, the preview, Test
 * Survey and the live runtime.
 */

/** The attribute the scoped container carries; its value names the scope. */
export const SCOPE_ATTR = "data-rs-scope";

export function scopeSelectorFor(id: string): string {
  return `[${SCOPE_ATTR}="${String(id).replace(/["\\]/g, "")}"]`;
}

const DOC_WRAPPERS = /<!doctype[^>]*>|<\/?html\b[^>]*>|<\/?head\b[^>]*>|<\/?body\b[^>]*>|<title\b[^>]*>[\s\S]*?<\/title\s*>/gi;
const STYLE_ELEMENT = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;

/** Does this content carry a stylesheet of its own? */
export function hasStyleBlock(html: string | null | undefined): boolean {
  return !!html && /<style\b/i.test(html);
}

/** The pasted page's wrapper removed, its content kept. */
export function unwrapDocument(html: string): string {
  return html.includes("<") ? html.replace(DOC_WRAPPERS, "") : html;
}

/**
 * The content ready to draw inside an element carrying
 * `data-rs-scope="<scopeId>"`: unwrapped, every stylesheet safe and scoped.
 */
export function prepareRichHtml(html: string, scopeId: string): string {
  if (!html || !html.includes("<")) return html;
  const scope = scopeSelectorFor(scopeId);
  return unwrapDocument(html).replace(STYLE_ELEMENT, (_m, open: string, css: string, close: string) =>
    `${open}${scopeAuthorCss(css, scope)}${close}`);
}

/**
 * THE ONE PIPELINE for a question's own rich content — its text, its
 * instruction, a Text / HTML block — at render: sanitised (keeping the
 * author's stylesheets), unwrapped and scoped, then players placed and
 * pictures that piped to nothing dropped. The Studio's preview, Test Survey
 * and the live survey all draw through this.
 */
export function renderRichContent(html: string, scopeId: string, opts: { allowFrames?: boolean } = {}): string {
  if (!html || !html.includes("<")) return html;
  return expandMediaEmbeds(prepareRichHtml(sanitizeHtml(html, { keepStyles: true, allowFrames: opts.allowFrames }), scopeId));
}

/* ------------------------------------------------------------- the scoper */

/** At-rules whose block holds rules, scoped in turn. */
const NESTING_AT = /^@(media|supports|container|layer|document)\b/i;
/** At-rules whose block is not rules (or not the author's elements) — kept as they are. */
const OPAQUE_AT = /^@(keyframes|-webkit-keyframes|font-face|page|counter-style|property|font-feature-values)\b/i;

/**
 * Every rule of a stylesheet prefixed with `scope`. A small character scanner
 * rather than a regex, so braces in strings, `:is(a, b)`, attribute
 * selectors and nested `@media` blocks are read as what they are.
 */
export function scopeAuthorCss(css: string, scope: string): string {
  const clean = sanitizeStylesheet(css).replace(/\/\*[\s\S]*?\*\//g, "");
  return scopeBlock(clean, scope);
}

/*
 * Not `ux.ts`'s `scopeCss`. That one is strict on purpose — it scopes styles
 * Intelligent mode writes, refuses `body`, nested rules and @font-face, and
 * checks every declaration. An author pasting a page is owed the opposite:
 * everything layout-related kept, `body` read as "this question".
 */

/**
 * THE STUDIO'S DEVICE PREVIEW NARROWS A BOX, NOT THE WINDOW — a `@media
 * (max-width: 600px)` written for phones would never apply in the Mobile
 * preview. Such a block's rules are also emitted under the preview's device
 * class (`.rs-viewport.mobile`, 390px wide; `.rs-viewport.tablet`, 768px), as
 * `ux.ts` does for its own styles, so Desktop / Tablet / Mobile in the
 * preview look like the devices.
 */
const DEVICE_WIDTH: [string, number][] = [["mobile", 390], ["tablet", 768]];
function deviceHoist(prelude: string, rules: string): string {
  const m = /^@media\s*(?:screen\s+and\s*)?\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)\s*$/i.exec(prelude.trim());
  if (!m) return "";
  const max = Number(m[1]);
  const devices = DEVICE_WIDTH.filter(([, w]) => w <= max).map(([d]) => d);
  if (!devices.length) return "";
  return rules.replace(/([^{}]+)\{([^{}]*)\}/g, (_x, sel: string, body: string) =>
    `${splitSelectors(sel).flatMap((x) => devices.map((d) => `.rs-viewport.${d} ${x}`)).join(", ")} {${body}}`);
}

function scopeBlock(css: string, scope: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    // whitespace between rules is kept as one space
    const ws = /^\s+/.exec(css.slice(i));
    if (ws) { out += ws[0].includes("\n") ? "\n" : " "; i += ws[0].length; continue; }
    const brace = findTopLevel(css, i, "{");
    const semi = findTopLevel(css, i, ";");
    // a statement at-rule (`@charset …;`, `@import …;` was removed by sanitizeStylesheet)
    if (semi !== -1 && (brace === -1 || semi < brace)) {
      const stmt = css.slice(i, semi + 1).trim();
      if (!/^@(charset|namespace)\b/i.test(stmt)) out += stmt;
      i = semi + 1;
      continue;
    }
    if (brace === -1) break; // trailing text with no block: not a rule
    const prelude = css.slice(i, brace).trim();
    const close = matchBrace(css, brace);
    const body = css.slice(brace + 1, close === -1 ? css.length : close);
    i = close === -1 ? css.length : close + 1;
    if (!prelude) continue;
    if (prelude.startsWith("@")) {
      if (NESTING_AT.test(prelude)) {
        const inner = scopeBlock(body, scope);
        out += `${prelude} {${inner}}${deviceHoist(prelude, inner)}`;
      }
      else if (OPAQUE_AT.test(prelude)) out += `${prelude} {${body}}`;
      // any other at-rule is dropped rather than guessed at
      continue;
    }
    out += `${scopeSelectorList(prelude, scope)} {${body}}`;
  }
  return out;
}

/** The index of `ch` at depth 0 (outside (), [], strings), or -1. */
function findTopLevel(s: string, from: number, ch: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ch) return i;
    if (c === "{" && ch !== "{") return -1; // a block starts before the statement ends
  }
  return -1;
}

/** The `}` that closes the `{` at `open`, or -1. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** `a, b:is(c, d)` split on its top-level commas. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** The page's root, as the author wrote it: html, body, :root — in any combination at the start. */
const ROOT_PREFIX = /^(?:(?:html|body|:root)(?![\w-])\s*)+/i;

export function scopeSelectorList(list: string, scope: string): string {
  return splitSelectors(list).map((sel) => {
    if (sel.startsWith(scope)) return sel;
    const root = ROOT_PREFIX.exec(sel);
    if (root) {
      const rest = sel.slice(root[0].length).trim();
      // `body` alone is the question's box; `body .x` is a .x inside it
      return rest ? `${scope} ${rest.replace(/^>\s*/, "> ")}` : scope;
    }
    return `${scope} ${sel}`;
  }).join(", ");
}
