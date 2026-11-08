import type { ClientStep, ClientTask } from "../copilot/taskStore.ts";

/**
 * THE AGENT WORKSPACE, AS DATA (ResLens analytics & agents redesign, 2026-11-07).
 *
 * The workspace draws the platform's AI work the way the reference pipeline does — agents as cards, the work
 * flowing between them — but every card, every connection and every state comes from the DURABLE TASK ENGINE
 * (intelligent_tasks / intelligent_steps, migration 0074; the in-memory store in the sandbox). Nothing here
 * animates, counts or connects anything a step row does not back:
 *
 *   an AGENT        is a set of real step kinds — the handlers registered in lib/tasks/handlers/*. An agent with
 *                   no handler is listed as PLANNED and drawn inactive; one whose work is only partly on the
 *                   engine says what is and is not connected.
 *   a NODE          is one step row; its state is the row's status.
 *   a CONNECTION    is one entry of a step's `dependsOn`. It is LIVE only while its source is done and its target
 *                   is running — the one moment work is actually passing along it.
 *   a COLUMN        is the step's depth in that dependency graph, so the map reads left to right in run order.
 *
 * Kept free of React so it is tested on its own.
 */

export type AgentId = "design" | "writer" | "logic" | "translation" | "assessment" | "validation" | "analysis" | "writing" | "decision";
export type AgentAvailability = "active" | "partial" | "planned";
export type Stage = "design" | "collect" | "analyze" | "act";

export interface AgentDef {
  id: AgentId;
  name: string;
  /** what it does, in a researcher's words */
  role: string;
  stage: Stage;
  availability: AgentAvailability;
  /** the step kinds (exact, or a prefix ending in ".") the engine runs for it */
  kinds: string[];
  /** a deterministic checker, not a model call */
  deterministic?: boolean;
  /** for partial and planned agents: what exists and what does not, said plainly */
  note?: string;
}

export const AGENTS: AgentDef[] = [
  { id: "design", name: "Research design", role: "Turns the brief into a design: structure, blocks, method designs, rotation and quotas", stage: "design", availability: "active",
    kinds: ["gen.design", "gen.skeleton", "gen.methods_design", "gen.randomization", "gen.quotas"] },
  { id: "writer", name: "Questionnaire writer", role: "Writes and reworks questions in batches, and repairs what the final check finds", stage: "design", availability: "active",
    kinds: ["gen.batch", "gen.batch_repair", "gen.edit_batch", "gen.repair", "copilot.generate", "copilot.rework", "copilot.turn", ""] },
  { id: "logic", name: "Logic", role: "Adds skip, display and branch logic over the questions written", stage: "design", availability: "active", kinds: ["gen.logic"] },
  { id: "translation", name: "Translation", role: "Translates the questionnaire into a target language, batch by batch", stage: "design", availability: "active", kinds: ["translation.prepare", "translation.batch"] },
  { id: "assessment", name: "Assessment", role: "Sets scoring and answer keys for exams and scored question sets", stage: "design", availability: "active", kinds: ["assessment.settings"] },
  { id: "validation", name: "Validation", role: "Checks every deliverable against its completion criteria before a task may complete", stage: "design", availability: "active", deterministic: true,
    kinds: ["gen.validate", "copilot.check", "assessment.validate", "translation.verify"] },
  { id: "analysis", name: "Analysis", role: "Writes the analysis plan, runs every planned analysis on the data, and verifies findings and hypothesis verdicts", stage: "analyze", availability: "active", deterministic: true,
    kinds: ["gen.analysis_plan", "analysis.check", "analysis.apply", "analysis.verify"] },
  { id: "writing", name: "Report writing", role: "Writes the findings storyline from the latest verified run, then hands it to the deck and Word report", stage: "act", availability: "active", deterministic: true,
    kinds: ["report.evidence", "report.storyline", "report.check"] },
  { id: "decision", name: "Decision", role: "Turns verdicts and the findings that hold into recommended actions, each tied to its evidence", stage: "act", availability: "active", deterministic: true,
    kinds: ["decision.evidence", "decision.brief", "decision.check"] },
];

