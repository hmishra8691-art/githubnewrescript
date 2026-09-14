import { escapeHtml } from "./rules.js";

/**
 * THE EMAILS THIS PLATFORM SENDS.
 *
 * Four of them, and the rules are the same for all four.
 *
 * THE TEXT VERSION IS WRITTEN, NOT DERIVED. Every template returns `text`
 * composed by hand, and `html` separately. Stripping tags out of HTML
 * produces a plain-text part that reads like a broken web page, and the
 * plain-text part is what a spam filter weighs, what a screen reader gets,
 * and what somebody sees when the images are off. It is the version that
 * matters; the HTML is the decoration.
 *
 * THE LINK IS ALSO WRITTEN OUT IN FULL. A respondent invitation whose only
 * link is behind the words "start the survey" is indistinguishable from
 * phishing, and half of corporate mail clients rewrite or strip the anchor
 * anyway. So the URL appears as text, always, and the recipient can see
 * where it goes before they click.
 *
 * NO IMAGES, NO TRACKING PIXEL, NO WEB FONTS. A survey invitation that
 * silently reports whether it was opened is a thing you have to disclose,
 * and a plain email is a deliverable email.
 *
 * NOTHING SENSITIVE IN THE SUBJECT. Subject lines appear on lock screens.
 */

const SIG = "Rescript";

/** A minimal, table-free HTML shell. Inline styles only: every client strips <style>. */
function shell(bodyHtml: string, footer?: string): string {
  return [
    `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#131a2b;max-width:560px">`,
    bodyHtml,
    footer
      ? `<hr style="border:0;border-top:1px solid #e6e8ef;margin:24px 0 12px"><p style="font-size:12.5px;color:#6b7690;margin:0">${footer}</p>`
      : "",
    `</div>`,
  ].join("");
}

/** A URL as its own visible, copyable line. */
function linkBlock(url: string, label: string): string {
  return (
    `<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;display:inline-block;font-weight:600">${escapeHtml(label)}</a></p>` +
    `<p style="margin:0 0 4px;font-size:12.5px;color:#6b7690">Or copy this link into your browser:</p>` +
    `<p style="margin:0;font-size:12.5px;word-break:break-all"><a href="${escapeHtml(url)}" style="color:#4f46e5">${escapeHtml(url)}</a></p>`
  );
}

export interface Rendered { subject: string; text: string; html: string }

/* -------------------------------------------------------- password reset */

export function passwordResetEmail(args: {
  name?: string | null;
  url: string;
  expiresInMinutes: number;
  requestedFrom?: string | null;
}): Rendered {
  const who = args.name?.trim() ? `Hello ${args.name.trim()},` : "Hello,";
  const mins = args.expiresInMinutes;

  const text = [
    who,
    "",
    "Someone asked to reset the password on your Rescript account. If that was you, open this link and choose a new one:",
    "",
    args.url,
    "",
    `The link works once and expires in ${mins} minutes.`,
    "",
    /*
     * The reassurance matters more than the instruction. Most people who
     * receive an unexpected reset email are worried they have been hacked,
     * and the true and calming fact is that nothing has changed yet.
     */
    "If it was not you, you can ignore this email — nothing has changed, and your current password still works. Somebody may simply have mistyped their own email address.",
    "",
    SIG,
  ].join("\n");

  const html = shell(
    `<p style="margin:0 0 12px">${escapeHtml(who)}</p>` +
      `<p style="margin:0">Someone asked to reset the password on your Rescript account. If that was you, choose a new one:</p>` +
      linkBlock(args.url, "Choose a new password") +
      `<p style="margin:20px 0 0">The link works once and expires in ${mins} minutes.</p>` +
      `<p style="margin:12px 0 0">If it was not you, you can ignore this email — nothing has changed, and your current password still works.</p>`,
    args.requestedFrom ? `Requested from ${escapeHtml(args.requestedFrom)}.` : undefined,
  );

  /* deliberately says nothing about which account: subjects show on lock screens */
  return { subject: "Reset your Rescript password", text, html };
}

/* ---------------------------------------------------- project invitation */

