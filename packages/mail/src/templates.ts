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

/**
 * INTERVIEW SCHEDULING (Q6, 2026-11-29): the invitation to pick a time, and the reminder before it. Plain text first,
 * like every template here; the booking link is personal and says so.
 */
export function interviewInvitationEmail(args: { name?: string | null; senderName: string; studyTitle: string; url: string; minutes: number; incentive?: string | null; replyTo?: string | null }): Rendered {
  const who = args.name?.trim() ? `Hello ${args.name.trim().split(/\s+/)[0]},` : "Hello,";
  const text = [
    who, "",
    `${args.senderName} would like to talk with you about ${args.studyTitle}. The conversation takes about ${args.minutes} minutes.`, "",
    ...(args.incentive ? [`As a thank-you for taking part: ${args.incentive}.`, ""] : []),
    "Pick a time that suits you:", "", args.url, "",
    "This link is just for you. You can change or cancel your time from the same link.", "",
    args.replyTo ? `If you have a question, reply to this email and it will reach ${args.senderName}.` : "",
  ].filter((l) => l !== "").join("\n").replace(/\n(?=\S)/g, "\n\n");
  const html = shell(
    `<p style="margin:0 0 12px">${escapeHtml(who)}</p>` +
      `<p style="margin:0"><strong>${escapeHtml(args.senderName)}</strong> would like to talk with you about ${escapeHtml(args.studyTitle)}. The conversation takes about ${args.minutes} minutes.</p>` +
      (args.incentive ? `<p style="margin:12px 0 0">As a thank-you for taking part: ${escapeHtml(args.incentive)}.</p>` : "") +
      linkBlock(args.url, "Pick a time") +
      `<p style="margin:16px 0 0">This link is just for you. You can change or cancel your time from the same link.</p>`,
    args.replyTo ? `Questions? Reply to this email and it reaches ${escapeHtml(args.senderName)}.` : undefined,
  );
  return { subject: `Would you talk with ${args.senderName} about ${args.studyTitle}?`, text, html };
}

export function interviewReminderEmail(args: { name?: string | null; senderName: string; studyTitle: string; when: string; url?: string | null; hoursBefore: number }): Rendered {
  const who = args.name?.trim() ? `Hello ${args.name.trim().split(/\s+/)[0]},` : "Hello,";
  const soon = args.hoursBefore <= 1 ? "in about an hour" : args.hoursBefore <= 24 ? "in about a day" : `in ${Math.round(args.hoursBefore / 24)} days`;
  /* the booking link is personal and only its hash is stored, so a reminder sent by the job points back to the invitation */
  const change = args.url ? ["To change or cancel your time:", "", args.url] : ["To change or cancel your time, use the link in your invitation email."];
  const text = [who, "", `A reminder: your conversation with ${args.senderName} about ${args.studyTitle} is ${soon}, at ${args.when}.`, "", ...change].join("\n").replace(/\n(?=\S)/g, "\n\n");
  const html = shell(`<p style="margin:0 0 12px">${escapeHtml(who)}</p><p style="margin:0">A reminder: your conversation with <strong>${escapeHtml(args.senderName)}</strong> about ${escapeHtml(args.studyTitle)} is ${soon}, at ${escapeHtml(args.when)}.</p>` + (args.url ? linkBlock(args.url, "Change or cancel") : `<p style="margin:16px 0 0">To change or cancel your time, use the link in your invitation email.</p>`));
  return { subject: `Reminder: ${args.studyTitle}, ${args.when}`, text, html };
}

/**
 * SCHEDULED REPORTS AND METRIC ALERTS (R5 / R6, 2026-11-22). The email says what changed and links to the report —
 * the Studio file (sign-in needed) and, when the schedule names one, the share link. No file is attached and no
 * bearer link to a file is sent.
 */
export function reportDeliveryEmail(args: { reportName: string; studyTitle: string; headline: string; changes: string[]; fileUrl?: string | null; shareUrl?: string | null; format?: string | null }): Rendered {
  const lines = args.changes.slice(0, 8);
  const text = [
    `${args.reportName} — ${args.studyTitle}`, "",
    args.headline, "",
    ...(lines.length ? ["What changed:", ...lines.map((l) => `- ${l}`), ""] : []),
    ...(args.fileUrl ? [`The ${String(args.format ?? "report").toUpperCase()} (sign in to download):`, args.fileUrl, ""] : []),
    ...(args.shareUrl ? ["The shared report:", args.shareUrl, ""] : []),
    "You get this email because you are on this report's schedule. Ask the research team to change it.",
  ].join("\n");
  const html = shell(
    `<p style="margin:0 0 6px;font-size:13px;color:#6b7690">${escapeHtml(args.studyTitle)}</p>` +
      `<p style="margin:0 0 12px"><strong>${escapeHtml(args.reportName)}</strong></p>` +
      `<p style="margin:0 0 12px">${escapeHtml(args.headline)}</p>` +
      (lines.length ? `<ul style="margin:0 0 12px;padding-left:18px">${lines.map((l) => `<li style="margin:0 0 4px">${escapeHtml(l)}</li>`).join("")}</ul>` : "") +
      (args.fileUrl ? linkBlock(args.fileUrl, `Download the ${String(args.format ?? "report").toUpperCase()}`) : "") +
      (args.shareUrl ? linkBlock(args.shareUrl, "Open the shared report") : ""),
    "You get this email because you are on this report's schedule.",
  );
  return { subject: `${args.reportName}: ${args.headline.length > 90 ? `${args.headline.slice(0, 87)}…` : args.headline}`, text, html };
}

export function metricAlertEmail(args: { reportName: string; studyTitle: string; sentence: string; url?: string | null }): Rendered {
  const text = [`Alert on ${args.reportName} — ${args.studyTitle}`, "", args.sentence, "", ...(args.url ? ["Open the report:", args.url, ""] : []), "You are told once when the figure crosses the threshold, not again while it stays there."].join("\n");
  const html = shell(`<p style="margin:0 0 6px;font-size:13px;color:#6b7690">${escapeHtml(args.studyTitle)}</p><p style="margin:0 0 12px"><strong>Alert on ${escapeHtml(args.reportName)}</strong></p><p style="margin:0 0 12px">${escapeHtml(args.sentence)}</p>` + (args.url ? linkBlock(args.url, "Open the report") : ""), "You are told once when the figure crosses the threshold.");
  return { subject: `Alert: ${args.sentence.length > 100 ? `${args.sentence.slice(0, 97)}…` : args.sentence}`, text, html };
}
