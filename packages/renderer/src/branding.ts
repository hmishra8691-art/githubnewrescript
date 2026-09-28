import type { Branding } from "@rescript/schema";

/**
 * Branding -> `--rs-*` custom properties, applied to `.rs-shell`.
 *
 * The single source of truth for turning a survey's Branding config into
 * the CSS variables `questions.css` themes off of. Two callers need the
 * EXACT same mapping: the respondent runtime (`Runner.tsx`, which renders
 * the real thing) and the Studio's live theme preview (`BrandingPanel.tsx`,
 * which has to show what the real thing will look like). A preview built
 * from a second, hand-copied implementation is a preview of that
 * implementation's bugs, not of the survey — so this lives in
 * `@rescript/renderer`, a package both apps already depend on, and both
 * import it from here rather than each keeping their own copy.
 *
 * Sept 21 (Advanced Theming): the seven optional colors (accent/heading/
 * link/inputBackground/buttonBackground/buttonText/progress) fall back to a
 * base color — accent to primary, heading to text, link to accent-then-
 * primary, and so on — when the survey hasn't customized them.
 *
 * That fallback is resolved HERE, in JS, not via a `:root { --rs-button-bg:
 * var(--rs-primary); }` chain in the stylesheet. CSS custom properties
 * don't support the "re-resolve against whoever inherits this" behavior
 * that a `:root`-level chain would need: a `var()` inside a custom-property
 * DECLARATION resolves against the cascade of the element the declaration
 * is written on (`:root`), and it is that already-resolved value —
 * `:root`'s own `--rs-primary`, the schema default — that then inherits
 * down, not a live reference re-evaluated at each descendant. A survey that
 * overrides `--rs-primary` on `.rs-shell` but never touches
 * `--rs-button-bg` would therefore still get the DEFAULT button color from
 * `:root`, not its own primary — the opposite of "falls back to primary".
 * (Caught by `scripts/desktop-layout-theming-test.mjs` expecting a themed
 * button and getting `#2563eb`, the un-themed default, back.)
 *
 * So every one of these seven is always present in the returned vars,
 * computed from the same optional-field-or-base logic questions.css's
 * comments describe, and set directly on `.rs-shell` where `--rs-primary`
 * etc. are already known. The `:root` declarations stay in questions.css
 * as the default for the one consumer that never calls this function —
 * Studio's own unthemed Live Question Canvas (`LiveCanvas.tsx`) — where
 * `:root`-resolves-against-`:root` is exactly the (correct, static) answer.
 */
