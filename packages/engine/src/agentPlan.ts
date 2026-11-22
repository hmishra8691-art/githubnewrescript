import type { SurveyDefinition } from "@rescript/schema";
import type { SurveyAction } from "./surveyActions.js";
import { dryRunTool, runComputeTool, toolByName, TOOLS, type ToolApproval, type ToolRisk } from "./toolRegistry.js";

/**
 * ONE PLAN FORMAT (Level 5 roadmap A3, with A6 and A8 — 2026-11-25).
 *
 * Intelligent Mode had several readers, each with its own result: the rule reader's actions, the operations
 * reader's request, the design reader's calculation, the model's change plan. An AGENT PLAN is the one shape all of
 * them produce and everything downstream consumes — the check, the approval, the loop, the audit:
 *
 *   step         one call of one tool from the registry, with its input and WHY (A8: no step without a reason)
 *   assumption   something decided without asking, with the reason and the sentence that overturns it
 *   question     something only the researcher can decide — asked only when the answer changes the design (A6)
 *
 * Three rules the format enforces, whoever wrote the plan:
 *   - a tool is one the registry has. A plan naming anything else is refused, with the names that exist nearby.
 *   - risk and approval come from the registry and the dry run, never from the plan's author. A model cannot
 *     declare its own step safe.
 *   - checking a plan writes nothing. It runs every questionnaire step on a copy, in order, and reports what each
 *     would do, what it would destroy, and whether the survey is still valid after it.
 */
export type PlanSource = "rules" | "operations" | "design" | "model";
export interface AgentStep {
  id: string;
  /** a registry tool name: survey.<op>, design.<calc>, analytics.run … */
  tool: string;
  input: Record<string, unknown>;
  /** why this step — in the researcher's terms. Never empty */
  why: string;
  dependsOn: string[];
}
/** what the answer to a question would change. A question that changes none of these is not worth asking */
export type DesignAspect = "audience" | "sample" | "quotas" | "method" | "questionnaire" | "length" | "fieldwork" | "budget" | "analysis" | "language";
export interface AgentQuestion {
  ask: string;
  changes: DesignAspect[];
  /** what will be assumed if nobody answers, and why that is defensible */
  default?: { value: string; because: string };
}
export interface PlanAssumption {
  text: string;
  because: string;
  /** what to say to change it */
  overturn?: string;
  /** it stands in for a question that was not asked */
  insteadOf?: string;
}
export interface AgentPlan {
  goal: string;
  source: PlanSource;
  steps: AgentStep[];
  assumptions: PlanAssumption[];
  questions: AgentQuestion[];
}

const ASPECTS: ReadonlySet<string> = new Set<DesignAspect>(["audience", "sample", "quotas", "method", "questionnaire", "length", "fieldwork", "budget", "analysis", "language"]);
export const PLAN_LIMITS = { steps: 60, questions: 12, assumptions: 30 } as const;

/* ------------------------------------------------------------------ from the rule readers */

/** the rule reader's actions as a plan: one step per action, each with the request as its reason */
export function planFromActions(goal: string, actions: readonly SurveyAction[], opts: { source?: PlanSource; why?: (a: SurveyAction, i: number) => string } = {}): AgentPlan {
  const said = goal.trim().replace(/\s+/g, " ");
  return {
    goal: said, source: opts.source ?? "rules", assumptions: [], questions: [],
    steps: actions.map((a, i) => {
      const { op, ...input } = a as unknown as Record<string, unknown> & { op: string };
      return { id: `s${i + 1}`, tool: `survey.${op}`, input, why: opts.why?.(a, i) ?? `You asked: “${said.slice(0, 160)}”.`, dependsOn: i ? [`s${i}`] : [] };
    }),
  };
}

/** a calculation asked for in words, as a plan of one read-only step */
export function planFromCalculation(goal: string, tool: string, input: Record<string, unknown>): AgentPlan {
  return { goal: goal.trim(), source: "design", assumptions: [], questions: [], steps: [{ id: "s1", tool, input, why: `You asked: “${goal.trim().slice(0, 160)}”. This is a calculation; it changes nothing.`, dependsOn: [] }] };
}

