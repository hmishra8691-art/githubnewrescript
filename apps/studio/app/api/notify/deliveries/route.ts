import { NextRequest } from "next/server";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { notifyActor, noStore } from "@/lib/notify/access";
import { notifyStore } from "@/lib/notify/server";

export const dynamic = "force-dynamic";

/**
 * THE ALERT DELIVERY LOG (2026-10-22, G3) — every event × destination: status (sent / failed / retrying / skipped as a
 * duplicate / held for a digest / digested / not configured), attempts, the next retry, the endpoint's status, the
 * error. Destinations are what a screen may show (an address, "user:<id>", "#research-ops") — never a webhook URL.
 *
 *   GET ?surveyId=…   one project's (the project's responses.read)
 *   GET               the organisation's (its members)
 */
export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = notifyActor(authed);
  if (isFailure(actor)) return actor.response;
  const surveyId = req.nextUrl.searchParams.get("surveyId");
  const limit = Math.min(500, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 100));
  if (surveyId && !actor.sandbox) {
    const gate = await requireProjectFor(actor.user!, surveyId, "responses.read");
    if (isFailure(gate)) return gate.response;
  }
  const rows = await notifyStore().listDeliveries({ customerId: surveyId ? null : actor.customerId, surveyId: surveyId || null, limit });
  return noStore({ ok: true, deliveries: rows.map((d) => ({ id: d.id, eventType: d.eventType, channel: d.channelKind, destination: d.destination, status: d.status, reason: d.reason, attempts: d.attempts, nextAttemptAt: d.nextAttemptAt, responseStatus: d.responseStatus, error: d.lastError, test: d.isTest, createdAt: d.createdAt, sentAt: d.sentAt, digest: d.digest })) });
}
