import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { SurveyDefinition } from "@rescript/schema";
import { aiConfigured, aiProviderName, completeJson, embedTexts, aiEmbeddingsModelName, isAiReplyError, isProviderError, capacityNotice, ProviderError, type ProviderErrorKind, type ProviderEvent } from "@rescript/ai";
import { describeFailure, failureFromError, failureFromReplyError, type TurnFailure } from "@/lib/copilot/failure";
import { singleFlight } from "@/lib/singleFlight";
import { aiReadyFor, connectionFor } from "@/lib/byok/connect";
import { providerById, identityOf, aiIdentity } from "@rescript/ai";
import { outputBudget } from "@/lib/copilot/budget";
import { CHANGE_PLAN_SCHEMA, coerceChangePlan, executeItemPrompt, mergeItemReplies, planRetryPrompt, planStagePrompt, sanitizeDone, type ChangePlan } from "@/lib/copilot/changePlan";
import { mirrorStart, type Mirror } from "@/lib/copilot/taskMirror";
import { COPILOT_REPLY_SCHEMA, replyCallOptions } from "@/lib/copilot/replySchema";
/* response streaming (2026-10-18, docs/COPILOT-STREAMING-2026-10-18.md): the same turn, reported to a sink while it works */
import { streamTurn, streamingAllowed, wantsStream, type TurnSink } from "@/lib/copilot/stream";
import { JsonTextExtractor, type FakeStreamScript } from "@rescript/ai";
import { applySurveyActions, coverageReport, diffSurveys, reviewSurvey, requestScope, outsideNote, UNSUPPORTED_MESSAGE, isLongBrief, capabilityReadiness, capabilityRefusal, availabilityNote, type CoverageReport } from "@rescript/engine";
/* engine items 11–14 (2026-10-22, docs/ENGINE-11-14-2026-10-22.md): per-item guides, the readiness rule at action time, refused designs corrected or explained */
import { autoFixMethodAction, coerceSurveyActions, explainMethodRefusal, isAnalysisOp, isMethodOp, isQualOp, type SurveyAction } from "@rescript/engine";
import { GUIDE_TEXT, flagsOf, guideMisses, guideTexts, guidesOf, itemGuideSelection, itemGuidesEnabled, type GuideFlags, type GuideId, type ItemGuideSelection } from "@/lib/copilot/guideSelect";
import { aiInterviewIntent } from "@/lib/copilot/aiInterviewGuide";
import { qualSynthesisIntent } from "@/lib/copilot/qualSynthesisGuide";
import { integrationsIntent } from "@/lib/copilot/integrationsGuide";
import { registerPlanReadinessGate } from "@rescript/analytics";
/* §3 (2026-10-18): a long brief read once — the structured research context, its store, the brief's exact passages, task-aware selection, per-call measurement */
import { addCalls, briefFingerprint, contextLayersFor, contextOwner, deriveResearchContext, itemPassagesFor, questionnaireScope, reconcileContext, renderBriefPassages, renderResearchContext, retrieveBriefPassages, sectionBrief, withProgress, workflowIdFor, type CallMeasure, type ResearchContext, type StoredResearchContext } from "@/lib/copilot/researchContext";
import { researchContextStoreFor } from "@/lib/copilot/researchContextStore";
import { qualIntent, researchPlanIntent } from "@/lib/copilot/researchGuide";
import { ResearchIndex } from "@rescript/import/research";
import { isFailure, requireUser, type AuthedUser } from "@/lib/guard";
import { billingProjectFor, isSandboxProject, meteredAi, refusalResponse } from "@/lib/metering";
/* the system prompt and the guides as cacheable system blocks; the outline and the request after them (AI cost audit, 2026-10-17) */
import { copilotCall } from "@/lib/aiPromptCache";
import type { AiEstimate } from "@/lib/aiEstimate";
import { latestRun } from "@/lib/analytics";
import { supabaseAdmin } from "@/lib/admin";
import { describeThemeImages, withThemeImage } from "@/lib/copilot/themeImageText";
/* prompt-injection audit (2026-10-18): untrusted text fenced, scanned, and the provenance gate on high-risk actions */
import { assessTurn, carryProvenance, fenceResearch, gateReply, provenanceRejections, turnNotice } from "@/lib/copilot/injection";
import { fenceNonceFor, neutralizeUntrusted, UNTRUSTED_DATA_RULE } from "@rescript/ai";
import type { AnalysisRun } from "@rescript/analytics";
type RunBrief = Pick<AnalysisRun, "computedAt" | "n" | "findings" | "verdicts" | "warnings" | "environment" | "trigger" | "corrections" | "advice" | "discoveries">;
import { NOTICES, replyLanguage } from "@/lib/copilot/notices";
import { COPILOT_SYSTEM_PROMPT, classifyRequest, normalizeBrief, honestReply, MAX_MESSAGE_CHARS, repairPrompt, memoryWithRefusals, lookOnlySaid, policyRefusal, mergeRepair, coerceCopilotReply, copilotUserPrompt, type CopilotReply, analysisIntent, translationIntent, quotaIntent, findingsIntent, referencedQuestions, surveyLanguageOf, reportingIntent, type RequestMode, type TurnMemory } from "@/lib/copilot/prompt";
import { researchCards, researchPassages } from "@/lib/copilot/research";
import { researchStoreFor } from "@/lib/copilot/store";
import { copilotOutline } from "@/lib/copilot/outline";
import { listFillIntent } from "@/lib/copilot/listFillGuide";
import { methodsIntent } from "@/lib/copilot/methodsGuide";
/* create_maxdiff / create_conjoint generate their designs through the schema's registry: the real generators, here as in the Studio's panel and the browser's replay */
import { registerBuiltinDesignGenerators } from "@rescript/designs";

registerBuiltinDesignGenerators();
/* #12: an analysis-plan item the one readiness rule calls not ready is refused at action time, naming what is missing */
registerPlanReadinessGate();

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * ONE COPILOT TURN (the copilot brief §15): reasoning → structured actions →
 * validation → preview. Nothing is written here.
 *
 *   1  what the request needs (classifyRequest): generate / edit / review /
 *      question, and whether it is about the research at all
 *   2  the RELEVANT context only: a compact outline of the survey with the
 *      questions the request names in full; the research cards and the few
 *      passages that match — only when the request is about the research;
 *      the conversation memory and the last turns; for a review, what the
 *      engine's own checks already found (so the model adds meaning, not a
 *      second copy of the facts)
 *   3  the model, metered, with an identical request answered from a short
 *      cache instead of paying twice
 *   4  the gate: coerceCopilotReply, then every action applied to a CLONE of
 *      the survey by the engine — refused actions are reported with their
 *      reasons, destructive ones flagged, the diff computed
 *
 * The browser shows the preview; Apply is the researcher's, one undoable
 * edit, saved by the ordinary save path (which validates again).
 *
 * Body: { surveyId, message, definition, selectedId?, memory?, mode? }.
 * TEST SEAM, fake provider only: `fake` (a reply object) stands in for the
 * model, which the fake cannot be; ignored with a real provider.
 */

const CACHE = new Map<string, { at: number; value: unknown }>();
const TTL = 15 * 60_000;

/*
 * THE TIME THIS REQUEST HAS. The route may run 180 s (maxDuration); past that
 * the platform answers for us with an error page that is not JSON — which is
 * how a long generation used to end in "the provider refused the request"
 * with nothing in it, and every item already built was lost. The route now
 * keeps its own clock: provider calls are given a DEADLINE inside it, items
 * are built only while there is time for another, and whatever is not done
 * is handed back as PENDING, with what is done, so the browser carries on in
 * the next request. Nothing is lost to a clock.
 */
const ROUTE_BUDGET_MS = 165_000;
/** the gate and the proposal need a few seconds after the last item */
const GATE_RESERVE_MS = 15_000;
/** the fewest ms left that justify starting another item (the slowest item so far, 1.5×, if more) */
const MIN_ITEM_MS = 30_000;
/*
 * ONE STAGE PER REQUEST, NOT ONE GENERATION PER REQUEST (2026-10-17). A build used to keep going while the
 * 165 s clock allowed, so a single HTTP request could stay open, silent, for almost three minutes — long
 * enough for a phone, a proxy or the platform to drop it (evidence: 2026-10-16 13:04, a 30–35-minute survey
 * with loops ended on "the connection was interrupted" with nothing kept). Past this many ms no new item is
 * started: what is built is handed back as a checkpoint and the browser asks for the next batch at once.
 */
const STAGE_SOFT_MS = 90_000;

/** the first question a non-plan answer asked (a clarify reply's, or a plan's) — the ONE question a brief may get back */
function firstQuestion(...raws: unknown[]): string | null {
  for (const raw of raws) {
    const q = (raw && typeof raw === "object" ? (raw as { questions?: unknown }).questions : null);
    if (Array.isArray(q)) for (const x of q) if (typeof x === "string" && x.trim()) return x.trim().slice(0, 300);
  }
  return null;
}

/** TEST SEAM, fake provider only: a scripted failure or delay for the next model call(s) — one entry per call, null to let it through */
interface Fault { kind?: ProviderErrorKind; status?: number; retryAfterMs?: number; delayMs?: number }
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flights = singleFlight<unknown>();

/** an item's line in the "already built" list the next item is told about: its title and the codes it made */
function builtLine(item: { title: string }, raw: unknown): string {
  const o = (raw && typeof raw === "object" ? raw : {}) as { actions?: { code?: string; title?: string }[] };
  const codes = (o.actions ?? []).map((a) => a?.code ?? a?.title ?? "").filter(Boolean).slice(0, 12);
  return `${item.title}${codes.length ? ` (${codes.join(", ")})` : ""}`;
}


/** what the provider layer did on the way — retries and a fallback — for the log and the history, never a provider's words */
function providerNote(events: ProviderEvent[]): { retries: number; fallback: boolean; recovered: boolean } {
  return { retries: events.filter((e) => e.type === "retry").length, fallback: events.some((e) => e.type === "fallback"), recovered: events.some((e) => e.type === "recovered") };
}

/** the scripted replies an executed plan consumed: one per approved item */
const approvedCount = (plan: { items: unknown[] }) => plan.items.length;

/*
 * TWO TRANSPORTS, ONE TURN (2026-10-18). A request with `Accept: application/x-ndjson` gets the turn as a
 * stream of events — heartbeats, progress, the reply text as the model writes it, each built plan item —
 * ending in one terminal event that carries exactly the JSON below. Without the header (older pages, every
 * other caller) the response is the JSON, unchanged. Everything answered before the first model call (auth,
 * refusals, the wallet, the cache) is the same JSON with the same HTTP status on both.
 */
