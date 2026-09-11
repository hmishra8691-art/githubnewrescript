import { NextRequest, NextResponse } from "next/server";
import { Rate, DEFAULT_RATES } from "@rescript/billing";
import { audit } from "@/lib/guard";
import { requireBillingAdmin, billingError } from "@/lib/billingAdmin";

export const dynamic = "force-dynamic";

/**
 * THE COST & PRICING REGISTRY (billing brief §8).
 *   GET     → every rate (stored rows, or the shipped defaults when none are stored) + the defaults
 *   PUT     → upsert one rate { rate }
 *   DELETE  → ?id=  remove a rate
 * The first PUT seeds the stored table with the defaults so an edit never hides the rest.
 */
export async function GET(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  try {
    gate.meter.invalidate();
    const stored = await gate.meter.store.loadRates();
    return NextResponse.json({ ok: true, rates: stored && stored.length ? stored : DEFAULT_RATES, stored: !!(stored && stored.length), defaults: DEFAULT_RATES });
  } catch (e) { return billingError(e); }
}

export async function PUT(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const parsed = Rate.safeParse(body?.rate);
  if (!parsed.success) return NextResponse.json({ error: "invalid rate", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  try {
    const stored = await gate.meter.store.loadRates();
    if (!stored || !stored.length) for (const r of DEFAULT_RATES) await gate.meter.store.saveRate(r);
    await gate.meter.store.saveRate(parsed.data);
    gate.meter.invalidate();
    if (gate.user) await audit({ action: "billing.rate_changed", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, entity: "billing_rate", entityId: parsed.data.id, detail: parsed.data });
    return NextResponse.json({ ok: true, rate: parsed.data, rates: await gate.meter.rates() });
  } catch (e) { return billingError(e); }
}

export async function DELETE(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    const stored = await gate.meter.store.loadRates();
    if (!stored || !stored.length) for (const r of DEFAULT_RATES) await gate.meter.store.saveRate(r);
    await gate.meter.store.deleteRate(id);
    gate.meter.invalidate();
    if (gate.user) await audit({ action: "billing.rate_changed", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, entity: "billing_rate", entityId: id, detail: { deleted: true } });
    return NextResponse.json({ ok: true, rates: await gate.meter.rates() });
  } catch (e) { return billingError(e); }
}
