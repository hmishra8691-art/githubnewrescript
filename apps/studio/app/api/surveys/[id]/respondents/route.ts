import { NextRequest, NextResponse } from "next/server";
import { parseEnvironment } from "@/lib/responseData";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { peopleSandboxAllowed, runIntake, sandboxPeople, sandboxStore, type IntakeStore, type SandboxPerson } from "@/lib/respondentIntake";

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
 *          { environment, action: "rename_list", list, to }
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

/* ------------------------------------------------------------------ read */

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  /*
   * Names, emails and external ids are respondent CONTACT DETAILS
   * (`responses.read_pii`, 0062). Every role that held `responses.read` holds
   * it, so nobody loses the list; a custom member can be given data without it.
   */
  if (peopleSandboxAllowed(params.id)) return sandboxList(req);
  const gate = await requireProject(req, params.id, "responses.read_pii");
  if (isFailure(gate)) return gate.response;

  const sp = req.nextUrl.searchParams;
  const environment = parseEnvironment(sp.get("environment") ?? "LIVE");
  if (!environment || environment === "ALL") {
    return NextResponse.json({ error: "environment must be TEST or LIVE — a respondent list belongs to one" }, { status: 400 });
  }
  const isTest = environment === "TEST";
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit") ?? 100)));
  const offset = Math.max(0, Number(sp.get("offset") ?? 0));

  const db = gate.db;
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
  /* the database-less /sandbox fixture: the same two stages, kept in memory (never in production) */
  if (peopleSandboxAllowed(params.id)) {
    let sb: any;
    try { sb = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
    const env = parseEnvironment(sb?.environment);
    if (!env || env === "ALL") return NextResponse.json({ error: "environment must be TEST or LIVE" }, { status: 400 });
    const o = await runIntake(sandboxStore(env === "TEST"), sb, env);
    return NextResponse.json(o.body, { status: o.status });
  }
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
  const db = gate.db;

  const store: IntakeStore = {
    async existing(emails, externalIds) {
      const out = { emails: new Set<string>(), externalIds: new Set<string>() };
      const base = () => db.from("respondents").select("email, external_id").eq("survey_id", params.id).eq("is_test", isTest);
      for (let i = 0; i < externalIds.length; i += 200) {
        const { data } = await base().in("external_id", externalIds.slice(i, i + 200));
        for (const r of data ?? []) if (r.external_id) out.externalIds.add(String(r.external_id).toLowerCase());
      }
      /* ids are matched as written first; a file that writes them in another case is caught by the index on commit */
      for (let i = 0; i < emails.length; i += 200) {
        const { data } = await base().in("email", emails.slice(i, i + 200)).is("external_id", null);
        for (const r of data ?? []) if (r.email) out.emails.add(String(r.email).toLowerCase());
      }
      return out;
    },
    /*
     * Inserted in chunks, and `token` is left out of every row so the database
     * generates it. A partial failure leaves the rows that landed — which is
     * the right outcome for a list: the alternative is one bad address
     * discarding an upload of 4 000 people.
     */
    async insert(prepared, listName) {
      const CHUNK = 500;
      let inserted = 0;
      const rejected: string[] = [];
      for (let i = 0; i < prepared.length; i += CHUNK) {
        const slice = prepared.slice(i, i + CHUNK).map((p) => ({
          survey_id: params.id, is_test: isTest, list_name: listName,
          name: p.name, email: p.email, external_id: p.external_id, embedded: p.embedded, status: "invited",
        }));
        const { data, error } = await db.from("respondents").insert(slice).select("id");
        if (error) {
          if (/is_test|list_name|does not exist|schema cache/i.test(error.message)) return { error: "Respondent lists need migration 0013.", status: 503, migration: "0013" };
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
      return { inserted, rejected };
    },
  };

  const outcome = await runIntake(store, body, environment);
  if (outcome.committed) {
    const { inserted, rejected, listName } = outcome.committed;
    await audit({
      action: "deployment.started", userId: gate.user.userId, sessionId: gate.user.sessionId,
      surveyId: params.id, customerId: gate.user.customerId,
      entity: "respondent_list", entityId: listName,
      detail: {
        summary: `added ${inserted} ${environment} invitation${inserted === 1 ? "" : "s"}${listName ? ` to “${listName}”` : ""}`,
        environment, listName, inserted, rejected,
      },
    });
  }
  return NextResponse.json(outcome.body, { status: outcome.status });
}

/* ------------------------------------------------------------ mark sent */

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (peopleSandboxAllowed(params.id)) return sandboxPatch(req);
  const gate = await requireProject(req, params.id, "deploy.manage");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const environment = parseEnvironment(body?.environment);
  if (!environment || environment === "ALL") {
    return NextResponse.json({ error: "environment must be TEST or LIVE" }, { status: 400 });
  }
  /*
   * RENAME A LIST (2026-11-21): a list is a label on its people, so renaming is relabelling them. Refused when the
   * new name is already another list's — merging two lists is not something a rename should do by accident.
   */
  if (body?.action === "rename_list") {
    const from = typeof body?.list === "string" ? body.list : "";
    const to = String(body?.to ?? "").trim().slice(0, 120);
    if (!from || !to) return NextResponse.json({ error: "Give the list a name." }, { status: 400 });
    if (from === to) return NextResponse.json({ ok: true, affected: 0 });
    const isTest = environment === "TEST";
    const clash = await gate.db.from("respondents").select("id", { count: "exact", head: true }).eq("survey_id", params.id).eq("is_test", isTest).eq("list_name", to);
    if ((clash.count ?? 0) > 0) return NextResponse.json({ error: `There is already a list called “${to}”. Choose another name.` }, { status: 409 });
    const { data: moved, error: rErr } = await gate.db.from("respondents").update({ list_name: to }).eq("survey_id", params.id).eq("is_test", isTest).eq("list_name", from).select("id");
    if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
    await audit({ action: "deployment.started", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, entity: "respondent_list", entityId: to, detail: { summary: `renamed the ${environment} list “${from}” to “${to}” (${moved?.length ?? 0} people)`, environment } });
    return NextResponse.json({ ok: true, affected: moved?.length ?? 0 });
  }
  const action = body?.action === "mark_unsent" ? "mark_unsent" : "mark_sent";

  const db = gate.db;
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

  const db = gate.db;
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


/* ------------------------------------------------------------------ the /sandbox fixture's list, from memory */

function sandboxList(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const isTest = (parseEnvironment(sp.get("environment") ?? "LIVE") ?? "LIVE") === "TEST";
  const all = sandboxPeople().filter((p) => p.is_test === isTest);
  const list = sp.get("list"), search = sp.get("search")?.trim().toLowerCase();
  const rows = all.filter((p) => (!list || p.list_name === list) && (!search || `${p.email ?? ""} ${p.external_id ?? ""} ${p.name ?? ""}`.toLowerCase().includes(search))).sort((a, b) => b.invited_at.localeCompare(a.invited_at));
  const by = new Map<string, SandboxPerson[]>();
  for (const p of all) (by.get(p.list_name ?? "") ?? by.set(p.list_name ?? "", []).get(p.list_name ?? "")!).push(p);
  return NextResponse.json({
    available: true, environment: isTest ? "TEST" : "LIVE", total: rows.length, offset: 0, limit: 100,
    rows: rows.slice(0, 100).map((r) => ({ id: r.id, token: r.token, name: r.name, email: r.email, externalId: r.external_id, status: r.status, listName: r.list_name, sentAt: r.sent_at, invitedAt: r.invited_at, embeddedCount: Object.keys(r.embedded).length })),
    stats: [...by.entries()].map(([name, ps]) => ({ listName: name || null, total: ps.length, sent: ps.filter((p) => p.sent_at).length, notSent: ps.filter((p) => !p.sent_at).length, waiting: ps.filter((p) => p.sent_at && p.status === "invited").length, started: 0, completed: 0, screened: 0, quotaFull: 0, terminated: 0, firstInvited: ps[0]?.invited_at ?? null, lastInvited: ps.at(-1)?.invited_at ?? null })),
  }, { headers: { "cache-control": "no-store" } });
}

async function sandboxPatch(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const isTest = parseEnvironment(body?.environment) === "TEST";
  if (body?.action === "rename_list") {
    const to = String(body?.to ?? "").trim();
    if (!to) return NextResponse.json({ error: "Give the list a name." }, { status: 400 });
    if (sandboxPeople().some((p) => p.is_test === isTest && p.list_name === to)) return NextResponse.json({ error: `There is already a list called “${to}”. Choose another name.` }, { status: 409 });
    let n = 0;
    for (const p of sandboxPeople()) if (p.is_test === isTest && p.list_name === body.list) { p.list_name = to; n++; }
    return NextResponse.json({ ok: true, affected: n });
  }
  let n = 0;
  for (const p of sandboxPeople()) if (p.is_test === isTest && (Array.isArray(body?.ids) ? body.ids.includes(p.id) : p.list_name === body?.list)) { p.sent_at = body?.action === "mark_unsent" ? null : new Date().toISOString(); n++; }
  return NextResponse.json({ ok: true, affected: n });
}
