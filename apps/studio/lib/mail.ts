import "server-only";
import {
  routeRecipient, redirectNotice, escapeHtml, summarise,
  type SendSummary,
} from "@rescript/mail";
import { supabaseService } from "./authServer";
import { platformTier } from "./platform";

/**
 * SENDING MAIL.
 *
 * One transport, one place to look when something did not arrive. Three
 * decisions shape this file, and each of them is about a way sending mail
 * goes wrong rather than about how it goes right.
 *
 * 1. NOT CONFIGURED IS A NORMAL STATE, NOT AN ERROR. Every caller here had a
 *    working fallback before mail existed: an invitation route that returns a
 *    link for a human to pass on, a spreadsheet of respondent links. So
 *    `sendMail` never throws for want of an API key — it returns
 *    `{ sent: false, reason: "not_configured" }` and the caller keeps doing
 *    what it did before. An instance with no mail must be a slightly less
 *    convenient platform, not a broken one.
 *
 * 2. A NON-PRODUCTION INSTANCE MUST NOT MAIL REAL PEOPLE. This is the
 *    guarantee worth more than the feature. A staging copy pointed at a
 *    production database holds real respondent addresses and real client
 *    contacts, and one careless "send this wave" from it reaches 4 000
 *    people who did not agree to hear from a test system. So outside
 *    production, mail is either REDIRECTED to one declared address or
 *    suppressed entirely — never delivered to its real recipient — and the
 *    redirect carries a banner saying who it was really for. Reaching real
 *    inboxes takes both `RESCRIPT_ENV=production` and a key.
 *
 * 3. NOTHING IS SENT TWICE. `dedupeKey` is checked against
 *    `mail_deliveries` before sending. A double-clicked button, a retried
 *    request, a re-run wave: each is one email. This matters most where it
 *    costs most — a respondent who gets two invitations has two links, and
 *    the second one is a second interview.
 *
 * Resend is called over plain HTTPS rather than through its SDK: it is one
 * POST, the shape is stable, and a dependency that wraps `fetch` is a
 * dependency to keep in step for nothing. Swapping provider means editing
 * `deliver()`.
 */

export type MailKind = "password_reset" | "project_invitation" | "respondent_invitation" | "test";

export interface MailMessage {
  to: string;
  subject: string;
  /** the plain-text body — always written, and always the one that matters */
  text: string;
  /** optional HTML. Text is never generated from it: see the templates. */
  html?: string;
  kind: MailKind;
  /** where a reply should go — a respondent replying to a survey invitation is a real person with a real question */
  replyTo?: string;
  /**
   * A bulk send (respondent invitations) goes from a different address and,
   * ideally, a different subdomain: its reputation must not be able to take
   * password resets down with it.
   */
  stream?: "transactional" | "bulk";
  dedupeKey?: string;
  /* for the delivery log */
  surveyId?: string | null;
  customerId?: string | null;
  userId?: string | null;
}

export type MailResult =
  | { sent: true; providerId: string | null; redirectedTo?: string }
  | { sent: false; reason: "not_configured" | "suppressed" | "duplicate" | "invalid_recipient" | "provider_error"; detail?: string };

export interface MailConfig {
  configured: boolean;
  from: string;
  fromBulk: string;
  replyTo: string | null;
  /** outside production, where mail is sent instead of to its real recipient */
  redirectTo: string | null;
  tier: "development" | "staging" | "production";
}

export function mailConfig(): MailConfig {
  const { tier } = platformTier();
  const from = (process.env.MAIL_FROM ?? "").trim();
  return {
    configured: !!process.env.RESEND_API_KEY && !!from,
    from,
    /* falls back to the transactional address: one stream is better than none */
    fromBulk: (process.env.MAIL_FROM_INVITATIONS ?? "").trim() || from,
    replyTo: (process.env.MAIL_REPLY_TO ?? "").trim() || null,
    redirectTo: (process.env.MAIL_DEV_REDIRECT ?? "").trim() || null,
    tier,
  };
}

/** One POST to Resend. The only provider-specific code in the file. */
async function deliver(args: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string | null;
}): Promise<{ ok: true; id: string | null } | { ok: false; detail: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: args.from,
        to: [args.to],
        subject: args.subject,
        text: args.text,
        ...(args.html ? { html: args.html } : {}),
        ...(args.replyTo ? { reply_to: args.replyTo } : {}),
      }),
      /* a hung provider must not hang the request that triggered it */
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok) {
      return { ok: false, detail: body.message ?? body.name ?? `provider returned ${res.status}` };
    }
    return { ok: true, id: body.id ?? null };
  } catch (e) {
    const err = e as Error;
    return { ok: false, detail: err.name === "TimeoutError" ? "the mail provider did not respond within 15s" : err.message };
  }
}

