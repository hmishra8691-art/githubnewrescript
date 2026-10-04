import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireEditRight } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { MediaError, stageLogger } from "@rescript/media";
import { fetchDriveFile, storeAssetBytes } from "@rescript/media/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SAVE A GOOGLE DRIVE FILE INTO THIS SURVEY'S ASSET LIBRARY (1-10-26 review).
 *
 * Insert media → Google Drive URL → "Save to asset library". The browser
 * cannot read a Drive file itself (no CORS), so this route downloads the
 * file Drive serves for a link shared "Anyone with the link" and stores it
 * through the same ticket → upload → confirm path every library upload
 * takes (`storeAssetBytes`). Only a Drive file link is fetched — never an
 * arbitrary URL — and only a picture, video or audio file within the
 * library's size for its kind is kept.
 *
 * `survey.edit`: adding to the library is editing the survey.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected a JSON body" }, { status: 400 }); }
  const url = String(body.url ?? "").trim();
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  const log = stageLogger(`survey:${params.id}`);
  try {
    const file = await fetchDriveFile(url);
    const out = await storeAssetBytes(handle.db, {
      customerId: gate.survey.customer_id ?? gate.user.customerId!,
      surveyId: params.id,
      createdBy: gate.user.userId,
      file,
      displayName: typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : null,
      altText: typeof body.altText === "string" && body.altText.trim() ? body.altText.trim() : null,
    });
    log("storage_confirmed", { mediaId: out.asset.id, kind: "survey_asset", bytes: file.bytes.byteLength, source: "google_drive", duplicate: out.duplicate });
    return NextResponse.json({ ok: true, asset: out.asset, duplicate: out.duplicate });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
