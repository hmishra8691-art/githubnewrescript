import { NextRequest, NextResponse } from "next/server";
import { aiConfigured, aiModelName, aiProviderName } from "@rescript/ai";
import { SurveyDefinition } from "@rescript/schema";
import { modelSteps, researchWorkflow, type ExecutionMode, type ResearchWorkflow } from "@rescript/engine";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireProject, requireUser, type AuthedUser } from "@/lib/guard";
import { billingProjectFor, estimateAi } from "@/lib/metering";
import { loadDefinition } from "@/lib/analytics";

/**
 * THE RESEARCH AGENT'S WORKFLOW (Research Engine audit, Phase 6).
 *
 * The planner (`researchWorkflow`) is pure: it reads the survey and says
 * which step is done, what the engine does next, what the researcher must
 * answer and where a model is wanted. This route gives it what only the
 * server knows — whether fieldwork data exists, the project's execution
 * mode — and prices every model step before anything is called, so the
 * card can show the cost of a step next to the button that runs it.
 *
 * EXECUTION CHOICE. The project setting `settings.ai.mode` ("internal" |
 * "cloud") is the project's choice; a request may override it for one call
 * (`mode`), and `setMode` records a new project choice (survey.edit). In
 * INTERNAL mode no model is called: a model step becomes the engine's
 * alternative or a question to the researcher. The effective mode travels
 * back so the Studio shows what it did.
 *
 * Who may ask: `project.read`. The sandbox, against the fake provider only,
 * sends its own definition and keeps its mode in the browser.
 */
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const MODES = new Set<ExecutionMode>(["internal", "cloud"]);
const modeOf = (x: unknown): ExecutionMode | null => (typeof x === "string" && MODES.has(x as ExecutionMode) ? (x as ExecutionMode) : null);

export interface WorkflowResponse {
  workflow: ResearchWorkflow;
  mode: { project: ExecutionMode; effective: ExecutionMode; override: boolean; /** the sandbox keeps its choice in the browser — the request's `mode` is it */ sandbox: boolean };
  /** the model available for cloud steps, and whether one is configured at all */
  model: { configured: boolean; provider: string | null; small: string; large: string };
  /** each model step priced before any call; the total of what the cloud steps would cost from here */
  cost: { steps: { id: string; tier: string; model: string; charge: number }[]; total: number; currency: "credits" };
  runAvailable: boolean;
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  let body: { surveyId?: unknown; definition?: unknown; objective?: unknown; produced?: unknown; mode?: unknown; setMode?: unknown; runAvailable?: unknown };
  try { body = await req.json(); } catch { return isFailure(authed) ? authed.response : json({ error: "bad json" }, 400); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  const sandbox = surveyId === "sandbox";
  const fakeProvider = aiProviderName() === "fake";
  if (isFailure(authed) && !(sandbox && fakeProvider)) return authed.response;
  const user: AuthedUser | null = isFailure(authed) ? null : authed;
  const override = modeOf(body.mode);
  const setMode = modeOf(body.setMode);
  if (body.setMode !== undefined && !setMode) return json({ error: "setMode must be internal or cloud" }, 400);

  let def: SurveyDefinition;
  let projectMode: ExecutionMode = "cloud";
  let runAvailable = false;
  if (sandbox) {
    const parsed = SurveyDefinition.safeParse(body.definition);
    if (!parsed.success) return json({ error: "send the survey as it is open in the editor (definition)" }, 400);
    def = parsed.data;
    runAvailable = body.runAvailable === true;
    /* the sandbox has no project row: its choice lives in the browser and comes as the request's `mode`; `setMode` here is that choice confirmed */
    projectMode = setMode ?? "cloud";
  } else {
    const ctx = await requireProject(req, surveyId, setMode ? "survey.edit" : "project.read");
    if (isFailure(ctx)) return ctx.response;
    const db = supabaseService();
    const loaded = await loadDefinition(db, surveyId);
    if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
    def = loaded.def as SurveyDefinition;
    const [proj, completes] = await Promise.all([
      db.from("surveys").select("settings").eq("id", surveyId).maybeSingle(),
      db.from("responses").select("id", { count: "exact", head: true }).eq("survey_id", surveyId).is("deleted_at", null).eq("status", "complete").eq("is_test", false),
    ]);
    const settings = (proj.data?.settings && typeof proj.data.settings === "object" ? proj.data.settings : {}) as Record<string, unknown>;
    const ai = (settings.ai && typeof settings.ai === "object" ? settings.ai : {}) as Record<string, unknown>;
    projectMode = modeOf(ai.mode) ?? "cloud";
    runAvailable = (completes.count ?? 0) > 0;
    if (setMode && setMode !== projectMode) {
      /* merged server-side: the setting is one key of a bag other panels write */
      const up = await db.from("surveys").update({ settings: { ...settings, ai: { ...ai, mode: setMode } } }).eq("id", surveyId);
      if (up.error) return json({ error: `could not save the execution mode: ${up.error.message}` }, 500);
      projectMode = setMode;
    }
  }
  const effective = override ?? projectMode;
  const configured = aiConfigured();
  const wf = researchWorkflow(def, { mode: configured ? effective : "internal", runAvailable, ...(typeof body.objective === "string" && body.objective.trim() ? { objective: body.objective.trim().slice(0, 500) } : {}), ...(Array.isArray(body.produced) ? { produced: body.produced.filter((x): x is "design_document" | "deck" => x === "design_document" || x === "deck") } : {}) });

  /* the cost of every model step, priced and never reserved */
  const steps: WorkflowResponse["cost"]["steps"] = [];
  let total = 0;
  const priced = modelSteps(wf);
  if (priced.length && configured) {
    const billing = await billingProjectFor(user, surveyId, "project.read");
    if (!("response" in billing)) {
      for (const m of priced) {
        const tier = m.tier === "small" ? "small" : "large";
        const charge = await estimateAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: m.estimateText, maxTokens: m.maxTokens, operation: m.operation, tier });
        steps.push({ id: m.id, tier, model: aiModelName(tier), charge });
        if (effective === "cloud") total += charge;
      }
    }
  }
  const out: WorkflowResponse = {
    workflow: wf,
    mode: { project: projectMode, effective: configured ? effective : "internal", override: !!override && override !== projectMode, sandbox },
    model: { configured, provider: aiProviderName(), small: aiModelName("small"), large: aiModelName("large") },
    cost: { steps, total: Math.round(total * 10000) / 10000, currency: "credits" },
    runAvailable,
  };
  return json(out);
}
