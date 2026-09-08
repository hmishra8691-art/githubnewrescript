import { createHash } from "node:crypto";
import { SurveyDefinition } from "@rescript/schema";
import type { HistoryRecord, PeerRecord, QualityAssessment, ResponseRecord } from "./types.js";
import { assess, assessSurvey, resolveConfig } from "./engine.js";
import { ensureElementIds } from "@rescript/engine";

/**
 * Server-side glue between the engine and the `responses` table. Both the
 * runtime (on completion) and the Studio (recompute, dashboard) use this, so
 * the two never disagree about what a peer is or what gets stored.
 *
 * `db` is a Supabase client (service role). It is typed loosely on purpose:
 * this package has no Supabase dependency, and the calls are the plain
 * `.from().select()` chain.
 */

export const RESPONSE_COLUMNS =
  "id, session_id, respondent_id, status, is_test, answers, calculated, embedded, flags, started_at, completed_at, telemetry, ip_hash, device_hash, quality, review_status, review_reason, reviewed_by, reviewed_at";

/*
 * Only `system` out of `quality` ever gets read (by `sharedSignals` in
 * similarity.ts, for matrix/open-end/timing fingerprints) — never
 * `classification`, never the flags/categories/cluster/reasons/benchmarks
 * that make up the rest of a stored assessment. Fetching the whole blob for
 * up to `maxPeers` (3000 by default) rows on every completed interview was
 * the single largest egress line item in the platform: every completion
 * pulled several KB of flag text and score breakdowns per peer that nothing
 * downstream ever looked at. `quality->system` projects just that sub-object
 * at the database layer, and `review_status` is dropped outright — no rule
 * or scoring path reads `PeerRecord.reviewStatus` either.
 */
const PEER_COLUMNS = "session_id, respondent_id, status, answers, started_at, completed_at, ip_hash, device_hash, system:quality->system";

/** sha256(salt + value) — comparable, not reversible. */
export function hashIdentifier(salt: string, value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash("sha256").update(`${salt}|${value}`).digest("hex").slice(0, 32);
}

/** The first hop of x-forwarded-for, or x-real-ip. */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || null;
  return headers.get("x-real-ip") ?? headers.get("cf-connecting-ip") ?? null;
}

/** The device hash uses only coarse characteristics — never the full UA string. */
export function deviceHashFrom(salt: string, d: { browser?: string; os?: string; screen?: string; timezone?: string; language?: string; dpr?: number; platform?: string } | null | undefined): string | null {
  if (!d) return null;
  return hashIdentifier(salt, [d.browser, d.os, d.screen, d.timezone, d.language, d.dpr, d.platform].map((x) => x ?? "").join("|"));
}

export function rowToResponse(row: any): ResponseRecord {
  return {
    sessionId: row.session_id,
    respondentId: row.respondent_id ?? null,
    externalId: row.external_id ?? null,
    status: row.status,
    isTest: !!row.is_test,
    answers: row.answers ?? {},
    embedded: row.embedded ?? {},
    calculated: row.calculated ?? {},
    flags: row.flags ?? [],
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    telemetry: row.telemetry ?? null,
    ipHash: row.ip_hash ?? null,
    deviceHash: row.device_hash ?? null,
    userAgent: row.user_agent ?? null,
  };
}

export function rowToPeer(row: any): PeerRecord {
  return {
    sessionId: row.session_id,
    respondentId: row.respondent_id ?? null,
    status: row.status,
    answers: row.answers ?? {},
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    ipHash: row.ip_hash ?? null,
    deviceHash: row.device_hash ?? null,
    // `row.system` is the projected `quality->system` column; `row.quality?.system`
    // is a defensive fallback in case a caller ever hands this a full,
    // unprojected row (e.g. a future direct `.select("*")`) — cheap insurance,
    // never the expected path for `loadPeers`.
    system: row.system ?? row.quality?.system ?? null,
  };
}

/**
 * Peers for one assessment: the newest finished responses of the same survey
 * and mode (test vs live never mix), excluding the response itself. Screened
 * and terminated sessions are included — screener-gaming rules need them.
 */
export async function loadPeers(db: any, surveyId: string, isTest: boolean, excludeSessionId: string, maxPeers: number): Promise<PeerRecord[]> {
  const { data, error } = await db
    .from("responses")
    .select(PEER_COLUMNS)
    .eq("survey_id", surveyId)
    .eq("is_test", isTest)
    .neq("status", "in_progress")
    .neq("session_id", excludeSessionId)
    .order("started_at", { ascending: false })
    .limit(maxPeers);
  if (error) throw new Error(`loadPeers: ${error.message}`);
  return (data ?? []).map(rowToPeer);
}

