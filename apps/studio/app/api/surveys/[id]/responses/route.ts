import { NextRequest, NextResponse } from "next/server";
import { assertNotReadOnly, getMeter, projectContext, recordUsage } from "@/lib/metering";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { responsesToCSV, exportResponsesXlsx, responsesToSav, responsesToSavBundle, responsesToSasBundle, inDataset, ENVIRONMENT_COLUMNS, environmentCells, QUALITY_CSV_COLUMNS, qualityCsvCells, SAMPLE_COLUMNS, sampleCells, VALUE_MODES, renderValue, dictionaryIndex, type DatasetFilter, type QualityExportRow, type ValueMode } from "@rescript/exporters";
import { buildVariableDictionary, flattenVariables } from "@rescript/engine";
import { audit, isFailure, requireProject } from "@/lib/guard";

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
  /*
   * `values=code|label|code_label` — whether a coded answer is written as its
   * code, its label, or both. Anything unrecognised falls back to `code`,
   * which is what every file produced before this option existed contained:
   * a mistyped parameter must not silently change what a client receives.
   *
   * It applies to the text formats only. SPSS and SAS carry codes in the
   * cells and the labels as metadata, which is the whole reason to use them.
   */
  /*
   * `dictionary=1` ships the data dictionary with the data (§44.5). For a
   * `.sav` that turns the download into a zip, which is a visible change in
   * what the researcher gets — so it only happens when asked, and a bare
   * `format=sav` returns the same single file it did in phase 1.
   */
  const withDictionary = req.nextUrl.searchParams.get("dictionary") === "1";
  const valuesParam = req.nextUrl.searchParams.get("values");
  const valueMode: ValueMode = VALUE_MODES.some((m) => m.mode === valuesParam) ? (valuesParam as ValueMode) : "code";

  /*
   * A download is recorded; the summary count on the header is not. The line
   * between them is whether rows leave the platform — that is the event a
   * data-protection question is actually about, and it was not written down
   * anywhere.
   */
  if (format !== "summary") {
    // METERING: a read-only project may still export only when the configuration allows it; the download is a usage event either way
    const meter = getMeter();
    /* the file's own dataset decides this: `include=test` is test work */
    const mctx = projectContext(gate, include === "test" ? "TEST" : "LIVE");
    const blocked = await assertNotReadOnly(meter, mctx, "export");
    if (blocked) return blocked;
    void recordUsage(meter, mctx, { eventType: "EXPORT_GENERATION", quantity: 1, metadata: { format, dataset, include } });
    await audit({
      action: "responses.exported", userId: gate.user.userId, sessionId: gate.user.sessionId,
      surveyId: params.id, customerId: gate.user.customerId,
      entity: "responses", entityId: null,
      detail: { format, dataset, include, quality: withQuality },
    });
  }

  if (format === "summary") {
    /* binned rows are not data — see the note on the export query below. The
       fallback is for a database from before migration 0006, which has no
       soft delete and therefore nothing to exclude. */
    let { data, error: sErr } = await db
      .from("responses")
      .select("status, is_test")
      .eq("survey_id", params.id)
      .is("deleted_at", null);
    if (sErr && /deleted_at|does not exist|schema cache/i.test(sErr.message)) {
      data = (await db.from("responses").select("status, is_test").eq("survey_id", params.id)).data;
    }
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

  /*
   * A RESPONSE THE RESEARCHER BINNED MUST NOT REACH THE DELIVERED FILE.
   *
   * This query had no `deleted_at` filter, while every other reader in the
   * platform has one — `responseData.ts` ("soft-deleted rows are not data"),
   * the analytics loader, the counts on the Data tab. So the screen said
   * seven responses and the CSV handed to the client contained twelve,
   * including the five completes the researcher had just removed as
   * fraudulent. Nothing warned anybody: the file looked entirely normal.
   *
   * The Data tab's contract is that a deleted row leaves EVERY dataset. The
   * export is a dataset. Rows are recoverable from the recycle bin until they
   * are purged, so nothing is lost by excluding them here.
   */
  /*
   * PAGED, BECAUSE POSTGREST TRUNCATES SILENTLY.
   *
   * This was one unbounded `select … order by started_at`. PostgREST caps the
   * result at `db-max-rows` and answers **200 OK**, so a 4,000-complete study
   * exported 1,000 rows under the right filename, with the right header and no
   * warning anywhere — the researcher delivers a quarter of their fieldwork and
   * nothing tells them. Where the cap is NOT configured the same line instead
   * loaded every response with its full answer payload into one function's
   * memory, which is the other way to lose the export.
   *
   * Every other bulk reader here already chunks (`lib/analytics.ts`,
   * `lib/responseData.ts`, both at 1000, both stopping on a short chunk); this
   * is that pattern, and `range()` overrides the cap rather than colliding with
   * it. `MAX_EXPORT_ROWS` is a real ceiling rather than an accident of
   * configuration, and crossing it is REPORTED (see below) instead of quietly
   * shortening the file.
   */
  const CHUNK = 1000;
  const MAX_EXPORT_ROWS = 500_000;
  const COLUMNS = "session_id, respondent_id, status, seed, answers, calculated, embedded, flags, started_at, completed_at, is_test, quality, review_status, review_reason, reviewed_by, reviewed_at, sample_source, sample_source_respondent";
  const FALLBACK_COLUMNS = "session_id, respondent_id, status, seed, answers, calculated, embedded, flags, started_at, completed_at, is_test";

  const page = (columns: string, softDelete: boolean, start: number) => {
    let q = db.from("responses").select(columns).eq("survey_id", params.id);
    if (softDelete) q = q.is("deleted_at", null);
    if (include === "live") q = q.eq("is_test", false);
    else if (include === "test") q = q.eq("is_test", true);
    return q.order("started_at").range(start, start + CHUNK - 1);
  };

  const readAll = async (columns: string, softDelete: boolean): Promise<{ rows: any[]; error: { message: string } | null; capped: boolean }> => {
    const rows: any[] = [];
    for (let start = 0; start < MAX_EXPORT_ROWS; start += CHUNK) {
      const { data, error } = (await page(columns, softDelete, start)) as { data: any[] | null; error: { message: string } | null };
      if (error) return { rows, error, capped: false };
      const chunk = data ?? [];
      rows.push(...chunk);
      if (chunk.length < CHUNK) return { rows, error: null, capped: false };
    }
    return { rows, error: null, capped: true };
  };

  let { rows: resp, error: qerr, capped } = await readAll(COLUMNS, true);
  if (qerr && /quality|review_status|sample_source|deleted_at|does not exist|schema cache/i.test(qerr.message)) {
    /*
     * A column the database has not got yet — migration 0005 (quality), 0006
     * (soft delete) or 0012 (sample source). Serve the data without them
     * rather than refusing the export: a researcher who cannot download their
     * responses because a migration is pending has lost the study, not a
     * column.
     *
     * Dropping the `deleted_at` filter here is safe rather than a hole: a
     * database without the column has no soft delete, so it has no binned
     * rows to leak.
     */
    const fallback = await readAll(FALLBACK_COLUMNS, false);
    resp = fallback.rows;
    qerr = fallback.error;
    capped = fallback.capped;
  }
  if (qerr) return NextResponse.json({ error: qerr.message }, { status: 500 });
  /*
   * A file that is short is not a file. The old code could not even detect
   * this; now that it can, it refuses rather than handing over a plausible
   * download that is missing four fifths of the fieldwork.
   */
  if (capped) {
    return NextResponse.json(
      {
        error: `This export is larger than ${MAX_EXPORT_ROWS.toLocaleString("en")} responses. Narrow it with a date range or a dataset filter, or ask for it to be delivered in parts — a truncated file would look complete.`,
        code: "export_too_large",
      },
      { status: 413 },
    );
  }
  // the dataset filter (REMOVED never in a clean dataset; raw rows untouched)
  const exportRows: QualityExportRow[] = (resp ?? []).map((r: any) => ({
    state: { sessionId: r.session_id, respondentId: r.respondent_id ?? undefined, surveyVersion: ver!.version, startedAt: r.started_at, completedAt: r.completed_at, status: r.status, answers: r.answers ?? {}, embedded: r.embedded ?? {}, calculated: r.calculated ?? {}, isTest: !!r.is_test, sampleSource: r.sample_source ?? null, sampleSourceRespondent: r.sample_source_respondent ?? null },
    quality: r.quality ?? null,
    review: { status: r.review_status ?? null, reason: r.review_reason ?? null, by: r.reviewed_by ?? null, at: r.reviewed_at ?? null },
  }));
  /*
   * `include=all` runs neither `is_test` branch above, so the file carries
   * both — and until this was added nothing in it said which row was which.
   * The column goes on whenever the file CAN mix, not only when it happens to:
   * a study whose pilot has not started yet still exports the column, so the
   * client's script does not gain one halfway through fieldwork.
   */
  const withEnvironment = include === "all";
  if (format === "xlsx") {
    const buf = await exportResponsesXlsx(parsed.data, exportRows, { dataset, environmentColumn: withEnvironment, qualityColumns: withQuality || dataset.kind !== "all" || exportRows.some((r) => r.quality), valueMode });
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
  /*
   * THE STATISTICAL FORMATS.
   *
   * Placed here, after the dataset filter has been applied to `states`, so
   * they export exactly the rows the CSV does. They deliberately ignore
   * `values`: in a .sav or a SAS dataset the code IS the value and the label
   * is metadata attached to it, which is what lets the recipient run a
   * frequency and see "Male 412" without the file ever containing the word.
   * Writing labels into the cells would produce a string variable and cost
   * them every analysis the format exists for.
   */
  if (format === "sav" || format === "sas") {
    const fileBase = `${parsed.data.meta.code}_${include}${dataset.kind !== "all" ? `_${dataset.kind}` : ""}`;
    const mediaBaseUrl = process.env.STUDIO_PUBLIC_URL ?? null;
    if (format === "sav") {
      if (withDictionary) {
        const buf = responsesToSavBundle(parsed.data, states as any, { mediaBaseUrl });
        return new NextResponse(new Uint8Array(buf), {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${fileBase}_spss.zip"`,
          },
        });
      }
      const buf = responsesToSav(parsed.data, states as any, { mediaBaseUrl });
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          "content-type": "application/x-spss-sav",
          "content-disposition": `attachment; filename="${fileBase}.sav"`,
        },
      });
    }
    /*
     * SAS is a BUNDLE, not a file: the transport file truncates names to 8
     * characters and labels to 40, so on its own it silently loses part of
     * the dictionary. The zip carries the CSV and the generated syntax with
     * the full names, labels and PROC FORMAT value labels beside it.
     */
    const csvForSas = responsesToCSV(parsed.data, states as any, undefined, { mediaBaseUrl });
    const buf = responsesToSasBundle(parsed.data, states as any, { mediaBaseUrl, csv: csvForSas, includeDictionary: withDictionary });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${fileBase}_sas.zip"`,
      },
    });
  }

  if (format === "json") {
    // Ordered by the data dictionary, so columns follow questionnaire order.
    const dict = buildVariableDictionary(parsed.data).filter((v) => v.responseType !== "system");
    const columns = dict.map((v) => v.name);
    /*
     * JSON keeps a multiple response as a LIST rather than joining it — the
     * consumer is code, and a list is what code wants. `renderValue` returns
     * the array untouched in code mode and element-wise in label mode, so
     * that shape holds whichever mode is asked for.
     */
    const byName = dictionaryIndex(dict);
    const renderVars = (vars: Record<string, unknown>) => {
      if (valueMode === "code") return vars;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(vars)) out[k] = renderValue(v, byName.get(k), valueMode);
      return out;
    };
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
        sampleSource: raw?.sample_source ?? null,
        sampleSourceRespondent: raw?.sample_source_respondent ?? null,
        vars: renderVars(flattenVariables(parsed.data, st as any, { mediaBaseUrl: process.env.STUDIO_PUBLIC_URL ?? null })),
        quality: raw?.quality ? { classification: raw.quality.classification, qualityScore: raw.quality.qualityScore, riskScore: raw.quality.riskScore, flags: raw.quality.flags?.length ?? 0 } : null,
        review: raw?.review_status ?? null,
      };
    });
    return NextResponse.json({ version: ver!.version, columns, rows, dataset: dataset.kind, total: exportRows.length, included: rows.length });
  }

  /*
   * The two optional column sets are COMPOSED, not chosen between. `extra`
   * takes one block, so a quality export used to be able to carry the quality
   * columns or nothing — adding the source columns as a second caller would
   * have silently dropped whichever came second.
   */
  const withSample = kept.some((r) => r.state.sampleSource);
  const extraColumns = [
    ...(withQuality ? QUALITY_CSV_COLUMNS : []),
    ...(withSample ? SAMPLE_COLUMNS : []),
    ...(withEnvironment ? ENVIRONMENT_COLUMNS : []),
  ];
  const csv = responsesToCSV(
    parsed.data,
    states as any,
    extraColumns.length
      ? {
          columns: extraColumns,
          cells: (i) => [
            ...(withQuality ? qualityCsvCells(kept[i]) : []),
            ...(withSample ? sampleCells(kept[i]) : []),
            ...(withEnvironment ? environmentCells(kept[i]) : []),
          ],
        }
      : undefined,
    { mediaBaseUrl: process.env.STUDIO_PUBLIC_URL ?? null, valueMode },
  );
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${parsed.data.meta.code}_${include}${dataset.kind !== "all" ? `_${dataset.kind}` : ""}_responses.csv"`,
    },
  });
}
