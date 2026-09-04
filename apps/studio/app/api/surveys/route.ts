import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { newSurveyDefinition } from "@/lib/defaults";
import { loadDashboardStats } from "@/lib/dashboard";
import { SurveyDefinition } from "@rescript/schema";
import { audit, isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE SURVEY LIST.
 *
 * This used to return every survey in the database to anyone who could reach
 * the Studio, which was correct when there were no accounts and is a
 * cross-project data leak now that there are. It returns only the projects
 * the caller actually has a role on — owned, or shared with them — resolved
 * by `rescript_my_projects`, the same function the dashboard uses, so the
 * listing and the cards can never disagree about who can see what.
 *
 * A platform administrator sees only their own projects here too. Reading
 * every project in the installation is not an operational duty, and the admin
 * console is where operational work belongs.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  let db: ReturnType<typeof supabaseAdmin>;
  try {
    db = supabaseAdmin();
  } catch (e) {
    // Missing env vars: answer with a readable message instead of a 500 page.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Supabase is not configured" },
      { status: 503 },
    );
  }

  const { data: mine, error } = await db.rpc("rescript_my_projects", {
    p_user: user.userId,
    p_lock_stale_seconds: user.policies.lock.staleAfterSeconds,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (mine ?? []) as {
    survey_id: string; code: string; title: string; status: string; updated_at: string;
    owner_id: string | null; owner_name: string | null; owner_code: string | null;
    my_role: string; collaborators: number;
    editing_user_id: string | null; editing_name: string | null; editing_since: string | null;
    current_version: string | null;
  }[];

  /*
   * The shape the dashboard has always consumed, plus the collaboration
   * fields. Keeping `surveys` identical means the existing dashboard keeps
   * working unchanged and the new columns are additive (§22 of the request:
   * existing functionality must remain unaffected).
   */
  const surveys = rows.map((r) => ({
    id: r.survey_id,
    code: r.code,
    title: r.title,
    status: r.status,
    created_at: r.updated_at,
    updated_at: r.updated_at,
    current_version_id: null as string | null,
    created_by: r.owner_id,
    // collaboration additions
    myRole: r.my_role,
    owner: r.owner_id ? { userId: r.owner_id, name: r.owner_name, userCode: r.owner_code, isMe: r.owner_id === user.userId } : null,
    collaborators: r.collaborators,
    version: r.current_version,
    editing: r.editing_user_id
      ? { userId: r.editing_user_id, name: r.editing_name, since: r.editing_since, isMe: r.editing_user_id === user.userId }
      : null,
  }));

  /**
   * Statistics are additive: if they cannot be loaded the listing still
   * renders with names, statuses and dates, and each missing number shows as
   * "—" rather than a misleading 0 (reqs §23–§25).
   */
  let dashboard = null;
  try {
    dashboard = await loadDashboardStats(db, surveys as never);
  } catch (e) {
    return NextResponse.json({
      surveys,
      stats: {},
      contributors: {},
      warnings: [`statistics unavailable: ${e instanceof Error ? e.message : String(e)}`],
    });
  }

  return NextResponse.json({
    surveys,
    stats: dashboard.stats,
    contributors: dashboard.contributors,
    statsSource: dashboard.source,
    warnings: dashboard.warnings,
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * CREATE A PROJECT.
 *
 * The creator becomes the owner (§12) and the project belongs to their
 * workspace, not to a global "default" one — that fallback existed only
 * because there were no accounts to attribute anything to.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  const body = await req.json().catch(() => ({}));
  const title = String(body.title ?? "Untitled survey").slice(0, 200);
  const code = String(body.code ?? `SURVEY_${Date.now().toString(36).toUpperCase()}`).slice(0, 60);
  const db = supabaseAdmin();

  if (!user.customerId) {
    return NextResponse.json(
      { error: "Your account is not attached to a workspace. Contact your administrator." },
      { status: 409 },
    );
  }

  const { data: survey, error } = await db
    .from("surveys")
    .insert({ customer_id: user.customerId, code, title, owner_id: user.userId, created_by: user.userId })
    .select("id")
    .single();
  if (error) {
    if (/duplicate|unique/i.test(error.message)) {
      return NextResponse.json({ error: `A project with the code "${code}" already exists in your workspace.` }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // definition: from template payload or blank
  let definition = newSurveyDefinition(survey.id, code, title);
  if (body.definition) {
    const parsed = SurveyDefinition.safeParse({
      ...body.definition,
      meta: { ...body.definition.meta, id: survey.id, code, title, version: "1.0" },
    });
    if (parsed.success) definition = parsed.data;
  }

  // Derive a unique default URL slug from the survey code, so every new survey
  // gets its own /s/<client>/<study> and the Test button never collides.
  const slug =
    code.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "study";
  definition.deployment.studySlug = slug;

  const { data: ver, error: verr } = await db
    .from("survey_versions")
    .insert({ survey_id: survey.id, version: "1.0", definition, label: "Initial version", created_by: user.userId })
    .select("id")
    .single();
  if (verr) return NextResponse.json({ error: verr.message }, { status: 500 });

  await db.from("surveys").update({ current_version_id: ver.id }).eq("id", survey.id);
  await audit({
    action: "project.created", userId: user.userId, sessionId: user.sessionId,
    surveyId: survey.id, customerId: user.customerId, detail: { code, title },
  });
  return NextResponse.json({ id: survey.id });
}