/** Prior assessments of the same external respondent in other surveys (longitudinal, opt-in). */
export async function loadHistory(db: any, respondentId: string | null | undefined, surveyId: string): Promise<HistoryRecord[]> {
  if (!respondentId) return [];
  const { data: me } = await db.from("respondents").select("external_id, survey_id").eq("id", respondentId).maybeSingle();
  if (!me?.external_id) return [];
  const { data: siblings } = await db.from("respondents").select("id, survey_id").eq("external_id", me.external_id).neq("survey_id", surveyId).limit(50);
  const ids = (siblings ?? []).map((s: any) => s.id);
  if (!ids.length) return [];
  const { data } = await db.from("responses").select("survey_id, completed_at, quality").in("respondent_id", ids).not("quality", "is", null).limit(50);
  return (data ?? [])
    .filter((r: any) => r.quality?.classification)
    .map((r: any) => ({
      surveyId: r.survey_id, completedAt: r.completed_at,
      qualityScore: r.quality.qualityScore, riskScore: r.quality.riskScore,
      classification: r.quality.classification, categories: r.quality.categories ?? {},
    }));
}

/** Assess one stored response against its peers and write the assessment back. */
export async function assessAndStore(db: any, def: SurveyDefinition, row: any): Promise<QualityAssessment> {
  const config = resolveConfig(def);
  const response = rowToResponse(row);
  const peers = await loadPeers(db, row.survey_id, !!row.is_test, row.session_id, config.maxPeers);
  const history = config.privacy.longitudinal ? await loadHistory(db, row.respondent_id, row.survey_id) : [];
  const a = assess({ def, response, peers, history });
  await db.from("responses").update({ quality: a, quality_computed_at: a.computedAt }).eq("id", row.id);
  return a;
}

/**
 * Recompute every finished response of a survey (after settings change, or
 * to backfill), with final cluster ids. Returns counts by classification.
 */
export async function recomputeSurvey(db: any, def: SurveyDefinition, surveyId: string, isTest: boolean): Promise<{ assessed: number; byClass: Record<string, number> }> {
  const config = resolveConfig(def);
  const { data, error } = await db
    .from("responses")
    .select(RESPONSE_COLUMNS + ", survey_id")
    .eq("survey_id", surveyId)
    .eq("is_test", isTest)
    .neq("status", "in_progress")
    .order("started_at", { ascending: false })
    .limit(Math.max(config.maxPeers, 50));
  if (error) throw new Error(`recomputeSurvey: ${error.message}`);
  const rows = (data ?? []) as any[];
  const responses = rows.map(rowToResponse);
  const history = new Map<string, HistoryRecord[]>();
  const sa = assessSurvey(def, responses, history);
  const byClass: Record<string, number> = {};
  // write in batches of 50
  const entries = [...sa.bySession.entries()];
  for (let i = 0; i < entries.length; i += 50) {
    await Promise.all(entries.slice(i, i + 50).map(([sid, a]) => {
      byClass[a.classification] = (byClass[a.classification] ?? 0) + 1;
      return db.from("responses").update({ quality: a, quality_computed_at: a.computedAt }).eq("session_id", sid);
    }));
  }
  return { assessed: entries.length, byClass };
}

/**
 * Parse a survey definition row defensively.
 *
 * Element ids are filled in here too (§31–49), deterministically, so a
 * definition read out of a frozen published version presents the same ids the
 * editor and the runtime see. Every read path has to agree, or an id in a
 * saved analysis resolves in one place and not another.
 */
export function parseDefinition(json: unknown): SurveyDefinition | null {
  const p = SurveyDefinition.safeParse(json);
  return p.success ? ensureElementIds(p.data).def : null;
}

/* --------------------------------------------------- the immutable version cache */

/**
 * A published version's `definition` can never change again once cut — a
 * database trigger (`survey_versions_immutable`, migration 0012) enforces it.
 * That makes a version's parsed definition safe to hold in memory for the
 * life of the process: there is no invalidation to get wrong, because there
 * is nothing to invalidate.
 *
 * Before this cache, `resolveRunDefinition` re-fetched and re-validated the
 * whole survey JSON from Postgres on EVERY save of a live session — every
 * "Next" click, for the entire survey — just to read a handful of quality
 * config flags. A 100-page survey saved a hundred times over meant a hundred
 * multi-hundred-KB reads and a hundred full Zod parses, for content that
 * cannot have changed since the first read. `loadDeployment` /
 * `loadTestBuild` in the runtime (session start, on every page load) hit the
 * same version for the same reason and are the other callers.
 *
 * Only the immutable VERSION path is cached here. A test session's autosaved
 * DRAFT is deliberately never cached — it changes on every autosave, and
 * "the latest saved state" is the whole point of a test link.
 */
