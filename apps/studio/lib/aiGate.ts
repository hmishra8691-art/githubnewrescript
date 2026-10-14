import { NextRequest, NextResponse } from "next/server";
import { aiConfigured, aiProviderName } from "@rescript/ai";
import { isFailure, requireUser, type AuthedUser } from "@/lib/guard";
import { aiReadyFor } from "@/lib/byok/connect";

/**
 * WHO MAY SPEND THE AI PROVIDER FROM THE STUDIO — shared by the rephrase,
 * translate and text-to-speech routes.
 *
 * A signed-in Studio user, always. Unconfigured provider → 501 and the UI
 * says so. The one carve-out mirrors the runtime's: against the FAKE provider
 * (free, deterministic) the sandbox may call these without a session, so the
 * browser suites and a local developer can see the whole path work. Nothing
 * here ever returns the key or the provider URL.
 */
export async function requireAiCaller(req: NextRequest): Promise<{ ok: true; user: AuthedUser | null } | { ok: false; response: NextResponse }> {
  const unconfigured = () => ({ ok: false as const, response: NextResponse.json({ error: "AI is not configured on this Studio" }, { status: 501 }) });
  const user = await requireUser(req);
  if (isFailure(user)) {
    if (!aiConfigured()) return unconfigured();
    if (aiProviderName() !== "fake") return { ok: false, response: user.response };
    return { ok: true, user: null };
  }
  /* no platform model is not "no AI" for a person who connected their own provider: the metered call itself says whether it can be used */
  if (!aiConfigured() && !(await aiReadyFor(user, null, "additional"))) return unconfigured();
  return { ok: true, user };
}
