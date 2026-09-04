import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { responsesToCSV, exportResponsesXlsx, inDataset, QUALITY_CSV_COLUMNS, qualityCsvCells, type DatasetFilter, type QualityExportRow } from "@rescript/exporters";
import { buildVariableDictionary, flattenVariables } from "@rescript/engine";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * `dataset=all|clean|custom:CLS1,CLS2` — which responses form the dataset:
 * all, the clean dataset (KEEP decisions + unreviewed CLEAN; REMOVED out), or
 * everything but the listed classifications (and REMOVED). This is the
 * hand-off to analysis: the same filter drives the Data tab, CSV, JSON and
 * XLSX, so what the researcher approved is what gets analysed.
 */
function parseDataset(raw: string | null): DatasetFilter {
  if (!raw || raw === "all") return { kind: "all" };
  if (raw === "clean") return { kind: "clean" };
  if (raw.startsWith("custom:")) return { kind: "custom", exclude: raw.slice(7).split(",").map((s) => s.trim()).filter(Boolean) };
  return { kind: "all" };
}

/** Response data export (CSV / JSON / XLSX) + summary counts. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const format = req.nextUrl.searchParams.get("format") ?? "summary";
  // include=live|test|all ("test=1" kept for backwards compatibility)
  const include =
    req.nextUrl.searchParams.get("include") ??
    (req.nextUrl.searchParams.get("test") === "1" ? "all" : "live");
  const dataset = parseDataset(req.nextUrl.searchParams.get("dataset"));
  const withQuality = req.nextUrl.searchParams.get("quality") === "1";

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
    .select("session_id, respondent_id, status, seed, answers, calculated, embedded, flags, started_at, completed_at, is_test, quality, review_status, review_reason, reviewed_by, reviewed_at")
    .eq("survey_id", params.id);
  if (include === "live") query = query.eq("is_test", false);
  else if (include === "test") query = query.eq("is_test", true);
  let { data: resp, error: qerr } = (await query.order("started_at")) as { data: any[] | null; error: { message: string } | null };
  if (qerr && /quality|review_status|does not exist|schema cache/i.test(qerr.message)) {
    // migration 0005 not applied yet: serve the data without quality columns
    let q2 = db.from("responses")
      .select("session_id, respondent_id, status, seed, answers, calculated, embedded, flags, started_at, completed_at, is_test")
      .eq("survey_id", params.id);
    if (include === "live") q2 = q2.eq("is_test", false);
    else if (include === "test") q2 = q2.eq("is_test", true);
    resp = ((await q2.order("started_at")).data ?? []) as any[];
  }
  // the dataset filter (REMOVED never in a clean dataset; raw rows untouched)
  const exportRows: QualityExportRow[] = (resp ?? []).map((r: any) => ({
    state: { sessionId: r.session_id, respondentId: r.respondent_id ?? undefined, surveyVersion: ver!.version, startedAt: r.started_at, completedAt: r.completed_at, status: r.status, answers: r.answers ?? {}, embedded: r.embedded ?? {}, calculated: r.calculated ?? {}, isTest: !!r.is_test },
    quality: r.quality ?? null,
    review: { status: r.review_status ?? null, reason: r.review_reason ?? null, by: r.reviewed_by ?? null, at: r.reviewed_at ?? null },
  }));
  if (format === "xlsx") {
    const buf = await exportResponsesXlsx(parsed.data, exportRows, { dataset, qualityColumns: withQuality || dataset.kind !== "all" || exportRows.some((r) => r.quality) });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${parsed.data.meta.code}_${include}_${dataset.kind}_responses.xlsx"`,
      },
    });
  }
  const kept = exportRows.filter((r) => inDataset(r, dataset));
  resp = (resp ?? []).filter((r: any) => kept.some((k) => k.state.sessionId === r.session_id));

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
        durationSec: raw?.quality?.system?.SYSTEM_TOTAL_DURATION ?? (started && done ? Math.round((done - started) / 1000) : null),
        flags: st.flags,
        vars: flattenVariables(parsed.data, st as any),
        quality: raw?.quality ? { classification: raw.quality.classification, qualityScore: raw.quality.qualityScore, riskScore: raw.quality.riskScore, flags: raw.quality.flags?.length ?? 0 } : null,
        review: raw?.review_status ?? null,
      };
    });
    return NextResponse.json({ version: ver!.version, columns, rows, dataset: dataset.kind, total: exportRows.length, included: rows.length });
  }

  const csv = responsesToCSV(parsed.data, states as any, withQuality ? { columns: QUALITY_CSV_COLUMNS, cells: (i) => qualityCsvCells(kept[i]) } : undefined);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${parsed.data.meta.code}_${include}${dataset.kind !== "all" ? `_${dataset.kind}` : ""}_responses.csv"`,
    },
  });
}
