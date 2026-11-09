import type { ClientTask } from "../copilot/taskStore.ts";
import { agentOf } from "../agents/workspace.ts";

/**
 * WHERE THE WORK STANDS, IN FOUR PLAIN PHASES (2026-11-08). Intelligent mode shows a running task the way a researcher
 * thinks about it — not which agent holds which step:
 *
 *   Planned     the request was understood and broken into steps (always done once a task exists)
 *   Working     the steps that build things (questions, logic, translations, analyses, the storyline…)
 *   Checking    the independent checks of the result (the validators — deterministic, no model)
 *   Ready       ready to review — or waiting for you, or stopped with what is kept
 *
 * Every state comes from the step rows; nothing advances on a timer.
 */
export type PhaseState = "done" | "active" | "waiting" | "attention" | "failed" | "skipped";
export interface TaskPhase { id: "plan" | "work" | "check" | "ready"; label: string; state: PhaseState; detail: string }

type T = Pick<ClientTask, "status" | "steps"> & { blocked?: { message?: string } | null };

export function taskPhases(task: T): TaskPhase[] {
  const steps = task.steps.filter((s) => s.status !== "tombstoned");
  const checks = steps.filter((s) => agentOf(s) === "validation");
  const work = steps.filter((s) => agentOf(s) !== "validation");
  const closed = task.status === "cancelled" || task.status === "failed";
  const of = (set: typeof steps): { state: PhaseState; detail: string } => {
    if (!set.length) return { state: "skipped", detail: "" };
    const done = set.filter((s) => s.status === "completed").length;
    const busy = set.filter((s) => s.status === "running" || s.status === "retrying").length;
    const failed = set.filter((s) => s.status === "failed" || s.status === "blocked").length;
    const count = `${done} of ${set.length} done`;
    if (done === set.length) return { state: "done", detail: count };
    if (closed) return { state: "failed", detail: `${count}${failed ? ` · ${failed} couldn't finish` : ""}` };
    if (busy) return { state: "active", detail: `${count} · ${busy} in progress` };
    if (failed && set.every((s) => s.status !== "pending")) return { state: "attention", detail: `${count} · ${failed} couldn't finish` };
    return { state: done ? "active" : "waiting", detail: count };
  };
  const ready: TaskPhase = task.status === "completed" ? { id: "ready", label: "Ready", state: "done", detail: "Ready to review" }
    : task.status === "needs_attention" ? { id: "ready", label: "Ready", state: "attention", detail: "Needs you" /* the reason is shown once, under the steps */ }
    : task.status === "cancelled" ? { id: "ready", label: "Ready", state: "failed", detail: "Stopped — finished work is kept" }
    : task.status === "failed" ? { id: "ready", label: "Ready", state: "failed", detail: "Stopped — finished work is kept" }
    : { id: "ready", label: "Ready", state: "waiting", detail: "" };
  return [
    { id: "plan", label: "Planned", state: "done", detail: `${steps.length} step${steps.length === 1 ? "" : "s"}` },
    { id: "work", label: "Working", ...of(work) },
    { id: "check", label: "Checking", ...of(checks) },
    ready,
  ];
}
