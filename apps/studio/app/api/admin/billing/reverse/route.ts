import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/guard";
import { requireBillingAdmin, billingError } from "@/lib/billingAdmin";

export const dynamic = "force-dynamic";

/** REVERSE ONE USAGE EVENT (billing brief §9): a reversal row beside the original, the wallet credited back. POST { eventId, note } */
export async function POST(req: NextRequest) {
  const gate = await requireBillingAdmin(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const eventId = typeof body?.eventId === "string" ? body.eventId : "";
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 2000) : "";
  if (!eventId || !note) return NextResponse.json({ error: "eventId and a note are required" }, { status: 400 });
  try {
    const r = await gate.meter.reverse(eventId, gate.user?.userId ?? null, note);
    if (!r) return NextResponse.json({ error: "That usage event cannot be reversed (unknown, or already a reversal)." }, { status: 409 });
    if (gate.user) await audit({ action: "billing.usage_reversed", userId: gate.user.userId, sessionId: gate.user.sessionId, customerId: gate.user.customerId, surveyId: r.reversal.surveyId ?? undefined, entity: "usage_event", entityId: eventId, detail: { note, amount: -r.reversal.customerCharge } });
    return NextResponse.json({ ok: true, reversal: r.reversal, entry: r.entry });
  } catch (e) { return billingError(e); }
}
