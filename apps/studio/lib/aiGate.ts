import { NextRequest, NextResponse } from "next/server";
import { aiConfigured, aiProviderName } from "@rescript/ai";
import { isFailure, requireUser, type AuthedUser } from "@/lib/guard";

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
  if (!aiConfigured()) return { ok: false, response: NextResponse.json({ error: "AI is not configured on this Studio" }, { status: 501 }) };
  const user = await requireUser(req);
  if (isFailure(user)) {
    if (aiProviderName() !== "fake") return { ok: false, response: user.response };
    return { ok: true, user: null };
  }
  return { ok: true, user };
}
