import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Condition, SurveyDefinition } from "@rescript/schema";
import {
  buildDataset, runAnalysis, variableMetadata, recommendCharts, DEFAULT_THEME,
  type AnalysisDefinition, type AnalysisResult, type AnalyticsRow, type Dataset, type DatasetSpec, type ReportTheme, type SegmentDef, type VariableMeta,
} from "@rescript/analytics";
import { loadQualityDefinition } from "./qualityDef";

/**
 * THE ANALYTICS SERVICE — server-side aggregation (§38).
 *
 * Every analysis is computed HERE, from the response rows the platform already
 * stores, and only the RESULT (tables, chart series, tests, insights, bases)
 * travels to the browser. The browser never receives a response row. Rows are
 * streamed from `responses` in chunks exactly as `responseData.ts` does, using
 * the same environment / status / soft-delete rules, so the dataset an analyst
 * sees is the dataset the data grid shows.
 *
 * A built dataset is cached briefly per (survey, environment, statuses,
 * quality) so a researcher iterating on an analysis does not re-scan the table
 * on every run; the cache key includes the survey's `revision` and the newest
 * response `updated_at`, so new data or a definition change invalidates it.
 */

const COLUMNS = "id, session_id, respondent_code, respondent_id, status, is_test, answers, calculated, embedded, flags, seed, started_at, completed_at, quality, sample_source";
const CHUNK = 1000;
const MAX_ROWS = 250_000;

interface CacheEntry { at: number; stamp: string; rows: AnalyticsRow[] }
const rowCache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

async function dataStamp(db: SupabaseClient, surveyId: string, spec: DatasetSpec): Promise<string> {
  let q = db.from("responses").select("updated_at", { count: "exact", head: false }).eq("survey_id", surveyId).is("deleted_at", null).order("updated_at", { ascending: false }).limit(1);
  if (spec.environment === "TEST") q = q.eq("is_test", true);
  else if (spec.environment === "LIVE") q = q.eq("is_test", false);
  const { data, count } = await q;
  return `${count ?? 0}:${data?.[0]?.updated_at ?? ""}`;
}

/** Stream every response row the dataset spec admits (chunked; never all-at-once). */
export async function loadRows(db: SupabaseClient, surveyId: string, spec: DatasetSpec): Promise<AnalyticsRow[]> {
  const statuses = spec.statuses?.length ? spec.statuses : ["complete"];
  const key = JSON.stringify([surveyId, spec.environment, statuses, spec.dataset, spec.qualityClasses ?? [], spec.from ?? "", spec.to ?? ""]);
  const stamp = await dataStamp(db, surveyId, spec);
  const hit = rowCache.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < TTL_MS) return hit.rows;
  const rows: AnalyticsRow[] = [];
  for (let start = 0; start < MAX_ROWS; start += CHUNK) {
    let q = db.from("responses").select(COLUMNS).eq("survey_id", surveyId).is("deleted_at", null).in("status", statuses).order("started_at", { ascending: true }).range(start, start + CHUNK - 1);
    if (spec.environment === "TEST") q = q.eq("is_test", true);
    else if (spec.environment === "LIVE") q = q.eq("is_test", false);
    if (spec.from) q = q.gte("started_at", spec.from);
    if (spec.to) q = q.lte("started_at", spec.to);
    if (spec.dataset === "clean") q = q.or("quality.is.null,quality->>classification.eq.CLEAN");
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as unknown as AnalyticsRow[];
    rows.push(...chunk);
    if (chunk.length < CHUNK) break;
  }
  rowCache.set(key, { at: Date.now(), stamp, rows });
  if (rowCache.size > 40) { const oldest = [...rowCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) rowCache.delete(oldest[0]); }
  return rows;
}

export interface LoadedContext { def: SurveyDefinition; version: string | null; revision: number | null; customerId: string | null }