export const STAGES: { id: Stage; label: string; question: string }[] = [
  { id: "design", label: "Design", question: "What do we need to learn, and how do we ask it?" },
  { id: "collect", label: "Collect", question: "Are the right people answering, and is the data sound?" },
  { id: "analyze", label: "Analyze", question: "What does the data show?" },
  { id: "act", label: "Act", question: "What do we tell people, and what should they do?" },
];

/** the agent a step belongs to; a plan item of the survey_build path (no kind) is the questionnaire writer's */
export function agentOf(step: Pick<ClientStep, "kind">): AgentId | null {
  const kind = step.kind ?? "";
  for (const a of AGENTS) if (a.kinds.some((k) => (k.endsWith(".") ? kind.startsWith(k) : k === kind))) return a.id;
  return null;
}

export interface AgentNode {
  stepId: string;
  agent: AgentId | null;
  status: ClientStep["status"];
  title: string;
  column: number;
  dependsOn: string[];
  retryCount: number;
  failureMessage?: string;
  validation?: ClientStep["validation"];
  modelTier?: string;
  durationMs?: number;
  /** what the step was charged, in the platform's own units */
  charge?: number;
}
export interface AgentEdge { from: string; to: string; live: boolean }
export interface AgentGraph { nodes: AgentNode[]; edges: AgentEdge[]; columns: number; agents: AgentId[] }

/** the step's depth in the dependency graph (longest path from a step with no dependencies); cycles are cut, not looped */
function depths(steps: ClientStep[]): Map<string, number> {
  const by = new Map(steps.map((s) => [s.stepId, s]));
  const memo = new Map<string, number>();
  const visit = (id: string, path: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    const s = by.get(id);
    if (!s || path.has(id)) return 0;
    path.add(id);
    const d = s.dependsOn.filter((x) => by.has(x)).reduce((m, x) => Math.max(m, visit(x, path) + 1), 0);
    path.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const s of steps) visit(s.stepId, new Set());
  return memo;
}

export function agentGraph(task: Pick<ClientTask, "steps" | "planVersion">): AgentGraph {
  /* a step dropped by a re-plan is history, not part of the map */
  const steps = task.steps.filter((s) => s.status !== "tombstoned");
  const d = depths(steps);
  const ids = new Set(steps.map((s) => s.stepId));
  const by = new Map(steps.map((s) => [s.stepId, s]));
  const nodes: AgentNode[] = steps.map((s) => ({
    stepId: s.stepId, agent: agentOf(s), status: s.status, title: s.title ?? s.kind ?? s.stepId, column: d.get(s.stepId) ?? 0,
    dependsOn: s.dependsOn.filter((x) => ids.has(x)), retryCount: s.retryCount,
    ...(s.failureMessage ? { failureMessage: s.failureMessage } : {}),
    ...(s.validation ? { validation: s.validation } : {}),
    ...((s as { modelTier?: string }).modelTier ? { modelTier: (s as { modelTier?: string }).modelTier } : {}),
    ...(s.startedAt && s.finishedAt && s.finishedAt >= s.startedAt ? { durationMs: s.finishedAt - s.startedAt } : {}),
    ...(s.usage && typeof (s.usage as { charge?: number }).charge === "number" ? { charge: (s.usage as { charge?: number }).charge } : {}),
  }));
  const edges: AgentEdge[] = [];
  for (const n of nodes) for (const from of n.dependsOn) edges.push({ from, to: n.stepId, live: n.status === "running" && by.get(from)?.status === "completed" });
  const agents = AGENTS.map((a) => a.id).filter((id) => nodes.some((n) => n.agent === id));
  return { nodes, edges, columns: nodes.reduce((m, n) => Math.max(m, n.column + 1), 0), agents };
}

export type AgentState = "working" | "waiting" | "attention" | "done" | "failed" | "stopped" | "idle" | "planned";

export interface AgentStatus {
  id: AgentId;
  state: AgentState;
  /** step counts in the tasks read, by status */
  steps: { total: number; completed: number; running: number; failed: number; waiting: number };
  /** the newest step time this agent has, if any */
  lastActive?: number;
  /** what it is doing now: the running step's title */
  now?: string;
}

/**
 * Each agent's state across the tasks read. WORKING only when one of its steps is running right now in an open
 * task; ATTENTION when a step failed or is blocked in an open task; WAITING when its steps are queued behind others;
 * DONE when it has finished work and nothing is open; IDLE when it has never run here; PLANNED when it does not exist.
 */
