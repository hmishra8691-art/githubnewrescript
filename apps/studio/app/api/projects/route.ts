import { NextRequest, NextResponse } from "next/server";
import { avatarHue, initialsOf, ROLE_LABEL } from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * MY PROJECTS (§36's dashboard, §37's project card).
 *
 * Split into what I own and what was shared with me, because those are
 * different relationships and a flat list hides the one fact a researcher
 * checks first — whether this is theirs.
 *
 * Every card carries who is editing it right now (§37), which is what makes
 * the dashboard useful before you open anything: you can see that Sarah is in
 * the Finance study without opening it and being told you cannot edit.
 *
 * One database function does the whole thing. The alternative is three
 * queries per card, which is the N+1 that makes a project list feel slow at
 * exactly the point a team is big enough to need one.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  const db = supabaseService();
  const { data, error } = await db.rpc("rescript_my_projects", {
    p_user: user.userId,
    p_lock_stale_seconds: user.policies.lock.staleAfterSeconds,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = ((data ?? []) as {
    survey_id: string; code: string; title: string; status: string; updated_at: string;
    owner_id: string; owner_name: string; owner_code: string; my_role: string;
    collaborators: number; editing_user_id: string | null; editing_name: string | null;
    editing_since: string | null; current_version: string | null; response_count: number;
  }[]).map((r) => ({
    id: r.survey_id,
    code: r.code,
    title: r.title,
    status: r.status,
    lastModified: r.updated_at,
    owner: {
      userId: r.owner_id, name: r.owner_name, userCode: r.owner_code,
      isMe: r.owner_id === user.userId,
      initials: initialsOf(r.owner_name, "?"),
      hue: r.owner_id ? avatarHue(r.owner_id) : 0,
    },
    myRole: r.my_role,
    myRoleLabel: ROLE_LABEL[r.my_role as keyof typeof ROLE_LABEL] ?? r.my_role,
    collaborators: r.collaborators,
    version: r.current_version,
    responses: r.response_count,
    /** §37: "Editing: ● Sarah Lee" straight on the card */
    editing: r.editing_user_id
      ? {
          userId: r.editing_user_id, name: r.editing_name, since: r.editing_since,
          isMe: r.editing_user_id === user.userId,
          initials: initialsOf(r.editing_name, "?"),
          hue: avatarHue(r.editing_user_id),
        }
      : null,
  }));

  const owned = rows.filter((r) => r.myRole === "owner");
  const shared = rows.filter((r) => r.myRole !== "owner");

  return NextResponse.json({
    owned,
    shared,
    recent: [...rows].sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified)).slice(0, 6),
    total: rows.length,
  }, { headers: { "cache-control": "no-store" } });
}
