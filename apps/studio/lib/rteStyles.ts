import { scopeAuthorCss } from "@rescript/engine";

/**
 * AN AUTHOR'S `<style>` IN THE VISUAL EDITOR (October 2026 review).
 *
 * The question text keeps its stylesheet now (`sanitizeHtml({ keepStyles })`),
 * and the respondent's view scopes it to the question. The Studio's visual
 * editor is a contentEditable surface in the Studio's own page, so a raw
 * `<style>` there would restyle the Studio — `body { display: flex }` would
 * re-lay the whole builder. So while the text is in the surface, each sheet
 * is shown SCOPED to that surface, and the author's original travels with it
 * in a data attribute; reading the surface back restores the original
 * exactly. What is saved is always what the author wrote.
 */
export const RTE_SCOPE_ATTR = "data-rte-scope";
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const SURFACE_STYLE = /<style\b[^>]*\bdata-rte-src="([^"]*)"[^>]*>[\s\S]*?<\/style\s*>/gi;

export function surfaceHtml(html: string, scopeId: string): string {
  if (!html || !/<style\b/i.test(html)) return html;
  const scope = `[${RTE_SCOPE_ATTR}="${scopeId.replace(/["\\]/g, "")}"]`;
  return html.replace(STYLE, (m, css: string) => (/data-rte-src=/.test(m) ? m
    : `<style data-rte-src="${encodeURIComponent(css)}">${scopeAuthorCss(css, scope)}</style>`));
}

export function restoreSurfaceHtml(html: string): string {
  if (!html || !html.includes("data-rte-src")) return html;
  return html.replace(SURFACE_STYLE, (_m, src: string) => {
    let css = "";
    try { css = decodeURIComponent(src); } catch { css = ""; }
    return `<style>${css}</style>`;
  });
}
