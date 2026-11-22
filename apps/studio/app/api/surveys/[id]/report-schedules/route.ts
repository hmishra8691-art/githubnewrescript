import { NextRequest, NextResponse } from "next/server";
import { nextRunAt, type AlertRule, type Cadence } from "@rescript/analytics";
import { audit, isFailure, requireProject, type ProjectContext } from "@/lib/guard";
import { mediaDb } from "@/lib/mediaRoute";
import { isMissing0110, MISSING_0110, runSchedule, SCHEDULE_COLUMNS, studioPublicUrl, timingOf } from "@/lib/reportSchedules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * REPORT SCHEDULES (Level 5 roadmap R5 + R6, migration 0110).
 *
 * GET                     ?reportId=   the schedules (of one report, or all) with their last runs
 * GET                     ?file=<runId>  a short-lived download link to the file a run stored (project access)
 * POST { action: "save", id?, reportId, name, kind: "report"|"alert", cadence, hourUtc, weekday?, dayOfMonth?,
 *        format?, recipients?, shareId?, alert?: { analysisId, metric, op, threshold, minBase? }, enabled? }
 * POST { action: "run", id }        run now (refresh on demand): recorded as a manual run, the schedule keeps its time
 * POST { action: "delete", id }
 *
 * Who may call: reading needs Data Analytics: View; changing or running needs Data Analytics & Reports: Publish —
 * a schedule sends the report's numbers to people by email.
 */
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const UUID = /^[0-9a-f-]{36}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (e: unknown) => { const m = (e as Error).message; return json({ error: isMissing0110(m) ? MISSING_0110 : m }, isMissing0110(m) ? 503 : 500); };

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "analytics.read");
  if (isFailure(gate)) return gate.response;
  const u = new URL(req.url);
  try {
    const fileRun = u.searchParams.get("file");
    if (fileRun) {
      if (!UUID.test(fileRun)) return json({ error: "Unknown file." }, 404);
      const { data: run } = await gate.db.from("report_runs").select("bucket, path, ran_at").eq("id", fileRun).eq("survey_id", params.id).maybeSingle();
      if (!run?.path) return json({ error: "That run has no file." }, 404);
      const store = mediaDb(gate.db as never).stores.primary;
      const ext = String(run.path).split(".").pop();
      const url = await store.signDownload(String(run.bucket), String(run.path), { seconds: 600, downloadAs: `report-${String(run.ran_at).slice(0, 10)}.${ext}` });
      return NextResponse.redirect(url, 302);
    }
    let q = gate.db.from("report_schedules").select(SCHEDULE_COLUMNS).eq("survey_id", params.id).order("created_at", { ascending: false }).limit(100);
    const reportId = u.searchParams.get("reportId");
    if (reportId && UUID.test(reportId)) q = q.eq("report_id", reportId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const ids = (data ?? []).map((s) => String(s.id));
    const { data: runs } = ids.length ? await gate.db.from("report_runs").select("id, schedule_id, trigger, status, headline, delivered, alert, error, bytes, ran_at").in("schedule_id", ids).order("ran_at", { ascending: false }).limit(200) : { data: [] };
    return json({ schedules: (data ?? []).map((s) => ({ ...s, last_digest: undefined, runs: (runs ?? []).filter((r) => r.schedule_id === s.id).slice(0, 10) })) });
  } catch (e) { return fail(e); }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "analytics.publish");
  if (isFailure(gate)) return gate.response;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "Send a JSON body with an action." }, 400);
  try {
    if (body.action === "save") return save(gate, body);
    const id = typeof body.id === "string" && UUID.test(body.id) ? body.id : null;
    if (!id) return json({ error: "Which schedule? Pass id." }, 400);
    const { data: s, error } = await gate.db.from("report_schedules").select(SCHEDULE_COLUMNS).eq("id", id).eq("survey_id", params.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!s) return json({ error: "No such schedule." }, 404);
    if (body.action === "delete") {
      await gate.db.from("report_schedules").delete().eq("id", id);
      log(gate, "analytics.schedule_deleted", id, { name: s.name });
      return json({ ok: true });
    }
    if (body.action === "run") {
      const out = await runSchedule(gate.db, s, { trigger: "manual", studioUrl: studioPublicUrl(new URL(req.url).origin) });
      log(gate, "analytics.schedule_run", id, { name: s.name, status: out.status, delivered: out.delivered });
      return json(out, out.status === "failed" ? 500 : 200);
    }
    return json({ error: "action is one of save, run, delete." }, 400);
  } catch (e) { return fail(e); }
}

function log(gate: ProjectContext, action: "analytics.schedule_saved" | "analytics.schedule_deleted" | "analytics.schedule_run", id: string, detail: Record<string, unknown>) {
  void audit({ action, userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: gate.surveyId, customerId: gate.user.customerId, entity: "analytics", entityId: id, detail });
}