export function agentStatuses(tasks: Pick<ClientTask, "status" | "steps">[]): AgentStatus[] {
  const open = (t: Pick<ClientTask, "status">) => t.status === "pending" || t.status === "running" || t.status === "needs_attention";
  return AGENTS.map((a) => {
    const counts = { total: 0, completed: 0, running: 0, failed: 0, waiting: 0 };
    let lastActive: number | undefined, now: string | undefined, attention = false, running = false, waiting = false;
    for (const t of tasks) for (const s of t.steps) {
      if (s.status === "tombstoned" || agentOf(s) !== a.id) continue;
      counts.total++;
      if (s.status === "completed") counts.completed++;
      else if (s.status === "running") counts.running++;
      else if (s.status === "failed" || s.status === "blocked") counts.failed++;
      else counts.waiting++;
      const ts = s.finishedAt ?? s.startedAt;
      if (ts && (!lastActive || ts > lastActive)) lastActive = ts;
      if (!open(t)) continue;
      if (s.status === "running") { running = true; now ??= s.title ?? s.kind; }
      else if (s.status === "failed" || s.status === "blocked") attention = true;
      /* a paused task's queued work is waiting on a person, not on another step */
      else if (s.status === "pending" || s.status === "retrying") { if (t.status === "needs_attention") attention = true; else waiting = true; }
    }
    /* with nothing open, the agent's state is how its NEWEST task ended for it (tasks arrive newest first): failed
       steps in a stopped task are a failure, a cancelled task is stopped — "done" only when that task completed */
    let closed: AgentState | null = null;
    const last = tasks.find((t) => t.steps.some((s) => s.status !== "tombstoned" && agentOf(s) === a.id));
    if (last && !open(last)) {
      const mine = last.steps.filter((s) => s.status !== "tombstoned" && agentOf(s) === a.id);
      if (last.status === "completed") closed = "done";
      else if (mine.some((s) => s.status === "failed" || s.status === "blocked")) closed = "failed";
      else closed = "stopped";
    }
    const state: AgentState = a.availability === "planned" ? "planned" : running ? "working" : attention ? "attention" : waiting ? "waiting" : closed ?? (counts.completed ? "done" : "idle");
    return { id: a.id, state, steps: counts, ...(lastActive ? { lastActive } : {}), ...(now ? { now } : {}) };
  });
}

/** a task the workspace should keep reading: something on it can still change */
export const isLive = (t: Pick<ClientTask, "status"> | null | undefined): boolean => !!t && (t.status === "pending" || t.status === "running");

/* the task another screen asked the workspace to open (the Intelligent mode's "Details") — read once on mount */
let requestedTask: string | null = null;
export function requestAgentTask(id: string | null | undefined): void { requestedTask = id ?? null; }
export function takeRequestedAgentTask(): string | null { const t = requestedTask; requestedTask = null; return t; }

/* ------------------------------------------------------------ the run, as phases and as a feed */

export type PhaseState = "done" | "active" | "waiting" | "failed" | "skipped";
export interface RunPhase { id: "understand" | "plan" | "agents" | "execute" | "validate" | "complete"; label: string; state: PhaseState; detail: string }

/**
 * The run in the order a researcher thinks about it — understood, planned, agents chosen, executing, validating,
 * complete — each phase's state taken from what really happened: the launcher's own request while it is reading or
 * planning (`launch`), then the task's step rows. A phase with no rows behind it says so; nothing advances on a timer.
 */