/* ------------------------------------------------------------------ from a model */

export interface PlanReading { plan: AgentPlan | null; problems: string[] }
const nearby = (name: string): string[] => {
  const head = name.split(".")[0] ?? "", tail = (name.split(".")[1] ?? name).split("_")[0] ?? "";
  return TOOLS.filter((t) => t.name.startsWith(`${head}.`) && (!tail || t.name.includes(tail))).slice(0, 5).map((t) => t.name);
};

/**
 * Read a plan a model wrote. Everything is checked against the registry: a step for a tool that does not exist, a
 * step without a reason, a dependency on a step that is not there, are PROBLEMS — and a plan with a problem is not
 * a plan (null), because a plan that is half understood must not be half run. Extra fields are dropped.
 */
export function planFromModel(raw: unknown, fallbackGoal = ""): PlanReading {
  const problems: string[] = [];
  let o = raw;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { return { plan: null, problems: ["The plan is not valid JSON."] }; } }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { plan: null, problems: ["The plan must be an object with steps."] };
  const p = o as Record<string, unknown>;
  const rawSteps = Array.isArray(p.steps) ? p.steps : null;
  if (!rawSteps) return { plan: null, problems: ["The plan has no steps list."] };
  if (rawSteps.length > PLAN_LIMITS.steps) problems.push(`The plan has ${rawSteps.length} steps; the limit is ${PLAN_LIMITS.steps}. Split the work.`);
  const steps: AgentStep[] = [];
  const ids = new Set<string>();
  rawSteps.slice(0, PLAN_LIMITS.steps).forEach((s, i) => {
    const x = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    const id = typeof x.id === "string" && x.id.trim() && !ids.has(x.id.trim()) ? x.id.trim().slice(0, 40) : `s${i + 1}`;
    ids.add(id);
    const tool = String(x.tool ?? "").trim();
    if (!toolByName(tool)) { const near = nearby(tool); problems.push(`Step ${i + 1}: there is no tool called “${tool || "(none)"}”.${near.length ? ` Did you mean ${near.join(", ")}?` : ""}`); return; }
    const why = String(x.why ?? "").replace(/\s+/g, " ").trim();
    if (why.length < 8) problems.push(`Step ${i + 1} (${tool}) gives no reason. Every step says why, in the researcher's terms.`);
    const input = x.input && typeof x.input === "object" && !Array.isArray(x.input) ? (x.input as Record<string, unknown>) : null;
    if (!input) { problems.push(`Step ${i + 1} (${tool}): the input must be an object.`); return; }
    if ("op" in input) problems.push(`Step ${i + 1} (${tool}): the input must not carry “op”; the tool's name says which action it is.`);
    steps.push({ id, tool, input, why: why.slice(0, 400), dependsOn: Array.isArray(x.dependsOn) ? x.dependsOn.map(String).slice(0, 10) : [] });
  });
  for (const s of steps) for (const d of s.dependsOn) if (!ids.has(d)) problems.push(`Step ${s.id} depends on “${d}”, which is not a step of this plan.`);
  const order = new Map(steps.map((s, i) => [s.id, i]));
  for (const s of steps) for (const d of s.dependsOn) if ((order.get(d) ?? -1) >= order.get(s.id)!) problems.push(`Step ${s.id} depends on “${d}”, which comes after it.`);
  const assumptions: PlanAssumption[] = (Array.isArray(p.assumptions) ? p.assumptions : []).slice(0, PLAN_LIMITS.assumptions).flatMap((a) => {
    const x = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    const text = String(x.text ?? "").trim(), because = String(x.because ?? "").trim();
    if (!text) return [];
    if (!because) { problems.push(`The assumption “${text.slice(0, 60)}” gives no reason.`); return []; }
    return [{ text: text.slice(0, 300), because: because.slice(0, 300), ...(typeof x.overturn === "string" && x.overturn.trim() ? { overturn: x.overturn.trim().slice(0, 200) } : {}) }];
  });
  const questions: AgentQuestion[] = (Array.isArray(p.questions) ? p.questions : []).slice(0, PLAN_LIMITS.questions).flatMap((q) => {
    const x = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
    const ask = String(x.ask ?? "").trim();
    if (!ask) return [];
    const changes = (Array.isArray(x.changes) ? x.changes.map(String) : []).filter((c): c is DesignAspect => ASPECTS.has(c));
    const d = x.default && typeof x.default === "object" ? (x.default as Record<string, unknown>) : null;
    const def = d && String(d.value ?? "").trim() && String(d.because ?? "").trim() ? { value: String(d.value).trim().slice(0, 200), because: String(d.because).trim().slice(0, 300) } : undefined;
    return [{ ask: ask.slice(0, 300), changes, ...(def ? { default: def } : {}) }];
  });
  if (!steps.length && !questions.length && !problems.length) problems.push("The plan has no step and no question: there is nothing to do.");
  if (problems.length) return { plan: null, problems };
  return { plan: { goal: String(p.goal ?? fallbackGoal).trim().slice(0, 400) || fallbackGoal, source: "model", steps, assumptions, questions }, problems: [] };
}

