import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireUser } from "@/lib/guard";
import { getMeter } from "@/lib/metering";
import { stripInternalCosts } from "@/lib/billingView";
import { projectMeters, meterThresholds } from "@/lib/projectMeters";
import { can, type ProjectRole } from "@rescript/access";

export const dynamic = "force-dynamic";

/**
 * THE WALLET, AND WHAT EVERY PROJECT IS SPENDING FROM IT.
 *
 * One request for the whole page: one balance, plus each project's own spend
 * and policy. Asking each card to fetch its own would be a query per project
 * for numbers that are sums — `projectMeters` answers the whole set in three
 * store reads (see that file for why this is not `projectMeterView` in a
 * loop).
 *
 * Which projects: `rescript_my_projects`, the same function the survey list
 * itself uses, so a wallet can never appear for a project the person could
 * not open.
 *
 * This is a researcher's endpoint: customer charges only. Provider cost,
 * infrastructure, fees, reserve and margin are never computed here, and the
 * payload goes through `stripInternalCosts` regardless.
 *
 * Billing is optional on an installation. When migration 0023 is absent this
 * answers 200 with `ok: false` rather than an error, because a dashboard that
 * cannot show wallets must still show projects.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const db = supabaseAdmin();
  const { data: mine, error } = await db.rpc("rescript_my_projects", {
    p_user: user.userId,
    p_lock_stale_seconds: user.policies.lock.staleAfterSeconds,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (mine ?? []) as { survey_id: string; my_role: string }[];

  const meter = getMeter();
  try {
    const { meters, wallet, config } = await projectMeters(meter, user.customerId, user.userId, rows.map((r) => r.survey_id));
    /* Who may change which project's spending limit — decided here, with the
       role, so a card does not offer a control the server would refuse. */
    const canBudget = new Set(
      rows.filter((r) => can(r.my_role as ProjectRole, "billing.set_budget")).map((r) => r.survey_id),
    );
    return NextResponse.json(stripInternalCosts({
      ok: true,
      currency: config.currency,
      /* the one balance every card on this page draws on */
      wallet,
      thresholds: meterThresholds(config),
      isPlatformAdmin: !!user.isPlatformAdmin,
      projects: rows.map((r) => {
        const m = meters.get(r.survey_id);
        return {
          id: r.survey_id,
          meter: m ?? null,
          canBudget: canBudget.has(r.survey_id) || !!user.isPlatformAdmin,
        };
      }),
    }));
  } catch (e) {
    const msg = (e as Error).message;
    const unavailable = /relation .* does not exist|function .* does not exist|schema cache/i.test(msg);
    if (unavailable) return NextResponse.json({ ok: false, code: "billing_unavailable" });
    return NextResponse.json({ ok: false, code: "billing_error", error: msg });
  }
}
