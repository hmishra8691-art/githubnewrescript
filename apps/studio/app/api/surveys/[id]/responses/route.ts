import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { responsesToCSV } from "@rescript/exporters";

export const dynamic = "force-dynamic";

/** Response data export (CSV) + summary counts. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const format = req.nextUrl.searchParams.get("format") ?? "summary";
  const includeTest = req.nextUrl.searchParams.get("test") === "1";

  if (format === "summary") {
    const { data } = await db
      .from("responses")
      .select("status, is_test")
      .eq("survey_id", params.id);
    const rows = data ?? [];
    const count = (s: string, t: boolean) => rows.filter((r) => r.status === s && r.is_test === t).length;
    return NextResponse.json({
      live: {
        in_progress: count("in_progress", false), complete: count("complete", false),
        screened: count("screened", false), quota_full: count("quota_full", false),
        terminated: count("terminated", false),
      },
      test: { total: rows.filter((r) => r.is_test).length },
    });
  }

  const { data: survey } = await db.from("surveys").select("current_version_id").eq("id", params.id).single();
  if (!survey?.current_version_id) return NextResponse.json({ error: "no version" }, { status: 404 });
  const { data: ver } = await db.from("survey_versions").select("definition, version").eq("id", survey.current_version_id).single();
  const parsed = ver ? SurveyDefinition.safeParse(ver.definition) : null;
  if (!parsed?.success) return NextResponse.json({ error: "definition invalid" }, { status: 500 });

  let query = db.from("responses")
    .select("session_id, respondent_id, status, seed, answers, calculated, embedded, flags, started_at, completed_at, is_test")
    .eq("survey_id", params.id);
  if (!includeTest) query = query.eq("is_test", false);
  const { data: resp } = await query.order("started_at");

  const states = (resp ?? []).map((r) => ({
    surveyId: params.id,
    surveyVersion: ver!.version,
    sessionId: r.session_id,
    respondentId: r.respondent_id ?? undefined,
    seed: r.seed,
    startedAt: r.started_at,
    status: r.status,
    answers: r.answers ?? {},
    embedded: r.embedded ?? {},
    calculated: r.calculated ?? {},
    flags: r.flags ?? [],
    stepIndex: 0,
  }));
  const csv = responsesToCSV(parsed.data, states as any);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${parsed.data.meta.code}_responses.csv"`,
    },
  });
}
