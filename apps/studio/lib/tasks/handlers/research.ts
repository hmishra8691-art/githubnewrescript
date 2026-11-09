import type { SurveyDefinition } from "@rescript/schema";
import { deckFromRun, holds, plannedAnalyses, rankFindings, type DatasetSpec, type DeckSlide, type Finding, type HypothesisVerdict } from "@rescript/analytics";
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

const NO_DATA = "This works on a saved project's responses, and this survey has no database behind it (the sandbox). Open a saved survey to run it.";

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

/* ------------------------------------------------------------ the report-writing agent */

/**
 * THE REPORT-WRITING AGENT (phase 3). A storyline from the latest stored run, written by the analytics engine's
 * storytelling deck (`deckFromRun` — the same one the findings .pptx is made from): summary, key findings with the
 * chart chosen for the audience, segments, the strongest effects, implications, recommendations, method, caveats.
 * A focus the researcher names is led with when a key finding matches it. The files themselves come from the
 * existing output route, which asks a model once (when one is configured) and passes every sentence through the
 * narrative gate — so this agent never writes a number either.
 */
const AUDIENCES = new Set(["client", "executive", "researcher"]);

async function evidence(ctx: StepContext): Promise<StepResult | { run: ResearchRunLite; def: SurveyDefinition }> {
  const b = backend();
  if (!b) return { status: "blocked", reason: NO_DATA, needs: "config" };
  const got = await b.definition(ctx.surveyId);
  if ("error" in got) return { status: "failed", reason: `The survey could not be read: ${got.error}`, permanent: true };
  const env = ctx.step.input.environment === "TEST" || ctx.step.input.environment === "ALL" || ctx.step.input.environment === "LIVE" ? ctx.step.input.environment as DatasetSpec["environment"] : undefined;
  const run = await b.latestRun(ctx.surveyId, env);
  if (!run) return { status: "blocked", reason: "There is no analysis run to work from yet. Run the Analysis agent (or Apply the plan in Data Analytics), then resume.", needs: "user_input" };
  if (!run.n) return { status: "blocked", reason: "The latest run has no respondents in it. Run the analysis on data with responses, then resume.", needs: "user_input" };
  return { run, def: got.def };
}
const isResult = (x: unknown): x is StepResult => !!x && typeof x === "object" && "status" in (x as object);

const runEvidence: StepHandler["run"] = async (ctx) => {
  const e = await evidence(ctx);
  if (isResult(e)) return e;
  const d = runDigest(e.run);
  return ok(d, d.holding ? [] : ["No finding holds after correction in the latest run — the report will say so rather than overstate anything."]);
};

/** one slide as the workspace lists it: its kind, its title and the engine's own words */
export function slideOutline(s: DeckSlide): { type: string; title: string; points: string[]; significant?: boolean } {
  switch (s.type) {
    case "title": return { type: s.type, title: s.title, points: [s.subtitle] };
    case "summary": return { type: s.type, title: s.title, points: [s.headline, ...s.bullets] };
    case "key_finding": return { type: s.type, title: s.title, points: [s.evidence, s.soWhat].filter(Boolean), significant: s.significant };
    case "segment_comparison": return { type: s.type, title: s.title, points: [s.differs, ...s.groups.slice(0, 6).map((g) => `${g.label}: ${g.value} (n = ${g.n})`)] };
    case "statistical_highlight": return { type: s.type, title: s.title, points: [`${s.label}: ${s.stat} (${s.test}, ${s.p}, n = ${s.n})`, s.context] };
    case "implications": case "caveats": return { type: s.type, title: s.title, points: s.bullets };
    case "recommendations": return { type: s.type, title: s.title, points: s.items };
    case "method": return { type: s.type, title: s.title, points: s.items.map((i) => `${i.label}: ${i.value}`) };
    case "wave_change": return { type: s.type, title: s.title, points: [...s.changes, ...s.verdicts] };
    case "quotes": return { type: s.type, title: s.title, points: s.quotes.slice(0, 3).map((q) => `“${q.quote}” — ${q.source}`) };
    default: return { type: (s as { type: string }).type, title: (s as { title?: string }).title ?? "", points: [] };
  }
}

