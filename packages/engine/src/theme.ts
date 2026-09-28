import type { Branding, SurveyDefinition } from "@rescript/schema";
import { Branding as BrandingSchema } from "@rescript/schema";

/**
 * THE THEME, CHANGED BY THE COPILOT — through the survey's own `branding`,
 * the same configuration the Branding panel edits and the runtime renders.
 * There is no second theme: "make it a premium dark theme around this image"
 * becomes a patch of `branding`, checked field by field, and afterwards every
 * value is simply there in Research tools → Branding to change by hand.
 *
 *   applyThemePatch   a partial branding → the survey's branding, every value
 *                     through a gate (colours are colours, lengths are
 *                     lengths, images load only from https or inline, fonts
 *                     are font names), the result through the Branding schema
 *   diffTheme         what changed, field by field, for the preview
 *   withoutPresentation
 *                     the survey minus everything that is only how it looks —
 *                     what "the structure did not change" is checked against
 */

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|[a-z]{3,20}|transparent|currentcolor|color-mix\([a-z\s,#0-9%().-]+\))$/i;
const LENGTH = /^(0|-?\d+(\.\d+)?(px|em|rem|%|vh|vw|ch))$/i;
const FONT = /^[A-Za-z0-9 ,'"_-]{1,160}$/;
const GRADIENT = /^(repeating-)?(linear|radial|conic)-gradient\([#a-z0-9\s.,%()/-]+\)$/i;
const IMAGE = (u: string) => /^https:\/\/[^\s"'()<>\\]+$/i.test(u) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(u) || /^\/[^\s"'()<>\\]+$/.test(u);

type Check = (v: unknown) => string | null;
const color: Check = (v) => (typeof v === "string" && COLOR.test(v.trim()) ? null : "is not a colour (hex, rgb(), hsl() or a colour name)");
const length: Check = (v) => (typeof v === "string" && LENGTH.test(v.trim()) ? null : "is not a length (e.g. 16px, 1.1em, 12px)");
const lineHeight: Check = (v) => (typeof v === "string" && (/^\d+(\.\d+)?$/.test(v.trim()) || LENGTH.test(v.trim())) ? null : "is not a line height (e.g. 1.5 or 24px)");
const font: Check = (v) => (typeof v === "string" && FONT.test(v.trim()) ? null : "is not a font family list");
const oneOf = (...xs: string[]): Check => (v) => (typeof v === "string" && xs.includes(v) ? null : `must be one of ${xs.join(", ")}`);
const bool: Check = (v) => (typeof v === "boolean" ? null : "must be true or false");
const num = (lo: number, hi: number): Check => (v) => (typeof v === "number" && v >= lo && v <= hi ? null : `must be a number from ${lo} to ${hi}`);
const image: Check = (v) => (typeof v === "string" && IMAGE(v.trim()) ? null : "must load from https: (or be an uploaded / inline image)");
const html: Check = (v) => (typeof v === "string" && v.length <= 20000 && !/<\s*(script|iframe|object|embed|style|link|meta)\b|\bon[a-z]+\s*=|javascript:/i.test(v) ? null : "may not contain scripts, frames, styles, event handlers or javascript: links");
const text = (max: number): Check => (v) => (typeof v === "string" && v.length <= max ? null : `must be text of at most ${max} characters`);
const gradient: Check = (v) => (typeof v === "string" && GRADIENT.test(v.trim()) ? null : "is not a CSS gradient");

/** every theme field the copilot may set, and its gate */
export const THEME_FIELDS: Record<string, Record<string, Check>> = {
  colors: Object.fromEntries(["primary", "secondary", "background", "surface", "text", "subtleText", "border", "error", "accent", "heading", "link", "inputBackground", "buttonBackground", "buttonText", "progress"].map((k) => [k, color])),
  typography: { fontFamily: font, baseSize: length, headingWeight: num(100, 900), headingFont: font, lineHeight, letterSpacing: length, questionSize: length },
  layout: { maxWidth: length, widthMode: oneOf("full", "contained"), contentAlign: oneOf("left", "center", "right"), cardStyle: oneOf("flat", "card", "line"), radius: length, spacing: oneOf("compact", "regular", "relaxed"), progressBar: oneOf("top", "bottom", "none"), progressStyle: oneOf("bar", "steps", "percent"), showBlockTitles: bool },
  buttons: { style: oneOf("solid", "outline", "pill"), nextLabel: text(60), backLabel: text(60), submitLabel: text(60), showBack: bool },
  background: { image, size: oneOf("cover", "contain", "auto"), position: (v) => (typeof v === "string" && /^[a-z0-9 %.-]{1,40}$/i.test(v) ? null : "is not a background position"), repeat: bool, attachment: oneOf("fixed", "scroll"), overlay: color, gradient },
  appearance: { shadow: oneOf("none", "soft", "medium", "strong"), cardPadding: length, borderWidth: length, optionStyle: oneOf("default", "cards", "pills", "minimal"), controlStyle: oneOf("native", "custom"), optionGap: length, inputStyle: oneOf("outlined", "filled", "underline"), focusColor: color, selectedTint: num(0, 40), buttonRadius: length, progressHeight: length, logoMaxHeight: length },
};
const DEVICE: Record<string, Check> = { baseSize: length, maxWidth: length, cardPadding: length, optionGap: length, radius: length, questionSize: length, hideBackgroundImage: bool };
const TOP: Record<string, Check> = { logoUrl: image, logoPosition: oneOf("left", "center", "right"), headerHtml: html, footerHtml: html };

export interface ThemePatchResult { branding: Branding; errors: string[]; changes: string[] }

/**
 * A partial theme onto the survey's branding. Unknown fields and values that
 * fail their gate are refused with a reason; everything else is merged, and
 * the result must pass the Branding schema. `null` clears an optional field
 * (a background, an override) back to the default.
 */
export function applyThemePatch(current: Branding, patch: Record<string, unknown>): ThemePatchResult {
  const errors: string[] = [];
  const next = structuredClone(current) as Record<string, unknown>;
  for (const [group, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    if (TOP[group]) {
      if (value === null) { delete next[group]; continue; }
      const e = TOP[group](value);
      if (e) errors.push(`${group} ${e}`); else next[group] = typeof value === "string" ? value.trim() : value;
      continue;
    }
    if (group === "responsive") {
      if (value === null) { delete next.responsive; continue; }
      if (typeof value !== "object") { errors.push("responsive must be { tablet?, mobile? }"); continue; }
      const r = { ...((next.responsive as Record<string, unknown>) ?? {}) };
      for (const [device, over] of Object.entries(value as Record<string, unknown>)) {
        if (device !== "tablet" && device !== "mobile") { errors.push(`responsive.${device} is not a device (tablet, mobile)`); continue; }
        if (over === null) { delete r[device]; continue; }
        const d = { ...((r[device] as Record<string, unknown>) ?? {}) };
        for (const [k, v] of Object.entries((over ?? {}) as Record<string, unknown>)) {
          const check = DEVICE[k];
          if (!check) { errors.push(`responsive.${device}.${k} is not a device setting (${Object.keys(DEVICE).join(", ")})`); continue; }
          if (v === null) { delete d[k]; continue; }
          const e = check(v); if (e) errors.push(`responsive.${device}.${k} ${e}`); else d[k] = typeof v === "string" ? v.trim() : v;
        }
        r[device] = d;
      }
      next.responsive = r;
      continue;
    }
    const fields = THEME_FIELDS[group];
    if (!fields) { errors.push(`“${group}” is not part of the theme (${[...Object.keys(THEME_FIELDS), ...Object.keys(TOP), "responsive"].join(", ")})`); continue; }
    if (value === null) {
      if (group === "background" || group === "appearance") { delete next[group]; continue; }
      errors.push(`${group} cannot be removed, only changed`); continue;
    }
    if (typeof value !== "object") { errors.push(`${group} must be an object of settings`); continue; }
    const target = { ...((next[group] as Record<string, unknown>) ?? {}) };
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const check = fields[k];
      if (!check) { errors.push(`${group}.${k} is not a theme setting (${Object.keys(fields).join(", ")})`); continue; }
      if (v === null) { delete target[k]; continue; }
      const e = check(v);
      if (e) errors.push(`${group}.${k} ${e}`); else target[k] = typeof v === "string" ? v.trim() : v;
    }
    next[group] = target;
  }
  const parsed = BrandingSchema.safeParse(next);
  if (!parsed.success) return { branding: current, errors: [...errors, ...parsed.error.issues.slice(0, 3).map((i) => `the theme does not pass the schema at ${i.path.join(".")}: ${i.message}`)], changes: [] };
  return { branding: parsed.data, errors, changes: diffTheme(current, parsed.data) };
}

const FIELD_LABEL: Record<string, string> = { "colors.primary": "primary colour", "colors.background": "page background colour", "colors.surface": "card colour", "colors.text": "text colour", "typography.fontFamily": "font", "typography.headingFont": "heading font", "layout.cardStyle": "card style", "layout.radius": "corner radius", "buttons.style": "button style", "background.image": "background image", "background.overlay": "background overlay", "appearance.optionStyle": "option style", "appearance.controlStyle": "radio / checkbox style", "appearance.shadow": "shadow" };
/** what changed in the look, field by field: "primary colour #2563eb → #c9a227" */
export function diffTheme(before: Branding | undefined, after: Branding | undefined): string[] {
  const out: string[] = [];
  const b = (before ?? {}) as Record<string, unknown>, a = (after ?? {}) as Record<string, unknown>;
  const show = (v: unknown) => (v === undefined ? "default" : typeof v === "string" ? (v.length > 48 ? `${v.slice(0, 45)}…` : v) : JSON.stringify(v));
  for (const group of [...Object.keys(THEME_FIELDS), "responsive"]) {
    const bg = (b[group] ?? {}) as Record<string, unknown>, ag = (a[group] ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(bg), ...Object.keys(ag)])) {
      if (JSON.stringify(bg[k]) === JSON.stringify(ag[k])) continue;
      out.push(`${FIELD_LABEL[`${group}.${k}`] ?? `${group}.${k}`}: ${show(bg[k])} → ${show(ag[k])}`);
    }
  }
  for (const k of Object.keys(TOP)) if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) out.push(`${k === "logoUrl" ? "logo" : k}: ${k.endsWith("Html") ? (a[k] ? "changed" : "removed") : `${show(b[k])} → ${show(a[k])}`}`);
  return out;
}

const PRESENTATION_BRANDING = ["themeId", "logoUrl", "logoPosition", "logoDisplay", "colors", "typography", "background", "appearance", "responsive", "headerHtml", "footerHtml", "customCss", "customJs"];
const PRESENTATION_LAYOUT = ["maxWidth", "widthMode", "contentAlign", "cardStyle", "radius", "spacing", "progressBar", "progressStyle", "showBlockTitles"];
/**
 * The survey minus how it looks: its UX configuration, the visual part of
 * its branding, and questions' decorative custom HTML. What remains —
 * questions, options, codes, logic, validation, flow, button labels, the AI
 * interviewer — is what a look-only change must leave byte-identical.
 */
export function withoutPresentation(def: SurveyDefinition): SurveyDefinition {
  const { ux: _ux, ...rest } = def;
  const out = structuredClone(rest) as SurveyDefinition;
  const br = out.branding as unknown as Record<string, unknown> | undefined;
  if (br) {
    for (const k of PRESENTATION_BRANDING) delete br[k];
    const layout = br.layout as Record<string, unknown> | undefined;
    if (layout) for (const k of PRESENTATION_LAYOUT) delete layout[k];
    const buttons = br.buttons as Record<string, unknown> | undefined;
    if (buttons) delete buttons.style;
  }
  for (const q of out.questions ?? []) {
    if (q.type !== "custom_component") delete (q as { customHtml?: string }).customHtml;
    // a starting answer is behaviour, not structure: the question, its options, codes and logic are what they were
    if (q.settings) delete (q.settings as { defaultValue?: unknown }).defaultValue;
  }
  return out;
}
