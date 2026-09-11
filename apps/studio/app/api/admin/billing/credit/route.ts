import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { audit } from "@/lib/guard";
import { requireBillingAdmin, billingError } from "@/lib/billingAdmin";

export const dynamic = "force-dynamic";

/**
 * ASSIGN / ADD / REMOVE CREDITS (billing brief §1, §17).
 *
 *   POST { walletId | surveyId, amount, reason, note?, expiresAt? }
 *
 * A positive amount is a credit, a negative one an adjustment; both are
 * ledger lines — the balance is never written directly. Amounts are in the
 * wallet's currency; the presets ($10 / $50 / $100 / $500 / $1,000) are a
 * UI convenience over this one call.
 */
export async function POST(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 10_000_000) return NextResponse.json({ error: "amount must be a non-zero number" }, { status: 400 });
  const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 120) : (amount > 0 ? "credits_added" : "credits_removed");
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) : null;
  const expiresAt = typeof body?.expiresAt === "string" && body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
  try {
    let walletId: string | null = typeof body?.walletId === "string" ? body.walletId : null;
    if (!walletId && typeof body?.surveyId === "string") {
      let customerId = "sandbox";
      if (!gate.sandbox) {
        const { data } = await supabaseAdmin().from("surveys").select("customer_id").eq("id", body.surveyId).maybeSingle();
        if (!data) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
        customerId = data.customer_id;
      }
      walletId = (await gate.meter.walletFor({ customerId, surveyId: body.surveyId }, true))?.id ?? null;
    }
    if (!walletId) return NextResponse.json({ error: "walletId or surveyId is required" }, { status: 400 });
    const { entry, wallet } = await gate.meter.credit(walletId, amount, { reason, note, by: gate.user?.userId ?? null, expiresAt });
    if (gate.user) await audit({ action: amount > 0 ? "billing.credits_assigned" : "billing.credits_adjusted", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, surveyId: wallet.surveyId ?? undefined, entity: "wallet", entityId: wallet.id, detail: { amount, reason, note, expiresAt, balanceAfter: wallet.balance } });
    return NextResponse.json({ ok: true, entry, wallet });
  } catch (e) { return billingError(e); }
}
