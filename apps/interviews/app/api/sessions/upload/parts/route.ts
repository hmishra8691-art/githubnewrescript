import { NextRequest, NextResponse } from "next/server";
import { UPLOAD_SECONDS, planUpload, remainingParts } from "@rescript/storage";
import { isFailure } from "@/lib/auth";
import { requireMedia } from "@/lib/recordings";
import { storageOrResponse } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * RE-SIGN THE PARTS OF A MODERATED RECORDING THAT ARE STILL MISSING.
 *
 * The resume path. A laptop that slept, a network that dropped, a tab that was
 * closed in the middle of a two-hour session: the recording is still in the
 * browser and most of it is already in the store, so what is needed is URLs for
 * the rest rather than the whole upload again.
 *
 * THE STORE IS ASKED, not the client. Which parts arrived is a fact the store
 * holds and the browser can only guess at — a part that returned 200 and is not
 * there is precisely the case this exists to recover from, and asking the
 * client which parts it is missing would ask the one party that cannot know.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const mediaId = String(body?.mediaId ?? "");
  if (!mediaId) return NextResponse.json({ error: "Which recording?" }, { status: 400 });

  const ctx = await requireMedia(req, mediaId, "candidates.invite");
  if (isFailure(ctx)) return ctx.response;

  const { media } = ctx;
  if (!media.multipart_upload_id) {
    return NextResponse.json(
      { error: "That recording was a single upload — there is nothing to resume." },
      { status: 409 },
    );
  }
  if (media.upload_status === "stored") {
    return NextResponse.json({ ok: true, done: true, parts: [] });
  }

  const store = storageOrResponse();
  if ("response" in store) return store.response;

  let known;
  try {
    known = await store.storage.listUploadedParts(media.storage_key, media.multipart_upload_id);
  } catch (e) {
    return NextResponse.json(
      { error: `We could not check what has arrived: ${(e as Error).message}` }, { status: 503 },
    );
  }

  const plan = planUpload(Number(media.file_size ?? 0) || 0);
  const missing = remainingParts(plan, known);

  const parts = await Promise.all(
    missing.map(async (p) => ({
      partNumber: p.partNumber,
      start: p.start,
      end: p.end,
      url: await store.storage.signUploadPart(
        media.storage_key, media.multipart_upload_id!, p.partNumber, { expiresIn: UPLOAD_SECONDS },
      ),
    })),
  );

  return NextResponse.json({
    ok: true,
    done: parts.length === 0,
    have: known.length,
    parts,
  });
}