export function runPhases(task: Pick<ClientTask, "status" | "steps" | "planner"> & { blocked?: { message?: string } } | null, launch?: { phase: "understanding" | "planning"; detail: string } | null): RunPhase[] {
  const P = (id: RunPhase["id"], label: string, state: PhaseState, detail: string): RunPhase => ({ id, label, state, detail });
  if (!task || launch) {
    return [
      P("understand", "Understand the instruction", launch?.phase === "understanding" ? "active" : launch ? "done" : "waiting", launch?.phase === "understanding" ? launch.detail : launch ? "Read" : "Say or type what you need"),
      P("plan", "Plan the steps", launch?.phase === "planning" ? "active" : "waiting", launch?.phase === "planning" ? launch.detail : ""),
      P("agents", "Assign agents", "waiting", ""), P("execute", "Execute", "waiting", ""), P("validate", "Validate", "waiting", ""), P("complete", "Complete", "waiting", ""),
    ];
  }
  const steps = task.steps.filter((s) => s.status !== "tombstoned");
  const name = (id: AgentId | null) => AGENTS.find((a) => a.id === id)?.name ?? "Other";
  const agents = [...new Set(steps.map((s) => agentOf(s)))];
  const work = steps.filter((s) => agentOf(s) !== "validation");
  const checks = steps.filter((s) => agentOf(s) === "validation");
  const closed = task.status === "cancelled" || task.status === "failed";
  const stateOf = (set: typeof steps): { state: PhaseState; detail: string } => {
    if (!set.length) return { state: "skipped", detail: "No separate step" };
    const done = set.filter((s) => s.status === "completed").length;
    const runningAll = set.filter((s) => s.status === "running");
    const running = runningAll[0] ?? set.find((s) => s.status === "retrying");
    const failed = set.filter((s) => s.status === "failed" || s.status === "blocked").length;
    /* several agents at once: say so, each with what it is doing */
    if (runningAll.length > 1 && !closed) return { state: "active", detail: `${runningAll.length} agents at once — ${runningAll.map((r) => `${name(agentOf(r))}: ${r.title ?? r.kind ?? r.stepId}`).join("; ")} · ${done}/${set.length} done` };
    if (running && !closed) return { state: "active", detail: `${name(agentOf(running))}: ${running.title ?? running.kind ?? running.stepId} · ${done}/${set.length} done` };
    if (done === set.length) return { state: "done", detail: `${done}/${set.length} done` };
    if (failed && (closed || set.every((s) => s.status !== "pending"))) return { state: "failed", detail: `${done}/${set.length} done · ${failed} failed` };
    if (closed) return { state: "failed", detail: `${done}/${set.length} done · stopped` };
    return { state: done ? "active" : "waiting", detail: `${done}/${set.length} done${failed ? ` · ${failed} retrying` : ""}` };
  };
  const ex = stateOf(work), va = stateOf(checks);
  const complete: RunPhase = task.status === "completed" ? P("complete", "Complete", "done", "Ready to review")
    : task.status === "cancelled" ? P("complete", "Complete", "failed", "Cancelled — finished steps are kept")
    : task.status === "failed" ? P("complete", "Complete", "failed", "Stopped")
    : task.status === "needs_attention" ? P("complete", "Complete", "active", `Waiting for you${task.blocked?.message ? `: ${task.blocked.message}` : ""}`)
    : P("complete", "Complete", "waiting", "");
  return [
    P("understand", "Understand the instruction", "done", "Read"),
    P("plan", "Plan the steps", "done", `${steps.length} step${steps.length === 1 ? "" : "s"}${task.planner ? ` · ${task.planner} planner` : ""}`),
    P("agents", "Assign agents", "done", agents.map(name).join(", ")),
    P("execute", "Execute", ex.state, ex.detail),
    P("validate", "Validate", va.state, va.detail),
    complete,
  ];
}

export interface ActivityEvent { at: number; agent: string; text: string; tone: "ok" | "bad" | "busy" }

/** what happened, newest first — one event per step start and per step end, at the times the rows recorded */
export function activityFeed(task: Pick<ClientTask, "status" | "steps">, limit = 14): ActivityEvent[] {
  const name = (id: AgentId | null) => AGENTS.find((a) => a.id === id)?.name ?? "Other";
  const out: ActivityEvent[] = [];
  for (const s of task.steps) {
    if (s.status === "tombstoned") continue;
    const title = s.title ?? s.kind ?? s.stepId;
    if (s.startedAt) out.push({ at: s.startedAt, agent: name(agentOf(s)), text: `started ${title}${s.retryCount ? ` (attempt ${s.retryCount + 1})` : ""}`, tone: "busy" });
    if (s.finishedAt && (s.status === "completed" || s.status === "failed")) out.push({ at: s.finishedAt, agent: name(agentOf(s)), text: s.status === "completed" ? `finished ${title}${s.validation?.status === "invalid" ? " — its check failed" : ""}` : `failed ${title}${s.failureMessage ? ` — ${s.failureMessage}` : ""}`, tone: s.status === "completed" && s.validation?.status !== "invalid" ? "ok" : "bad" });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
