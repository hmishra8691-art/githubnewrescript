import { NextRequest, NextResponse } from "next/server";
import { sessionForMedia } from "@/lib/aiSession";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { beginUpload, MediaError, stageLogger, type MediaKind } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PERMISSION TO STORE ONE RESPONDENT RECORDING.
 *
 * Same reasoning as the Studio's ticket route: the bytes go straight from the
 * browser to object storage on a signed URL, because a serverless host
 * refuses a request body over 4.5 MB and the Studio offers answer lengths up
 * to thirty minutes. A five-minute answer at the bitrate the recorder now
 * uses is 2.4 MB and would have squeaked through; a fifteen-minute one at the
 * browser's default would not, and "it worked in testing" is not a limit.
 *
 * A preview has no session and therefore no storage: the renderer keeps the
 * clip as an object URL, exactly as it did before, and says so.
 */
const KINDS: readonly MediaKind[] = ["answer_audio", "answer_upload"];

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected a JSON body" }, { status: 400 }); }

  const gate = await sessionForMedia(body);
  if ("response" in gate) return gate.response;
  if (!gate.row) return NextResponse.json({ error: "a preview does not store recordings" }, { status: 403 });
  if (!gate.row.customerId) return NextResponse.json({ error: "this session has no project to store against" }, { status: 409 });

  const kind = String(body.kind ?? "answer_audio") as MediaKind;
  if (!KINDS.includes(kind)) return NextResponse.json({ error: `a respondent cannot store ${kind}` }, { status: 400 });
  const questionId = String(body.questionId ?? "").trim();
  if (!questionId) return NextResponse.json({ error: "questionId required" }, { status: 400 });

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;

  try {
    const ticket = await beginUpload(handle.db, {
      kind,
      customerId: gate.row.customerId,
      surveyId: gate.row.surveyId,
      questionId,
      sessionId: gate.row.sessionId,
      responseId: gate.row.responseId,
      /*
       * Inside a loop the answer lives under `<questionId>__<iteration>`, so
       * the question id alone cannot say which answer this recording's
       * transcript belongs to. The browser knows; it says so here, once, and
       * the server needs nothing from it afterwards.
       */
      answerKey: typeof body.answerKey === "string" && body.answerKey.trim() ? body.answerKey.trim() : null,
      fileName: typeof body.fileName === "string" ? body.fileName : null,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : null,
      bytes: Number(body.bytes) || null,
      durationSeconds: Number(body.durationSeconds) || null,
    });
    stageLogger(`session:${gate.row.sessionId.slice(0, 8)}`)("upload_url_issued", { mediaId: ticket.mediaId, kind, questionId });
    return NextResponse.json({ ok: true, ...ticket });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
