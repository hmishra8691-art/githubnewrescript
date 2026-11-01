import type { Question, SurveyDefinition, Timer, TimerInput } from "@rescript/schema";
import { DEVICE_CLASSES } from "@rescript/schema";
import type { RuntimeStep } from "./flow.js";
import type { ResponseState } from "./state.js";
import { isEmptyAnswer } from "./answers.js";
import { lookupAnswer } from "./state.js";

/**
 * S4b (GA-05, IM-19) — NATIVE TIMERS ON ANY QUESTION AND ANY PAGE: the pure half.
 *
 * The Runner keeps ONE clock per page (the page's arrival, wall clock — it keeps counting while the tab is hidden,
 * the research norm) and asks this module, on every tick, what that clock means: the countdown to draw, whether the
 * warning is due, which timers have just run out, how long Next must stay disabled (`minSeconds`). A question timer
 * counts on the same clock, from the page's arrival.
 *
 * PARADATA. Each timer writes two embedded-data fields, so they travel with every save and every export with no new
 * column: `TIMER_<REF>_ELAPSED` (seconds on the page when it was left, one decimal) and `TIMER_<REF>_TIMED_OUT`
 * (0 | 1; written the moment it runs out, so a `timed_out` behaviour condition can read it on the same page).
 * <REF> is the question's code, or the page node's id, upper-cased, with the loop iteration appended.
 *
 * ADVANCE ON TIMEOUT. The normal Next path, with one difference: a question NOT YET ANSWERED on a page whose
 * advance timer ran out is not refused (it is recorded as timed out). An answered question that fails its rules
 * still stops the page — an invalid value is never stored because time ran out; the respondent sees the error,
 * and the next Next goes through once it is fixed (the unanswered ones still skipped). The server replay applies
 * the same rule from the posted `TIMER_*_TIMED_OUT` (`timedOutSkips`).
 *
 * `gamified.timed` keeps its own renderer clock (unchanged, documented): it is a reaction-time single choice that
 * also records `__rt`; a `timer` on the same question runs on the page clock beside it.
 */

export interface ResolvedTimer {
  limitSeconds?: number;
  show: "countdown" | "hidden";
  onTimeout: "advance" | "lock" | "message";
  warnAtSeconds?: number;
  minSeconds?: number;
  message?: string;
}

export interface PageTimer {
  /** the question code or page node id (+ loop iteration) — what `timed_out.<ref>` names */
  ref: string;
  /** the embedded-data stem: TIMER_<REF> */
  key: string;
  scope: "page" | "question";
  questionId?: string;
  timer: ResolvedTimer;
}

/** the timer with its defaults applied, or null when it does nothing */
export function resolveTimer(raw: TimerInput | Timer | undefined | null): ResolvedTimer | null {
  if (!raw || typeof raw !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(3600, v) : undefined);
  const t: ResolvedTimer = {
    show: raw.show === "hidden" ? "hidden" : "countdown",
    onTimeout: raw.onTimeout === "lock" || raw.onTimeout === "message" ? raw.onTimeout : "advance",
    ...(n(raw.limitSeconds) ? { limitSeconds: n(raw.limitSeconds) } : {}),
    ...(n(raw.warnAtSeconds) ? { warnAtSeconds: n(raw.warnAtSeconds) } : {}),
    ...(n(raw.minSeconds) ? { minSeconds: n(raw.minSeconds) } : {}),
    ...(typeof raw.message === "string" && raw.message.trim() ? { message: raw.message.trim().slice(0, 500) } : {}),
  };
  return t.limitSeconds || t.minSeconds ? t : null;
}

const SAFE = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
/** `TIMER_<REF>` for a question code / page id, with the loop iteration (`p1@apple` → `TIMER_P1_APPLE`) */
export function timerKey(ref: string): string { return `TIMER_${SAFE(ref)}`; }

/** the page node a runtime page step was compiled from (`p1@apple` → node `p1`) */
function pageNode(def: SurveyDefinition, pageId: string): { timer?: Timer } | undefined {
  const id = pageId.split("@")[0];
  const walk = (nodes: unknown[]): { timer?: Timer } | undefined => {
    for (const n of nodes as { type: string; id: string; children?: unknown[]; branches?: { children: unknown[] }[]; timer?: Timer }[]) {
      if (n.type === "page" && n.id === id) return n;
      const kids = [...(n.children ?? []), ...(n.branches ?? []).flatMap((b) => b.children ?? [])];
      if (kids.length) { const hit = walk(kids); if (hit) return hit; }
    }
    return undefined;
  };
  return walk(def.flow ?? []);
}

