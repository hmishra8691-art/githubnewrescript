import { clockView, type ClockView, type PageTimer } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";

/**
 * S4b (GA-05) — THE RUNNER'S ONE CLOCK PER PAGE.
 *
 * Not one per renderer: every timer on a page (the page's own and each question's) counts from the page's arrival
 * on this clock. It is WALL time (`Date.now()`), so it keeps counting while the tab is hidden — the research norm
 * for timed tasks (a respondent cannot stop the clock by switching tabs). A reload starts the page again.
 *
 * `step` is what the Runner's interval calls: it marks the timers that have just run out (each once), and says
 * when the polite announcements are due — the warning (once per timer, at `warnAtSeconds` left) and "you can
 * continue now" (once, when a minimum wait ends). Never every second: a screen reader hears at most those.
 * Pure apart from its own fields; `now` is passed in, so it is unit-tested without timers.
 */
export class PageClock {
  key = "";
  enteredAt = 0;
  /** timers already handled this visit */
  fired = new Set<string>();
  /** timers that ran out this visit (the paradata's TIMED_OUT) */
  timedOut = new Set<string>();
  warned = new Set<string>();
  ready = false;

  /** arrive on a page (a new key); returns true when the clock restarted */
  enter(key: string, now: number): boolean {
    if (key === this.key) return false;
    this.key = key; this.enteredAt = now;
    this.fired = new Set(); this.timedOut = new Set(); this.warned = new Set(); this.ready = false;
    return true;
  }

  elapsed(now: number): number { return this.key ? Math.max(0, (now - this.enteredAt) / 1000) : 0; }

  view(timers: PageTimer[], now: number): ClockView { return clockView(timers, this.elapsed(now), this.fired); }

  step(timers: PageTimer[], now: number): { view: ClockView; expired: PageTimer[]; warn: ClockView["countdown"]; ready: boolean } {
    const view = this.view(timers, now);
    for (const t of view.expired) { this.fired.add(t.ref); this.timedOut.add(t.ref); }
    let warn: ClockView["countdown"] = null;
    if (view.countdown?.warn && !this.warned.has(view.countdown.ref)) { this.warned.add(view.countdown.ref); warn = view.countdown; }
    let ready = false;
    if (timers.some((t) => t.timer.minSeconds) && view.minWait === 0 && !this.ready) { this.ready = true; ready = true; }
    return { view, expired: view.expired, warn, ready };
  }
}

const LIVE = new WeakMap<object, boolean>();
/** does any condition in the survey read time_on_page / elapsed (so the page must re-evaluate as time passes)? */
export function usesLiveBehavior(def: SurveyDefinition): boolean {
  const hit = LIVE.get(def);
  if (hit !== undefined) return hit;
  const scan = (o: unknown, d = 0): boolean => {
    if (!o || typeof o !== "object" || d > 60) return false;
    if (Array.isArray(o)) return o.some((x) => scan(x, d + 1));
    const r = o as Record<string, unknown>;
    if (r.kind === "behavior" && (r.ref === "time_on_page" || r.ref === "elapsed")) return true;
    return Object.values(r).some((x) => scan(x, d + 1));
  };
  const d = def as unknown as Record<string, unknown>;
  const v = scan(d.questions) || scan(d.flow) || scan(d.ux) || scan(d.displayRules) || scan(d.namedExpressions);
  LIVE.set(def, v);
  return v;
}

/** the device class conditions read: the preview's device switch when it is not the default, else the detected class */
export function effectiveDevice(detected: string | undefined, previewChoice: "desktop" | "tablet" | "mobile", preview: boolean): "desktop" | "tablet" | "mobile" | undefined {
  if (preview && previewChoice !== "desktop") return previewChoice;
  return detected === "mobile" || detected === "tablet" || detected === "desktop" ? detected : preview ? previewChoice : undefined;
}
