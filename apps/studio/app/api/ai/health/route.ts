import { NextRequest, NextResponse } from "next/server";
import { aiConfigured, aiProviderName, capacityNotice, fallbackProvider, probeProvider, providerHealth } from "@rescript/ai";
import { isFailure, requireAdmin, requireUser } from "@/lib/guard";
import { maxOutputTokens } from "@/lib/copilot/budget";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * THE AI PROVIDER'S HEALTH, as this server instance has seen it.
 *
 *   GET  /api/ai/health   what this instance has learnt (any signed-in user)
 *   POST /api/ai/health   ADMINISTRATORS: ask the provider, in miniature, the
 *                         three things a copilot request depends on — a plain
 *                         request, a request with a JSON schema, and the
 *                         output ceiling — and say which is refused and what
 *                         the provider said (redacted). The answer to "the AI
 *                         service could not process this request", without a
 *                         log and without pasting a key.
 *
 * GET: one entry per provider lane (a host, never a key): fine, cooling down
 * after a rate limit, blocked by a refused key or a spent quota, how many
 * requests it is running and queueing, and the last error's KIND. State is per
 * instance — a serverless deployment runs several. No key, no prompt, no
 * provider text. (An administrator's GET adds the provider's last words.)
 */
export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  if (isFailure(authed)) return authed.response;
  const admin = await requireAdmin(req);
  return NextResponse.json({
    configured: aiConfigured(), provider: aiProviderName(), fallbackConfigured: !!fallbackProvider(),
    notice: capacityNotice(), lanes: providerHealth(Date.now(), { detail: !isFailure(admin) }),
  });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;
  const result = await probeProvider({ maxTokens: maxOutputTokens() });
  console.warn("[rescript:ai]", JSON.stringify({ event: "probe", userId: admin.userId, ok: result.verdict.startsWith("The provider accepted"), verdict: result.verdict, plain: result.plain, schema: result.schema, ceiling: result.ceiling && { ok: result.ceiling.ok, status: result.ceiling.status, said: result.ceiling.said } }));
  return NextResponse.json(result);
}
