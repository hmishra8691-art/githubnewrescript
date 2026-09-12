import { NextRequest, NextResponse } from "next/server";
import { CATEGORY_LABEL, usageByCategory, money6 } from "@rescript/billing";
import { supabaseAdmin } from "@/lib/admin";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { getMeter } from "@/lib/metering";
import { publicEvent, stripInternalCosts } from "@/lib/billingView";
import { projectMeters } from "@/lib/projectMeters";

export const dynamic = "force-dynamic";

/**
 * MY WALLET — the signed-in person's whole position: one balance, what has
 * been deposited, used, transferred in and out, what is held, and which of
 * their projects is spending it.
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
     * ONE WALLET, AND THE PROJECTS SPENDING FROM IT. The same function the
     * dashboard calls, so a balance read here and a balance read there are
     * the same number arrived at the same way.
     */
    const { meters, wallet, events: mineEvents } = await projectMeters(meter, user.customerId, user.userId, rows.map((r) => r.survey_id));
    const titles = new Map(rows.map((r) => [r.survey_id, r.title]));
    const projects = rows.map((r) => {
      const m = meters.get(r.survey_id);
      return {
        id: r.survey_id, code: r.code, title: r.title, status: r.status, role: r.my_role,
        meter: m ?? null,
        used: m?.used ?? 0, events: m?.events ?? 0,
      };
    }).sort((a, b) => b.used - a.used);
    /*
     * The totals are the WALLET's, not a sum over projects. Adding up
     * projects would count one balance once per card, which is exactly the
     * confusion the central wallet exists to end.
     */
    const totals = { credits: wallet.totalAdded, used: wallet.totalUsed, remaining: wallet.balance };
    return NextResponse.json(stripInternalCosts({
      ok: true, projects, totals, wallet,
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

/**
 * ADD FUNDS.
 *
 * The platform is in simulation mode: credits enter the system when an
 * administrator assigns them, and there is no payment processing yet. So the
 * honest version of "add funds" is a REQUEST — the person names an amount,
 * an administrator approves it, and the credits land in their wallet through
 * the same audited path every other credit takes.
 *
 * The shape is deliberately the one a payment provider slots into later: the
 * person chooses an amount here and something else decides whether the money
 * arrives. When Stripe or Razorpay is connected, the approval step is
 * replaced; nothing else about the wallet, the ledger or the projects that
 * spend from it has to change.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (body?.action !== "add_funds") return NextResponse.json({ error: "unknown action" }, { status: 400 });

  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return NextResponse.json({ error: "Enter an amount greater than zero." }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) : "";

  const meter = getMeter();
  try {
    const wallet = await meter.store.walletForUser(user.customerId ?? "", user.userId, { create: true });
    const request = await meter.store.createCreditRequest({
      customerId: user.customerId ?? "",
      /* a wallet-level request: it belongs to the person, not to one study */
      surveyId: null,
      walletId: wallet?.id ?? null,
      userId: user.userId,
      requestedAmount: amount,
      reason: "Wallet top-up",
      message: note || null,
    });
    await audit({
      action: "billing.credit_requested", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId,
      entity: "credit_request", entityId: request.id, detail: { amount, scope: "wallet" },
    });
    return NextResponse.json({ ok: true, request });
  } catch (e) {
    const msg = (e as Error).message;
    const unavailable = /relation .* does not exist|function .* does not exist|schema cache/i.test(msg);
    return NextResponse.json({ error: unavailable ? "Metered usage is not enabled on this installation yet (migration 0023)." : msg, code: unavailable ? "billing_unavailable" : "billing_error" }, { status: unavailable ? 501 : 503 });
  }
}
