import { NextRequest, NextResponse } from "next/server";
import { aiConfigured, aiModelName, aiProviderName, completeJson } from "@rescript/ai";
import { aiAllowed } from "@/lib/aiPolicy";
import { keepReply, recordAiRefused, recordAiText, replyFromCache, replyKey } from "@/lib/aiText";
import { SurveyDefinition } from "@rescript/schema";
import type { OutputRequest } from "@rescript/engine";
import { briefText, buildDataset, compareRuns, deckFromRun, describeDeck, gateNarrative, claimsBrief, claimsFromRun, claimsHash, promptVersion, redactPrompt, redactRunForModel, hash64, runPlan, NARRATIVE_INSTRUCTIONS, type AnalyticsRow, type AnalysisResult, type NarrativeSections } from "@rescript/analytics";
import { buildDeckPptx, buildFindingsDocx, buildProposalDocx, buildSapDocx } from "@rescript/analytics/export";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireProject, requireUser, type AuthedUser } from "@/lib/guard";
import { billingProjectFor, meteredAi } from "@/lib/metering";
import { aiReadyFor, connectionTag } from "@/lib/byok/connect";
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
const TYPES = new Set(["proposal_docx", "sap_docx", "findings_docx", "findings_pptx"]);
/** the documents made from the survey and its research design alone — `project.read`, no data needed */
const DESIGN_ONLY = new Set(["proposal_docx", "sap_docx"]);
const AUDIENCES = new Set(["executive", "client", "researcher"]);
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "document";
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 900);

