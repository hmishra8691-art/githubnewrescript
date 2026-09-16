import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { candidateGate, isCandidateFailure } from "@/lib/candidate";
import { storageOrResponse } from "@/lib/storage";
import { UPLOAD_SECONDS, planUpload, PART_BYTES } from "@rescript/storage";

export const dynamic = "force-dynamic";

/**
 * WHICH PARTS DOES THE STORE ALREADY HAVE?
 *
 * The resume question, answered by the only party whose answer counts. The
 * browser calls this when it comes back from an interruption — a lost
 * connection, a sleeping laptop, a reloaded page — and is told exactly which
 * parts to send and given fresh URLs for those and no others.
 *
 * There is deliberately no client-side ledger of "parts I have sent". A
 * second record of the same fact is a second record to get out of step, and
 * the store is authoritative anyway; keeping a list in the tab would only
 * create a way for a resumed upload to skip a part that never arrived.
 *
 * Signatures expire, so a resume always re-signs rather than reusing what was
 * handed out an hour ago. That is why this route exists at all rather than
 * the browser simply retrying its original URLs.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gate = await candidateGate(body?.token);
  if (isCandidateFailure(gate)) return gate.response;

  const store = storageOrResponse();
  if ("response" in store) return store.response;

  const { data: media } = await supabaseAdmin()
    .from("interview_media")
    .select("id, storage_key, multipart_upload_id, upload_status, file_size")
    .eq("id", String(body?.mediaId ?? ""))
    .eq("interview_id", gate.interview.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!media) return NextResponse.json({ error: "That recording is not part of this interview." }, { status: 404 });
  if (media.upload_status === "stored") {
    return NextResponse.json({ ok: true, complete: true, uploaded: [], parts: [] });
  }
  if (!media.multipart_upload_id) {
    return NextResponse.json({
      ok: true, complete: false, uploaded: [], kind: "single",
      uploadUrl: await store.storage.createSignedUploadUrl(media.storage_key, { expiresIn: UPLOAD_SECONDS }),
    });
  }

  const bytes = Number(body?.bytes) || Number(media.file_size) || PART_BYTES;
  const plan = planUpload(bytes);
  let uploaded: { partNumber: number; etag: string }[] = [];
  try {
    uploaded = await store.storage.listUploadedParts(media.storage_key, media.multipart_upload_id);
  } catch (e) {
    return NextResponse.json(
      { error: `We could not check what has arrived: ${(e as Error).message}` }, { status: 503 },
    );
  }

  const have = new Set(uploaded.map((p) => p.partNumber));
  const parts: { partNumber: number; url: string; start: number; end: number }[] = [];
  for (let n = 1; n <= plan.partCount; n++) {
    if (have.has(n)) continue;
    const start = (n - 1) * plan.partBytes;
    parts.push({
      partNumber: n,
      url: await store.storage.signUploadPart(media.storage_key, media.multipart_upload_id, n, { expiresIn: UPLOAD_SECONDS }),
      start,
      end: Math.min(plan.totalBytes, start + plan.partBytes),
    });
  }

  return NextResponse.json({
    ok: true, kind: "multipart", complete: parts.length === 0,
    partBytes: plan.partBytes, partCount: plan.partCount,
    uploaded, parts,
  });
}