/** every timer on a page: the page's own, then each shown question's (in page order) */
export function pageTimers(def: SurveyDefinition, step: Extract<RuntimeStep, { kind: "page" }> | null | undefined, questions: Question[]): PageTimer[] {
  if (!step) return [];
  const suffix = step.pageId.includes("@") ? step.pageId.slice(step.pageId.indexOf("@")) : "";
  const out: PageTimer[] = [];
  const pt = resolveTimer(pageNode(def, step.pageId)?.timer);
  if (pt) out.push({ ref: step.pageId, key: timerKey(step.pageId), scope: "page", timer: pt });
  for (const q of questions) {
    const t = resolveTimer(q.timer);
    if (t) out.push({ ref: `${q.code}${suffix}`, key: timerKey(`${q.code}${suffix}`), scope: "question", questionId: q.id, timer: t });
  }
  return out;
}

export interface ClockView {
  /** the soonest-ending visible countdown, if any is still running */
  countdown: { ref: string; remaining: number; warn: boolean; scope: "page" | "question"; questionId?: string } | null;
  /** timers whose limit has passed and that have not been handled yet (not in `fired`) */
  expired: PageTimer[];
  /** whole seconds before Next may be pressed (minSeconds); 0 = now */
  minWait: number;
  /** the questions a lock has disabled (page lock = every question on the page: `pageLocked`) */
  lockedQuestions: string[];
  pageLocked: boolean;
}

/** what the page clock means at `elapsedSec`, given the timers already handled (`fired`) */
export function clockView(timers: PageTimer[], elapsedSec: number, fired: ReadonlySet<string> = new Set()): ClockView {
  let countdown: ClockView["countdown"] = null;
  const expired: PageTimer[] = [];
  let minWait = 0;
  const lockedQuestions: string[] = [];
  let pageLocked = false;
  for (const t of timers) {
    const { limitSeconds, minSeconds, warnAtSeconds, show, onTimeout } = t.timer;
    if (minSeconds) minWait = Math.max(minWait, Math.ceil(minSeconds - elapsedSec));
    if (!limitSeconds) continue;
    const remaining = Math.max(0, Math.ceil(limitSeconds - elapsedSec));
    if (elapsedSec >= limitSeconds) {
      if (!fired.has(t.ref)) expired.push(t);
      if (onTimeout === "lock") { if (t.scope === "page") pageLocked = true; else if (t.questionId) lockedQuestions.push(t.questionId); }
      continue;
    }
    if (show === "countdown" && (!countdown || remaining < countdown.remaining)) {
      countdown = { ref: t.ref, remaining, warn: !!warnAtSeconds && remaining <= warnAtSeconds, scope: t.scope, ...(t.questionId ? { questionId: t.questionId } : {}) };
    }
  }
  return { countdown, expired, minWait: Math.max(0, minWait), lockedQuestions, pageLocked };
}

/** "1:05", "0:09" */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** the paradata written when the page is left: TIMER_<REF>_ELAPSED and TIMER_<REF>_TIMED_OUT for every timer on it */
export function timerParadata(timers: PageTimer[], elapsedSec: number, timedOut: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of timers) {
    out[`${t.key}_ELAPSED`] = Math.round(Math.max(0, elapsedSec) * 10) / 10;
    out[`${t.key}_TIMED_OUT`] = timedOut.has(t.ref) ? 1 : 0;
  }
  return out;
}

/** has an ADVANCE timer on this page run out (by the paradata in `embedded`)? */
export function advanceTimedOut(timers: PageTimer[], embedded: ResponseState["embedded"]): boolean {
  return timers.some((t) => t.timer.onTimeout === "advance" && t.timer.limitSeconds && Number(embedded[`${t.key}_TIMED_OUT`]) === 1);
}

/**
 * ADVANCE ON TIMEOUT, the validation half — used by the Runner and the server replay alike. When an advance timer
 * on the page has run out, the errors of questions NOT YET ANSWERED are dropped (they are skipped, recorded timed
 * out); every other error stays — an answered value that fails its rules still stops the page.
 */
export function timedOutSkips<E extends { questionId: string }>(
  errors: E[], state: Pick<ResponseState, "answers">, step: Extract<RuntimeStep, { kind: "page" }>, timers: PageTimer[], embedded: ResponseState["embedded"],
): { kept: E[]; skipped: E[] } {
  if (!advanceTimedOut(timers, embedded)) return { kept: errors, skipped: [] };
  const kept: E[] = [], skipped: E[] = [];
  for (const e of errors) {
    if (e.questionId && isEmptyAnswer(lookupAnswer(state.answers, e.questionId, step.loop ?? null))) skipped.push(e);
    else kept.push(e);
  }
  return { kept, skipped };
}

/* ------------------------------------------------------------------ lint */

