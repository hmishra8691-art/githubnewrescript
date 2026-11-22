import { changeSummary, checkAlert, digestResults, nextRunAt, type AlertRule, type AnalysisResult, type Cadence, type MetricDigest, type ReportDefinition, type ReportFormat, type ReportTheme } from "@rescript/analytics";
import { renderReport } from "@rescript/analytics/export";
import { metricAlertEmail, reportDeliveryEmail } from "@rescript/mail";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * RUNNING A REPORT SCHEDULE (Level 5 roadmap R5 + R6, migration 0110) — the run itself, with its database, computation,
 * store and mail handed in (reportSchedules.ts wires the real ones), so it can be tested end to end. One run:
 *   1. re-compute every analysis the report uses, from the data as it is now;
 *   2. digest the numbers and compare with the last run's digest (packages/analytics/src/reportSchedule.ts);
 *   3. kind "report": render the chosen format through the one renderer, store it, and email the recipients the
 *      change summary with a sign-in link to the file (and the share link when the schedule names one);
 *      kind "alert": check the rule and email only when the metric crossed its threshold since the last run;
 *      with `republish` on (migration 0114), the fresh results are first published as the report's next version, so
 *      share links that follow the latest version show them (a blank or partial result is not published);
 *   4. record the run and move the schedule on.
 * A run that fails is recorded with its reason and the schedule still moves on (the next run tries again).
 */
type Db = SupabaseClient;
import { REPORTS_BUCKET } from "./storyCore.ts";
type Row = Record<string, unknown>;
/* "*" rather than a column list so a database without migration 0114 (report_schedules.republish) still reads its
   schedules: the column simply is not there, and a schedule without it never republishes */
export const SCHEDULE_COLUMNS = "*";
export const MISSING_0110 = "Report schedules need migration 0110 (report_schedules, report_runs), which has not been applied to this database.";
export const isMissing0110 = (m: string) => !isMissing0114(m) && /report_schedules|report_runs|does not exist|schema cache/i.test(m);
export const MISSING_0114 = "Republishing on refresh needs migration 0114 (report_schedules.republish), which has not been applied to this database. The schedule can be saved without it.";
export const isMissing0114 = (m: string) => /republish/i.test(m);

export const timingOf = (s: Row) => ({ cadence: String(s.cadence) as Cadence, hourUtc: Number(s.hour_utc ?? 7), weekday: s.weekday == null ? undefined : Number(s.weekday), dayOfMonth: s.day_of_month == null ? undefined : Number(s.day_of_month) });
export const runFilePath = (surveyId: string, scheduleId: string, runAt: string, format: string) => `schedules/${surveyId}/${scheduleId}/${runAt.replace(/[:.]/g, "-")}.${format}`;

export interface RunOutcome { status: "ok" | "failed" | "skipped"; headline: string | null; delivered: number; alertFired: boolean; runId: string | null; error?: string; published?: { version: number; withheld: number } | { notPublished: string } }

export interface RunDeps {
  /** every analysis the report uses, computed from the data as it is now */
  compute(report: ReportDefinition): Promise<Record<string, AnalysisResult>>;
  theme(themeId: string | null, customerId: string | null): Promise<ReportTheme>;
  store: { name: string; put(bucket: string, path: string, bytes: Buffer, o: { contentType: string }): Promise<unknown> };
  mailConfigured: boolean;
  send(m: { to: string; subject: string; text: string; html?: string; kind: "report_delivery" | "metric_alert"; dedupeKey: string }): Promise<{ sent: boolean }>;
  /**
   * publish the results just computed as the report's next version (reportPublishCore.ts) — called only for a report
   * schedule with `republish` on; share links not pinned to a version then show the new numbers
   */
  publish?(reportId: string, results: Record<string, AnalysisResult>, note: string): Promise<{ ok: true; version: number; withheld: string[] } | { ok: false; error: string }>;
}

