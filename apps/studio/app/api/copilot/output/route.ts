import { NextRequest, NextResponse } from "next/server";
import { aiConfigured, aiProviderName, completeJson } from "@rescript/ai";
import { SurveyDefinition } from "@rescript/schema";
import type { OutputRequest } from "@rescript/engine";
import { briefText, buildDataset, compareRuns, deckFromRun, describeDeck, gateNarrative, runPlan, NARRATIVE_INSTRUCTIONS, type AnalyticsRow, type AnalysisResult, type NarrativeSections } from "@rescript/analytics";
import { buildDeckPptx, buildFindingsDocx, buildProposalDocx } from "@rescript/analytics/export";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireProject, requireUser, type AuthedUser } from "@/lib/guard";
import { billingProjectFor, meteredAi } from "@/lib/metering";
import { outputBudget } from "@/lib/copilot/budget";
import { buildFor, loadDefinition, previousRun } from "@/lib/analytics";

/**
 * A DOCUMENT FROM THE RESEARCH ENGINE (Research Engine audit, Phase 5).
 *
 * The engine read "create the client-ready research proposal" / "create
 * the final findings presentation" / "write the findings report as a Word
 * document" into an OutputRequest; this route makes the file. The proposal
 * comes from the survey and its research design alone. The findings
 * outputs come from a fresh run of the plan on the survey's clean live
 * data (the same dataset the workspace reads), so the file says what the
 * data says today; the story's words are the engine's, and when a model is
 * configured it is asked once — from the run's brief and nothing else — for
 * a headline, a summary, implications and recommendations, which pass the
 * narrative gate sentence by sentence before they replace the engine's.
 * What the gate kept and dropped travels in the response headers.
 *
 * Who may ask: a signed-in user with `project.read` for the proposal and
 * `analytics.export` for the findings outputs. The sandbox, against the
 * fake provider only, may send its own definition, rows and a scripted
 * narrative, so the browser suites can see the whole path.
 */
export const dynamic = "force-dynamic";
const TYPES = new Set(["proposal_docx", "findings_docx", "findings_pptx"]);
const AUDIENCES = new Set(["executive", "client", "researcher"]);
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "document";
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 900);

