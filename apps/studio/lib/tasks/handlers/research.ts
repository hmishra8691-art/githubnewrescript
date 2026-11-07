import type { SurveyDefinition } from "@rescript/schema";
import { holds, plannedAnalyses, rankFindings, type DatasetSpec, type Finding, type HypothesisVerdict } from "@rescript/analytics";
import type { StepContext, StepHandler, StepResult, TaskPlanner, TaskStepSpec } from "../types.ts";
import { registerStepHandler, registerTaskPlanner } from "../registry.ts";

/**
 * THE RESEARCH AGENTS ON THE TASK ENGINE (ResLens agents, phase 2 — 2026-11-07).
 *
 * The Analysis agent was "partly connected": the analysis plan was written during generation, but running it lived
 * only behind a button in Data Analytics. It is now a planner and three durable steps over the SAME services that
 * button calls — no second analytics engine, no model anywhere near a number:
 *
 *   analysis.check    the plan: what will run (the written plan, or the framework derived from the questionnaire)
 *   analysis.apply    Apply the analysis plan — saved analyses, the run, charts, dashboard, findings report
 *                     (lib/analysisPlanCore `applyPlan`, the route Data Analytics uses)
 *   analysis.verify   the stored run read back: base, findings that hold after correction, every hypothesis' verdict
 *
 * The data services are server-only (Supabase), so they are INJECTED (`setResearchBackend`, installed by
 * lib/tasks/service.ts). Without one — the sandbox, or a test that sets none — a step does not pretend: it pauses the
 * task saying it needs a saved project's responses.
 */

/* ------------------------------------------------------------ the data door */

export interface ResearchRunLite {
  computedAt: string;
  environment?: string;
  n: number;
  findings: Finding[];
  verdicts: HypothesisVerdict[];
  warnings?: string[];
  items: { definition: { name: string; kind: string }; findings?: Finding[]; result?: unknown }[];
  [k: string]: unknown;
}
export interface ApplyLite {
  ok: boolean; status: number; error?: string;
  summary?: { status: string; n: number; message: string; counts: Record<string, number | undefined>; items: { id: string; title: string; status: string; reason?: string }[] };
  runId?: string | null; reportId?: string | null; dashboardId?: string | null;
  report?: { action: string }; dashboard?: { action: string };
  warnings?: string[];
}
export interface ResearchBackend {
  /** the survey as saved (draft, else the deployed version) */
  definition(surveyId: string): Promise<{ def: SurveyDefinition } | { error: string }>;
  applyPlan(surveyId: string, dataset: DatasetSpec): Promise<ApplyLite>;
  latestRun(surveyId: string, environment?: DatasetSpec["environment"]): Promise<ResearchRunLite | null>;
}

const G = globalThis as unknown as { __rescriptResearchBackend?: ResearchBackend | null };
export function setResearchBackend(b: ResearchBackend | null): void { G.__rescriptResearchBackend = b; }
const backend = (): ResearchBackend | null => G.__rescriptResearchBackend ?? null;

const NO_DATA = "This agent works on a saved project's responses, and this survey has no database behind it (the sandbox). Open a saved survey to run it.";

/* ------------------------------------------------------------ helpers */

export const datasetOf = (input: Record<string, unknown>): DatasetSpec => ({
  environment: input.environment === "TEST" || input.environment === "ALL" ? input.environment : "LIVE",
  dataset: input.dataset === "clean" ? "clean" : "all",
});
const ok = (data: unknown, warnings: string[] = []): StepResult => ({ status: "completed", output: { data, validation: { ok: true, errors: [], warnings } } });
const ENV_WORD: Record<string, string> = { LIVE: "production", TEST: "test", ALL: "all" };

/* ------------------------------------------------------------ the analysis agent */

const runCheck: StepHandler["run"] = async (ctx) => {
  const b = backend();
  if (!b) return { status: "blocked", reason: NO_DATA, needs: "config" };
  const got = await b.definition(ctx.surveyId);
  if ("error" in got) return { status: "failed", reason: `The survey could not be read: ${got.error}`, permanent: true };
  const ds = datasetOf(ctx.step.input);
  const def = got.def;
  const written = !!def.research?.analysisPlan;
  let planned: ReturnType<typeof plannedAnalyses> = [];
  try { planned = plannedAnalyses(def, ds); } catch (e) { return { status: "failed", reason: `The analysis plan could not be read: ${(e as Error).message}`, permanent: true }; }
  if (!planned.length) return { status: "blocked", reason: "There is nothing to analyse yet: add questions, or write an analysis plan in Data Analytics › Architect › Analysis plan, then resume.", needs: "user_input" };
  const hypotheses = def.research?.hypotheses?.length ?? 0;
  return ok({ planned: planned.length, planWritten: written, hypotheses, dataset: ds, titles: planned.slice(0, 40).map((p) => p.definition.name) },
    written ? [] : ["No analysis plan is written for this survey, so the framework derived from the questionnaire is what runs. Writing a plan (with hypotheses) makes the verdicts meaningful."]);
};

