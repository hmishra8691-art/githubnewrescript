import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition } from "@/lib/qualityDef";
import { parseDelimited, suggestMapping, validateImportRows, type ColumnMapping, type ImportMode, type PreparedRow } from "@rescript/engine";
import { parseEnvironment, missingResponseMigration, RESPONSE_MIGRATION_MESSAGE } from "@/lib/responseData";
import { recountQuotas } from "@/lib/quotaRecount";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Import response data: VALIDATE → PREVIEW → CONFIRM → TRANSACTIONAL COMMIT.
 *
 *   POST { environment, stage: "preview", format?, text? | rows?, mapping?, mode }
 *        parse, map, validate, and report — nothing is written. The response
 *        carries the suggested mapping (so the UI can show and change it), the
 *        counts, and every problem with its row number.
 *
 *   POST { environment, stage: "commit", rows, mode, expected? }
 *        commit the PREPARED rows from a preview, in ONE transaction
 *        (`rescript_import_responses`). A file that would half-apply does not
 *        apply at all: create mode raises on a duplicate and the whole call
 *        rolls back.
 *
 * `mode`: create (new rows only) · update (existing keys only) · upsert.
 * An existing respondent code is UPDATED in place — never turned into
 * TEST_000123_2 — and an update merges the file's columns onto the stored
 * answers, so a three-column file changes three answers.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const environment = parseEnvironment(body?.environment);
  if (!environment || environment === "ALL") {
    return NextResponse.json({ error: "environment must be TEST or LIVE — an import has to land in one dataset" }, { status: 400 });
  }
  const mode: ImportMode = body?.mode === "create" ? "create" : body?.mode === "update" ? "update" : "upsert";
  const isTest = environment === "TEST";

  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const def = loaded.def;

  /* ------------------------------------------------------------- preview */
  if (body?.stage !== "commit") {
    let rows: Record<string, unknown>[] = [];
    let headers: string[] = [];
    if (typeof body?.text === "string" && body.text.trim()) {
      if (body?.format === "json") {
        try {
          const j = JSON.parse(body.text);
          const arr = Array.isArray(j) ? j : Array.isArray(j?.rows) ? j.rows : null;
          if (!arr) return NextResponse.json({ error: "the JSON must be an array of row objects, or { rows: [...] }" }, { status: 422 });
          rows = arr.map((r: unknown) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}));
          headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        } catch (e) { return NextResponse.json({ error: `the JSON could not be read: ${(e as Error).message}` }, { status: 422 }); }
      } else {
        const parsed = parseDelimited(body.text);
        headers = parsed.headers;
        rows = parsed.rows;
      }
    } else if (Array.isArray(body?.rows)) {
      rows = body.rows;
      headers = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];
    } else {
      return NextResponse.json({ error: "give the file's text (CSV/TSV/JSON) or a rows array" }, { status: 400 });
    }
    if (!rows.length) return NextResponse.json({ error: "no data rows were found in the file" }, { status: 422 });
    if (rows.length > 20000) return NextResponse.json({ error: `this file has ${rows.length} rows; import at most 20 000 at a time` }, { status: 413 });

    const mapping: ColumnMapping = body?.mapping && typeof body.mapping === "object" ? body.mapping : suggestMapping(def, headers);
    const preview = validateImportRows(def, mapping, rows, mode);

    // which keys already exist, so the preview can say "12 will be updated"
    const keys = preview.rows.map((r) => r.respondentCode).filter((k): k is string => !!k);
    const sessionKeys = preview.rows.map((r) => r.sessionId).filter((k): k is string => !!k);
    const existing = new Set<string>();
    if (keys.length || sessionKeys.length) {
      for (let i = 0; i < keys.length; i += 500) {
        const { data } = await db.from("responses").select("respondent_code").eq("survey_id", params.id).eq("is_test", isTest).is("deleted_at", null).in("respondent_code", keys.slice(i, i + 500));
        for (const r of data ?? []) if (r.respondent_code) existing.add(r.respondent_code);
      }
      for (let i = 0; i < sessionKeys.length; i += 500) {
        const { data } = await db.from("responses").select("session_id, respondent_code").eq("survey_id", params.id).eq("is_test", isTest).is("deleted_at", null).in("session_id", sessionKeys.slice(i, i + 500));
        for (const r of data ?? []) if (r.session_id) existing.add(r.session_id);
      }
    }
    const willUpdate = preview.rows.filter((r) => (r.respondentCode && existing.has(r.respondentCode)) || (r.sessionId && existing.has(r.sessionId))).length;
    const willCreate = preview.rows.length - willUpdate;

    const blocking =
      mode === "create" && willUpdate > 0
        ? `${willUpdate} row${willUpdate === 1 ? "" : "s"} in this file already exist in the ${environment} data. Choose “Update existing” or “Upsert”, or nothing will be imported.`
        : mode === "update" && willCreate > 0
          ? `${willCreate} row${willCreate === 1 ? "" : "s"} have no matching response and would be skipped in “Update existing” mode.`
          : null;

    console.info("[rescript:import] preview", JSON.stringify({ surveyId: params.id, environment, mode, ...preview.summary, willCreate, willUpdate }));
    return NextResponse.json({
      ok: true, stage: "preview", environment, mode,
      mapping: preview.mapping, headers, unmapped: preview.unmapped,
      summary: { ...preview.summary, willCreate, willUpdate },
      issues: preview.issues.slice(0, 500),
      issuesTruncated: preview.issues.length > 500,
      /** the rows to hand back to `stage: "commit"` unchanged */
      rows: preview.rows,
      sample: preview.rows.slice(0, 10),
      blocking,
      questions: def.questions.map((q) => ({ id: q.id, code: q.code, variableName: q.variableName, text: q.text, type: q.type, rows: (q.rows ?? []).map((r) => ({ code: String(r.code), label: r.label })) })),
      embedded: def.embeddedData.map((e) => e.name),
    });
  }

  /* -------------------------------------------------------------- commit */
  const prepared: PreparedRow[] = Array.isArray(body?.rows) ? body.rows : [];
  if (!prepared.length) return NextResponse.json({ error: "nothing to import" }, { status: 400 });
  if (prepared.length > 20000) return NextResponse.json({ error: "too many rows for one import" }, { status: 413 });
  if (!loaded.versionId) return NextResponse.json({ error: "this survey has no saved version yet — save one before importing responses" }, { status: 409 });

  // a row keyed by session id is resolved to its respondent code, because the
  // importer keys on the code (the stable, researcher-visible identifier)
  const sessionKeys = prepared.map((r) => r.sessionId).filter((k): k is string => !!k);
  const codeBySession = new Map<string, string>();
  for (let i = 0; i < sessionKeys.length; i += 500) {
    const { data } = await db.from("responses").select("session_id, respondent_code").eq("survey_id", params.id).eq("is_test", isTest).in("session_id", sessionKeys.slice(i, i + 500));
    for (const r of data ?? []) if (r.session_id && r.respondent_code) codeBySession.set(r.session_id, r.respondent_code);
  }

  const payload = prepared.map((r) => ({
    respondent_code: r.respondentCode ?? (r.sessionId ? codeBySession.get(r.sessionId) ?? null : null),
    answers: r.answers ?? {},
    embedded: r.embedded ?? {},
    status: r.status ?? undefined,
    started_at: r.startedAt ?? undefined,
    completed_at: r.completedAt ?? undefined,
  }));

  const { data, error } = await db.rpc("rescript_import_responses", {
    p_survey: params.id,
    p_version: loaded.versionId,
    p_test: isTest,
    p_mode: mode,
    p_rows: payload,
    p_by: gate.user.fullName || gate.user.userCode,
  });
  if (error) {
    if (/IMPORT_DUPLICATE/.test(error.message)) {
      return NextResponse.json({ error: `${error.message.replace(/^.*IMPORT_DUPLICATE /, "")} — nothing was imported. Choose “Update existing” or “Upsert” to change the responses that already exist.` }, { status: 409 });
    }
    if (missingResponseMigration(error.message)) return NextResponse.json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, { status: 503 });
    console.error("[rescript:import] failed — nothing was committed", JSON.stringify({ surveyId: params.id, environment, mode, error: error.message }));
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // the dataset changed, so this environment's quota counters are stale
  const quotas = await recountQuotas(db, def, params.id, isTest).catch(() => null);
  console.info("[rescript:import] committed", JSON.stringify({ surveyId: params.id, environment, mode, ...(data ?? {}), quotasRecounted: !!quotas }));
  return NextResponse.json({ ok: true, stage: "commit", environment, mode, ...(data ?? {}), quotas });
}
