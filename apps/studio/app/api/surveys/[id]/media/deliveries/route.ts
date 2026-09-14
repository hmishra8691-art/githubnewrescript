import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject, audit } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import {
  retryDelivery,
  DELIVERY_SAY,
  deliveryStalled,
  RETENTION_HOURS,
  type DeliveryStatus,
} from "@rescript/media/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WHAT HAPPENED TO THE RECORDINGS.
 *
 * Delivery runs on a cron, which means it runs where nobody is looking — and
 * a process nobody can see is a process nobody trusts. This is the window
 * into it: one row per respondent, what state it reached, when the email went
 * out, whether anyone opened it, when the media goes or went.
 *
 * `project.read` to look, `responses.manage` to retry. Retrying re-sends a
 * respondent's recordings to a mailbox, which is a decision about someone's
 * data rather than about the questionnaire — the same right that governs
 * deleting and exporting response data governs this.
 */

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const { data: survey } = await db
    .from("surveys")
    .select("media_delivery_email, media_delivery_enabled")
    .eq("id", params.id)
    .maybeSingle();

  const { data, error } = await db.rpc("rescript_media_delivery_status", { p_survey: params.id });
  if (error) {
    /* the feature simply is not migrated yet — that is a state, not a fault */
    if (/rescript_media_delivery_status|media_deliveries|does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ ok: true, migration: "0029", configured: false, retentionHours: RETENTION_HOURS, deliveries: [] });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deliveries = ((data ?? []) as any[]).map((d) => ({
    id: d.id,
    respondent: d.respondent_label ?? String(d.session_id ?? "").slice(0, 8),
    recipient: d.recipient_email,
    status: d.status as DeliveryStatus,
    say: DELIVERY_SAY[d.status as DeliveryStatus] ?? d.status,
    canRetry: deliveryStalled(d.status as DeliveryStatus),
    mediaCount: Number(d.media_count ?? 0),
    totalBytes: Number(d.total_bytes ?? 0),
    attempts: Number(d.attempts ?? 0),
    error: d.error ?? null,
    emailSentAt: d.email_sent_at,
    downloadedAt: d.downloaded_at,
    downloadCount: Number(d.download_count ?? 0),
    expiresAt: d.expires_at,
    deletedAt: d.deleted_at,
    createdAt: d.created_at,
  }));

  return NextResponse.json({
    ok: true,
    retentionHours: RETENTION_HOURS,
    configured: !!survey?.media_delivery_enabled && !!survey?.media_delivery_email,
    recipient: survey?.media_delivery_email ?? null,
    deliveries,
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (body?.action !== "retry" || typeof body?.deliveryId !== "string") {
    return NextResponse.json({ error: "send { action: 'retry', deliveryId }" }, { status: 400 });
  }

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;

  /*
   * Check the delivery belongs to THIS project before touching it. The id
   * came from the caller, and `requireProject` proved their right to this
   * survey — not to whatever row they named.
   */
  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from("media_deliveries")
    .select("id, survey_id, status")
    .eq("id", body.deliveryId)
    .maybeSingle();
  if (!row || row.survey_id !== params.id) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (row.status !== "failed") {
    return NextResponse.json({ error: `Only a failed delivery can be retried — this one is ${row.status}.` }, { status: 409 });
  }

  await retryDelivery(handle.db, body.deliveryId);

  await audit({
    action: "survey.modified",
    userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "media_delivery", entityId: body.deliveryId,
    detail: { summary: "queued a failed qualitative media delivery to be sent again" },
  });

  return NextResponse.json({ ok: true, note: "Queued. The next delivery run will try again." });
}
