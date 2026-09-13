import { NextRequest, NextResponse } from "next/server";
import { sessionForMedia } from "@/lib/aiSession";
import { mediaDbOrResponse, sessionStt } from "@/lib/mediaRoute";
import { aiProviderName } from "@/lib/ai";
import { transcribe } from "@rescript/ai";
import { savesAudio } from "@rescript/engine";
import {
  runTranscription, transcriptFor, queueTranscript, removeMedia, stageLogger,
  TRANSCRIPT_SAY, transcriptPending, MediaError, type TranscriptStatus,
} from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/* the same 300s the Studio's transcript route takes, for the same reason */
export const maxDuration = 300;

/**
 * THE TRANSCRIPT OF AN ANSWER: ITS STATE, AND THE BUTTON THAT ADVANCES IT.
 *
 * POST drives the job and is what the renderer calls the moment a clip is
 * confirmed; GET is what it polls while the job is still running. A
 * respondent is never blocked on either — the answer was complete when the
 * audio was stored — but a researcher's "Retry transcription" and a
 * respondent's own retry are the same call, and both work from the stored
 * clip rather than from a recording nobody has any more.
 */
function payload(row: { status: TranscriptStatus; text: string | null; error: string | null; attempts: number; language: string | null; model: string | null; media_id: string; completed_at: string | null } | null) {
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

async function gateFor(body: Record<string, unknown>) {
  const gate = await sessionForMedia(body);
  if ("response" in gate) return gate;
  if (!gate.row) return { response: NextResponse.json({ error: "a preview has no stored recordings" }, { status: 403 }) };
  return gate;
}

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId") ?? "";
  const mediaId = req.nextUrl.searchParams.get("mediaId") ?? "";
  if (!mediaId) return NextResponse.json({ error: "mediaId required" }, { status: 400 });

  const gate = await gateFor({ sessionId });
  if ("response" in gate) return gate.response;

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;

  try {
    const { data: owned } = await handle.db.from("media_objects").select("id, session_id").eq("id", mediaId).maybeSingle();
    if (!owned || owned.session_id !== gate.row!.sessionId) return NextResponse.json({ error: "no such recording" }, { status: 404 });
    const row = await transcriptFor(handle.db, mediaId);
    return NextResponse.json({ ok: true, transcript: payload(row as never) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected a JSON body" }, { status: 400 }); }

  const gate = await gateFor(body);
  if ("response" in gate) return gate.response;

  const mediaId = String(body.mediaId ?? "").trim();
  const questionId = String(body.questionId ?? "").trim();
  if (!mediaId) return NextResponse.json({ error: "mediaId required" }, { status: 400 });

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  const db = handle.db;

  try {
    const { data: owned } = await db.from("media_objects").select("id, session_id, status, bucket, path").eq("id", mediaId).maybeSingle();
    if (!owned || owned.session_id !== gate.row!.sessionId) return NextResponse.json({ error: "no such recording" }, { status: 404 });
    if (owned.status !== "stored") return NextResponse.json({ error: "that recording has not finished uploading yet" }, { status: 409 });

    if (!aiProviderName()) return NextResponse.json({ ok: true, transcript: { status: null, pending: false } });

    await queueTranscript(db, mediaId, gate.row!.surveyId);

    const q = questionId ? gate.def.questions.find((x) => x.id === questionId) ?? null : null;
    const language = (q?.settings.transcriptLanguage as string | undefined)
      || gate.def.localization?.sourceLanguage
      || undefined;

    const outcome = await runTranscription(db, mediaId, {
      transcribe: (bytes, opts) => transcribe(bytes, opts),
      metered: sessionStt(gate.billing, "transcribe_answer"),
      language,
      provider: aiProviderName() ?? undefined,
      log: stageLogger(`session:${gate.row!.sessionId.slice(0, 8)}`),
    });

    const row = await transcriptFor(db, mediaId);

    /*
     * `saveAnswerAudio: false` — the researcher asked for the words and not
     * the voice. The clip had to exist to be read; now that the words are
     * kept it goes, which is the only point at which discarding it is safe.
     */
    if (q && !savesAudio(q) && row?.status === "completed") {
      await removeMedia(db, [{ id: owned.id, bucket: owned.bucket, path: owned.path }]);
    }

    return NextResponse.json({ ok: true, ran: outcome.ran, transcript: payload(row as never) });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
