import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { parseEnvironment } from "@/lib/responseData";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * List Fill allocation counts for one environment — the live dashboard (§28).
 *
 *   GET  ?environment=TEST|LIVE|ALL
 *   POST { environment, action: "recount" }
 *
 * The counters are per environment (migration 0007), so a test run can never
 * make a live option look full. Two numbers are reported for every option and
 * they answer different questions: `allocated` is how many respondents were
 * GIVEN it, including sessions still in progress, and is what a cap holds
 * against; `completed` is how many of those finished. A researcher chasing
 * "150 interviews about Apple" is watching the second one.
 *
 * A database without migration 0007 answers with empty counts and says so,
 * rather than failing the panel.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const environment = parseEnvironment(req.nextUrl.searchParams.get("environment") ?? "LIVE");
  if (!environment) return NextResponse.json({ error: "environment must be TEST, LIVE or ALL" }, { status: 400 });

  const db = supabaseAdmin();
  let q = db
    .from("listfill_counts")
    .select("list_fill_id, option_code, allocated_count, completed_count, is_test")
    .eq("survey_id", params.id);
  if (environment === "TEST") q = q.eq("is_test", true);
  else if (environment === "LIVE") q = q.eq("is_test", false);
  const { data, error } = (await q) as {
    data: { list_fill_id: string; option_code: string; allocated_count: number; completed_count: number }[] | null;
    error: { message: string } | null;
  };
  if (error) {
    if (/listfill_counts|does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json(
        { counts: {}, completed: {}, environment, available: false, note: "List Fill allocation counters need migration 0007." },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const counts: Record<string, Record<string, number>> = {};
  const completed: Record<string, Record<string, number>> = {};
  for (const r of data ?? []) {
    counts[r.list_fill_id] = counts[r.list_fill_id] ?? {};
    completed[r.list_fill_id] = completed[r.list_fill_id] ?? {};
    // ALL sums the two environments, which is why the panel names the one it shows
    counts[r.list_fill_id][r.option_code] = (counts[r.list_fill_id][r.option_code] ?? 0) + r.allocated_count;
    completed[r.list_fill_id][r.option_code] = (completed[r.list_fill_id][r.option_code] ?? 0) + r.completed_count;
  }
  return NextResponse.json({ counts, completed, environment, available: true }, { headers: { "cache-control": "no-store" } });
}

/**
 * Rebuild one environment's counters from the allocations that stand.
 *
 * The repair path after a bulk delete, an import or any doubt: the counters
 * are a cache of `listfill_allocations`, and this makes them agree with it in
 * one transaction. It never invents or removes an allocation.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const environment = parseEnvironment(body?.environment);
  if (!environment) return NextResponse.json({ error: "environment must be TEST, LIVE or ALL" }, { status: 400 });
  if (body?.action && body.action !== "recount")
    return NextResponse.json({ error: `unknown action "${body.action}"` }, { status: 400 });

  const db = supabaseAdmin();
  const envs = environment === "ALL" ? [true, false] : [environment === "TEST"];
  const results: Record<string, number> = {};
  for (const isTest of envs) {
    const { data, error } = await db.rpc("rescript_recount_listfill", { p_survey: params.id, p_test: isTest });
    if (error) {
      if (/rescript_recount_listfill|does not exist|schema cache/i.test(error.message)) {
        return NextResponse.json({ error: "List Fill allocation needs migration 0007." }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    results[isTest ? "TEST" : "LIVE"] = Number(data ?? 0);
  }
  return NextResponse.json({ ok: true, results });
}
