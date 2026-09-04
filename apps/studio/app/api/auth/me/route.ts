import { NextRequest, NextResponse } from "next/server";
import { supabaseService } from "@/lib/authServer";
import { isFailure, publicUser, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Who am I, and what governs me?
 *
 * The client's first call. It returns the identity, the policy intervals the
 * client must use for its heartbeats (so the cadence is server-decided and
 * configurable, never hardcoded in the browser), and the count of unread
 * notifications. A 401 here is the signal to show the login screen.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  const db = supabaseService();
  const [{ data: profile }, { count }] = await Promise.all([
    db.from("profiles")
      .select("organization, job_title, created_at, last_login_at, status")
      .eq("id", user.userId).maybeSingle(),
    db.from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.userId).is("read_at", null),
  ]);

  return NextResponse.json({
    ...publicUser(user),
    organization: profile?.organization ?? null,
    jobTitle: profile?.job_title ?? null,
    createdAt: profile?.created_at ?? null,
    lastLoginAt: profile?.last_login_at ?? null,
    accountStatus: profile?.status ?? "active",
    unread: count ?? 0,
  }, { headers: { "cache-control": "no-store" } });
}
