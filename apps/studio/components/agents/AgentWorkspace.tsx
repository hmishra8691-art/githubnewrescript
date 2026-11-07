"use client";
import React from "react";
import type { ClientTask } from "../../lib/copilot/taskStore";
import { AGENTS, STAGES, agentGraph, agentStatuses, isLive, type AgentId, type AgentNode, type AgentState } from "../../lib/agents/workspace";
import { workflowStages, type StageView } from "../../lib/agents/workflow";
import type { ModuleStatus } from "../../lib/projectOverview";
import { moduleStates } from "../../lib/projectOverview";
import type { SurveyDefinition } from "@rescript/schema";
import { AgentLauncher, TaskControls, TaskResultReview } from "./AgentActions";

/**
 * THE AI AGENT WORKSPACE (ResLens analytics & agents redesign, 2026-11-07).
 *
 * Three things, all read from what the platform actually stores:
 *
 *   the JOURNEY    Design → Collect → Analyze → Act, from the Project overview's module states
 *                  (/api/surveys/{id}/overview); a stage that cannot be read here says so.
 *   the AGENTS     every agent the task engine has, each one's state taken from its step rows; agents with no
 *                  implementation are drawn inactive and labelled Planned, with what exists instead.
 *   the MAP        one task's steps as nodes, its dependsOn as connections, laid out in run order. A connection
 *                  glows only while work is passing along it (source done, target running).
 *
 * The workspace OBSERVES: it never advances, retries or cancels a task — that stays with the Copilot that owns the
 * run. It reads /api/copilot/tasks (redacted for the client: statuses, counts, our own sentences — never the request
 * or a model's output) and re-reads it every 3 s only while a task can still change; otherwise it is still.
 */

interface TasksResponse { ok?: boolean; durable?: boolean; task?: ClientTask | null; tasks?: ClientTask[] }

const STATE_WORD: Record<AgentState, string> = { working: "Working", waiting: "Queued", attention: "Needs attention", done: "Finished", idle: "Not used yet", planned: "Planned" };
const STEP_WORD: Record<string, string> = { pending: "Queued", running: "Running", completed: "Done", failed: "Failed", retrying: "Retrying", blocked: "Blocked", tombstoned: "Dropped" };
const TASK_WORD: Record<string, string> = { pending: "Queued", running: "Running", completed: "Completed", needs_attention: "Waiting for you", failed: "Failed", cancelled: "Cancelled" };
const KIND_WORD: Record<string, string> = { survey_build: "Survey build", translation: "Translation", conjoint: "Conjoint design", maxdiff: "MaxDiff design", scored_exam: "Scored exam", analysis: "Analysis", other: "Task" };
const STAGE_WORD: Record<StageView["state"], string> = { done: "Complete", in_progress: "In progress", attention: "Needs attention", not_started: "Not started", unknown: "Not available here" };

