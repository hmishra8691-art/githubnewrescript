import { NextRequest, NextResponse } from "next/server";
import { sessionStatus, type SessionRecord } from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

const PLATFORM_ROLES = ["platform_admin", "programmer", "researcher", "client", "viewer"] as const;

/**
 * ADMIN — ACCOUNTS (§9).
 *
 * List, disable, re-enable, unlock, and change a platform role.
 *
 * Two deliberate refusals, both learned from how these screens go wrong:
 *
 *   * an admin cannot disable or demote THEMSELVES. One mis-click would
 *     otherwise leave an installation with nobody who can administer it, and
 *     the recovery is a database console.
 *   * the LAST remaining platform admin cannot be demoted or disabled either,
 *     for the same reason. The check counts the others rather than trusting
 *     that someone else exists.
 *
 * Disabling an account ends its sessions immediately: an account that is
 * "disabled" but still working until its token expires is not disabled.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;

  const url = new URL(req.url);
  const search = url.searchParams.get("q")?.trim().toLowerCase() ?? "";

  const db = supabaseService();
  let q = db
    .from("profiles")
    .select("id, user_code, email, full_name, organization, job_title, role, status, created_at, last_login_at, locked_until, customer_id")
    .order("created_at", { ascending: false })
    .limit(500);
  if (search) q = q.or(`email.ilike.%${search}%,full_name.ilike.%${search}%,user_code.ilike.%${search}%`);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (data ?? []).map((p) => p.id);
  const live = new Map<string, { id: string; created_at: string; last_seen_at: string; device_label: string }>();
  if (ids.length) {
    const { data: sessions } = await db
      .from("user_sessions")
      .select("id, user_id, created_at, last_seen_at, device_label")
      .in("user_id", ids).eq("status", "active");
    for (const s of sessions ?? []) live.set(s.user_id, s);
  }

  const workspaceIds = [...new Set((data ?? []).map((p) => p.customer_id).filter(Boolean))] as string[];
  const workspaces = new Map<string, string>();
  if (workspaceIds.length) {
    const { data: cs } = await db.from("customers").select("id, name").in("id", workspaceIds);
    for (const c of cs ?? []) workspaces.set(c.id, c.name);
  }

  const otherAdmins = (data ?? []).filter((p) => p.role === "platform_admin" && p.status === "active" && p.id !== admin.userId).length;

  return NextResponse.json({
    accounts: (data ?? []).map((p) => {
      const s = live.get(p.id);
      const record: SessionRecord | null = s
        ? { sessionId: s.id, userId: p.id, status: "active", createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: null }
        : null;
      const isSelf = p.id === admin.userId;
      const isLastAdmin = p.role === "platform_admin" && p.status === "active" && otherAdmins === 0;
      return {
        userId: p.id,
        userCode: p.user_code,
        name: p.full_name,
        email: p.email,
        organization: p.organization ?? (p.customer_id ? workspaces.get(p.customer_id) : null) ?? null,
        jobTitle: p.job_title,
        platformRole: p.role,
        accountStatus: p.status,
        createdAt: p.created_at,
        lastLogin: p.last_login_at,
        lockedUntil: p.locked_until,
        /*
         * Whether the lockout is IN FORCE, decided here rather than by
         * comparing a timestamp in the browser — the same reason session
         * status is computed server-side. A client clock that is a few
         * minutes out would otherwise offer or hide "Unlock" wrongly.
         */
        locked: !!p.locked_until && Date.parse(p.locked_until) > Date.now(),
        session: record
          ? { sessionId: record.sessionId, status: sessionStatus(record, admin.policies.session), since: s!.created_at, lastActivity: s!.last_seen_at, device: s!.device_label }
          : null,
        isSelf,
        /** said in the payload so the UI can disable the control and explain why */
        immutableReason: isSelf
          ? "You cannot change your own account here."
          : isLastAdmin
            ? "This is the only platform administrator — promote someone else first."
            : null,
      };
    }),
    platformRoles: PLATFORM_ROLES,
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const userId = String(body?.userId ?? "");
  const action = String(body?.action ?? "");
  if (!userId || !action) return NextResponse.json({ error: "Name a user and an action." }, { status: 400 });

  const db = supabaseService();
  const { data: person } = await db
    .from("profiles").select("id, full_name, user_code, role, status, customer_id").eq("id", userId).maybeSingle();
  if (!person) return NextResponse.json({ error: "Unknown account." }, { status: 404 });

  const selfHarm = userId === admin.userId && (action === "disable" || (action === "set_role" && body?.role !== "platform_admin"));
  if (selfHarm) {
    return NextResponse.json(
      { error: "You cannot disable or demote your own administrator account. Ask another administrator." },
      { status: 409 },
    );
  }

  if (person.role === "platform_admin" && (action === "disable" || (action === "set_role" && body?.role !== "platform_admin"))) {
    const { count } = await db
      .from("profiles").select("id", { count: "exact", head: true })
      .eq("role", "platform_admin").eq("status", "active").neq("id", userId);
    if (!count) {
      return NextResponse.json(
        { error: "This is the only platform administrator. Promote someone else before changing this account." },
        { status: 409 },
      );
    }
  }

  const reason = String(body?.reason ?? "").slice(0, 300) || null;

  switch (action) {
    case "disable": {
      await db.from("profiles").update({ status: "disabled", updated_at: new Date().toISOString() }).eq("id", userId);
      // a disabled account that keeps working until its token expires is not
      // disabled — end every live session now
      const { data: sessions } = await db.from("user_sessions").select("id").eq("user_id", userId).eq("status", "active");
      for (const s of sessions ?? []) {
        await db.rpc("rescript_end_session", { p_session: s.id, p_reason: "revoked", p_by: admin.userId });
      }
      await audit({
        action: "account.disabled", userId: admin.userId, sessionId: admin.sessionId, customerId: person.customer_id,
        detail: { targetName: person.full_name, targetUserCode: person.user_code, sessionsEnded: sessions?.length ?? 0, reason },
      });
      return NextResponse.json({
        ok: true, sessionsEnded: sessions?.length ?? 0,
        message: `${person.full_name}'s account is disabled${sessions?.length ? ` and ${sessions.length} session${sessions.length === 1 ? "" : "s"} ended` : ""}.`,
      });
    }
    case "enable": {
      await db.from("profiles").update({ status: "active", locked_until: null, updated_at: new Date().toISOString() }).eq("id", userId);
      await audit({
        action: "account.enabled", userId: admin.userId, sessionId: admin.sessionId, customerId: person.customer_id,
        detail: { targetName: person.full_name, targetUserCode: person.user_code, reason },
      });
      return NextResponse.json({ ok: true, message: `${person.full_name} can sign in again.` });
    }
    case "unlock": {
      // clear the lockout AND the failures behind it, or the next attempt
      // re-locks against a window that has not moved yet
      await db.from("profiles").update({ locked_until: null, updated_at: new Date().toISOString() }).eq("id", userId);
      await db.from("login_attempts").delete().eq("user_id", userId).eq("success", false);
      await audit({
        action: "account.unlocked", userId: admin.userId, sessionId: admin.sessionId, customerId: person.customer_id,
        detail: { targetName: person.full_name, targetUserCode: person.user_code, reason },
      });
      return NextResponse.json({ ok: true, message: `${person.full_name}'s sign-in lockout has been cleared.` });
    }
    case "set_role": {
      const role = String(body?.role ?? "");
      if (!(PLATFORM_ROLES as readonly string[]).includes(role)) {
        return NextResponse.json({ error: `Choose one of: ${PLATFORM_ROLES.join(", ")}.` }, { status: 400 });
      }
      await db.from("profiles").update({ role, updated_at: new Date().toISOString() }).eq("id", userId);
      await audit({
        action: "account.role_changed", userId: admin.userId, sessionId: admin.sessionId, customerId: person.customer_id,
        detail: { targetName: person.full_name, targetUserCode: person.user_code, role, from: person.role, reason },
      });
      return NextResponse.json({ ok: true, role, message: `${person.full_name} is now ${role.replace("_", " ")}.` });
    }
    default:
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  }
}
