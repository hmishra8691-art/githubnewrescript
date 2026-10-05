import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import type { SurveyDefinition } from "@rescript/schema";
import { supabaseService } from "@/lib/authServer";
import { loadDefinition, dueMilestone, runPlanFor, draftFindingsReport } from "@/lib/analytics";

/**
 * THE PLAN RUNS BY ITSELF (research-intelligence Phase 5).
 *
 * Hourly: every live survey with an analysis plan (and autoRun not turned
 * off) is checked against the milestones of its fieldwork — the first
 * readable base (30 completes), halfway to the suppliers' target, the
 * target, the end of the field window — and the plan is run once for each
 * milestone reached, the findings and the hypothesis verdicts kept in
 * `analytics_runs`. When the target is reached or the field closes, the
 * findings report is drafted from that run as well (analysisPlan.autoReport,
 * on unless turned off). Nothing is recomputed that was already run; a
 * survey with nothing due costs one count query.
 *
 * Authorised by CRON_SECRET like the other jobs; bounded in time so a slow
 * survey never blocks the rest — the next hour picks up what was left.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUDGET_MS = 45_000;
const MAX_SURVEYS = 200;

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });
  const db = supabaseService();
  const startedAt = Date.now();
  // only a survey whose definition carries an analysis plan can have a run due
  const { data: withPlan, error } = await db.from("surveys").select("id").not("draft_definition->research->>analysisPlan", "is", null).in("status", ["testing", "live", "closed"]).order("updated_at", { ascending: false }).limit(MAX_SURVEYS);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const surveyIds = (withPlan ?? []).map((r) => String((r as { id: string }).id));
  const ran: { surveyId: string; trigger: string; n: number; findings: number; report?: string }[] = [];
  const skipped: { surveyId: string; reason: string }[] = [];
  let checked = 0;
  for (const surveyId of surveyIds) {
    if (Date.now() - startedAt > BUDGET_MS) { skipped.push({ surveyId, reason: "time budget spent — next hour" }); continue; }
    checked++;
    const loaded = await loadDefinition(db, surveyId);
    if ("error" in loaded) { skipped.push({ surveyId, reason: loaded.error }); continue; }
    const def = loaded.def as SurveyDefinition;
    if (!def.research?.analysisPlan) continue;
    const due = await dueMilestone(db, surveyId, def);
    if (!due) continue;
    const r = await runPlanFor(db, surveyId, loaded, { environment: "LIVE", trigger: due });
    if (r.error && !r.stored) { skipped.push({ surveyId, reason: r.error }); continue; }
    let report: string | undefined;
    if ((due === "target_reached" || due === "field_end") && def.research.analysisPlan.autoReport !== false && r.stored) {
      const d = await draftFindingsReport(db, surveyId, loaded, r.stored);
      if (d.report) report = String(d.report.id);
    }
    ran.push({ surveyId, trigger: due, n: r.run.n, findings: r.run.findings.length, ...(report ? { report } : {}) });
  }
  return NextResponse.json({ ok: true, checked, ran, skipped, elapsedMs: Date.now() - startedAt });
}
