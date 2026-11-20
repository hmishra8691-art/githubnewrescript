import "server-only";
import { scorecardProblems } from "@rescript/engine";
import { SurveyDefinition } from "@rescript/schema";
import { audit, type ProjectContext } from "./guard";
import { platformDb } from "./db";
import { liveScoreKey, scorePage, type CompletedRow } from "./portalScoresCore";

/**
 * STORED SCORES FOR ONE SURVEY — status, and scoring again (phase 2, 2026-11-20; /api/surveys/[id]/portal/scores).
 *
 * The final save stores a completed interview's scores. Responses completed BEFORE the scorecard existed, or
 * before it last changed, carry no scores or scores of the old kind; the portal leaves those out of every
 * comparison. "Score again" works through the completed responses a page at a time and brings them up to date.
 * It writes only portal_scorecards (and clears the kept comparison): an answer is never touched.
 */
type Row = Record<string, unknown>;
const PAGE = 300;
const missing = (m: string | undefined) => /portal_scorecards|portal_benchmarks|schema cache|does not exist/i.test(m ?? "");

/** the version respondents are taking now — the one whose portal settings the portal applies */
async function liveDefinition(ctx: ProjectContext): Promise<SurveyDefinition | null> {
  const { data: deps } = await platformDb().from("deployments").select("version_id").eq("survey_id", ctx.surveyId).eq("mode", "live").eq("active", true).limit(1);
  const versionId = ((deps ?? []) as Row[])[0]?.version_id;
  if (typeof versionId !== "string") return null;
  const { data: v } = await ctx.db.from("survey_versions").select("definition").eq("id", versionId).eq("survey_id", ctx.surveyId).maybeSingle();
  const parsed = SurveyDefinition.safeParse((v as Row | null)?.definition);
  return parsed.success ? parsed.data : null;
}

export interface ScoresStatus {
  /** false until migration 0104 is applied */
  available: boolean;
  /** the survey is published with a scorecard */
  ready: boolean;
  why: string | null;
  completed: number;
  /** completed responses whose stored scores match the scoring that is live now */
  upToDate: number;
  /** people in the comparison the portal last built, and when */
  compared: { people: number; at: string } | null;
  problems: { dimension: string; message: string }[];
}

export async function scoresStatus(ctx: ProjectContext): Promise<ScoresStatus> {
  const live = await liveDefinition(ctx);
  const key = liveScoreKey(live);
  const base: ScoresStatus = { available: true, ready: !!key, why: !live ? "Publish the survey to score its responses." : !key ? "The published version has no scorecard. Add scores, save and publish." : null, completed: 0, upToDate: 0, compared: null, problems: live ? scorecardProblems(live) : [] };
  const done = await ctx.db.from("responses").select("id", { count: "exact", head: true }).eq("survey_id", ctx.surveyId).eq("status", "complete").eq("is_test", false).is("deleted_at", null);
  base.completed = done.count ?? 0;
  const stored = await ctx.db.from("portal_scorecards").select("response_id, responses!inner(status, deleted_at)", { count: "exact", head: true })
    .eq("survey_id", ctx.surveyId).eq("is_test", false).eq("fingerprint", key ?? "-").eq("responses.status", "complete").is("responses.deleted_at", null);
  if (stored.error) { if (missing(stored.error.message)) return { ...base, available: false, ready: false, why: "The scorecard tables are not on this database yet. Apply migration 0104." }; throw new Error(stored.error.message); }
  base.upToDate = key ? stored.count ?? 0 : 0;
  const { data: b } = await ctx.db.from("portal_benchmarks").select("people, computed_at, fingerprint").eq("survey_id", ctx.surveyId).maybeSingle();
  const kept = b as Row | null;
  if (kept && kept.fingerprint === key) base.compared = { people: Number(kept.people ?? 0), at: String(kept.computed_at) };
  return base;
}

export interface RescoreStep { scored: number; skipped: number; next: string | null }

/** one page of completed responses (test and live), after the id `after`; `next` is null when the last page is done */
export async function rescoreStep(ctx: ProjectContext, after: string | null): Promise<RescoreStep | { error: string; status: number }> {
  const live = await liveDefinition(ctx);
  if (!live) return { error: "Publish the survey to score its responses.", status: 409 };
  if (!liveScoreKey(live)) return { error: "The published version has no scorecard. Add scores, save and publish.", status: 409 };

  let q = ctx.db.from("responses").select("id, survey_id, respondent_id, is_test, version_id, completed_at, answers, calculated, embedded")
    .eq("survey_id", ctx.surveyId).eq("status", "complete").is("deleted_at", null).order("id", { ascending: true }).limit(PAGE);
  if (after) q = q.gt("id", after);
  const { data, error } = await q;
  if (error) return { error: error.message, status: 500 };
  const rows = (data ?? []) as unknown as CompletedRow[];

  const versions = new Map<string, SurveyDefinition>();
  const ids = [...new Set(rows.map((r) => r.version_id).filter((x): x is string => typeof x === "string"))];
  if (ids.length) {
    const { data: vs } = await ctx.db.from("survey_versions").select("id, definition").eq("survey_id", ctx.surveyId).in("id", ids);
    for (const v of (vs ?? []) as Row[]) { const p = SurveyDefinition.safeParse(v.definition); if (p.success) versions.set(String(v.id), p.data); }
  }
  const { upserts, skipped } = scorePage(rows, live, versions);
  if (upserts.length) {
    const w = await ctx.db.from("portal_scorecards").upsert(upserts, { onConflict: "response_id" });
    if (w.error) return missing(w.error.message) ? { error: "The scorecard tables are not on this database yet. Apply migration 0104.", status: 409 } : { error: w.error.message, status: 500 };
  }
  const next = rows.length === PAGE ? rows[rows.length - 1]!.id : null;
  if (!next) {
    /* the kept comparison was built from the old scores: the portal builds a new one on its next view */
    await ctx.db.from("portal_benchmarks").delete().eq("survey_id", ctx.surveyId);
    void audit({ action: "portal.scores_rebuilt", userId: ctx.user.userId, sessionId: ctx.user.sessionId, surveyId: ctx.surveyId, customerId: ctx.user.customerId, entity: "portal_scorecards", detail: {} });
  }
  return { scored: upserts.length, skipped, next };
}