const agentName = (id: AgentId | null) => AGENTS.find((a) => a.id === id)?.name ?? "Other";
const ago = (ms?: number) => {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(ms).toLocaleDateString();
};
const dur = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`);

const POLL_MS = 3000;

export function AgentWorkspace({ surveyId, def, onTab, canEdit = false, onApply }: { surveyId: string; def: SurveyDefinition; onTab?: (tab: string) => void; canEdit?: boolean; onApply?: (next: SurveyDefinition, label: string) => void }) {
  const [data, setData] = React.useState<TasksResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [node, setNode] = React.useState<string | null>(null);
  const [modules, setModules] = React.useState<{ list: ModuleStatus[]; fromServer: boolean } | null>(null);
  const [readAt, setReadAt] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await fetch(`/api/copilot/tasks?surveyId=${encodeURIComponent(surveyId)}`, { cache: "no-store" });
      if (!r.ok) { setError(r.status === 403 ? "You do not have access to this project's agent tasks." : `The agent tasks could not be read (${r.status}).`); return; }
      setData(await r.json()); setError(null); setReadAt(Date.now());
    } catch { setError("The agent tasks could not be read — check your connection."); }
  }, [surveyId]);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/surveys/${encodeURIComponent(surveyId)}/overview`, { cache: "no-store" });
        if (r.ok) { const j = await r.json(); if (!cancelled && Array.isArray(j.modules)) { setModules({ list: j.modules, fromServer: true }); return; } }
      } catch { /* fall through to what the questionnaire alone can say */ }
      if (!cancelled) setModules({ list: moduleStates(def), fromServer: false });
    })();
    return () => { cancelled = true; };
  }, [surveyId, def]);

  const tasks = React.useMemo(() => data?.tasks ?? [], [data]);
  /** a task an action answered with: replace it in the list (or add it, newest first) and select it */
  const upsert = React.useCallback((t: ClientTask) => {
    setData((d) => {
      const list = d?.tasks ?? [];
      const has = list.some((x) => x.id === t.id);
      return { ...(d ?? {}), tasks: has ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list], task: d?.task?.id === t.id ? t : d?.task ?? t };
    });
    setSelected(t.id);
  }, []);
  const current = React.useMemo(() => tasks.find((t) => t.id === selected) ?? data?.task ?? tasks[0] ?? null, [tasks, selected, data]);
  const live = tasks.some(isLive) || isLive(data?.task);

  /* re-read only while something can still change; stop the moment nothing can */
  React.useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [live, load]);

  const statuses = React.useMemo(() => agentStatuses(tasks), [tasks]);
  const graph = React.useMemo(() => (current ? agentGraph(current) : null), [current]);
  const stages = React.useMemo(() => (modules ? workflowStages(modules.list, modules.fromServer ? {} : { unknown: ["collect", "analyze", "act"] }) : null), [modules]);
  const picked = graph?.nodes.find((n) => n.stepId === node) ?? null;

  return (
    <div className="agw" data-testid="agent-workspace">
      <div className="agw-head">
        <div>
          <h2>AI Agent Workspace</h2>
          <p className="muted">What the platform&apos;s agents are doing on this survey, read from the task engine&apos;s own records.</p>
        </div>
        <span className="grow" />
        {data && <span className={`agw-chip ${data.durable ? "ok" : "warn"}`} title={data.durable ? "Tasks are stored in the database and survive a restart" : "Tasks are held in this server's memory (sandbox, or the task tables are not installed) — a restart loses them"} data-testid="agw-durable">{data.durable ? "Stored" : "Server memory only"}</span>}
        <span className={`agw-chip ${live ? "live" : ""}`} data-testid="agw-live">{live ? "● Live — re-reading every 3 s" : readAt ? `Read ${ago(readAt)}` : "Reading…"}</span>
        <button className="btn small" onClick={() => void load()} data-testid="agw-refresh">Refresh</button>
      </div>
      {error && <div className="agw-error" role="alert">{error}</div>}

      {/* the journey */}
      <section aria-label="Research journey" className="agw-journey" data-testid="agw-journey">
        {(stages ?? STAGES.map((s) => ({ ...s, state: "unknown" as const, modules: [] }))).map((s, i) => (
          <React.Fragment key={s.id}>
            {i > 0 && <span className="agw-journey-arrow" aria-hidden="true">→</span>}
            <div className={`agw-stage st-${s.state}`} data-testid={`agw-stage-${s.id}`} data-state={s.state}>
              <div className="agw-stage-top"><b>{s.label}</b><span className="agw-stage-state">{modules ? STAGE_WORD[s.state] : "Reading…"}</span></div>
              <div className="agw-stage-q">{s.question}</div>
              <ul>{s.modules.map((m) => <li key={m.key} className={`m-${m.state}`}>{onTab ? <button type="button" className="linkish" onClick={() => onTab(m.tab)} title={m.detail}>{m.label}</button> : m.label}<span className="muted"> · {m.detail}</span></li>)}</ul>
              {s.state === "unknown" && modules && !modules.fromServer && <div className="muted agw-stage-note">Read from the saved project — open a saved survey to see it.</div>}
            </div>
          </React.Fragment>
        ))}
      </section>

      <AgentLauncher surveyId={surveyId} def={def} canEdit={canEdit} onStarted={(t) => { upsert(t); void load(); }} />

      <div className="agw-canvas">
        {/* the agents */}
        <section aria-label="Agents" className="agw-roster" data-testid="agw-roster">
          {STAGES.filter((st) => AGENTS.some((a) => a.stage === st.id)).map((st) => (
            <div key={st.id} className="agw-lane">
              <div className="agw-lane-head">{st.label}</div>
              {AGENTS.filter((a) => a.stage === st.id).map((a) => {
                const s = statuses.find((x) => x.id === a.id)!;
                return (
                  <div key={a.id} className={`agw-agent a-${a.id} s-${s.state} av-${a.availability}`} data-testid={`agw-agent-${a.id}`} data-state={s.state}>
                    <div className="agw-agent-top"><span className="agw-dot" aria-hidden="true" /><b>{a.name}</b><span className="grow" /><span className="agw-agent-state">{STATE_WORD[s.state]}</span></div>
                    <div className="agw-agent-role">{a.role}{a.deterministic ? " · deterministic checks, no model" : ""}</div>
                    {s.now && <div className="agw-agent-now">Now: {s.now}</div>}
                    {a.availability !== "planned" && s.steps.total > 0 && <div className="agw-agent-meta">{s.steps.completed}/{s.steps.total} steps done{s.steps.failed ? ` · ${s.steps.failed} failed` : ""}{s.lastActive ? ` · ${ago(s.lastActive)}` : ""}</div>}
                    {a.note && <div className="agw-agent-note">{a.availability === "partial" ? "Partly connected. " : ""}{a.note}</div>}
                  </div>
                );
              })}
            </div>
          ))}
        </section>

        {/* the tasks and the map */}
        <section aria-label="Task map" className="agw-mapwrap">
          <div className="agw-tasks" role="tablist" aria-label="Agent tasks on this survey" data-testid="agw-tasks">
            {tasks.map((t) => (
              <button key={t.id} role="tab" aria-selected={current?.id === t.id} className={`agw-task t-${t.status} ${current?.id === t.id ? "on" : ""}`} onClick={() => { setSelected(t.id); setNode(null); }} data-testid="agw-task">
                <b>{KIND_WORD[t.kind] ?? t.kind}</b>
                <span>{TASK_WORD[t.status] ?? t.status} · {t.steps.filter((s) => s.status === "completed").length}/{t.steps.filter((s) => s.status !== "tombstoned").length} steps</span>
                <span className="muted">{ago(t.updatedAt ?? t.createdAt)}</span>
              </button>
            ))}
          </div>
          {!tasks.length && data && (
            <div className="agw-empty" data-testid="agw-empty">
              <b>No agent tasks on this survey yet.</b>
              <p>Agents run when you ask the Copilot for a substantial piece of work — writing a questionnaire from a brief, a translation, an exam with an answer key. Each step they take appears here as it happens.</p>
            </div>
          )}
          {current && <TaskControls task={current} surveyId={surveyId} canEdit={canEdit} onTask={upsert} />}
          {current && graph && <TaskMap task={current} graph={graph} selected={node} onSelect={setNode} />}
          {picked && <NodeDetail node={picked} onClose={() => setNode(null)} />}
          {current?.blocked && <div className="agw-error" role="status">Waiting for a person: {current.blocked.message}</div>}
          {current && onApply && <TaskResultReview task={current} surveyId={surveyId} def={def} canEdit={canEdit} onApply={onApply} />}
        </section>
      </div>
    </div>
  );
}

