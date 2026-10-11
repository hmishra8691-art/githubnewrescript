import { NextRequest, NextResponse } from "next/server";
import { auditCategory, describeEvent } from "@rescript/access";
import type { SurveyDefinition } from "@rescript/schema";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseAdmin } from "@/lib/admin";
import { loadDefinition } from "@/lib/analytics";
import { loadDashboardStats } from "@/lib/dashboard";
import { getMeter, SANDBOX_CUSTOMER } from "@/lib/metering";
import { projectMeterView } from "@/lib/billingView";
import { moduleStates, overviewSummary, type OverviewFacts } from "@/lib/projectOverview";

export const dynamic = "force-dynamic";

/**
 * THE PROJECT OVERVIEW in one request (dashboard brief §2): the project's
 * facts, its counts, the state of every module read from what is saved, its
 * spend from the same meter the Usage tab reads, and its last activity.
 * `project.read`; every optional source (quota counters, reports, runs,
 * sample sources, the meter, the audit log) fails soft, so a database missing
 * a table still answers with what it has, and says so in `warnings`.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.read");
  if (isFailure(ctx)) return ctx.response;
  const db = supabaseAdmin();
  const surveyId = params.id;
  const warnings: string[] = [];
  const soft = async <T,>(what: string, p: PromiseLike<T>, fallback: T): Promise<T> => { try { return await p; } catch (e) { warnings.push(`${what}: ${(e as Error).message}`); return fallback; } };

  const loaded = await loadDefinition(db, surveyId);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const def = loaded.def as SurveyDefinition;

  const [survey, deployments, quotaRows, reports, analyses, latestRun, sampleSources, stats, meterView, activity] = await Promise.all([
    db.from("surveys").select("id, code, title, status, current_version_id, draft_updated_at, revision, updated_at, created_at, client_name, project_manager, fieldwork_from, fieldwork_to, due_date, locked").eq("id", surveyId).maybeSingle().then((r) => r.data ?? null),
    soft("deployments", db.from("deployments").select("mode, active, version_id").eq("survey_id", surveyId).then((r) => { if (r.error) throw new Error(r.error.message); return r.data ?? []; }), [] as { mode: string; active: boolean; version_id: string | null }[]),
    soft("quota counts", db.from("quota_counts").select("quota_id, cell_id, count, is_test").eq("survey_id", surveyId).then((r) => { if (r.error) throw new Error(r.error.message); return r.data ?? []; }), [] as { quota_id: string; cell_id: string; count: number; is_test: boolean | null }[]),
    soft("reports", db.from("analytics_reports").select("id, kind").eq("survey_id", surveyId).is("deleted_at", null).then((r) => { if (r.error) throw new Error(r.error.message); return r.data ?? []; }), [] as { id: string; kind: string }[]),
    soft("analyses", db.from("analytics_analyses").select("id", { count: "exact", head: true }).eq("survey_id", surveyId).is("deleted_at", null).then((r) => { if (r.error) throw new Error(r.error.message); return r.count ?? 0; }), 0),
    soft("runs", db.from("analytics_runs").select("computed_at, n, trigger").eq("survey_id", surveyId).order("computed_at", { ascending: false }).limit(1).maybeSingle().then((r) => { if (r.error) throw new Error(r.error.message); return r.data ? { computedAt: String(r.data.computed_at), n: Number(r.data.n ?? 0), trigger: String(r.data.trigger) } : null; }), null),
    soft("sample sources", db.from("sample_sources").select("id", { count: "exact", head: true }).eq("survey_id", surveyId).then((r) => { if (r.error) throw new Error(r.error.message); return r.count ?? 0; }), 0),
    soft("statistics", loadDashboardStats(db, [{ id: surveyId, current_version_id: null }]).then((p) => p.stats[surveyId] ?? null), null),
    soft("usage", (async () => { const meter = getMeter(); return projectMeterView(meter, { customerId: ctx.survey.customer_id ?? ctx.user.customerId ?? SANDBOX_CUSTOMER, surveyId }, { recent: 0 }); })(), null),
    soft("activity", db.from("audit_logs").select("id, action, entity, entity_id, user_id, detail, created_at").eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(8).then((r) => { if (r.error) throw new Error(r.error.message); return r.data ?? []; }), [] as { id: string; action: string; entity: string | null; entity_id: string | null; user_id: string | null; detail: unknown; created_at: string }[]),
  ]);
  if (!survey) return NextResponse.json({ error: "not found" }, { status: 404 });

  const quotaCounts: Record<string, Record<string, number>> = {};
  for (const r of quotaRows) { if (r.is_test) continue; (quotaCounts[r.quota_id] ??= {})[r.cell_id] = (quotaCounts[r.quota_id]?.[r.cell_id] ?? 0) + Number(r.count ?? 0); }
  const config = { clientName: survey.client_name as string | null, projectManager: survey.project_manager as string | null, fieldworkFrom: survey.fieldwork_from ? String(survey.fieldwork_from).slice(0, 10) : null, fieldworkTo: survey.fieldwork_to ? String(survey.fieldwork_to).slice(0, 10) : null, dueDate: survey.due_date ? String(survey.due_date).slice(0, 10) : null };
  const facts: OverviewFacts = { deployments, quotaCounts, reports, analyses, latestRun, config, sampleSources, status: String(survey.status) };
  const modules = moduleStates(def, facts);

  const userIds = [...new Set(activity.map((r) => r.user_id).filter(Boolean))] as string[];
  const people = new Map<string, string>();
  if (userIds.length) { const { data } = await db.from("profiles").select("id, full_name").in("id", userIds); for (const p of data ?? []) people.set(p.id, p.full_name ?? ""); }
  const events = activity.map((r) => { const row = { id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id, surveyId, userId: r.user_id, actorName: r.user_id ? people.get(r.user_id) ?? null : null, actorUserCode: null, detail: (r.detail as Record<string, unknown> | null) ?? null, createdAt: r.created_at }; return { id: r.id, text: describeEvent(row), category: auditCategory(r.action), at: r.created_at, actorName: row.actorName }; });

  return NextResponse.json({
    ok: true,
    project: {
      id: surveyId, code: String(survey.code), title: String(survey.title), status: String(survey.status), version: loaded.version, revision: loaded.revision,
      draftSavedAt: survey.draft_updated_at ? String(survey.draft_updated_at) : null, updatedAt: String(survey.updated_at ?? ""), createdAt: String(survey.created_at ?? ""),
      locked: !!survey.locked, role: ctx.role, roleSource: ctx.roleSource, ...config,
      languages: def.localization?.languages.length ?? 0, sourceLanguage: def.localization?.sourceLanguage ?? "en",
    },
    counts: {
      questions: def.questions.filter((q) => !["html", "hidden", "calculated", "embedded_data"].includes(q.type)).length,
      pages: JSON.stringify(def.flow).split("\"type\":\"page\"").length - 1,
      responses: stats?.responseCount ?? null, live: stats?.liveResponseCount ?? null, test: stats?.testResponseCount ?? null, complete: stats?.completeCount ?? null, lastResponseAt: stats?.lastResponseAt ?? null,
    },
    modules, summary: overviewSummary(modules),
    /* this project's spend — the same figures the Usage tab shows; never the wallet balance */
    spend: meterView ? { currency: meterView.wallet.currency, used: meterView.project.used, limit: meterView.project.limit, allowance: meterView.project.allowance, mode: meterView.project.mode, level: meterView.project.level, state: meterView.project.state, events: meterView.project.events, walletRemaining: meterView.summary.remaining } : null,
    activity: events,
    warnings,
  }, { headers: { "cache-control": "no-store" } });
}
