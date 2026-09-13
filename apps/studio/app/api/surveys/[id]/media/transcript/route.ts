import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";
import { mediaDbOrResponse, projectStt } from "@/lib/mediaRoute";
import { transcribe, aiProviderName } from "@rescript/ai";
import { runTranscription, transcriptFor, queueTranscript, stageLogger, TRANSCRIPT_SAY, transcriptPending, MediaError, type TranscriptStatus } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/*
 * Five minutes of speech takes a provider twenty to sixty seconds and the
 * default function timeout is ten. Every other long route in this app says
 * 60; this one is the longest thing the Studio does, so it says the maximum.
 * The durable job row means a timeout here is a delay rather than a loss —
 * the next poll reclaims it — but there is no reason to make that the
 * ordinary path.
 */
export const maxDuration = 300;

/**
 * THE TRANSCRIPT OF A RECORDING: ITS STATE, AND THE BUTTON THAT ADVANCES IT.
 *
 * GET answers "what is happening", which the Question Builder polls while a
 * transcript is in flight. POST drives the job — the same call whether it is
 * the first attempt, a retry after a failure, or a rescue of a job whose
 * runner was killed mid-flight by a function timeout. It is safe to call
 * repeatedly: the claim happens in SQL and a job somebody else holds is not
 * taken, so a researcher leaning on "Retry" cannot be billed twice for the
 * same audio.
 */
function payload(row: { status: TranscriptStatus; text: string | null; error: string | null; attempts: number; completed_at: string | null; language: string | null; model: string | null; media_id: string } | null) {
  if (!row) return { status: null, pending: false };
  return {
    mediaId: row.media_id,
    status: row.status,
    say: TRANSCRIPT_SAY[row.status],
    pending: transcriptPending(row.status),
    text: row.text,
    error: row.error,
    attempts: row.attempts,
    language: row.language,
    model: row.model,
    completedAt: row.completed_at,
  };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const mediaId = req.nextUrl.searchParams.get("mediaId") ?? "";
  if (!mediaId) return NextResponse.json({ error: "mediaId required" }, { status: 400 });

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;

  try {
    const row = await transcriptFor(handle.db, mediaId);
    if (row && row.survey_id !== params.id) return NextResponse.json({ error: "no such recording" }, { status: 404 });
    return NextResponse.json({ ok: true, transcript: payload(row as never) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty retry body is fine */ }
  const mediaId = String(body.mediaId ?? req.nextUrl.searchParams.get("mediaId") ?? "").trim();
  if (!mediaId) return NextResponse.json({ error: "mediaId required" }, { status: 400 });

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  const db = handle.db;

  try {
    const { data: owned } = await db.from("media_objects").select("id, survey_id, status").eq("id", mediaId).maybeSingle();
    if (!owned || owned.survey_id !== params.id) return NextResponse.json({ error: "no such recording" }, { status: 404 });
    if (owned.status !== "stored") {
      return NextResponse.json({ error: "that recording has not finished uploading yet" }, { status: 409 });
    }

    /* a retry on a recording that was never queued should queue it */
    await queueTranscript(db, mediaId, params.id);

    if (!aiProviderName()) {
      return NextResponse.json({ error: "transcription is not configured on this installation" }, { status: 501 });
    }

    const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : undefined;
    const outcome = await runTranscription(db, mediaId, {
      transcribe: (bytes, opts) => transcribe(bytes, opts),
      metered: projectStt(gate, "transcribe_question"),
      language,
      provider: aiProviderName() ?? undefined,
      log: stageLogger(`survey:${params.id}`),
    });

    const row = await transcriptFor(db, mediaId);
    return NextResponse.json({ ok: true, ran: outcome.ran, transcript: payload(row as never) });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
