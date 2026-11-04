import { NextRequest, NextResponse } from "next/server";
import { verifyWebhook, normaliseEvent, webhookIdempotencyKey, WEBHOOK_SPECS } from "@rescript/recruitment";
import { supabaseService } from "@/lib/authServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE VENDOR WEBHOOK DOOR (Phase 6).
 *
 *   POST /api/webhooks/vendors/<vendor>
 *
 * This is the one endpoint in the platform an unauthenticated stranger is invited to call, and what arrives
 * through it decides whether a supplier gets paid. Four rules follow from that.
 *
 * 1. THE RAW BODY IS READ FIRST, before anything parses it. The signature covers the exact bytes sent; parse
 *    and re-serialise and a genuine event is rejected as a forgery.
 * 2. NOTHING IS DROPPED. A forged, stale or unsigned delivery is stored with its verdict and quarantined.
 *    Silence makes a probing attacker and a misconfigured integration look identical — and both look like
 *    nothing at all.
 * 3. THE DATABASE DE-DUPLICATES, not this route. `rescript_webhook_receive` contends on a unique index, so two
 *    retries landing in the same instant cannot both be "new". A select-then-insert here would lose that race.
 * 4. 200 IS RETURNED FOR ANYTHING RECEIVED, including a rejected one. A non-2xx tells the vendor to retry, and
 *    retrying a forgery forever is pointless; retrying a stale event cannot make it fresh. The verdict is in
 *    the body, and a vendor that is genuinely misconfigured finds out from the receipt log, not from a 500.
 *
 * There is no `requireUser` here, which is the point, and `scripts/auth-guard-audit.mjs` carries the reason
 * alongside the panel callback it resembles.
 */

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(req: NextRequest, context: { params: Promise<{ vendor: string }> }) {
  const { vendor: rawVendor } = await context.params;
  const vendor = String(rawVendor ?? "").toLowerCase().slice(0, 48);

  /*
   * An unknown vendor is refused before the body is even read. There is no signing scheme for it, so nothing
   * it sends could be trusted, and reading the body would only let a stranger fill the receipts table.
   */
  if (!Object.prototype.hasOwnProperty.call(WEBHOOK_SPECS, vendor)) {
    return NextResponse.json({ error: "unknown vendor" }, { status: 404 });
  }

  // THE RAW BYTES. Nothing may parse this request before the signature is checked over them.
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  const db = supabaseService();

  /*
   * The secret lives sealed beside the integration, like every other credential (0081). One query, by vendor
   * slug, because the delivery carries no customer identity — that is what the signature establishes.
   */
  const { data: integration } = await db
    .from("vendor_integrations")
    .select("id, customer_id, credentials_sealed, panel_vendors!inner(slug)")
    .eq("panel_vendors.slug", vendor)
    .eq("enabled", true)
    .limit(1)
    .maybeSingle();

  const row = integration as { id?: string; customer_id?: string; credentials_sealed?: string | null } | null;
  const secret = process.env.VENDOR_WEBHOOK_SECRET?.trim() || null;

  const envelope = verifyWebhook({ vendor, rawBody, headers, secret });

  let parsed: unknown = null;
  if (envelope.verdict === "verified") {
    // only now, after the bytes have been vouched for, is it safe to parse them
    try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { parsed = null; }
  }
  const event = normaliseEvent(vendor, parsed);

  const { data: receipt, error } = await db.rpc("rescript_webhook_receive", {
    p_customer: row?.customer_id ?? null,
    p_integration: row?.id ?? null,
    p_vendor: vendor,
    p_event_id: envelope.eventId,
    p_verdict: envelope.verdict,
    p_reason: envelope.reason ?? null,
    p_body: parsed ?? (rawBody ? { unparsed: rawBody.slice(0, 2000) } : {}),
    p_order_ref: event.vendorOrderRef,
    p_participant: event.participantId,
    p_signed_at: envelope.timestamp ? new Date(Number(envelope.timestamp) * 1000).toISOString() : null,
  });

  if (error) {
    /*
     * A storage failure IS worth a 500: the event has not been recorded, so the vendor retrying is exactly what
     * should happen. This is the one case where asking for a retry is right.
     */
    return NextResponse.json({ error: "could not record the event" }, { status: 500 });
  }

  const r = (Array.isArray(receipt) ? receipt[0] : receipt) as
    { receipt_id?: string; is_new?: boolean; processing?: string } | null;

  return NextResponse.json({
    received: true,
    verdict: envelope.verdict,
    /* the vendor is told whether this was new, which helps them reconcile their own retry log */
    duplicate: r?.is_new === false,
    idempotencyKey: envelope.eventId ? webhookIdempotencyKey(vendor, envelope.eventId) : null,
    ...(envelope.actionable ? {} : { quarantined: true, reason: envelope.reason }),
  }, { status: 200, headers: { "cache-control": "no-store" } });
}

/** A GET is how operators and vendors check a URL is live before configuring it. It reveals nothing. */
export async function GET(_req: NextRequest, context: { params: Promise<{ vendor: string }> }) {
  const { vendor } = await context.params;
  const known = Object.prototype.hasOwnProperty.call(WEBHOOK_SPECS, String(vendor ?? "").toLowerCase());
  return NextResponse.json({ ok: known, vendor, method: "POST" }, { status: known ? 200 : 404 });
}
