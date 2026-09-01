import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { responsesToCSV } from "@rescript/exporters";
import { buildVariableDictionary, flattenVariables } from "@rescript/engine";

export const dynamic = "force-dynamic";

/** Response data export (CSV) + summary counts. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const format = req.nextUrl.searchParams.get("format") ?? "summary";
  // include=live|test|all ("test=1" kept for backwards compatibility)
  const include =
    req.nextUrl.searchParams.get("include") ??
    (req.nextUrl.searchParams.get("test") === "1" ? "all" : "live");

  if (format === "summary") {
    const { data } = await db
      .from("responses")
      .select("status, is_test")
      .eq("survey_id", params.id);
    const rows = data ?? [];
    const count = (s: string, t: boolean) => rows.filter((r) => r.status === s && r.is_test === t).length;
    const block = (t: boolean) => ({
      in_progress: count("in_progress", t), complete: count("complete", t),
      screened: count("screened", t), quota_full: count("quota_full", t),
      terminated: count("terminated", t),
      total: rows.filter((r) => r.is_test === t).length,
    });
    return NextResponse.json({ live: block(false), test: block(true) });
  }

  const { data: survey } = await db.from("surveys").select("current_version_id").eq("id", params.id).single();
  if (!survey?.current_version_id) return NextResponse.json({ error: "no version" }, { status: 404 });
  const { data: ver } = await db.from("survey_versions").select("definition, version").eq("id", survey.current_version_id).single();
  const parsed = ver ? SurveyDefinition.safeParse(ver.definition) : null;
  if (!parsed?.success) return NextResponse.json({ error: "definition invalid" }, { status: 500 });

  let query = db.from("responses")
    .select("session_id, respondent_id, status, seed, answers, calculated, embedded, flags, started_at, completed_at, is_test")
    .eq("survey_id", params.id);
  if (include === "live") query = query.eq("is_test", false);
  else if (include === "test") query = query.eq("is_test", true);
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
  if (format === "json") {
    // Ordered by the data dictionary, so columns follow questionnaire order.
    const columns = buildVariableDictionary(parsed.data)
      .filter((v) => v.responseType !== "system")
      .map((v) => v.name);
    const rows = states.map((st, i) => {
      const raw = (resp ?? [])[i];
      const started = raw?.started_at ? new Date(raw.started_at).getTime() : null;
      const done = raw?.completed_at ? new Date(raw.completed_at).getTime() : null;
      return {
        sessionId: st.sessionId,
        status: st.status,
        isTest: !!raw?.is_test,
        startedAt: raw?.started_at ?? null,
        completedAt: raw?.completed_at ?? null,
        durationSec: started && done ? Math.round((done - started) / 1000) : null,
        flags: st.flags,
        vars: flattenVariables(parsed.data, st as any),
      };
    });
    return NextResponse.json({ version: ver!.version, columns, rows });
  }

  const csv = responsesToCSV(parsed.data, states as any);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${parsed.data.meta.code}_${include}_responses.csv"`,
    },
  });
}
