import { nextDue, portalPresentation, portalSettings } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";

/**
 * WHAT A RESPONDENT IS TOLD, AND WHEN — THE DECISIONS (phase 6, 2026-11-20). Pure.
 *
 * A notice says THAT something happened and names the assessment. It never carries an answer, a score, or the text
 * of a message: it may be read on a lock screen or in a shared inbox. The same sentence is the portal notification
 * and the subject of the email.
 *
 *   due        a repeated assessment has reached its next due date           (once per due date)
 *   closing    an assessment not yet completed closes within two days        (once per closing time)
 *   request_answered / message   written where those happen (the Studio's answer and reply)
 */
export interface NoticePlan { accountId: string; kind: "due" | "closing" | "request_answered" | "message"; title: string; body: string | null; surveyId: string; enrolmentId: string; dedupe: string }

export interface EnrolmentFacts { id: string; accountId: string; accessFrom: string | null; accessUntil: string | null; suspended: boolean; lastCompletedAt: string | null; completions: number; maxAttempts: number | null }

export const CLOSING_HOURS = 48;
const day = (iso: string) => iso.slice(0, 10);

/** the reminders one survey's enrolments are owed now. A survey whose portal is off, or that is not live, owes none. */
export function planReminders(surveyId: string, title: string, live: SurveyDefinition | null, enrolments: EnrolmentFacts[], now: number): NoticePlan[] {
  const portal = live ? portalSettings(live) : null;
  if (!live || !portal) return [];
  const w = portalPresentation(portal).words;
  const out: NoticePlan[] = [];
  for (const e of enrolments) {
    if (e.suspended) continue;
    if (e.accessFrom && Date.parse(e.accessFrom) > now) continue;
    const closed = !!e.accessUntil && Date.parse(e.accessUntil) <= now;
    if (closed) continue;
    const limit = e.maxAttempts ?? portal.maxAttempts ?? null;
    const usedUp = limit !== null && e.completions >= limit;
    const due = nextDue(live, e.lastCompletedAt, now);
    if (due?.overdue && !usedUp) out.push({ accountId: e.accountId, kind: "due", title: `Your next ${w.one} is due: ${title}`, body: null, surveyId, enrolmentId: e.id, dedupe: `due:${e.id}:${day(due.at)}` });
    if (e.accessUntil && e.completions === 0) {
      const left = Date.parse(e.accessUntil) - now;
      if (left > 0 && left <= CLOSING_HOURS * 3_600_000) out.push({ accountId: e.accountId, kind: "closing", title: `Closing soon: ${title}`, body: `This ${w.one} closes on ${new Date(e.accessUntil).toUTCString().replace(":00 GMT", " UTC")}.`, surveyId, enrolmentId: e.id, dedupe: `closing:${e.id}:${e.accessUntil}` });
    }
  }
  return out;
}

export const requestAnsweredNotice = (r: { accountId: string; surveyId: string; enrolmentId: string; requestId: string }, title: string): NoticePlan =>
  ({ accountId: r.accountId, kind: "request_answered", title: `Your request has been answered: ${title}`, body: "Open Profile and security to read the answer.", surveyId: r.surveyId, enrolmentId: r.enrolmentId, dedupe: `request:${r.requestId}` });

export const messageNotice = (r: { accountId: string; surveyId: string; enrolmentId: string; messageId: string }, title: string): NoticePlan =>
  ({ accountId: r.accountId, kind: "message", title: `You have a new message: ${title}`, body: null, surveyId: r.surveyId, enrolmentId: r.enrolmentId, dedupe: `message:${r.messageId}` });

/** the email of a notice: the same sentence and a link to sign in — nothing else */
export function noticeMail(n: Pick<NoticePlan, "title" | "body">, name: string | null, portalUrl: string): { subject: string; text: string } {
  return { subject: n.title.slice(0, 150), text: [name ? `Hello ${name},` : "Hello,", "", `${n.title}.`, ...(n.body ? [n.body] : []), "", "Sign in to your portal to see it:", "", portalUrl, "", "For your privacy this email contains no answers or results."].join("\n") };
}

/** a staff reply as it will be stored, or the sentence that says what is wrong with it */
export function readReply(body: unknown): { enrolmentId: string; text: string } | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.enrolmentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.enrolmentId)) return { error: "Choose a respondent." };
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return { error: "Write a message first." };
  if (text.length > 4000) return { error: "Please keep a message under 4,000 characters." };
  return { enrolmentId: b.enrolmentId, text };
}
