import { NextRequest, NextResponse } from "next/server";
import { translationAdapter, googleConfigured } from "@rescript/ai";
import { isFailure, requireUser } from "@/lib/guard";
import { connectionFor } from "@/lib/byok/connect";
import { viewOfResolution } from "@/lib/byok/resolve";

export const dynamic = "force-dynamic";

/**
 * TRANSLATION PROVIDER SETTINGS — what the Studio's Translation → Settings
 * card shows. Reports WHICH provider is active for THIS person and WHETHER it is
 * connected; never a key, never an endpoint. Readable by any signed-in user (and
 * by the sandbox, where there is nothing to protect).
 *
 * "Which provider" is the question every translation asks, answered by the same
 * resolver: the project's choice, else the person's own translation service or AI
 * model, else the platform's. A choice that cannot be used is reported with the
 * reason, not hidden behind the platform's provider.
 */
export async function GET(req: NextRequest) {
  const platform = translationAdapter();
  const authed = await requireUser(req);
  if (isFailure(authed) && platform && platform.id !== "fake") return authed.response;
  const user = isFailure(authed) ? null : authed;
  const surveyId = req.nextUrl.searchParams.get("surveyId");
  const resolution = user ? await connectionFor({ userId: user.userId, customerId: user.customerId, surveyId, operation: "translate" }) : null;
  const view = resolution ? viewOfResolution(resolution) : null;
  const dbCache = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

  let provider: { id: string | null; name: string; connected: boolean; via?: "user" | "platform"; refused?: { code: string; message: string } };
  if (view?.kind === "user") provider = { id: view.provider, name: view.provider === "llm" ? "My AI model" : view.label ?? view.provider, connected: true, via: "user" };
  else if (view?.kind === "refused") provider = { id: null, name: "Your own provider", connected: false, refused: { code: view.code, message: view.message } };
  else provider = platform ? { id: platform.id, name: platform.name, connected: true, via: "platform" } : { id: null, name: "None", connected: false };

  return NextResponse.json({
    provider,
    candidates: { google: googleConfigured(), ai: !!(process.env.AI_API_URL ?? "").trim() && process.env.AI_API_URL !== "fake:", fake: process.env.AI_API_URL === "fake:" || process.env.TRANSLATION_PROVIDER === "fake" },
    cache: { backend: dbCache ? "database" : "memory" },
    pinned: (process.env.TRANSLATION_PROVIDER ?? "").trim() || null,
  });
}
