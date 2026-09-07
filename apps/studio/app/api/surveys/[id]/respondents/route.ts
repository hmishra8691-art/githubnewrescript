import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { parseEnvironment } from "@/lib/responseData";
import { audit, isFailure, requireProject } from "@/lib/guard";
import {
  parseSpreadsheet, parseDelimitedList, guessRespondentMapping,
  prepareRespondentList, summariseRespondentList,
  type ColumnTarget,
} from "@rescript/exporters";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * THE RESPONDENT LIST (§24).
 *
 * `access.mode` has offered `unique_links` and `invitation` since the first
 * release and neither has ever been usable, because nothing could put a row
 * in `respondents`. The Studio said so out loud: a warning chip told the
 * programmer the live link "will refuse everyone until tokens exist in the
 * respondents table". This route is what deletes that chip.
 *
 *   GET    ?environment=&list=&status=&search=&limit=&offset=
 *   POST   { environment, stage: "preview" | "commit", listName,
 *            text | xlsxBase64 | rows, format?, sheet?, mapping? }
 *   PATCH  { environment, action: "mark_sent" | "mark_unsent", ids? | list? }
 *   DELETE ?ids=a,b   or   ?list=wave%201&environment=TEST
 *
 * THE UPLOAD IS TWO-STAGE, exactly like the response importer: `preview`
 * parses, maps, reports what it found and writes nothing; `commit` posts the
 * same rows back. A list of 4 000 people is the kind of thing that must be
 * looked at before it is committed, because the failure mode — inviting the
 * wrong file, or the same file twice — cannot be undone by deleting rows once
 * the links have gone out.
 *
 * TOKENS ARE NOT MINTED HERE. `respondents.token` defaults to
 * `encode(gen_random_bytes(16),'hex')`, so the secret is generated inside the
 * database by a CSPRNG and this code never sees a token until it reads one
 * back. That is deliberate: a link is a credential, and application code that
 * chooses credentials is application code that can get it wrong.
 *
 * NOTHING HERE SENDS ANYTHING. There is no mail transport in this platform.
 * `sent_at` is marked by a human who has actually sent the links, which is
 * why it is a separate action rather than a side effect of uploading.
 */

/*
 * The parsing, the mapping guess and the duplicate detection are pure, and
 * therefore live in `@rescript/exporters` beside the spreadsheet importer,
 * where they are unit-tested against the shapes client files actually arrive
 * in. What is left here is what cannot be pure: permissions, the two-stage
 * preview, and the insert that lets the database mint each token.
 */
const MAX_ROWS = 20_000;

