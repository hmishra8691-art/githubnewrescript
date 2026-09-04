import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition } from "@/lib/qualityDef";
import { Condition } from "@rescript/schema";
import { matchingResponseIds, parseEnvironment, missingResponseMigration, RESPONSE_MIGRATION_MESSAGE } from "@/lib/responseData";
import { recountQuotas } from "@/lib/quotaRecount";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Bulk delete / restore / purge.
 *
 *   POST { environment, ids: [...] }                  the rows the researcher ticked
 *   POST { environment, filter, search?, statuses?, confirmCount }
 *                                                     everything matching a condition
 *   POST { ..., action: "restore" | "purge" }
 *
 * A condition-based delete MUST carry `confirmCount` — the number the
 * researcher was shown. If the dataset moved in between (a response landed,
 * another editor deleted one) the count no longer matches and the delete is
 * REFUSED with the new number, so a "delete 23" can never quietly become a
 * "delete 240". That is the whole reason this route exists separately from the
 * per-response DELETE.
 *
 * Deleting is SOFT: the rows leave every dataset (`deleted_at`), the audit
 * trail records who and why, and `restore` brings them back. `purge` removes
 * permanently and only ever touches rows that are already soft-deleted.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const environment = parseEnvironment(body?.environment);
  if (!environment) return NextResponse.json({ error: "environment must be TEST, LIVE or ALL" }, { status: 400 });
  const action = body?.action === "restore" ? "restore" : body?.action === "purge" ? "purge" : "delete";
  const by = gate.user.fullName || gate.user.userCode;
  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 1000) : null;

  const db = supabaseAdmin();
  let ids: string[] = [];
  let codes: string[] = [];

  if (Array.isArray(body?.ids) && body.ids.length) {
    ids = body.ids.map(String).slice(0, 50000);
    // ids must belong to THIS survey and THIS environment — a stale or forged
    // id from another survey can never be deleted through here
    let sel = db.from("responses").select("id, respondent_code, is_test").eq("survey_id", params.id).in("id", ids);
    if (environment === "TEST") sel = sel.eq("is_test", true);
    else if (environment === "LIVE") sel = sel.eq("is_test", false);
    const { data, error } = await sel;
    if (error) {
      if (missingResponseMigration(error.message)) return NextResponse.json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, { status: 503 });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const owned = data ?? [];
    if (owned.length !== ids.length) {
      return NextResponse.json({ error: `${ids.length - owned.length} of the selected responses are not in this survey's ${environment} data, so nothing was deleted.` }, { status: 409 });
    }
    ids = owned.map((r) => r.id);
    codes = owned.map((r) => r.respondent_code ?? r.id);
  } else if (body?.filter || body?.search || body?.statuses) {
    let filter = null;
    if (body?.filter) {
      const parsed = Condition.safeParse(body.filter);
      if (!parsed.success) return NextResponse.json({ error: "filter is not a valid condition" }, { status: 422 });
      filter = parsed.data;
    }
    const loaded = await loadQualityDefinition(db, params.id);
    if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    try {
      const found = await matchingResponseIds(db, loaded.def, {
        surveyId: params.id, environment, filter,
        search: typeof body?.search === "string" ? body.search : undefined,
        statuses: Array.isArray(body?.statuses) ? body.statuses.map(String) : undefined,
        from: body?.from, to: body?.to,
        deleted: action !== "delete",
      });
      if (found.capped) return NextResponse.json({ error: "This filter matches more responses than one operation may change (50 000). Narrow it and try again." }, { status: 413 });
      // the confirmation contract
      const confirm = Number.isFinite(body?.confirmCount) ? Number(body.confirmCount) : null;
      if (confirm === null) return NextResponse.json({ error: "confirmCount is required for a filter-based operation — show the researcher the count first", found: found.ids.length }, { status: 428 });
      if (confirm !== found.ids.length) {
        return NextResponse.json({
          error: `The data changed since you were shown ${confirm} response${confirm === 1 ? "" : "s"} — ${found.ids.length} now match, so nothing was ${action}d. Check the new count and confirm again.`,
          recount: found.ids.length, expected: confirm,
        }, { status: 409 });
      }
      ids = found.ids;
      codes = found.codes;
    } catch (e) {
      const msg = (e as Error).message;
      if (missingResponseMigration(msg)) return NextResponse.json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, { status: 503 });
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  } else {
    return NextResponse.json({ error: "give either ids or a filter — a bulk delete with neither would mean 'everything'" }, { status: 400 });
  }

  if (!ids.length) return NextResponse.json({ ok: true, affected: 0, action, note: "nothing matched" });

  const fn = action === "purge" ? "rescript_purge_responses" : action === "restore" ? "rescript_restore_responses" : "rescript_soft_delete_responses";
  const args: Record<string, unknown> = { p_survey: params.id, p_ids: ids, p_by: by };
  if (action === "delete") args.p_reason = reason;
  const { data: affected, error } = await db.rpc(fn, args);
  if (error) {
    if (missingResponseMigration(error.message)) return NextResponse.json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // the dataset changed: recount the affected environment(s)
  const quotas: Record<string, unknown> = {};
  for (const isTest of environment === "ALL" ? [true, false] : [environment === "TEST"]) {
    const r = await recountQuotas(db, undefined, params.id, isTest).catch(() => null);
    if (r) quotas[isTest ? "TEST" : "LIVE"] = r;
  }
  console.info("[rescript:data] bulk", JSON.stringify({ surveyId: params.id, environment, action, affected, by, reason, sample: codes.slice(0, 5) }));
  return NextResponse.json({ ok: true, action, affected: typeof affected === "number" ? affected : ids.length, respondentCodes: codes.slice(0, 200), quotas });
}
