"use client";
/**
 * ONE TASK AT A TIME (2026-11-12) — the shared pager of every design-driven question.
 *
 * A choice exercise is a series of independent decisions. A MaxDiff of nine sets or a conjoint of twelve tasks used
 * to be drawn as one long column on one page: the respondent scrolled through every task at once, could compare
 * tasks that are meant to be judged alone, and on a phone the page was several screens long. Every task-based
 * renderer (CBC, MaxDiff, menu-based, rating-based) now shows the tasks through this pager.
 *
 *   paging    `settings.taskPaging`: absent / "one" = one task at a time; "all" = the stacked column as before
 *             (for a short exercise the author wants on one screen). One task is always one "screen".
 *   answer    unchanged — the question still stores one object keyed by task, so exports, validation, analysis,
 *             saved responses and existing projects are untouched. Paging is presentation only.
 *   Next      inside a Runner the page's own Next and Back step through the tasks first (TaskStepContext), so
 *             there is ONE pair of buttons; the page is left only from the last task. Without a host (the docs'
 *             live examples, an embedded renderer) the pager draws its own Previous / Next.
 *   required  a required question does not move past a task that is not answered — the message names it. An
 *             optional one may be stepped through.
 *   landing   the first unanswered task; when every task is answered (Back from the next page) the last one.
 *   errors    when the page's validation flags the question, the pager goes to the first unanswered task.
 *   auto      `settings.taskAutoNext` (off unless switched on): a task that has just been completed moves on to the
 *             next task after a short beat. Never leaves the page — that stays the respondent's Next.
 */
import * as React from "react";

export interface TaskStepper {
  canForward(): boolean;
  canBack(): boolean;
  /** move to the next task, or say why not (stays put); always "handled" when canForward() was true */
  forward(): void;
  back(): void;
}

export interface TaskStepHost {
  register(s: TaskStepper): () => void;
  /** a stepper's position changed — the host re-reads canForward / canBack (button label, Back visibility) */
  changed(): void;
  pendingForward(): boolean;
  pendingBack(): boolean;
  /** true when a task step consumed the press */
  forward(): boolean;
  back(): boolean;
}

export function createTaskStepHost(onChange: () => void): TaskStepHost {
  const list: TaskStepper[] = [];
  return {
    register(s) {
      list.push(s);
      onChange();
      return () => { const i = list.indexOf(s); if (i >= 0) list.splice(i, 1); onChange(); };
    },
    changed: onChange,
    pendingForward: () => list.some((s) => s.canForward()),
    pendingBack: () => list.some((s) => s.canBack()),
    forward() { const s = list.find((x) => x.canForward()); if (!s) return false; s.forward(); return true; },
    back() { for (let i = list.length - 1; i >= 0; i--) if (list[i].canBack()) { list[i].back(); return true; } return false; },
  };
}

export const TaskStepContext = React.createContext<TaskStepHost | null>(null);

export type TaskPaging = "one" | "all";

export function taskPagingOf(settings: unknown): TaskPaging {
  return (settings as { taskPaging?: string } | undefined)?.taskPaging === "all" ? "all" : "one";
}

export interface TaskPagerOptions {
  /** the tasks in the order shown */
  tasks: string[];
  settings: unknown;
  required: boolean;
  /** the task has everything a required question needs */
  complete(task: string): boolean;
  /** how many validation errors the page raised for this question (a rise sends the pager to the first open task) */
  errorCount: number;
  /** "task" / "menu" / "pair" / "product" — for the messages */
  noun?: string;
  /** a task the count leaves out (a practice task): shown, never numbered */
  uncounted?(task: string): boolean;
  readOnly?: boolean;
}

export interface TaskPager {
  paged: boolean;
  /** the tasks to draw now: one when paged, all otherwise */
  shown: string[];
  index: number;
  /** position among the counted tasks, 1-based (0 for an uncounted task) and their total */
  position: number;
  total: number;
  /** the progress strip above the task (null when not paged) */
  header: React.ReactNode;
  /** message + own buttons below the task (the buttons only without a host) */
  footer: React.ReactNode;
  /** call after an answer change: moves on when `taskAutoNext` is on and the task is now complete */
  answered(task: string, nowComplete: boolean): void;
}

