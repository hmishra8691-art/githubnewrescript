import { NextRequest, NextResponse } from "next/server";
import { assertNotReadOnly, getMeter, projectContext, recordUsage } from "@/lib/metering";
import { supabaseAdmin } from "@/lib/admin";
import { parseEnvironment } from "@/lib/responseData";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { mailConfig, sendMany, summariseSend, type MailMessage } from "@/lib/mail";
import { respondentInvitationEmail } from "@rescript/mail";
import { surveyBaseUrl } from "@/lib/runtime-url";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * EMAILING THE RESPONDENT LIST (§24).
 *
 *   POST { environment, list?, ids?, onlyUnsent?, senderName?, minutes?, closesOn?, replyTo? }
 *
 * The Distribution panel could already mint a personal link per respondent
 * and hand them out as a spreadsheet. This sends them.
 *
 * FOUR THINGS PROTECT THE PEOPLE ON THE LIST, and they are the whole design:
 *
 * 1. NOBODY IS MAILED TWICE. Every message carries a `dedupeKey` of the
 *    respondent's id, checked against `mail_deliveries` before sending. A
 *    double-clicked button, a retried request, a re-run wave — each is one
 *    email. This is not tidiness: a respondent with two links has two
 *    interviews, and the data is then wrong in a way nobody notices.
 *
 * 2. `onlyUnsent` IS THE DEFAULT. "Send this wave" means "send it to the
 *    people who have not had it", because the second send is the one that
 *    goes wrong — chasing eleven stragglers by re-exporting a list of 400 is
 *    how the other 389 get invited again.
 *
 * 3. A NON-PRODUCTION INSTANCE CANNOT REACH THEM AT ALL. `sendMail` refuses
 *    outside production unless a redirect address is configured, and then
 *    every message goes there with a banner. A staging copy pointed at a
 *    production database holds real respondent addresses; this is the
 *    guarantee that matters more than the feature.
 *
 * 4. IT GOES FROM THE BULK ADDRESS. Survey invitations and password resets
 *    must not share a sending reputation: a wave that lands in spam folders
 *    should not take the platform's ability to send a password reset down
 *    with it.
 *
 * `sent_at` is stamped for whoever was actually mailed — the column that
 * used to be set by hand, meaning "I sent these myself", now also records
 * what the platform sent.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  /* the same capability that mints the links: sending them is shipping the study */
  const gate = await requireProject(req, params.id, "deploy.manage");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const environment = parseEnvironment(body?.environment);
  if (!environment || environment === "ALL") {
    return NextResponse.json({ error: "environment must be TEST or LIVE" }, { status: 400 });
  }
  const isTest = environment === "TEST";
  const cfg = mailConfig();

  if (!cfg.configured) {
    return NextResponse.json({
      error: "No mail is configured on this instance, so nothing was sent. Download the links and send them yourself, or set RESEND_API_KEY and MAIL_FROM.",
      code: "mail_not_configured",
    }, { status: 503 });
  }

  const db = supabaseAdmin();

  /* the link's base has to come from the DEPLOYMENT: a draft slug is a 404 sent to everybody */
  const { data: dep } = await db
    .from("deployments")
    .select("client_slug, study_slug")
    .eq("survey_id", params.id)
    .eq("mode", isTest ? "test" : "live")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!dep) {
    return NextResponse.json({
      error: `This survey has no active ${isTest ? "test" : "live"} deployment, so there is no link to send. Deploy it first, under Versions & Deploy.`,
    }, { status: 409 });
  }

  const { data: survey } = await db.from("surveys").select("title, code, client_name, current_version_id, fieldwork_to").eq("id", params.id).maybeSingle();

  let customDomain: string | undefined;
  if (survey?.current_version_id) {
    const { data: ver } = await db.from("survey_versions").select("definition").eq("id", survey.current_version_id).maybeSingle();
    const d = (ver?.definition as { deployment?: { customDomain?: string } } | null)?.deployment?.customDomain;
    if (typeof d === "string" && d.trim()) customDomain = d;
  }
  const base = `${surveyBaseUrl(customDomain)}/${isTest ? "t" : "s"}/${dep.client_slug}/${dep.study_slug}`;

  /* who to send to */
  let q = db
    .from("respondents")
    .select("id, token, name, email, list_name, status, sent_at")
    .eq("survey_id", params.id)
    .eq("is_test", isTest)
    .not("email", "is", null)
    .limit(5000);

  if (Array.isArray(body?.ids) && body.ids.length) q = q.in("id", body.ids.map(String).slice(0, 5000));
  else if (typeof body?.list === "string") q = q.eq("list_name", body.list);
  /* the default, and the safe one */
  if (body?.onlyUnsent !== false) q = q.is("sent_at", null);

  const { data: people, error } = await q;
  if (error) {
    if (/is_test|list_name|does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ error: "Respondent lists need migration 0013.", migration: "0013" }, { status: 503 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!people?.length) {
    return NextResponse.json({
      ok: true, summary: { total: 0, sent: 0, duplicate: 0, suppressed: 0, invalid: 0, failed: 0, notConfigured: 0 },
      note: body?.onlyUnsent === false
        ? "Nobody on that selection has an email address."
        : "Everybody on that selection has already been sent their link. Choose “send again” if you meant to re-send.",
    });
  }

  /*
   * Who the invitation appears to come from. A respondent has never heard of
   * this platform: the name they recognise is the client's, or the agency's.
   * The project's own `client_name` (§60) is the best available answer, and
   * an explicit `senderName` overrides it.
   */
  const senderName =
    (typeof body?.senderName === "string" && body.senderName.trim()) ||
    survey?.client_name ||
    "Research team";

  const messages: MailMessage[] = people.map((r) => {
    const mail = respondentInvitationEmail({
      name: r.name,
      senderName,
      surveyTitle: survey?.title ?? "a short survey",
      url: `${base}?token=${encodeURIComponent(r.token)}`,
      minutes: typeof body?.minutes === "number" && body.minutes > 0 ? Math.round(body.minutes) : null,
      closesOn: typeof body?.closesOn === "string" && body.closesOn ? body.closesOn : (survey?.fieldwork_to ?? null),
      replyTo: typeof body?.replyTo === "string" && body.replyTo ? body.replyTo : null,
    });
    return {
      to: r.email as string,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      kind: "respondent_invitation" as const,
      stream: "bulk" as const,
      surveyId: params.id,
      customerId: gate.user.customerId,
      userId: gate.user.userId,
      /*
       * The respondent's id, not their address: the same person re-uploaded
       * under a second row is a second invitation on purpose (two rows, two
       * tokens, two interviews), while one row must only ever be mailed once.
       */
      dedupeKey: `respondent_invitation:${r.id}`,
      replyTo: typeof body?.replyTo === "string" && body.replyTo ? body.replyTo : undefined,
    };
  });

  // METERING: a read-only project sends nothing; every message actually mailed is one EMAIL_MESSAGE
  const mctx = projectContext(gate);
  const blocked = await assertNotReadOnly(getMeter(), mctx, "other");
  if (blocked) return blocked;
  const results = await sendMany(messages, { perSecond: 2 });
  const summary = summariseSend(results);
  const sentCount = results.filter((r) => r.result.sent).length;
  if (sentCount) void recordUsage(getMeter(), mctx, { eventType: "EMAIL_MESSAGE", quantity: sentCount, metadata: { attempted: results.length } });

  /*
   * Stamp `sent_at` only for those actually mailed. A failure must stay
   * visible as "not sent" so the next run picks it up — marking a whole wave
   * sent because the request completed is how eleven people never hear from
   * the study at all.
   */
  const mailed = people.filter((_, i) => results[i].result.sent).map((r) => r.id);
  if (mailed.length) {
    await db.from("respondents").update({ sent_at: new Date().toISOString() }).in("id", mailed);
  }

  await audit({
    action: "deployment.completed", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "respondent_list", entityId: typeof body?.list === "string" ? body.list : null,
    detail: {
      summary: `emailed ${summary.sent} of ${summary.total} ${environment} invitation${summary.total === 1 ? "" : "s"}${typeof body?.list === "string" ? ` in “${body.list}”` : ""}`,
      environment, senderName, ...summary,
    },
  });

  const failures = results
    .map((r, i) => ({ email: people[i].email, r }))
    .filter((x) => !x.r.result.sent && x.r.result.reason === "provider_error")
    .slice(0, 10)
    .map((x) => ({ email: x.email, detail: "detail" in x.r.result ? x.r.result.detail : undefined }));

  return NextResponse.json({
    ok: true,
    summary,
    failures,
    ...(cfg.tier !== "production"
      ? {
          note: cfg.redirectTo
            ? `This is the ${cfg.tier} platform, so all ${summary.sent} went to ${cfg.redirectTo} instead of to the respondents, each labelled with who it was really for.`
            : `This is the ${cfg.tier} platform, so nothing was delivered — set MAIL_DEV_REDIRECT to see the emails, or send from production.`,
        }
      : {}),
    ...(summary.duplicate
      ? { alreadyHadTheirs: summary.duplicate }
      : {}),
  });
}
