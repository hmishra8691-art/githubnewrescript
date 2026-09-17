import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * RETIRED. A respondent's file used to be POSTed here as multipart and
 * forwarded to storage by this function — 25 MB allowed by the route, 4.5 MB
 * allowed by the platform, and no check that the caller held a session at
 * all. Files now go straight from the browser to object storage through
 * `/api/session/media/{ticket,parts,confirm}` (see
 * `packages/renderer/src/lib/sessionUpload.ts`), which is session-gated,
 * resumable and never carries the bytes through here.
 *
 * Answered rather than deleted so a stale bundle gets a sentence instead of
 * a 404 it cannot interpret.
 */
export async function POST() {
  return NextResponse.json(
    { error: "This upload route has been retired. Reload the page — files now upload directly to storage." },
    { status: 410, headers: { "cache-control": "no-store" } },
  );
}
