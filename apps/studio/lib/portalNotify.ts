import "server-only";
import { SurveyDefinition } from "@rescript/schema";
import { platformDb, surveyDb } from "./db";
import { mailConfig, sendMail } from "./mail";
import { runtimeBaseUrl } from "./runtime-url";
import { noticeMail, planReminders, type EnrolmentFacts, type NoticePlan } from "./portalNotifyCore";

/**
 * TELLING RESPONDENTS (phase 6, 2026-11-20). One way out for every notice: stored as a portal notification — once,
 * by its dedupe key — and, when the person has an email address and mail is configured, sent as an email that
 * says the same sentence and links to the portal (portalNotifyCore.ts `noticeMail`). The reminder job and the
 * Studio's answers and replies all come through `deliver`.
 */
type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);

export async function deliver(plans: NoticePlan[]): Promise<{ created: number; emailed: number }> {
  if (!plans.length) return { created: 0, emailed: 0 };
  const db = platformDb();
  const { data, error } = await db.from("portal_notifications")
    .upsert(plans.map((p) => ({ account_id: p.accountId, kind: p.kind, title: p.title, body: p.body, survey_id: p.surveyId, enrolment_id: p.enrolmentId, dedupe: p.dedupe })), { onConflict: "account_id,dedupe", ignoreDuplicates: true })
    .select("id, account_id, title, body");
  if (error) throw new Error(error.message);
  const created = (data ?? []) as Row[];
  let emailed = 0;
  if (created.length && mailConfig().configured) {
    const { data: accounts } = await db.from("portal_accounts").select("id, email, name, status").in("id", [...new Set(created.map((c) => String(c.account_id)))]);
    const who = new Map(((accounts ?? []) as Row[]).map((a) => [String(a.id), a]));
    const portal = `${runtimeBaseUrl()}/portal`;
    for (const n of created) {
      const a = who.get(String(n.account_id));
      const to = str(a?.email);
      if (!to || a?.status !== "active") continue;
      const m = noticeMail({ title: String(n.title), body: str(n.body) }, str(a?.name), portal);
      const sent = await sendMail({ to, subject: m.subject, text: m.text, kind: "portal_notice", stream: "transactional", dedupeKey: `portal-notice:${String(n.id)}` });
      if (sent.sent) { emailed++; await db.from("portal_notifications").update({ emailed_at: new Date().toISOString() }).eq("id", String(n.id)); }
    }
  }
  return { created: created.length, emailed };
}

/** the reminder job: every live survey with a portal, its enrolled people, what each is owed now */
export async function runReminders(budgetMs = 40_000): Promise<{ surveys: number; planned: number; created: number; emailed: number; partial: boolean }> {
  const started = Date.now();
  const totals = { surveys: 0, planned: 0, created: 0, emailed: 0, partial: false };
  const { data: deps, error } = await platformDb().from("deployments").select("survey_id, version_id").eq("mode", "live").eq("active", true).limit(2000);
  if (error) throw new Error(error.message);
  for (const d of (deps ?? []) as Row[]) {
    if (Date.now() - started > budgetMs) { totals.partial = true; break; }
    const surveyId = String(d.survey_id);
    const db = await surveyDb(surveyId);
    const { data: v } = await db.from("survey_versions").select("definition").eq("id", String(d.version_id)).eq("survey_id", surveyId).maybeSingle();
    const parsed = SurveyDefinition.safeParse((v as Row | null)?.definition);
    if (!parsed.success || !parsed.data.portal?.enabled) continue;
    const { data: people, error: pErr } = await db.from("respondents").select("id, account_id, access_from, access_until, max_attempts, portal_suspended").eq("survey_id", surveyId).eq("is_test", false).not("account_id", "is", null).limit(5000);
    if (pErr) throw new Error(pErr.message);
    const rows = (people ?? []) as Row[];
    if (!rows.length) continue;
    totals.surveys++;
    const last = new Map<string, { at: string; n: number }>();
    const ids = rows.map((r) => String(r.id));
    for (let i = 0; i < ids.length; i += 200) {
      const { data: done } = await db.from("responses").select("respondent_id, completed_at").eq("survey_id", surveyId).eq("status", "complete").eq("is_test", false).is("deleted_at", null).in("respondent_id", ids.slice(i, i + 200)).limit(20_000);
      for (const r of (done ?? []) as Row[]) {
        const id = String(r.respondent_id), at = str(r.completed_at);
        if (!at) continue;
        const had = last.get(id);
        last.set(id, { at: had && had.at > at ? had.at : at, n: (had?.n ?? 0) + 1 });
      }
    }
    const { data: s } = await db.from("surveys").select("title").eq("id", surveyId).maybeSingle();
    const facts: EnrolmentFacts[] = rows.map((r) => ({ id: String(r.id), accountId: String(r.account_id), accessFrom: str(r.access_from), accessUntil: str(r.access_until), suspended: r.portal_suspended === true, maxAttempts: r.max_attempts == null ? null : Number(r.max_attempts), lastCompletedAt: last.get(String(r.id))?.at ?? null, completions: last.get(String(r.id))?.n ?? 0 }));
    const plans = planReminders(surveyId, str((s as Row | null)?.title) ?? parsed.data.meta.title, parsed.data, facts, Date.now());
    totals.planned += plans.length;
    const out = await deliver(plans);
    totals.created += out.created; totals.emailed += out.emailed;
  }
  return totals;
}