function readOutput(x: unknown): OutputRequest | string {
  const o = (x ?? {}) as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  if (!TYPES.has(type)) return "the output needs a type (proposal_docx, findings_docx, findings_pptx)";
  const audience = typeof o.audience === "string" && AUDIENCES.has(o.audience) ? o.audience : "client";
  const client = typeof o.client === "string" && o.client.trim() ? o.client.trim().slice(0, 80) : undefined;
  return { type: type as OutputRequest["type"], audience: audience as OutputRequest["audience"], ...(client ? { client } : {}), words: typeof o.words === "string" ? o.words.slice(0, 120) : type };
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  let body: { surveyId?: unknown; output?: unknown; definition?: unknown; rows?: unknown; narrative?: unknown; fake?: unknown; environment?: unknown; dataset?: unknown; previous?: unknown };
  try { body = await req.json(); } catch { return isFailure(authed) ? authed.response : json({ error: "bad json" }, 400); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  const sandbox = surveyId === "sandbox";
  const fakeProvider = aiProviderName() === "fake";
  if (isFailure(authed) && !(sandbox && fakeProvider)) return authed.response;
  const user: AuthedUser | null = isFailure(authed) ? null : authed;
  const output = readOutput(body.output);
  if (typeof output === "string") return json({ error: output }, 400);

  /* the survey, the client and the fieldwork dates */
  let def: SurveyDefinition;
  let client = output.client, fieldwork: { from?: string; to?: string } | undefined;
  const db = sandbox ? null : supabaseService();
  let loaded: Awaited<ReturnType<typeof loadDefinition>> | null = null;
  if (sandbox) {
    const parsed = SurveyDefinition.safeParse(body.definition);
    if (!parsed.success) return json({ error: "send the survey as it is open in the editor (definition)" }, 400);
    def = parsed.data;
  } else {
    const ctx = await requireProject(req, surveyId, output.type === "proposal_docx" ? "project.read" : "analytics.export");
    if (isFailure(ctx)) return ctx.response;
    loaded = await loadDefinition(db!, surveyId);
    if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
    def = loaded.def as SurveyDefinition;
    const proj = await db!.from("surveys").select("fieldwork_from, fieldwork_to, client_name").eq("id", surveyId).maybeSingle();
    // Phase 8: the brief's client first — it is part of the design the researcher approved; the project's client name stands in when there is none
    client ??= def.research?.brief?.client ?? (proj.data?.client_name ? String(proj.data.client_name) : undefined);
    if (proj.data?.fieldwork_from || proj.data?.fieldwork_to) fieldwork = { ...(proj.data?.fieldwork_from ? { from: String(proj.data.fieldwork_from).slice(0, 10) } : {}), ...(proj.data?.fieldwork_to ? { to: String(proj.data.fieldwork_to).slice(0, 10) } : {}) };
  }
  const author = user?.email ?? undefined;
  const date = new Date().toISOString().slice(0, 10);
  const base = safeName(def.research?.objective ? def.research.objective.slice(0, 50) : def.meta.title);

  if (output.type === "proposal_docx") {
    const buf = await buildProposalDocx(def, { client, author, date, fieldwork });
    return new NextResponse(new Uint8Array(buf), { status: 200, headers: { "content-type": DOCX, "content-disposition": `attachment; filename="${base}-research-proposal.docx"`, "cache-control": "no-store", "x-rescript-output": ascii(`Research proposal: ${def.research?.hypotheses.length ?? 0} hypotheses, ${def.questions.length} questions, ${def.research?.analysisPlan ? "the saved analysis plan" : "the design's analysis plan"}`) } });
  }

  /* the findings outputs: a fresh run of the plan on the data */
  let dataset;
  if (sandbox) {
    const rows = Array.isArray(body.rows) ? (body.rows as AnalyticsRow[]).slice(0, 5000) : [];
    if (!rows.length) return json({ error: "The sandbox has no respondents to report on — open a survey with fieldwork and ask there.", code: "no_data" }, 409);
    dataset = buildDataset(def, rows, { spec: { environment: "ALL", dataset: "all" } });
  } else {
    const environment = body.environment === "TEST" || body.environment === "ALL" ? body.environment : "LIVE";
    dataset = await buildFor(db!, surveyId, loaded!, { name: "output", kind: "descriptive", dataset: { environment, dataset: body.dataset === "all" ? "all" : "clean" }, variables: [] });
    if (!dataset.cases.length) return json({ error: "No completes in the data yet — the findings outputs need respondents.", code: "no_data" }, 409);
  }
  const run = runPlan(def, dataset, { trigger: "output" });
  if (!run.items.length) return json({ error: "Nothing is planned yet — plan the analysis in Intelligent mode (Analysis tab) first.", code: "no_plan" }, 409);
  /* Phase 8: since the last wave — the latest stored run on the same data (the sandbox, with no database, may send the previous run itself) */
  const previous = sandbox
    ? (body.previous && typeof body.previous === "object" && Array.isArray((body.previous as { findings?: unknown }).findings) ? body.previous as Parameters<typeof compareRuns>[1] : null)
    : await previousRun(db!, surveyId, dataset.spec, run.computedAt);
  if (previous) run.since = compareRuns(run, previous);
  const results: Record<string, AnalysisResult> = Object.fromEntries(run.items.map((it) => [it.definition.options?.planned ? String(it.definition.options.planned) : it.definition.name, it.result]));

  /* the narrative: the model, from the brief only, through the gate */
  let narrative: NarrativeSections | undefined;
  let gate = "none";
  if (body.narrative !== false && aiConfigured()) {
    const fake = fakeProvider && body.fake && typeof body.fake === "object" ? body.fake : null;
    let raw: unknown = fake;
    if (!raw) {
      const billing = await billingProjectFor(user, surveyId);
      if (!("response" in billing)) {
        const brief = briefText(run, { maxFindings: 25 });
        const prompt = `${NARRATIVE_INSTRUCTIONS}\n\nAUDIENCE: ${output.audience}.\n\nRUN BRIEF:\n${brief}`;
        const nb = outputBudget("narrative");
        const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: prompt, maxTokens: nb.expectedTokens, operation: "copilot_narrative" }, () => completeJson("You write research findings for clients. Answer with JSON only.", prompt, nb.maxTokens, { timeoutMs: nb.timeoutMs, continuations: nb.continuations })).catch(() => null);
        raw = m && m.ok ? m.value : null;
      }
    }
    const g = raw && typeof raw === "object" ? gateNarrative(run, raw as Record<string, unknown>) : null;
    if (g && g.offered) {
      narrative = g.accepted;
      gate = `${g.kept} of ${g.offered} sentences kept${g.rejected.length ? `; dropped: ${g.rejected.map((r) => `${r.section}: ${r.reason}`).join(" | ")}` : ""}`;
    } else gate = "the model gave nothing - the engine's words stand";
  } else if (body.narrative === false) gate = "not asked";
  else gate = "no model configured - the engine's words stand";

  const opts = { audience: output.audience, client, author, date, results, narrative };
  if (output.type === "findings_pptx") {
    const deck = deckFromRun(def, run, opts);
    const buf = await buildDeckPptx({ deck, results, author, footer: client ? `Prepared for ${client}` : undefined });
    return new NextResponse(new Uint8Array(buf), { status: 200, headers: { "content-type": PPTX, "content-disposition": `attachment; filename="${base}-findings-${output.audience}.pptx"`, "cache-control": "no-store", "x-rescript-output": ascii(`${describeDeck(deck)} - ${run.n} completes`), "x-rescript-narrative": ascii(gate) } });
  }
  const buf = await buildFindingsDocx(def, run, opts);
  return new NextResponse(new Uint8Array(buf), { status: 200, headers: { "content-type": DOCX, "content-disposition": `attachment; filename="${base}-findings-report.docx"`, "cache-control": "no-store", "x-rescript-output": ascii(`Findings report: ${run.verdicts.length} hypotheses, ${run.findings.filter((f) => f.significant).length} significant findings - ${run.n} completes${run.since ? ` - since the last wave (${run.since.previous.computedAt.slice(0, 10)})` : ""}`), "x-rescript-narrative": ascii(gate) } });
}
