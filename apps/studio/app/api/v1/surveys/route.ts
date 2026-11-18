import { NextRequest, NextResponse } from "next/server";
import { platformDb } from "@/lib/db";
import { isFailure } from "@/lib/guard";
import { requireApiKey } from "@/lib/apiKeys";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/surveys — the projects the key's owner can open (scope surveys:read). P2-13; docs: content/docs/api.md.
 */
export async function GET(req: NextRequest) {
  const caller = await requireApiKey(req, "surveys:read");
  if (isFailure(caller)) return caller.response;
  const { data, error } = await platformDb().rpc("rescript_my_projects", { p_user: caller.user.userId, p_lock_stale_seconds: caller.user.policies.lock.staleAfterSeconds });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = ((data ?? []) as { survey_id: string; code: string; title: string; status: string; updated_at: string; my_role: string; current_version: string | null; response_count: number; test_response_count: number }[]);
  return NextResponse.json({
    data: rows.map((r) => ({ id: r.survey_id, code: r.code, title: r.title, status: r.status, updatedAt: r.updated_at, role: r.my_role, version: r.current_version, liveResponses: r.response_count, testResponses: r.test_response_count })),
  }, { headers: { "cache-control": "no-store" } });
}