export interface TimerIssue { level: "error" | "warning"; questionId?: string; questionCode?: string; path: string; message: string; pageId?: string }

function lintOne(t: TimerInput, where: string): string[] {
  const out: string[] = [];
  const r = resolveTimer(t);
  if (!r) return [`${where} has a timer with neither a limit nor a minimum time — it does nothing`];
  if (r.warnAtSeconds && !r.limitSeconds) out.push(`${where}: the warning (${r.warnAtSeconds}s) needs a time limit`);
  if (r.warnAtSeconds && r.limitSeconds && r.warnAtSeconds >= r.limitSeconds) out.push(`${where}: the warning (${r.warnAtSeconds}s left) is not shorter than the limit (${r.limitSeconds}s) — it would show at once`);
  if (r.minSeconds && r.limitSeconds && r.minSeconds >= r.limitSeconds) out.push(`${where}: the minimum time (${r.minSeconds}s) is not shorter than the limit (${r.limitSeconds}s) — Next would never be usable before time runs out`);
  if (r.onTimeout === "message" && !r.limitSeconds) out.push(`${where}: "show a message on timeout" needs a time limit`);
  return out;
}

export function lintTimers(def: SurveyDefinition): TimerIssue[] {
  const issues: TimerIssue[] = [];
  for (const q of def.questions ?? []) {
    if (!q.timer) continue;
    for (const m of lintOne(q.timer, q.code)) issues.push({ level: "warning", questionId: q.id, questionCode: q.code, path: "timer", message: m });
    if (q.variant === "gamified.timed") issues.push({ level: "warning", questionId: q.id, questionCode: q.code, path: "timer", message: `${q.code} is a timed question (its own clock, settings.timeLimitSeconds) and also has a timer — two clocks run on it; keep one` });
  }
  const walk = (nodes: unknown[]) => {
    for (const n of nodes as { type: string; id: string; title?: string; children?: unknown[]; branches?: { children: unknown[] }[]; timer?: TimerInput }[]) {
      if (n.type === "page" && n.timer) for (const m of lintOne(n.timer, `page ${n.title ?? n.id}`)) issues.push({ level: "warning", pageId: n.id, path: `flow.${n.id}.timer`, message: m });
      const kids = [...(n.children ?? []), ...(n.branches ?? []).flatMap((b) => b.children ?? [])];
      if (kids.length) walk(kids);
    }
  };
  walk(def.flow ?? []);
  return issues;
}

/* ------------------------------------------------------------- behaviour */

/**
 * S4b (LO-07) — the BEHAVIOUR SNAPSHOT the evaluator reads (`state.meta.behavior`): set by the Runner on every page
 * arrival and every clock tick, by the server replay from the stored device class. Never posted (meta is not part
 * of the save payload).
 */
export interface BehaviorSnapshot {
  /** seconds on the current page */
  timeOnPage?: number;
  /** seconds since the interview started */
  elapsed?: number;
  device?: "mobile" | "tablet" | "desktop";
  /** the server replay: time values are not known (client-asserted) */
  asserted?: boolean;
}

export function behaviorOf(state: Pick<ResponseState, "meta">): BehaviorSnapshot {
  const b = (state.meta as { behavior?: BehaviorSnapshot } | undefined)?.behavior;
  return b && typeof b === "object" ? b : {};
}

export function setBehavior(state: ResponseState, patch: BehaviorSnapshot): void {
  state.meta = { ...(state.meta ?? {}), behavior: { ...behaviorOf(state), ...patch } };
}

/** a device class from any spelling ("phone" → mobile); undefined when it is not one */
export function deviceClass(v: unknown): BehaviorSnapshot["device"] {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "phone" || s === "smartphone") return "mobile";
  return (DEVICE_CLASSES as readonly string[]).includes(s) ? s as BehaviorSnapshot["device"] : undefined;
}

/** the value of a behaviour source (`{ kind: "behavior", ref, scope? }`) */
export function behaviorValue(ref: string, scope: string | undefined, state: Pick<ResponseState, "meta" | "embedded">): unknown {
  const b = behaviorOf(state);
  switch (ref) {
    case "time_on_page": return typeof b.timeOnPage === "number" ? b.timeOnPage : null;
    case "elapsed": return typeof b.elapsed === "number" ? b.elapsed : null;
    case "device": return b.device ?? null;
    case "timed_out": {
      if (scope) return Number(state.embedded[`${timerKey(scope)}_TIMED_OUT`]) === 1;
      return Object.entries(state.embedded).some(([k, v]) => /^TIMER_.*_TIMED_OUT$/.test(k) && Number(v) === 1);
    }
    default: return null;
  }
}
