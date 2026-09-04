import { NextRequest, NextResponse } from "next/server";
import { describeEvent } from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * IN-APP NOTIFICATIONS (§39).
 *
 * The rows are already scoped to the recipient, and the sentence a user reads
 * is produced by the shared `describeEvent` — the same function the project
 * activity log uses — so a shared project and a released lock are worded the
 * same wherever they appear.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  const db = supabaseService();
  const { data } = await db
    .from("notifications")
    .select("id, survey_id, action, detail, created_at, read_at")
    .eq("user_id", user.userId)
    .order("created_at", { ascending: false })
    .limit(50);

  const ids = [...new Set((data ?? []).map((n) => n.survey_id).filter(Boolean))] as string[];
  const titles = new Map<string, string>();
  if (ids.length) {
    const { data: surveys } = await db.from("surveys").select("id, code, title").in("id", ids);
    for (const s of surveys ?? []) titles.set(s.id, `${s.code} — ${s.title}`);
  }

  return NextResponse.json({
    notifications: (data ?? []).map((n) => ({
      id: n.id,
      surveyId: n.survey_id,
      project: n.survey_id ? titles.get(n.survey_id) ?? null : null,
      action: n.action,
      text: describeEvent({
        id: n.id, action: n.action, entity: "survey", entityId: n.survey_id,
        userId: null, detail: n.detail as Record<string, unknown>, createdAt: n.created_at,
        actorName: (n.detail as { actorName?: string } | null)?.actorName ?? null,
      }),
      createdAt: n.created_at,
      read: !!n.read_at,
    })),
    unread: (data ?? []).filter((n) => !n.read_at).length,
  }, { headers: { "cache-control": "no-store" } });
}

/** Mark notifications read — all of them, or the ones named. */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const db = supabaseService();
  let q = db.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", user.userId).is("read_at", null);
  if (Array.isArray(body?.ids) && body.ids.length) q = q.in("id", body.ids.slice(0, 200));
  const { error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
