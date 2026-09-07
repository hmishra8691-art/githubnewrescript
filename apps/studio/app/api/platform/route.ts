import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireUser } from "@/lib/guard";
import { platformInfo, platformTier } from "@/lib/platform";
import { mailConfig, sendMail } from "@/lib/mail";
import { testEmail } from "@rescript/mail";

export const dynamic = "force-dynamic";

/**
 * WHAT THIS INSTANCE IS, AND WHAT IT IS MISSING (§45).
 *
 *   GET /api/platform
 *
 * The per-project diagnostics (§27) answer "why can I not save this survey".
 * This answers the question one level up, which nobody could answer before:
 * which deployment of the platform is this, which database is it pointed at,
 * what is configured, and how far have the migrations got. Until now the only
 * way to find out was to read the environment variables of the host — which
 * means shell access, which means the people who most need the answer cannot
 * get it.
 *
 * WHO MAY SEE IT. The same rule the per-project diagnostics use, and for the
 * same reason: readable outside production, and in production only by a
 * platform admin. What comes back is safe to screenshot — a tier, a Supabase
 * project reference (the public part of a URL every respondent's browser
 * already sees), presence flags for configuration, and a migration level
 * inferred by asking the database what it has. No key, no token, no
 * connection string, no user data.
 *
 * THE MIGRATION LEVEL is probed rather than read from a table, because there
 * is no migrations table: each feature in this platform detects its own
 * missing migration and says so in its own panel. That is good behaviour and
 * a bad way to answer "is this database up to date", so the probes are
 * gathered here — one cheap head-count per feature — and reported as a level
 * with the first gap named. It is the difference between five support
 * conversations and one.
 */

/** One probe per migration that added something a panel depends on. */
const PROBES: { migration: string; what: string; table: string; column?: string }[] = [
  { migration: "0002", what: "dashboard statistics", table: "surveys" },
  { migration: "0005", what: "response quality", table: "responses", column: "quality" },
  { migration: "0006", what: "response management and per-environment quotas", table: "responses", column: "deleted_at" },
  { migration: "0007", what: "List Fill allocation", table: "listfill_counts" },
  { migration: "0008", what: "accounts, sessions and project sharing", table: "user_sessions" },
  { migration: "0011", what: "analytics", table: "analytics_reports" },
  { migration: "0012", what: "sample sources and version immutability", table: "sample_sources" },
  { migration: "0013", what: "respondent lists and distribution", table: "respondents", column: "list_name" },
  { migration: "0014", what: "report templates and viewer filters", table: "analytics_report_templates" },
  { migration: "0015", what: "project configuration", table: "surveys", column: "client_name" },
];