/** lead with the key finding a focus phrase names (word overlap, deterministic); everything else keeps the engine's order */
export function leadWith(slides: DeckSlide[], focus: string | undefined): { slides: DeckSlide[]; led: string | null } {
  const words = (focus ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  if (!words.length) return { slides, led: null };
  const score = (s: DeckSlide) => (s.type === "key_finding" ? words.filter((w) => `${s.title} ${s.evidence}`.toLowerCase().includes(w)).length : 0);
  let best = -1, at = -1;
  slides.forEach((s, i) => { const sc = score(s); if (sc > best) { best = sc; at = i; } });
  if (best <= 0) return { slides, led: null };
  const first = slides.findIndex((s) => s.type === "key_finding");
  if (first < 0 || at === first) return { slides, led: (slides[at] as { title: string }).title };
  const out = [...slides];
  const [m] = out.splice(at, 1);
  out.splice(first, 0, m);
  return { slides: out, led: (m as { title: string }).title };
}

const runStoryline: StepHandler["run"] = async (ctx) => {
  const e = await evidence(ctx);
  if (isResult(e)) return e;
  const audience = AUDIENCES.has(String(ctx.step.input.audience)) ? String(ctx.step.input.audience) as "client" : "client";
  let deck;
  try { deck = deckFromRun(e.def, e.run as never, { audience, maxFindings: 8 }); } catch (err) { return { status: "failed", reason: `The storyline could not be made: ${(err as Error).message}`, permanent: true }; }
  const { slides, led } = leadWith(deck.slides, typeof ctx.step.input.focus === "string" ? ctx.step.input.focus : undefined);
  const warnings: string[] = [];
  if (typeof ctx.step.input.focus === "string" && ctx.step.input.focus && !led) warnings.push(`No key finding matches “${ctx.step.input.focus}”, so the engine's order is kept.`);
  return ok({ title: deck.title, subtitle: deck.subtitle, audience, led, n: e.run.n, computedAt: e.run.computedAt, slides: slides.map(slideOutline) }, warnings);
};

const runReportCheck: StepHandler["run"] = async (ctx) => {
  const story = ctx.deps.storyline?.data as { slides?: { type: string; title: string; significant?: boolean }[]; n?: number } | undefined;
  if (!story?.slides) return { status: "failed", reason: "The storyline step left nothing to check.", permanent: true };
  const errors: string[] = [], warnings: string[] = [];
  const types = new Set(story.slides.map((s) => s.type));
  for (const need of ["summary", "method", "caveats"]) if (!types.has(need)) errors.push(`The report has no ${need} section.`);
  const kf = story.slides.filter((s) => s.type === "key_finding");
  if (!kf.length) warnings.push("No key finding slide — the run had nothing that holds to lead with.");
  const notHolding = kf.filter((s) => s.significant === false);
  if (notHolding.length) warnings.push(`${notHolding.length} key finding slide(s) report a result that is NOT significant; the slide says so and it must not be presented as a difference.`);
  return { status: "completed", output: { data: { slides: story.slides.length, keyFindings: kf.length, sections: [...types] }, validation: { ok: errors.length === 0, errors, warnings } } };
};

export const reportPlanner: TaskPlanner = {
  id: "report",
  matches: () => 0,
  async plan({ message, options }) {
    const audience = AUDIENCES.has(String(options?.audience)) ? String(options!.audience) : "client";
    const focus = typeof options?.focus === "string" ? options.focus.slice(0, 200) : undefined;
    const input = { audience, ...(focus ? { focus } : {}) };
    return {
      summary: { goal: message.slice(0, 200), deliverables: [`findings storyline for a ${audience} audience`], decisions: [], constraints: ["every number comes from the stored run", "narrative passes the gate when downloaded"], sourceTurnIds: [] },
      steps: [
        { id: "evidence", kind: "report.evidence", title: "Read the latest verified run", dependsOn: [], input },
        { id: "storyline", kind: "report.storyline", title: `Write the storyline for a ${audience} audience${focus ? `, leading with “${focus.slice(0, 40)}”` : ""}`, dependsOn: ["evidence"], input },
        { id: "check", kind: "report.check", title: "Check sections and what each finding may claim", dependsOn: ["storyline"], input: {} },
      ],
      completion: [],
    };
  },
};

/* ------------------------------------------------------------ the decision agent */

/**
 * THE DECISION AGENT (phase 3). Turns the verdicts and the findings that hold into recommended actions, each one
 * tied to its evidence and its strength — deterministic rules over the engine's verdicts, plus the storytelling
 * deck's own implications and recommendations. It never reads a finding that does not hold as support.
 *
 *   supported        → Act on it            (strength = the strongest holding finding behind it)
 *   not supported    → Do not build on it
 *   mixed            → Resolve before acting
 *   inconclusive     → Test further
 *   untested         → Plan the analysis that would test it
 */
export interface DecisionItem { id: string; action: "act" | "avoid" | "resolve" | "test" | "plan"; title: string; basis: string; evidence: string[]; strength: "strong" | "moderate" | "weak" | "none"; caveat?: string }
const ACTION_WORD: Record<DecisionItem["action"], string> = { act: "Act on it", avoid: "Do not build on it", resolve: "Resolve before acting", test: "Test further", plan: "Plan the analysis" };
const RANK = { strong: 3, moderate: 2, weak: 1, none: 0 } as const;

export function decisionItems(run: ResearchRunLite): DecisionItem[] {
  const out: DecisionItem[] = [];
  for (const v of run.verdicts) {
    const verdict = v.corrected?.verdict ?? v.verdict;
    const holding = v.findings.filter(holds);
    const strength = holding.reduce<DecisionItem["strength"]>((m, f) => (RANK[f.strength] > RANK[m] ? f.strength : m), "none");
    const action: DecisionItem["action"] = verdict === "supported" ? "act" : verdict === "not_supported" ? "avoid" : verdict === "mixed" ? "resolve" : verdict === "untested" ? "plan" : "test";
    out.push({
      id: v.label, action, title: `${ACTION_WORD[action]}: ${v.text}`, basis: v.corrected?.note ?? v.reason, evidence: holding.map((f) => f.headline).slice(0, 4), strength,
      ...(action === "act" && strength === "weak" ? { caveat: "The supporting effect is weak — size the decision accordingly." } : {}),
      ...(run.n < 100 ? { caveat: `Small base (n = ${run.n}).` } : {}),
    });
  }
  /* findings that hold but no hypothesis asked about: discoveries worth a decision */
  const covered = new Set(run.verdicts.flatMap((v) => v.findings.map((f) => f.id)));
  for (const f of rankFindings(run.findings.filter(holds)).filter((f) => !covered.has(f.id)).slice(0, 3)) {
    out.push({ id: f.id, action: "test", title: `Beyond the plan — confirm before acting: ${f.headline}`, basis: "This holds in the data but no hypothesis predicted it; treat it as a lead.", evidence: [f.headline], strength: f.strength });
  }
  const order: DecisionItem["action"][] = ["act", "avoid", "resolve", "test", "plan"];
  return out.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action) || RANK[b.strength] - RANK[a.strength]);
}