/** Record what happened. Never throws: a missing log row must not fail a send. */
async function log(m: MailMessage, status: "sent" | "failed" | "suppressed", extra: { providerId?: string | null; error?: string | null }) {
  try {
    await supabaseService().from("mail_deliveries").insert({
      customer_id: m.customerId ?? null,
      survey_id: m.surveyId ?? null,
      kind: m.kind,
      to_email: m.to.toLowerCase(),
      subject: m.subject.slice(0, 500),
      provider: "resend",
      provider_id: extra.providerId ?? null,
      status,
      error: extra.error?.slice(0, 1000) ?? null,
      dedupe_key: m.dedupeKey ?? null,
      created_by: m.userId ?? null,
    });
  } catch (e) {
    console.error("[rescript:mail] delivery not logged", { kind: m.kind, error: (e as Error).message });
  }
}

/** Has this exact message already gone? */
async function alreadySent(dedupeKey: string): Promise<boolean> {
  try {
    const { data } = await supabaseService()
      .from("mail_deliveries")
      .select("id")
      .eq("dedupe_key", dedupeKey)
      .eq("status", "sent")
      .maybeSingle();
    return !!data;
  } catch {
    /*
     * If the check itself fails we do NOT send. For a bulk invitation the
     * cost of sending twice (a respondent with two links, and two possible
     * interviews) is higher than the cost of not sending once, which a retry
     * fixes.
     */
    return true;
  }
}

export async function sendMail(m: MailMessage): Promise<MailResult> {
  const cfg = mailConfig();
  if (!cfg.configured) return { sent: false, reason: "not_configured" };

  if (m.dedupeKey && (await alreadySent(m.dedupeKey))) {
    return { sent: false, reason: "duplicate" };
  }

  const routed = routeRecipient(m.to, { tier: cfg.tier, redirectTo: cfg.redirectTo });
  if ("blocked" in routed) {
    await log(m, "suppressed", {
      error: routed.blocked === "suppressed"
        ? `not production (${cfg.tier}) and MAIL_DEV_REDIRECT is not set`
        : "not a valid email address",
    });
    return { sent: false, reason: routed.blocked };
  }

  const notice = routed.redirected ? redirectNotice(m.to, cfg.tier) : null;
  const from = m.stream === "bulk" ? cfg.fromBulk : cfg.from;

  const out = await deliver({
    from,
    to: routed.deliverTo,
    subject: notice ? `[${cfg.tier}] ${m.subject}` : m.subject,
    text: notice ? `${notice}\n\n${m.text}` : m.text,
    html: m.html ? (notice ? `<p style="background:#fef3c7;padding:10px;border-radius:6px;font:13px system-ui">${escapeHtml(notice)}</p>${m.html}` : m.html) : undefined,
    replyTo: m.replyTo ?? cfg.replyTo,
  });

  if (!out.ok) {
    await log(m, "failed", { error: out.detail });
    console.error("[rescript:mail] not sent", { kind: m.kind, detail: out.detail });
    return { sent: false, reason: "provider_error", detail: out.detail };
  }

  await log(m, "sent", { providerId: out.id });
  return { sent: true, providerId: out.id, ...(routed.redirected ? { redirectedTo: routed.deliverTo } : {}) };
}

/**
 * Send to many, without becoming a spam incident.
 *
 * Sequential with a small delay, not `Promise.all`: Resend's default limit is
 * 2 requests per second, and a wave of 400 fired at once would have most of
 * them rejected with a 429 — recorded as failures, and then retried by
 * somebody, producing duplicates for the ones that did get through. Slow and
 * complete beats fast and half-sent.
 *
 * Every result is returned, in order, so the caller can say exactly who was
 * emailed, who was skipped as already-sent, and who failed.
 */
export async function sendMany(
  messages: MailMessage[],
  opts: { perSecond?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ to: string; result: MailResult }[]> {
  const gap = Math.max(0, Math.round(1000 / (opts.perSecond ?? 2)));
  const out: { to: string; result: MailResult }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const result = await sendMail(messages[i]);
    out.push({ to: messages[i].to, result });
    opts.onProgress?.(i + 1, messages.length);
    if (i < messages.length - 1 && gap) await new Promise((r) => setTimeout(r, gap));
  }
  return out;
}

/** A one-line summary of a bulk send, for a response and for an audit line. */
export function summariseSend(results: { result: MailResult }[]): SendSummary {
  return summarise(results);
}