export async function GET(_req: NextRequest) {
  /*
   * `requireUser` rather than a bare cookie read: it is the platform's one
   * session resolver, and it applies the expiry, revocation and takeover
   * rules. A signed-out caller is not an error here — outside production this
   * endpoint is readable, which is what makes it usable while setting an
   * instance up, before there is an account to sign in with.
   *
   * It is the FIRST statement, before the tier is even read. That ordering is
   * enforced by `scripts/auth-guard-audit.mjs` and the reason is not this
   * route in particular: a handler that decides anything before authorizing
   * has already acted on an unauthenticated request, and the audit cannot
   * tell a harmless env-var read from a harmful one.
   */
  const resolved = await requireUser(_req);
  const user = isFailure(resolved) ? null : resolved;
  const isAdmin = !!user?.isPlatformAdmin;
  const { tier } = platformTier();

  /*
   * In production this is admin-only, and the refusal is a 404 rather than a
   * 403 — the same shape the diagnostics route uses. A signed-out stranger
   * learns nothing from it, including whether the endpoint exists.
   */
  if (tier === "production" && !isAdmin) {
    return NextResponse.json({ error: "Not available." }, { status: 404 });
  }

  const info = platformInfo();

  /* the migration level, probed. Each is one indexed head-count. */
  const applied: string[] = [];
  const missing: { migration: string; what: string }[] = [];
  /*
   * Not probed at all when there is no database to probe. Reporting "up to
   * date" because nothing came back would be the most misleading answer this
   * page could give — the warning above already says the database is not
   * configured, and this stays honestly unknown.
   */
  const probed = info.configured.database && info.configured.serviceKey;
  if (probed) {
    const db = supabaseAdmin();
    for (const probe of PROBES) {
      const { error } = await db
        .from(probe.table)
        .select(probe.column ?? "id", { count: "exact", head: true })
        .limit(1);
      if (error) missing.push({ migration: probe.migration, what: probe.what });
      else applied.push(probe.migration);
    }
  }

  return NextResponse.json({
    tier: info.tier,
    tierDeclared: info.declared,
    database: info.database,
    runtimeUrl: info.runtimeUrl,
    studioUrl: info.studioUrl,
    release: info.release,
    node: info.node,
    configured: info.configured,
    migrations: {
      applied,
      missing,
      /*
       * "Up to date as far as this build knows": the probe list is written by
       * hand alongside each migration, so a database ahead of the code reads
       * as complete — which is the right answer to "can this build work
       * against that database".
       */
      probed,
      level: !probed ? null : missing.length ? missing[0].migration : (PROBES[PROBES.length - 1]?.migration ?? null),
      complete: probed && missing.length === 0,
    },
    warnings: [
      ...info.warnings,
      ...(missing.length
        ? [`${missing.length} migration${missing.length === 1 ? "" : "s"} not applied — the first is ${missing[0].migration} (${missing[0].what}).`]
        : []),
    ],
    mail: (() => {
      const cfg = mailConfig();
      return {
        configured: cfg.configured,
        from: cfg.from || null,
        fromBulk: cfg.fromBulk || null,
        replyTo: cfg.replyTo,
        /* outside production, where mail actually goes instead of to its recipient */
        redirectTo: cfg.redirectTo,
        /* whether a real recipient can be reached from here at all */
        canReachRealRecipients: cfg.configured && cfg.tier === "production",
      };
    })(),
    viewer: { isPlatformAdmin: isAdmin, signedIn: !!user, email: user?.email ?? null },
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * SEND YOURSELF A TEST EMAIL.
 *
 *   POST /api/platform  { action: "test_mail" }
 *
 * The one thing nobody can check by reading configuration: whether a message
 * actually leaves. It goes to the SIGNED-IN CALLER'S OWN ADDRESS and nowhere
 * else — not to an address in the request body, which would turn a
 * configuration page into an open relay for sending mail from a verified
 * domain. Signing in is therefore required even on a development instance,
 * where the rest of this route is readable.
 *
 * What the test proves and what it does not is spelled out in the email
 * itself: a key and an address that work are not a verified sending domain,
 * and mail that reaches your own inbox can still land every respondent in a
 * spam folder. That is a DNS problem, and it is the most common one.
 */
export async function POST(req: NextRequest) {
  const resolved = await requireUser(req);
  if (isFailure(resolved)) return resolved.response;
  const user = resolved;
  const { tier } = platformTier();

  if (tier === "production" && !user.isPlatformAdmin) {
    return NextResponse.json({ error: "Not available." }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "test_mail") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  if (!user.email) {
    return NextResponse.json({ error: "Your account has no email address to send a test to." }, { status: 400 });
  }

  const cfg = mailConfig();
  if (!cfg.configured) {
    return NextResponse.json({
      error: "No mail is configured. Set RESEND_API_KEY and MAIL_FROM, then redeploy.",
      code: "mail_not_configured",
    }, { status: 503 });
  }

  const info = platformInfo();
  const mail = testEmail({
    tier: info.tier,
    database: info.database,
    from: cfg.from,
    requestedBy: user.email,
  });

  const out = await sendMail({
    to: user.email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    kind: "test",
    customerId: user.customerId,
    userId: user.userId,
    /* no dedupeKey: pressing it twice should send twice — that is the point of a test */
  });

  if (out.sent) {
    return NextResponse.json({
      ok: true,
      message: out.redirectedTo
        ? `Sent — but this is the ${info.tier} platform, so it went to ${out.redirectedTo}.`
        : `Sent to ${user.email}. If it does not arrive within a minute or two, check your spam folder, then your sending domain's DNS.`,
      providerId: out.providerId,
    });
  }

  return NextResponse.json({
    error:
      out.reason === "suppressed"
        ? `This is the ${info.tier} platform and MAIL_DEV_REDIRECT is not set, so mail is suppressed rather than delivered. Set it to your own address to test.`
        : out.reason === "invalid_recipient"
          ? "Your account's email address does not look valid."
          : `The provider refused it: ${"detail" in out ? out.detail : "no detail given"}`,
    reason: out.reason,
  }, { status: 502 });
}
