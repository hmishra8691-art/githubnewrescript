/**
 * WHO A MESSAGE MAY ACTUALLY REACH, AND WHAT A SEND ADDS UP TO.
 *
 * The decisions in this file are the ones worth more than the mail feature
 * itself, which is why they live in a package with tests rather than inside
 * a route: every one of them is about a way sending mail goes wrong.
 *
 * Pure — no environment, no network, no database. The configuration is passed
 * in, so the rule can be tested rather than reasoned about.
 */

export type MailTier = "development" | "staging" | "production";

/*
 * Deliberately not the "correct" RFC 5322 address grammar, which permits
 * quoted local parts and comments and is a well-known way to write a regular
 * expression nobody can read. This is the shape of an address a person types,
 * and the provider is the real validator: the point here is to catch the
 * empty string, the missing @ and the trailing comma from a pasted list
 * before they become 400 failed sends.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(value: string | null | undefined): boolean {
  return !!value && EMAIL_RE.test(value.trim());
}

export interface MailRouting {
  tier: MailTier;
  /** outside production, the one address everything is sent to instead */
  redirectTo: string | null;
}

export type Routed =
  | { deliverTo: string; redirected: boolean }
  | { blocked: "suppressed" | "invalid_recipient" };

/**
 * Where this message may go.
 *
 * THE RULE THAT MATTERS: outside production, a message never reaches its real
 * recipient. It goes to `redirectTo` if one is configured, and otherwise
 * nowhere at all.
 *
 * "Nowhere at all" is the safe default, not an oversight. A staging copy of
 * this platform pointed at a production database holds real respondent
 * addresses and real client contacts; one careless "send this wave" from it
 * reaches thousands of people who never agreed to hear from a test system.
 * An unconfigured staging instance that suppresses mail is an inconvenience.
 * An unconfigured staging instance that sends it is an incident, and an
 * apology to somebody else's customers.
 *
 * Reaching a real inbox therefore takes two independent things: a production
 * tier AND a configured provider. Neither alone is enough.
 */
export function routeRecipient(to: string, cfg: MailRouting): Routed {
  const address = (to ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(address)) return { blocked: "invalid_recipient" };
  if (cfg.tier === "production") return { deliverTo: address, redirected: false };
  const redirect = (cfg.redirectTo ?? "").trim().toLowerCase();
  if (redirect && EMAIL_RE.test(redirect)) return { deliverTo: redirect, redirected: true };
  return { blocked: "suppressed" };
}

/**
 * The banner a redirected message carries.
 *
 * It says who it was really for, because the alternative is a developer's
 * inbox filling with survey invitations addressed to nobody they recognise —
 * and, worse, somebody forwarding one on in good faith. It also says that
 * nobody else received it, which is the reassurance a person actually wants.
 */
export function redirectNotice(realRecipient: string, tier: string): string {
  return (
    `[${tier.toUpperCase()} — this email was addressed to ${realRecipient} and was redirected to you ` +
    `because this is not the production platform. Nobody else received it.]`
  );
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------ a bulk send */

export type SendReason =
  | "not_configured" | "suppressed" | "duplicate" | "invalid_recipient" | "provider_error";

export type SentOutcome = { sent: true } | { sent: false; reason: SendReason };

export interface SendSummary {
  total: number;
  sent: number;
  duplicate: number;
  suppressed: number;
  invalid: number;
  failed: number;
  notConfigured: number;
}

/**
 * What a bulk send adds up to.
 *
 * Every outcome is counted separately because they mean different things to
 * the person who pressed the button, and lumping them into "sent / not sent"
 * is how a wave gets re-sent. In particular: `duplicate` is a SUCCESS (they
 * already have their link) while `failed` is the only category that should
 * be tried again.
 */
export function summarise(results: { result: SentOutcome }[]): SendSummary {
  const count = (reason: SendReason) =>
    results.filter((r) => !r.result.sent && r.result.reason === reason).length;
  return {
    total: results.length,
    sent: results.filter((r) => r.result.sent).length,
    duplicate: count("duplicate"),
    suppressed: count("suppressed"),
    invalid: count("invalid_recipient"),
    failed: count("provider_error"),
    notConfigured: count("not_configured"),
  };
}

/**
 * A sentence a person can act on.
 *
 * `failed` is the only number that asks anything of them, so it is the only
 * one that comes with an instruction — and the instruction is the reassuring
 * true thing: those people are still marked unsent, so sending again picks
 * exactly them up and nobody else.
 */
export function describeSend(s: SendSummary): string {
  if (!s.total) return "There was nobody to send to.";
  const parts = [`Emailed ${s.sent} of ${s.total}.`];
  if (s.duplicate) parts.push(`${s.duplicate} already had theirs.`);
  if (s.invalid) parts.push(`${s.invalid} had an address that is not valid.`);
  if (s.suppressed) parts.push(`${s.suppressed} were not delivered because this is not the production platform.`);
  if (s.notConfigured) parts.push("No mail is configured on this instance.");
  if (s.failed) parts.push(`${s.failed} failed — they stay marked unsent, so sending again will pick them up.`);
  return parts.join(" ");
}

/**
 * How long a wave will take, so a button can say so before it is pressed.
 *
 * Sending is deliberately sequential and rate-limited (a provider's default
 * is a couple of requests a second, and a wave fired all at once is mostly
 * 429s recorded as failures). 400 people is therefore three and a half
 * minutes, and a person who is not told that will conclude it has hung and
 * press it again.
 */
export function estimateSeconds(recipients: number, perSecond = 2): number {
  if (recipients <= 1) return recipients;
  return Math.ceil((recipients - 1) / Math.max(1, perSecond));
}
