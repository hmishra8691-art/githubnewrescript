import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { findDuplicateAsset, MediaError } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "IS THIS FILE ALREADY HERE?"
 *
 * The browser hashes a file before uploading it and asks. A stored asset
 * with the same bytes in this survey — or shared across the customer — is
 * handed back and nothing is uploaded: the same logo dragged in for the
 * third time is the same asset, not a third copy of it. `POST` because the
 * hash is a body, not a query string.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected a JSON body" }, { status: 400 }); }
  const sha256 = String(body.sha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) return NextResponse.json({ error: "sha256 must be 64 hex characters" }, { status: 400 });
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  try {
    const asset = await findDuplicateAsset(handle.db, {
      surveyId: params.id,
      customerId: gate.survey.customer_id ?? gate.user.customerId ?? null,
      sha256,
      bytes: Number(body.bytes) || null,
    });
    return NextResponse.json({ ok: true, asset }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