async function save(gate: ProjectContext, b: Record<string, unknown>) {
  const problems: string[] = [];
  const reportId = typeof b.reportId === "string" && UUID.test(b.reportId) ? b.reportId : null;
  if (!reportId) problems.push("Which report? Pass reportId.");
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 120) : "";
  if (!name) problems.push("Name the schedule.");
  const kind = b.kind === "alert" ? "alert" : b.kind === "report" ? "report" : null;
  if (!kind) problems.push("kind is report or alert.");
  const cadence = (["daily", "weekly", "monthly"] as Cadence[]).includes(b.cadence as Cadence) ? (b.cadence as Cadence) : null;
  if (!cadence) problems.push("cadence is daily, weekly or monthly.");
  const hourUtc = Math.round(Number(b.hourUtc ?? 7));
  if (!(hourUtc >= 0 && hourUtc <= 23)) problems.push("hourUtc is 0 to 23.");
  const weekday = b.weekday == null ? null : Math.round(Number(b.weekday));
  if (cadence === "weekly" && !(weekday !== null && weekday >= 0 && weekday <= 6)) problems.push("A weekly schedule needs a weekday (0 = Sunday … 6 = Saturday).");
  const dayOfMonth = b.dayOfMonth == null ? null : Math.round(Number(b.dayOfMonth));
  if (cadence === "monthly" && !(dayOfMonth !== null && dayOfMonth >= 1 && dayOfMonth <= 31)) problems.push("A monthly schedule needs a day of the month (1–31).");
  const format = ["pptx", "pdf", "docx", "xlsx"].includes(String(b.format)) ? String(b.format) : null;
  if (kind === "report" && !format) problems.push("A report schedule needs a format: pptx, pdf, docx or xlsx.");
  const recipients = [...new Set((Array.isArray(b.recipients) ? b.recipients : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  for (const e of recipients) if (!EMAIL.test(e)) problems.push(`“${e}” is not an email address.`);
  if (recipients.length > 50) problems.push("At most 50 recipients.");
  let alert: AlertRule | null = null;
  if (kind === "alert") {
    const a = (b.alert ?? {}) as Partial<AlertRule>;
    if (!(typeof a.analysisId === "string" && UUID.test(a.analysisId))) problems.push("An alert needs the analysis it watches.");
    if (!(typeof a.metric === "string" && a.metric.trim())) problems.push("An alert needs the figure it watches (a KPI or a category).");
    if (a.op !== "above" && a.op !== "below") problems.push("An alert fires above or below its threshold.");
    if (!Number.isFinite(Number(a.threshold))) problems.push("An alert needs a numeric threshold.");
    if (!recipients.length) problems.push("An alert needs at least one recipient.");
    alert = { analysisId: String(a.analysisId), metric: String(a.metric ?? "").trim().slice(0, 120), op: a.op === "below" ? "below" : "above", threshold: Number(a.threshold), ...(a.minBase != null ? { minBase: Math.max(0, Math.round(Number(a.minBase))) } : {}) };
  }
  const shareId = typeof b.shareId === "string" && UUID.test(b.shareId) ? b.shareId : null;
  if (problems.length) return json({ error: `Not saved. ${problems.join(" ")}`, problems }, 400);
  const db = gate.db;
  const { data: rep } = await db.from("analytics_reports").select("id").eq("id", reportId!).eq("survey_id", gate.surveyId).is("deleted_at", null).maybeSingle();
  if (!rep) return json({ error: "Unknown report." }, 404);
  if (alert) { const { data: an } = await db.from("analytics_analyses").select("id").eq("id", alert.analysisId).eq("survey_id", gate.surveyId).is("deleted_at", null).maybeSingle(); if (!an) return json({ error: "The alert's analysis is not one of this project's analyses." }, 400); }
  if (shareId) { const { data: sh } = await db.from("analytics_shares").select("id").eq("id", shareId).eq("survey_id", gate.surveyId).eq("report_id", reportId!).maybeSingle(); if (!sh) return json({ error: "That share link is not a link to this report." }, 400); }
  const timing = { cadence: cadence!, hourUtc, weekday: weekday ?? undefined, dayOfMonth: dayOfMonth ?? undefined };
  const row = { survey_id: gate.surveyId, report_id: reportId, share_id: shareId, name, kind, cadence, hour_utc: hourUtc, weekday: cadence === "weekly" ? weekday : null, day_of_month: cadence === "monthly" ? dayOfMonth : null, format: kind === "report" ? format : null, recipients, alert, enabled: b.enabled !== false, next_run_at: nextRunAt(timing, new Date()).toISOString(), updated_at: new Date().toISOString() };
  const id = typeof b.id === "string" && UUID.test(b.id) ? b.id : null;
  const q = id ? db.from("report_schedules").update(row).eq("id", id).eq("survey_id", gate.surveyId) : db.from("report_schedules").insert({ ...row, created_by: gate.user.userId });
  const { data, error } = await q.select(SCHEDULE_COLUMNS).single();
  if (error) throw new Error(error.message);
  log(gate, "analytics.schedule_saved", String(data.id), { name, kind, cadence, recipients: recipients.length });
  return json({ ok: true, schedule: { ...data, last_digest: undefined }, nextRunAt: nextRunAt(timingOf(data), new Date()).toISOString() }, id ? 200 : 201);
}