/* ------------------------------------------------------------------ A6: ask only what changes the design */

/** which answers move the design most: asked first when only a few may be asked */
const WEIGHT: Record<DesignAspect, number> = { method: 10, audience: 9, sample: 8, quotas: 7, questionnaire: 6, analysis: 5, budget: 4, fieldwork: 4, length: 3, language: 3 };
export interface SettledQuestions {
  /** asked now — at most `maxAsk`, the ones whose answer changes the most and that have no defensible default */
  ask: AgentQuestion[];
  /** decided without asking, each one overturnable */
  assumptions: PlanAssumption[];
  /** questions whose answer would change nothing: neither asked nor assumed */
  dropped: string[];
}

/**
 * THE CLARIFICATION POLICY. A question is asked only when (1) its answer changes the design and (2) there is no
 * defensible default. A question with a default becomes an assumption the researcher can overturn in a sentence. A
 * question that changes nothing is dropped. When more must be asked than `maxAsk`, the ones that move the design
 * most are asked and the rest are held back as OPEN, said plainly — never silently assumed, because they have no
 * default to assume.
 */
export function settleQuestions(questions: readonly AgentQuestion[], opts: { maxAsk?: number } = {}): SettledQuestions & { held: AgentQuestion[] } {
  const maxAsk = opts.maxAsk ?? 2;
  const dropped: string[] = [], assumptions: PlanAssumption[] = [], must: AgentQuestion[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    const key = q.ask.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!q.changes.length) { dropped.push(q.ask); continue; }
    if (q.default) { assumptions.push({ text: q.default.value, because: q.default.because, insteadOf: q.ask, overturn: `Answer “${q.ask}” to change it.` }); continue; }
    must.push(q);
  }
  const weight = (q: AgentQuestion) => Math.max(...q.changes.map((c) => WEIGHT[c]));
  const ranked = must.map((q, i) => ({ q, i })).sort((a, b) => weight(b.q) - weight(a.q) || a.i - b.i).map((x) => x.q);
  return { ask: ranked.slice(0, maxAsk), held: ranked.slice(maxAsk), assumptions, dropped };
}

/* ------------------------------------------------------------------ checking a plan: nothing is written */

export interface StepCheck {
  id: string; tool: string; why: string;
  /** ok: would run as written · refused: the engine will not do it · route: runs through its own endpoint, not here · skipped: a step it depends on was refused */
  outcome: "ok" | "refused" | "route" | "skipped";
  risk: ToolRisk; approval: ToolApproval;
  /** what it would do, in words (A8: the consequence beside the reason) */
  does: string[];
  destroys: string[];
  warnings: string[];
  refused?: string;
  /** a calculation's answer */
  value?: unknown;
  working?: string[];
}
export interface PlanCheck {
  ok: boolean;
  steps: StepCheck[];
  /** the strictest approval any step needs: what a person must give before the plan runs */
  approval: ToolApproval;
  destroys: string[];
  /** the survey after every step that would run — a copy; nothing was saved */
  after: SurveyDefinition;
  changed: boolean;
  refused: number;
}
const RANK: Record<ToolApproval, number> = { none: 0, confirm: 1, explicit: 2 };

