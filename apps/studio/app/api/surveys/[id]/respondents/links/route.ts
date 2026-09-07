import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { parseEnvironment } from "@/lib/responseData";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { invitationsToCSV, invitationsToXlsx, type Invitation } from "@rescript/exporters";
import { surveyBaseUrl } from "@/lib/runtime-url";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * THE LINKS, AS A FILE (§24).
 *
 *   GET ?environment=LIVE&format=xlsx|csv&list=wave%201&onlyUnsent=1
 *
 * The point of a respondent list is the moment each person's link leaves the
 * platform, and in a research team that moment is a spreadsheet: mail-merged
 * from, handed to the client to send, or imported into whatever mailing tool
 * they already pay for. This platform has no mail transport, so this file IS
 * the distribution mechanism rather than a convenience beside it.
 *
 * `onlyUnsent` exists because the second send is the hard one. Re-exporting
 * a whole list to chase the eleven people who have not started is how the
 * other 4 000 get a second invitation, and a survey that mails somebody
 * twice is a survey the client complains about.
 *
 * `responses.export` gates it: this is the same act as downloading a dataset,
 * and the file is more sensitive — every row is a working credential.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.export");
  if (isFailure(gate)) return gate.response;

  const sp = req.nextUrl.searchParams;
  const environment = parseEnvironment(sp.get("environment") ?? "LIVE");
  if (!environment || environment === "ALL") {
    return NextResponse.json({ error: "environment must be TEST or LIVE" }, { status: 400 });
  }
  const isTest = environment === "TEST";
  const format = sp.get("format") === "csv" ? "csv" : "xlsx";

  const db = supabaseAdmin();
  const { data: survey } = await db
    .from("surveys").select("title, code").eq("id", params.id).maybeSingle();

  /*
   * The slugs come from the DEPLOYMENT, not the draft definition. A draft can
   * say anything — a programmer may be mid-rename — and a link built from an
   * unpublished slug is a 404 handed to 4 000 people. If there is no matching
   * deployment there is no link to give out, and saying so is the only honest
   * answer.
   */
  const { data: dep } = await db
    .from("deployments")
    .select("client_slug, study_slug, mode, active")
    .eq("survey_id", params.id)
    .eq("mode", isTest ? "test" : "live")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!dep) {
    return NextResponse.json({
      error: `This survey has no active ${isTest ? "test" : "live"} deployment, so there is no link to put in the file. Deploy it first, under Versions & Deploy.`,
    }, { status: 409 });
  }

  /*
   * `customDomain` lives in the definition rather than on the deployment row,
   * so it is read from the current version — the same source the Versions
   * panel uses to show the link.
   */
  let customDomain: string | undefined;
  const { data: cur } = await db.from("surveys").select("current_version_id").eq("id", params.id).maybeSingle();
  if (cur?.current_version_id) {
    const { data: ver } = await db.from("survey_versions").select("definition").eq("id", cur.current_version_id).maybeSingle();
    const d = (ver?.definition as { deployment?: { customDomain?: string } } | null)?.deployment?.customDomain;
    if (typeof d === "string" && d.trim()) customDomain = d;
  }
  const base = `${surveyBaseUrl(customDomain)}/${isTest ? "t" : "s"}/${dep.client_slug}/${dep.study_slug}`;

  let q = db
    .from("respondents")
    .select("token, name, email, external_id, status, list_name, sent_at, invited_at")
    .eq("survey_id", params.id)
    .eq("is_test", isTest)
    .order("invited_at", { ascending: true })
    .limit(50_000);

  const list = sp.get("list");
  if (list) q = q.eq("list_name", list);
  if (sp.get("onlyUnsent") === "1") q = q.is("sent_at", null);
  if (sp.get("onlyWaiting") === "1") q = q.eq("status", "invited");

  const { data, error } = await q;
  if (error) {
    if (/is_test|list_name|does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ error: "Respondent lists need migration 0013.", migration: "0013" }, { status: 503 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data?.length) {
    return NextResponse.json({ error: "no invitations match that selection" }, { status: 404 });
  }

  const rows: Invitation[] = data.map((r) => ({
    /*
     * The token goes in as `?token=`, which is the parameter the runtime
     * reads (`s/[client]/[study]/page.tsx`). Encoded, even though the
     * database only ever generates hex: a link built by string concatenation
     * that assumes its input is safe is a link that breaks the day the
     * assumption stops holding.
     */
    url: `${base}?token=${encodeURIComponent(r.token)}`,
    token: r.token,
    name: r.name,
    email: r.email,
    externalId: r.external_id,
    listName: r.list_name,
    status: r.status,
    sentAt: r.sent_at,
    invitedAt: r.invited_at,
  }));

  const stem = `${survey?.code ?? "survey"}_${environment.toLowerCase()}${list ? `_${list.replace(/[^A-Za-z0-9_-]+/g, "-")}` : ""}_invitations`;

  await audit({
    action: "responses.exported", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "respondent_list", entityId: list,
    detail: {
      summary: `downloaded ${rows.length} ${environment} invitation link${rows.length === 1 ? "" : "s"} as ${format.toUpperCase()}`,
      format, environment, listName: list, count: rows.length,
    },
  });

  if (format === "csv") {
    return new NextResponse(invitationsToCSV(rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${stem}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  const buf = await invitationsToXlsx(rows, {
    surveyTitle: survey?.title ?? undefined,
    environment,
  });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${stem}.xlsx"`,
      "cache-control": "no-store",
    },
  });
}
