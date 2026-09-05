import { NextRequest, NextResponse } from "next/server";
import { describeEvent } from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * The change history of one quota — the `quota.*` audit rows whose detail
 * names it — for the dashboard's detail view. Configuration history, so it
 * needs only `project.read`.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const quotaId = req.nextUrl.searchParams.get("quotaId");
  if (!quotaId) return NextResponse.json({ error: "quotaId is required" }, { status: 400 });
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? 50), 1), 200);

  const db = supabaseService();
  const { data, error } = await db
    .from("audit_logs")
    .select("id, action, entity, entity_id, user_id, detail, created_at")
    .eq("survey_id", params.id)
    .in("action", ["quota.created", "quota.modified", "quota.deleted"])
    .eq("entity_id", quotaId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const userIds = [...new Set((data ?? []).map((r) => r.user_id).filter(Boolean))] as string[];
  const people = new Map<string, { name: string; code: string }>();
  if (userIds.length) {
    const { data: profiles } = await db.from("profiles").select("id, full_name, user_code").in("id", userIds);
    for (const p of profiles ?? []) people.set(p.id, { name: p.full_name ?? "", code: p.user_code ?? "" });
  }
  const events = (data ?? []).map((r) => {
    const who = r.user_id ? people.get(r.user_id) : undefined;
    const row = {
      id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id, surveyId: params.id, userId: r.user_id,
      actorName: who?.name ?? null, actorUserCode: who?.code ?? null,
      detail: r.detail as Record<string, unknown> | null, createdAt: r.created_at,
    };
    return { ...row, text: describeEvent(row) };
  });
  return NextResponse.json({ events }, { headers: { "cache-control": "no-store" } });
}
