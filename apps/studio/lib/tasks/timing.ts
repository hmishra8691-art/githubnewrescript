/**
 * EVERY CLOCK THE AGENTS RUN ON, IN ONE PLACE (2026-11-07 — "no task may fail for an arbitrary time limit").
 *
 * The audit behind this file: a generation step was given the route's SLICE budget as its own deadline — 60 s by
 * default (COPILOT_TASK_ADVANCE_MS, capped at 90 s) — and the model call inside it was cut at whatever was left.
 * A batch that needed 70 s of model time could never finish: "The AI provider did not answer in time", a retry with
 * the same 60 s, a third, a split, and the run sat in "recovering". The advance and planning routes were capped at
 * 120 s, the Copilot turn at 180 s, the background continuation at 60 s with a 20 s slice, and a step left running
 * past 180 s was reclaimed by another worker while it was still working.
 *
 * The rules now:
 *
 *   A STEP HAS ITS OWN CLOCK   5 minutes on its first attempt (5× the old 60 s), and on its one retry the whole of
 *                              the request's lifetime (~13 minutes). It is never the slice's leftovers.
 *   ONE AUTOMATIC RETRY        a step that genuinely fails is retried once, with the longer clock; a second failure is
 *                              reported as what it is ("Failed after 2 attempts"), never retried forever.
 *   A SLICE ONLY DECIDES       whether ANOTHER step may start (there must be a full step's time left); it never cuts a
 *                              running step short. The browser, or the background runner, starts the next slice.
 *   REQUESTS LIVE LONG ENOUGH  route maxDuration 800 s (the platform's ceiling for streaming/fluid functions); the
 *                              slice uses 780 s of it and keeps a margin to write the result.
 *   NO STEALING                a running step's lease outlives its longest clock (15 minutes), so a slow step is not
 *                              reclaimed and run twice.
 *   SPLITTING IS NOT RETRYING  a step too large for one answer is split into halves — a plan revision, unchanged.
 *
 * Every value can be lowered (never raised past the route ceiling) by environment for a deployment with a shorter
 * function limit; the defaults assume the platform allows 800 s.
 */
const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = typeof process !== "undefined" ? (process.env?.[name] ?? "").trim() : "";
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};

/** the route ceiling, in seconds — keep `export const maxDuration` in the task routes equal to this */
export const ROUTE_MAX_SECONDS = 800;
/** what a request may spend running steps, leaving a margin to write the result and answer */
export const SLICE_BUDGET_MS = envInt("COPILOT_TASK_ADVANCE_MS", 780_000, 5_000, 790_000);
/** a step's own clock on its first attempt — 5× the 60 s it used to inherit */
export const STEP_BUDGET_MS = envInt("COPILOT_STEP_BUDGET_MS", 300_000, 10_000, 790_000);
/** a step's clock on its one retry — as long as the request may run */
export const RETRY_STEP_BUDGET_MS = envInt("COPILOT_RETRY_STEP_BUDGET_MS", 760_000, 10_000, 790_000);
/** after this, a slice starts no new step (it returns so the page updates; the next slice carries on) — 5× 90 s */
export const SLICE_SOFT_STOP_MS = 450_000;
/** the least time worth starting a step with — 5× 30 s */
export const MIN_STEP_START_MS = 150_000;
/** automatic retries per step: ONE */
export const STEP_RETRIES = 1;
/** a running step's lease: longer than its longest clock, so nobody reclaims a step that is still working */
export const LEASE_SECONDS = 900;
/** planning a task (the planner's one model call) — 5× 90 s */
export const PLAN_BUDGET_MS = 450_000;

/** the clock a step gets on this attempt, inside what the slice has left */
export const stepClock = (attempt: number, now: number, sliceDeadline: number): number =>
  Math.min(sliceDeadline, now + (attempt > 0 ? RETRY_STEP_BUDGET_MS : STEP_BUDGET_MS));
