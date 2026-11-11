/**
 * THE STUDIO'S COLOUR THEMES (2026-11-11).
 *
 * A theme is a set of values for the design tokens in `app/design-system.css` (`:root[data-theme="<id>"]`), and
 * nothing else: no component knows which theme is on. This list is what the selector shows — the name, a line
 * about it, and four colours for its preview chip, which are the theme's own canvas / surface / accent / text
 * values (themes.test.ts checks they match the stylesheet, and that every theme defines every colour token).
 *
 * The Studio only. A respondent's survey is drawn with the survey's own branding, which no personal theme touches.
 */
export interface StudioTheme {
  id: string;
  label: string;
  description: string;
  dark: boolean;
  /** canvas, surface, accent, text — the same values the stylesheet gives --c-bg, --c-surface, --c-primary, --c-text */
  swatch: [string, string, string, string];
}

export const DEFAULT_THEME = "reslens";

export const STUDIO_THEMES: readonly StudioTheme[] = [
  { id: "reslens", label: "ResLens", description: "Warm paper and deep ink-indigo — the default", dark: false, swatch: ["#f6f3ec", "#fdfcf9", "#17143f", "#15132e"] },
  { id: "classic", label: "Classic", description: "The earlier cool grey and electric indigo", dark: false, swatch: ["#f5f7fb", "#ffffff", "#4f46e5", "#131a2b"] },
  { id: "light", label: "Light", description: "Clean, bright and minimal", dark: false, swatch: ["#f7f8fa", "#ffffff", "#2563eb", "#111827"] },
  { id: "soft", label: "Soft Neutral", description: "Muted tones for long sessions", dark: false, swatch: ["#f3f1ee", "#faf9f7", "#4f6272", "#2b2a28"] },
  { id: "ocean", label: "Ocean", description: "Calm blues and teals", dark: false, swatch: ["#eef6f8", "#ffffff", "#0e7490", "#0c2a36"] },
  { id: "contrast", label: "Modern Contrast", description: "Strong contrast and clear hierarchy", dark: false, swatch: ["#ffffff", "#ffffff", "#0b3bd9", "#000000"] },
  { id: "dark", label: "Dark", description: "Dark greys with comfortable text", dark: true, swatch: ["#0f1115", "#171a21", "#8b93ff", "#e8eaf0"] },
  { id: "midnight", label: "Midnight", description: "Deep navy with soft blue highlights", dark: true, swatch: ["#0b1220", "#111a2e", "#7aa2ff", "#e6ecff"] },
];

export const isStudioTheme = (v: unknown): v is string => typeof v === "string" && STUDIO_THEMES.some((t) => t.id === v);
export const studioTheme = (id: string | null | undefined): StudioTheme => STUDIO_THEMES.find((t) => t.id === id) ?? STUDIO_THEMES[0];

/** where this browser remembers the theme (the account's copy is `profiles.ui_theme`) */
export const THEME_STORAGE_KEY = "rescript.theme";

/**
 * Runs in <head> before the first paint, so a saved theme never flashes the default first. Self-contained on
 * purpose (it is inlined as text): the ids are written into it from the list above.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t&&${JSON.stringify(STUDIO_THEMES.map((t) => t.id))}.indexOf(t)>=0)document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;
