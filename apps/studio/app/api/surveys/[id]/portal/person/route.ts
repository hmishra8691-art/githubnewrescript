import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import { personView } from "@/lib/portalPerson";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ONE RESPONDENT'S PORTAL RESULTS (Respondent Intelligence Engine, phase 3, 2026-11-20).
 *
 *   GET ?respondent=<id on this survey's list>   their latest scores and their history across this survey's
 *                                               attempts. Needs `responses.read_individual` — a permission of
 *                                               its own, not part of reading the data. Scores only: no answers;
 *                                               name and email only with `responses.read_pii`. Audited.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "responses.read_individual");
  if (isFailure(ctx)) return ctx.response;
  const respondent = req.nextUrl.searchParams.get("respondent") ?? "";
  if (!UUID.test(respondent)) return json({ error: "Choose a respondent." }, 400);
  const out = await personView(ctx, respondent);
  if ("error" in out) return json({ error: out.error }, out.status);
  return json({ ok: true, ...out });
}
