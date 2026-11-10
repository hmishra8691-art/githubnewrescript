import { NextRequest, NextResponse } from "next/server";
import { audit, isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseAdmin } from "@/lib/admin";
import { dbConfigured } from "@/lib/copilot/durable";
import { mailConfig, sendMail } from "@/lib/mail";
import { draftTicket, sharedSummary, ticketReference, ticketText, type StoredTurn } from "@/lib/help/escalation";

export const dynamic = "force-dynamic";

/**
 * HAND A HELP CONVERSATION TO THE SUPPORT TEAM (2026-11-10, migration 0095).
 *
 *   GET  ?conversationId=…            what WOULD be shared (the list the user confirms) and whether support is set up
 *   POST { conversationId?, surveyId?, message?, reason?, context?, transcript? }
 *        creates the ticket for the caller: the conversation (their own, from the store — or, where conversations are
 *        not stored, the turns their browser sends), the steps tried, the latest survey check and where they were.
 *        Stored in support_tickets and, when mail is configured and SUPPORT_EMAIL is set, e-mailed to the support
 *        address with the user's e-mail as reply-to. Returns the reference.
 *
 * Only on the user's confirmation (the UI shows the GET list first). Without a table and without a support address
 * there is nowhere to send it: the answer says so plainly rather than pretending a ticket exists.
 */
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const missing = (m?: string) => !!m && /support_tickets|help_conversations|help_messages|does not exist|schema cache/i.test(m);
const supportAddress = () => (process.env.SUPPORT_EMAIL ?? "").trim() || null;

async function conversationTurns(db: ReturnType<typeof supabaseAdmin>, userId: string, conversationId: string): Promise<{ turns: StoredTurn[]; surveyId: string | null } | null> {
  const { data: conv, error } = await db.from("help_conversations").select("id, survey_id").eq("id", conversationId).eq("user_id", userId).is("deleted_at", null).maybeSingle();
  if (error || !conv) return null;
  const { data } = await db.from("help_messages").select("role, content").eq("conversation_id", conversationId).order("created_at").limit(80);
  return { turns: (data ?? []) as StoredTurn[], surveyId: conv.survey_id ?? null };
}

function browserTurns(raw: unknown): StoredTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-40).map((x) => {
    const t = (x ?? {}) as { role?: unknown; text?: unknown; answer?: unknown };
    if (t.role === "assistant") {
      const a = (t.answer ?? {}) as Record<string, unknown>;
      return { role: "assistant" as const, content: { answer: str(a.answer, 4000), sources: Array.isArray(a.sources) ? a.sources.slice(0, 6) : [], route: a.route ?? null, diagnosis: a.diagnosis ?? null } };
    }
    return { role: "user" as const, content: { text: str(t.text, 2000) } };
  }).filter((t) => (t.role === "user" ? t.content.text : t.content.answer));
}

