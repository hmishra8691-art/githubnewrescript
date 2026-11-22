import type { SurveyDefinition } from "@rescript/schema";
import { checkPlan, planFromModel, settleQuestions, type AgentPlan, type PlanAssumption, type PlanCheck, type AgentQuestion } from "./agentPlan.js";
import type { ToolApproval } from "./toolRegistry.js";
import type { ModelTier } from "./researchPlanner.js";

/**
 * THE AGENT LOOP (Level 5 roadmap A4, with A15 — 2026-11-25): plan, act, observe, repair.
 *
 * Until now a request was planned once. If the plan's result did not verify, a person found out. The loop closes
 * that: it asks the planner for a plan, runs it on a COPY of the survey, has the result verified, and — when the
 * verification saw something — gives the planner exactly what was seen and asks for a repair. It stops when the
 * result verifies, when it stops improving, or at a bound.
 *
 * What the loop never does:
 *   - write. It ends in a PROPOSAL: the plan, the survey it would produce, the approval a person must give, and
 *     what verification still sees. Saving is the tools route's, under a person's approval, as before.
 *   - spend past its ceiling, run past its step bounds, or ask more than the clarification policy allows.
 *   - trust the planner. A plan is read against the registry and dry-run by the engine; a refused step goes back
 *     to the planner as an observation like any other.
 *
 * The planner and the verifier are passed in: the engine has no model and no simulator of its own. In production
 * the planner is a language model and the verifier is the simulation and the review; in tests both are scripted.
 */
export type AgentTask = "classify" | "edit" | "extract" | "plan" | "generate" | "repair" | "review";

/**
 * MODEL ROUTING (A15). The small model for work with one right shape (classifying a request, a single edit,
 * pulling fields out of text); the large one for planning, generating and reviewing. A failed attempt on the small
 * model is retried once on the large one; a failed attempt on the large one is not retried on anything.
 */
export function routeModel(task: AgentTask, opts: { attempt?: number; failedOn?: ModelTier | null; steps?: number } = {}): { tier: ModelTier; because: string; retry: boolean } {
  const base: ModelTier = task === "classify" || task === "edit" || task === "extract" ? "small" : "large";
  if (opts.failedOn === "large") return { tier: "large", because: "the large model already failed at this; it is not asked again", retry: false };
  if (opts.failedOn === "small") return { tier: "large", because: "the small model's answer did not pass the engine's check, so the large one is asked once", retry: true };
  /* a repair of a short plan is an edit; a repair of a long one is planning again */
  if (task === "repair") return (opts.steps ?? 99) <= 3 && (opts.attempt ?? 1) <= 1 ? { tier: "small", because: "a repair of a short plan is one edit", retry: true } : { tier: "large", because: "repairing a long plan, or repairing again, is planning", retry: true };
  return { tier: base, because: base === "small" ? `${task} has one right shape; the small model is enough` : `${task} needs judgement across the whole survey`, retry: true };
}

/** what one call to the planner cost; the loop adds these up against its ceiling */
export interface PlannerUsage { tier: ModelTier; cost: number; tokensIn?: number; tokensOut?: number; ms?: number }
export interface PlannerTurn {
  goal: string;
  def: SurveyDefinition;
  tier: ModelTier;
  attempt: number;
  /** on a repair: the plan that was tried and everything seen about it */
  previous?: { plan: AgentPlan; observations: LoopObservation[] };
  /** answers the researcher has given to earlier questions */
  answers: Record<string, string>;
}
export interface PlannerReply { plan: unknown; usage?: PlannerUsage }
export type Planner = (turn: PlannerTurn) => Promise<PlannerReply> | PlannerReply;

/** what verification saw, reduced to what a planner needs. The templates package's Observation fits this shape */
export interface LoopObservation {
  id: string; kind: string; severity: "blocker" | "problem" | "note"; message: string;
  where?: { codes?: string[]; pageId?: string };
  condition?: { text: string; reads: string[] };
  respondents?: { code: string; endStatus: string; answers: Record<string, unknown> }[];
  look?: string;
}
export type Verifier = (def: SurveyDefinition) => Promise<LoopObservation[]> | LoopObservation[];

export interface LoopLimits {
  /** plans asked of the planner, the first included */
  maxAttempts: number;
  /** steps the engine will dry-run across all attempts */
  maxSteps: number;
  /** total planner cost, in the unit the planner reports */
  costCeiling: number;
  maxAsk: number;
}
export const DEFAULT_LOOP_LIMITS: LoopLimits = { maxAttempts: 4, maxSteps: 150, costCeiling: 1, maxAsk: 2 };

