import { z } from "zod";

/**
 * S4b (GA-05, IM-19) — A NATIVE TIMER ON ANY QUESTION AND ANY PAGE.
 *
 *   question.timer   or   flow page node .timer
 *
 *   limitSeconds   how long the page (or the question) is open; absent = no limit (only a minimum wait)
 *   show           "countdown" (a visible clock) | "hidden" (the clock runs, nothing is drawn)
 *   onTimeout      "advance" — the normal Next path; questions not yet answered are skipped (recorded
 *                              timed_out), an answered but invalid question still stops the page
 *                  "lock"    — the inputs are disabled, the respondent presses Next
 *                  "message" — a message is shown (`message`, else the localized default); nothing else changes
 *   warnAtSeconds  remaining seconds at which the countdown is announced (once, politely) and marked
 *   minSeconds     the minimum time on the page before Next is enabled (explained next to the button)
 *   message        the timeout message for onTimeout "message"
 *
 * One clock per page, kept by the Runner (not per renderer); a question timer counts from the page's arrival.
 * The clock keeps counting while the tab is hidden (wall clock — the research norm). Paradata is written to
 * embedded data as `TIMER_<REF>_ELAPSED` (seconds) and `TIMER_<REF>_TIMED_OUT` (0 | 1) — see engine `timers.ts`.
 * Optional and backward compatible: a survey without timers is unchanged; `gamified.timed` keeps its own clock.
 */
export const Timer = z.object({
  limitSeconds: z.number().min(1).max(3600).optional(),
  show: z.enum(["countdown", "hidden"]).default("countdown"),
  onTimeout: z.enum(["advance", "lock", "message"]).default("advance"),
  warnAtSeconds: z.number().min(1).max(3600).optional(),
  minSeconds: z.number().min(1).max(3600).optional(),
  message: z.string().max(500).optional(),
});
export type Timer = z.infer<typeof Timer>;
/** the wire / authoring form (defaults not yet applied) */
export type TimerInput = z.input<typeof Timer>;

/**
 * S4b (LO-07) — BEHAVIOUR CONDITION SOURCES: `{ kind: "behavior", ref }` in any Condition.
 *
 *   time_on_page  seconds on the current page (live; client-asserted on the server)
 *   elapsed       seconds since the interview started (live; client-asserted on the server)
 *   device        "mobile" | "tablet" | "desktop" — the runtime's device detection (replayed from the stored class)
 *   timed_out     a timer has run out: `scope` names one timer (question code or page id), absent = any so far
 */
export const BEHAVIOR_SOURCES = ["time_on_page", "elapsed", "device", "timed_out"] as const;
export type BehaviorSource = typeof BEHAVIOR_SOURCES[number];
export const DEVICE_CLASSES = ["mobile", "tablet", "desktop"] as const;
export type DeviceClass = typeof DEVICE_CLASSES[number];
