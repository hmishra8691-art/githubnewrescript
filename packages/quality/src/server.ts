import { createHash } from "node:crypto";
import { SurveyDefinition } from "@rescript/schema";
import type { HistoryRecord, PeerRecord, QualityAssessment, ResponseRecord } from "./types.js";
import { assess, assessSurvey, resolveConfig } from "./engine.js";

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

const PEER_COLUMNS = "session_id, respondent_id, status, answers, started_at, completed_at, ip_hash, device_hash, quality, review_status";

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
    system: row.quality?.system ?? null,
    classification: row.quality?.classification ?? null,
    reviewStatus: row.review_status ?? null,
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

/** Parse a survey definition row defensively. */
export function parseDefinition(json: unknown): SurveyDefinition | null {
  const p = SurveyDefinition.safeParse(json);
  return p.success ? p.data : null;
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
  const { data: ver } = await db.from("survey_versions").select("definition").eq("id", existing.version_id).single();
  const parsed = ver ? SurveyDefinition.safeParse(ver.definition) : null;
  return { def: parsed?.success ? parsed.data : null, source: "version", versionId: existing.version_id, revision: null, note };
}