export type LoopStop = "verified" | "needs_answers" | "no_progress" | "attempts" | "steps" | "cost" | "planner_failed" | "nothing_to_do";
export interface LoopAttempt {
  attempt: number; tier: ModelTier; tierBecause: string;
  /** the plan as read, or why it could not be read */
  plan: AgentPlan | null; problems: string[];
  check: Omit<PlanCheck, "after"> | null;
  observations: LoopObservation[];
  cost: number;
}
export interface LoopResult {
  stop: LoopStop;
  /** true only when the last plan ran whole and verification saw nothing above a note */
  verified: boolean;
  /** the plan to put before a person — the best attempt, not necessarily the last */
  plan: AgentPlan | null;
  /** the survey that plan would produce. A copy: nothing was saved */
  after: SurveyDefinition | null;
  /** what a person must give before it is saved */
  approval: ToolApproval;
  destroys: string[];
  /** what verification still sees in `after` */
  remaining: LoopObservation[];
  ask: AgentQuestion[]; held: AgentQuestion[]; assumptions: PlanAssumption[];
  attempts: LoopAttempt[];
  spent: number; stepsRun: number;
  /** one sentence on why it stopped, for the person */
  because: string;
}

const loud = (o: LoopObservation[]) => o.filter((x) => x.severity !== "note");
const score = (o: LoopObservation[]) => loud(o).reduce((s, x) => s + (x.severity === "blocker" ? 100 : 1), 0);

