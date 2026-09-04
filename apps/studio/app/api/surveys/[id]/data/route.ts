import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition } from "@/lib/qualityDef";
import { Condition } from "@rescript/schema";
import {
  countResponses, parseEnvironment, queryResponses, responseCounts,
  missingResponseMigration, RESPONSE_MIGRATION_MESSAGE, type ResponseQuery,
} from "@/lib/responseData";

export const dynamic = "force-dynamic";

/**
 * Response Data Manager — the dataset.
 *
 *   GET  ?environment=TEST|LIVE|ALL&status=&search=&from=&to=&sort=&dir=&limit=&offset=&deleted=1
 *        one page of rows plus the total that matches, and the per-environment
 *        counts for the header.
 *   POST { environment, filter, search?, statuses?, count: true }
 *        how many responses match a condition — the number shown before a
 *        bulk operation is ever offered.
 *
 * `environment` is REQUIRED and has no default. A caller that omits it gets
 * 400, not a mixed dataset: this is the enforcement point for "test and live
 * never mix", and it sits in front of the database rather than in the UI.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const sp = req.nextUrl.searchParams;
  const environment = parseEnvironment(sp.get("environment"));
  if (!environment) return NextResponse.json({ error: "environment must be TEST, LIVE or ALL" }, { status: 400 });

  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });

  const sortField = (sp.get("sort") ?? "started_at") as ResponseQuery["sort"] extends undefined ? never : NonNullable<ResponseQuery["sort"]>["field"];
  const allowedSort = ["started_at", "completed_at", "updated_at", "respondent_code", "status"];
  const q: ResponseQuery = {
    surveyId: params.id,
    environment,
    statuses: sp.getAll("status").flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean),
    search: sp.get("search") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    deleted: sp.get("deleted") === "1",
    sort: { field: (allowedSort.includes(sortField) ? sortField : "started_at") as never, dir: sp.get("dir") === "asc" ? "asc" : "desc" },
    limit: Number(sp.get("limit") ?? 50),
    offset: Number(sp.get("offset") ?? 0),
  };

  try {
    const [page, counts] = await Promise.all([
      queryResponses(db, loaded.def, q),
      responseCounts(db, params.id).catch(() => null),
    ]);
    return NextResponse.json({ ...page, counts, definitionSource: loaded.source, version: loaded.version }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message;
    if (missingResponseMigration(msg)) return NextResponse.json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, { status: 503 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const environment = parseEnvironment(body?.environment);
  if (!environment) return NextResponse.json({ error: "environment must be TEST, LIVE or ALL" }, { status: 400 });

  let filter = null;
  if (body?.filter) {
    const parsed = Condition.safeParse(body.filter);
    if (!parsed.success) return NextResponse.json({ error: "filter is not a valid condition", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 422 });
    filter = parsed.data;
  }

  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });

  try {
    const res = await countResponses(db, loaded.def, {
      surveyId: params.id, environment, filter,
      search: typeof body?.search === "string" ? body.search : undefined,
      statuses: Array.isArray(body?.statuses) ? body.statuses.map(String) : undefined,
      from: body?.from, to: body?.to, deleted: !!body?.deleted,
    });
    console.info("[rescript:data] count", JSON.stringify({ surveyId: params.id, environment, total: res.total, exact: res.exact }));
    return NextResponse.json({ ...res, environment });
  } catch (e) {
    const msg = (e as Error).message;
    if (missingResponseMigration(msg)) return NextResponse.json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, { status: 503 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
