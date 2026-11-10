import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireUser } from "@/lib/guard";
import { supabaseAdmin } from "@/lib/admin";
import { dbConfigured } from "@/lib/copilot/durable";

export const dynamic = "force-dynamic";

/**
 * "DID THIS SOLVE IT?" (2026-11-10) — POST { messageId, solved }. Recorded on the answer the user owns (its
 * conversation is theirs); the admin Help usage report counts it. A "No" in the UI also asks the next question
 * ("That didn't solve it"), which is what moves the problem on — this only records the outcome.
 * Without a database there is nothing to record: { ok: true, recorded: false }.
 */
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return dbConfigured() ? user.response : json({ ok: true, recorded: false });
  if (!dbConfigured()) return json({ ok: true, recorded: false });
  let body: { messageId?: unknown; solved?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const id = typeof body.messageId === "string" && /^[0-9a-f-]{36}$/i.test(body.messageId) ? body.messageId : null;
  if (!id || typeof body.solved !== "boolean") return json({ error: "messageId and solved are required" }, 400);
  const db = supabaseAdmin();
  const { data: msg } = await db.from("help_messages").select("id, role, content, conversation_id").eq("id", id).maybeSingle();
  if (!msg || msg.role !== "assistant") return json({ error: "No such answer." }, 404);
  const { data: conv } = await db.from("help_conversations").select("id").eq("id", msg.conversation_id).eq("user_id", user.userId).is("deleted_at", null).maybeSingle();
  if (!conv) return json({ error: "No such answer." }, 404);
  const { error } = await db.from("help_messages").update({ content: { ...(msg.content as object), solved: body.solved } }).eq("id", id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, recorded: true });
}
