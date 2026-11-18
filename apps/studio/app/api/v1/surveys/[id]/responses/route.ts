import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { flattenVariables } from "@rescript/engine";
import { inDataset } from "@rescript/exporters";
import { customerDb } from "@/lib/db";
import { audit, isFailure, requireProjectFor } from "@/lib/guard";
import { requireApiKey } from "@/lib/apiKeys";
import { decodeCursor, encodeCursor } from "@/lib/apiKeysCore";
import { resolveExportVersions } from "@/lib/exportVersions";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/surveys/{id}/responses — response data, a page at a time (scope responses:read; the owner needs
 * responses.export on the project, as for a download in the Studio). P2-13; docs: content/docs/api.md.
 *
 *   ?environment=live|test (live)  ?dataset=all|clean (all)  ?limit=1..500 (100)  ?cursor=<next_cursor>
 *
 * Each row is read through the version it was collected under (the same rule as the Studio's export) and comes back
 * with its variables by name. Binned responses are never included. Ordered by start time, then id; `next_cursor` is
 * null on the last page.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireApiKey(req, "responses:read");
  if (isFailure(caller)) return caller.response;
  const gate = await requireProjectFor(caller.user, params.id, "responses.export");
  if (isFailure(gate)) return gate.response;
  const sp = req.nextUrl.searchParams;
  const environment = sp.get("environment") === "test" ? "test" : "live";
  const dataset = sp.get("dataset") === "clean" ? "clean" : "all";
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit") ?? 100) || 100));
  const cursorRaw = sp.get("cursor");
  const cursor = decodeCursor(cursorRaw);
  if (cursorRaw && !cursor) return NextResponse.json({ error: "That cursor is not one this API issued." }, { status: 400 });

  const db = customerDb(gate.survey.customer_id);
  const { data: survey } = await db.from("surveys").select("current_version_id, draft_definition").eq("id", params.id).single();
  if (!survey?.current_version_id) return NextResponse.json({ error: "This project has no published version yet." }, { status: 409 });
  const { data: ver } = await db.from("survey_versions").select("definition, version").eq("id", survey.current_version_id).single();
  const parsed = ver ? SurveyDefinition.safeParse(ver.definition) : null;
  if (!parsed?.success) return NextResponse.json({ error: "The project's definition could not be read." }, { status: 500 });

  let q = db.from("responses")
    .select("id, session_id, version_id, respondent_id, respondent_code, status, seed, answers, calculated, embedded, flags, started_at, completed_at, is_test, quality, review_status, sample_source, sample_source_respondent")
    .eq("survey_id", params.id).is("deleted_at", null).eq("is_test", environment === "test");
  if (cursor) q = q.or(`started_at.gt.${cursor.startedAt},and(started_at.eq.${cursor.startedAt},id.gt.${cursor.id})`);
  const { data: rows, error } = await q.order("started_at", { ascending: true }).order("id", { ascending: true }).limit(limit + 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const page = (rows ?? []).slice(0, limit) as any[];
  const more = (rows ?? []).length > limit;

  const draft = (survey as { draft_definition?: unknown }).draft_definition ? SurveyDefinition.safeParse((survey as { draft_definition?: unknown }).draft_definition) : null;
  const versioned = await resolveExportVersions(db, page, { versionId: survey.current_version_id, version: String(ver!.version), def: parsed.data }, undefined, draft?.success ? draft.data : null);
  const filter = dataset === "clean" ? { kind: "clean" as const } : { kind: "all" as const };
  const data = page.filter((r) => inDataset({ state: { sessionId: r.session_id, status: r.status, answers: {}, embedded: {}, calculated: {} } as never, quality: r.quality ?? null, review: { status: r.review_status ?? null, reason: null, by: null, at: null } }, filter)).map((r) => {
    const v = versioned.forSession(r.session_id);
    const state = { sessionId: r.session_id, respondentId: r.respondent_id ?? undefined, seed: r.seed == null ? undefined : Number(r.seed), surveyVersion: v.version, startedAt: r.started_at, completedAt: r.completed_at, status: r.status, answers: r.answers ?? {}, embedded: r.embedded ?? {}, calculated: r.calculated ?? {}, flags: r.flags ?? [] };
    return {
      id: r.id, respondentCode: r.respondent_code ?? null, status: r.status, startedAt: r.started_at, completedAt: r.completed_at,
      surveyVersion: v.version, sampleSource: r.sample_source ?? null, sampleSourceRespondent: r.sample_source_respondent ?? null,
      quality: r.quality ? { classification: r.quality.classification ?? null, verdict: r.quality.verdict ?? null } : null, review: r.review_status ?? null,
      variables: flattenVariables(v.def, state as never, { mediaBaseUrl: process.env.STUDIO_PUBLIC_URL ?? null }),
    };
  });
  const last = page[page.length - 1];
  if (!cursor) await audit({ action: "responses.exported", userId: caller.user.userId, sessionId: caller.user.sessionId, surveyId: params.id, customerId: caller.user.customerId, detail: { format: "api", dataset, include: environment, via: "api", keyId: caller.keyId } });
  return NextResponse.json({ data, next_cursor: more && last ? encodeCursor(last.started_at, last.id) : null, environment, dataset, ...(versioned.warnings.length ? { warnings: versioned.warnings } : {}) }, { headers: { "cache-control": "no-store" } });
}