export async function runAgentLoop(input: { goal: string; def: SurveyDefinition; planner: Planner; verifier: Verifier; limits?: Partial<LoopLimits>; answers?: Record<string, string>; task?: AgentTask }): Promise<LoopResult> {
  const limits = { ...DEFAULT_LOOP_LIMITS, ...input.limits };
  const attempts: LoopAttempt[] = [];
  let spent = 0, stepsRun = 0;
  let best: { plan: AgentPlan; check: PlanCheck; observations: LoopObservation[]; score: number } | null = null;
  let previous: PlannerTurn["previous"];
  let failedOn: ModelTier | null = null;
  let unreadableLarge = false, sinceImproved = 0;
  let settled = settleQuestions([], { maxAsk: limits.maxAsk });
  const finish = (stop: LoopStop, because: string): LoopResult => ({
    stop, verified: stop === "verified", plan: best?.plan ?? null, after: best?.check.after ?? null, approval: best?.check.approval ?? "none", destroys: best?.check.destroys ?? [],
    remaining: best?.observations ?? [], ask: settled.ask, held: settled.held, assumptions: [...(best?.plan.assumptions ?? []), ...settled.assumptions], attempts, spent: Math.round(spent * 1e6) / 1e6, stepsRun, because,
  });

  for (let attempt = 1; attempt <= limits.maxAttempts; attempt++) {
    if (spent >= limits.costCeiling) return finish("cost", `Stopped at the cost ceiling (${limits.costCeiling}) after ${attempt - 1} attempt${attempt === 2 ? "" : "s"}.`);
    const route = unreadableLarge && !failedOn && !previous?.plan.steps.length
      ? { tier: "large" as ModelTier, because: "its last plan could not be read; it is asked once more, with what was wrong", retry: false }
      : routeModel(attempt === 1 ? input.task ?? "plan" : "repair", { attempt: attempt - 1, failedOn, steps: previous?.plan.steps.length });
    let reply: PlannerReply;
    try { reply = await input.planner({ goal: input.goal, def: input.def, tier: route.tier, attempt, previous, answers: input.answers ?? {} }); }
    catch (e) { attempts.push({ attempt, tier: route.tier, tierBecause: route.because, plan: null, problems: [`The planner failed: ${(e as Error).message}`], check: null, observations: [], cost: 0 }); return finish("planner_failed", `The planner failed on attempt ${attempt}: ${(e as Error).message}`); }
    const cost = reply.usage?.cost ?? 0;
    spent += cost;
    const read = planFromModel(reply.plan, input.goal);
    if (!read.plan) {
      /* an unreadable plan goes back to the planner as what was seen about it — once per tier */
      attempts.push({ attempt, tier: route.tier, tierBecause: route.because, plan: null, problems: read.problems, check: null, observations: [], cost });
      if (route.tier === "large") { if (unreadableLarge) return finish("planner_failed", `The large model's plan could not be read twice: ${read.problems[0]}`); unreadableLarge = true; }
      else failedOn = "small";
      previous = { plan: previous?.plan ?? { goal: input.goal, source: "model", steps: [], assumptions: [], questions: [] }, observations: read.problems.map((m, i) => ({ id: `plan:${i}`, kind: "plan_unreadable", severity: "blocker" as const, message: m })) };
      continue;
    }
    failedOn = null;
    const plan = read.plan;
    settled = settleQuestions(plan.questions, { maxAsk: limits.maxAsk });
    /* an unanswered question that must be asked stops the loop BEFORE anything is built on a guess */
    const open = settled.ask.filter((q) => !(q.ask in (input.answers ?? {})));
    if (open.length) {
      attempts.push({ attempt, tier: route.tier, tierBecause: route.because, plan, problems: [], check: null, observations: [], cost });
      settled = { ...settled, ask: open };
      if (!best) best = { plan, check: { ok: false, steps: [], approval: "none", destroys: [], after: input.def, changed: false, refused: 0 }, observations: [], score: Infinity };
      return finish("needs_answers", `${open.length} question${open.length === 1 ? "" : "s"} only you can answer, each of which changes the design. Nothing was built on a guess.`);
    }
    if (!plan.steps.length) { attempts.push({ attempt, tier: route.tier, tierBecause: route.because, plan, problems: [], check: null, observations: [], cost }); return finish("nothing_to_do", "The plan has no step to run."); }
    if (stepsRun + plan.steps.length > limits.maxSteps) { attempts.push({ attempt, tier: route.tier, tierBecause: route.because, plan, problems: [], check: null, observations: [], cost }); return finish("steps", `Stopped at the step limit (${limits.maxSteps}).`); }
    stepsRun += plan.steps.length;
    const check = checkPlan(input.def, plan);
    /* what the engine refused is an observation; what the verifier sees in the result is another */
    const refusals: LoopObservation[] = check.steps.filter((s) => s.outcome === "refused" || s.outcome === "skipped").map((s) => ({ id: `step:${s.id}`, kind: "step_refused", severity: "blocker" as const, message: `Step ${s.id} (${s.tool}) was refused: ${s.refused}`, look: "Change the step so the engine accepts it, or drop it and say why." }));
    const seen = check.changed ? await input.verifier(check.after) : [];
    const observations = [...refusals, ...seen];
    const { after: _after, ...checkLite } = check;
    attempts.push({ attempt, tier: route.tier, tierBecause: route.because, plan, problems: [], check: checkLite, observations, cost });
    const sc = score(observations);
    if (!best || sc < best.score) { best = { plan, check, observations, score: sc }; sinceImproved = 0; } else sinceImproved++;
    if (sc === 0) return finish("verified", attempt === 1 ? "The plan ran whole on a copy of the survey and verification saw nothing wrong." : `Verified after ${attempt - 1} repair${attempt === 2 ? "" : "s"}.`);
    /* two repairs running that are no better than the best so far: it is not converging */
    if (sinceImproved >= 2) return finish("no_progress", `Two repairs in a row did not improve it. ${loud(best.observations).length} thing${loud(best.observations).length === 1 ? "" : "s"} still seen; the best attempt is shown.`);
    previous = { plan, observations };
  }
  return finish("attempts", `Stopped after ${limits.maxAttempts} attempts. ${best ? `${loud(best.observations).length} thing${loud(best.observations).length === 1 ? "" : "s"} still seen in the best one.` : "No plan could be read."}`);
}

/** what the planner is told on a repair: the observations as text, no more than it needs */
export function repairBrief(previous: NonNullable<PlannerTurn["previous"]>): string {
  const lines = ["The previous plan was run on a copy of the survey. This is what was seen. Fix these and nothing else; keep every step that worked.", ""];
  for (const o of previous.observations.filter((x) => x.severity !== "note").slice(0, 12)) {
    lines.push(`- [${o.severity}] ${o.message}`);
    if (o.condition) lines.push(`  condition: ${o.condition.text} (reads ${o.condition.reads.join(", ") || "nothing"})`);
    for (const r of (o.respondents ?? []).slice(0, 2)) lines.push(`  simulated respondent ${r.code} ended ${r.endStatus}: ${Object.entries(r.answers).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") || "no relevant answers"}`);
    if (o.look) lines.push(`  look: ${o.look}`);
  }
  return lines.join("\n");
}
