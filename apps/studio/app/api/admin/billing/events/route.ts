import { NextRequest, NextResponse } from "next/server";
import { BillableEventDef } from "@rescript/billing";
import { audit } from "@/lib/guard";
import { requireBillingAdmin, billingError } from "@/lib/billingAdmin";

export const dynamic = "force-dynamic";

/**
 * THE BILLABLE EVENT REGISTRY (billing brief §6, §22).
 *   GET → every event the platform knows (defaults merged with stored overrides)
 *   PUT → { event } upsert: billable / non-billable, unit, category, rate reference, active
 */
export async function GET(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  try { gate.meter.invalidate(); return NextResponse.json({ ok: true, events: await gate.meter.events() }); } catch (e) { return billingError(e); }
}

export async function PUT(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const parsed = BillableEventDef.safeParse(body?.event);
  if (!parsed.success) return NextResponse.json({ error: "invalid event", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  try {
    await gate.meter.store.saveEvent(parsed.data);
    gate.meter.invalidate();
    if (gate.user) await audit({ action: "billing.event_changed", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, entity: "billing_event", entityId: parsed.data.type, detail: parsed.data });
    return NextResponse.json({ ok: true, event: parsed.data, events: await gate.meter.events() });
  } catch (e) { return billingError(e); }
}
