import "server-only";
import { SurveyDefinition, type Condition } from "@rescript/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildVariableDictionary, compileResponseFilter, flattenVariables, matchesResponseCondition,
  responseMatchesText, rowToState, type PrefilterClause,
} from "@rescript/engine";

/**
 * The one service every response reader goes through.
 *
 * Two rules it exists to enforce:
 *
 *   1. ENVIRONMENT IS A PARAMETER, never a default. `Environment` has no
 *      fallback value in this module — a caller must say TEST, LIVE or ALL,
 *      and ALL only exists because the researcher can ask for it explicitly.
 *      A query that forgot to say is a type error, not a mixed dataset.
 *   2. SOFT-DELETED ROWS ARE NOT DATA. Every read here excludes them unless
 *      the caller asks for the recycle bin on purpose.
 *
 * Filtering is two-stage by design (see `compileResponseFilter`): the database
 * narrows with clauses no matching row can fail, then the survey engine
 * decides. Nothing is ever loaded into the browser to be filtered — a count
 * over 100 000 rows streams here in chunks and returns a number.
 */

export type Environment = "TEST" | "LIVE" | "ALL";

export function parseEnvironment(raw: string | null | undefined): Environment | null {
  const v = String(raw ?? "").toUpperCase();
  return v === "TEST" || v === "LIVE" || v === "ALL" ? v : null;
}

/** Columns a grid row needs — deliberately not `telemetry` or `quality`. */
const ROW_COLUMNS =
  "id, session_id, respondent_code, respondent_id, status, is_test, environment, revision, source, " +
  "answers, calculated, embedded, flags, seed, started_at, completed_at, updated_at, last_saved_at, " +
  "deleted_at, deleted_by, deletion_reason, quality, review_status";

/** Columns the filter engine needs, and nothing more (chunked scans stay small). */
const FILTER_COLUMNS = "id, session_id, respondent_code, respondent_id, status, answers, calculated, embedded, flags, seed, started_at";

