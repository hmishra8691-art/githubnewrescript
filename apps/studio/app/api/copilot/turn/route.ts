import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { SurveyDefinition } from "@rescript/schema";
import { aiConfigured, aiProviderName, completeJson, embedTexts, aiEmbeddingsModelName, isAiReplyError, isProviderError, capacityNotice, ProviderError, type ProviderErrorKind, type ProviderEvent } from "@rescript/ai";
import { describeFailure, failureFromError, failureFromReplyError, type TurnFailure } from "@/lib/copilot/failure";
import { singleFlight } from "@/lib/singleFlight";
import { aiReadyFor, connectionFor } from "@/lib/byok/connect";
import { providerById, identityOf, aiIdentity } from "@rescript/ai";
import { outputBudget } from "@/lib/copilot/budget";
import { CHANGE_PLAN_SCHEMA, coerceChangePlan, executeItemPrompt, mergeItemReplies, planStagePrompt, type ChangePlan } from "@/lib/copilot/changePlan";
import { COPILOT_REPLY_SCHEMA, replyCallOptions } from "@/lib/copilot/replySchema";
import { applySurveyActions, coverageReport, diffSurveys, reviewSurvey, type CoverageReport } from "@rescript/engine";
import { ResearchIndex } from "@rescript/import/research";
import { isFailure, requireUser, type AuthedUser } from "@/lib/guard";
import { billingProjectFor, isSandboxProject, meteredAi, refusalResponse } from "@/lib/metering";
import { latestRun } from "@/lib/analytics";
import { supabaseAdmin } from "@/lib/admin";
import { describeThemeImage, withThemeImage } from "@/lib/copilot/themeImageText";
import type { AnalysisRun } from "@rescript/analytics";
type RunBrief = Pick<AnalysisRun, "computedAt" | "n" | "findings" | "verdicts" | "warnings" | "environment" | "trigger" | "corrections" | "advice" | "discoveries">;
import { COPILOT_SYSTEM_PROMPT, classifyRequest, coerceCopilotReply, copilotUserPrompt, analysisIntent, translationIntent, quotaIntent, findingsIntent, referencedQuestions, surveyLanguageOf, type RequestMode, type TurnMemory } from "@/lib/copilot/prompt";
import { researchCards, researchPassages } from "@/lib/copilot/research";
import { researchStoreFor } from "@/lib/copilot/store";
import { copilotOutline } from "@/lib/copilot/outline";

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

/**
 * the items a previous request already built, as the browser kept them: by plan item id, objects only, a plan's worth at most.
 * `applied` marks an item that is already in the open proposal — told to the model as context, never merged again.
 */
function sanitizeDone(x: unknown, allowed: Set<string>): Map<string, { raw: unknown; applied: boolean }> {
  const out = new Map<string, { raw: unknown; applied: boolean }>();
  if (!Array.isArray(x)) return out;
  for (const e of x.slice(0, 80)) {
    const r = e as { id?: unknown; raw?: unknown; applied?: unknown };
    if (typeof r?.id === "string" && allowed.has(r.id) && r.raw && typeof r.raw === "object" && !out.has(r.id)) out.set(r.id, { raw: r.raw, applied: r.applied === true });
  }
  return out;
}

/** what the provider layer did on the way — retries and a fallback — for the log and the history, never a provider's words */
function providerNote(events: ProviderEvent[]): { retries: number; fallback: boolean; recovered: boolean } {
  return { retries: events.filter((e) => e.type === "retry").length, fallback: events.some((e) => e.type === "fallback"), recovered: events.some((e) => e.type === "recovered") };
}

