import { NextRequest, NextResponse } from "next/server";
import { summarizeWallet, balanceLevel } from "@rescript/billing";
import { supabaseAdmin } from "@/lib/admin";
import { audit } from "@/lib/guard";
import { requireBillingAdmin, billingError } from "@/lib/billingAdmin";
import { projectMeterView } from "@/lib/billingView";

export const dynamic = "force-dynamic";

/**
 * WALLETS, for the administrator (billing brief §17, §20).
 *   GET   → every wallet with its project, owner, balance, state, level; ?survey=<id> → that project's full meter view + ledger
 *   POST  → { action: "ensure", surveyId } create the project's wallet if missing (so credits can be assigned before first use)
 *   PATCH → { walletId, state?, overdraftEnabled?, overdraftLimit?, sharedWalletId? }
 */
export async function GET(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  const surveyId = req.nextUrl.searchParams.get("survey");
  try {
    const cfg = await gate.meter.config();
    if (surveyId) {
      const wallets = await gate.meter.store.listWallets({});
      const w = wallets.find((x) => x.surveyId === surveyId) ?? null;
      const customerId = w?.customerId ?? (gate.sandbox ? "sandbox" : null);
      if (!customerId) return NextResponse.json({ ok: true, view: null });
      const view = await projectMeterView(gate.meter, { customerId, surveyId }, { recent: 200, audience: "admin" });
      return NextResponse.json({ ok: true, view, requests: await gate.meter.store.listCreditRequests({ surveyId }) });
    }
    const wallets = await gate.meter.store.listWallets({});
    let projects: Record<string, { code: string; title: string; status: string; owner: string | null; customer: string | null }> = {};
    if (!gate.sandbox && wallets.length) {
      const db = supabaseAdmin();
      const ids = wallets.map((w) => w.surveyId).filter(Boolean) as string[];
      const { data } = await db.from("surveys").select("id, code, title, status, owner_id, customer_id, profiles:owner_id(full_name, email), customers:customer_id(name)").in("id", ids);
      for (const r of (data ?? []) as any[]) projects[r.id] = { code: r.code, title: r.title, status: r.status, owner: r.profiles?.full_name ?? r.profiles?.email ?? null, customer: r.customers?.name ?? null };
      const userIds = wallets.map((w) => w.userId).filter(Boolean) as string[];
      if (userIds.length) {
        const { data: ps } = await db.from("profiles").select("id, user_code, full_name, email").in("id", userIds);
        for (const p of (ps ?? []) as any[]) projects[`user:${p.id}`] = { code: p.user_code, title: `Personal wallet — ${p.full_name || p.email}`, status: "", owner: p.full_name || p.email, customer: null };
      }
    }
    const rows = await Promise.all(wallets.map(async (w) => {
      const events = await gate.meter.store.listUsage({ walletId: w.id, limit: 5000 });
      const ledger = await gate.meter.store.listLedger(w.id, 500);
      const s = summarizeWallet(w, ledger, events, cfg);
      return {
        id: w.id, surveyId: w.surveyId, customerId: w.customerId, sharedWalletId: w.sharedWalletId, currency: w.currency,
        project: w.surveyId
          ? projects[w.surveyId] ?? (gate.sandbox ? { code: w.surveyId === "sandbox" ? "SANDBOX" : w.surveyId.toUpperCase(), title: w.surveyId === "sandbox" ? "Sandbox project" : `Sandbox project ${w.surveyId}`, status: "draft", owner: null, customer: null } : null)
          : w.userId
            ? projects[`user:${w.userId}`] ?? { code: "—", title: `Personal wallet — ${gate.sandbox ? w.userId : "user"}`, status: "", owner: null, customer: null }
            : { code: "—", title: "Workspace wallet", status: "", owner: null, customer: null },
        userId: w.userId,
        balance: w.balance, reserved: w.reserved, totalAdded: w.totalAdded, totalUsed: w.totalUsed, state: s.state, level: balanceLevel(w.balance, cfg),
        overdraftEnabled: w.overdraftEnabled, overdraftLimit: w.overdraftLimit, usage: s.usage, costs: s.costs, events: events.length, updatedAt: w.updatedAt,
      };
    }));
    return NextResponse.json({ ok: true, wallets: rows, pendingRequests: (await gate.meter.store.listCreditRequests({ status: "pending" })).length });
  } catch (e) { return billingError(e); }
}

export async function POST(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (body?.action !== "ensure" || typeof body?.surveyId !== "string") return NextResponse.json({ error: "action ensure and surveyId are required" }, { status: 400 });
  try {
    let customerId = "sandbox";
    if (!gate.sandbox) {
      const { data } = await supabaseAdmin().from("surveys").select("customer_id").eq("id", body.surveyId).maybeSingle();
      if (!data) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
      customerId = data.customer_id;
    }
    const wallet = await gate.meter.walletFor({ customerId, surveyId: body.surveyId }, true);
    return NextResponse.json({ ok: true, wallet });
  } catch (e) { return billingError(e); }
}

export async function PATCH(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (typeof body?.walletId !== "string") return NextResponse.json({ error: "walletId is required" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (["active", "suspended"].includes(body?.state)) patch.state = body.state;
  if (typeof body?.overdraftEnabled === "boolean" || body?.overdraftEnabled === null) patch.overdraftEnabled = body.overdraftEnabled;
  if (typeof body?.overdraftLimit === "number" || body?.overdraftLimit === null) patch.overdraftLimit = body.overdraftLimit;
  if (typeof body?.sharedWalletId === "string" || body?.sharedWalletId === null) patch.sharedWalletId = body.sharedWalletId;
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to change" }, { status: 400 });
  try {
    const wallet = await gate.meter.store.setWallet(body.walletId, patch);
    if (gate.user) await audit({ action: "billing.wallet_changed", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, surveyId: wallet.surveyId ?? undefined, entity: "wallet", entityId: wallet.id, detail: patch });
    return NextResponse.json({ ok: true, wallet });
  } catch (e) { return billingError(e); }
}