export interface ResponseQuery {
  surveyId: string;
  environment: Environment;
  /** statuses to include; empty/absent = every finished status AND in progress */
  statuses?: string[];
  /** free-text over identifiers and exported values */
  search?: string;
  /** researcher filter — an ordinary survey Condition */
  filter?: Condition | null;
  from?: string;
  to?: string;
  /** the recycle bin instead of the live dataset */
  deleted?: boolean;
  sort?: { field: "started_at" | "completed_at" | "updated_at" | "respondent_code" | "status"; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

export interface ResponseRecord {
  id: string;
  respondentCode: string | null;
  sessionId: string;
  respondentId: string | null;
  status: string;
  environment: "TEST" | "LIVE";
  revision: number;
  source: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  lastSavedAt: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  deletionReason: string | null;
  /** raw answers, keyed by question id — what an edit writes back */
  answers: Record<string, unknown>;
  calculated: Record<string, unknown>;
  embedded: Record<string, unknown>;
  flags: string[];
  /** the exported variable map — what the grid shows */
  vars: Record<string, unknown>;
  quality: { classification: string; qualityScore: number; riskScore: number } | null;
  reviewStatus: string | null;
}

export interface ResponsePage {
  rows: ResponseRecord[];
  /** total matching the query (not just this page) */
  total: number;
  /** whether `total` was counted by the database alone */
  exact: boolean;
  filterNote?: string;
  limit: number;
  offset: number;
  columns: { name: string; label: string }[];
  environment: Environment;
}

/** Apply the prefilter clauses to a PostgREST query builder. */
function applyClauses<T>(q: T, clauses: PrefilterClause[]): T {
  let out = q as never as {
    filter(col: string, op: string, val: unknown): typeof out;
    contains(col: string, val: unknown): typeof out;
    gt(col: string, val: unknown): typeof out;
    gte(col: string, val: unknown): typeof out;
    lt(col: string, val: unknown): typeof out;
    lte(col: string, val: unknown): typeof out;
    ilike(col: string, val: string): typeof out;
  };
  for (const c of clauses) {
    if (c.kind === "jsonEq") out = out.contains(c.column, { [c.key]: c.value });
    else if (c.kind === "hasKey") out = out.filter(c.column, "cs", `{"${c.key}": null}`) as never; // widened below if unsupported
    else if (c.kind === "compare") out = out[c.op](`${c.column}->>${c.key}`, c.value);
    else if (c.kind === "ilike") out = out.ilike(`${c.column}->>${c.key}`, `%${c.value}%`);
  }
  return out as never as T;
}

/**
 * `hasKey` has no portable PostgREST spelling that is safe here (`?` is not
 * exposed), so it is dropped rather than guessed: dropping a narrowing clause
 * only widens the scan, and the engine still decides. Kept separate so the
 * intent is visible rather than silently missing.
 */
function narrowable(clauses: PrefilterClause[]): PrefilterClause[] {
  return clauses.filter((c) => c.kind !== "hasKey");
}

function baseQuery(db: SupabaseClient, q: ResponseQuery, columns: string, count: boolean) {
  let sel = db.from("responses").select(columns, count ? { count: "exact" } : undefined).eq("survey_id", q.surveyId);
  // ENVIRONMENT — the whole point of this module
  if (q.environment === "TEST") sel = sel.eq("is_test", true);
  else if (q.environment === "LIVE") sel = sel.eq("is_test", false);
  if (q.deleted) sel = sel.not("deleted_at", "is", null);
  else sel = sel.is("deleted_at", null);
  if (q.statuses?.length) sel = sel.in("status", q.statuses);
  if (q.from) sel = sel.gte("started_at", q.from);
  if (q.to) sel = sel.lte("started_at", q.to);
  return sel;
}

const CHUNK = 1000;

/** One page of the dataset, with the total that matches the whole query. */
export async function queryResponses(db: SupabaseClient, def: SurveyDefinition, q: ResponseQuery): Promise<ResponsePage> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  const sort = q.sort ?? { field: "started_at", dir: "desc" };
  const compiled = compileResponseFilter(def, q.filter ?? null);
  const clauses = narrowable(compiled.clauses);
  const needsEngine = !!q.filter && !(compiled.exact && clauses.length === compiled.clauses.length);
  const needsText = !!q.search?.trim();
  const columns = buildVariableDictionary(def).filter((v) => v.responseType !== "system").map((v) => ({ name: v.name, label: v.label ?? v.name }));

  // Fast path: the database can answer both the page and the count.
  if (!needsEngine && !needsText) {
    let sel = applyClauses(baseQuery(db, q, ROW_COLUMNS, true), clauses);
    const { data, error, count } = await sel.order(sort.field, { ascending: sort.dir === "asc", nullsFirst: false }).range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);
    return {
      rows: (data ?? []).map((r) => toRecord(def, r)),
      total: count ?? 0, exact: true, limit, offset, columns, environment: q.environment,
    };
  }

  // Two-stage: stream the narrowed set through the engine, keep only the page.
  const rows: ResponseRecord[] = [];
  let total = 0;
  for (let start = 0; ; start += CHUNK) {
    let sel = applyClauses(baseQuery(db, q, ROW_COLUMNS, false), clauses);
    const { data, error } = await sel.order(sort.field, { ascending: sort.dir === "asc", nullsFirst: false }).range(start, start + CHUNK - 1);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    for (const raw of chunk) {
      if (q.filter && !matchesResponseCondition(def, q.filter, raw as never)) continue;
      if (needsText && !responseMatchesText(def, raw as never, q.search!)) continue;
      total++;
      if (total > offset && rows.length < limit) rows.push(toRecord(def, raw));
    }
    if (chunk.length < CHUNK) break;
  }
  return { rows, total, exact: false, filterNote: compiled.reason, limit, offset, columns, environment: q.environment };
}

/** How many responses match — no rows returned, nothing loaded in the browser. */
export async function countResponses(db: SupabaseClient, def: SurveyDefinition, q: ResponseQuery): Promise<{ total: number; exact: boolean; note?: string }> {
  const compiled = compileResponseFilter(def, q.filter ?? null);
  const clauses = narrowable(compiled.clauses);
  const needsEngine = !!q.filter && !(compiled.exact && clauses.length === compiled.clauses.length);
  const needsText = !!q.search?.trim();
  if (!needsEngine && !needsText) {
    const { count, error } = await applyClauses(baseQuery(db, q, "id", true), clauses);
    if (error) throw new Error(error.message);
    return { total: count ?? 0, exact: true };
  }
  let total = 0;
  for (let start = 0; ; start += CHUNK) {
    const { data, error } = await applyClauses(baseQuery(db, q, FILTER_COLUMNS, false), clauses).order("started_at", { ascending: false }).range(start, start + CHUNK - 1);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    for (const raw of chunk) {
      if (q.filter && !matchesResponseCondition(def, q.filter, raw as never)) continue;
      if (needsText && !responseMatchesText(def, raw as never, q.search!)) continue;
      total++;
    }
    if (chunk.length < CHUNK) break;
  }
  return { total, exact: false, note: compiled.reason };
}