const runApply: StepHandler["run"] = async (ctx) => {
  const b = backend();
  if (!b) return { status: "blocked", reason: NO_DATA, needs: "config" };
  const ds = datasetOf(ctx.step.input);
  const r = await b.applyPlan(ctx.surveyId, ds);
  if (!r.ok) return { status: "failed", reason: r.error ?? `Applying the plan failed (${r.status}).`, permanent: r.status >= 400 && r.status < 500 };
  const s = r.summary;
  if (s?.status === "no_data") return { status: "blocked", reason: `No ${ENV_WORD[ds.environment] ?? ""} responses to analyse yet. Collect responses (or choose test data) and resume — the analyses are saved and will run then.`, needs: "user_input" };
  if (s?.status === "nothing_planned") return { status: "blocked", reason: "The plan has nothing that can run on this survey. Review it in Data Analytics › Architect › Analysis plan, then resume.", needs: "user_input" };
  const failed = (s?.items ?? []).filter((i) => i.status === "failed");
  const data = { status: s?.status ?? "applied", n: s?.n ?? 0, message: s?.message ?? "", counts: s?.counts ?? {}, failed: failed.map((f) => ({ title: f.title, reason: f.reason ?? "" })), runId: r.runId ?? null, reportId: r.reportId ?? null, dashboardId: r.dashboardId ?? null, report: r.report?.action ?? "none", dashboard: r.dashboard?.action ?? "none" };
  return { status: "completed", output: { data, validation: { ok: s?.status !== "failed", errors: s?.status === "failed" ? [s.message] : [], warnings: [...failed.map((f) => `${f.title}: ${f.reason ?? "could not be computed"}`), ...(r.warnings ?? []).slice(0, 10)] } } };
};

/** what a run says, as data the workspace shows and the report / decision agents read — the engine's sentences only */
export function runDigest(run: ResearchRunLite, max = 12) {
  const holding = run.findings.filter(holds);
  return {
    computedAt: run.computedAt, environment: run.environment ?? null, n: run.n,
    findings: run.findings.length, holding: holding.length,
    top: rankFindings(holding).slice(0, max).map((f) => ({ id: f.id, headline: f.headline, strength: f.strength, analysis: f.analysis.name, p: f.evidence.adjusted?.p ?? f.evidence.p ?? null, n: f.evidence.n })),
    verdicts: run.verdicts.map((v) => ({ label: v.label, text: v.text, verdict: v.corrected?.verdict ?? v.verdict, reason: v.corrected?.note ?? v.reason, evidence: v.findings.filter(holds).map((f) => f.id) })),
    failedAnalyses: run.items.filter((i) => !i.result && !(i.findings?.length)).map((i) => i.definition.name).slice(0, 20),
  };
}

const runVerify: StepHandler["run"] = async (ctx) => {
  const b = backend();
  if (!b) return { status: "blocked", reason: NO_DATA, needs: "config" };
  const ds = datasetOf(ctx.step.input);
  const run = await b.latestRun(ctx.surveyId, ds.environment);
  if (!run) return { status: "failed", reason: "The plan was applied but no run was stored, so there is nothing to verify. Run it again from Data Analytics.", permanent: true };
  const d = runDigest(run);
  const errors: string[] = [];
  if (!run.n) errors.push("The run has no respondents in it.");
  const warnings = [
    ...d.verdicts.filter((v) => v.verdict === "untested").map((v) => `${v.label}: untested — no planned analysis reads it.`),
    ...(d.failedAnalyses.length ? [`${d.failedAnalyses.length} analysis(es) produced no result: ${d.failedAnalyses.slice(0, 5).join(", ")}`] : []),
    ...(run.n && run.n < 100 ? [`The base is small (n = ${run.n}); differences need to be large to show.`] : []),
  ];
  return { status: "completed", output: { data: d, validation: { ok: errors.length === 0, errors, warnings } } };
};

export const analysisPlanner: TaskPlanner = {
  id: "analysis",
  /*
   * Started by name only (the workspace launcher, POST /api/copilot/tasks { planner: "analysis" }), which checks
   * `analytics.edit` — applying a plan writes the analytics tables. A Copilot turn holds only the edit right on the
   * questionnaire, so the planner never claims a turn's sentence by itself.
   */
  matches: () => 0,
  async plan({ message, options }) {
    const ds = datasetOf(options ?? {});
    const where = `${ENV_WORD[ds.environment]} responses${ds.dataset === "clean" ? ", clean dataset" : ""}`;
    const steps: TaskStepSpec[] = [
      { id: "check", kind: "analysis.check", title: "Check the analysis plan", dependsOn: [], input: { ...ds } },
      { id: "apply", kind: "analysis.apply", title: `Run every planned analysis on the ${where}`, dependsOn: ["check"], input: { ...ds } },
      { id: "verify", kind: "analysis.verify", title: "Verify findings and hypothesis verdicts", dependsOn: ["apply"], input: { ...ds } },
    ];
    return { summary: { goal: message.slice(0, 200), deliverables: [`analysis run on ${where}`], decisions: [], constraints: ["numbers come from the analytics engine only"], sourceTurnIds: [] }, steps, completion: [] };
  },
};

export function registerResearchTasks(): void {
  registerTaskPlanner(analysisPlanner);
  registerStepHandler({ kind: "analysis.check", run: runCheck });
  registerStepHandler({ kind: "analysis.apply", run: runApply });
  registerStepHandler({ kind: "analysis.verify", run: runVerify });
}

/** test seam: one step run directly */
export const __research = { runCheck, runApply, runVerify } as Record<string, (ctx: StepContext) => Promise<StepResult>>;