export function projectInvitationEmail(args: {
  inviterName: string;
  projectTitle: string;
  projectCode: string;
  roleLabel: string;
  url: string;
  expiresAt?: string | null;
  hasAccount: boolean;
}): Rendered {
  const expiry = args.expiresAt
    ? `The invitation expires on ${new Date(args.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.`
    : null;

  const text = [
    "Hello,",
    "",
    `${args.inviterName} has invited you to work on “${args.projectTitle}” (${args.projectCode}) in Rescript, as ${args.roleLabel}.`,
    "",
    args.hasAccount ? "Open it here:" : "Create your account here, and you will have access as soon as you do:",
    "",
    args.url,
    "",
    ...(expiry ? [expiry, ""] : []),
    `${args.roleLabel} is what you can do on this one project — it does not change anything else you have access to.`,
    "",
    SIG,
  ].join("\n");

  const html = shell(
    `<p style="margin:0 0 12px">Hello,</p>` +
      `<p style="margin:0"><strong>${escapeHtml(args.inviterName)}</strong> has invited you to work on ` +
      `<strong>${escapeHtml(args.projectTitle)}</strong> <span style="color:#6b7690">(${escapeHtml(args.projectCode)})</span> ` +
      `in Rescript, as <strong>${escapeHtml(args.roleLabel)}</strong>.</p>` +
      linkBlock(args.url, args.hasAccount ? "Open the project" : "Create your account") +
      (expiry ? `<p style="margin:20px 0 0">${escapeHtml(expiry)}</p>` : ""),
    `${escapeHtml(args.roleLabel)} applies to this project only.`,
  );

  return { subject: `${args.inviterName} invited you to “${args.projectTitle}”`, text, html };
}

/* -------------------------------------------------- respondent invitation */

export function respondentInvitationEmail(args: {
  name?: string | null;
  /** who the survey is FOR — a respondent has never heard of your platform */
  senderName: string;
  surveyTitle: string;
  url: string;
  minutes?: number | null;
  closesOn?: string | null;
  replyTo?: string | null;
}): Rendered {
  const who = args.name?.trim() ? `Hello ${args.name.trim().split(/\s+/)[0]},` : "Hello,";
  const howLong = args.minutes ? `It takes about ${args.minutes} minutes.` : null;
  const closes = args.closesOn
    ? `Please answer by ${new Date(args.closesOn).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}.`
    : null;

  const text = [
    who,
    "",
    `${args.senderName} would like your views: ${args.surveyTitle}.`,
    "",
    ...(howLong ? [howLong, ""] : []),
    "Your survey link:",
    "",
    args.url,
    "",
    ...(closes ? [closes, ""] : []),
    /*
     * Two things a respondent has to be told, and neither is optional. The
     * link is personal, so forwarding it gives their interview away — people
     * forward survey links to colleagues constantly, in good faith. And it
     * only works once, so they should not be surprised later.
     */
    "This link is just for you. Please do not forward it — anyone who opens it would be answering as you, and it only works once.",
    "",
    args.replyTo ? `If you have a question about the survey, reply to this email and it will reach ${args.senderName}.` : "",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n(?=\S)/g, "\n\n");

  const html = shell(
    `<p style="margin:0 0 12px">${escapeHtml(who)}</p>` +
      `<p style="margin:0"><strong>${escapeHtml(args.senderName)}</strong> would like your views: ${escapeHtml(args.surveyTitle)}.</p>` +
      (howLong ? `<p style="margin:12px 0 0">${escapeHtml(howLong)}</p>` : "") +
      linkBlock(args.url, "Start the survey") +
      (closes ? `<p style="margin:20px 0 0">${escapeHtml(closes)}</p>` : "") +
      `<p style="margin:16px 0 0">This link is just for you — please do not forward it. Anyone who opens it would be answering as you, and it only works once.</p>`,
    args.replyTo ? `Questions? Reply to this email and it reaches ${escapeHtml(args.senderName)}.` : undefined,
  );

  /* the sender's name first: a respondent recognises the client, never us */
  return { subject: `${args.senderName}: ${args.surveyTitle}`, text, html };
}

/* --------------------------------------------------------------- the test */

export function testEmail(args: {
  tier: string;
  database: string | null;
  from: string;
  requestedBy: string;
}): Rendered {
  const lines = [
    "This is a test from your Rescript platform. If you are reading it, mail works.",
    "",
    `Instance:  ${args.tier}`,
    `Database:  ${args.database ?? "not configured"}`,
    `Sent from: ${args.from}`,
    `Requested: ${args.requestedBy}`,
    "",
    /*
     * The one thing a successful test does NOT prove, said plainly — because
     * a test that lands in your own inbox and then a real invitation that
     * lands in 400 spam folders is the single most common way this goes
     * wrong, and it is a DNS problem, not a code problem.
     */
    "One caveat: this proves the key and the address work. It does not prove your DNS is right.",
    "Until SPF and DKIM are verified for your sending domain, mail to anyone outside your own",
    "organisation is likely to be filtered as spam. Check the domain's status with your provider.",
    "",
    SIG,
  ];
  return {
    subject: `Rescript mail test — ${args.tier}`,
    text: lines.join("\n"),
    html: shell(
      `<p style="margin:0">This is a test from your Rescript platform. If you are reading it, <strong>mail works</strong>.</p>` +
        `<p style="margin:16px 0 0;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#131a2b">` +
        `Instance: ${escapeHtml(args.tier)}<br>Database: ${escapeHtml(args.database ?? "not configured")}<br>` +
        `Sent from: ${escapeHtml(args.from)}<br>Requested: ${escapeHtml(args.requestedBy)}</p>` +
        `<p style="margin:16px 0 0">This proves the key and the address work. It does <strong>not</strong> prove your DNS is right — until SPF and DKIM are verified for your sending domain, mail to anyone outside your own organisation is likely to be filtered as spam.</p>`,
    ),
  };
}

