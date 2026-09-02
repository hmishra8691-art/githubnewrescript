import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { countRespondentQuestions } from "@rescript/engine";

/**
 * Survey Project Dashboard statistics.
 *
 * Every number here is derived from the existing source of truth — the
 * `responses` table for counts, `responses.is_test` for the test/live split,
 * the current version's definition for the question count, and
 * `created_by` / `audit_logs.user_id` for contributors. Nothing is stored
 * twice and nothing is hard-coded, so the dashboard cannot drift from the
 * data it describes.
 *
 * Two paths:
 *   • `survey_dashboard_stats()` (migration 0002) does the whole job in one
 *     round trip, counting inside the database.
 *   • if that function is not there yet, a fallback computes the same numbers
 *     from ordinary queries, so the dashboard works before the migration is
 *     applied — just less efficiently, and it says so.
 */

export interface SurveyStats {
  surveyId: string;
  questionCount: number | null;
  responseCount: number | null;
  testResponseCount: number | null;
  liveResponseCount: number | null;
  completeCount: number | null;
  lastResponseAt: string | null;
  contributorIds: string[];
  versionCount: number | null;
}

export interface Contributor {
  id: string;
  name: string;
  initials: string;
}

export interface DashboardPayload {
  stats: Record<string, SurveyStats>;
  contributors: Record<string, Contributor>;
  /** which path produced these numbers — surfaced so a slow page is explicable */
  source: "rpc" | "fallback";
  /** a statistic that could not be loaded degrades to null rather than to 0 */
  warnings: string[];
}

const EMPTY_STATS = (surveyId: string): SurveyStats => ({
  surveyId,
  questionCount: null,
  responseCount: null,
  testResponseCount: null,
  liveResponseCount: null,
  completeCount: null,
  lastResponseAt: null,
  contributorIds: [],
  versionCount: null,
});

/** Mirrors `rescript_question_count` in SQL — see the engine for the rule. */
export const countQuestions = countRespondentQuestions;

/* --------------------------------------------------------------- the RPC */

async function viaRpc(
  db: SupabaseClient,
  surveyIds: string[],
): Promise<Record<string, SurveyStats> | null> {
  const { data, error } = await db.rpc("survey_dashboard_stats");
  if (error || !Array.isArray(data)) return null; // not migrated yet
  const out: Record<string, SurveyStats> = {};
  for (const id of surveyIds) out[id] = EMPTY_STATS(id);
  for (const row of data as Record<string, unknown>[]) {
    const id = String(row.survey_id);
    if (!(id in out)) continue;
    out[id] = {
      surveyId: id,
      questionCount: Number(row.question_count ?? 0),
      responseCount: Number(row.response_count ?? 0),
      testResponseCount: Number(row.test_response_count ?? 0),
      liveResponseCount: Number(row.live_response_count ?? 0),
      completeCount: Number(row.complete_count ?? 0),
      lastResponseAt: (row.last_response_at as string) ?? null,
      contributorIds: Array.isArray(row.contributor_ids)
        ? (row.contributor_ids as string[]).filter(Boolean)
        : [],
      versionCount: Number(row.version_count ?? 0),
    };
  }
  return out;
}

/* ---------------------------------------------------------- the fallback */

/**
 * Same numbers without the migration. Deliberately bounded: it asks for
 * response rows with only the three columns it needs rather than whole
 * responses, and pulls one definition per survey. Fine for tens of surveys,
 * which is why the RPC exists for the rest.
 */
