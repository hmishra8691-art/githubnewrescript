import { NextRequest, NextResponse } from "next/server";
import { auditCategory, describeEvent } from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * PROJECT ACTIVITY (§25).
 *
 * The audit rows for one project, rendered into sentences by the shared
 * `describeEvent` so the log is worded identically here, in the notification
 * list and anywhere else it surfaces.
 *
 * Requires `project.read_activity`, which a plain Viewer does not have: the
 * log says who looked at what and when, and that is team information rather
 * than project content.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.read_activity");
  if (isFailure(ctx)) return ctx.response;

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);
  const category = url.searchParams.get("category");
  const before = url.searchParams.get("before");

  const db = supabaseService();
  let q = db
    .from("audit_logs")
    .select("id, action, entity, entity_id, user_id, detail, created_at")
    .eq("survey_id", params.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) q = q.lt("created_at", before);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // one lookup for every actor in the page, rather than one per row
  const userIds = [...new Set((data ?? []).map((r) => r.user_id).filter(Boolean))] as string[];
  const people = new Map<string, { name: string; code: string }>();
  if (userIds.length) {
    const { data: profiles } = await db.from("profiles").select("id, full_name, user_code").in("id", userIds);
    for (const p of profiles ?? []) people.set(p.id, { name: p.full_name ?? "", code: p.user_code ?? "" });
  }

  const events = (data ?? []).map((r) => {
    const who = r.user_id ? people.get(r.user_id) : undefined;
    const row = {
      id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id,
      surveyId: params.id, userId: r.user_id,
      actorName: who?.name ?? null, actorUserCode: who?.code ?? null,
      detail: r.detail as Record<string, unknown> | null,
      createdAt: r.created_at,
    };
    return {
      ...row,
      text: describeEvent(row),
      category: auditCategory(r.action),
      at: r.created_at,
    };
  });

  return NextResponse.json({
    events: category ? events.filter((e) => e.category === category) : events,
    categories: [...new Set(events.map((e) => e.category))],
    nextBefore: events.length === limit ? events[events.length - 1].createdAt : null,
  }, { headers: { "cache-control": "no-store" } });
}