const VERSION_CACHE_LIMIT = 300;
const versionDefinitionCache = new Map<string, SurveyDefinition>();

function cacheGet(versionId: string): SurveyDefinition | undefined {
  const hit = versionDefinitionCache.get(versionId);
  if (hit) {
    // touch for a simple recency order — Map preserves insertion order, so
    // delete+re-set moves this key to the "most recently used" end
    versionDefinitionCache.delete(versionId);
    versionDefinitionCache.set(versionId, hit);
  }
  return hit;
}

function cacheSet(versionId: string, def: SurveyDefinition): void {
  versionDefinitionCache.set(versionId, def);
  if (versionDefinitionCache.size > VERSION_CACHE_LIMIT) {
    const oldest = versionDefinitionCache.keys().next().value;
    if (oldest !== undefined) versionDefinitionCache.delete(oldest);
  }
}

/**
 * Load and parse one published version's definition, from memory when this
 * process has already resolved that `versionId`. Returns null on a missing
 * row or a definition that fails schema validation — exactly what callers
 * already treated a failed fetch as: assessment/telemetry config unavailable,
 * the response's answers still save regardless.
 *
 * The returned object is shared across every caller that asks for the same
 * `versionId` in this process. Nothing on the read path (quota checks,
 * quality assessment, sample-source resolution, rendering) mutates a
 * definition in place — every one of those is a pure read — so sharing the
 * reference is safe and is the whole point: it is what avoids re-parsing.
 */
export async function getCachedVersionDefinition(db: any, versionId: string): Promise<SurveyDefinition | null> {
  const cached = cacheGet(versionId);
  if (cached) return cached;
  const { data: ver } = await db.from("survey_versions").select("definition").eq("id", versionId).single();
  if (!ver) return null;
  const parsed = SurveyDefinition.safeParse(ver.definition);
  if (!parsed.success) return null;
  const def = ensureElementIds(parsed.data).def;
  cacheSet(versionId, def);
  return def;
}

/** Test-only escape hatch — a suite that reuses a versionId across cases needs a clean slate. */
export function __clearVersionDefinitionCacheForTests(): void {
  versionDefinitionCache.clear();
}

/* ------------------------------------------------------------ which definition ran */

/** The runner's description of the build a TEST session is running (see runtime `TestBuildInfo`). */
export interface RunBuildHint { source?: unknown; versionId?: unknown; revision?: unknown }

export interface ResolvedRunDefinition {
  def: SurveyDefinition | null;
  /** where the definition came from */
  source: "draft" | "version";
  /** the version the response row is recorded against */
  versionId: string;
  /** the survey row's revision when the draft was used */
  revision: number | null;
  /** why the version was used although a draft exists (diagnostics) */
  note?: string;
}

/**
 * Which definition is a session running — the one its quality assessment
 * (and its telemetry switches) must come from.
 *
 * A LIVE session runs the version its deployment pinned; the response row
 * records that version, so it is loaded.
 *
 * A TEST session runs the latest saved state (`decideTestBuild`): the
 * autosaved DRAFT whenever one exists, though the row can only record the
 * draft's base version. Grading it with that version's settings meant the
 * tester ran the draft's questionnaire while the engine used the previous
 * version's quality settings — a check switched on in the draft never fired,
 * and if the version had quality off nothing was assessed at all. So a test
 * session resolves the way the link did: the requested version when the
 * runner says one was asked for (`?v=`), otherwise the draft, otherwise the
 * version on the row. The hint only chooses between the survey's own stored
 * definitions; a draft that does not parse falls back to the version and says so.
 */
export async function resolveRunDefinition(
  db: any,
  existing: { survey_id: string; version_id: string; is_test: boolean },
  hint: RunBuildHint | null | undefined,
): Promise<ResolvedRunDefinition> {
  const requested = hint && typeof hint === "object" && hint.source === "requested";
  let note: string | undefined;
  if (existing.is_test && !requested) {
    const { data: survey } = await db.from("surveys").select("draft_definition, revision").eq("id", existing.survey_id).maybeSingle();
    if (survey?.draft_definition) {
      const parsed = SurveyDefinition.safeParse(survey.draft_definition);
      if (parsed.success) return { def: parsed.data, source: "draft", versionId: existing.version_id, revision: typeof survey.revision === "number" ? survey.revision : null };
      note = `draft does not parse: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    }
  } else if (existing.is_test && requested) {
    note = "a specific version was requested with ?v=";
  }
  const def = await getCachedVersionDefinition(db, existing.version_id);
  return { def, source: "version", versionId: existing.version_id, revision: null, note };
}
