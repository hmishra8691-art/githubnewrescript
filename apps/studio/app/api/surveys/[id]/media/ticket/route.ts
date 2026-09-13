import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireEditRight } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { beginUpload, MediaError, stageLogger, type MediaKind } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PERMISSION TO STORE ONE RECORDING.
 *
 * The browser used to POST the whole video to us and we forwarded it to
 * object storage. That cannot work: a serverless host refuses a request body
 * of this size (4.5 MB on Vercel) long before any route of ours runs, so a
 * researcher recording anything longer than about twenty seconds got a
 * platform error page — which, having no JSON body, surfaced as the useless
 * "The video could not be saved (413)". The route's own carefully worded
 * limit was unreachable on the deployment it was written for.
 *
 * So the bytes no longer come through us at all. This route writes down that
 * a recording is about to exist and returns a signed URL good for exactly one
 * object at exactly one path. The browser PUTs straight to storage; we are
 * told afterwards, and we verify rather than believe (see `confirm`).
 *
 * Writing the row BEFORE the upload is what makes a failed upload findable: a
 * row still at `pending` an hour later is a browser that closed mid-transfer,
 * and it is the only evidence that would exist.
 *
 * `survey.edit` on the project: recording the question IS writing the
 * question.
 */
const KINDS: readonly MediaKind[] = ["question_video", "question_audio"];

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected a JSON body" }, { status: 400 }); }

  const kind = String(body.kind ?? "question_video") as MediaKind;
  if (!KINDS.includes(kind)) return NextResponse.json({ error: `a survey cannot store ${kind} here` }, { status: 400 });
  const questionId = String(body.questionId ?? "").trim();
  if (!questionId) return NextResponse.json({ error: "questionId required" }, { status: 400 });

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;

  const log = stageLogger(`survey:${params.id}`);
  try {
    const ticket = await beginUpload(handle.db, {
      kind,
      customerId: gate.survey.customer_id ?? gate.user.customerId!,
      surveyId: params.id,
      questionId,
      fileName: typeof body.fileName === "string" ? body.fileName : null,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : null,
      bytes: Number(body.bytes) || null,
      durationSeconds: Number(body.durationSeconds) || null,
      width: Number(body.width) || null,
      height: Number(body.height) || null,
    });
    log("upload_url_issued", { mediaId: ticket.mediaId, kind, questionId, bytes: Number(body.bytes) || null });
    return NextResponse.json({ ok: true, ...ticket });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