function readOutput(x: unknown): OutputRequest | string {
  const o = (x ?? {}) as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  if (!TYPES.has(type)) return "the output needs a type (proposal_docx, sap_docx, findings_docx, findings_pptx)";
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
    const ctx = await requireProject(req, surveyId, DESIGN_ONLY.has(output.type) ? "project.read" : "analytics.export");
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

  if (output.type === "sap_docx") {
    const buf = await buildSapDocx(def, { client, author, date });
    const sapPlan = def.research?.analysisPlan;
    return new NextResponse(new Uint8Array(buf), { status: 200, headers: { "content-type": DOCX, "content-disposition": `attachment; filename="${safeName(def.meta.title)}-analysis-plan.docx"`, "cache-control": "no-store", "x-rescript-output": ascii(`Statistical analysis plan: ${sapPlan ? `${sapPlan.tests.length} tests, ${sapPlan.crosstabs.length} crosstabs from the saved plan` : "derived from the design - no analysis plan is saved yet"}`) } });
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
  /* the plan's own multiple-comparison rule (DOC-03) is the run's correction; absent, the runner's default (Holm) stands */
  const run = runPlan(def, dataset, { trigger: "output", ...(def.research?.analysisPlan?.multipleComparisons ? { correction: def.research.analysisPlan.multipleComparisons } : {}) });
  if (!run.items.length) return json({ error: "Nothing is planned yet — plan the analysis in Intelligent mode (Analysis tab) first.", code: "no_plan" }, 409);
  /* Phase 8: since the last wave — the latest stored run on the same data (the sandbox, with no database, may send the previous run itself) */
  const previous = sandbox
    ? (body.previous && typeof body.previous === "object" && Array.isArray((body.previous as { findings?: unknown }).findings) ? body.previous as Parameters<typeof compareRuns>[1] : null)
    : await previousRun(db!, surveyId, dataset.spec, run.computedAt);
  if (previous) run.since = compareRuns(run, previous);
  const results: Record<string, AnalysisResult> = Object.fromEntries(run.items.map((it) => [it.definition.options?.planned ? String(it.definition.options.planned) : it.definition.name, it.result]));

  /*
   * THE NARRATIVE: the model, from the claims only, through the gate (audit A-1).
   * What is sent is redacted first (A-7: no group below the minimum, no
   * open-text words, no email or phone), the project's AI switch is asked
   * before the cache is read (A-2), the reply is kept under its claims and
   * prompt version (A-6), and the same redacted view is what the checker reads,
   * so a claim that was withheld cannot be cited. What stands is recorded.
   */
  let narrative: NarrativeSections | undefined;
  let gate = "none";
  if (body.narrative !== false && await aiReadyFor(user, surveyId, "copilot_narrative")) {
    const fake = fakeProvider && body.fake && typeof body.fake === "object" ? body.fake : null;
    const red = redactRunForModel(run);
    const claims = claimsFromRun(red.run);
    const pv = promptVersion(NARRATIVE_INSTRUCTIONS);
    const model = aiModelName("large");
    let raw: unknown = fake;
    let aiOff: string | null = null;
    let cached = false;
    let failure: string | null = null;
    let charge = 0;
    /* the project's AI switch comes first, whatever supplies the reply */
    const allowed = await aiAllowed(surveyId, "copilot_narrative");
    if (!allowed.allowed) { raw = null; aiOff = allowed.message ?? "AI is off for this project."; void recordAiRefused({ userId: user?.userId ?? null, surveyId }, "copilot_narrative", allowed.reason ?? "project_internal"); }
    else if (!raw) {
        const brief = briefText(red.run, { maxFindings: 25 });
        const prompt = redactPrompt(`${NARRATIVE_INSTRUCTIONS}\n\nAUDIENCE: ${output.audience}.\n\nRUN BRIEF:\n${brief}\n\nCLAIMS (cite these ids):\n${claimsBrief(claims)}`).text;
        /* an answer is only reused under the connection that wrote it: the platform's keep their keys; a user's own provider adds its identity (no secret) */
        const conn = await connectionTag({ userId: user?.userId, customerId: user?.customerId, surveyId, operation: "copilot_narrative" });
        const key = replyKey({ op: "narrative", pv, model, audience: output.audience, claims: claimsHash(claims), brief: hash64(brief), ...(conn ? { conn } : {}) });
        const hit = await replyFromCache<unknown>(db ?? undefined, surveyId, key);
        if (hit) { raw = hit; cached = true; }
        else {
          const billing = await billingProjectFor(user, surveyId);
          if (!("response" in billing)) {
            const nb = outputBudget("narrative");
            const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: prompt, maxTokens: nb.expectedTokens, operation: "copilot_narrative" }, () => completeJson("You write research findings for clients. Answer with JSON only.", prompt, nb.maxTokens, { timeoutMs: nb.timeoutMs, continuations: nb.continuations })).catch((e: unknown) => { failure = e instanceof Error ? e.message : "the model call failed"; return null; });
            if (m && !m.ok) { if (m.reason === "ai_off") aiOff = m.message; else failure = m.message; }
            if (m && m.ok) { raw = m.value; charge = m.event?.customerCharge ?? 0; await keepReply(db ?? undefined, surveyId, key, raw); }
          }
        }
    }
    const g = raw && typeof raw === "object" ? gateNarrative(red.run, raw as Record<string, unknown>, { claims }) : null;
    if (g && g.offered) {
      narrative = g.accepted;
      gate = `${g.kept} of ${g.offered} sentences kept${g.replaced ? `; ${g.replaced} replaced by the engine's wording` : ""}${g.rejected.length ? `; dropped: ${g.rejected.map((r) => `${r.section}: ${r.reason}`).join(" | ")}` : ""}${red.withheld.length ? `; ${red.withheld.length} small-group finding${red.withheld.length === 1 ? "" : "s"} not sent to the model` : ""}`;
      if (!fake) void recordAiText({ userId: user?.userId ?? null, surveyId }, { operation: "copilot_narrative", model, promptVersion: pv, claimsHash: claimsHash(claims), claims: [...new Set(g.sentences.flatMap((x) => x.claims))], offered: g.offered, kept: g.kept, replaced: g.replaced, rejected: g.rejected.map((r) => ({ reason: r.reason })), withheld: red.withheld, cached, charge });
    } else gate = aiOff ? `${aiOff} The engine's words stand.` : failure ? `the model could not be used (${failure}) - the engine's words stand` : "the model gave nothing - the engine's words stand";
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
