import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { beginUpload, mediaLimits, MediaError, stageLogger, RECORDING_CONSTRAINTS, type MediaKind } from "@rescript/media";

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
/*
 * What a researcher may store against a survey: the question's video and its
 * audio track, a recorded or generated reading (`localization_audio`, which
 * used to travel through a multipart POST to `/audio`), and an attached
 * image, PDF or document (`survey_asset`, which used to be a pasted URL).
 */
const KINDS: readonly MediaKind[] = ["question_video", "question_audio", "localization_audio", "survey_asset"];

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
      clientToken: typeof body.clientToken === "string" ? body.clientToken : null,
    });
    log("upload_url_issued", { mediaId: ticket.mediaId, kind, questionId, bytes: Number(body.bytes) || null, parts: ticket.partCount, resumed: ticket.uploaded.length > 0 });
    return NextResponse.json({ ok: true, ...ticket });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * WHAT STORAGE WILL ACTUALLY ACCEPT.
 *
 * Asked before the camera is opened, so the recorder offers a length that can
 * be stored rather than discovering the ceiling after the interview. A
 * Supabase project has a global upload limit — 50 MB by default — and no
 * bucket may exceed it, so the number this package would like is not
 * necessarily the number that applies.
 *
 * A failure here is not fatal: the recorder falls back to its own constants
 * and the upload is still judged on the server.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;

  try {
    const video = await mediaLimits(handle.db, "question_video");
    const audio = await mediaLimits(handle.db, "question_audio");
    return NextResponse.json({
      ok: true,
      video,
      audio,
      /* the smaller of what storage allows and what this recorder will do */
      maxSeconds: Math.min(video.maxSeconds, RECORDING_CONSTRAINTS.maxSeconds),
    });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
