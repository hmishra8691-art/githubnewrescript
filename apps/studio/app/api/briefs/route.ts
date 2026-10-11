import { NextRequest, NextResponse } from "next/server";
import { ResearchBrief } from "@rescript/schema";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE BRIEFS OF THE PROJECTS THE CALLER MAY SEE (Phase 8) — for "copy the
 * brief from another project" in the research design editor. The list is
 * `rescript_my_projects`, the same function the dashboard uses, so a project
 * the caller cannot open is not listed; each project's draft definition (or
 * its current version when there is no draft) gives the brief. Only projects
 * with a brief are returned, newest first.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  let db: ReturnType<typeof supabaseAdmin>;
  try { db = supabaseAdmin(); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Supabase is not configured" }, { status: 503, headers: { "cache-control": "no-store" } }); }
  const { data: mine, error } = await db.rpc("rescript_my_projects", { p_user: user.userId, p_lock_stale_seconds: user.policies.lock.staleAfterSeconds });
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: { "cache-control": "no-store" } });
  const rows = (mine ?? []) as { survey_id: string; title: string; updated_at: string }[];
  const ids = rows.map((r) => r.survey_id).slice(0, 200);
  if (!ids.length) return NextResponse.json({ ok: true, briefs: [] }, { headers: { "cache-control": "no-store" } });
  const { data: surveys, error: e2 } = await db.from("surveys").select("id, title, updated_at, draft_definition").in("id", ids);
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500, headers: { "cache-control": "no-store" } });
  const briefs = (surveys ?? []).map((s) => {
    const raw = (s.draft_definition as { research?: { brief?: unknown } } | null)?.research?.brief;
    const parsed = raw ? ResearchBrief.safeParse(raw) : null;
    const brief = parsed?.success ? parsed.data : null;
    const has = brief && (brief.client || brief.businessQuestion || brief.decision || brief.background || brief.deadline || brief.stakeholders.length || brief.deliverables.length);
    return has ? { surveyId: String(s.id), title: String(s.title ?? ""), updatedAt: String(s.updated_at ?? ""), brief } : null;
  }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return NextResponse.json({ ok: true, briefs }, { headers: { "cache-control": "no-store" } });
}