function readContext(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const pick = (o: unknown, keys: string[]) => o && typeof o === "object" ? Object.fromEntries(keys.filter((k) => (o as Record<string, unknown>)[k] !== undefined).map((k) => [k, String((o as Record<string, unknown>)[k]).slice(0, 300)])) : null;
  return { surface: str(c.surface, 20), tab: str(c.tab, 40), mode: str(c.mode, 30), survey: pick(c.survey, ["title", "code", "questions", "pages", "scripts", "quotas", "languages"]), question: pick(c.question, ["code", "type", "text", "displayLogic"]) };
}

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user) && dbConfigured()) return user.response;
  const cfg = mailConfig();
  const available = dbConfigured() || (cfg.configured && !!supportAddress());
  let turns = 0, attempts = 0, hasDiagnostics = false;
  const id = req.nextUrl.searchParams.get("conversationId");
  if (!isFailure(user) && dbConfigured() && id && /^[0-9a-f-]{36}$/i.test(id)) {
    const c = await conversationTurns(supabaseAdmin(), user.userId, id);
    if (c) { const d = draftTicket(c.turns); turns = d.transcript.length; attempts = d.attempts.length; hasDiagnostics = !!d.diagnostics; }
  }
  return json({ ok: true, available, ...(available ? {} : { note: "Support hand-off isn't set up on this installation: there is no database to keep tickets in and no support e-mail address (SUPPORT_EMAIL) to send them to." }), shared: turns ? sharedSummary({ turns, attempts, hasDiagnostics, hasContext: true }) : null });
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) {
    if (dbConfigured()) return user.response;
    return json({ error: "Support hand-off isn't set up on this installation: there is no database to keep tickets in and you are not signed in.", code: "not_configured" }, 501);
  }
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const db = dbConfigured() ? supabaseAdmin() : null;
  const conversationId = str(body.conversationId, 64) || null;
  let turns: StoredTurn[] = [];
  let surveyId: string | null = str(body.surveyId, 64) || null;
  if (db && conversationId && /^[0-9a-f-]{36}$/i.test(conversationId)) {
    const c = await conversationTurns(db, user.userId, conversationId);
    if (!c) return json({ error: "No such conversation." }, 404);
    turns = c.turns;
    surveyId = surveyId ?? c.surveyId;
  }
  if (!turns.length) turns = browserTurns(body.transcript);
  if (!turns.length) return json({ error: "There is no conversation to hand over yet — ask your question first." }, 400);
  if (surveyId === "sandbox") surveyId = null;
  if (surveyId) {
    const gate = await requireProjectFor(user, surveyId, "project.read");
    if (isFailure(gate)) return gate.response;
  }

  const draft = draftTicket(turns, { reason: str(body.reason, 200) || null });
  const reference = ticketReference();
  const message = str(body.message, 4000) || null;
  const context = readContext(body.context);
  const row = {
    reference, user_id: user.userId, customer_id: user.customerId ?? null, user_email: user.email || null,
    survey_id: surveyId, conversation_id: db && conversationId ? conversationId : null,
    subject: draft.subject, reason: draft.reason, message, transcript: draft.transcript, diagnostics: draft.diagnostics, attempts: draft.attempts, context,
  };

  let stored = false;
  let storeError: string | null = null;
  if (db) {
    const { error } = await db.from("support_tickets").insert(row);
    if (!error) stored = true;
    else storeError = missing(error.message) ? "support_tickets is missing — apply supabase/migrations/0095_support_tickets.sql" : error.message;
  }
  let emailed = false;
  const to = supportAddress();
  if (to && mailConfig().configured) {
    const r = await sendMail({
      to, kind: "support_escalation", subject: `[${reference}] ${draft.subject}`.slice(0, 200),
      text: ticketText({ reference, draft, userEmail: user.email || null, message, context, surveyId }),
      ...(user.email ? { replyTo: user.email } : {}), dedupeKey: `help-escalation:${reference}`,
    }).catch(() => ({ sent: false }));
    emailed = !!(r as { sent?: boolean }).sent;
    if (emailed && stored && db) await db.from("support_tickets").update({ emailed: true }).eq("reference", reference);
  }
  if (!stored && !emailed) {
    console.error("[rescript:help] escalation not delivered", JSON.stringify({ reference, storeError, mail: !!to }));
    return json({ error: `The hand-off could not be delivered: ${storeError ?? "there is no database for tickets"}${to ? "" : ", and no support e-mail address (SUPPORT_EMAIL) is set"}.`, code: "not_configured" }, 503);
  }
  await audit({ action: "help.escalated", userId: user.userId, customerId: user.customerId ?? null, surveyId, entity: "support_ticket", entityId: reference, detail: { reference, stored, emailed, turns: draft.transcript.length } });
  return json({ ok: true, reference, stored, emailed, shared: sharedSummary({ turns: draft.transcript.length, attempts: draft.attempts.length, hasDiagnostics: !!draft.diagnostics, hasContext: !!context }) });
}