/** run the plan against a copy of the survey, in order */
export function checkPlan(def: SurveyDefinition, plan: AgentPlan): PlanCheck {
  let working = def;
  const steps: StepCheck[] = [];
  const failed = new Set<string>();
  let approval: ToolApproval = "none";
  for (const s of plan.steps) {
    const tool = toolByName(s.tool);
    const base = { id: s.id, tool: s.tool, why: s.why, does: [] as string[], destroys: [] as string[], warnings: [] as string[] };
    if (!tool) { failed.add(s.id); steps.push({ ...base, outcome: "refused", risk: "read", approval: "explicit", refused: `There is no tool called ${s.tool}.` }); continue; }
    const blockedBy = s.dependsOn.find((d) => failed.has(d));
    if (blockedBy) { failed.add(s.id); steps.push({ ...base, outcome: "skipped", risk: tool.risk, approval: tool.approval, refused: `Not run: it depends on ${blockedBy}, which was refused.` }); continue; }
    if (tool.executor === "compute") {
      const r = runComputeTool(working, s.tool, s.input);
      if (!r.ok) failed.add(s.id);
      steps.push({ ...base, outcome: r.ok ? "ok" : "refused", risk: tool.risk, approval: tool.approval, does: r.ok ? r.working.slice(-1) : [], ...(r.ok ? { value: r.value, working: r.working } : { refused: r.refused }) });
      continue;
    }
    if (tool.executor === "route") {
      steps.push({ ...base, outcome: "route", risk: tool.risk, approval: tool.approval, does: [`${tool.summary} (${tool.route!.method} ${tool.route!.path})`] });
      if (RANK[tool.approval] > RANK[approval]) approval = tool.approval;
      continue;
    }
    const d = dryRunTool(working, s.tool, s.input);
    if (!d.ok || !d.after) { failed.add(s.id); steps.push({ ...base, outcome: "refused", risk: tool.risk, approval: d.approval, does: d.description, destroys: d.destructive, warnings: d.warnings, refused: d.refused ?? "The engine refused it." }); continue; }
    working = d.after;
    if (RANK[d.approval] > RANK[approval]) approval = d.approval;
    steps.push({ ...base, outcome: "ok", risk: tool.risk, approval: d.approval, does: d.description, destroys: d.destructive, warnings: d.warnings.slice(0, 5) });
  }
  const refused = steps.filter((x) => x.outcome === "refused" || x.outcome === "skipped").length;
  return { ok: refused === 0, steps, approval, destroys: [...new Set(steps.flatMap((x) => x.destroys))], after: working, changed: working !== def, refused };
}

/* ------------------------------------------------------------------ what a model is told */

/** the registry as the text a planning model reads: every tool, its risk, and the calculations' parameters */
export function planCatalogue(opts: { engines?: string[] } = {}): string {
  const tools = TOOLS.filter((t) => !opts.engines || opts.engines.includes(t.engine));
  const lines = tools.map((t) => `${t.name} [${t.risk}${t.approval !== "none" ? `, needs ${t.approval} approval` : ""}] — ${t.executor === "survey_action" ? `questionnaire action ${t.op}` : t.summary}${t.executor !== "survey_action" && t.params.length ? ` (${t.params.map((p) => `${p.name}${p.required ? "*" : ""}`).join(", ")})` : ""}`);
  return [
    "A plan is JSON: { goal, steps: [{ id, tool, input, why, dependsOn }], assumptions: [{ text, because, overturn }], questions: [{ ask, changes, default: { value, because } }] }.",
    "Every step names one tool below and says why in the researcher's terms. The input of a questionnaire tool is the action's fields without \"op\".",
    `A question lists what its answer would change (${[...ASPECTS].join(", ")}). Ask only when the answer changes the design; where a defensible default exists, give it and it will be recorded as an assumption instead.`,
    "Risk and approval are decided by the platform from this list and a dry run, not by the plan.",
    "", ...lines,
  ].join("\n");
}