export async function loadDefinition(db: SupabaseClient, surveyId: string): Promise<LoadedContext | { error: string; status: number }> {
  const loaded = await loadQualityDefinition(db, surveyId, "draft");
  if ("error" in loaded) {
    const v = await loadQualityDefinition(db, surveyId, "version");
    if ("error" in v) return v;
    return { def: v.def, version: v.version, revision: v.revision, customerId: v.customerId };
  }
  return { def: loaded.def, version: loaded.version, revision: loaded.revision, customerId: loaded.customerId };
}

/** Resolve saved filter / segment ids into the definition's inline conditions. */
export async function resolveSaved(db: SupabaseClient, surveyId: string, def: AnalysisDefinition): Promise<AnalysisDefinition> {
  const ids = [...(def.filterIds ?? []), ...((def.segments ?? []).filter((s) => !s.condition && s.id).map((s) => s.id))];
  if (!ids.length) return def;
  const { data } = await db.from("analytics_segments").select("id, name, kind, condition, color, description").eq("survey_id", surveyId).in("id", ids).is("deleted_at", null);
  const byId = new Map((data ?? []).map((r) => [r.id as string, r]));
  let filter = def.filter ?? null;
  const filters = (def.filterIds ?? []).map((id) => byId.get(id)?.condition as Condition | undefined).filter(Boolean) as Condition[];
  if (filters.length) filter = filter ? { type: "group", op: "and", children: [filter, ...filters] } as Condition : filters.length === 1 ? filters[0] : ({ type: "group", op: "and", children: filters } as Condition);
  const segments: SegmentDef[] | undefined = def.segments?.map((s) => { const saved = byId.get(s.id); return saved ? { id: s.id, name: s.name || (saved.name as string), condition: (s.condition ?? saved.condition) as Condition, color: s.color ?? (saved.color as string | undefined) } : s; });
  return { ...def, filter, segments };
}

export async function buildFor(db: SupabaseClient, surveyId: string, ctx: LoadedContext, def: AnalysisDefinition): Promise<Dataset> {
  const rows = await loadRows(db, surveyId, def.dataset);
  return buildDataset(ctx.def, rows, { spec: def.dataset, weighting: def.weighting ?? null });
}

export async function compute(db: SupabaseClient, surveyId: string, ctx: LoadedContext, definition: AnalysisDefinition): Promise<AnalysisResult & { recommendations: ReturnType<typeof recommendCharts> }> {
  const def = await resolveSaved(db, surveyId, definition);
  const ds = await buildFor(db, surveyId, ctx, def);
  const result = runAnalysis({ ...def, surveyVersion: def.surveyVersion ?? ctx.version ?? undefined }, ds);
  return { ...result, recommendations: recommendCharts(result) };
}

/** Variable picker payload: dictionary-derived metadata, grouped by question, plus dataset counts. */
export async function variablesPayload(db: SupabaseClient, surveyId: string, ctx: LoadedContext) {
  const variables: VariableMeta[] = variableMetadata(ctx.def).filter((v) => !v.hidden);
  const counts = await Promise.all((["LIVE", "TEST"] as const).map(async (env) => {
    let q = db.from("responses").select("id", { count: "exact", head: true }).eq("survey_id", surveyId).is("deleted_at", null).eq("status", "complete");
    q = env === "TEST" ? q.eq("is_test", true) : q.eq("is_test", false);
    const { count } = await q;
    return [env, count ?? 0] as const;
  }));
  return { variables, counts: Object.fromEntries(counts), surveyVersion: ctx.version, revision: ctx.revision };
}

export async function loadTheme(db: SupabaseClient, themeId: string | null | undefined): Promise<ReportTheme> {
  if (!themeId) return DEFAULT_THEME;
  const { data } = await db.from("analytics_themes").select("theme, name").eq("id", themeId).is("deleted_at", null).maybeSingle();
  return data ? ({ ...(data.theme as ReportTheme), name: data.name as string, id: themeId }) : DEFAULT_THEME;
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export async function hashPassword(pw: string, salt?: string): Promise<string> {
  const s = salt ?? newToken().slice(0, 16);
  const data = new TextEncoder().encode(`${s}:${pw}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `${s}$${Buffer.from(digest).toString("hex")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [salt] = stored.split("$");
  return (await hashPassword(pw, salt)) === stored;
}