export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  /* signed out: refused here exactly as below (only the fake provider's sandbox may continue, which needs the body) */
  if (isFailure(authed) && aiProviderName() !== "fake") return authed.response;
  if (!wantsStream(req.headers.get("accept"))) return turn(req, authed, null);
  /* a crash after streaming began reads as one before it did: a 500 with no JSON (the page's "temporary, resend") */
  return streamTurn((sink) => turn(req, authed, sink), { crash: (e) => { console.warn("[rescript:copilot]", JSON.stringify({ event: "turn crashed while streaming", error: ((e as Error)?.message ?? "").slice(0, 200) })); return { status: 500, body: null }; } });
}

async function turn(req: NextRequest, authed: Awaited<ReturnType<typeof requireUser>>, sink: TurnSink | null): Promise<Response> {
  const startedAt = Date.now();
  let body: { surveyId?: unknown; message?: unknown; definition?: unknown; selectedId?: unknown; memory?: TurnMemory; mode?: unknown; fake?: unknown; scope?: unknown; themeImage?: unknown; themeImages?: unknown; quotaCounts?: unknown; analysisRun?: unknown; stage?: unknown; planFirst?: unknown; plan?: unknown; items?: unknown; aiOnce?: unknown; done?: unknown; finalize?: unknown; faults?: unknown; budgetMs?: unknown };
  try { body = await req.json(); } catch { return isFailure(authed) ? authed.response : NextResponse.json({ error: "bad json" }, { status: 400 }); }
  /* TEST SEAM, fake provider only: how the stand-in streams (chunks, pauses, a failure part-way) and how the stream itself behaves (heartbeat interval, a scripted drop) */
  const fakeStreamSeam = aiProviderName() === "fake" ? streamSeam((body as { fakeStream?: unknown }).fakeStream) : null;
  sink?.configure({ enabled: streamingAllowed(process.env, aiProviderName() === "fake", !!fakeStreamSeam), ...(fakeStreamSeam ? { heartbeatMs: fakeStreamSeam.heartbeatMs, dropAfterCheckpoints: fakeStreamSeam.dropAfterCheckpoints, dropAfterMs: fakeStreamSeam.dropAfterMs } : {}) });
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  /* the researcher chose "send this once" while the project runs Internal: that one request may reach the model (audit A-2); nothing else may */
  const consent: { consent?: "once" } = body.aiOnce === true ? { consent: "once" } : {};
  /* a refusal body is a wallet failure unless the project's AI switch refused it */
  const failureOf = (b: Record<string, unknown>) => (b.code === "ai_disabled" ? describeFailure("internal_mode") : b.code === "ai_connection" ? describeFailure("connection", String(b.error ?? "")) : describeFailure("wallet", String(b.error ?? "")));
  let user: AuthedUser | null = null;
  if (isFailure(authed)) {
    if (!(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;
  } else user = authed;
  /*
   * THE REQUEST, READ WHOLE (2026-10-17). It was cut at 8,000 characters without a word — a pasted 25k brief
   * reached the model as its first third. Now: the chat tool's markdown noise removed (meaning kept), up to
   * MAX_MESSAGE_CHARS read, and past that the researcher is told — nothing is sent, nothing is charged.
   */
  const message = typeof body.message === "string" ? normalizeBrief(body.message) : "";
  /* the Studio's own sentences in the reply follow the researcher's language (notices.ts) */
  const lang = replyLanguage(message);
  if (!message) return NextResponse.json({ error: "say what you want" }, { status: 400 });
  if (message.length > MAX_MESSAGE_CHARS) {
    const failure = { ...describeFailure("too_long"), message: `This request is ${message.length.toLocaleString("en")} characters; Intelligent Mode reads up to ${MAX_MESSAGE_CHARS.toLocaleString("en")} at once. Nothing was sent to the model and nothing was charged — your text is kept.`, next: ["Send the brief in two parts — the research design and objectives first, then the questionnaire requirements — or upload it as a research document and ask for the survey “based on the brief”.", "Tables and long reference lists can go in a research document; the plan cites them from there."] };
    return NextResponse.json({ ok: false, error: failure.message, failure, retryable: false, saved: true, context: { mode: "generate", promptChars: 0, messageChars: message.length, cached: false }, usage: { charge: 0 } }, { status: 413 });
  }
  /*
   * WHAT INTELLIGENT MODE IS FOR — read before anything is paid for. Clearly unrelated ("write me a poem", "book
   * a flight") with nothing supported in it: the one sentence that says what the engine does, no model call, no
   * charge (the browser's engine answers these first; this is the same rule for any other caller). A greeting
   * gets one question. A mixed request goes on with its outside part named (below). The theme assistant and the
   * build of an approved plan are not re-read.
   */
  const scope = body.scope === "theme" || body.stage === "execute" ? null : requestScope(message);
  if (scope && (scope.scope === "unsupported" || scope.scope === "ambiguous")) {
    const said = scope.scope === "unsupported" ? NOTICES.unsupported(lang, UNSUPPORTED_MESSAGE) : scope.question;
    return NextResponse.json({
      ok: true,
      reply: { kind: scope.scope === "unsupported" ? "answer" : "clarify", reply: said, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: scope.scope === "ambiguous" ? [scope.question] : [], sources: [] },
      validation: null, passages: {},
      context: { mode: "question", scope: scope.scope, modelCalled: false, promptChars: 0, cached: false },
      usage: { charge: 0 },
    });
  }
  /*
   * WHAT THIS INSTALLATION CAN DO (§11, 2026-10-18) — the capability registry's readiness, from the server
   * environment (presence only; the language model is ready by definition here: a turn without one is refused
   * below). A short request for a capability that needs configuration this installation lacks gets the refusal
   * naming the missing dependency — no model call, no charge, no silent substitution. A long brief is never
   * refused: the model is told what is unavailable and plans around it in the open.
   */
  const readiness = capabilityReadiness(process.env, { ai_chat: true });
  const unavailable = body.scope === "theme" || body.stage === "execute" || scope?.longBrief ? null : capabilityRefusal(message, readiness);
  if (unavailable) {
    return NextResponse.json({
      ok: true,
      reply: { kind: "answer", reply: unavailable.message, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] },
      validation: null, passages: {},
      context: { mode: "question", scope: "unavailable", capability: unavailable.capability.id, missing: unavailable.capability.missing, modelCalled: false, promptChars: 0, cached: false },
      usage: { charge: 0 },
    });
  }
  const availability = availabilityNote(readiness) || undefined;
  if (!(await aiReadyFor(user, surveyId, "copilot_turn"))) return NextResponse.json({ error: "No language model is configured on this Studio (AI_API_URL). The built-in grammar still handles common edits.", code: "ai_unconfigured", failure: describeFailure("not_configured") }, { status: 501 });
  const parsed = SurveyDefinition.safeParse(body.definition);
  if (!parsed.success) return NextResponse.json({ error: "send the survey as it is open in the editor (definition)" }, { status: 400 });
  const def = parsed.data;
  const billing = await billingProjectFor(user, surveyId);
  if ("response" in billing) return billing.response;
  const { meter, ctx } = billing;
  /* WHOSE AI this request uses (the project's choice, else the user's, else the platform's): the cache and single-flight keys carry it, so an answer made under one connection is never served under another; a failure on the user's own provider is told as theirs to fix */
  const conn = await connectionFor({ userId: ctx.userId, customerId: ctx.customerId, surveyId: ctx.surveyId, operation: "copilot_turn" });
  const connTag = conn.kind === "user" ? `|${conn.source}:${identityOf(conn.scope)}` : "";
  const ownProvider = conn.kind === "user" ? providerById(conn.scope.provider)?.label ?? "Your AI provider" : undefined;

  /* 1–2: the context this request needs, and no more */
  const store = await researchStoreFor(surveyId);
  const docs = await store.list(surveyId);
  const classified = classifyRequest(message, def.questions.length, docs.length);
  // the Branding panel's theme assistant: a look-only request by construction
  const themeScope = body.scope === "theme";
  const cls = themeScope ? { ...classified, mode: "ux" as RequestMode, ux: true, uxOnly: true } : classified;
  /* a pasted brief (headings, sections, tables, thousands of characters) on a survey not yet built is a request to design one, whatever its first sentence says */
  const longBrief = !themeScope && !!scope?.longBrief;
  const briefMode = longBrief && def.questions.length < 3 && (cls.mode === "question" || cls.mode === "edit") && !!scope?.categories.some((c) => c === "research_planning" || c === "hypotheses" || c === "survey");
  const mode: RequestMode = body.mode === "review" ? "review" : body.mode === "generate" || briefMode ? "generate" : cls.mode;
  /* a mixed request: the model does the supported part; the outside part is named by the Studio, not the model */
  const outside = scope?.scope === "mixed" ? scope.outside : [];
  const scopeNote = outside.length ? `PART OF THIS REQUEST IS OUTSIDE THE PLATFORM (${outside.map((o) => `“${o}”`).join(", ")}): do only the supported part. Do not mention the outside part in "reply" — the Studio adds that sentence itself.` : undefined;
  /* images to build the theme from — one (`themeImage`, Intelligent mode) or up to four references (`themeImages`, Branding's Design with AI): their colours go to the model, their addresses stay here */
  const okUrl = (u: unknown): u is string => typeof u === "string" && (/^https:\/\/[^\s"'()<>\\]+$/i.test(u) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(u) || /^\/[^\s"'()<>\\]+$/.test(u));
  const tis = (Array.isArray(body.themeImages) ? body.themeImages.slice(0, 4) : [body.themeImage]).filter((t): t is { url?: unknown; name?: unknown; dominant?: unknown; palette?: unknown; dark?: unknown } => !!t && typeof t === "object" && okUrl((t as { url?: unknown }).url));
  const themeImageUrl: string[] | null = tis.length ? tis.map((t) => t.url as string) : null;
  const themeImageText = tis.length ? describeThemeImages(tis.map((ti) => ({ name: typeof ti.name === "string" ? neutralizeUntrusted(ti.name, { maxChars: 80 }).replace(/[\r\n"⟦⟧]/g, " ") : undefined, dominant: Array.isArray(ti.dominant) ? ti.dominant.filter((c): c is string => typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c)).slice(0, 8) : [], palette: ti.palette && typeof ti.palette === "object" ? Object.fromEntries(Object.entries(ti.palette as Record<string, unknown>).filter(([k, v]) => /^[a-z]{2,20}$/i.test(k) && typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)).slice(0, 16)) as Record<string, string> : {}, dark: ti.dark === true }))) : undefined;
  const selectedId = typeof body.selectedId === "string" ? body.selectedId : null;
  // a request about the look and behaviour gets the UX guide, the theme and the UX of the questions it names
  const uxTurn = cls.ux || mode === "ux";
  // look-only inferred from the words (not said, not the theme assistant): validation stays allowed — here and in the browser's replay
  const uxOnlyInferred = cls.uxOnly && !themeScope && !lookOnlySaid(message);
  // the analysis framework: a request about it, or a generation (the design arrives with its analysis)
  const analysisTurn = analysisIntent(message) || mode === "generate";
  // languages: the translation guide, and the named questions' elements with their existing translations
  const translationTurn = translationIntent(message);
  // quotas: the guide, every cell with its condition and where the check sits, the review, and the live counts the Studio sent
  const quotaTurn = quotaIntent(message);
  const listFillTurn = listFillIntent(message);
  // MaxDiff / conjoint: the methods guide (the designs in the survey are on the outline's "Designs:" line every turn)
  const methodsTurn = methodsIntent(message);
  const quotaCounts = body.quotaCounts && typeof body.quotaCounts === "object" ? body.quotaCounts as Record<string, Record<string, number>> : null;
  // findings: what the data showed — the latest analysis run the Studio sent, answered from its numbers
  const findingsTurn = findingsIntent(message);
  /* the findings the copilot answers from are the project's own stored run, read here — never numbers the browser sends (audit A-3). The sandbox has no stored data, so its fixture's run is taken as sent. */
  const sentRun = body.analysisRun && typeof body.analysisRun === "object" && Array.isArray((body.analysisRun as { findings?: unknown }).findings) ? body.analysisRun as RunBrief : null;
  const analysisRun: RunBrief | null = !findingsTurn ? null : isSandboxProject(surveyId) ? sentRun : await latestRun(supabaseAdmin(), surveyId).catch(() => null);
  /* §3 TASK-AWARE SELECTION: a theme turn gets no questionnaire; a logic edit on a large survey the named questions and their dependencies in full */
  const focusIds = referencedQuestions(def, message);
  const qScope = questionnaireScope({ message, mode, themeOnly: themeScope, uxOnly: cls.uxOnly, focusCount: focusIds.length, questionCount: def.questions.length });
  const outline = copilotOutline(def, { selectedId, focusIds, ux: uxTurn, analysis: analysisTurn, translation: translationTurn, quota: quotaTurn, quotaCounts, findings: findingsTurn, analysisRun, questionnaire: qScope });
  /*
   * §3 THE RESEARCH CONTEXT OF A LONG BRIEF (2026-10-18). Kept per survey AND owner (never another survey's,
   * never another organisation's). Checked against the survey's research design on every turn: the definition
   * is authoritative, a material change makes the context stale (not sent until regenerated). The build of an
   * approved plan from a brief uses it — with the exact passages each item needs — instead of the brief.
   */
  const owner = contextOwner({ customerId: ctx.customerId, userId: ctx.userId });
  const workflowId = workflowIdFor(surveyId, owner, message);
  const execPlanEarly = body.stage === "execute" ? coerceChangePlan(body.plan) : null;
  const briefStage = !themeScope && !!execPlanEarly && isLongBrief(message);
  const doneEarly = execPlanEarly ? [...sanitizeDone(body.done, new Set(execPlanEarly.items.map((i) => i.id))).keys()] : [];
  let rcStore: Awaited<ReturnType<typeof researchContextStoreFor>> | null = null;
  let stored: StoredResearchContext | null = null;
  let rcStatus: "none" | "derived" | "reused" | "regenerated" | "stale" | "invalidated" = "none";
  if (!themeScope) {
    try {
      rcStore = await researchContextStoreFor(surveyId);
      stored = await rcStore.get(surveyId, owner);
      if (stored) {
        const rec = reconcileContext(stored.context, def);
        if (rec.changed) stored = await rcStore.put({ ...stored, context: rec.context }, { userId: ctx.userId });
        rcStatus = rec.invalidated ? "invalidated" : stored.context.status === "stale" ? "stale" : "reused";
      }
      if (briefStage) {
        const sameBrief = !!stored && stored.context.fingerprint.brief === briefFingerprint(message);
        if (!stored || !sameBrief || stored.context.status === "stale") {
          /* derived here when the plan stage did not leave one (another server, an older page); regenerated on demand when stale */
          const fresh = deriveResearchContext({ brief: message, plan: execPlanEarly, def, previous: stored?.context ?? null, built: doneEarly });
          const was = stored;
          stored = await rcStore.put({ surveyId, owner, context: fresh, brief: message, workflow: sameBrief ? was?.workflow ?? null : null }, { userId: ctx.userId });
          rcStatus = sameBrief ? "regenerated" : "derived";
        } else {
          stored = await rcStore.put({ ...stored, context: withProgress(stored.context, execPlanEarly!, doneEarly) }, { userId: ctx.userId });
          rcStatus = "reused";
        }
      }
    } catch (e) {
      /* the context is an optimisation: a store that cannot answer never fails the turn — the brief is sent whole, as before */
      console.warn("[rescript:copilot]", JSON.stringify({ event: "research context unavailable", surveyId, error: ((e as Error)?.message ?? "").slice(0, 200) }));
      stored = null; rcStatus = "none";
    }
  }
  const rc: ResearchContext | null = stored && stored.context.status === "fresh" ? stored.context : null;
  /** the context the plan stage derived in this request (reported, not used by this request's own calls) */
  let planRc: ResearchContext | null = null;
  const useBriefLayers = briefStage && !!rc && !!stored && stored.context.fingerprint.brief === briefFingerprint(message);
  /* outside the build of its own brief, a context is used only once the design built from that brief is in the survey (adopted): a survey started over from scratch — or the shared sandbox — is not given an earlier brief's context */
  const layers = useBriefLayers ? { researchContext: "full" as const } : longBrief ? { researchContext: "none" as const } : contextLayersFor({ mode, themeOnly: themeScope, uxOnly: cls.uxOnly, stage: null, hasContext: !!rc && !rc.fingerprint.designEmpty, stale: !rc });
  /* neutralised (deterministic, so the cached block stays the same bytes): a brief's role markers or fence look-alikes never reach a system block as structure */
  const researchContextText = rc && layers.researchContext !== "none" ? neutralizeUntrusted(renderResearchContext(rc, { compact: layers.researchContext === "compact" })) : undefined;
  const briefSections = useBriefLayers ? sectionBrief(stored!.brief) : rc && stored && layers.researchContext === "compact" ? sectionBrief(stored.brief) : [];
  /* an ordinary turn that names something in the stored brief (its quota table, a definition) gets that passage verbatim */
  const turnPassages = !useBriefLayers && briefSections.length ? retrieveBriefPassages(briefSections, message, { k: 2, maxChars: 3000, minScore: 6 }) : [];
  /** the blocks after the guides that are the same on every call of this request: the research context, the availability note */
  const stableExtra = [researchContextText, availability];
  let research = "";
  let passageIds: string[] = [];
  let charge = 0;
  if (docs.length && (cls.research || mode === "generate" && def.questions.length < 3)) {
    const chunks = await store.chunks(surveyId);
    const embeddings = new Map(chunks.filter((c) => c.embedding).map((c) => [c.id, c.embedding!]));
    let queryEmbedding: number[] | undefined;
    if (embeddings.size && aiEmbeddingsModelName()) {
      const m = await meteredAi(meter, ctx, "AI_REQUEST", { ...consent, estimateText: message, maxTokens: 1, operation: "copilot_query_embedding" }, () => embedTexts([message]));
      if (!m.ok) return refusalResponse(m);
      charge += m.event?.customerCharge ?? 0;
      queryEmbedding = m.value?.[0];
    }
    const index = new ResearchIndex(chunks, embeddings);
    const cards = researchCards(docs.map((d) => ({ id: d.ref, name: d.name, summary: d.summary })));
    const p = researchPassages(index, docs.map((d) => ({ id: d.ref, name: d.name })), message, { k: mode === "generate" ? 10 : 6, maxChars: mode === "generate" ? 12_000 : 7000, ...(queryEmbedding ? { queryEmbedding } : {}) });
    research = `${cards}${p.text ? `\n\nPASSAGES:\n${p.text}` : ""}`;
    passageIds = p.ids;
  }
  /*
   * PROMPT INJECTION (2026-10-18). The research material is the documents' authors' text, not the researcher's:
   * scanned, then sent as fenced data (the rule in a cached block, the fence's keyed nonce in the user text — the
   * same request gets the same prompt, so the reply cache and single-flight still work). A pasted brief, the
   * survey's own text and image names are scanned too. The provenance gate below reads `provenance`.
   */
  const provenance = assessTurn({ message, longBrief, research, docs, def, extra: tis.map((t) => ({ source: "theme image names", text: typeof t.name === "string" ? t.name : "" })) });
  if (research) { research = fenceResearch(research, fenceNonceFor(`${surveyId}\u0000${user?.userId ?? "sandbox"}\u0000${message}`)); stableExtra.push(UNTRUSTED_DATA_RULE); }
  const guard = <R extends NonNullable<ReturnType<typeof coerceCopilotReply>>>(r: R | null): R | null => (r ? gateReply(r, def, provenance, { allowUrls: themeImageUrl ?? [] }).reply : r);
  const deterministic = mode === "review" ? reviewSurvey(def) : null;
  /* the prompt in full, and — for the rare provider that says it is too long for the model's context window — in compact form: no research passages, no memory of earlier turns. `planOnly`: the plan stage's, without the action guides */
  const promptFor = (compact: boolean, planOnly = false, guides?: GuideFlags) => copilotUserPrompt({
    message, outline, surveyLanguage: surveyLanguageOf(def), mode,
    memory: compact ? undefined : sanitizeMemory(body.memory), research: compact ? undefined : research || undefined,
    deterministicFindings: deterministic?.findings.slice(0, 40).map((f) => `${f.severity}: ${f.message}`),
    selected: selectedId ? def.questions.find((q) => q.id === selectedId)?.code ?? null : null,
    ux: uxTurn, uxOnly: cls.uxOnly,
    analysis: analysisTurn, translation: translationTurn, quota: quotaTurn, listFill: listFillTurn, methods: methodsTurn, findings: findingsTurn,
    ...(themeImageText ? { themeImage: themeImageText } : {}),
    ...(themeScope ? { themeOnly: true } : {}),
    ...(planOnly ? { planOnly: true } : {}), ...(longBrief ? { longBrief: true } : {}), ...(scopeNote ? { scopeNote } : {}),
    /* §3 layers: the research context (1), the stored brief in place of the message with its passages (5); the guides the brief named are still chosen from the brief itself */
    ...(researchContextText ? { researchContext: researchContextText } : {}),
    ...(useBriefLayers ? { briefRef: { chars: stored!.brief.length, ref: rc!.fingerprint.brief.slice(0, 12) }, researchPlan: researchPlanIntent(message, mode), qual: qualIntent(message), reporting: reportingIntent(message) } : {}),
    ...(turnPassages.length ? { briefPassages: renderBriefPassages(turnPassages) } : {}),
    ...(availability ? { availability } : {}),
    /* #11: a staged item's own guides — every switch set, so nothing is read from the message for it */
    ...(guides ?? {}),
  });
  const prompt = promptFor(false);
  let compactPrompt: string | null = null;
  const promptOf = (compact: boolean) => (compact ? (compactPrompt ??= promptFor(true)) : prompt);
  const planPrompts: Record<"full" | "compact", string | null> = { full: null, compact: null };
  const planPromptOf = (compact: boolean) => (compact ? (planPrompts.compact ??= promptFor(true, true)) : (planPrompts.full ??= promptFor(false, true)));
  /*
   * #11 PER-ITEM GUIDES (2026-10-22). What this turn would send (the brief's guides), and for a staged build each
   * item's own selection — the core every item shares (one cached block) plus what the item needs. The prompts are
   * built once per distinct set, so items that need the same guides send the same bytes.
   */
  const buildGuides: GuideFlags = { ux: uxTurn, analysis: analysisTurn, translation: translationTurn, quota: quotaTurn, listFill: listFillTurn, methods: methodsTurn, findings: findingsTurn, researchPlan: researchPlanIntent(message, mode), qual: qualIntent(message), aiInterview: aiInterviewIntent(message), integrations: integrationsIntent(message), reporting: reportingIntent(message), qualSynthesis: qualSynthesisIntent(message) };
  const perItemGuides = itemGuidesEnabled();
  const itemPrompts = new Map<string, string>();
  const itemPromptOf = (compact: boolean, sel: ItemGuideSelection) => {
    const k = `${compact ? 1 : 0}|${sel.all.join(",")}`;
    let p = itemPrompts.get(k);
    if (p == null) { p = promptFor(compact, false, flagsOf(sel.all, !!buildGuides.qualSynthesis && sel.fallback)); itemPrompts.set(k, p); }
    return p;
  };
  /** what each item of this request was sent (ids, why, characters) and the actions a reply proposed whose guide was not sent */
  const itemGuides: Record<string, { guides: GuideId[]; core: GuideId[]; why: Partial<Record<GuideId, string>>; fallback?: true; chars: number }> = {};
  const misses: { item: string; guides: GuideId[]; ops: string[] }[] = [];

  /* 3: the model — or the cache, for exactly the same request. The answer is not rationed (Phase 7): the provider's ceiling, the expected size reserved */
  const budget = outputBudget(mode === "generate" ? "generate" : mode === "review" ? "review" : uxTurn ? "ux" : "edit");
  const maxTokens = budget.maxTokens;
  // the key names the project and the person too (consolidation, audit §C.2 #4): a copy of a survey under another project is never served another project's reply
  const key = createHash("sha256").update(`${surveyId}\u0000${user?.userId ?? "sandbox"}${connTag}\u0000${COPILOT_SYSTEM_PROMPT}\u0000${prompt}\u0000${maxTokens}`).digest("hex");
  // the browser suites stand in for the model: one reply, or [reply, the reply to the repair request] — or, executing a plan, one reply per item
  const fakes = aiProviderName() === "fake" && body.fake && typeof body.fake === "object" ? (Array.isArray(body.fake) ? body.fake : [body.fake]) : [];
  const fake = fakes[0] ?? null;
  let raw: unknown;
  let cached = false;
  /*
   * THE CHANGE PLAN (Phase 2). A generation — a questionnaire from a brief,
   * a restructuring — is planned before it is built: one small call for the
   * plan, shown to the researcher; then, once approved, one call per item.
   * `stage: "execute"` is the second half; a plan-first request that the
   * model cannot plan (or a scripted reply that is not a plan) falls through
   * to the single-reply turn as before.
   */
  /* a pasted brief is always planned first (a reviewable plan with its assumptions — never a 100-question reply in one call); a scripted clarify on a brief stands in for a model that asked instead of planning */
  const fakeKind = fake ? (fake as { kind?: string }).kind : undefined;
  const stage = body.stage === "execute" ? "execute" : body.stage === "plan" || ((body.planFirst !== false || longBrief) && mode === "generate" && !(fake && fakeKind !== "plan" && !(longBrief && fakeKind === "clarify"))) ? "plan" : null;
  let planFailures: { id: string; failure: TurnFailure }[] = [];
  let planPending: string[] = [];
  let executedPlan: ChangePlan | null = null;
  /* the durable mirror of this turn, started in the execute stage and closed once the actions have been applied to a clone */
  let mirror: Mirror | null = null;
  /* this request's clock and what the provider told us on the way */
  const fakeProvider = aiProviderName() === "fake";
  const budgetMs = fakeProvider && Number.isFinite(Number(body.budgetMs)) && Number(body.budgetMs) > 0 ? Number(body.budgetMs) : ROUTE_BUDGET_MS;
  const deadline = startedAt + budgetMs;
  const events: ProviderEvent[] = [];
  const onEvent = (e: ProviderEvent) => { events.push(e); };
  /*
   * MEASURED PER CALL (§3, 2026-10-18): every model call of this request — characters sent, input / output /
   * cached tokens, requests, retries, latency, charge — on its usage event (with the workflow id, so a
   * generation's cost can be summed across requests) and in this request's list; a long brief's workflow keeps
   * the running totals with its research context. TEST SEAM, fake provider only: what each call sent.
   */
  const calls: CallMeasure[] = [];
  const sent: { operation: string; chars: number; variableChars: number; variable: string; contextBlock: boolean; passages: string[]; blocks?: number[]; guides?: GuideId[] }[] = [];
  const retriesNow = () => events.filter((e) => e.type === "retry").length;
  const measured = async <T,>(est: AiEstimate, userText: string, fn: () => Promise<T>, passages: string[] = [], callOpts: { core?: readonly string[]; guides?: GuideId[] } = {}) => {
    const [sys, variable] = copilotCall(userText, stableExtra, callOpts.core ? { core: callOpts.core } : {});
    const chars = sys.reduce((n, s) => n + s.length, 0) + variable.length;
    if (fakeProvider) sent.push({ operation: est.operation, chars, variableChars: variable.length, variable, contextBlock: !!researchContextText && sys.slice(1).some((b) => b.includes(researchContextText)) && !variable.includes(researchContextText), passages, blocks: sys.map((b) => b.length), ...(callOpts.guides ? { guides: callOpts.guides } : {}) });
    const r0 = retriesNow(); const t0 = Date.now();
    const m = await meteredAi(meter, ctx, "AI_REQUEST", { ...est, meta: () => ({ workflowId, promptChars: chars, retries: retriesNow() - r0, ...(rc ? { researchContextVersion: rc.version } : {}) }) }, fn);
    if (m.ok) {
      const md = (m.event?.metadata ?? {}) as { tokens?: { cachedInput?: number; cacheWrite?: number }; requests?: number };
      /* the cache WRITE too (2026-10-18): the per-call measure carries both halves of the prompt cache, so the eval and the cost card need not read the meter */
      calls.push({ operation: est.operation, promptChars: chars, inputTokens: m.event?.inputUnits ?? 0, outputTokens: m.event?.outputUnits ?? 0, cachedInputTokens: Number(md.tokens?.cachedInput ?? 0), cacheWriteTokens: Number(md.tokens?.cacheWrite ?? 0), requests: Number(md.requests ?? 1), retries: retriesNow() - r0, latencyMs: Date.now() - t0, charge: m.event?.customerCharge ?? 0 });
    }
    return m;
  };
  /** the workflow's running totals, kept with its research context (a long brief's plan and build) */
  const keepWorkflow = async (completed: boolean) => {
    if (!rcStore || !stored || !calls.length || stored.context.fingerprint.brief !== briefFingerprint(message)) return stored?.workflow ?? null;
    try { stored = await rcStore.put({ ...stored, workflow: addCalls(stored.workflow, workflowId, calls, { completed }) }, { userId: ctx.userId }); }
    catch (e) { console.warn("[rescript:copilot]", JSON.stringify({ event: "workflow totals not kept", error: ((e as Error)?.message ?? "").slice(0, 200) })); }
    return stored?.workflow ?? null;
  };
  /** what the response says about the context it used */
  const contextMeta = () => { const shown = rc ?? planRc; return { researchContext: { status: rcStatus, ...(shown ? { version: shown.version, chars: (researchContextText ?? renderResearchContext(shown)).length, layer: rc ? layers.researchContext : "none", briefChars: shown.fingerprint.briefChars, ref: shown.fingerprint.brief.slice(0, 12), hypotheses: shown.hypotheses.length, sections: shown.sections.length } : {}), ...(stored?.context.status === "stale" ? { stale: true, reason: stored.context.staleReason } : {}), ...(turnPassages.length ? { passages: turnPassages.map((p) => p.id) } : {}) }, questionnaire: qScope, workflowId, ...(Object.keys(itemGuides).length ? { itemGuides } : {}), ...(misses.length ? { guideMisses: misses } : {}), calls: calls.map((c) => ({ operation: c.operation, promptChars: c.promptChars, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cachedInputTokens: c.cachedInputTokens, cacheWriteTokens: c.cacheWriteTokens ?? 0, retries: c.retries, latencyMs: c.latencyMs })), ...(fakeProvider && sent.length ? { sent } : {}) }; };
  const faults: Fault[] = fakeProvider && Array.isArray(body.faults) ? (body.faults as Fault[]).slice(0, 40) : [];
  /** the test seam: a scripted fault or delay in front of a model call (nothing, outside the fake provider) */
  const model = async <T,>(fn: () => Promise<T>): Promise<T> => {
    /* the first model call commits a streaming request to the stream (heartbeats from here on); a no-op otherwise */
    sink?.start();
    const f = faults.shift();
    if (f?.delayMs) await sleepMs(Math.min(5000, f.delayMs));
    if (f?.kind) throw new ProviderError({ kind: f.kind, status: f.status, retryAfterMs: f.retryAfterMs, detail: "scripted", host: "fake", exhausted: true });
    return fn();
  };
  /**
   * STREAMED TEXT (2026-10-18): the options that make one model call report its readable field (`reply`, a
   * plan's `summary`) to the stream as the model writes it — only once this request is streaming (the
   * provider is asked to stream then and only then). `part` names what the text belongs to; a compact retry
   * is a new part, so the page replaces what it showed instead of appending a second copy. With the fake
   * provider the scripted reply is what the stand-in "writes".
   */
  const live = (field: "reply" | "summary", part: string, scripted?: unknown): { onText?: (d: string) => void; fakeStream?: FakeStreamScript } => {
    const fs = fakeStreamSeam ? { ...fakeStreamSeam.script, ...(scripted != null && typeof scripted === "object" ? { text: JSON.stringify(scripted) } : {}) } : undefined;
    const out = sink;
    if (!out?.streaming) return fs ? { fakeStream: fs } : {};
    const x = new JsonTextExtractor([field], (d) => out.text(d, part));
    return { onText: (d: string) => x.push(d), ...(fs ? { fakeStream: fs } : {}) };
  };
  /** one provider call, once: a request that repeats an identical call still running (a double click, a refresh while the first is in flight) shares it instead of paying for a second */
  const shared = <T,>(label: string, text: string, fn: () => Promise<T>): Promise<T> =>
    /* a request that waits on another's identical call is streaming too: heartbeats while it waits (its text deltas go to the first request) */
    (sink?.start(), fakeProvider ? fn() : flights(`${user?.userId ?? "sandbox"}|${surveyId}|${aiIdentity()}|${label}|${createHash("sha256").update(text).digest("hex")}`, fn as () => Promise<unknown>) as Promise<T>);
  /** a prompt the provider says is longer than the model's context window is sent once more in compact form — a bulk job is not lost to its own size */
  const fitting = async <T,>(run: (compact: boolean) => Promise<T>): Promise<T> => {
    try { return await run(false); }
    catch (e) {
      if (!(isProviderError(e) && e.contextTooLong)) throw e;
      console.warn("[rescript:copilot]", JSON.stringify({ event: "context too long — retrying compact", surveyId, userId: user?.userId }));
      return run(true);
    }
  };
  /** the browser is told what happened: the card, the retry and the log all read the same failure */
  const failureOfError = (e: unknown, where: string): TurnFailure => {
    const failure = isAiReplyError(e) ? failureFromReplyError(e.code, e.detail) : isProviderError(e) ? failureFromError(e, { own: ownProvider }) : failureFromError((e as Error)?.message ?? "", { own: ownProvider, studio: true });
    console.warn("[rescript:copilot]", JSON.stringify({ event: `${where} failed`, userId: user?.userId, surveyId, code: failure.code, ...(isProviderError(e) ? { kind: e.kind, status: e.status, attempts: e.attempts, retryAfterMs: e.retryAfterMs, exhausted: e.exhausted, host: e.host, said: e.detail.slice(0, 200) } : { error: ((e as Error)?.message ?? "").slice(0, 200) }), retries: events.filter((x) => x.type === "retry").length, elapsedMs: Date.now() - startedAt }));
    return failure;
  };
  /** a failed turn: nothing was changed, nothing was charged for the failed call, the request is kept — and a temporary failure says when to come back (HTTP 503 + Retry-After) */
  const failedTurn = (failure: TurnFailure, promptChars: number, extra: Record<string, unknown> = {}) => {
    const res = NextResponse.json({ ok: false, error: `${failure.message}${failure.retryable ? "" : " Nothing was changed."}`, failure, retryable: !!failure.retryable, saved: true, context: { mode, promptChars, cached: false }, usage: { charge }, ...extra }, { status: failure.retryable ? 503 : 502 });
    if (failure.retryAfterMs) res.headers.set("retry-after", String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000))));
    return res;
  };
  if (stage === "plan") {
    /* the plan stage writes no actions, so it goes without the action guides — a brief that names analysis, quotas, translation and MaxDiff sent ~40k characters of guides with it (evidence: 43,698 prompt characters) */
    const planText = (c: boolean) => planPromptOf(c) + planStagePrompt({ longBrief });
    const planPrompt = planText(false);
    const planContext = () => ({ mode, researchUsed: !!research, passages: passageIds, promptChars: planPrompt.length, messageChars: message.length, cached: false, provider: providerNote(events), ...(longBrief ? { longBrief: true } : {}), ...(outside.length ? { scope: "mixed", outside } : {}) });
    const maxQuestions = longBrief ? 1 : 5;
    /*
     * §3: THE PLAN STAGE LEAVES THE RESEARCH CONTEXT BEHIND — derived from the brief it just read whole and the
     * plan it produced (no further model call), kept for this survey and owner, so the build's items get the
     * context and their own passages instead of the brief.
     */
    const keepPlanContext = async (p: ChangePlan) => {
      if (!longBrief || !rcStore) return;
      try {
        const same = !!stored && stored.context.fingerprint.brief === briefFingerprint(message);
        const ctxNew = deriveResearchContext({ brief: message, plan: p, def, previous: stored?.context ?? null });
        /* a new plan is a new generation: its totals start here (the plan call is added by keepWorkflow), so "cost per completed generation" is one generation's */
        stored = await rcStore.put({ surveyId, owner, context: ctxNew, brief: message, workflow: null }, { userId: ctx.userId });
        planRc = ctxNew; rcStatus = same ? "regenerated" : "derived";
      } catch (e) { console.warn("[rescript:copilot]", JSON.stringify({ event: "research context not kept", surveyId, error: ((e as Error)?.message ?? "").slice(0, 200) })); }
    };
    const planDone = async (p: ChangePlan, extra: Record<string, unknown> = {}) => { await keepPlanContext(p); const workflow = await keepWorkflow(false); return NextResponse.json({ ok: true, stage: "plan", plan: p, context: { ...planContext(), ...extra, ...contextMeta(), ...(workflow ? { workflow } : {}) }, usage: { charge } }); };
    try {
      const pb = outputBudget("plan");
      sink?.progress({ stage: "plan", label: "Planning" });
      const m = await measured({ ...consent, estimateText: COPILOT_SYSTEM_PROMPT + planPrompt, maxTokens: pb.expectedTokens, operation: "copilot_plan" }, planPrompt,
        () => fitting((c) => shared("plan", planText(c), () => model(() => completeJson(...copilotCall(planText(c), stableExtra), pb.maxTokens, { timeoutMs: pb.timeoutMs, deadline, schema: CHANGE_PLAN_SCHEMA, continuations: pb.continuations, operation: "copilot_plan", onEvent, ...live("summary", c ? "summary:compact" : "summary", fake) })))));
      if (!m.ok) {
        const r = refusalResponse(m);
        const body = await r.json().catch(() => ({})) as Record<string, unknown>;
        return NextResponse.json({ ...body, failure: failureOf(body) }, { status: r.status });
      }
      charge += m.event?.customerCharge ?? 0;
      const first = fake ?? m.value;
      const plan = coerceChangePlan(first, { maxQuestions });
      if (plan) return planDone(plan);
      if (longBrief) {
        /*
         * A BRIEF GETS A PLAN, NOT A QUESTIONNAIRE BACK (evidence 2026-10-16 12:49). The model answered with
         * questions: it is asked once more for the plan alone, assumptions stated. If it still has no plan, the
         * researcher gets ONE focused question — never a list, and never a full single-reply generation of a
         * 25,000-character brief (the call most likely to be cut off and paid for twice).
         */
        const retryText = (c: boolean) => planText(c) + planRetryPrompt();
        const m2 = await measured({ ...consent, estimateText: COPILOT_SYSTEM_PROMPT + retryText(false), maxTokens: pb.expectedTokens, operation: "copilot_plan_retry" }, retryText(false),
          () => fitting((c) => shared("plan_retry", retryText(c), () => model(() => completeJson(...copilotCall(retryText(c), stableExtra), pb.maxTokens, { timeoutMs: pb.timeoutMs, deadline, schema: CHANGE_PLAN_SCHEMA, continuations: pb.continuations, operation: "copilot_plan_retry", onEvent })))));
        if (m2.ok) charge += m2.event?.customerCharge ?? 0;
        const second = fakes.length ? fakes[1] ?? null : m2.ok ? m2.value : null;
        const plan2 = coerceChangePlan(second, { maxQuestions });
        if (plan2) return planDone(plan2, { planRetried: true });
        const q = firstQuestion(second, first);
        const reply = { kind: "clarify", reply: NOTICES.briefQuestion(lang, q), plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: q ? [q] : [], sources: [] };
        return NextResponse.json({ ok: true, reply, validation: null, passages: {}, context: { ...planContext(), planRetried: true }, usage: { charge } });
      }
      // nothing plan-shaped came back: the single-reply turn below, as before (and the scripted reply, if any, is that turn's)
    } catch (e) {
      return failedTurn(failureOfError(e, "plan"), planPrompt.length);
    }
  }
  if (stage === "execute") {
    const plan = coerceChangePlan(body.plan);
    if (!plan) return NextResponse.json({ error: "send the approved change plan (plan)" }, { status: 400 });
    const wanted = Array.isArray(body.items) ? new Set(body.items.map(String)) : null;
    const approved = plan.items.filter((it) => !wanted || wanted.has(it.id));
    if (!approved.length) return NextResponse.json({ error: "no plan item was approved" }, { status: 400 });
    executedPlan = { ...plan, items: approved };
    /*
     * WHAT IS ALREADY BUILT IS NEVER BUILT AGAIN. The browser keeps each
     * item's reply as it arrives (a checkpoint) and sends the ones it has
     * back with every continuation: an item in `done` is not asked of the
     * model again — not after a retry, a rate limit, a refresh or a resume —
     * so nothing is duplicated and nothing is paid for twice.
     */
    const prior = sanitizeDone(body.done, new Set(plan.items.map((i) => i.id)));
    const finalize = body.finalize === true;
    /*
     * THE DURABLE MIRROR (2026-10-24). The browser's checkpoint above is
     * still the source of truth for what is built; these rows are WRITTEN so
     * that an operator can later make them the source (COPILOT_TASK_RESUME)
     * without a deploy. Best-effort by construction: `mirrorStart` returns
     * null for a turn too small to deserve a task row and for any failure at
     * all, and nothing below it can fail this turn.
     */
    mirror = await mirrorStart({ surveyId, request: message, plan, mode, definition: def, planFirst: body.planFirst !== false });
    /* mergeable: built earlier and not yet in a proposal; the rest of `prior` is context for the next item's prompt */
    const built: { item: typeof approved[number]; raw: unknown }[] = approved.filter((it) => prior.has(it.id) && !prior.get(it.id)!.applied).map((item) => ({ item, raw: prior.get(item.id)!.raw }));
    const newlyBuilt: { id: string; raw: unknown }[] = [];
    const done: string[] = plan.items.filter((it) => prior.has(it.id)).map((it) => builtLine(it, prior.get(it.id)!.raw));
    let waiting: { retryAfterMs: number; failure: TurnFailure } | null = null;
    let halted: TurnFailure | null = null;
    const ib = outputBudget("item");
    const itemDeadline = deadline - GATE_RESERVE_MS;
    const softStop = startedAt + Math.min(STAGE_SOFT_MS, budgetMs);
    let slowest = 0;
    if (!finalize) for (let i = 0; i < approved.length; i++) {
      const item = approved[i];
      if (prior.has(item.id) && !prior.get(item.id)!.applied) continue;
      /*
       * WHY THIS WHOLE TEST SITS BEHIND `newlyBuilt.length`, AND MUST (2026-10-25).
       *
       * A 2026-10-24 change split this in two and made the soft-stop half
       * unconditional, reasoning that a request whose FIRST item is slow is
       * never capped. That reasoning was right and the change was wrong,
       * twice over:
       *
       *   • At i = 0 `Date.now()` is a few hundred ms, far below `softStop`,
       *     so an unconditional test does not fire there anyway — it fixed
       *     nothing. What it did do is break out with NOTHING BUILT when the
       *     work before this loop (auth, the survey, the research context,
       *     the brief layering) ran past 90 s, which lands in the
       *     `!built.length` path below and makes the browser DISCARD its
       *     checkpoint.
       *   • The `slowest * 1.5` half already prevents the case that actually
       *     reaches ~160 s with more than one item: an item that took 80 s
       *     stops the next one from starting, because 1.5 × 80 s does not
       *     fit in what is left.
       *
       * The case that remains — ONE item that itself needs more than the
       * clock — cannot be fixed by stopping earlier, only by not having to
       * finish it in this request. Cutting it short (a bounded per-item
       * deadline) makes a survey that used to build in 150 s fail at 90 s and
       * fail again on every Resume, which is strictly worse than being slow.
       * That case belongs to the durable runner, not to this loop.
       */
      /* not enough of this request's time left for another item: it, and the rest, are pending — handed back, not lost */
      if (newlyBuilt.length && (itemDeadline - Date.now() < Math.max(MIN_ITEM_MS, slowest * 1.5) || Date.now() >= softStop)) break;
      /* streaming, and the page has gone (or the stream was dropped): nothing more is started for nobody — what is built was already sent as checkpoints */
      if (sink?.cancelled) break;
      sink?.progress({ stage: "item", item: i + 1, of: approved.length, id: item.id, label: item.title });
      /* §3: the item's own exact passages of the stored brief (a quota table, a hypothesis, a definitions table) — not the whole brief */
      const hit = useBriefLayers ? itemPassagesFor(briefSections, item) : { text: "", ids: [] as string[] };
      const itemPassages = hit.text;
      /*
       * #11: THIS ITEM'S GUIDES — the build's core (one cached block, the same on every item) and what the item itself
       * needs, read from its kind, title, objects and its own brief passages; the whole build's set when nothing can be
       * read from it or per-item selection is off (COPILOT_ITEM_GUIDES=off).
       */
      const sel = perItemGuides ? itemGuideSelection({ item, build: buildGuides, mode, passages: itemPassages }) : null;
      const core = sel ? guideTexts(sel.core) : undefined;
      const basePrompt = (c: boolean) => (sel ? itemPromptOf(c, sel) : promptOf(c));
      const sentGuides: GuideId[] = sel ? sel.all : guidesOf(buildGuides);
      itemGuides[item.id] = { guides: sentGuides, core: sel?.core ?? [], why: sel?.why ?? {}, ...(sel?.fallback ? { fallback: true as const } : {}), chars: sentGuides.reduce((n, g) => n + GUIDE_TEXT[g].length, 0) };
      const itemPrompt = basePrompt(false) + itemPassages + executeItemPrompt(plan, item, i, approved, done);
      const t0 = Date.now();
      try {
        const m = await measured({ ...consent, estimateText: COPILOT_SYSTEM_PROMPT + itemPrompt, maxTokens: ib.expectedTokens, operation: `copilot_${mode}_item` }, itemPrompt,
          () => fitting((c) => { const p = basePrompt(c) + itemPassages + executeItemPrompt(plan, item, i, approved, c ? done.slice(-12) : done); return shared(`item:${item.id}`, p, () => model(() => completeJson(...copilotCall(p, stableExtra, core ? { core } : {}), ib.maxTokens, { timeoutMs: ib.timeoutMs, deadline: itemDeadline, schema: COPILOT_REPLY_SCHEMA, continuations: ib.continuations, operation: `copilot_${mode}_item`, onEvent, ...live("reply", `item:${item.id}${c ? ":compact" : ""}`, fakes[newlyBuilt.length]) }))); }), hit.ids, { ...(core ? { core } : {}), guides: sentGuides });
        if (!m.ok) {
          const r = refusalResponse(m);
          const body = await r.json().catch(() => ({})) as Record<string, unknown>;
          if (!built.length) return NextResponse.json({ ...body, failure: failureOf(body) }, { status: r.status });
          halted = failureOf(body);
          break;
        }
        charge += m.event?.customerCharge ?? 0;
        const itemRaw = fakes[newlyBuilt.length] ?? m.value;
        built.push({ item, raw: itemRaw });
        newlyBuilt.push({ id: item.id, raw: itemRaw });
        /* the item, kept by the page the moment it exists: a connection lost after this costs only the item in flight */
        sink?.checkpoint(item.id, itemRaw);
        /* and kept by the SERVER, so a connection lost after this costs nothing at all once the read is switched over */
        await mirror?.step(item.id, itemRaw, { tokensIn: m.event?.inputUnits ?? undefined, tokensOut: m.event?.outputUnits ?? undefined, charge: m.event?.customerCharge, model: m.event?.model ?? undefined });
        slowest = Math.max(slowest, Date.now() - t0);
        done.push(builtLine(item, itemRaw));
        /* #11: an action whose guide this item was not sent — judged by the gate as any other; logged, and offered to the repair with its guide */
        const miss = guideMisses(rawActionsOf(itemRaw).map(opOfRaw), sentGuides);
        if (miss.length) {
          misses.push({ item: item.id, guides: miss.map((x) => x.guide), ops: miss.flatMap((x) => x.ops) });
          console.warn("[rescript:copilot]", JSON.stringify({ event: "guide miss: an item proposed actions whose guide it was not sent (the gate judges them; the repair carries the guide)", surveyId, item: item.id, sent: sentGuides, missing: miss }));
        }
      } catch (e) {
        const failure = failureOfError(e, `plan item ${item.id}`);
        if (isProviderError(e) && (e.retryable || !["bad_request"].includes(e.kind))) {
          /* the provider, not this item: a temporary failure waits and resumes; a refused key or spent quota stops and says so — the item stays PENDING either way */
          if (e.retryable) waiting = { retryAfterMs: Math.max(0, Math.round(e.retryAfterMs ?? (e.kind === "timeout" ? 0 : 5000 + Math.random() * 5000))), failure };
          else halted = failure;
          break;
        }
        planFailures.push({ id: item.id, failure });
      }
    }
    const failedIds = new Set(planFailures.map((f) => f.id));
    planPending = approved.filter((it) => !built.some((b) => b.item.id === it.id) && !failedIds.has(it.id)).map((it) => it.id);
    if (!built.length) {
      /* nothing built, nothing to keep: a failure to retry as it is (the browser holds the request) */
      const failure = halted ?? waiting?.failure ?? planFailures[0]?.failure ?? describeFailure("unusable");
      return failedTurn(waiting ? { ...failure, retryAfterMs: waiting.retryAfterMs || failure.retryAfterMs } : failure, prompt.length);
    }
    if (planPending.length && !finalize) {
      await mirror?.finish(null);
      /* a checkpoint: what was built in this request, what is still to do, why it stopped — the browser stores it and carries on */
      return NextResponse.json({
        ok: true, stage: "progress", built: newlyBuilt, builtIds: built.map((b) => b.item.id), pending: planPending, failed: planFailures,
        ...(waiting ? { waiting: { retryAfterMs: waiting.retryAfterMs, failure: { ...waiting.failure, retryAfterMs: waiting.retryAfterMs || undefined } } } : {}),
        ...(halted ? { halted } : {}),
        context: { mode, promptChars: prompt.length, cached: false, provider: providerNote(events), elapsedMs: Date.now() - startedAt, ...(capacityNotice() ? { notice: capacityNotice() } : {}), ...contextMeta(), workflow: await keepWorkflow(false) },
        usage: { charge },
      });
    }
    raw = mergeItemReplies(built);
  }
  const hit = CACHE.get(key);
  if (stage === "execute") { /* built above */ }
  else if (hit && Date.now() - hit.at < TTL && !fake) { raw = hit.value; cached = true; }
  else {
    try {
      /*
       * The reply's shape goes with the request where the provider takes a
       * schema; a cut-off answer is continued (generation is the one most
       * likely to outgrow its budget — two continuations give it three
       * budgets); and what still cannot be read comes back as a CODE the
       * researcher is told, not as "nothing I could use" (Phase 1).
       */
      sink?.progress({ stage: "turn" });
      const m = await measured({ ...consent, estimateText: COPILOT_SYSTEM_PROMPT + prompt, maxTokens: budget.expectedTokens, operation: `copilot_${mode}` }, prompt,
        () => fitting((c) => shared("turn", promptOf(c), () => model(() => completeJson(...copilotCall(promptOf(c), stableExtra), maxTokens, { timeoutMs: budget.timeoutMs, deadline, schema: COPILOT_REPLY_SCHEMA, continuations: budget.continuations, operation: `copilot_${mode}`, onEvent, ...live("reply", c ? "reply:compact" : "reply", fake) })))));
      if (!m.ok) {
        const r = refusalResponse(m);
        const body = await r.json().catch(() => ({})) as Record<string, unknown>;
        return NextResponse.json({ ...body, failure: failureOf(body) }, { status: r.status });
      }
      charge += m.event?.customerCharge ?? 0;
      raw = fake ?? m.value;
      if (raw && !fake) { CACHE.set(key, { at: Date.now(), value: raw }); if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value!); }
    } catch (e) {
      return failedTurn(failureOfError(e, "turn"), prompt.length);
    }
  }

  /* 4: the gate, and the engine's validation on a clone */
  sink?.progress({ stage: "gate", label: "Checking the proposal" });
  const coerced = coerceCopilotReply(raw);
  let reply = guard(coerced && themeImageUrl ? { ...coerced, actions: withThemeImage(coerced.actions, themeImageUrl) } : coerced);
  if (!reply) {
    const failure = aiProviderName() === "fake"
      ? describeFailure("unusable", "The FAKE provider cannot reason about surveys; configure a real model to use the copilot.")
      : describeFailure("unusable");
    return NextResponse.json({ ok: true, reply: null, message: failure.message, failure, context: { mode, researchUsed: !!research, passages: passageIds, promptChars: prompt.length, cached }, usage: { charge }, ...(deterministic ? { review: deterministic } : {}) });
  }
  // a look-only request cannot change the structure: the engine refuses structural actions and proves the rest left it alone
  let applied = reply.actions.length ? applySurveyActions(def, reply.actions, { uxOnly: cls.uxOnly, uxOnlyInferred }) : null;
  const okCount = (a: typeof applied) => (a ? a.results.filter((x) => x.ok).length - a.results.filter((x) => !x.ok).length : -Infinity);
  /*
   * #13 (2026-10-22): A REFUSED MAXDIFF / CONJOINT DESIGN WITH ONE OBVIOUS CORRECTION IS CORRECTED HERE — 5 items per
   * task from 5 items, more alternatives than the attributes make concepts, a None beside dual-response, a level
   * listed twice, too few rating profiles (`autoFixMethodAction`). No model call; the correction goes through the
   * gate again and is kept only if more of the batch applies; what was changed is said (assumptions, context).
   * Nothing is invented: missing levels, items or prices and over-tight prohibitions go to the repair below.
   */
  const methodFixes: { op: string; note: string }[] = [];
  /** the raw actions `reply.rejected` indexes (the repair's own answer, once it is adopted) */
  let rejectedRaw: unknown = raw;
  for (let round = 0; round < 3; round++) {
    const r0: CopilotReply = reply;
    const rawList = rawActionsOf(raw);
    const targets: { gate: boolean; i: number; obj: Record<string, unknown>; reason: string }[] = [];
    for (const rj of r0.rejected) { const o = rawList[rj.index]; if (o && isMethodOp(opOfRaw(o))) targets.push({ gate: true, i: rj.index, obj: o, reason: rj.reason }); }
    if (applied) for (const res of applied.results) if (!res.ok && isMethodOp(res.op)) targets.push({ gate: false, i: res.index, obj: r0.actions[res.index] as unknown as Record<string, unknown>, reason: res.error ?? "" });
    if (!targets.length) break;
    const nextActions: SurveyAction[] = [...r0.actions];
    let nextRejected = [...r0.rejected];
    const notes: { op: string; note: string }[] = [];
    for (const tg of targets) {
      const f = autoFixMethodAction(tg.obj, tg.reason, def);
      if (!f) continue;
      const c = coerceSurveyActions([f.action]);
      if (!c.actions.length) continue;
      if (tg.gate) { nextActions.push(c.actions[0]!); nextRejected = nextRejected.filter((x) => x.index !== tg.i); }
      else nextActions[tg.i] = c.actions[0]!;
      notes.push({ op: opOfRaw(tg.obj), note: f.note });
    }
    if (!notes.length) break;
    const a2 = applySurveyActions(def, nextActions, { uxOnly: cls.uxOnly, uxOnlyInferred });
    if (okCount(a2) <= okCount(applied)) break;
    reply = { ...r0, kind: "proposal", actions: nextActions, rejected: nextRejected, assumptions: [...r0.assumptions, ...notes.map((n) => `Corrected by the Studio (${n.op}): ${n.note}.`)].slice(0, 30) };
    applied = a2;
    methodFixes.push(...notes);
  }
  if (methodFixes.length) console.warn("[rescript:copilot]", JSON.stringify({ event: "refused design corrected by the Studio, no model call", surveyId, fixes: methodFixes }));
  /*
   * ONE REPAIR. The model sometimes proposes something the Studio refuses — a
   * script reaching for the page, an event that does not exist, an option that
   * is not there. Rather than offer a proposal whose Apply can do nothing, the
   * refusals go back to the model once, with its answer, and it corrects
   * them. The corrected answer is used only if the Studio accepts more of it.
   */
  let repair: { refused: string[]; fixed: boolean; uxGuide?: boolean; skipped?: "policy"; guides?: GuideId[] } | undefined;
  // the failed actions, each "what it was: why" — the first entries of errors, in order (a design's refusal made precise: its prohibitions, what must not be invented)
  const failedResults = applied ? applied.results.filter((x) => !x.ok) : [];
  const refused = applied ? applied.errors.slice(0, failedResults.length).map((e, k) => { const res = failedResults[k]; if (!res || !isMethodOp(res.op)) return e; const why = res.error ?? ""; return `${e}${explainMethodRefusal(reply!.actions[res.index] as unknown as Record<string, unknown>, why).slice(why.length)}`; }) : [];
  /*
   * #12 / #13: AN ANALYSIS-PLAN OR DESIGN ACTION REFUSED AT THE GATE (before it could be applied — "create_conjoint
   * (cbc) needs the attributes…", "a crosstab needs rows and columns") goes to the same repair. It never did: only
   * refusals at apply time reached it, so such a turn ended in "nothing was changed". A qualitative guide refused in
   * the same way goes too (production 2026-10-23: a 20-minute guide dropped for sessionPlan.mode "video", $0.16 spent).
   */
  const rawNow = rawActionsOf(raw);
  const gateRefused = reply.rejected.filter((rj) => { const op = opOfRaw(rawNow[rj.index] ?? {}); return isMethodOp(op) || isAnalysisOp(op) || isQualOp(op); }).map((rj) => { const o = rawNow[rj.index] ?? {}; const op = opOfRaw(o); return { op, text: `${op}: ${isMethodOp(op) ? explainMethodRefusal(o, rj.reason) : rj.reason}` }; });
  const refusedAll = [...refused, ...gateRefused.map((g) => g.text)];
  // a refusal the model cannot change (said look-only, the enforced research design) is not worth a paid call
  const repairable = refusedAll.filter((r) => !policyRefusal(r));
  if (refusedAll.length && !repairable.length) repair = { refused: refusedAll, fixed: false, skipped: "policy" };
  /*
   * A STAGED BUILD gets the repair too (#11/#13, 2026-10-22) when what was refused is a design or plan action, or an
   * action whose guide its item was not sent — the guide goes with the repair. TEST SEAM, fake provider only: the
   * repair's scripted reply is `fakeRepair` (the per-item replies are `fake`).
   */
  const failedOps = [...failedResults.map((x) => x.op), ...gateRefused.map((g) => g.op)];
  const missedOps = new Set(misses.flatMap((x) => x.ops));
  const missedGuides = [...new Set(misses.flatMap((x) => x.guides))].filter((g) => failedOps.some((op) => missedOps.has(op)));
  const repairHere = !executedPlan || failedOps.some((op) => isMethodOp(op) || isAnalysisOp(op) || isQualOp(op) || missedOps.has(op));
  const repairFake = executedPlan ? (fakeProvider ? (body as { fakeRepair?: unknown }).fakeRepair ?? null : null) : fakes[1] ?? null;
  if (repairable.length && repairHere && !cached && !sink?.cancelled && deadline - Date.now() > MIN_ITEM_MS && (aiProviderName() !== "fake" || repairFake != null)) {
    const rp = repairPrompt({ prompt, raw, refused: refusedAll, total: reply.actions.length + gateRefused.length, uxGuideSent: uxTurn, methodsGuideSent: methodsTurn, ops: [...reply.actions.map((x) => String((x as { op?: unknown }).op ?? "")), ...gateRefused.map((g) => g.op)], extraGuides: missedGuides.map((g) => GUIDE_TEXT[g]) });
    const repairPromptText = rp.text;
    // what was refused, for whoever reads the server log: the request did not reach the guide, or the model ignored it
    console.warn("[rescript:copilot] actions refused, asking once more", JSON.stringify({ mode, uxGuideSent: uxTurn, addedUxGuide: rp.addedUxGuide, ...(missedGuides.length ? { addedGuides: missedGuides } : {}), refused: refusedAll.map((e) => e.slice(0, 300)) }));
    try {
      const rb = outputBudget("repair");
      sink?.progress({ stage: "repair", label: "Correcting refused actions" });
      const m = await measured({ ...consent, estimateText: COPILOT_SYSTEM_PROMPT + repairPromptText, maxTokens: rb.expectedTokens, operation: `copilot_${mode}_repair` }, repairPromptText,
        () => model(() => completeJson(...copilotCall(repairPromptText, stableExtra), rb.maxTokens, replyCallOptions({ timeoutMs: rb.timeoutMs, deadline, continuations: rb.continuations, operation: `copilot_${mode}_repair`, onEvent }))));
      if (m.ok) {
        charge += m.event?.customerCharge ?? 0;
        const raw2 = repairFake ?? m.value;
        const c2 = coerceCopilotReply(raw2);
        const r2 = guard(c2 && themeImageUrl ? { ...c2, actions: withThemeImage(c2.actions, themeImageUrl) } : c2);
        /*
         * TARGETED: the model returns only the corrections; the accepted actions are kept as they were
         * (not regenerated, not paid for twice). A model that repeats an accepted action keeps it once.
         */
        const kept = applied ? applied.results.filter((x) => x.ok).map((x) => reply!.actions[x.index]!).filter(Boolean) : [];
        const merged = r2 ? mergeRepair(kept, r2.actions) : [];
        const a2 = r2 && merged.length ? applySurveyActions(def, merged, { uxOnly: cls.uxOnly, uxOnlyInferred }) : null;
        const r2Gate = r2 ? r2.rejected.length : 0;
        if (r2 && (okCount(a2) > okCount(applied) || (!a2 && !applied?.results.some((x) => x.ok)))) {
          reply = carryProvenance(reply, { ...r2, actions: merged }); applied = a2; rejectedRaw = raw2;
          if (!fakes.length && !kept.length) { CACHE.set(key, { at: Date.now(), value: raw2 }); }
          repair = { refused: refusedAll, fixed: (!a2 || a2.results.every((x) => x.ok)) && !r2Gate, uxGuide: rp.addedUxGuide, ...(missedGuides.length ? { guides: missedGuides } : {}) };
        } else repair = { refused: refusedAll, fixed: false, uxGuide: rp.addedUxGuide, ...(missedGuides.length ? { guides: missedGuides } : {}) };
      }
    } catch (e) {
      console.warn("[rescript:copilot] repair failed", JSON.stringify({ error: (e as Error).message }));
    }
  }
  /*
   * #13: A DESIGN THAT STILL CANNOT BE MADE IS SAID PLAINLY — what was refused and why, and that it was sent back
   * once (the researcher is never left with a proposal that silently lacks the MaxDiff they asked for).
   */
  {
    const rawEnd = rawActionsOf(rejectedRaw);
    const stillGate = reply.rejected.map((rj) => ({ o: rawEnd[rj.index] ?? {}, reason: rj.reason })).filter((x) => isMethodOp(opOfRaw(x.o))).map((x) => `${opOfRaw(x.o)}: ${x.reason}`);
    const stillApplied = applied ? applied.results.filter((x) => !x.ok && isMethodOp(x.op)).map((x) => `${x.description}: ${x.error ?? ""}`) : [];
    const designStill = [...new Set([...stillApplied, ...stillGate])];
    if (designStill.length) reply = { ...reply, reply: `${reply.reply} ${NOTICES.designRefused(lang, designStill, !!repair && repair.skipped !== "policy")}`.slice(0, 4000) };
  }
  /*
   * THE COVERAGE GATE (Phase 3). A generated survey is checked on the clone
   * before it is shown: every hypothesis measured, every question serving
   * the design or the sample. What is loose goes back to the model once —
   * keep the actions, add the tags, links and questions that connect them
   * — and the better answer is used. The report travels with the proposal
   * either way, so the card says what is connected and what is not.
   */
  let coverage: CoverageReport | undefined;
  if (mode === "generate" && applied?.valid && reply.actions.length) {
    coverage = coverageReport(applied.def);
    const nextFake = executedPlan ? fakes[approvedCount(executedPlan)] : fakes[repair ? 2 : 1];
    /* a partial build is not sent round again to connect what is not there yet; and a pass is only started with time to finish it */
    const partialBuild = !!executedPlan && (planPending.length > 0 || planFailures.length > 0);
    if (!coverage.ok && !cached && !partialBuild && !sink?.cancelled && deadline - Date.now() > MIN_ITEM_MS && (aiProviderName() !== "fake" || nextFake)) {
      const coveragePrompt = `${prompt}\n\nYOUR PREVIOUS ANSWER:\n${JSON.stringify(executedPlan ? raw : raw).slice(0, 14_000)}\n\nTHE STUDIO CHECKED THE RESEARCH COVERAGE OF THAT ANSWER: ${coverage.summary}.\n\nAnswer again in the same JSON shape with the SAME actions, plus what connects the loose ends: set_question_analysis tags (hypotheses) on the questions that measure each unmeasured hypothesis, constructs in set_research that name the measuring questions, a question for a hypothesis none measures, and a tag or construct for each unconnected question — or remove a question that serves nothing. Every hypothesis must be measured and every question must serve one, a construct, the plan or a KPI (screeners and demographics are exempt).`;
      try {
        const cb = outputBudget("coverage");
        sink?.progress({ stage: "coverage", label: "Connecting the research coverage" });
        const m = await measured({ ...consent, estimateText: COPILOT_SYSTEM_PROMPT + coveragePrompt, maxTokens: cb.expectedTokens, operation: `copilot_${mode}_coverage` }, coveragePrompt,
          () => model(() => completeJson(...copilotCall(coveragePrompt, stableExtra), cb.maxTokens, { timeoutMs: cb.timeoutMs, deadline, schema: COPILOT_REPLY_SCHEMA, continuations: cb.continuations, operation: `copilot_${mode}_coverage`, onEvent })));
        if (m.ok) {
          charge += m.event?.customerCharge ?? 0;
          const raw3 = nextFake ?? m.value;
          const c3 = coerceCopilotReply(raw3);
          const r3 = guard(c3 && themeImageUrl ? { ...c3, actions: withThemeImage(c3.actions, themeImageUrl) } : c3);
          const a3 = r3 && r3.actions.length ? applySurveyActions(def, r3.actions, { uxOnly: cls.uxOnly, uxOnlyInferred }) : null;
          if (r3 && a3?.valid) {
            const cov3 = coverageReport(a3.def);
            const better = cov3.ok || cov3.unmeasured.length + cov3.unconnected.length < coverage.unmeasured.length + coverage.unconnected.length;
            if (better && a3.results.filter((x) => x.ok).length >= applied.results.filter((x) => x.ok).length) { reply = carryProvenance(reply, r3); applied = a3; coverage = { ...cov3, summary: `${cov3.summary} (connected on a second pass)` }; }
          }
        }
      } catch (e) {
        console.warn("[rescript:copilot] coverage pass failed", JSON.stringify({ error: (e as Error).message }));
      }
    }
  }
  /*
   * THE COMPLETION GATE, and the only place it can honestly run: `applied.def`
   * is the survey as this turn would leave it. A task whose every step came
   * back but whose deliverable is short — 64 questions of 100 — stays
   * `running` here and resumes at 65. Deterministic code decides; no model is
   * asked, and a failure to record it cannot fail the turn.
   */
  await mirror?.finish(applied?.valid ? applied.def : null);
  const diff = applied?.valid ? diffSurveys(def, applied.def) : null;
  const passages = passageIds.length || reply.sources.length ? await describePassages(store, surveyId, docs, [...passageIds, ...reply.sources.flatMap((x) => x.passages)]) : {};
  // a citation to a passage that does not exist is not a citation: dropped, and a "document" claim with none left is only a recommendation
  for (const src of reply.sources) {
    src.passages = src.passages.filter((p) => passages[p]);
    if (src.support === "document" && !src.passages.length) src.support = "recommendation";
  }
  /*
   * THE MEMORY TELLS THE TRUTH. The model writes its running memory before the Studio has judged its
   * actions, so a refused action used to be remembered as done ("Q3 validation: min 18" after the
   * validation was refused) and the next turn built on it. What was refused is appended in the
   * Studio's words.
   */
  if (reply && applied && typeof reply.memory === "string") reply = { ...reply, memory: memoryWithRefusals(reply.memory, applied.results) };
  /* NEVER "SUCCESS" WHEN NOTHING WAS DONE: a batch the engine refused entirely, a reply that claims a change it did not propose, an approved plan whose items came back empty */
  reply = honestReply(reply, applied?.results ?? null, lang);
  if (executedPlan && !reply.actions.length && !provenanceRejections(reply).length) reply = { ...reply, kind: "answer", reply: NOTICES.nothingBuilt(lang, executedPlan.items.length) };
  /* the turn's notice: the provider's capacity, and what the injection scan and the provenance gate said */
  const injectionNotice = turnNotice(provenance, provenanceRejections(reply).length);
  const noticeOf = () => [capacityNotice(), injectionNotice].filter(Boolean).join(" ") || undefined;
  /* a mixed request: the supported part was done; the Studio names the rest */
  if (outside.length) reply = { ...reply, reply: `${reply.reply} ${NOTICES.outside(lang, outside, outsideNote(outside))}`.slice(0, 4000) };
  return NextResponse.json({
    ok: true, reply,
    ...(executedPlan ? { stage: "executed", plan: executedPlan, ...(planFailures.length ? { planFailures } : {}), ...(planPending.length ? { planPending, partial: true } : {}) } : {}),
    ...(coverage ? { coverage: { ok: coverage.ok, summary: coverage.summary, unmeasured: coverage.unmeasured, unconnected: coverage.unconnected.map((q) => String(q.code)), hypotheses: coverage.hypotheses } } : {}),
    validation: applied ? { valid: applied.valid, results: applied.results, errors: applied.errors, destructive: applied.destructive, warnings: applied.warnings, summary: diff?.summary ?? [], diff, uxOnly: applied.uxOnly, structureUnchanged: applied.structureUnchanged } : null,
    ...(deterministic ? { review: deterministic } : {}),
    passages,
    context: { mode, researchUsed: !!research, passages: passageIds, promptChars: prompt.length, outlineChars: outline.length, messageChars: message.length, ...(longBrief ? { longBrief: true } : {}), ...(outside.length ? { scope: "mixed", outside } : {}), cached, ux: uxTurn, uxOnly: cls.uxOnly, ...(uxOnlyInferred ? { uxOnlyInferred } : {}), analysis: analysisTurn, translation: translationTurn, quota: quotaTurn, ...(methodsTurn ? { methods: true } : {}), findings: findingsTurn, hasRun: !!analysisRun, provider: providerNote(events), ...(noticeOf() ? { notice: noticeOf() } : {}), ...(provenance.untrusted ? { injection: { untrusted: true, flagged: provenance.flagged, sources: provenance.sources, signals: provenance.signals.slice(0, 5).map((x) => ({ kind: x.kind, excerpt: x.excerpt })), excluded: provenanceRejections(reply).map((x) => x.reason) } } : {}), ...(repair ? { repair } : {}), ...(methodFixes.length ? { methodFixes } : {}), ...contextMeta(), ...(executedPlan ? { workflow: await keepWorkflow(!planPending.length && !planFailures.length) } : {}) },
    usage: { charge },
  });
}

/** TEST SEAM (fake provider only): `fakeStream` — `true`, or { chunkChars, delayMs, failAfterChars, failKind } for the stand-in's writing and { heartbeatMs, dropAfterCheckpoints, dropAfterMs } for the stream */
interface StreamSeam { script: FakeStreamScript; heartbeatMs?: number; dropAfterCheckpoints?: number; dropAfterMs?: number }
const SEAM_KINDS: ProviderErrorKind[] = ["rate_limited", "quota_exhausted", "overloaded", "server", "network", "timeout", "auth", "forbidden", "not_found", "bad_request", "busy"];
function streamSeam(v: unknown): StreamSeam | null {
  if (v === true) return { script: {} };
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined);
  const kind = SEAM_KINDS.find((k) => k === o.failKind);
  const script: FakeStreamScript = { ...(num(o.chunkChars) ? { chunkChars: num(o.chunkChars) } : {}), ...(num(o.delayMs) != null ? { delayMs: num(o.delayMs) } : {}), ...(num(o.failAfterChars) != null ? { failAfterChars: num(o.failAfterChars) } : {}), ...(kind ? { failKind: kind } : {}) };
  return { script, heartbeatMs: num(o.heartbeatMs), dropAfterCheckpoints: num(o.dropAfterCheckpoints), dropAfterMs: num(o.dropAfterMs) };
}

/** the model's own action objects (raw JSON), in order — what `reply.rejected` indexes */
function rawActionsOf(raw: unknown): Record<string, unknown>[] {
  const a = raw && typeof raw === "object" ? (raw as { actions?: unknown }).actions : null;
  return Array.isArray(a) ? a.map((x) => (x && typeof x === "object" ? x as Record<string, unknown> : {})) : [];
}
const opOfRaw = (x: Record<string, unknown>): string => String(x.op ?? x.action ?? "");

function sanitizeMemory(m: TurnMemory | undefined): TurnMemory | undefined {
  if (!m || typeof m !== "object") return undefined;
  const history = Array.isArray(m.history) ? m.history.filter((h) => h && (h.role === "user" || h.role === "copilot") && typeof h.text === "string").slice(-6).map((h) => ({ role: h.role, text: h.text.slice(0, 500) })) : [];
  return { ...(typeof m.memory === "string" ? { memory: m.memory.slice(0, 1000) } : {}), history };
}

async function describePassages(store: Awaited<ReturnType<typeof researchStoreFor>>, surveyId: string, docs: { ref: string; name: string }[], ids: string[]): Promise<Record<string, { doc: string; page: number; heading?: string; excerpt: string }>> {
  const want = new Set(ids);
  if (!want.size) return {};
  const name = new Map(docs.map((d) => [d.ref, d.name]));
  const out: Record<string, { doc: string; page: number; heading?: string; excerpt: string }> = {};
  for (const c of await store.chunks(surveyId)) if (want.has(c.id)) out[c.id] = { doc: name.get(c.docId) ?? c.docId, page: c.page, ...(c.heading ? { heading: c.heading } : {}), excerpt: c.text.slice(0, 280) };
  return out;
}
