import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { definitionForProviderCall } from "@/lib/aiSession";
import { meteredSessionStt, recordSessionUsage } from "@/lib/metering";
import { aiConfigured, aiProviderName, transcribe } from "@/lib/ai";
import { savesAudio, transcribes } from "@rescript/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A RESPONDENT'S SPOKEN ANSWER: stored, then transcribed, in one call.
 *
 * ## Why one route and not two
 *
 * Upload-then-transcribe is two round trips over the same bytes, and the
 * respondent waits through both while a page will not turn. More
 * importantly it has a failure mode with no good answer: if the second call
 * never arrives, the clip is in the bucket and nothing knows it needs
 * transcribing. Doing both here means the answer that comes back is complete
 * or explicitly incomplete, and the client never has to reconcile two
 * outcomes.
 *
 * ## The order, and why it is that way round
 *
 * STORE FIRST. A transcript can always be generated again from a stored
 * clip; a clip that was never uploaded is gone the moment the tab closes. So
 * the upload is awaited and its failure is fatal to the request, while every
 * transcription failure — no provider, an empty wallet, a timeout, a
 * provider that returns nothing — is reported as `transcript.source: "none"`
 * with a 200, and the respondent moves on with their recording safely kept.
 *
 * That is the same contract `/api/session/ai` states and the geocoder
 * follows: a paid external service is never the reason an interview stops.
 *
 * ## What the question's configuration decides
 *
 * `saveAnswerAudio: false` means the clip is transcribed and NOT kept — so
 * the upload is skipped entirely rather than uploaded and deleted, because
 * the fastest way not to leak a recording is never to write it down.
 * `transcribeAnswer: false` means the reverse: stored, never sent anywhere.
 * Both off is a question that collects nothing, which the Studio refuses to
 * save, so it cannot arrive here.
 */
const BUCKET = "rescript-uploads";
/** 25 MB, matching `/api/upload` — a long answer at a sane bitrate is well under it. */
const MAX_BYTES = 25 * 1024 * 1024;
const SIGNED_SECONDS = 60 * 60 * 24 * 365;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const file = form.get("file");
  const sessionId = String(form.get("sessionId") ?? "");
  const questionId = String(form.get("questionId") ?? "");
  const durationSeconds = Number(form.get("durationSeconds") ?? 0);
  const retakes = Number(form.get("retakes") ?? 0);
  if (!(file instanceof File)) return NextResponse.json({ error: "file missing" }, { status: 400 });
  if (!questionId) return NextResponse.json({ error: "questionId required" }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `recording exceeds ${MAX_BYTES / 1024 / 1024} MB` }, { status: 413 });
  }

  /*
   * The same gate every provider-spending route uses: a live in-progress
   * session, or a preview against the fake provider only. It wants a JSON
   * body and this route is multipart, so the few fields it reads are lifted
   * out of the form — `definition` arrives as a JSON string in a preview.
   */
  let definition: unknown;
  const defRaw = form.get("definition");
  if (typeof defRaw === "string" && defRaw) { try { definition = JSON.parse(defRaw); } catch { /* the gate will refuse it */ } }
  const gate = await definitionForProviderCall(
    { sessionId, definition, build: form.get("build") ?? undefined },
    { configured: aiConfigured(), fake: aiProviderName() === "fake", what: "transcription", unconfigured: "transcription is not configured on this runtime" },
  );
  if ("response" in gate) return gate.response;
  const { def, billing } = gate;

  const q = def.questions.find((x) => x.id === questionId);
  if (!q) return NextResponse.json({ error: "unknown question" }, { status: 404 });

  /*
   * A PREVIEW STORES NOTHING. There is no session for the object to belong
   * to, no respondent whose data it is, and nothing to come back for it —
   * the Studio's own preview keeps the clip as an object URL and never calls
   * this route at all. What a preview may still do is transcribe, against
   * the free fake provider only (the gate above enforces that), so a
   * programmer can see the whole path work before fielding.
   */
  const isPreview = sessionId === "preview";
  const keepAudio = savesAudio(q) && !isPreview;
  const wantTranscript = transcribes(q);
  const bytes = Buffer.from(await file.arrayBuffer());

  /* ------------------------------------------------------------- 1. store */

  let audio: Record<string, unknown> | null = null;
  if (keepAudio) {
    let db;
    try { db = supabaseAdmin(); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 501 }); }

    const { data: buckets } = await db.storage.listBuckets();
    if (!buckets?.some((b) => b.name === BUCKET)) {
      const { error } = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES });
      if (error && !/already exists/i.test(error.message)) {
        return NextResponse.json({ error: `could not create bucket: ${error.message}` }, { status: 500 });
      }
    }

    const safeSession = sessionId.replace(/[^A-Za-z0-9_-]/g, "") || "preview";
    const safeQuestion = questionId.replace(/[^A-Za-z0-9_-]/g, "");
    const safeName = (file.name || "answer.webm").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const path = `${safeSession}/${safeQuestion}/${Date.now()}-${safeName}`;
    const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: file.type || "audio/webm", upsert: false });
    if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });
    const signed = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_SECONDS);
    if (signed.error) return NextResponse.json({ error: signed.error.message }, { status: 500 });

    audio = {
      url: signed.data.signedUrl,
      path,
      mimeType: file.type || "audio/webm",
      bytes: bytes.length,
      durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 10) / 10 : undefined,
      recordedAt: new Date().toISOString(),
      retakes: Number.isFinite(retakes) && retakes > 0 ? Math.floor(retakes) : 0,
    };

    /* the storage cost, recorded after the fact — never a refusal */
    if (billing) {
      void recordSessionUsage(billing, {
        eventType: "FILE_UPLOAD",
        quantity: Math.max(0.001, bytes.length / (1024 * 1024)),
        metadata: { questionId, contentType: file.type || null, bytes: bytes.length, operation: "interview_answer" },
      });
    }
  }

  /* --------------------------------------------------------- 2. transcribe */

  let transcript: Record<string, unknown> = { source: "none" };
  if (wantTranscript) {
    const language = q.settings.transcriptLanguage || def.localization?.sourceLanguage || undefined;
    const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : Math.max(1, Math.round(bytes.length / 16_000));

    const metered = await meteredSessionStt(billing, { seconds, operation: "transcribe_answer" }, () =>
      transcribe(new Uint8Array(bytes), {
        language,
        mimeType: file.type || "audio/webm",
        fileName: file.name || "answer.webm",
        durationSeconds: seconds,
      }),
    );

    if ("refused" in metered) {
      /* the wallet said no. The recording is already safe; the transcript is
         simply absent, and `failed` tells the Studio it is worth retrying. */
      console.info("[rescript:interview] transcription refused", JSON.stringify({ questionId, reason: metered.refused }));
      transcript = { source: "none", failed: true };
    } else if (metered.value) {
      const t = metered.value;
      transcript = {
        text: t.text,
        language: t.language,
        source: "provider",
        model: t.model,
        transcribedAt: new Date().toISOString(),
      };
    } else {
      transcript = { source: "none", failed: true };
    }
  }

  return NextResponse.json({ ok: true, audio, transcript });
}
