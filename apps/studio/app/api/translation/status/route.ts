import { NextRequest, NextResponse } from "next/server";
import { translationAdapter, googleConfigured } from "@rescript/ai";
import { isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * TRANSLATION PROVIDER SETTINGS — what the Studio's Translation → Settings
 * card shows. Reports WHICH provider is active and WHETHER it is connected;
 * never the key, never the endpoint. Readable by any signed-in user (and by
 * the sandbox, where there is nothing to protect).
 */
export async function GET(req: NextRequest) {
  const adapter = translationAdapter();
  if (!adapter || adapter.id !== "fake") {
    const user = await requireUser(req);
    if (isFailure(user) && adapter) return user.response;
  }
  const dbCache = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  return NextResponse.json({
    provider: adapter ? { id: adapter.id, name: adapter.name, connected: true } : { id: null, name: "None", connected: false },
    candidates: { google: googleConfigured(), ai: !!(process.env.AI_API_URL ?? "").trim() && process.env.AI_API_URL !== "fake:", fake: process.env.AI_API_URL === "fake:" || process.env.TRANSLATION_PROVIDER === "fake" },
    cache: { backend: dbCache ? "database" : "memory" },
    pinned: (process.env.TRANSLATION_PROVIDER ?? "").trim() || null,
  });
}
