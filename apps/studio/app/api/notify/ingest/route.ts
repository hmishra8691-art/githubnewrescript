import { NextRequest, NextResponse } from "next/server";
import { verifySignedHeader } from "@rescript/ai";
import { ingestKey, notifyDeps, notifySandbox, notifyStore } from "@/lib/notify/server";
import { emitNotifyEvent, processEvent, runDue } from "@/lib/notify/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * EVENTS FROM THE RESPONDENT RUNTIME (2026-10-22, G3) — an AI interview's distress / abuse / injection flag, its
 * completion, a quota or target reached, the study budget, a provider fallback, a group-session flag. The runtime
 * has no session and is not a person, so this route is authenticated by a SIGNATURE instead:
 * `x-rescript-ingest: t=<unix>,v1=<HMAC-SHA256(key, "t.body")>` with a sub-key of INTEGRATIONS_SECRET_KEY (both apps
 * hold it), checked over the raw body in the handler's first statement, five-minute replay window; refused
 * entirely when the key is unset.
 *
 *   POST { eventId }    the runtime already wrote the 0072 outbox row: deliver it now
 *   POST { event }      an event to write and deliver (the runtime could not write the outbox)
 *
 * THE SANDBOX (no database, fake provider, not production) accepts `{ event }` unsigned: the runtime forwards its
 * sandbox events here server to server, as it forwards group-session participants.
 */
async function authorised(req: NextRequest, raw: string): Promise<boolean> {
  if (notifySandbox()) return true;
  const key = ingestKey();
  return !!key && verifySignedHeader(key, req.headers.get("x-rescript-ingest"), raw);
}

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => ""); if (raw.length > 64_000 || !(await authorised(req, raw))) return NextResponse.json({ error: "not authorised" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const store = notifyStore();
  const deps = notifyDeps(store);
  try {
    if (typeof body.eventId === "string" && !notifySandbox()) {
      const claimed = await store.claimEvents(1, body.eventId);
      const deliveries = claimed.length ? await processEvent(deps, claimed[0]) : [];
      await runDue(deps, { limit: 20 }).catch(() => null);
      return NextResponse.json({ ok: true, delivered: deliveries.map((d) => ({ channel: d.channelKind, status: d.status })) }, { headers: { "cache-control": "no-store" } });
    }
    const ev = body.event as Record<string, unknown> | undefined;
    if (!ev || typeof ev !== "object") return NextResponse.json({ error: "send { eventId } or { event }" }, { status: 400 });
    const r = await emitNotifyEvent(deps, { ...(ev as Record<string, unknown>), source: "runtime" } as never);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    await runDue(deps, { limit: 20 }).catch(() => null);
    return NextResponse.json({ ok: true, eventId: r.eventId, inserted: r.inserted, delivered: r.deliveries.map((d) => ({ channel: d.channelKind, status: d.status })) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("[rescript:notify] ingest failed", JSON.stringify({ error: (e as Error).message.slice(0, 200) }));
    return NextResponse.json({ error: "the event could not be delivered now; it stays in the outbox for the scheduled pass" }, { status: 500 });
  }
}
