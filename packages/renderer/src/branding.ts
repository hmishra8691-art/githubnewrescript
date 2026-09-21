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
  return vars;
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
