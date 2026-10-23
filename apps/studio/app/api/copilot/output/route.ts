import { NextRequest, NextResponse } from "next/server";
import { aiConfigured, aiModelName, aiProviderName, completeJson } from "@rescript/ai";
import { aiAllowed } from "@/lib/aiPolicy";
import { keepReply, recordAiRefused, recordAiText, replyFromCache, replyKey } from "@/lib/aiText";
import { SurveyDefinition } from "@rescript/schema";
import type { OutputRequest } from "@rescript/engine";
import { briefText, buildDataset, compareRuns, deckFromRun, describeDeck, gateNarrative, claimsBrief, claimsFromRun, claimsHash, promptVersion, redactPrompt, redactRunForModel, hash64, runPlan, NARRATIVE_INSTRUCTIONS, type AnalyticsRow, type AnalysisResult, type NarrativeSections } from "@rescript/analytics";
import { buildDeckPptx, buildFindingsDocx, buildProposalDocx, buildResearchPlanDocx, buildSapDocx, checkDocx, checkPptx, logoFromBytes } from "@rescript/analytics/export";
import { readThemeSpec, findReportTheme, themeToReportTheme, sectionOrderFor } from "@rescript/analytics";
import { artifactFingerprint, definitionHash, editionOf, GENERATOR_VERSION, type ArtifactType } from "@/lib/artifacts/core";
import { obtainArtifact, type Produced, type Fail as ArtifactFail } from "@/lib/artifacts/service";
import { artifactDeps, documentLook, fingerprintInputs, type DocumentLook } from "@/lib/artifacts/server";
import { readStructure, themeStamp } from "@/lib/reportThemesStore";
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
 *
 * MADE ONCE, KEPT (2026-10-18, docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md):
 * a saved project's document is fingerprinted by what it is made from (the
 * definition, the edition, the data stamp and latest run, the report theme,
 * the client, the narrative mode) and stored as an artifact. Asking again for
 * the same fingerprint sends the stored, re-checked file — nothing generated,
 * no model asked; `output.regenerate` ("update the Word document", the
 * Regenerate button) makes a new version anyway. The response is the file, as
 * before, with `x-rescript-artifact-*` headers saying which stored version it
 * is, so the card and the Research tab can offer it again after a reload. The
 * report theme (the project's applied one, or one named in the sentence) styles
 * the document; it never changes a word of it.
 */
export const dynamic = "force-dynamic";
const TYPES = new Set(["proposal_docx", "sap_docx", "findings_docx", "findings_pptx", "research_plan_docx"]);
/** the documents made from the survey and its research design alone — `project.read`, no data needed */
const DESIGN_ONLY = new Set(["proposal_docx", "sap_docx", "research_plan_docx"]);
const AUDIENCES = new Set(["executive", "client", "researcher"]);
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "document";
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 900);

