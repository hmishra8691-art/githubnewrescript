import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Condition, SurveyDefinition } from "@rescript/schema";
import {
  buildDataset, runAnalysis, variableMetadata, recommendCharts, DEFAULT_THEME,
  unionVariableMetadata, definitionResolver,
  type AnalysisDefinition, type AnalysisResult, type AnalyticsRow, type Dataset, type DatasetSpec, type ReportTheme, type SegmentDef, type VariableMeta,
} from "@rescript/analytics";
import type { VersionedDefinition } from "@rescript/engine";
import { getCachedVersionDefinition } from "@rescript/quality/server";
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

/*
 * `review_status` is READ, and that is finding 12 of the audit, not a column
 * added for completeness: without it the analytics dataset could not see the
 * researcher's own KEEP / REMOVE decisions, so the crosstabs disagreed with
 * the file delivered from the same study. The rule itself lives in
 * `inAnalyticsDataset` beside the exporters' `inDataset`.
 */
const COLUMNS = "id, version_id, session_id, respondent_code, respondent_id, status, is_test, answers, calculated, embedded, flags, seed, started_at, completed_at, quality, review_status, sample_source";
const CHUNK = 1000;
const MAX_ROWS = 250_000;

interface CacheEntry { at: number; stamp: string; rows: AnalyticsRow[]; bytes: number }
const rowCache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;
/*
 * THE CACHE IS BOUNDED IN BYTES, NOT ENTRIES. Forty entries of a 250 000-row
 * survey is not "forty entries", it is the process. Each entry is charged its
 * serialised size (an over-estimate of the heap it holds, which is the safe
 * direction) and the oldest entries go until the budget fits; a single result
 * larger than the whole budget is served but never kept.
 */
const CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
let cacheBytes = 0;
function remember(key: string, entry: Omit<CacheEntry, "bytes">) {
  let bytes = 0;
  for (const r of entry.rows) bytes += JSON.stringify(r).length * 2 + 64;
  const old = rowCache.get(key); if (old) { cacheBytes -= old.bytes; rowCache.delete(key); }
  if (bytes > CACHE_BUDGET_BYTES) return;
  while (cacheBytes + bytes > CACHE_BUDGET_BYTES && rowCache.size) {
    const oldest = [...rowCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    cacheBytes -= oldest[1].bytes; rowCache.delete(oldest[0]);
  }
  rowCache.set(key, { ...entry, bytes }); cacheBytes += bytes;
}
/** for tests and diagnostics */
export function rowCacheStats() { return { entries: rowCache.size, bytes: cacheBytes, budget: CACHE_BUDGET_BYTES }; }

/*
 * THE STAMP IS ASKED ONCE PER REPORT, NOT ONCE PER WIDGET.
 *
 * `dataStamp` is a COUNT(*) over `responses`. It was called before the row
 * cache was consulted, so a ten-widget report issued ten exact counts to
 * discover ten times that nothing had changed — and a published report with
 * viewer filters multiplied that again. Two seconds is shorter than any
 * render and far shorter than the row cache's own minute, so this cannot make
 * the dataset staler than it already was; it only stops the same question
 * being asked ten times in one breath.
 */
const stampCache = new Map<string, { at: number; stamp: string }>();
const STAMP_TTL_MS = 2_000;

async function dataStamp(db: SupabaseClient, surveyId: string, spec: DatasetSpec): Promise<string> {
  const key = `${surveyId}:${spec.environment}`;
  const hit = stampCache.get(key);
  if (hit && Date.now() - hit.at < STAMP_TTL_MS) return hit.stamp;
  const fresh = await computeStamp(db, surveyId, spec);
  stampCache.set(key, { at: Date.now(), stamp: fresh });
  return fresh;
}

async function computeStamp(db: SupabaseClient, surveyId: string, spec: DatasetSpec): Promise<string> {
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
    /*
     * The dataset rule is applied in `buildDataset`, not here.
     *
     * It used to be half here — `quality.is.null,quality->>classification.eq.CLEAN`
     * — and half absent, which is how it came to disagree with the export: a
     * KEEP decision on a SUSPICIOUS response never reached the loader, so the
     * row was gone before anything could honour it. `custom` was already
     * filtered downstream only. One rule, one place; the cost is reading rows
     * that are then dropped, which is what `MAX_ROWS` bounds.
     */
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as unknown as AnalyticsRow[];
    rows.push(...chunk);
    if (chunk.length < CHUNK) break;
  }
  /*
   * TRUNCATION IS RECORDED, NOT SWALLOWED.
   *
   * The loop stops at MAX_ROWS and used to return quietly, so a survey with
   * 300,000 responses produced a report computed on the first 250,000 that
   * looked exactly like a complete one. That is a correctness bug wearing a
   * performance costume: every base, every percentage and every significance
   * test in it is wrong, and nothing on the screen says so.
   *
   * A side table rather than a field, so the array stays a plain
   * `AnalyticsRow[]` for its one caller and for the row cache's byte
   * accounting.
   */
  if (rows.length >= MAX_ROWS) truncatedRows.add(rows);
  remember(key, { at: Date.now(), stamp, rows });
  return rows;
}

