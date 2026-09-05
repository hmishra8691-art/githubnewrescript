import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { parseEnvironment } from "@/lib/responseData";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Quota counts for one environment.
 *
 * `?environment=TEST|LIVE|ALL` — required. The counters are keyed by
 * environment (migration 0006), so a test run cannot make a live cell look
 * full and the Quotas panel always says which dataset it is showing. Before
 * that migration every counter was live's, so a database without the
 * `is_test` column answers as LIVE and says so.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const environment = parseEnvironment(req.nextUrl.searchParams.get("environment") ?? "LIVE");
  if (!environment) return NextResponse.json({ error: "environment must be TEST, LIVE or ALL" }, { status: 400 });
  const db = supabaseAdmin();
  type Row = { quota_id: string; cell_id: string; count: number; updated_at?: string | null };
  const select = async (cols: string) => {
    let q = db.from("quota_counts").select(cols).eq("survey_id", params.id);
    if (environment === "TEST") q = q.eq("is_test", true);
    else if (environment === "LIVE") q = q.eq("is_test", false);
    return (await q) as unknown as { data: Row[] | null; error: { message: string } | null };
  };
  // `updated_at` arrives with migration 0010; a database without it still answers, without timestamps
  let { data, error } = await select("quota_id, cell_id, count, is_test, updated_at");
  if (error && /updated_at/.test(error.message)) ({ data, error } = await select("quota_id, cell_id, count, is_test"));
  let perEnvironment = true;
  if (error && /is_test/.test(error.message)) {
    // migration 0006 not applied: one shared counter, which is live's
    perEnvironment = false;
    ({ data, error } = (await db.from("quota_counts").select("quota_id, cell_id, count").eq("survey_id", params.id)) as unknown as { data: Row[] | null; error: { message: string } | null });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const counts: Record<string, Record<string, number>> = {};
  /** quotaId → the most recent counter change in this environment */
  const updatedAt: Record<string, string> = {};
  for (const r of data ?? []) {
    counts[r.quota_id] = counts[r.quota_id] ?? {};
    counts[r.quota_id][r.cell_id] = (counts[r.quota_id][r.cell_id] ?? 0) + r.count;
    if (r.updated_at && (!updatedAt[r.quota_id] || r.updated_at > updatedAt[r.quota_id])) updatedAt[r.quota_id] = r.updated_at;
  }
  return NextResponse.json({ counts, updatedAt, environment, perEnvironment, fetchedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
}