export function useTaskPager(o: TaskPagerOptions): TaskPager {
  const host = React.useContext(TaskStepContext);
  const paged = taskPagingOf(o.settings) === "one" && o.tasks.length > 1;
  const autoNext = (o.settings as { taskAutoNext?: boolean } | undefined)?.taskAutoNext === true;
  const [index, setIndexRaw] = React.useState(() => {
    const open = o.tasks.findIndex((t) => !o.complete(t));
    return open < 0 ? Math.max(0, o.tasks.length - 1) : open;
  });
  const [notice, setNotice] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const at = Math.min(index, Math.max(0, o.tasks.length - 1));
  const live = React.useRef({ o, at, paged });
  live.current = { o, at, paged };
  const hostRef = React.useRef(host);
  hostRef.current = host;

  const go = React.useCallback((next: number, focus = true) => {
    setNotice("");
    setIndexRaw(next);
    /* the host re-reads canForward / canBack as it re-renders — before this component does — so the position is current now */
    live.current = { ...live.current, at: next };
    hostRef.current?.changed();
    if (!focus || typeof window === "undefined") return;
    /* the new task starts at its top, and a screen reader is told where it is (the header is a live region) */
    window.requestAnimationFrame(() => {
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.top > window.innerHeight * 0.5) el.scrollIntoView({ block: "start", behavior: "auto" });
    });
  }, []);

  const stepper = React.useMemo<TaskStepper>(() => ({
    canForward: () => live.current.paged && live.current.at < live.current.o.tasks.length - 1,
    canBack: () => live.current.paged && live.current.at > 0,
    forward: () => {
      const { o: cur, at: i } = live.current;
      const t = cur.tasks[i];
      if (cur.required && !cur.readOnly && !cur.complete(t)) {
        setNotice(`Please answer this ${cur.noun ?? "task"} before you continue.`);
        return;
      }
      go(i + 1);
    },
    back: () => go(Math.max(0, live.current.at - 1)),
  }), [go]);

  React.useEffect(() => {
    if (!host || !paged) return;
    return host.register(stepper);
  }, [host, paged, stepper]);

  /* the page's validation refused the question: show the task that needs the answer */
  const lastErrors = React.useRef(o.errorCount);
  React.useEffect(() => {
    const rose = o.errorCount > lastErrors.current;
    lastErrors.current = o.errorCount;
    if (!rose || !paged) return;
    const open = o.tasks.findIndex((t) => !o.complete(t));
    if (open >= 0 && open !== at) go(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.errorCount]);

  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const answered = (task: string, nowComplete: boolean) => {
    if (notice && nowComplete) setNotice("");
    if (!paged || !autoNext || !nowComplete) return;
    const i = o.tasks.indexOf(task);
    if (i < 0 || i !== at || i >= o.tasks.length - 1) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (live.current.at === i) go(i + 1); }, 450);
  };

  const counted = o.tasks.filter((t) => !o.uncounted?.(t));
  const current = o.tasks[at];
  const position = current !== undefined && !o.uncounted?.(current) ? counted.indexOf(current) + 1 : 0;
  const doneCount = counted.filter((t) => o.complete(t)).length;

  const header = paged ? (
    <div className="rs-taskpager" ref={rootRef} data-testid="rs-taskpager" data-task-index={at + 1} data-task-count={o.tasks.length}>
      {/* said, not shown: each task's own card carries the visible "Task n of N" */}
      <div className="rs-taskpager-count rs-sr-only" role="status" aria-live="polite" data-testid="rs-taskpager-count">
        {position > 0 ? `${o.noun ?? "task"} ${position} of ${counted.length}` : `practice ${o.noun ?? "task"}`}
      </div>
      <div className="rs-taskpager-track" role="progressbar" aria-label="Tasks answered" aria-valuemin={0} aria-valuemax={counted.length} aria-valuenow={doneCount}>
        {o.tasks.map((t, i) => (
          <span key={t} className={`rs-taskpager-seg${i === at ? " current" : ""}${o.complete(t) ? " done" : ""}${o.uncounted?.(t) ? " practice" : ""}`} />
        ))}
      </div>
    </div>
  ) : null;

  const footer = paged ? (
    <>
      {notice && <div role="alert" className="rs-error-msg rs-taskpager-notice" data-testid="rs-taskpager-notice">{notice}</div>}
      {!host && (
        <div className="rs-taskpager-nav">
          {at > 0 ? <button type="button" className="rs-btn secondary" data-testid="rs-task-back" onClick={() => stepper.back()}>Previous</button> : <span />}
          {at < o.tasks.length - 1 && <button type="button" className="rs-btn" data-testid="rs-task-next" onClick={() => stepper.forward()}>Next</button>}
        </div>
      )}
    </>
  ) : null;

  return { paged, shown: paged ? (current !== undefined ? [current] : []) : o.tasks, index: at, position, total: counted.length, header, footer, answered };
}