export function brandingVars(b: Branding): Record<string, string> {
  const accent = b.colors.accent ?? b.colors.primary;
  const vars: Record<string, string> = {
    "--rs-primary": b.colors.primary,
    "--rs-secondary": b.colors.secondary,
    "--rs-bg": b.colors.background,
    "--rs-surface": b.colors.surface,
    "--rs-text": b.colors.text,
    "--rs-subtle": b.colors.subtleText,
    "--rs-border": b.colors.border,
    "--rs-error": b.colors.error,
    "--rs-font": b.typography.fontFamily,
    "--rs-base-size": b.typography.baseSize,
    "--rs-heading-weight": String(b.typography.headingWeight),
    "--rs-max-width": b.layout.maxWidth,
    "--rs-radius": b.layout.radius,
    "--rs-gap": b.layout.spacing === "compact" ? "12px" : b.layout.spacing === "relaxed" ? "28px" : "20px",
    /*
     * Alignment (Sept 21): "left"/"right" pin the shell to that edge by
     * zeroing the margin on that side and leaving the other `auto`; "center"
     * is the old unconditional `margin: 0 auto`. Inert while width mode is
     * "full" (nothing left over to shift), and takes effect the moment
     * `maxWidth` actually constrains the shell — "contained" mode, or custom
     * CSS narrowing a "full" survey back down.
     */
    "--rs-align-ml": b.layout.contentAlign === "left" ? "0" : "auto",
    "--rs-align-mr": b.layout.contentAlign === "right" ? "0" : "auto",

    "--rs-accent": accent,
    "--rs-heading": b.colors.heading ?? b.colors.text,
    "--rs-link": b.colors.link ?? accent,
    "--rs-input-bg": b.colors.inputBackground ?? b.colors.surface,
    "--rs-button-bg": b.colors.buttonBackground ?? b.colors.primary,
    "--rs-button-text": b.colors.buttonText ?? "#ffffff",
    "--rs-progress": b.colors.progress ?? accent,
  };
  /*
   * ADVANCED THEMING (Sept 28). Each variable below is emitted ONLY when the
   * survey sets it; questions.css reads every one as `var(--x, <the value it
   * always hard-coded>)`, so a survey that sets none renders byte-for-byte
   * as before.
   */
  const t = b.typography, a = b.appearance;
  const put = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== "" && safeCssValue(String(v))) vars[k] = String(v); };
  put("--rs-heading-font", t.headingFont);
  put("--rs-line-height", t.lineHeight);
  put("--rs-letter-spacing", t.letterSpacing);
  put("--rs-q-size", t.questionSize);
  if (a) {
    if (a.shadow) put("--rs-shadow", SHADOWS[a.shadow]);
    put("--rs-card-pad", a.cardPadding);
    put("--rs-border-w", a.borderWidth);
    put("--rs-option-gap", a.optionGap);
    put("--rs-focus", a.focusColor);
    if (a.selectedTint !== undefined) put("--rs-selected-tint", `${Math.max(0, Math.min(40, a.selectedTint))}%`);
    put("--rs-btn-radius", a.buttonRadius);
    put("--rs-progress-h", a.progressHeight);
    put("--rs-logo-h", a.logoMaxHeight);
  }
  const bg = backgroundLayers(b);
  if (bg) {
    vars["--rs-bg-layers"] = bg;
    vars["--rs-bg-size"] = b.background?.size ?? "cover";
    vars["--rs-bg-position"] = safeCssValue(b.background?.position ?? "") ? b.background!.position : "center";
    vars["--rs-bg-repeat"] = b.background?.repeat ? "repeat" : "no-repeat";
    vars["--rs-bg-attachment"] = b.background?.attachment ?? "fixed";
  }
  return vars;
}

export const SHADOWS: Record<string, string> = {
  none: "none",
  soft: "0 1px 2px rgba(15, 23, 42, .06), 0 1px 3px rgba(15, 23, 42, .08)",
  medium: "0 4px 12px rgba(15, 23, 42, .10), 0 2px 4px rgba(15, 23, 42, .06)",
  strong: "0 12px 32px rgba(15, 23, 42, .18), 0 4px 8px rgba(15, 23, 42, .08)",
};

