import { NextRequest, NextResponse } from "next/server";
import { aiConfigured, aiProviderName, capacityNotice, fallbackProvider, providerHealth } from "@rescript/ai";
import { isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE AI PROVIDER'S HEALTH, as this server instance has seen it.
 *
 *   GET /api/ai/health
 *
 * One entry per provider lane (a host, never a key): whether it is fine,
 * cooling down after a rate limit (and for how long), blocked by a refused key
 * or a spent quota, how many requests it is running and queueing, and the last
 * error's KIND. State is per instance — a serverless deployment runs several —
 * so this is a window onto what this one has learnt, not a global verdict.
 * Signed-in users only; no key, no prompt, no provider text.
 */
export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  if (isFailure(authed)) return authed.response;
  return NextResponse.json({
    configured: aiConfigured(), provider: aiProviderName(), fallbackConfigured: !!fallbackProvider(),
    notice: capacityNotice(), lanes: providerHealth(),
  });
}