/* ------------------------------------------------------------------ read */

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const sp = req.nextUrl.searchParams;
  const environment = parseEnvironment(sp.get("environment") ?? "LIVE");
  if (!environment || environment === "ALL") {
    return NextResponse.json({ error: "environment must be TEST or LIVE — a respondent list belongs to one" }, { status: 400 });
  }
  const isTest = environment === "TEST";
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit") ?? 100)));
  const offset = Math.max(0, Number(sp.get("offset") ?? 0));

  const db = supabaseAdmin();
  let q = db
    .from("respondents")
    .select("id, token, name, email, external_id, status, list_name, sent_at, invited_at, embedded", { count: "exact" })
    .eq("survey_id", params.id)
    .eq("is_test", isTest)
    .order("invited_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const list = sp.get("list");
  if (list) q = q.eq("list_name", list);
  const status = sp.get("status");
  if (status) q = q.eq("status", status);
  const search = sp.get("search")?.trim();
  if (search) {
    const like = `%${search.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    q = q.or(`email.ilike.${like},external_id.ilike.${like},name.ilike.${like}`);
  }

  const { data, count, error } = await q;
  if (error) {
    /*
     * Migration 0013 not applied: an empty, explicitly unavailable panel
     * rather than an error, the shape every migration-gated panel here uses.
     */
    if (/is_test|list_name|does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({
        available: false, environment, rows: [], total: 0, stats: [],
        note: "Respondent lists need migration 0013.",
      }, { headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const stats = await db.rpc("rescript_respondent_stats", { p_survey: params.id, p_is_test: isTest });

  return NextResponse.json({
    available: true,
    environment,
    total: count ?? 0,
    offset,
    limit,
    rows: (data ?? []).map((r) => ({
      id: r.id, token: r.token, name: r.name, email: r.email, externalId: r.external_id,
      status: r.status, listName: r.list_name, sentAt: r.sent_at, invitedAt: r.invited_at,
      embeddedCount: Object.keys((r.embedded ?? {}) as object).length,
    })),
    stats: (stats.data ?? []).map((s: Record<string, unknown>) => ({
      listName: s.list_name,
      total: Number(s.total ?? 0),
      sent: Number(s.sent ?? 0),
      notSent: Number(s.not_sent ?? 0),
      waiting: Number(s.waiting ?? 0),
      started: Number(s.started ?? 0),
      completed: Number(s.completed ?? 0),
      screened: Number(s.screened ?? 0),
      quotaFull: Number(s.quota_full ?? 0),
      terminated: Number(s.terminated ?? 0),
      firstInvited: s.first_invited ?? null,
      lastInvited: s.last_invited ?? null,
    })),
  }, { headers: { "cache-control": "no-store" } });
}

/* ---------------------------------------------------------------- upload */

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  /*
   * `deploy.manage`, not `survey.edit`. Minting invitation links is shipping
   * the study, and the platform's roles separate the two on purpose — a
   * programmer edits the survey, a deployment manager sends it (see
   * packages/access/src/roles.ts).
   */
  const gate = await requireProject(req, params.id, "deploy.manage");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const environment = parseEnvironment(body?.environment);
  if (!environment || environment === "ALL") {
    return NextResponse.json({ error: "environment must be TEST or LIVE" }, { status: 400 });
  }
  const isTest = environment === "TEST";
  const stage = body?.stage === "commit" ? "commit" : "preview";
  const listName = String(body?.listName ?? "").trim().slice(0, 120) || null;

  let headers: string[] = [];
  let rows: Record<string, unknown>[] = [];
  let sheetInfo: { sheetName?: string; sheetNames?: string[] } = {};

  if (Array.isArray(body?.rows)) {
    rows = body.rows as Record<string, unknown>[];
    headers = Array.isArray(body?.headers) && body.headers.length
      ? body.headers.map(String)
      : Object.keys(rows[0] ?? {});
  } else if (typeof body?.xlsxBase64 === "string" && body.xlsxBase64) {
    /*
     * A workbook is parsed HERE, as in the response importer: exceljs is
     * already a server dependency because every export writes with it, and
     * shipping a spreadsheet parser into the Studio bundle to read a file
     * that is about to be posted anyway would be paying twice.
     */
    try {
      const parsed = await parseSpreadsheet(Buffer.from(body.xlsxBase64, "base64"), { sheet: body?.sheet });
      headers = parsed.headers;
      rows = parsed.rows;
      sheetInfo = { sheetName: parsed.sheetName, sheetNames: parsed.sheetNames };
    } catch (e) {
      return NextResponse.json({ error: `that workbook could not be read: ${(e as Error).message}` }, { status: 422 });
    }
  } else if (typeof body?.text === "string" && body.text.trim()) {
    const parsed = parseDelimitedList(body.text);
    headers = parsed.headers;
    rows = parsed.rows;
  } else {
    return NextResponse.json({ error: "nothing to import — paste a list, or choose a file" }, { status: 422 });
  }

  if (!rows.length) return NextResponse.json({ error: "that file has a header row and no people in it" }, { status: 422 });
  if (rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `${rows.length} rows is more than this can take at once (${MAX_ROWS}). Split the file.` }, { status: 413 });
  }

  const mapping: Record<string, ColumnTarget> =
    body?.mapping && typeof body.mapping === "object" ? body.mapping : guessRespondentMapping(headers);

  const parsed = prepareRespondentList(rows, mapping);
  const { people: prepared, issues, duplicates } = parsed;
  const summary = summariseRespondentList(rows.length, parsed, mapping);

  if (stage === "preview") {
    return NextResponse.json({
      stage: "preview",
      environment,
      listName,
      headers,
      mapping,
      ...sheetInfo,
      summary,
      issues: issues.slice(0, 20),
      duplicates: duplicates.slice(0, 20),
      sample: prepared.slice(0, 10),
      rows,
      /* nothing blocks an upload except having no people in it */
      blocking: prepared.length === 0 ? "none of those rows has an email, an id or a name, so there is nobody to invite" : null,
    });
  }

  if (!prepared.length) {
    return NextResponse.json({ error: "there is nobody to invite in that file" }, { status: 422 });
  }

  const db = supabaseAdmin();
  /*
   * Inserted in chunks, and `token` is left out of every row so the database
   * generates it. A partial failure leaves the rows that landed — which is
   * the right outcome for a list: the alternative is one bad address
   * discarding an upload of 4 000 people.
   */
  const CHUNK = 500;
  let inserted = 0;
  const rejected: string[] = [];
  for (let i = 0; i < prepared.length; i += CHUNK) {
    const slice = prepared.slice(i, i + CHUNK).map((p) => ({
      survey_id: params.id,
      is_test: isTest,
      list_name: listName,
      name: p.name,
      email: p.email,
      external_id: p.external_id,
      embedded: p.embedded,
      status: "invited",
    }));
    const { data, error } = await db.from("respondents").insert(slice).select("id");
    if (error) {
      if (/is_test|list_name|does not exist|schema cache/i.test(error.message)) {
        return NextResponse.json({ error: "Respondent lists need migration 0013.", migration: "0013" }, { status: 503 });
      }
      /*
       * Almost always the external-id unique index: somebody in this file is
       * already on the list. Retried one at a time so the clash names the
       * person instead of losing the chunk.
       */
      for (const one of slice) {
        const single = await db.from("respondents").insert(one).select("id");
        if (single.error) rejected.push(one.external_id ?? one.email ?? one.name ?? "(unnamed)");
        else inserted++;
      }
      continue;
    }
    inserted += data?.length ?? 0;
  }

  await audit({
    action: "deployment.started", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "respondent_list", entityId: listName,
    detail: {
      summary: `added ${inserted} ${environment} invitation${inserted === 1 ? "" : "s"}${listName ? ` to “${listName}”` : ""}`,
      environment, listName, inserted, rejected: rejected.length,
    },
  });

  return NextResponse.json({
    ok: true, stage: "commit", environment, listName, inserted,
    alreadyOnTheList: rejected.slice(0, 20),
    alreadyOnTheListCount: rejected.length,
    summary,
  });
}

/* ------------------------------------------------------------ mark sent */

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "deploy.manage");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const environment = parseEnvironment(body?.environment);
  if (!environment || environment === "ALL") {
    return NextResponse.json({ error: "environment must be TEST or LIVE" }, { status: 400 });
  }
  const action = body?.action === "mark_unsent" ? "mark_unsent" : "mark_sent";

  const db = supabaseAdmin();
  let q = db
    .from("respondents")
    .update({ sent_at: action === "mark_sent" ? new Date().toISOString() : null })
    .eq("survey_id", params.id)
    .eq("is_test", environment === "TEST");

  if (Array.isArray(body?.ids) && body.ids.length) q = q.in("id", body.ids.map(String).slice(0, 20000));
  else if (typeof body?.list === "string") q = q.eq("list_name", body.list);
  else return NextResponse.json({ error: "say which respondents: ids, or a list name" }, { status: 400 });

  const { data, error } = await q.select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit({
    action: "deployment.completed", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "respondent_list", entityId: typeof body?.list === "string" ? body.list : null,
    detail: {
      summary: `marked ${data?.length ?? 0} ${environment} invitation${data?.length === 1 ? "" : "s"} as ${action === "mark_sent" ? "sent" : "not sent"}`,
      environment, action,
    },
  });

  return NextResponse.json({ ok: true, affected: data?.length ?? 0 });
}

/* ---------------------------------------------------------------- remove */

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "deploy.manage");
  if (isFailure(gate)) return gate.response;

  const sp = req.nextUrl.searchParams;
  const environment = parseEnvironment(sp.get("environment") ?? "");
  if (!environment || environment === "ALL") {
    return NextResponse.json({ error: "environment must be TEST or LIVE" }, { status: 400 });
  }

  const db = supabaseAdmin();
  let q = db.from("respondents").delete()
    .eq("survey_id", params.id)
    .eq("is_test", environment === "TEST");

  const ids = sp.get("ids");
  const list = sp.get("list");
  if (ids) q = q.in("id", ids.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20000));
  else if (list !== null) q = q.eq("list_name", list);
  else return NextResponse.json({ error: "say which respondents: ids, or a list name" }, { status: 400 });

  /*
   * Only ever an UNUSED invitation. Once somebody has started, their row is
   * what their response points at (`responses.respondent_id`) and what the
   * retake gate reads — deleting it would orphan a real interview and let
   * the same person in again. Those rows are not deletable from here at all;
   * the interview itself is managed in Data.
   */
  q = q.eq("status", "invited");

  const { data, error } = await q.select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit({
    action: "deployment.started", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "respondent_list", entityId: list,
    detail: {
      summary: `removed ${data?.length ?? 0} unused ${environment} invitation${data?.length === 1 ? "" : "s"}${list ? ` from “${list}”` : ""}`,
      environment,
    },
  });

  return NextResponse.json({
    ok: true,
    removed: data?.length ?? 0,
    note: "Only invitations nobody has opened are removed — a respondent who has started keeps their row, because their answers point at it.",
  });
}
