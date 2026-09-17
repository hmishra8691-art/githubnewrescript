import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * RETIRED. Localization audio used to be POSTed here as multipart and
 * forwarded by this function to a bucket it knew by name, with a five-year
 * signed URL back. It now goes straight from the browser to object storage
 * through `media/{ticket,parts,confirm}` as a `localization_audio` object,
 * under the same lifecycle — and the same deletion — as every other stored
 * file. Answered rather than deleted so a stale tab gets a sentence.
 */
export async function POST() {
  return NextResponse.json(
    { error: "This upload route has been retired. Reload the Studio — audio now uploads directly to storage." },
    { status: 410, headers: { "cache-control": "no-store" } },
  );
}
