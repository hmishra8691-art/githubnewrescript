import { NextRequest, NextResponse } from "next/server";
import { CATEGORY_LABEL, usageByCategory, money6 } from "@rescript/billing";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireUser } from "@/lib/guard";
import { getMeter } from "@/lib/metering";
import { publicEvent, stripInternalCosts } from "@/lib/billingView";
import { projectMeters } from "@/lib/projectMeters";

export const dynamic = "force-dynamic";

/**
 * MY USAGE (billing brief §19) — the signed-in person's view across every
 * project they can see: each project's wallet and use, totals, use by
 * category, and their most recent usage rows.
 *
 * Which projects: `rescript_my_projects`, the same function the dashboard
 * uses — so this page can never show a wallet for a project the person
 * could not open.
 *
 * Every amount here is a CUSTOMER CHARGE (change 2). Provider cost,
 * infrastructure, fees, reserve and margin are internal metrics and are
 * not in this payload — `publicEvent` never carries them and the whole
 * response is passed through `stripInternalCosts`.
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
    /*
     * The same meters the dashboard draws on its cards — one function, so a
     * balance read here and a balance read there are the same number arrived
     * at the same way. (`projectMeters` also explains why this is two store
     * reads rather than one per project.)
     */
    const { meters, wallets, events: mineEvents } = await projectMeters(meter, user.customerId, rows.map((r) => r.survey_id));
    const titles = new Map(rows.map((r) => [r.survey_id, r.title]));
    const projects = rows.map((r) => {
      const m = meters.get(r.survey_id);
      return {
        id: r.survey_id, code: r.code, title: r.title, status: r.status, role: r.my_role,
        wallet: m ? { balance: m.remaining, totalAdded: m.allocated, totalUsed: m.used, state: m.state, currency: m.currency } : null,
        used: m?.used ?? 0, events: m?.events ?? 0,
      };
    }).sort((a, b) => b.used - a.used);
    // the person's own wallet, when an administrator has created one (credits transferred to them)
    const personal = wallets.find((w) => w.userId === user.userId) ?? null;
    const totals = {
      credits: money6(projects.reduce((a, p) => a + (p.wallet?.totalAdded ?? 0), 0) + (personal?.totalAdded ?? 0)),
      used: money6(projects.reduce((a, p) => a + (p.wallet?.totalUsed ?? 0), 0) + (personal?.totalUsed ?? 0)),
      remaining: money6(projects.reduce((a, p) => a + (p.wallet?.balance ?? 0), 0) + (personal?.balance ?? 0)),
    };
    return NextResponse.json(stripInternalCosts({
      ok: true, projects, totals,
      personalWallet: personal ? { balance: personal.balance, totalAdded: personal.totalAdded, state: personal.state, currency: personal.currency } : null,
      categories: usageByCategory(mineEvents).map((c) => ({ category: c.category, label: CATEGORY_LABEL[c.category], charge: c.charge, events: c.events, quantity: c.quantity })),
      recent: mineEvents.slice(0, 50).map((e) => ({ ...publicEvent(e), projectTitle: e.surveyId ? titles.get(e.surveyId) ?? null : null })),
      requests: (await meter.store.listCreditRequests({ userId: user.userId })).slice(0, 20),
    }));
  } catch (e) {
    const msg = (e as Error).message;
    const unavailable = /relation .* does not exist|function .* does not exist|schema cache/i.test(msg);
    return NextResponse.json({ error: unavailable ? "Metered usage is not enabled on this installation yet (migration 0023)." : msg, code: unavailable ? "billing_unavailable" : "billing_error" }, { status: unavailable ? 501 : 503 });
  }
}
