import { NextRequest, NextResponse } from "next/server";
import {
  ACCESS_FIELDS, DEFAULT_SESSION_POLICY, DEFAULT_THROTTLE,
  buildAccessPolicy, describeAccessPolicy,
  GRANTABLE_ROLES,
} from "@rescript/access";
import { loadPolicies, supabaseService } from "@/lib/authServer";
import { audit, isFailure, requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE WORKSPACE ACCESS POLICY (§7).
 *
 *   GET  /api/admin/access     the effective policy, the defaults, and which
 *                              values are actually stored
 *   PUT  /api/admin/access     write this workspace's overrides
 *
 * `public.access_settings` has existed since 0008. It is read on every login,
 * every heartbeat and every lock decision through `rescript_access_policy`,
 * which merges the platform default row over a customer's own. It has never
 * been WRITTEN by anything: the only way to change a session timeout, a
 * lockout threshold or the workspace baseline role was to open the SQL editor
 * and hand-write a jsonb document.
 *
 * That is the worst shape for a settings table. §7 promises these are
 * configurable, `loadPolicies` reads them faithfully, the login screen quotes
 * the numbers back to people in minutes — and an operator could not change one
 * without database credentials. So the table is a promise the product could
 * not keep, and the values everyone actually ran on were the code defaults.
 *
 * THREE DECISIONS.
 *
 * 1. IT WRITES ONLY THE VALUES THAT DIFFER FROM THE DEFAULT. A settings row
 *    that restates every default is a row that silently pins them: raise a
 *    default in code six months from now and every workspace keeps the old
 *    number, with nothing to show why. Storing only the deltas means a
 *    workspace inherits improvements it never asked to opt out of.
 *
 * 2. IT VALIDATES THROUGH THE SAME FUNCTIONS `loadPolicies` USES. The
 *    `*Policy()` helpers already clamp, floor and ignore nonsense — including
 *    the rule that `staleAfterSeconds` cannot precede `idleAfterSeconds`, or
 *    a session would skip IDLE entirely. Writing a second validator here
 *    would be a second opinion about what is legal, and the one that runs at
 *    login would win.
 *
 * 3. IT IS PLATFORM-ADMIN ONLY, AND SCOPED TO THE CALLER'S OWN WORKSPACE.
 *    There is no per-customer admin role in this schema, and a session
 *    timeout is not a per-project setting — it decides whether a colleague
 *    gets signed out mid-edit. `requireAdmin` is the right door, and the row
 *    written is the admin's own `customer_id` so a platform admin cannot
 *    reconfigure another workspace by accident.
 */

/** The platform-wide default row, seeded by 0008. */
const PLATFORM_DEFAULT = "00000000-0000-0000-0000-000000000000";

/*
 * The field table, the validation and the delta rule all live in
 * `@rescript/access` (`settings.ts`) rather than here. A route imports
 * `server-only`, so logic inside one cannot be unit-tested — and "which
 * values get stored" is the last thing in this feature that should go
 * untested, because a wrong number signs every colleague out mid-edit.
 * `packages/access/src/settings.test.ts` covers it with 18 assertions.
 */

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (isFailure(gate)) return gate.response;

  const db = supabaseService();
  const customerId = gate.customerId;

  /*
   * Three things, and the difference between them is the whole point of the
   * screen: what is IN FORCE, what the code would do with no settings at all,
   * and which of those numbers this workspace has actually chosen. Without
   * the third an operator cannot tell an inherited default from a decision
   * somebody made and forgot.
   */
  const effective = await loadPolicies(customerId);

  let stored: Record<string, unknown> = {};
  let platform: Record<string, unknown> = {};
  let migration: string | null = null;
  try {
    const [own, base] = await Promise.all([
      customerId
        ? db.from("access_settings").select("policy, updated_at, updated_by").eq("customer_id", customerId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      db.from("access_settings").select("policy").eq("customer_id", PLATFORM_DEFAULT).maybeSingle(),
    ]);
    stored = (own?.data?.policy as Record<string, unknown>) ?? {};
    platform = (base?.data?.policy as Record<string, unknown>) ?? {};
  } catch (e) {
    /* a settings table that cannot be read must not break the admin screen */
    migration = "0008";
    console.error("[rescript:access] settings not readable", { error: (e as Error).message });
  }

  return NextResponse.json({
    effective,
    defaults: { session: DEFAULT_SESSION_POLICY, throttle: DEFAULT_THROTTLE },
    stored,
    platformDefault: platform,
    fields: ACCESS_FIELDS,
    grantableRoles: GRANTABLE_ROLES,
    workspaceId: customerId,
    ...(migration ? { migration } : {}),
  }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  if (!gate.customerId) {
    return NextResponse.json({
      error: "Your account is not attached to a workspace, so there is nothing to configure.",
    }, { status: 409 });
  }

  /*
   * One call, and every rule with it: the ranges, the clamps, the ordering
   * rule between idle and stale, and "store only what differs from the
   * default". `adjusted` is returned to the caller rather than swallowed —
   * asking for a stale timeout shorter than the idle one gets you the idle
   * one, and a screen that showed the number you typed would be lying about
   * what is in force.
   */
  const draft = buildAccessPolicy({
    session: body?.session ?? null,
    throttle: body?.throttle ?? null,
    workspace: body?.workspace ?? null,
  });

  if (draft.rejected.length) {
    return NextResponse.json(
      { error: draft.rejected.join(". ") + ".", rejected: draft.rejected },
      { status: 400 },
    );
  }
  const next = draft.policy;

  const db = supabaseService();
  const { error } = await db.from("access_settings").upsert({
    customer_id: gate.customerId,
    policy: next,
    updated_at: new Date().toISOString(),
    updated_by: gate.userId,
  }, { onConflict: "customer_id" });
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ error: "Access settings need migration 0008.", migration: "0008" }, { status: 503 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  /*
   * Audited as a settings change with the whole document, because this is the
   * one screen where a wrong value locks colleagues out of their own accounts
   * — "who shortened the session lifetime to five minutes" has to be
   * answerable.
   */
  await audit({
    action: "workspace.access_policy_changed",
    userId: gate.userId, sessionId: gate.sessionId, customerId: gate.customerId,
    entity: "access_settings", entityId: gate.customerId,
    detail: { policy: next, summary: describeAccessPolicy(next) },
  });

  const effective = await loadPolicies(gate.customerId);
  return NextResponse.json({
    ok: true, stored: next, effective,
    note: describeAccessPolicy(next),
    ...(draft.adjusted.length ? { adjusted: draft.adjusted } : {}),
  });
}

