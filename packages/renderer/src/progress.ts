/**
 * D20 / AQ-11 — THE PROGRESS INDICATOR'S MODEL (pure; the component is ProgressIndicator.tsx).
 *
 * `branding.layout.progressBar` (top | bottom | none) and `progressStyle` (bar | steps | percent) were accepted by
 * the schema, the Branding panel and IM `set_theme`, but the runtime drew a top bar for every value. The numbers
 * are the Runner's existing, logic-aware ones: `current` = pages reached on the compiled path (the flow is
 * recompiled as answers change, so a branch that skips pages shortens `total`), `total` = pages on that path.
 *
 *  - bar / percent: percent = current / (total + 1) — the end screen is the "+1", as before;
 *  - steps: "Page n of N" plus one dot per page, up to STEP_DOTS_MAX; past that the dots would be a smear on a
 *    phone, so only the "n of N" text is drawn.
 */
export const STEP_DOTS_MAX = 12;

export type ProgressPosition = "top" | "bottom" | "none";
export type ProgressStyle = "bar" | "steps" | "percent";

export interface ProgressModel {
  percent: number;
  current: number;
  total: number;
  /** steps style: draw the dots (false past STEP_DOTS_MAX) */
  dots: boolean;
}

export function progressModel(current: number, total: number, ended = false): ProgressModel {
  const t = Math.max(1, Math.floor(Number.isFinite(total) ? total : 1));
  const c = Math.min(t, Math.max(ended ? t : 1, Math.floor(Number.isFinite(current) ? current : 1)));
  const percent = ended ? 100 : Math.round((c / (t + 1)) * 100);
  return { percent, current: c, total: t, dots: t <= STEP_DOTS_MAX };
}
