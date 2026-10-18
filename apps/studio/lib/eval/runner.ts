import { DEFAULT_BUDGETS, type EvalCase, type EvalTurn } from "./cases.ts";
import { scoreTurn, type CallMetric, type Check, type RiskRules, type TurnOutcome } from "./score.ts";
import { summarize, type CaseResult, type EvalMeta, type EvalReport, type TurnResult } from "./report.ts";

/**
 * THE RUNNER (AI evaluation harness). Drives each case through the REAL turn
 * handler — the caller injects it (`post`), with everything the route needs —
 * exactly as the Studio's browser does: the survey as it is open, the selected
 * question, the conversation memory built by the browser's own `memoryFrom`,
 * Apply (the engine's `applySurveyActions` on the survey, as the browser
 * replays it), ⌘Z, the plan → build loop with its checkpoints. What each call
 * cost and how many tokens it used come from the usage events the meter wrote
 * for the turn (`usageSince`), so the numbers are billing's own.
 *
 * Only the sandbox project is ever named: the harness never reads or writes a
 * customer project.
 */

export interface UsageLike { operation?: unknown; eventType: string; model: string | null; provider: string | null; inputUnits: number | null; outputUnits: number | null; providerCost: number; customerCharge: number; metadata: Record<string, unknown> }

export interface RunnerDeps {
  /** call the turn handler with this body (the runner adds nothing else) */
  post(body: Record<string, unknown>, opts: { stream: boolean }): Promise<Response>;
  /** read a turn response, JSON or streamed (lib/copilot/stream's readTurnResponse) */
  read(res: Response): Promise<{ status: number; d: Record<string, unknown> | null; streamed?: boolean }>;
  /** the usage events the meter wrote since `mark()` */
  mark(): number;
  usageSince(mark: number): UsageLike[];
  /** the starting survey of a case (`spec`: built from the case's questions) */
  fixture(key: string, spec?: readonly { ref: string; type: string; text: string; options?: string[] }[]): unknown;
  /** Apply — the engine's applySurveyActions(def, actions) → the survey after, when valid */
  apply(def: unknown, actions: unknown[]): { def: unknown; valid: boolean };
  /** the browser's memory of the conversation (lib/copilot/client's memoryFrom) */
  memoryFrom(turns: { user: string; reply: unknown }[]): unknown;
  /** put an injection payload into a question's text */
  inject?(def: unknown, target: string, text: string): unknown;
  risk?: RiskRules;
  /** the fake provider is configured: scripted replies are sent with the turn */
  fake: boolean;
  stream?: boolean;
  /** told when a turn starts and ends (the cassette recorder / player) */
  onTurn?(caseId: string, turn: number): void;
  onTurnEnd?(caseId: string, turn: number, latencyMs: number): void;
  /** replay: the latency recorded for this turn, reported instead of the replay's own */
  recordedLatency?(caseId: string, turn: number): number | null;
  /** a hard cap: stop before a case when this much has been spent (USD, provider cost) */
  stopAt?: number;
  now?(): number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export function callOf(e: UsageLike): CallMetric {
  const md = e.metadata ?? {};
  const t = (md.tokens && typeof md.tokens === "object" ? md.tokens : {}) as Record<string, unknown>;
  return {
    operation: String(md.operation ?? e.eventType), model: e.model, provider: e.provider,
    inputTokens: num(e.inputUnits), outputTokens: num(e.outputUnits), cacheReadTokens: num(t.cachedInput ?? t.cacheRead), cacheWriteTokens: num(t.cacheWrite),
    requests: Math.max(1, num(md.requests) || 1), providerCostUsd: num(e.providerCost), chargeUsd: num(e.customerCharge), latencyMs: num(md.latencyMs ?? md.providerLatencyMs),
    ...(md.byok ? { byok: true } : {}),
  };
}

/** the route's `context.calls` (tokens, cache read and — since 2026-10-18 — cache write, latency) as call metrics; cost is not in it (0) */
export function callsFromContext(body: Record<string, unknown> | null): CallMetric[] {
  const calls = body && body.context && typeof body.context === "object" ? (body.context as { calls?: unknown }).calls : null;
  if (!Array.isArray(calls)) return [];
  return calls.map((x) => { const o = (x ?? {}) as Record<string, unknown>; return { operation: String(o.operation ?? "call"), model: null, provider: null, inputTokens: num(o.inputTokens), outputTokens: num(o.outputTokens), cacheReadTokens: num(o.cachedInputTokens), cacheWriteTokens: num(o.cacheWriteTokens), requests: 1, providerCostUsd: 0, chargeUsd: 0, latencyMs: num(o.latencyMs) }; });
}

function itemsOf(plan: unknown): string[] {
  const items = plan && typeof plan === "object" && Array.isArray((plan as { items?: unknown }).items) ? (plan as { items: { id?: unknown }[] }).items : [];
  return items.map((i) => String(i.id ?? "")).filter(Boolean);
}

/** one turn: the request(s) — a build loops over its checkpoints, as the browser does — and what came back */
async function runTurn(c: EvalCase, t: EvalTurn, i: number, state: { def: unknown; history: { user: string; reply: unknown }[]; plan: unknown }, deps: RunnerDeps): Promise<TurnOutcome> {
  const now = deps.now ?? Date.now;
  const body: Record<string, unknown> = {
    surveyId: "sandbox", message: t.message, definition: state.def,
    memory: deps.memoryFrom(state.history),
    ...(t.selected ? { selectedId: selectedIdOf(state.def, t.selected) } : {}),
    ...(t.mode ? { mode: t.mode } : {}),
    ...(t.planFirst === false ? { planFirst: false } : {}),
    ...(deps.fake && t.fake !== undefined ? { fake: t.fake } : {}),
  };
  if (t.stage === "plan") Object.assign(body, { stage: "plan", planFirst: true });
  if (t.stage === "execute") {
    if (!state.plan) return { status: 0, body: null, latencyMs: 0, calls: [], error: "no plan from an earlier turn to build" };
    Object.assign(body, { stage: "execute", plan: state.plan, items: t.items ?? itemsOf(state.plan), done: [] });
  }
  const mark = deps.mark();
  const t0 = now();
  let res: { status: number; d: Record<string, unknown> | null; streamed?: boolean } = { status: 0, d: null };
  let error: string | undefined;
  try {
    const done: { id: string; raw: unknown }[] = [];
    let fakes = Array.isArray(t.fake) ? [...t.fake] : null;
    for (let round = 0; round < 12; round++) {
      res = await deps.read(await deps.post(body, { stream: !!deps.stream }));
      if (!(res.status === 200 && res.d?.stage === "progress")) break;
      /* a checkpoint: keep what was built and ask for the rest, with the scripted replies not yet used */
      const built = Array.isArray(res.d.built) ? res.d.built as { id: string; raw: unknown }[] : [];
      done.push(...built);
      body.done = [...done];
      if (fakes && deps.fake) { fakes = fakes.slice(built.length); body.fake = fakes; }
      if (!built.length && !res.d.waiting) break;
    }
  } catch (e) { error = (e as Error)?.message ?? String(e); }
  const latency = deps.recordedLatency?.(c.id, i) ?? now() - t0;
  /* the meter's events; where the turn handler's meter is not this process's (none came back), the route's own per-call measure */
  const metered = deps.usageSince(mark).map(callOf);
  return { status: res.status, body: res.d, latencyMs: latency, calls: metered.length ? metered : callsFromContext(res.d), ...(res.streamed ? { streamed: true } : {}), ...(error ? { error } : {}) };
}

function selectedIdOf(def: unknown, code: string): string | null {
  const qs = (def as { questions?: { id: string; code?: string; variable?: string }[] })?.questions ?? [];
  return qs.find((q) => q.code === code || q.variable === code || q.id === code)?.id ?? null;
}

export async function runCase(c: EvalCase, deps: RunnerDeps): Promise<CaseResult> {
  const budget = { ...DEFAULT_BUDGETS[c.category], ...(c.budgets ?? {}) };
  const turns: TurnResult[] = [];
  const stack: unknown[] = [];
  const state = { def: deps.fixture(c.fixture, c.fixtureSpec), history: [] as { user: string; reply: unknown }[], plan: null as unknown };
  let error: string | undefined;
  for (let i = 0; i < c.turns.length; i++) {
    const t = c.turns[i];
    if (t.undoPrevious && stack.length) state.def = stack.pop();
    if (t.inject && deps.inject) state.def = deps.inject(state.def, t.inject.target, t.inject.text);
    const defBefore = state.def;
    deps.onTurn?.(c.id, i);
    const out = await runTurn(c, t, i, state, deps);
    deps.onTurnEnd?.(c.id, i, out.latencyMs);
    const { checks, facts } = scoreTurn(t, out, { defBefore, risk: deps.risk });
    const reply = facts.replyText || (out.body ? JSON.stringify(out.body).slice(0, 400) : out.error ?? "");
    turns.push({ index: i, message: t.message.slice(0, 300), status: out.status, latencyMs: out.latencyMs, checks, failed: checks.filter((x) => !x.ok).map((x) => x.name), reply: reply.slice(0, 1200),
      facts: { kind: facts.kind, ops: facts.ops, applied: facts.applied, refused: facts.refused, mode: facts.mode, scope: facts.scope, stage: facts.stage, planItems: facts.planItems, repairRan: facts.repairRan, repaired: facts.repaired, oneShotParse: facts.oneShotParse, clarify: facts.clarify, modelCalled: facts.modelCalled },
      calls: out.calls, ...(out.streamed ? { streamed: true } : {}), ...(out.error ? { error: out.error } : {}) });
    if (out.error) error = out.error;
    /* what the researcher does next: a plan is kept to be built; a proposal is applied (and can be undone) */
    if (facts.stage === "plan") state.plan = (out.body as { plan?: unknown })?.plan ?? null;
    if (facts.actions.length && facts.applied > 0) {
      const a = deps.apply(state.def, facts.actions);
      if (a.valid) { stack.push(state.def); state.def = a.def; }
    }
    state.history.push({ user: t.message, reply: (out.body as { reply?: unknown })?.reply ?? null });
    if (out.status !== 200 && (t.expect?.status ?? 200) === 200) break;
  }
  const calls = turns.flatMap((t) => t.calls);
  const costUsd = Math.round(calls.reduce((n, x) => n + x.providerCostUsd, 0) * 1e6) / 1e6;
  const inputTokens = calls.reduce((n, x) => n + x.inputTokens, 0);
  const latencyMs = turns.reduce((n, t) => n + t.latencyMs, 0);
  const budgetChecks: Check[] = [
    { name: "cost", ok: costUsd <= budget.maxCostUsd, ...(costUsd <= budget.maxCostUsd ? {} : { detail: `$${costUsd.toFixed(4)} > $${budget.maxCostUsd}` }) },
    { name: "latency", ok: latencyMs <= budget.maxLatencyMs, ...(latencyMs <= budget.maxLatencyMs ? {} : { detail: `${latencyMs} ms > ${budget.maxLatencyMs} ms` }) },
    { name: "input_tokens", ok: inputTokens <= budget.maxInputTokens, ...(inputTokens <= budget.maxInputTokens ? {} : { detail: `${inputTokens} > ${budget.maxInputTokens}` }) },
  ];
  const passed = turns.length === c.turns.length && turns.every((t) => !t.failed.length) && budgetChecks.every((b) => b.ok);
  return {
    id: c.id, category: c.category, title: c.title, source: c.source ?? "golden", passed, turns, budget, budgetChecks,
    costUsd, chargeUsd: Math.round(calls.reduce((n, x) => n + x.chargeUsd, 0) * 1e6) / 1e6, inputTokens,
    outputTokens: calls.reduce((n, x) => n + x.outputTokens, 0), cacheReadTokens: calls.reduce((n, x) => n + x.cacheReadTokens, 0), cacheWriteTokens: calls.reduce((n, x) => n + x.cacheWriteTokens, 0),
    latencyMs, ...(error ? { error } : {}),
  };
}

/** every case in order; a hard spending cap stops the run between cases (the cases not run are reported as skipped) */
export async function runCases(cases: readonly EvalCase[], deps: RunnerDeps, meta: Omit<EvalMeta, "finishedAt" | "cases">, onCase?: (r: CaseResult, i: number) => void): Promise<EvalReport & { skipped: string[] }> {
  const results: CaseResult[] = [];
  const skipped: string[] = [];
  let spent = 0;
  for (let i = 0; i < cases.length; i++) {
    if (deps.stopAt != null && spent >= deps.stopAt) { skipped.push(cases[i].id); continue; }
    const r = await runCase(cases[i], deps);
    spent += r.costUsd;
    results.push(r);
    onCase?.(r, i);
  }
  const notes = [...(meta.notes ?? []), ...(skipped.length ? [`stopped at the spending cap ($${deps.stopAt}): ${skipped.length} case(s) not run — ${skipped.join(", ")}`] : [])];
  return { meta: { ...meta, notes, finishedAt: new Date().toISOString(), cases: results.length }, summary: summarize(results), cases: results, skipped };
}
