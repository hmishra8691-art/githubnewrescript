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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/help/ask { message, conversationId?, surveyId?, context?, history? } — ONE HELP ANSWER (2026-11-09).
 *
 *   1. retrieve: the knowledge base (guides, docs, generated facts) is searched with the question, the conversation's
 *      topic carried into a follow-up;
 *   2. billing questions get the live billing configuration's customer-facing rules (and, in a project, its wallet);
 *   3. with a model available and a project to bill (`surveyId`, `project.read`): the model writes the answer from the
 *      sources, metered as one AI request on that project ("help_answer"; free on the user's own provider). A refusal
 *      (empty wallet, AI off) falls back to the guides' own answer and says why;
 *   4. without one: the guides' own answer, labelled;
 *   5. the turn is saved to the user's conversation (migration 0094); without it, nothing is stored and the browser keeps
 *      the conversation for the session.
 *
 * `context` is the user's own open survey as their browser describes it; it is used only when they may read that
 * project (`surveyId`). Help never edits a survey: a "do it for me" request returns an instruction for Intelligent
 * Mode, where the change is proposed and approved.
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
  let body: { message?: unknown; conversationId?: unknown; surveyId?: unknown; context?: unknown; history?: unknown; useAi?: unknown };
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
  let history: { role: "user" | "assistant"; text: string; sources?: string[] }[] = [];
  let persisted = !!db;
  if (db && conversationId) {
    const { data: conv, error } = await db.from("help_conversations").select("id").eq("id", conversationId).eq("user_id", user!.userId).is("deleted_at", null).maybeSingle();
    if (error) { if (missingTable(error.message)) persisted = false; else return json({ error: error.message }, 500); }
    else if (!conv) conversationId = null;
    else {
      const { data: msgs } = await db.from("help_messages").select("role, content").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(10);
      history = (msgs ?? []).reverse().map((m) => ({ role: m.role as "user" | "assistant", text: String((m.content as { text?: string; answer?: string }).text ?? (m.content as { answer?: string }).answer ?? ""), sources: ((m.content as { sources?: { id: string }[] }).sources ?? []).map((s) => s.id.split("#")[0]) }));
    }
  }
  if (!history.length && Array.isArray(body.history)) {
    history = (body.history as unknown[]).slice(-10).map((h) => { const x = h as { role?: unknown; text?: unknown; sources?: unknown }; return { role: x.role === "assistant" ? "assistant" as const : "user" as const, text: str(x.text, 2000), sources: Array.isArray(x.sources) ? x.sources.filter((s): s is string => typeof s === "string").map((s) => s.split("#")[0]).slice(0, 6) : [] }; }).filter((h) => h.text);
  }

  /* retrieval */
  const { index, articles } = helpKnowledge();
  const mode = helpMode(message);
  const topic = [...history].reverse().find((h) => h.role === "assistant")?.sources ?? [];
  const followUp = topic.length > 0 && isFollowUp(message);
  const near = [...new Set(topic.flatMap((id) => articles.get(id)?.related ?? []))];
  const hits = search(index, message, { limit: 12, topic, near, followUp, ...categoryFor(mode, message) });
  const top = topArticles(hits, 3);
  /* a follow-up is a new aspect: don't hand back the guide just given when a related one fits nearly as well */
  if (followUp && top.length > 1 && top[0].article === topic[0] && top[1].score >= top[0].score * 0.5) top.push(top.shift()!);
  const clarify = followUp ? null : clarificationFor(message);
  const best = top[0] && (!clarify || top[0].score > 0) ? index.chunks.filter((c) => c.article === top[0].article) : null;
  const related = best ? (articles.get(best[0].article)?.related ?? []).map((id) => articles.get(id)).filter((a): a is NonNullable<typeof a> => !!a) : [];
  const instruction = mode === "do" ? intelligentInstruction(message) : null;

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

  /* the model writes the answer when it can, billed to the project */
  let answer: HelpAnswer | null = null;
  let note: string | null = null;
  let charge = 0;
  const chunks = [...(best ?? []), ...hits.map((h) => h.chunk).filter((c) => !best?.includes(c))].slice(0, 10);
  const wantsAi = body.useAi !== false;
  const modelAvailable = aiProviderName() !== null && aiProviderName() !== "fake";
  if (wantsAi && modelAvailable && user && surveyId && surveyId !== "sandbox" && (await aiReadyFor(user, surveyId, "help_answer").catch(() => false))) {
    const billing = await billingProjectFor(user, surveyId, "project.read");
    if ("response" in billing) return billing.response;
    const prompt = helpPrompt({ question: message, mode, chunks, history, context: contextText(context), billingFacts: facts });
    try {
      const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: HELP_RULES + prompt, maxTokens: 1800, operation: "help_answer" }, () => completeJson(HELP_RULES, prompt, 1800, { schema: { name: "help_answer", schema: HELP_SCHEMA }, timeoutMs: 60_000, retries: 1 }));
      if (m.ok) {
        answer = readModelAnswer(m.value, { mode, chunks, instruction });
        charge = Number((m as { event?: { customerCharge?: number } }).event?.customerCharge ?? 0) || 0;
        if (!answer) note = "The AI's answer could not be used, so this one is from the guides.";
      } else note = `No AI answer: ${(m as { message?: string }).message ?? "AI is not available for this project"}. This answer is from the guides.`;
    } catch (e) {
      console.warn("[rescript:help] model call failed", JSON.stringify({ error: (e as Error).message.slice(0, 200) }));
      note = "The AI could not answer just now, so this answer is from the guides.";
    }
  } else if (wantsAi && modelAvailable && user && !surveyId) {
    note = "Answered from the guides. Choose a project to bill AI answers to for a written, conversational answer.";
  }
  if (!answer) {
    answer = guidesAnswer({ mode, question: message, article: best, others: related.map((a) => ({ title: a.title, ask: a.title })), clarify, billingFacts: facts, instruction });
  }
  if (note) answer.note = answer.note ? `${answer.note} ${note}` : note;

  /* save the turn to the user's own conversation */
  if (db && persisted) {
    try {
      if (!conversationId) {
        const { data, error } = await db.from("help_conversations").insert({ user_id: user!.userId, customer_id: user!.customerId ?? null, survey_id: surveyId && surveyId !== "sandbox" ? surveyId : null, title: message.slice(0, 120) }).select("id").single();
        if (error) throw error;
        conversationId = data.id;
      }
      const { error: e2 } = await db.from("help_messages").insert([
        { conversation_id: conversationId, role: "user", content: { text: message } },
        { conversation_id: conversationId, role: "assistant", content: { ...answer, charge } },
      ]);
      if (e2) throw e2;
      await db.from("help_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId).eq("user_id", user!.userId);
    } catch (e) {
      if (!missingTable((e as { message?: string }).message)) console.warn("[rescript:help] could not save the turn", (e as Error).message?.slice(0, 200));
      persisted = false;
      if (!missingTable((e as { message?: string }).message)) conversationId = null;
    }
  }
  return json({ ok: true, conversationId: persisted ? conversationId : null, persisted, answer, usage: { charge } });
}