export async function runScheduleWith(db: Db, deps: RunDeps, s: Row, opts: { trigger: "schedule" | "manual"; studioUrl: string | null }): Promise<RunOutcome> {
  const surveyId = String(s.survey_id), scheduleId = String(s.id);
  const ranAt = new Date().toISOString();
  const record = async (row: Row) => {
    const { data } = await db.from("report_runs").insert({ schedule_id: scheduleId, survey_id: surveyId, trigger: opts.trigger, ran_at: ranAt, ...row }).select("id").single();
    return data ? String((data as { id: string }).id) : null;
  };
  const advance = async (digest: MetricDigest | null) => {
    const patch: Row = { last_run_at: ranAt, updated_at: ranAt, ...(digest ? { last_digest: digest } : {}) };
    if (opts.trigger === "schedule") patch.next_run_at = nextRunAt(timingOf(s), new Date()).toISOString();
    await db.from("report_schedules").update(patch).eq("id", scheduleId);
  };
  try {
    const [{ data: report }, { data: survey }] = await Promise.all([
      db.from("analytics_reports").select("id, name, definition, theme_id, deleted_at").eq("id", String(s.report_id)).eq("survey_id", surveyId).maybeSingle(),
      db.from("surveys").select("title, customer_id").eq("id", surveyId).maybeSingle(),
    ]);
    if (!report || (report as Row).deleted_at) { const runId = await record({ status: "skipped", headline: "The report was deleted, so nothing was run.", error: "report deleted" }); await db.from("report_schedules").update({ enabled: false, updated_at: ranAt }).eq("id", scheduleId); return { status: "skipped", headline: null, delivered: 0, alertFired: false, runId }; }
    const r = report as Row;
    const definition = r.definition as ReportDefinition;
    const results = await deps.compute(definition);
    const digest = digestResults(results, ranAt);
    const prev = (s.last_digest ?? null) as MetricDigest | null;
    const summary = changeSummary(prev, digest);
    const studyTitle = String((survey as Row | null)?.title ?? "the study");
    const reportName = String(r.name ?? definition.title ?? "Report");
    const recipients = (Array.isArray(s.recipients) ? (s.recipients as string[]) : []).filter(Boolean);
    const mailing = deps.mailConfigured && recipients.length > 0;
    const shareUrl = s.share_id && opts.studioUrl ? await shareLinkOf(db, String(s.share_id), opts.studioUrl) : null;
    let delivered = 0;

    if (s.kind === "alert") {
      const rule = s.alert as AlertRule;
      const check = checkAlert(rule, digest, prev);
      if (check.fire && mailing) {
        const m = metricAlertEmail({ reportName, studyTitle, sentence: check.sentence, url: opts.studioUrl ? `${opts.studioUrl}/analytics?survey=${surveyId}` : null });
        for (const to of recipients) { const sent = await deps.send({ to, subject: m.subject, text: m.text, html: m.html, kind: "metric_alert", dedupeKey: `metric-alert:${scheduleId}:${ranAt}:${to}` }); if (sent.sent) delivered++; }
      }
      const runId = await record({ status: "ok", headline: check.sentence.slice(0, 1000), changes: summary, alert: { ...check, rule }, delivered });
      await advance(digest);
      return { status: "ok", headline: check.sentence, delivered, alertFired: check.fire, runId };
    }

    /* kind "report": render, store, republish when asked, tell */
    const format = String(s.format ?? "pptx") as ReportFormat;
    const theme = await deps.theme((r.theme_id as string | null) ?? null, ((survey as Row | null)?.customer_id as string | null) ?? null);
    const rendered = await renderReport(format, { report: definition, results, theme, meta: { survey: studyTitle, generatedBy: `Scheduled: ${String(s.name)}` } });
    const store = deps.store;
    const path = runFilePath(surveyId, scheduleId, ranAt, format);
    await store.put(REPORTS_BUCKET, path, rendered.bytes, { contentType: rendered.mime });
    let published: { version: number; withheld: number } | { notPublished: string } | null = null;
    let headline = summary.headline;
    if (s.republish === true && deps.publish) {
      /* published after the file is stored, so a run that fails to render publishes nothing; never forced: a run whose report comes out blank or partial keeps the last published version and says why */
      const p = await deps.publish(String(r.id), results, `Republished by the schedule “${String(s.name)}” (${opts.trigger === "manual" ? "run now" : "scheduled run"}).`);
      if (p.ok) { published = { version: p.version, withheld: p.withheld.length }; headline = `${headline} Published as version ${p.version}; share links that follow the latest version now show it.`; }
      else { published = { notPublished: p.error }; headline = `${headline} Not republished: ${p.error.replace(/^Not published\.\s*/, "")} Share links still show the last published version.`; }
      headline = headline.slice(0, 1000);
    }
    const runId = await record({ status: "ok", headline, changes: { ...summary, coverage: rendered.coverage.notes, ...(published ? { published } : {}) }, storage_provider: store.name, bucket: REPORTS_BUCKET, path, bytes: rendered.bytes.length });
    if (mailing && runId) {
      const fileUrl = opts.studioUrl ? `${opts.studioUrl}/api/surveys/${surveyId}/report-schedules?file=${runId}` : null;
      const m = reportDeliveryEmail({ reportName, studyTitle, headline, changes: summary.changes.map((c) => c.sentence), fileUrl, shareUrl, format });
      for (const to of recipients) { const sent = await deps.send({ to, subject: m.subject, text: m.text, html: m.html, kind: "report_delivery", dedupeKey: `report-delivery:${runId}:${to}` }); if (sent.sent) delivered++; }
      await db.from("report_runs").update({ delivered }).eq("id", runId);
    }
    await advance(digest);
    return { status: "ok", headline, delivered, alertFired: false, runId, ...(published ? { published } : {}) };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 900);
    if (isMissing0110(msg)) throw e;
    const runId = await record({ status: "failed", error: msg }).catch(() => null);
    await advance(null).catch(() => undefined);
    return { status: "failed", headline: null, delivered: 0, alertFired: false, runId, error: msg };
  }
}

async function shareLinkOf(db: Db, shareId: string, studioUrl: string): Promise<string | null> {
  const { data } = await db.from("analytics_shares").select("token, revoked_at, expires_at").eq("id", shareId).maybeSingle();
  const r = data as Row | null;
  if (!r || r.revoked_at || (r.expires_at && Date.parse(String(r.expires_at)) < Date.now())) return null;
  return `${studioUrl}/share/${String(r.token)}`;
}