/** a value that cannot break out of a declaration or load from anywhere but https / an inline image */
export function safeCssValue(v: string): boolean {
  if (/[{};<>\\]/.test(v.replace(/url\([^)]*\)/g, "url()"))) return false;
  if (/expression\s*\(|javascript:|vbscript:|@import/i.test(v)) return false;
  for (const m of v.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) if (!safeImageUrl(m[2])) return false;
  return true;
}
export function safeImageUrl(u: string | undefined): boolean {
  const s = (u ?? "").trim();
  return /^https:\/\/[^\s"'()<>\\]+$/i.test(s) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(s) || /^\/[^\s"'()<>\\]+$/.test(s);
}

/** the page background as CSS layers: overlay over image over gradient — or null when the survey sets none */
export function backgroundLayers(b: Branding): string | null {
  const bg = b.background;
  if (!bg) return null;
  const layers: string[] = [];
  if (bg.overlay && safeCssValue(bg.overlay)) layers.push(`linear-gradient(${bg.overlay}, ${bg.overlay})`);
  if (bg.image && safeImageUrl(bg.image)) layers.push(`url("${bg.image}")`);
  if (bg.gradient && /^(repeating-)?(linear|radial|conic)-gradient\(/i.test(bg.gradient.trim()) && safeCssValue(bg.gradient)) layers.push(bg.gradient.trim());
  return layers.length ? layers.join(", ") : null;
}

/**
 * The shell's appearance classes: `rs-themed` (the shell carries a theme, so
 * it takes the theme's font, size and page background itself — the preview
 * frames need that; the runtime's body gets the same through pageThemeVars),
 * and the option / control / input styles, which select rules rather than
 * supply values.
 */
export function brandingClasses(b: Branding, opts: { pageBackground?: boolean } = {}): string {
  const a = b.appearance;
  // the runtime paints the background on the page itself; a preview frame paints it on the shell
  return ["rs-themed", a?.optionStyle && a.optionStyle !== "default" ? `rs-opt-${a.optionStyle}` : "", a?.controlStyle === "custom" ? "rs-ctl-custom" : "", a?.inputStyle && a.inputStyle !== "outlined" ? `rs-input-${a.inputStyle}` : "", backgroundLayers(b) && !opts.pageBackground ? "rs-has-bg" : ""].filter(Boolean).join(" ");
}

/**
 * The page's own variables, for `<html>`: the runtime's body reads
 * `--rs-bg`, `--rs-font` and `--rs-base-size` from the ROOT, so a survey's
 * background, font and size were set on the shell and never reached the page.
 */
export function pageThemeVars(b: Branding): Record<string, string> {
  const v = brandingVars(b);
  const out: Record<string, string> = {};
  for (const k of ["--rs-bg", "--rs-text", "--rs-font", "--rs-base-size", "--rs-line-height", "--rs-bg-layers", "--rs-bg-size", "--rs-bg-position", "--rs-bg-repeat", "--rs-bg-attachment"]) if (v[k]) out[k] = v[k];
  return out;
}

/**
 * PER-DEVICE OVERRIDES as a stylesheet: the real breakpoints, and the
 * runtime's and Studio's device previews (which narrow a box, not the
 * window). `scope` is a selector for this survey's shell.
 */
export function brandingResponsiveCss(b: Branding, scope: string): string {
  const r = b.responsive;
  if (!r) return "";
  const block = (o: NonNullable<typeof r.mobile>) => {
    const d: string[] = [];
    const put = (k: string, v?: string) => { if (v && safeCssValue(v)) d.push(`${k}:${v}`); };
    put("--rs-base-size", o.baseSize); put("--rs-max-width", o.maxWidth); put("--rs-card-pad", o.cardPadding); put("--rs-option-gap", o.optionGap); put("--rs-radius", o.radius); put("--rs-q-size", o.questionSize);
    if (o.baseSize && safeCssValue(o.baseSize)) d.push(`font-size:${o.baseSize}`);
    if (o.hideBackgroundImage) d.push("--rs-bg-layers:none");
    return d.join(";");
  };
  let css = "";
  if (r.tablet) { const d = block(r.tablet); if (d) css += `@media (min-width: 641px) and (max-width: 1024px){${scope}{${d}}}.rs-viewport.tablet ${scope}{${d}}`; }
  if (r.mobile) { const d = block(r.mobile); if (d) css += `@media (max-width: 640px){${scope}{${d}}}.rs-viewport.mobile ${scope}{${d}}`; }
  return css;
}

/**
 * `.rs-shell`'s width-mode modifier class. A class, not folded into the CSS
 * variables above, because it selects WHICH max-width rule applies
 * (`none` vs `var(--rs-max-width)`) rather than supplying a value — see
 * questions.css's comment on `.rs-shell.rs-width-full` / `.rs-width-contained`.
 */
export function widthModeClass(b: Branding): string {
  return b.layout.widthMode === "contained" ? "rs-width-contained" : "rs-width-full";
}