const NODE_W = 196, NODE_H = 62, COL_GAP = 64, ROW_GAP = 16, PAD = 12;

function TaskMap({ task, graph, selected, onSelect }: { task: ClientTask; graph: ReturnType<typeof agentGraph>; selected: string | null; onSelect: (id: string | null) => void }) {
  /* deterministic layout: x by dependency depth, y by order within the column */
  const pos = new Map<string, { x: number; y: number }>();
  const perCol = new Map<number, number>();
  for (const n of graph.nodes) {
    const i = perCol.get(n.column) ?? 0;
    perCol.set(n.column, i + 1);
    pos.set(n.stepId, { x: PAD + n.column * (NODE_W + COL_GAP), y: PAD + i * (NODE_H + ROW_GAP) });
  }
  const rows = Math.max(1, ...perCol.values());
  const W = PAD * 2 + graph.columns * NODE_W + Math.max(0, graph.columns - 1) * COL_GAP;
  const H = PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP;
  const done = graph.nodes.filter((n) => n.status === "completed").length;
  return (
    <div className="agw-map" data-testid="agw-map">
      <div className="agw-map-head">
        <b>{KIND_WORD[task.kind] ?? task.kind}</b>
        <span>{TASK_WORD[task.status] ?? task.status}</span>
        <span>{done}/{graph.nodes.length} steps</span>
        {task.spend.charge > 0 && <span title="What the task has been charged so far, in the platform's own units">charge {task.spend.charge.toFixed(4)}</span>}
        <span className="grow" />
        <span className="agw-legend">{graph.agents.map((a) => <span key={a} className={`a-${a}`}><i />{agentName(a)}</span>)}</span>
      </div>
      <div className="agw-map-scroll">
        <div style={{ position: "relative", width: W, height: H }}>
          <svg width={W} height={H} className="agw-edges" aria-hidden="true">
            {graph.edges.map((e) => {
              const a = pos.get(e.from), b = pos.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
              return <path key={`${e.from}>${e.to}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} className={e.live ? "live" : ""} data-live={e.live ? "1" : "0"} />;
            })}
          </svg>
          {graph.nodes.map((n) => {
            const p = pos.get(n.stepId)!;
            return (
              <button key={n.stepId} type="button" className={`agw-node a-${n.agent ?? "other"} n-${n.status} ${selected === n.stepId ? "on" : ""}`} style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                onClick={() => onSelect(selected === n.stepId ? null : n.stepId)} data-testid="agw-node" data-step={n.stepId} data-status={n.status} aria-label={`${agentName(n.agent)}: ${n.title} — ${STEP_WORD[n.status] ?? n.status}`}>
                <span className="agw-node-agent">{agentName(n.agent)}</span>
                <span className="agw-node-title">{n.title}</span>
                <span className="agw-node-status">{STEP_WORD[n.status] ?? n.status}{n.retryCount ? ` · retry ${n.retryCount}` : ""}{n.durationMs != null ? ` · ${dur(n.durationMs)}` : ""}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function NodeDetail({ node, onClose }: { node: AgentNode; onClose: () => void }) {
  return (
    <div className="agw-detail" data-testid="agw-detail">
      <div className="row" style={{ gap: 8 }}><b>{node.title}</b><span className="grow" /><button className="btn tiny ghost" onClick={onClose} aria-label="Close step details">×</button></div>
      <dl>
        <dt>Agent</dt><dd>{agentName(node.agent)}</dd>
        <dt>Status</dt><dd>{STEP_WORD[node.status] ?? node.status}{node.retryCount ? ` (attempt ${node.retryCount + 1})` : ""}</dd>
        {node.dependsOn.length > 0 && <><dt>Waits for</dt><dd>{node.dependsOn.join(", ")}</dd></>}
        {node.modelTier && <><dt>Model tier</dt><dd>{node.modelTier}</dd></>}
        {node.durationMs != null && <><dt>Took</dt><dd>{dur(node.durationMs)}</dd></>}
        {node.charge != null && <><dt>Charge</dt><dd>{node.charge.toFixed(4)}</dd></>}
        {node.validation && <><dt>Check</dt><dd>{node.validation.status === "valid" ? "Passed" : node.validation.status === "invalid" ? "Failed" : "Not checked yet"}{node.validation.errors?.length ? `: ${node.validation.errors.slice(0, 3).join("; ")}` : ""}</dd></>}
        {node.failureMessage && <><dt>Problem</dt><dd>{node.failureMessage}</dd></>}
      </dl>
    </div>
  );
}