function readOutput(x: unknown): OutputRequest | string {
  const o = (x ?? {}) as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  if (!TYPES.has(type)) return "the output needs a type (research_plan_docx, proposal_docx, sap_docx, findings_docx, findings_pptx)";
  const audience = typeof o.audience === "string" && AUDIENCES.has(o.audience) ? o.audience : "client";
  const client = typeof o.client === "string" && o.client.trim() ? o.client.trim().slice(0, 80) : undefined;
  const theme = typeof o.theme === "string" && o.theme.trim() ? o.theme.trim().slice(0, 80) : undefined;
  return { type: type as OutputRequest["type"], audience: audience as OutputRequest["audience"], ...(client ? { client } : {}), words: typeof o.words === "string" ? o.words.slice(0, 120) : type, ...(o.regenerate === true ? { regenerate: true } : {}), ...(theme ? { theme } : {}) };
}
const SOURCES = new Set(["copilot", "research_tab", "workflow", "api"]);

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  let body: { surveyId?: unknown; output?: unknown; definition?: unknown; rows?: unknown; narrative?: unknown; fake?: unknown; environment?: unknown; dataset?: unknown; previous?: unknown; theme?: unknown; structure?: unknown; regenerate?: unknown; source?: unknown; visibility?: unknown };
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

  /* THE LOOK (2026-10-18): the project's applied report theme, or one named in the sentence; the sandbox sends its own */
  let look: DocumentLook = { theme: null, structure: null, logo: null };
  if (sandbox) {
    const t = readThemeSpec(body.theme) ?? (output.theme ? findReportTheme(output.theme) : null);
    const dataLogo = t?.branding.logo.placement !== "none" && t?.branding.logo.url?.startsWith("data:image/") ? /^data:image\/(?:png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i.exec(t.branding.logo.url) : null;
    look = { theme: t, structure: readStructure(body.structure), logo: dataLogo ? logoFromBytes(Buffer.from(dataLogo[1], "base64")) : null, ...(output.theme ? { named: { name: output.theme, found: !!t } } : {}) };
  } else {
    look = await documentLook(db!, { surveyId, customerId: user?.customerId ?? null, userId: user?.userId ?? null, themeName: output.theme ?? null }).catch(() => look);
  }
  if (output.theme && look.named && !look.named.found) return json({ error: `There is no report theme called “${output.theme}”. Describe it (colours, headings, fonts, tables) and it can be created and saved under that name — or pick one of the built-in themes: Executive Research, Healthcare Analytics, Brand Performance, Consumer Insights, Academic Research.`, code: "theme_unknown" }, 404);
  const styled = { theme: look.theme, logo: look.logo };

  /*
   * NO LINK TO A FILE WORD CANNOT OPEN (2026-10-17): every Word document is checked as a package — the
   * required parts, every XML part well-formed, every relationship resolved — before it is sent; a file
   * that fails is refused here with what is wrong, so the copilot and the Research tab never offer it.
   * 2026-10-18: a made document is returned to `obtainArtifact`, which keeps it (or, for the same
   * fingerprint, sends the kept one without calling this at all).
   */
  type Made = Produced & { extra?: Record<string, string> };
  const docx = (buf: Buffer, name: string, said: string, extra: Record<string, string> = {}): Made | ArtifactFail => {
    const c = checkDocx(buf);
    if (!c.ok) { console.error("[output] a Word document failed its package check", JSON.stringify({ type: output.type, problems: c.problems.slice(0, 5) })); return { ok: false, status: 500, error: `The document was produced but failed its check, so it is not offered: ${c.problems.slice(0, 3).join("; ")}.`, code: "invalid_document" }; }
    return { bytes: new Uint8Array(buf), fileName: name, mime: DOCX, summary: said, narrative: extra["x-rescript-narrative"] ?? null, extra: { "x-rescript-checked": `docx ok; ${c.paragraphs} paragraphs, ${c.tables} tables` } };
  };
  const environment: "LIVE" | "TEST" | "ALL" = body.environment === "TEST" || body.environment === "ALL" ? body.environment : "LIVE";
  const datasetKind: "all" | "clean" = body.dataset === "all" ? "all" : "clean";
  const produce = async (): Promise<Made | ArtifactFail> => {

  /* THE WORD RESEARCH PLAN (2026-10-17): the proposal's research-plan edition, named <SurveyCode>_Research_Plan_<date>.docx */
  if (output.type === "research_plan_docx") {
    const buf = await buildResearchPlanDocx(def, { client, author, date, fieldwork, ...styled, structure: look.structure });
    const plan = def.research?.analysisPlan;
    return docx(buf, `${safeName(String(def.meta.code ?? "") || def.meta.title)}_Research_Plan_${date}.docx`, `Research plan: ${def.research?.hypotheses.length ?? 0} hypotheses, ${def.questions.length} questions, ${plan ? `the saved analysis plan (${plan.tests.length} tests, ${plan.crosstabs.length} crosstabs)` : "the analysis plan derived from the design (not yet saved)"}, traceability, QC and limitations`);
  }

  if (output.type === "proposal_docx") {
    const buf = await buildProposalDocx(def, { client, author, date, fieldwork, ...styled, structure: look.structure });
    return docx(buf, `${base}-research-proposal.docx`, `Research proposal: ${def.research?.hypotheses.length ?? 0} hypotheses, ${def.questions.length} questions, ${def.research?.analysisPlan ? "the saved analysis plan" : "the design's analysis plan"}`);
  }

  if (output.type === "sap_docx") {
    const buf = await buildSapDocx(def, { client, author, date, ...styled, structure: look.structure });
    const sapPlan = def.research?.analysisPlan;
    return docx(buf, `${safeName(def.meta.title)}-analysis-plan.docx`, `Statistical analysis plan: ${sapPlan ? `${sapPlan.tests.length} tests, ${sapPlan.crosstabs.length} crosstabs from the saved plan` : "derived from the design - no analysis plan is saved yet"}`);
  }

  /* the findings outputs: a fresh run of the plan on the data */
  let dataset;
  if (sandbox) {
    const rows = Array.isArray(body.rows) ? (body.rows as AnalyticsRow[]).slice(0, 5000) : [];
    if (!rows.length) return { ok: false, status: 409, error: "The sandbox has no respondents to report on — open a survey with fieldwork and ask there.", code: "no_data" };
    dataset = buildDataset(def, rows, { spec: { environment: "ALL", dataset: "all" } });
  } else {
    dataset = await buildFor(db!, surveyId, loaded!, { name: "output", kind: "descriptive", dataset: { environment, dataset: datasetKind }, variables: [] });
    if (!dataset.cases.length) return { ok: false, status: 409, error: "No completes in the data yet — the findings outputs need respondents.", code: "no_data" };
  }
  /* the plan's own multiple-comparison rule (DOC-03) is the run's correction; absent, the runner's default (Holm) stands */
  const run = runPlan(def, dataset, { trigger: "output", ...(def.research?.analysisPlan?.multipleComparisons ? { correction: def.research.analysisPlan.multipleComparisons } : {}) });
  if (!run.items.length) return { ok: false, status: 409, error: "Nothing is planned yet — plan the analysis in Intelligent mode (Analysis tab) first.", code: "no_plan" };
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
    /* the same section order as the findings Word report (#18) */
    const buf = await buildDeckPptx({ deck, results, author, footer: client ? `Prepared for ${client}` : undefined, ...(look.theme ? { theme: themeToReportTheme(look.theme) } : {}), sectionOrder: sectionOrderFor(look.structure, "findings") });
    const pc = checkPptx(buf);
    if (!pc.ok) return { ok: false, status: 500, error: `The deck was produced but failed its check, so it is not offered: ${pc.problems.slice(0, 3).join("; ")}.`, code: "invalid_document" };
    return { bytes: new Uint8Array(buf), fileName: `${base}-findings-${output.audience}.pptx`, mime: PPTX, summary: `${describeDeck(deck)} - ${run.n} completes`, narrative: gate };
  }
  const buf = await buildFindingsDocx(def, run, { ...opts, ...styled, structure: look.structure });
  return docx(buf, `${base}-findings-report.docx`, `Findings report: ${run.verdicts.length} hypotheses, ${run.findings.filter((f) => f.significant).length} significant findings - ${run.n} completes${run.since ? ` - since the last wave (${run.since.previous.computedAt.slice(0, 10)})` : ""}`, { "x-rescript-narrative": ascii(gate) });
  };

  /* the file, as it has always been sent — with which stored version it is */
  const send = (f: { bytes: Uint8Array; fileName: string; mime: string; summary: string | null; narrative: string | null }, extra: Record<string, string>) => new NextResponse(new Uint8Array(f.bytes), { status: 200, headers: {
    "content-type": f.mime, "content-disposition": `attachment; filename="${f.fileName}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`, "cache-control": "no-store",
    "x-rescript-output": ascii(f.summary ?? ""), ...(f.narrative ? { "x-rescript-narrative": ascii(f.narrative) } : {}),
    ...(look.theme ? { "x-rescript-theme": ascii(look.theme.name), ...(look.theme.version ? { "x-rescript-theme-version": String(look.theme.version) } : {}) } : {}),
    ...(look.structure && output.type === "findings_docx" ? { "x-rescript-structure": ascii(look.structure.understood) } : {}),
    ...extra,
  } });

  if (sandbox) {
    /* no database, no store: made every time; the fingerprint is sent so the page's own (sandbox-only) store can key it */
    const made = await produce();
    if ("ok" in made && made.ok === false) return json({ error: made.error, code: made.code }, made.status);
    const m = made as Made;
    const fp = artifactFingerprint({ type: output.type as ArtifactType, edition: editionOf(output.type as ArtifactType, output.audience), definition: { hash: definitionHash(def) }, theme: themeStamp(look.theme), structure: output.type === "findings_docx" ? look.structure?.order ?? null : null, client: client ?? null, generator: GENERATOR_VERSION });
    return send({ ...m, summary: m.summary ?? null, narrative: m.narrative ?? null }, { ...(m.extra ?? {}), "x-rescript-artifact-fingerprint": fp, "x-rescript-artifact-reused": "0" });
  }
  const fpIn = await fingerprintInputs(db!, { surveyId, type: output.type as ArtifactType, audience: output.audience, def, client: client ?? null, look, narrative: body.narrative === false ? "engine" : "auto", environment, dataset: datasetKind });
  const fingerprint = artifactFingerprint(fpIn);
  let made: Made | null = null;
  const got = await obtainArtifact(artifactDeps(), {
    surveyId, type: output.type as ArtifactType, edition: fpIn.edition, fingerprint, userId: user?.userId ?? null, customerId: user?.customerId ?? null,
    inputs: { ...fpIn, revision: loaded?.revision ?? null, versionId: loaded?.versionId ?? null },
    regenerate: output.regenerate === true || body.regenerate === true,
    source: typeof body.source === "string" && SOURCES.has(body.source) ? body.source as "copilot" : "copilot",
    visibility: body.visibility === "private" ? "private" : "project",
    themeRef: look.theme?.id ?? null, themeVersion: look.theme?.version ?? null,
  }, async () => { const m = await produce(); if (!("ok" in m)) made = m; return m; });
  if (!got.ok) return json({ error: got.error, code: got.code }, got.status);
  const r = got.row;
  return send(got, {
    ...((made as Made | null)?.extra ?? (got.reused ? { "x-rescript-checked": "stored copy re-checked" } : {})),
    "x-rescript-artifact-fingerprint": fingerprint, "x-rescript-artifact-reused": got.reused ? "1" : "0",
    ...(r ? { "x-rescript-artifact-id": String(r.id), "x-rescript-artifact-version": String(r.version), "x-rescript-artifact-created": String(r.created_at ?? "") } : {}),
    ...(got.note ? { "x-rescript-artifact-note": ascii(got.note) } : {}),
  });
}