/* ------------------------------------------------ qualitative media delivery */

/**
 * The recordings from one respondent's sitting.
 *
 * This email is the only notice the researcher gets that a 48-hour clock is
 * running, so the deadline is stated three times and in three registers: the
 * hour it expires, the wording "automatically deleted", and the reason. A
 * retention policy nobody was told about is indistinguishable from data loss.
 *
 * What is deliberately NOT in it: the transcript, the respondent's answers,
 * any free text they gave. Those live in the Studio behind an account, and a
 * mailbox is not the place to duplicate them — this is a notification with a
 * link, not a copy of the research.
 *
 * The subject leads with the project, because a researcher running three
 * studies sorts their inbox by which one this is.
 */
export function mediaDeliveryEmail(args: {
  projectName: string;
  surveyName?: string | null;
  respondentLabel: string;
  fileCount: number;
  respondedAt: string;
  expiresAt: string;
  hoursRemaining: number;
  url: string;
  totalBytes?: number | null;
  questions?: string[];
}): Rendered {
  const files = args.fileCount === 1 ? "1 media file" : `${args.fileCount} media files`;
  const size = args.totalBytes ? ` (${mb(args.totalBytes)})` : "";
  const expiry = when(args.expiresAt);
  const responded = when(args.respondedAt);
  const survey = args.surveyName && args.surveyName !== args.projectName ? args.surveyName : null;
  const asked = (args.questions ?? []).filter(Boolean).slice(0, 8);

  const facts: [string, string][] = [
    ["Project", args.projectName],
    ...(survey ? ([["Survey", survey]] as [string, string][]) : []),
    ["Respondent", args.respondentLabel],
    ["Media files", `${files}${size}`],
    ["Responded", responded],
  ];

  const text = [
    "A new qualitative research response containing audio/video media is available for your project.",
    "",
    ...facts.map(([k, v]) => `${k}: ${v}`),
    ...(asked.length ? ["", `Questions: ${asked.join(", ")}`] : []),
    "",
    "The original media files are available through the secure download link below.",
    "",
    args.url,
    "",
    `Important: these files are automatically deleted ${args.hoursRemaining} hours from now, on ${expiry}. Please download them before then.`,
    "",
    "The transcript and the rest of the response stay in Rescript Studio — only the original recordings expire.",
    "",
    SIG,
  ].join("\n");

  const rows = facts
    .map(([k, v]) =>
      `<p style="margin:0 0 4px"><span style="color:#6b7690">${escapeHtml(k)}:</span> ${escapeHtml(v)}</p>`)
    .join("");

  const html = shell(
    `<p style="margin:0 0 16px">A new qualitative research response containing audio/video media is available for your project.</p>` +
      rows +
      (asked.length
        ? `<p style="margin:12px 0 0"><span style="color:#6b7690">Questions:</span> ${escapeHtml(asked.join(", "))}</p>`
        : "") +
      linkBlock(args.url, `Download ${files}`) +
      /*
       * Amber, and above the fold. Every other warning in these templates is
       * grey small print, and this one is not small print: it is the entire
       * difference between a delivery and a loss.
       */
      `<p style="margin:22px 0 0;padding:12px 14px;background:#fff7ed;border-left:3px solid #ea580c;border-radius:4px">` +
      `<strong>These files are deleted automatically ${args.hoursRemaining} hours from now</strong>, on ${escapeHtml(expiry)}. ` +
      `Please download them before then.</p>` +
      `<p style="margin:16px 0 0">The transcript and the rest of the response stay in Rescript Studio — only the original recordings expire.</p>`,
    "You are receiving this because your project is configured to deliver qualitative media to this address.",
  );

  return { subject: `Qualitative research media available — ${args.projectName}`, text, html };
}

function mb(bytes: number): string {
  const m = bytes / (1024 * 1024);
  return m >= 10 ? `${Math.round(m)} MB` : `${m.toFixed(1)} MB`;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }) + " UTC";
}
