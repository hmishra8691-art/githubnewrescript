import { THEME_PRESETS, REPORT_THEMES, themeToReportTheme, themeNameKey, type ReportTheme } from "@rescript/analytics";

/**
 * THE REPORT BUILDER'S THEME, APPLIED (2026-10-18). A report asked for in words
 * names a theme ("premium" → Midnight, "the Healthcare Analytics theme"); the
 * builder used to add a note saying which preset would fit and leave it there,
 * because a report's theme is a stored record (`analytics_themes`) and a preset
 * is not one. Now the name is resolved when the report is created: a saved
 * theme of that name (the project's or the workspace's) is used as it is;
 * otherwise the preset is saved to THIS PROJECT first (never to the whole
 * workspace on someone's behalf) and used. A name that is neither is left out
 * and said so — nothing is invented.
 */
export type ThemeResolution =
  | { kind: "saved"; themeId: string; name: string }
  | { kind: "create"; name: string; theme: ReportTheme }
  | { kind: "unknown"; name: string };

export function resolveReportTheme(name: string | null | undefined, saved: readonly { id: string; name: string }[]): ThemeResolution | null {
  if (!name?.trim()) return null;
  const k = themeNameKey(name);
  const hit = saved.find((t) => themeNameKey(t.name) === k);
  if (hit) return { kind: "saved", themeId: hit.id, name: hit.name };
  const preset = THEME_PRESETS.find((t) => themeNameKey(t.name) === k);
  if (preset) return { kind: "create", name: preset.name, theme: structuredClone(preset) };
  const report = REPORT_THEMES.find((t) => themeNameKey(t.name) === k);
  if (report) return { kind: "create", name: report.name, theme: themeToReportTheme(report) };
  return { kind: "unknown", name: name.trim() };
}
