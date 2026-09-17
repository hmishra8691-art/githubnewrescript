import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/admin";
import { mediaDb } from "@/lib/mediaRoute";
import { sendMail } from "@/lib/mail";
import { mediaDeliveryEmail } from "@rescript/mail";
import { removeMedia } from "@rescript/media";
import {
  findDue,
  openDelivery,
  claimDelivery,
  sessionMedia,
  buildManifest,
  markSent,
  markFailed,
  findExpiring,
  expireLink,
  markDeleted,
  mintDownloadToken,
  expiryFrom,
  hoursRemaining,
  RETENTION_HOURS,
  type DeliveryFile,
} from "@rescript/media/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* packaging reads every object in a session; a long sitting is not quick */
export const maxDuration = 300;

/**
 * THE ONLY THING IN THIS PLATFORM THAT RUNS WITHOUT A BROWSER.
 *
 * Everything else here is driven by somebody's open tab — transcription
 * included, which is why a respondent who closes the page mid-upload leaves a
 * job nothing ever picks up. This route is the first piece of work that has
 * to happen whether or not anyone is watching, because the two promises the
 * feature makes are both about time passing:
 *
 *   · the researcher will get an email, even if the send failed the first
 *     time and nobody was there to press retry;
 *   · the recording will be gone in 48 hours, even if nobody asked.
 *
 * A promise that only holds while a tab is open is not a promise.
 *
 * ## Three phases, in this order, every run
 *
 *   1. EXPIRE first. If the run dies halfway through, the thing that should
 *      have happened is the deletion, not another email. Overdue media is a
 *      broken promise; a delayed delivery is a delay.
 *   2. DISCOVER completed responses that have media and no delivery row.
 *   3. SEND the ones that are ready, oldest first.
 *
 * ## Why it discovers rather than being told
 *
 * The route that finalises a response is the last thing between a respondent
 * and a finished survey. An insert there that fails would either lose the
 * delivery silently or fail somebody's submission over an email, so nothing
 * was added to it. The cost is a query per run; the gain is that a response
 * completed while this route was broken, or before the feature existed, is
 * picked up on the next run instead of being lost.
 */

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  /*
   * No secret, no run. An unauthenticated route that deletes media and sends
   * mail is worse than a feature that has not shipped: refusing is the safe
   * default, and the deploy that forgets the variable finds out immediately.
   */
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered);
  const b = Buffer.from(secret);
  // length differs → not equal, and timingSafeEqual would throw
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Report {
  expired: number;
  deleted: number;
  discovered: number;
  sent: number;
  failed: number;
  warnings: string[];
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }

  let db;
  try {
    db = mediaDb();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const report: Report = { expired: 0, deleted: 0, discovered: 0, sent: 0, failed: 0, warnings: [] };

  /* ------------------------------------------------------- 1. expire */

  try {
    for (const due of await findExpiring(db, 50)) {
      /*
       * The link dies before the bytes do. If storage refuses the delete, the
       * promise in the email is still kept — the link is already dead — and
       * the next run tries the bytes again. The other order leaves a window
       * where a link that should have expired still works.
       */
      await expireLink(db, due.id);
      report.expired++;

      const files = (due.manifest ?? []) as DeliveryFile[];
      const rows = files.map((f) => ({ id: f.mediaId, bucket: f.bucket, path: f.path }));
      if (!rows.length) {
        await markDeleted(db, due.id, []);
        report.deleted++;
        continue;
      }
      /*
       * `removeMedia` deletes the storage object AND the `media_objects` row,
       * which cascades to `media_transcripts`. That is correct and it is not
       * a loss: by 0028 the transcript became the ANSWER VALUE inside
       * `responses.answers` when it completed, so what is being deleted here
       * is the transcription JOB, not the transcript. The response keeps its
       * text, its quality scores and its exports.
       */
      const purge = await removeMedia(db, rows, "delivered");
      /*
       * DELETED MEANS DELETED. `removeMedia` now confirms each object gone
       * with a HEAD and keeps the row of any that is not; the delivery is
       * marked deleted only when every object went. Otherwise it stays
       * `expired` — the link is already dead — and the next run tries the
       * remaining bytes again, which is what the email promised.
       */
      if (purge.objects >= rows.length) {
        await markDeleted(db, due.id, purge.warnings);
        report.deleted++;
      } else {
        report.warnings.push(`delivery ${due.id}: ${rows.length - purge.objects} of ${rows.length} objects still in storage; will retry`);
      }
      if (purge.warnings.length) report.warnings.push(...purge.warnings.slice(0, 3));
    }
  } catch (e) {
    report.warnings.push(`expiry: ${(e as Error).message}`);
  }

  /* ----------------------------------------------------- 2. discover */

  const queue: string[] = [];
  try {
    for (const due of await findDue(db, 25)) {
      const row = await openDelivery(db, due);
      if (row) { queue.push(row.id); report.discovered++; }
    }
  } catch (e) {
    report.warnings.push(`discovery: ${(e as Error).message}`);
  }

  /* the backlog too: anything pending, or failed and past its backoff */
  try {
    const { data } = await db.from("media_deliveries")
      .select("id")
      .in("status", ["pending", "processing", "failed"])
      .order("created_at", { ascending: true })
      .limit(25);
    for (const r of (data ?? []) as { id: string }[]) {
      if (!queue.includes(r.id)) queue.push(r.id);
    }
  } catch (e) {
    report.warnings.push(`backlog: ${(e as Error).message}`);
  }

  /* --------------------------------------------------------- 3. send */

  const admin = supabaseAdmin();
  const base = (process.env.STUDIO_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

  for (const id of queue) {
    let manifest: DeliveryFile[] | undefined;
    let attempt = 1;
    try {
      const claimed = await claimDelivery(db, id);
      if (claimed) attempt = claimed.attempts;
      if (!claimed) continue;   // another run has it, or it is out of attempts

      if (!base) {
        await markFailed(db, id, "STUDIO_PUBLIC_URL is not set, so no download link can be built", undefined, claimed.attempts);
        report.failed++;
        continue;
      }

      const { data: survey } = await admin
        .from("surveys")
        .select("title, code, client_name, media_delivery_email, media_delivery_enabled")
        .eq("id", claimed.survey_id)
        .maybeSingle();

      /*
       * Read the address again at send time rather than trusting the one
       * copied onto the row at discovery. Between the two, somebody may have
       * corrected a typo or switched delivery off — and a researcher who
       * turns this off expects it to stop, including for work already queued.
       */
      if (!survey?.media_delivery_enabled || !survey?.media_delivery_email) {
        await markFailed(db, id, "delivery was switched off for this project before the email went out", undefined, claimed.attempts);
        report.failed++;
        continue;
      }
      const recipient = String(survey.media_delivery_email);

      const { data: response } = await admin
        .from("responses")
        .select("completed_at, respondent_code")
        .eq("id", claimed.response_id)
        .maybeSingle();

      const files = await sessionMedia(db, claimed.session_id);
      if (!files.length) {
        await markFailed(db, id, "no stored media was found for this response", undefined, claimed.attempts);
        report.failed++;
        continue;
      }

      const projectName = String(survey.title || survey.code || "Project");
      const label = claimed.respondent_label || String(response?.respondent_code ?? claimed.session_id.slice(0, 8));
      manifest = buildManifest({ projectName, respondentLabel: label, files });

      const { token, hash } = mintDownloadToken();
      const now = new Date();
      const expiresAt = expiryFrom(now);
      const url = `${base}/d/${id}?k=${encodeURIComponent(token)}`;

      const mail = mediaDeliveryEmail({
        projectName,
        surveyName: survey.client_name ? String(survey.title) : null,
        respondentLabel: label,
        fileCount: manifest.length,
        respondedAt: String(response?.completed_at ?? now.toISOString()),
        expiresAt: expiresAt.toISOString(),
        hoursRemaining: hoursRemaining(expiresAt, now),
        url,
        totalBytes: manifest.reduce((n, f) => n + (f.bytes || 0), 0),
        questions: [...new Set(manifest.map((f) => f.questionId).filter(Boolean) as string[])],
      });

      const out = await sendMail({
        to: recipient,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        kind: "media_delivery",
        /*
         * One email per delivery, ever. The row is already uniquely keyed by
         * response, but a retry after a partial failure could otherwise send
         * a second link for the same recordings — and two links, one of which
         * silently stopped working, is worse than one.
         */
        dedupeKey: `media_delivery:${id}`,
        surveyId: claimed.survey_id,
        customerId: claimed.customer_id,
      });

      if (!out.sent) {
        /*
         * `duplicate` means this delivery was already emailed and something
         * lost the acknowledgement. Treating it as a failure would retry
         * forever against a dedupe key that can never clear; treating it as
         * sent is the truth.
         */
        if (out.reason === "duplicate") {
          await markSent(db, id, { manifest, tokenHash: hash, expiresAt });
          report.sent++;
          continue;
        }
        await markFailed(db, id, `email not sent (${out.reason}${out.detail ? `: ${out.detail}` : ""})`, manifest, claimed.attempts);
        report.failed++;
        continue;
      }

      /*
       * The token hash is written only now. Until the email is actually away
       * there is no link in anyone's hands, and a live credential for an
       * email that was never sent is a hole with nothing on the other side.
       */
      await markSent(db, id, { manifest, tokenHash: hash, expiresAt, providerId: out.providerId });
      report.sent++;
    } catch (e) {
      report.failed++;
      try { await markFailed(db, id, (e as Error).message, manifest, attempt); } catch { /* reported below */ }
      report.warnings.push(`${id}: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({ ok: true, retentionHours: RETENTION_HOURS, ...report });
}
