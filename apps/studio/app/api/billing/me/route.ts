import { NextRequest, NextResponse } from "next/server";
import { CATEGORY_LABEL, usageByCategory, money6 } from "@rescript/billing";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireUser } from "@/lib/guard";
import { getMeter } from "@/lib/metering";
import { publicEvent } from "@/lib/billingView";

export const dynamic = "force-dynamic";

/**
 * MY USAGE (billing brief §19) — the signed-in person's view across every
 * project they can see: each project's wallet and use, totals, use by
 * category, and their most recent usage rows.
 *
 * Which projects: `rescript_my_projects`, the same function the dashboard
 * uses — so this page can never show a wallet for a project the person
 * could not open.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const db = supabaseAdmin();
  const { data: mine, error } = await db.rpc("rescript_my_projects", { p_user: user.userId, p_lock_stale_seconds: user.policies.lock.staleAfterSeconds });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (mine ?? []) as { survey_id: string; code: string; title: string; status: string; my_role: string }[];
  const meter = getMeter();
  try {
    const wallets = await meter.store.listWallets({ customerId: user.customerId ?? undefined });
    const byId = new Map(wallets.filter((w) => w.surveyId).map((w) => [w.surveyId!, w]));
    const events = await meter.store.listUsage({ customerId: user.customerId ?? undefined, limit: 5000 });
    const visible = new Set(rows.map((r) => r.survey_id));
    const mineEvents = events.filter((e) => e.surveyId && visible.has(e.surveyId));
    const projects = rows.map((r) => {
      const w = byId.get(r.survey_id);
      const ev = mineEvents.filter((e) => e.surveyId === r.survey_id);
      return {
        id: r.survey_id, code: r.code, title: r.title, status: r.status, role: r.my_role,
        wallet: w ? { balance: w.balance, totalAdded: w.totalAdded, totalUsed: w.totalUsed, state: w.state, currency: w.currency } : null,
        used: money6(ev.reduce((a, e) => a + e.customerCharge, 0)), events: ev.length,
      };
    }).sort((a, b) => b.used - a.used);
    const totals = {
      credits: money6(projects.reduce((a, p) => a + (p.wallet?.totalAdded ?? 0), 0)),
      used: money6(projects.reduce((a, p) => a + (p.wallet?.totalUsed ?? 0), 0)),
      remaining: money6(projects.reduce((a, p) => a + (p.wallet?.balance ?? 0), 0)),
    };
    return NextResponse.json({
      ok: true, projects, totals,
      categories: usageByCategory(mineEvents).map((c) => ({ ...c, label: CATEGORY_LABEL[c.category] })),
      recent: mineEvents.slice(0, 50).map(publicEvent),
      requests: (await meter.store.listCreditRequests({ userId: user.userId })).slice(0, 20),
    });
  } catch (e) {
    const msg = (e as Error).message;
    const unavailable = /relation .* does not exist|function .* does not exist|schema cache/i.test(msg);
    return NextResponse.json({ error: unavailable ? "Metered usage is not enabled on this installation yet (migration 0023)." : msg, code: unavailable ? "billing_unavailable" : "billing_error" }, { status: unavailable ? 501 : 503 });
  }
}
