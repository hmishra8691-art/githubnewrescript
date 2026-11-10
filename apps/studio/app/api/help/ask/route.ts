import { NextRequest, NextResponse } from "next/server";
import { aiProviderName, completeJson } from "@rescript/ai";
import { isFailure, requireProjectFor, requireUser, type AuthedUser } from "@/lib/guard";
import { supabaseAdmin } from "@/lib/admin";
import { dbConfigured } from "@/lib/copilot/durable";
import { aiReadyFor } from "@/lib/byok/connect";
import { billingProjectFor, getMeter, meteredAi, projectLookup } from "@/lib/metering";
import { helpKnowledge } from "@/lib/help/kb";
import { categoryFor, isFollowUp, search, topArticles } from "@/lib/help/search";
import { clarificationFor, helpMode, intelligentInstruction } from "@/lib/help/intent";
import { contextText, guidesAnswer, helpPrompt, readModelAnswer, HELP_RULES, HELP_SCHEMA, type HelpAnswer, type HelpContext } from "@/lib/help/compose";
import { billingFacts } from "@/lib/help/billingFacts";
import { safeParseSurvey, type SurveyDefinition } from "@rescript/schema";
import { tokenize } from "@/lib/help/search";
import { retrievalConfidence } from "@/lib/help/confidence";
import { problemThread, wantsHuman } from "@/lib/help/attempts";
import { diagnoseSurvey, diagnosisText, featureFor, type SurveyDiagnosis } from "@/lib/help/diagnostics";
import { cacheGet, cacheKey, cachePut } from "@/lib/help/cache";
import { routeHelp } from "@/lib/help/levels";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/help/ask { message, conversationId?, surveyId?, context?, definition?, history?, forceAi? } — ONE HELP
 * ANSWER, internal first (2026-11-10; the router is lib/help/levels.ts).
 *
 *   1. the conversation as a support case: is this a follow-up, a "still not working" on a problem already being
 *      worked on (then the search goes back to the problem itself and leaves out the guides already given), or a
 *      request for a person;
 *   2. retrieve from the knowledge base (guides, docs, generated facts) and score how well it covers the question;
 *   3. troubleshooting with the user's survey (the definition the Studio sends, or the project's draft): run the
 *      engine's own checks on it — verified findings, and a fix to propose in Intelligent Mode;
 *   4. route: Level 1 (the guides' own answer), Level 2 (the survey checks + the guide), Level 3 (the model) only when
 *      the guides cover the question weakly, a problem persists after the internal answers, or the user asks for AI —
 *      and only with a model and a project to bill (`surveyId`, `project.read`, AI enabled). Level 3 answers are
 *      validated (readModelAnswer: sources, no "done" claims, no prices) and cached per account;
 *   5. escalation to a person is offered when the router says so (the user asks, two failed fixes, outside the
 *      guides, low confidence without a model) — POST /api/help/escalate does it, with the user's confirmation;
 *   6. the turn is saved to the user's conversation (0094) with how it was produced (`route`), which the admin Help
 *      usage report reads.
 *
 * `context` and `definition` are the user's own open survey as their browser describes it; they are used only when the
 * user may read that project (`surveyId`). Help never edits a survey: changes go to Intelligent Mode, where they are
 * proposed and approved.
 */
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const missingTable = (m?: string) => !!m && /help_conversations|help_messages|does not exist|schema cache/i.test(m);

function readContext(raw: unknown): HelpContext | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const q = c.question as Record<string, unknown> | null | undefined;
  const sv = c.survey as Record<string, unknown> | null | undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100000, Math.round(v))) : undefined);
  return {
    surface: c.surface === "studio" ? "studio" : "platform",
    tab: str(c.tab, 40) || undefined, tabLabel: str(c.tabLabel, 60) || undefined, mode: str(c.mode, 30) || undefined,
    survey: sv ? { title: str(sv.title, 200), code: str(sv.code, 60), questions: n(sv.questions), pages: n(sv.pages), scripts: n(sv.scripts), quotas: n(sv.quotas), languages: n(sv.languages) } : null,
    question: q && typeof q.code === "string" ? {
      code: str(q.code, 60), type: str(q.type, 40), text: str(q.text, 400), page: str(q.page, 60) || null,
      displayLogic: str(q.displayLogic, 600) || null,
      skipLogic: Array.isArray(q.skipLogic) ? q.skipLogic.slice(0, 8).map((x) => str(x, 300)) : [],
      validation: Array.isArray(q.validation) ? q.validation.slice(0, 8).map((x) => str(x, 200)) : [],
    } : null,
  };
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  /* without a database (the local sandbox) Help works anonymously: guides only, nothing stored */
  if (isFailure(authed) && dbConfigured()) return authed.response;
  const user: AuthedUser | null = isFailure(authed) ? null : authed;
  let body: { message?: unknown; conversationId?: unknown; surveyId?: unknown; context?: unknown; definition?: unknown; history?: unknown; useAi?: unknown; forceAi?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const message = str(body.message, 2000);
  if (message.length < 2) return json({ error: "Ask a question." }, 400);

  /* the project: context and billing only where the user may read it */
  const surveyId = str(body.surveyId, 64) || null;
  let projectGate: Awaited<ReturnType<typeof requireProjectFor>> | null = null;
  if (surveyId && surveyId !== "sandbox") {
    if (!user) return json({ error: "Sign in to use Help in a project." }, 401);
    projectGate = await requireProjectFor(user, surveyId, "project.read");
    if (isFailure(projectGate)) return projectGate.response;
  }
  const context = surveyId ? readContext(body.context) : readContext({ surface: "platform" });

  /* the conversation so far: the user's own, from the store; otherwise what the browser sent (sandbox) */
  const db = user && dbConfigured() ? supabaseAdmin() : null;
  let conversationId = str(body.conversationId, 64) || null;
  let history: { role: "user" | "assistant"; text: string; sources?: string[]; level?: number }[] = [];
  let persisted = !!db;
  if (db && conversationId) {
    const { data: conv, error } = await db.from("help_conversations").select("id").eq("id", conversationId).eq("user_id", user!.userId).is("deleted_at", null).maybeSingle();
    if (error) { if (missingTable(error.message)) persisted = false; else return json({ error: error.message }, 500); }
    else if (!conv) conversationId = null;
    else {
      const { data: msgs } = await db.from("help_messages").select("role, content").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(10);
      history = (msgs ?? []).reverse().map((m) => ({ role: m.role as "user" | "assistant", text: String((m.content as { text?: string; answer?: string }).text ?? (m.content as { answer?: string }).answer ?? ""), sources: ((m.content as { sources?: { id: string }[] }).sources ?? []).map((s) => s.id.split("#")[0]), level: (m.content as { route?: { level?: number } }).route?.level }));
    }
  }
  if (!history.length && Array.isArray(body.history)) {
    history = (body.history as unknown[]).slice(-10).map((h) => { const x = h as { role?: unknown; text?: unknown; sources?: unknown; level?: unknown }; return { role: x.role === "assistant" ? "assistant" as const : "user" as const, text: str(x.text, 2000), sources: Array.isArray(x.sources) ? x.sources.filter((s): s is string => typeof s === "string").map((s) => s.split("#")[0]).slice(0, 6) : [], level: x.level === 1 || x.level === 2 || x.level === 3 ? x.level : undefined }; }).filter((h) => h.text);
  }

    /* the conversation as a support case */
  const thread = problemThread(message, history);
  const human = wantsHuman(message);
  /* "still blank" is about the problem it replies to: search and check that, not the three words */
  const asked = thread.origin ? `${thread.origin} — ${message}` : message;

  /* retrieval */
  const { index, articles } = helpKnowledge();
  const mode = helpMode(asked);
  const topic = [...history].reverse().find((h) => h.role === "assistant")?.sources ?? [];
  const followUp = !thread.origin && topic.length > 0 && isFollowUp(message);
  const near = [...new Set(topic.flatMap((id) => articles.get(id)?.related ?? []))];
  const hits = search(index, asked, { limit: 16, topic: thread.origin ? [] : topic, near, followUp, ...categoryFor(mode, asked) });
  let top = topArticles(hits, 4);
  /* a follow-up is a new aspect: don't hand back the guide just given when a related one fits nearly as well */
  if (followUp && top.length > 1 && top[0].article === topic[0] && top[1].score >= top[0].score * 0.5) top.push(top.shift()!);
  /* a fix that didn't work is not offered again while something else fits */
  if (thread.tried.length) {
    const fresh = top.filter((t) => !thread.tried.includes(t.article) && t.score >= (top[0]?.score ?? 0) * 0.25);
    if (fresh.length) top = [...fresh, ...top.filter((t) => !fresh.includes(t))];
  }
  /* a retry is scored on the problem it is about — "it's still happening" adds no meaning, only unknown words */
  const confidence = retrievalConfidence(index, thread.origin ?? message, top[0]);
  const clarify = followUp || thread.origin || human ? null : clarificationFor(message);
  const inDomain = confidence.domain === "in";
  const best = top[0] && inDomain && (!clarify || top[0].score > 0) ? index.chunks.filter((c) => c.article === top[0].article) : null;
  const related = best ? (articles.get(best[0].article)?.related ?? []).map((id) => articles.get(id)).filter((a): a is NonNullable<typeof a> => !!a) : [];
  const instruction = mode === "do" ? intelligentInstruction(message) : null;

  /* Level 2: the user's own survey, checked by the engine */
  let diagnosis: SurveyDiagnosis | null = null;
  if (surveyId && !human && mode !== "do" && mode !== "billing" && featureFor(asked)) {
    const def = await surveyDefinition(body.definition, surveyId, db);
    if (def) {
      try { diagnosis = diagnoseSurvey(def, asked, context?.question?.code ?? null); }
      catch (e) { console.warn("[rescript:help] survey check failed", (e as Error).message.slice(0, 200)); }
    }
  }

  /* billing facts from the live configuration (never prices) */
  let facts: string | null = null;
  if (mode === "billing" || top[0]?.article === "wallet" || top[0]?.article === "billing-test-vs-live") {
    try {
      const meter = getMeter();
      const [cfg, events] = await Promise.all([meter.config(), meter.events()]);
      let wallet: { balance: number; reserved: number; state: string; level?: string } | null = null;
      if (projectGate && !isFailure(projectGate)) { const w = await meter.walletFor(projectLookup(projectGate), false).catch(() => null); if (w) wallet = { balance: w.balance, reserved: w.reserved, state: w.state }; }
      facts = billingFacts(cfg, events, wallet);
    } catch { facts = null; }
  }

  /* route */
  const modelConfigured = aiProviderName() !== null && aiProviderName() !== "fake";
  const modelPossible = body.useAi !== false && modelConfigured && !!user && !!surveyId && surveyId !== "sandbox";
  const routeInput = { mode, confidence, clarifying: !!clarify, diagnosis, thread, wantsHuman: human, forceAi: body.forceAi === true, modelAllowed: modelPossible, substantive: tokenize(message).length >= 3 || !!thread.origin };
  let route = routeHelp(routeInput);
  if (route.level === 3 && !(await aiReadyFor(user!, surveyId!, "help_answer").catch(() => false))) route = routeHelp({ ...routeInput, modelAllowed: false });

  let answer: HelpAnswer | null = null;
  let note: string | null = null;
  let charge = 0;
  let cached = false;
  let modelUsed = false;
  const chunks = [...(best ?? []), ...hits.map((h) => h.chunk).filter((c) => !best?.includes(c))].slice(0, 10);
  const diagText = diagnosis ? diagnosisText(diagnosis) : null;

  /* Level 3: the model, from the same sources and context — validated, and cached per account */
  if (route.level === 3) {
    const modelChunks = top[0] && !inDomain ? hits.map((h) => h.chunk).slice(0, 10) : chunks;
    const ctx = [contextText(context), diagText ?? "", thread.origin ? `ALREADY TRIED (did not fix it): ${thread.failedAttempts} answer(s) — from ${thread.tried.join(", ") || "the guides"}${thread.levels.includes(2) ? " and the survey checks" : ""}. Do not repeat those steps; look for other causes.` : ""].filter(Boolean).join("\n\n");
    const key = !history.length ? cacheKey({ scope: user!.customerId ?? user!.userId, question: message, mode, sources: modelChunks.map((c) => c.id), context: ctx }) : null;
    const hit = key ? cacheGet<HelpAnswer>(key) : null;
    if (hit) { answer = structuredClone(hit); cached = true; modelUsed = true; }
    else {
      const billing = await billingProjectFor(user!, surveyId!, "project.read");
      if ("response" in billing) return billing.response;
      const prompt = helpPrompt({ question: thread.origin ? asked : message, mode, chunks: modelChunks, history, context: ctx, billingFacts: facts });
      try {
        const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: HELP_RULES + prompt, maxTokens: 1800, operation: "help_answer" }, () => completeJson(HELP_RULES, prompt, 1800, { schema: { name: "help_answer", schema: HELP_SCHEMA }, timeoutMs: 60_000, retries: 1 }));
        if (m.ok) {
          answer = readModelAnswer(m.value, { mode, chunks: modelChunks, instruction });
          charge = Number((m as { event?: { customerCharge?: number } }).event?.customerCharge ?? 0) || 0;
          modelUsed = true;
          if (!answer) note = "The AI's answer could not be used, so this one is from the guides.";
          else if (key && !answer.note) cachePut(key, answer);
        } else note = `No AI answer: ${(m as { message?: string }).message ?? "AI is not available for this project"}. This answer is from the guides.`;
      } catch (e) {
        console.warn("[rescript:help] model call failed", JSON.stringify({ error: (e as Error).message.slice(0, 200) }));
        note = "The AI could not answer just now, so this answer is from the guides.";
      }
    }
    if (!answer) route = { ...route, level: diagnosis ? 2 : 1, reason: `${route.reason} — but the AI answer was not available` };
  }

  /* Levels 1 and 2: the knowledge base and the survey checks, no model */
  if (!answer && human) {
    answer = { mode, answer: "I can hand this conversation to the ResLens.ai support team, together with what has been tried so far and what the survey checks found. Review what will be shared and send it below — nothing is sent until you do.", sources: [], followUps: [], clarify: null, intelligent: null, origin: "guides", note: null };
  }
  if (!answer) {
    answer = guidesAnswer({ mode, question: message, article: best, others: (best ? related : top.map((t) => articles.get(t.article)).filter((a): a is NonNullable<typeof a> => !!a)).map((a) => ({ title: a.title, ask: a.title })), clarify, billingFacts: facts, instruction, contextNote: diagText });
    if (!inDomain && !clarify && mode !== "billing" && mode !== "do") {
      answer.answer = `${diagText ? `${diagText}\n\n` : ""}This isn't covered by the ResLens.ai guides, so I won't guess at it.${confidence.unknown.length ? ` (Nothing in the guides mentions ${confidence.unknown.slice(0, 3).map((w) => `“${w}”`).join(", ")}.)` : ""} If it's about a feature, try describing what you want respondents to see or what should happen — or hand it to the support team.`;
      if (answer.followUps.length) answer.answer += " The closest topics are below.";
    }
    if (thread.origin && route.level !== 3) answer.answer = `Since the earlier steps didn't fix it, here's what else to check.\n\n${answer.answer}`;
  }
  if (diagnosis?.fix && !answer.intelligent) answer.intelligent = { instruction: diagnosis.fix };
  if (note) answer.note = answer.note ? `${answer.note} ${note}` : note;
  if (route.level === 1 && confidence.level === "low" && inDomain && !modelPossible && modelConfigured && !surveyId) {
    answer.note = `${answer.note ? `${answer.note} ` : ""}The guides cover this only partly. Choose a project to bill AI answers to for a written answer.`;
  }
  answer.route = { level: route.level, reason: route.reason, confidence: confidence.score, confidenceLevel: confidence.level, cached, modelUsed: modelUsed && !cached, ...(thread.origin ? { attempt: thread.failedAttempts } : {}) };
  answer.diagnosis = diagnosis ? { feature: diagnosis.feature, target: diagnosis.target?.code ?? null, ...(diagnosis.verdict ? { verdict: diagnosis.verdict } : {}), summary: diagnosis.summary, findings: diagnosis.findings } : null;
  answer.escalate = route.escalate.offer ? route.escalate : null;
  console.info("[rescript:help] answer", JSON.stringify({ level: route.level, mode, confidence: confidence.score, cached, model: modelUsed && !cached, escalate: route.escalate.offer, diagnosed: !!diagnosis }));

  /* save the turn to the user's own conversation */
  let messageId: string | null = null;
  if (db && persisted) {
    try {
      if (!conversationId) {
        const { data, error } = await db.from("help_conversations").insert({ user_id: user!.userId, customer_id: user!.customerId ?? null, survey_id: surveyId && surveyId !== "sandbox" ? surveyId : null, title: message.slice(0, 120) }).select("id").single();
        if (error) throw error;
        conversationId = data.id;
      }
      const { data: rows, error: e2 } = await db.from("help_messages").insert([
        { conversation_id: conversationId, role: "user", content: { text: message } },
        { conversation_id: conversationId, role: "assistant", content: { ...answer, charge } },
      ]).select("id, role");
      if (e2) throw e2;
      messageId = (rows ?? []).find((r) => r.role === "assistant")?.id ?? null;
      await db.from("help_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId).eq("user_id", user!.userId);
    } catch (e) {
      if (!missingTable((e as { message?: string }).message)) console.warn("[rescript:help] could not save the turn", (e as Error).message?.slice(0, 200));
      persisted = false;
      if (!missingTable((e as { message?: string }).message)) conversationId = null;
    }
  }
  return json({ ok: true, conversationId: persisted ? conversationId : null, messageId, persisted, answer, usage: { charge } });
}

const MAX_DEFINITION = 4_000_000;
/**
 * The survey to check: what the Studio sent (the user's open survey, unsaved edits included), else the project's saved
 * draft. Called only after the user's read access to `surveyId` is established (or in the sandbox).
 */
async function surveyDefinition(raw: unknown, surveyId: string, db: ReturnType<typeof supabaseAdmin> | null): Promise<SurveyDefinition | null> {
  let src: unknown = raw && typeof raw === "object" ? raw : null;
  if (src && JSON.stringify(src).length > MAX_DEFINITION) src = null;
  if (!src && db && surveyId !== "sandbox") {
    const { data } = await db.from("surveys").select("draft_definition, definition").eq("id", surveyId).maybeSingle();
    src = (data as { draft_definition?: unknown; definition?: unknown } | null)?.draft_definition ?? (data as { definition?: unknown } | null)?.definition ?? null;
  }
  if (!src) return null;
  const parsed = safeParseSurvey(src);
  return parsed.success ? parsed.data : null;
}
