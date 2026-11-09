import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireUser } from "@/lib/guard";
import { supabaseAdmin } from "@/lib/admin";
import { dbConfigured } from "@/lib/copilot/durable";

export const dynamic = "force-dynamic";

/**
 * THE USER'S OWN HELP CONVERSATIONS (2026-11-09, migration 0094).
 *   GET                 the latest 30: id, title, project, updated
 *   GET ?id=…           one conversation's messages
 *   DELETE ?id=…        delete it (soft)
 * Every query is scoped to the caller's user id: there is no way to read another person's conversation here.
 * Without the migration (or a database) the list is empty and `persisted: false` says why.
 */
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const missingTable = (m?: string) => !!m && /help_conversations|help_messages|does not exist|schema cache/i.test(m);
const NOT_STORED = { ok: true, persisted: false, conversations: [], note: "Help conversations are kept for this session only until supabase/migrations/0094_help_conversations.sql is applied." };

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return dbConfigured() ? user.response : json(NOT_STORED);
  if (!dbConfigured()) return json(NOT_STORED);
  const db = supabaseAdmin();
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "id" }, 400);
    const { data: conv, error } = await db.from("help_conversations").select("id, title, survey_id, updated_at").eq("id", id).eq("user_id", user.userId).is("deleted_at", null).maybeSingle();
    if (error) return missingTable(error.message) ? json(NOT_STORED) : json({ error: error.message }, 500);
    if (!conv) return json({ error: "No such conversation." }, 404);
    const { data: msgs, error: e2 } = await db.from("help_messages").select("role, content, created_at").eq("conversation_id", id).order("created_at").limit(200);
    if (e2) return json({ error: e2.message }, 500);
    return json({ ok: true, persisted: true, conversation: { id: conv.id, title: conv.title, surveyId: conv.survey_id, updatedAt: conv.updated_at }, messages: msgs ?? [] });
  }
  const { data, error } = await db.from("help_conversations").select("id, title, survey_id, updated_at").eq("user_id", user.userId).is("deleted_at", null).order("updated_at", { ascending: false }).limit(30);
  if (error) return missingTable(error.message) ? json(NOT_STORED) : json({ error: error.message }, 500);
  return json({ ok: true, persisted: true, conversations: (data ?? []).map((c) => ({ id: c.id, title: c.title, surveyId: c.survey_id, updatedAt: c.updated_at })) });
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "id" }, 400);
  if (!dbConfigured()) return json({ ok: true });
  const { data, error } = await supabaseAdmin().from("help_conversations").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("user_id", user.userId).is("deleted_at", null).select("id").maybeSingle();
  if (error) return missingTable(error.message) ? json({ ok: true }) : json({ error: error.message }, 500);
  if (!data) return json({ error: "No such conversation." }, 404);
  return json({ ok: true });
}