/**
 * The ids that match — for a condition-based bulk operation. Capped, because
 * a delete the researcher has not seen a count for should not be possible;
 * the caller shows the count first and the cap is a backstop.
 */
export async function matchingResponseIds(db: SupabaseClient, def: SurveyDefinition, q: ResponseQuery, cap = 50000): Promise<{ ids: string[]; codes: string[]; capped: boolean }> {
  const compiled = compileResponseFilter(def, q.filter ?? null);
  const clauses = narrowable(compiled.clauses);
  const needsText = !!q.search?.trim();
  const ids: string[] = [];
  const codes: string[] = [];
  for (let start = 0; ; start += CHUNK) {
    const { data, error } = await applyClauses(baseQuery(db, q, FILTER_COLUMNS, false), clauses).order("started_at", { ascending: false }).range(start, start + CHUNK - 1);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    for (const raw of chunk as any[]) {
      if (q.filter && !matchesResponseCondition(def, q.filter, raw)) continue;
      if (needsText && !responseMatchesText(def, raw, q.search!)) continue;
      if (ids.length >= cap) return { ids, codes, capped: true };
      ids.push(raw.id);
      codes.push(raw.respondent_code ?? raw.session_id);
    }
    if (chunk.length < CHUNK) break;
  }
  return { ids, codes, capped: false };
}

function toRecord(def: SurveyDefinition, r: any): ResponseRecord {
  return {
    id: r.id,
    respondentCode: r.respondent_code ?? null,
    sessionId: r.session_id,
    respondentId: r.respondent_id ?? null,
    status: r.status,
    environment: r.environment ?? (r.is_test ? "TEST" : "LIVE"),
    revision: typeof r.revision === "number" ? r.revision : 0,
    source: r.source ?? "runtime",
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
    updatedAt: r.updated_at ?? null,
    lastSavedAt: r.last_saved_at ?? null,
    deletedAt: r.deleted_at ?? null,
    deletedBy: r.deleted_by ?? null,
    deletionReason: r.deletion_reason ?? null,
    answers: r.answers ?? {},
    calculated: r.calculated ?? {},
    embedded: r.embedded ?? {},
    flags: Array.isArray(r.flags) ? r.flags : [],
    vars: flattenVariables(def, rowToState(def, r)),
    quality: r.quality ? { classification: r.quality.classification, qualityScore: r.quality.qualityScore, riskScore: r.quality.riskScore } : null,
    reviewStatus: r.review_status ?? null,
  };
}

/** Per-environment counts for the manager's header — one query, no rows. */
export async function responseCounts(db: SupabaseClient, surveyId: string): Promise<Record<string, { total: number; complete: number; in_progress: number; screened: number; quota_full: number; terminated: number; deleted: number }>> {
  const { data, error } = await db.from("responses").select("status, is_test, deleted_at").eq("survey_id", surveyId).limit(200000);
  if (error) throw new Error(error.message);
  const blank = () => ({ total: 0, complete: 0, in_progress: 0, screened: 0, quota_full: 0, terminated: 0, deleted: 0 });
  const out: Record<string, ReturnType<typeof blank>> = { TEST: blank(), LIVE: blank(), ALL: blank() };
  for (const r of data ?? []) {
    for (const bucket of [r.is_test ? "TEST" : "LIVE", "ALL"]) {
      const b = out[bucket];
      if (r.deleted_at) { b.deleted++; continue; }
      b.total++;
      if (r.status in b) (b as never as Record<string, number>)[r.status]++;
    }
  }
  return out;
}

/** Migration 0006 not applied → a readable message instead of a stack. */
export function missingResponseMigration(message: string | undefined): boolean {
  return !!message && /deleted_at|respondent_code|environment|revision|response_edits|rescript_(update_response|soft_delete|restore|purge|import)_?|does not exist|schema cache/i.test(message);
}

export const RESPONSE_MIGRATION_MESSAGE =
  "Response management needs supabase/migrations/0006_response_management.sql applied. Your responses are safe — the Data tab's read-only views keep working until then.";