const runDecisionEvidence: StepHandler["run"] = runEvidence;

const runBrief: StepHandler["run"] = async (ctx) => {
  const e = await evidence(ctx);
  if (isResult(e)) return e;
  const items = decisionItems(e.run);
  let implications: string[] = [], recommendations: string[] = [];
  try {
    const deck = deckFromRun(e.def, e.run as never, { audience: "executive" });
    for (const s of deck.slides) { if (s.type === "implications") implications = s.bullets; if (s.type === "recommendations") recommendations = s.items; }
  } catch { /* the decisions stand on the verdicts alone */ }
  const question = typeof ctx.step.input.question === "string" ? ctx.step.input.question : null;
  return ok({ question, n: e.run.n, computedAt: e.run.computedAt, items, implications, recommendations }, items.length ? [] : ["The plan has no hypotheses and nothing holds beyond it, so there is no decision the data can support yet."]);
};

const runDecisionCheck: StepHandler["run"] = async (ctx) => {
  const brief = ctx.deps.brief?.data as { items?: DecisionItem[] } | undefined;
  if (!brief?.items) return { status: "failed", reason: "The brief step left nothing to check.", permanent: true };
  const errors = brief.items.filter((i) => i.action === "act" && !i.evidence.length).map((i) => `${i.id}: recommended to act on with no finding that holds behind it.`);
  return { status: "completed", output: { data: { items: brief.items.length, act: brief.items.filter((i) => i.action === "act").length }, validation: { ok: errors.length === 0, errors, warnings: [] } } };
};

export const decisionPlanner: TaskPlanner = {
  id: "decision",
  matches: () => 0,
  async plan({ message, options }) {
    const question = typeof options?.question === "string" ? options.question.slice(0, 300) : undefined;
    const input = question ? { question } : {};
    return {
      summary: { goal: message.slice(0, 200), deliverables: ["decision brief tied to evidence"], decisions: [], constraints: ["only findings that hold count as support"], sourceTurnIds: [] },
      steps: [
        { id: "evidence", kind: "decision.evidence", title: "Read the verdicts and the findings that hold", dependsOn: [], input },
        { id: "brief", kind: "decision.brief", title: question ? `Recommend: ${question.slice(0, 60)}` : "Recommend next steps", dependsOn: ["evidence"], input },
        { id: "check", kind: "decision.check", title: "Check every recommendation has evidence", dependsOn: ["brief"], input: {} },
      ],
      completion: [],
    };
  },
};

export function registerResearchTasks(): void {
  registerTaskPlanner(analysisPlanner);
  registerStepHandler({ kind: "analysis.check", run: runCheck });
  registerStepHandler({ kind: "analysis.apply", run: runApply });
  registerStepHandler({ kind: "analysis.verify", run: runVerify });
  registerTaskPlanner(reportPlanner);
  registerStepHandler({ kind: "report.evidence", run: runEvidence });
  registerStepHandler({ kind: "report.storyline", run: runStoryline });
  registerStepHandler({ kind: "report.check", run: runReportCheck });
  registerTaskPlanner(decisionPlanner);
  registerStepHandler({ kind: "decision.evidence", run: runDecisionEvidence });
  registerStepHandler({ kind: "decision.brief", run: runBrief });
  registerStepHandler({ kind: "decision.check", run: runDecisionCheck });
}

/** test seam: one step run directly */
export const __research = { runCheck, runApply, runVerify, runEvidence, runStoryline, runReportCheck, runBrief, runDecisionCheck } as Record<string, (ctx: StepContext) => Promise<StepResult>>;
