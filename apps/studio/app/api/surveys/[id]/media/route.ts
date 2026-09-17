import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { listAssets, MediaError } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE ASSET LIBRARY, as this survey sees it.
 *
 * `GET /api/surveys/:id/media` — every stored `survey_asset` this survey
 * owns, plus every asset of the customer marked shared. Newest first. The
 * Assets tab and the "Choose asset" picker both read this; `?family=image`
 * and `?q=logo` narrow it, but the filtering is also done client-side so the
 * picker stays instant.
 *
 * Reading the library is a `project.read` capability — the same one that
 * lets a member open a survey's media URLs.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  try {
    let assets = await listAssets(handle.db, { surveyId: params.id, customerId: gate.survey.customer_id ?? gate.user.customerId ?? null });
    const family = req.nextUrl.searchParams.get("family");
    if (family) assets = assets.filter((a) => a.family === family);
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
    if (q) assets = assets.filter((a) => a.name.toLowerCase().includes(q) || (a.fileName ?? "").toLowerCase().includes(q) || (a.altText ?? "").toLowerCase().includes(q));
    return NextResponse.json({ ok: true, assets }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
