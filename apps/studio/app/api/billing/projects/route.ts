import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireUser } from "@/lib/guard";
import { getMeter } from "@/lib/metering";
import { stripInternalCosts } from "@/lib/billingView";
import { projectMeters, meterThresholds } from "@/lib/projectMeters";
import { can, type ProjectRole } from "@rescript/access";

export const dynamic = "force-dynamic";

/**
 * EVERY PROJECT'S WALLET, FOR THE DASHBOARD.
 *
 * One request for the whole page. The dashboard draws a meter on every card,
 * and asking each card to fetch its own would be a query per project for a
 * number that is a sum — `projectMeters` answers the whole set in two store
 * reads (see that file for why this is not `projectMeterView` in a loop).
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
    const { meters, config } = await projectMeters(meter, user.customerId, rows.map((r) => r.survey_id));
    /* Who may put credits into which project — decided here, with the role,
       so the card does not have to guess and the button is not offered to
       someone the transfer endpoint would refuse. */
    const canRefill = new Set(
      rows.filter((r) => can(r.my_role as ProjectRole, "billing.transfer")).map((r) => r.survey_id),
    );
    return NextResponse.json(stripInternalCosts({
      ok: true,
      currency: config.currency,
      thresholds: meterThresholds(config),
      isPlatformAdmin: !!user.isPlatformAdmin,
      projects: rows.map((r) => {
        const m = meters.get(r.survey_id);
        return {
          id: r.survey_id,
          meter: m ?? null,
          canRefill: canRefill.has(r.survey_id) || !!user.isPlatformAdmin,
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
