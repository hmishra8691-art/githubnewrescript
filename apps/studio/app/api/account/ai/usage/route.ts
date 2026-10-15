import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireUser } from "@/lib/guard";
import { getMeter } from "@/lib/metering";
import { summariseAiUsage } from "@/lib/byok/usage";

export const dynamic = "force-dynamic";

/**
 * MY AI USAGE — what ran on MY provider (volumes only: the Studio does not
 * know that provider's price) and what ran on the platform's AI and was
 * charged to MY wallet. Read from the usage events the metering door already
 * writes; the acting user's id comes from the session, never the request.
 * Provider cost, fees and margin are never read.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(raw) && raw >= 1 && raw <= 90 ? Math.floor(raw) : 30;
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const events = await getMeter().store.listUsage({ userId: user.userId, since, limit: 5000 });
    return NextResponse.json({ ok: true, ...summariseAiUsage(events, { days }) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message;
    const unavailable = /relation .* does not exist|function .* does not exist|schema cache/i.test(msg);
    return NextResponse.json({ error: unavailable ? "Metered usage is not enabled on this installation yet." : "Usage could not be read right now.", code: unavailable ? "billing_unavailable" : "billing_error" }, { status: unavailable ? 501 : 503, headers: { "cache-control": "no-store" } });
  }
}