/** Row sets that hit MAX_ROWS, so the dataset built from them can say so. */
const truncatedRows = new WeakSet<AnalyticsRow[]>();
export function wasTruncated(rows: AnalyticsRow[]): boolean { return truncatedRows.has(rows); }

export interface LoadedContext {
  def: SurveyDefinition;
  version: string | null;
  revision: number | null;
  customerId: string | null;
  /** the version row the definition came from, when it came from one (R7) */
  versionId?: string | null;
}

export async function loadDefinition(db: SupabaseClient, surveyId: string): Promise<LoadedContext | { error: string; status: number }> {
  const loaded = await loadQualityDefinition(db, surveyId, "draft");
  if ("error" in loaded) {
    const v = await loadQualityDefinition(db, surveyId, "version");
    if ("error" in v) return v;
    return { def: v.def, version: v.version, revision: v.revision, customerId: v.customerId, versionId: v.versionId };
  }
  return { def: loaded.def, version: loaded.version, revision: loaded.revision, customerId: loaded.customerId, versionId: loaded.versionId };
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

/*
 * THE DATASET IS CACHED, NOT JUST THE ROWS.
 *
 * The row cache saved the cheap half. `buildDataset` is the expensive half —
 * it rebuilds the whole variable dictionary and then runs `rowToState` +
 * `flattenVariables` for every respondent, and `flattenVariables` walks the
 * questionnaire twice per case. A ten-widget dashboard did that ten times
 * over the same rows to produce ten identical `Case[]`.
 *
 * Safe to share because nothing downstream writes to it: no runner assigns to
 * `ds.*` or to a case, `filterDataset` returns `{...ds, cases}` over a fresh
 * array, and the one mutation in the package — `applyWeighting`, which sets
 * `c.weight` on the case objects themselves — happens inside `buildDataset`,
 * before the entry is stored. That mutation is exactly why `weighting` is
 * part of the key: two analyses weighting the same survey differently must
 * never be handed the same case objects.
 *
 * Keyed on the data stamp as well, so a new response invalidates it the same
 * way it invalidates the rows.
 */
interface DatasetEntry { at: number; key: string; ds: Dataset }
const datasetCache = new Map<string, DatasetEntry>();
const DATASET_TTL_MS = 60_000;
const DATASET_CACHE_MAX = 8;

/** for tests and diagnostics */
export function datasetCacheStats() { return { entries: datasetCache.size, max: DATASET_CACHE_MAX }; }

export async function buildFor(db: SupabaseClient, surveyId: string, ctx: LoadedContext, def: AnalysisDefinition): Promise<Dataset> {
  const stamp = await dataStamp(db, surveyId, def.dataset);
  const key = JSON.stringify([
    surveyId, stamp, def.dataset, def.weighting ?? null,
    ctx.versionId ?? ctx.version ?? null, ctx.revision ?? null,
  ]);
  const hit = datasetCache.get(key);
  if (hit && Date.now() - hit.at < DATASET_TTL_MS) return hit.ds;

  const rows = await loadRows(db, surveyId, def.dataset);
  const versioned = await resolveAnalyticsVersions(db, rows, ctx);
  const ds = buildDataset(ctx.def, rows, { spec: def.dataset, weighting: def.weighting ?? null, versioned });
  if (wasTruncated(rows)) ds.truncatedAt = MAX_ROWS;

  /*
   * Bounded by entry count rather than bytes, unlike the row cache — a
   * `Dataset` holds the same rows again in a shape whose heap size
   * `JSON.stringify` would badly misjudge, and eight datasets is already an
   * unusual number for one process to be serving at once.
   */
  datasetCache.set(key, { at: Date.now(), key, ds });
  while (datasetCache.size > DATASET_CACHE_MAX) {
    const oldest = [...datasetCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    datasetCache.delete(oldest[0]);
  }
  return ds;
}

/**
 * R7 — READ EACH RESPONSE THROUGH THE VERSION IT WAS COLLECTED UNDER.
 *
 * The export was fixed first, and until this existed the platform disagreed
 * with itself: the delivered CSV read each response through its own
 * questionnaire, and the crosstab on the screen beside it read every response
 * through the current one. Same study, two numbers, and whichever a
 * researcher quotes the other one contradicts.
 *
 * Returns `undefined` for a single-version study, which is every study until
 * somebody cuts a second version — so the common path allocates nothing and
 * behaves exactly as it did.
 */
async function resolveAnalyticsVersions(
  db: SupabaseClient,
  rows: AnalyticsRow[],
  ctx: LoadedContext,
): Promise<{ variables: VariableMeta[]; defFor: (row: AnalyticsRow) => SurveyDefinition } | undefined> {
  const ids = [...new Set(rows.map((r) => r.version_id).filter((v): v is string => !!v))];
  /*
   * Nothing to reconcile: no version on the rows at all, or every row under
   * the one the context already holds.
   */
  if (ids.length === 0) return undefined;
  if (ids.length === 1 && ctx.versionId && ids[0] === ctx.versionId) return undefined;

  const { data } = await db.from("survey_versions").select("id, version").in("id", ids);
  const numbers = new Map((data ?? []).map((v: { id: string; version: string }) => [v.id, String(v.version)]));

  const versions: VersionedDefinition[] = [];
  for (const id of ids) {
    const def = await getCachedVersionDefinition(db, id);
    if (def) versions.push({ versionId: id, version: numbers.get(id) ?? "?", def });
  }
  /*
   * The context's own definition joins the union. For a live study that is
   * the current version; for a draft-backed context it is what the analyst
   * is looking at, and leaving it out would drop a variable they can see in
   * the builder from the list they can analyse.
   */
  if (ctx.versionId && !versions.some((v) => v.versionId === ctx.versionId)) {
    versions.push({ versionId: ctx.versionId, version: ctx.version ?? "?", def: ctx.def });
  }
  if (!versions.length) return undefined;

  const union = unionVariableMetadata(versions);
  if (!union.mixed) return undefined;

  const resolve = definitionResolver(versions, ctx.def);
  return { variables: union.variables, defFor: (row) => resolve(row.version_id) };
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

/**
 * A theme is the survey's own or its workspace's — never another customer's.
 * The lookup is scoped the way the themes list is, because this runs through
 * the service role where RLS is not there to catch an id from elsewhere.
 */
export async function loadTheme(db: SupabaseClient, themeId: string | null | undefined, scope?: { surveyId: string; customerId: string | null }): Promise<ReportTheme> {
  if (!themeId) return DEFAULT_THEME;
  let q = db.from("analytics_themes").select("theme, name").eq("id", themeId).is("deleted_at", null);
  if (scope) q = q.or(`survey_id.eq.${scope.surveyId}${scope.customerId ? `,customer_id.eq.${scope.customerId}` : ""}`);
  const { data } = await q.maybeSingle();
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
