import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

/**
 * "HAS THE SURVEY CHANGED SINCE THIS TAB LOADED?"
 *
 * The one thing a running test tab could not previously find out.
 *
 * The runtime already serves the live draft on every request — branch 2 of
 * `decideTestBuild` reads `surveys.draft_definition` straight from Postgres
 * and is deliberately excluded from the version cache because it changes on
 * every autosave. So a reload has always picked up Studio's latest work. What
 * was missing was any way for an OPEN tab to know a reload was worth doing,
 * so the tester either reloaded constantly on spec or assumed the runtime
 * needed restarting.
 *
 * This is the smallest thing that closes that gap: one indexed read returning
 * the survey's revision counter, which `0006_response_management.sql` already
 * bumps on every draft write. The runtime POLLS it; Studio pushes nothing.
 * That direction matters — it keeps the authoring plane and the execution
 * plane uncoupled, needs no socket, no queue and no shared process, and works
 * unchanged across however many runtime instances are serving.
 *
 * Deliberately NOT returning the definition. A tab that learns it is behind
 * reloads, and the reload goes down the path that already exists and is
 * already correct. Shipping a definition down this route would be a second
 * way to load a survey, and the second way is the one that drifts.
 */
export async function GET(req: NextRequest) {
  const surveyId = req.nextUrl.searchParams.get("survey");
  if (!surveyId) {
    return NextResponse.json({ error: "survey required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("surveys")
    .select("id, revision, current_version_id, draft_updated_at")
    .eq("id", surveyId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json(
    {
      revision: typeof data.revision === "number" ? data.revision : null,
      currentVersionId: data.current_version_id ?? null,
      draftUpdatedAt: data.draft_updated_at ?? null,
    },
    /*
     * Never cached, at any layer. A stamp served from a CDN is a stamp that
     * says "nothing has changed" for as long as its TTL, which is the exact
     * failure this route exists to remove.
     */
    { headers: { "cache-control": "no-store" } },
  );
}