/** the scripted replies an executed plan consumed: one per approved item */
const approvedCount = (plan: { items: unknown[] }) => plan.items.length;

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  const startedAt = Date.now();
  let body: { surveyId?: unknown; message?: unknown; definition?: unknown; selectedId?: unknown; memory?: TurnMemory; mode?: unknown; fake?: unknown; scope?: unknown; themeImage?: unknown; quotaCounts?: unknown; analysisRun?: unknown; stage?: unknown; planFirst?: unknown; plan?: unknown; items?: unknown; aiOnce?: unknown; done?: unknown; finalize?: unknown; faults?: unknown; budgetMs?: unknown };
  try { body = await req.json(); } catch { return isFailure(authed) ? authed.response : NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  /* the researcher chose "send this once" while the project runs Internal: that one request may reach the model (audit A-2); nothing else may */
  const consent: { consent?: "once" } = body.aiOnce === true ? { consent: "once" } : {};
  /* a refusal body is a wallet failure unless the project's AI switch refused it */
  const failureOf = (b: Record<string, unknown>) => (b.code === "ai_disabled" ? describeFailure("internal_mode") : b.code === "ai_connection" ? describeFailure("connection", String(b.error ?? "")) : describeFailure("wallet", String(b.error ?? "")));
  let user: AuthedUser | null = null;
  if (isFailure(authed)) {
    if (!(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;
  } else user = authed;
  if (!(await aiReadyFor(user, surveyId, "copilot_turn"))) return NextResponse.json({ error: "No language model is configured on this Studio (AI_API_URL). The built-in grammar still handles common edits.", code: "ai_unconfigured", failure: describeFailure("not_configured") }, { status: 501 });
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 8000) : "";
  if (!message) return NextResponse.json({ error: "say what you want" }, { status: 400 });
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
  const mode: RequestMode = body.mode === "review" ? "review" : body.mode === "generate" ? "generate" : cls.mode;
  /* an image to build the theme from: its colours go to the model, its address stays here */
  const ti = body.themeImage && typeof body.themeImage === "object" ? body.themeImage as { url?: unknown; name?: unknown; dominant?: unknown; palette?: unknown; dark?: unknown } : null;
  const themeImageUrl = ti && typeof ti.url === "string" && (/^https:\/\/[^\s"'()<>\\]+$/i.test(ti.url) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(ti.url) || /^\/[^\s"'()<>\\]+$/.test(ti.url)) ? ti.url : null;
  const themeImageText = ti && themeImageUrl ? describeThemeImage({ name: typeof ti.name === "string" ? ti.name.slice(0, 80) : undefined, dominant: Array.isArray(ti.dominant) ? ti.dominant.filter((c): c is string => typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c)).slice(0, 8) : [], palette: ti.palette && typeof ti.palette === "object" ? Object.fromEntries(Object.entries(ti.palette as Record<string, unknown>).filter(([k, v]) => /^[a-z]{2,20}$/i.test(k) && typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)).slice(0, 16)) as Record<string, string> : {}, dark: ti.dark === true }) : undefined;
  const selectedId = typeof body.selectedId === "string" ? body.selectedId : null;
  // a request about the look and behaviour gets the UX guide, the theme and the UX of the questions it names
  const uxTurn = cls.ux || mode === "ux";
  // the analysis framework: a request about it, or a generation (the design arrives with its analysis)
  const analysisTurn = analysisIntent(message) || mode === "generate";
  // languages: the translation guide, and the named questions' elements with their existing translations
  const translationTurn = translationIntent(message);
  // quotas: the guide, every cell with its condition and where the check sits, the review, and the live counts the Studio sent
  const quotaTurn = quotaIntent(message);
  const quotaCounts = body.quotaCounts && typeof body.quotaCounts === "object" ? body.quotaCounts as Record<string, Record<string, number>> : null;
  // findings: what the data showed — the latest analysis run the Studio sent, answered from its numbers
  const findingsTurn = findingsIntent(message);
  /* the findings the copilot answers from are the project's own stored run, read here — never numbers the browser sends (audit A-3). The sandbox has no stored data, so its fixture's run is taken as sent. */
  const sentRun = body.analysisRun && typeof body.analysisRun === "object" && Array.isArray((body.analysisRun as { findings?: unknown }).findings) ? body.analysisRun as RunBrief : null;
  const analysisRun: RunBrief | null = !findingsTurn ? null : isSandboxProject(surveyId) ? sentRun : await latestRun(supabaseAdmin(), surveyId).catch(() => null);
  const outline = copilotOutline(def, { selectedId, focusIds: referencedQuestions(def, message), ux: uxTurn, analysis: analysisTurn, translation: translationTurn, quota: quotaTurn, quotaCounts, findings: findingsTurn, analysisRun });
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
  const deterministic = mode === "review" ? reviewSurvey(def) : null;
  /* the prompt in full, and — for the rare provider that says it is too long for the model's context window — in compact form: no research passages, no memory of earlier turns */
  const promptFor = (compact: boolean) => copilotUserPrompt({
    message, outline, surveyLanguage: surveyLanguageOf(def), mode,
    memory: compact ? undefined : sanitizeMemory(body.memory), research: compact ? undefined : research || undefined,
    deterministicFindings: deterministic?.findings.slice(0, 40).map((f) => `${f.severity}: ${f.message}`),
    selected: selectedId ? def.questions.find((q) => q.id === selectedId)?.code ?? null : null,
    ux: uxTurn, uxOnly: cls.uxOnly,
    analysis: analysisTurn, translation: translationTurn, quota: quotaTurn, findings: findingsTurn,
    ...(themeImageText ? { themeImage: themeImageText } : {}),
    ...(themeScope ? { themeOnly: true } : {}),
  });
  const prompt = promptFor(false);
  let compactPrompt: string | null = null;
  const promptOf = (compact: boolean) => (compact ? (compactPrompt ??= promptFor(true)) : prompt);

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
  const stage = body.stage === "execute" ? "execute" : body.stage === "plan" || (body.planFirst !== false && mode === "generate" && !(fake && (fake as { kind?: string }).kind !== "plan")) ? "plan" : null;
  let planFailures: { id: string; failure: TurnFailure }[] = [];
  let planPending: string[] = [];
  let executedPlan: ChangePlan | null = null;
  /* this request's clock and what the provider told us on the way */
  const fakeProvider = aiProviderName() === "fake";
  const budgetMs = fakeProvider && Number.isFinite(Number(body.budgetMs)) && Number(body.budgetMs) > 0 ? Number(body.budgetMs) : ROUTE_BUDGET_MS;
  const deadline = startedAt + budgetMs;
  const events: ProviderEvent[] = [];
  const onEvent = (e: ProviderEvent) => { events.push(e); };
  const faults: Fault[] = fakeProvider && Array.isArray(body.faults) ? (body.faults as Fault[]).slice(0, 40) : [];
  /** the test seam: a scripted fault or delay in front of a model call (nothing, outside the fake provider) */
  const model = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const f = faults.shift();
    if (f?.delayMs) await sleepMs(Math.min(5000, f.delayMs));
    if (f?.kind) throw new ProviderError({ kind: f.kind, status: f.status, retryAfterMs: f.retryAfterMs, detail: "scripted", host: "fake", exhausted: true });
    return fn();
  };
  /** one provider call, once: a request that repeats an identical call still running (a double click, a refresh while the first is in flight) shares it instead of paying for a second */
  const shared = <T,>(label: string, text: string, fn: () => Promise<T>): Promise<T> =>
    fakeProvider ? fn() : flights(`${user?.userId ?? "sandbox"}|${surveyId}|${aiIdentity()}|${label}|${createHash("sha256").update(text).digest("hex")}`, fn as () => Promise<unknown>) as Promise<T>;
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
    const failure = isAiReplyError(e) ? failureFromReplyError(e.code, e.detail) : failureFromError(isProviderError(e) ? e : (e as Error)?.message ?? "", { own: ownProvider });
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
    const planPrompt = prompt + planStagePrompt();
    try {
      const pb = outputBudget("plan");
      const m = await meteredAi(meter, ctx, "AI_REQUEST", { ...consent, estimateText: COPILOT_SYSTEM_PROMPT + planPrompt, maxTokens: pb.expectedTokens, operation: "copilot_plan" },
        () => fitting((c) => shared("plan", promptOf(c) + planStagePrompt(), () => model(() => completeJson(COPILOT_SYSTEM_PROMPT, promptOf(c) + planStagePrompt(), pb.maxTokens, { timeoutMs: pb.timeoutMs, deadline, schema: CHANGE_PLAN_SCHEMA, continuations: pb.continuations, operation: "copilot_plan", onEvent })))));
      if (!m.ok) {
        const r = refusalResponse(m);
        const body = await r.json().catch(() => ({})) as Record<string, unknown>;
        return NextResponse.json({ ...body, failure: failureOf(body) }, { status: r.status });
      }
      charge += m.event?.customerCharge ?? 0;
      const plan = coerceChangePlan(fake ?? m.value);
      if (plan) return NextResponse.json({ ok: true, stage: "plan", plan, context: { mode, researchUsed: !!research, passages: passageIds, promptChars: planPrompt.length, cached: false, provider: providerNote(events) }, usage: { charge } });
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
    /* mergeable: built earlier and not yet in a proposal; the rest of `prior` is context for the next item's prompt */
    const built: { item: typeof approved[number]; raw: unknown }[] = approved.filter((it) => prior.has(it.id) && !prior.get(it.id)!.applied).map((item) => ({ item, raw: prior.get(item.id)!.raw }));
    const newlyBuilt: { id: string; raw: unknown }[] = [];
    const done: string[] = plan.items.filter((it) => prior.has(it.id)).map((it) => builtLine(it, prior.get(it.id)!.raw));
    let waiting: { retryAfterMs: number; failure: TurnFailure } | null = null;
    let halted: TurnFailure | null = null;
    const ib = outputBudget("item");
    const itemDeadline = deadline - GATE_RESERVE_MS;
    let slowest = 0;
    if (!finalize) for (let i = 0; i < approved.length; i++) {
      const item = approved[i];
      if (prior.has(item.id) && !prior.get(item.id)!.applied) continue;
      /* not enough of this request's time left for another item: it, and the rest, are pending — handed back, not lost */
      if (newlyBuilt.length && itemDeadline - Date.now() < Math.max(MIN_ITEM_MS, slowest * 1.5)) break;
      const itemPrompt = prompt + executeItemPrompt(plan, item, i, approved, done);
      const t0 = Date.now();
      try {
        const m = await meteredAi(meter, ctx, "AI_REQUEST", { ...consent, estimateText: COPILOT_SYSTEM_PROMPT + itemPrompt, maxTokens: ib.expectedTokens, operation: `copilot_${mode}_item` },
          () => fitting((c) => { const p = promptOf(c) + executeItemPrompt(plan, item, i, approved, c ? done.slice(-12) : done); return shared(`item:${item.id}`, p, () => model(() => completeJson(COPILOT_SYSTEM_PROMPT, p, ib.maxTokens, { timeoutMs: ib.timeoutMs, deadline: itemDeadline, schema: COPILOT_REPLY_SCHEMA, continuations: ib.continuations, operation: `copilot_${mode}_item`, onEvent }))); }));
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
        slowest = Math.max(slowest, Date.now() - t0);
        done.push(builtLine(item, itemRaw));
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
      /* a checkpoint: what was built in this request, what is still to do, why it stopped — the browser stores it and carries on */
      return NextResponse.json({
        ok: true, stage: "progress", built: newlyBuilt, builtIds: built.map((b) => b.item.id), pending: planPending, failed: planFailures,
        ...(waiting ? { waiting: { retryAfterMs: waiting.retryAfterMs, failure: { ...waiting.failure, retryAfterMs: waiting.retryAfterMs || undefined } } } : {}),
        ...(halted ? { halted } : {}),
        context: { mode, promptChars: prompt.length, cached: false, provider: providerNote(events), elapsedMs: Date.now() - startedAt, ...(capacityNotice() ? { notice: capacityNotice() } : {}) },
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
      const m = await meteredAi(meter, ctx, "AI_REQUEST", { ...consent, estimateText: COPILOT_SYSTEM_PROMPT + prompt, maxTokens: budget.expectedTokens, operation: `copilot_${mode}` },
        () => fitting((c) => shared("turn", promptOf(c), () => model(() => completeJson(COPILOT_SYSTEM_PROMPT, promptOf(c), maxTokens, { timeoutMs: budget.timeoutMs, deadline, schema: COPILOT_REPLY_SCHEMA, continuations: budget.continuations, operation: `copilot_${mode}`, onEvent })))));
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
  const coerced = coerceCopilotReply(raw);
  let reply = coerced && themeImageUrl ? { ...coerced, actions: withThemeImage(coerced.actions, themeImageUrl) } : coerced;
  if (!reply) {
    const failure = aiProviderName() === "fake"
      ? describeFailure("unusable", "The FAKE provider cannot reason about surveys; configure a real model to use the copilot.")
      : describeFailure("unusable");
    return NextResponse.json({ ok: true, reply: null, message: failure.message, failure, context: { mode, researchUsed: !!research, passages: passageIds, promptChars: prompt.length, cached }, usage: { charge }, ...(deterministic ? { review: deterministic } : {}) });
  }
  // a look-only request cannot change the structure: the engine refuses structural actions and proves the rest left it alone
  let applied = reply.actions.length ? applySurveyActions(def, reply.actions, { uxOnly: cls.uxOnly }) : null;
  /*
   * ONE REPAIR. The model sometimes proposes something the Studio refuses — a
   * script reaching for the page, an event that does not exist, an option that
   * is not there. Rather than offer a proposal whose Apply can do nothing, the
   * refusals go back to the model once, with its answer, and it corrects
   * them. The corrected answer is used only if the Studio accepts more of it.
   */
  let repair: { refused: string[]; fixed: boolean } | undefined;
  // the failed actions, each "what it was: why" — the first entries of errors, in order
  const refused = applied ? applied.errors.slice(0, applied.results.filter((x) => !x.ok).length) : [];
  if (applied && refused.length && !cached && !executedPlan && deadline - Date.now() > MIN_ITEM_MS && (aiProviderName() !== "fake" || fakes.length > 1)) {
    const repairPrompt = `${prompt}\n\nYOUR PREVIOUS ANSWER:\n${JSON.stringify(raw).slice(0, 14_000)}\n\nTHE STUDIO REFUSED ${refused.length} OF ITS ${reply.actions.length} ACTIONS:\n${refused.map((e) => `- ${e}`).join("\n")}\n\nAnswer again in the same JSON shape. Keep the accepted actions as they were; correct each refused action using only the actions, events and rs api described above, or drop it and say plainly in "reply" what the Studio cannot do. Do not mention the refusal to the user unless something could not be done.`;
    try {
      const rb = outputBudget("repair");
      const m = await meteredAi(meter, ctx, "AI_REQUEST", { ...consent, estimateText: COPILOT_SYSTEM_PROMPT + repairPrompt, maxTokens: rb.expectedTokens, operation: `copilot_${mode}_repair` },
        () => model(() => completeJson(COPILOT_SYSTEM_PROMPT, repairPrompt, rb.maxTokens, replyCallOptions({ timeoutMs: rb.timeoutMs, deadline, continuations: rb.continuations, operation: `copilot_${mode}_repair`, onEvent }))));
      if (m.ok) {
        charge += m.event?.customerCharge ?? 0;
        const raw2 = fakes[1] ?? m.value;
        const c2 = coerceCopilotReply(raw2);
        const r2 = c2 && themeImageUrl ? { ...c2, actions: withThemeImage(c2.actions, themeImageUrl) } : c2;
        const a2 = r2 && r2.actions.length ? applySurveyActions(def, r2.actions, { uxOnly: cls.uxOnly }) : null;
        const okCount = (a: typeof applied) => (a ? a.results.filter((x) => x.ok).length - a.results.filter((x) => !x.ok).length : -Infinity);
        if (r2 && (okCount(a2) > okCount(applied) || (!a2 && !applied.results.some((x) => x.ok)))) {
          reply = r2; applied = a2;
          if (!fakes.length) { CACHE.set(key, { at: Date.now(), value: raw2 }); }
          repair = { refused, fixed: !a2 || a2.results.every((x) => x.ok) };
        } else repair = { refused, fixed: false };
      }
    } catch (e) {
      console.warn("[rescript:copilot] repair failed", JSON.stringify({ error: (e as Error).message }));
    }
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
    if (!coverage.ok && !cached && !partialBuild && deadline - Date.now() > MIN_ITEM_MS && (aiProviderName() !== "fake" || nextFake)) {
      const coveragePrompt = `${prompt}\n\nYOUR PREVIOUS ANSWER:\n${JSON.stringify(executedPlan ? raw : raw).slice(0, 14_000)}\n\nTHE STUDIO CHECKED THE RESEARCH COVERAGE OF THAT ANSWER: ${coverage.summary}.\n\nAnswer again in the same JSON shape with the SAME actions, plus what connects the loose ends: set_question_analysis tags (hypotheses) on the questions that measure each unmeasured hypothesis, constructs in set_research that name the measuring questions, a question for a hypothesis none measures, and a tag or construct for each unconnected question — or remove a question that serves nothing. Every hypothesis must be measured and every question must serve one, a construct, the plan or a KPI (screeners and demographics are exempt).`;
      try {
        const cb = outputBudget("coverage");
        const m = await meteredAi(meter, ctx, "AI_REQUEST", { ...consent, estimateText: COPILOT_SYSTEM_PROMPT + coveragePrompt, maxTokens: cb.expectedTokens, operation: `copilot_${mode}_coverage` },
          () => model(() => completeJson(COPILOT_SYSTEM_PROMPT, coveragePrompt, cb.maxTokens, { timeoutMs: cb.timeoutMs, deadline, schema: COPILOT_REPLY_SCHEMA, continuations: cb.continuations, operation: `copilot_${mode}_coverage`, onEvent })));
        if (m.ok) {
          charge += m.event?.customerCharge ?? 0;
          const raw3 = nextFake ?? m.value;
          const c3 = coerceCopilotReply(raw3);
          const r3 = c3 && themeImageUrl ? { ...c3, actions: withThemeImage(c3.actions, themeImageUrl) } : c3;
          const a3 = r3 && r3.actions.length ? applySurveyActions(def, r3.actions, { uxOnly: cls.uxOnly }) : null;
          if (r3 && a3?.valid) {
            const cov3 = coverageReport(a3.def);
            const better = cov3.ok || cov3.unmeasured.length + cov3.unconnected.length < coverage.unmeasured.length + coverage.unconnected.length;
            if (better && a3.results.filter((x) => x.ok).length >= applied.results.filter((x) => x.ok).length) { reply = r3; applied = a3; coverage = { ...cov3, summary: `${cov3.summary} (connected on a second pass)` }; }
          }
        }
      } catch (e) {
        console.warn("[rescript:copilot] coverage pass failed", JSON.stringify({ error: (e as Error).message }));
      }
    }
  }
  const diff = applied?.valid ? diffSurveys(def, applied.def) : null;
  const passages = passageIds.length || reply.sources.length ? await describePassages(store, surveyId, docs, [...passageIds, ...reply.sources.flatMap((x) => x.passages)]) : {};
  // a citation to a passage that does not exist is not a citation: dropped, and a "document" claim with none left is only a recommendation
  for (const src of reply.sources) {
    src.passages = src.passages.filter((p) => passages[p]);
    if (src.support === "document" && !src.passages.length) src.support = "recommendation";
  }
  return NextResponse.json({
    ok: true, reply,
    ...(executedPlan ? { stage: "executed", plan: executedPlan, ...(planFailures.length ? { planFailures } : {}), ...(planPending.length ? { planPending, partial: true } : {}) } : {}),
    ...(coverage ? { coverage: { ok: coverage.ok, summary: coverage.summary, unmeasured: coverage.unmeasured, unconnected: coverage.unconnected.map((q) => String(q.code)), hypotheses: coverage.hypotheses } } : {}),
    validation: applied ? { valid: applied.valid, results: applied.results, errors: applied.errors, destructive: applied.destructive, warnings: applied.warnings, summary: diff?.summary ?? [], diff, uxOnly: applied.uxOnly, structureUnchanged: applied.structureUnchanged } : null,
    ...(deterministic ? { review: deterministic } : {}),
    passages,
    context: { mode, researchUsed: !!research, passages: passageIds, promptChars: prompt.length, outlineChars: outline.length, cached, ux: uxTurn, uxOnly: cls.uxOnly, analysis: analysisTurn, translation: translationTurn, quota: quotaTurn, findings: findingsTurn, hasRun: !!analysisRun, provider: providerNote(events), ...(capacityNotice() ? { notice: capacityNotice() } : {}), ...(repair ? { repair } : {}) },
    usage: { charge },
  });
}

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