async function viaFallback(
  db: SupabaseClient,
  surveys: { id: string; current_version_id: string | null; created_by: string | null }[],
  warnings: string[],
): Promise<Record<string, SurveyStats>> {
  const out: Record<string, SurveyStats> = {};
  for (const s of surveys) out[s.id] = EMPTY_STATS(s.id);

  const ids = surveys.map((s) => s.id);
  if (ids.length === 0) return out;

  // one pass over the responses of these surveys
  try {
    const { data, error } = await db
      .from("responses")
      .select("survey_id, is_test, status, started_at")
      .in("survey_id", ids);
    if (error) throw new Error(error.message);
    for (const s of surveys) {
      out[s.id].responseCount = 0;
      out[s.id].testResponseCount = 0;
      out[s.id].liveResponseCount = 0;
      out[s.id].completeCount = 0;
    }
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const st = out[String(r.survey_id)];
      if (!st) continue;
      st.responseCount = (st.responseCount ?? 0) + 1;
      if (r.is_test) st.testResponseCount = (st.testResponseCount ?? 0) + 1;
      else st.liveResponseCount = (st.liveResponseCount ?? 0) + 1;
      if (r.status === "complete") st.completeCount = (st.completeCount ?? 0) + 1;
      const at = r.started_at as string | null;
      if (at && (!st.lastResponseAt || at > st.lastResponseAt)) st.lastResponseAt = at;
    }
  } catch (e) {
    warnings.push(`response counts unavailable: ${(e as Error).message}`);
  }

  // question counts from the current version's definition
  const versionIds = surveys.map((s) => s.current_version_id).filter(Boolean) as string[];
  if (versionIds.length) {
    try {
      const { data, error } = await db
        .from("survey_versions")
        .select("id, survey_id, definition, created_by")
        .in("id", versionIds);
      if (error) throw new Error(error.message);
      for (const v of (data ?? []) as Record<string, unknown>[]) {
        const st = out[String(v.survey_id)];
        if (st) st.questionCount = countQuestions(v.definition);
      }
    } catch (e) {
      warnings.push(`question counts unavailable: ${(e as Error).message}`);
    }
  }

  // contributors + version counts
  try {
    const { data, error } = await db
      .from("survey_versions")
      .select("survey_id, created_by")
      .in("survey_id", ids);
    if (error) throw new Error(error.message);
    const seen: Record<string, Set<string>> = {};
    for (const s of surveys) {
      seen[s.id] = new Set(s.created_by ? [s.created_by] : []);
      out[s.id].versionCount = 0;
    }
    for (const v of (data ?? []) as Record<string, unknown>[]) {
      const sid = String(v.survey_id);
      if (!seen[sid]) continue;
      out[sid].versionCount = (out[sid].versionCount ?? 0) + 1;
      if (v.created_by) seen[sid].add(String(v.created_by));
    }
    for (const s of surveys) out[s.id].contributorIds = [...seen[s.id]];
  } catch (e) {
    warnings.push(`contributors unavailable: ${(e as Error).message}`);
  }

  return out;
}

/* ------------------------------------------------------------------ entry */

export async function loadDashboardStats(
  db: SupabaseClient,
  surveys: { id: string; current_version_id: string | null; created_by?: string | null }[],
): Promise<DashboardPayload> {
  const warnings: string[] = [];
  const ids = surveys.map((s) => s.id);

  let stats = await viaRpc(db, ids);
  let source: DashboardPayload["source"] = "rpc";
  if (!stats) {
    source = "fallback";
    warnings.push(
      "Using per-survey queries — apply supabase/migrations/0002_dashboard_stats.sql for single-query stats.",
    );
    stats = await viaFallback(
      db,
      surveys.map((s) => ({
        id: s.id,
        current_version_id: s.current_version_id,
        created_by: s.created_by ?? null,
      })),
      warnings,
    );
  }

  // resolve contributor identities, without exposing more than a name
  const everyone = [...new Set(Object.values(stats).flatMap((s) => s.contributorIds))];
  const contributors: Record<string, Contributor> = {};
  if (everyone.length) {
    try {
      const { data } = await db
        .from("profiles")
        .select("id, full_name, email")
        .in("id", everyone);
      for (const p of (data ?? []) as Record<string, unknown>[]) {
        const name =
          (p.full_name as string) || (p.email as string)?.split("@")[0] || "Unknown";
        contributors[String(p.id)] = { id: String(p.id), name, initials: initialsOf(name) };
      }
    } catch {
      warnings.push("contributor names unavailable");
    }
    // a contributor with no profile row still counts — we just cannot name them
    for (const id of everyone) {
      if (!contributors[id]) contributors[id] = { id, name: "Unknown user", initials: "?" };
    }
  }

  return { stats, contributors, source, warnings };
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
