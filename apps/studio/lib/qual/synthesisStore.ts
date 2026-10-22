import "server-only";
import type { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiProviderName, completeJson, fenceNonceFor } from "@rescript/ai";
import { supabaseGroupStore, type GroupStore, type GroupRow, type GroupSession, type CodingAssignment, type CoderSet, type HighlightReel, type QualJob } from "@rescript/analytics";
import type { AuthedUser } from "@/lib/guard";
import { aiReadyFor } from "@/lib/byok/connect";
import { billingProjectFor, meteredAi, refusalResponse } from "@/lib/metering";
import { checkRow, json, QualStoreError } from "./qualStore";
import type { SynthesisRow } from "./synthesisWorkspace";

/**
 * THE 0070 TABLES, read and written with the service role behind the routes'
 * guard (the rules are in `synthesisWorkspace.ts` and `@rescript/analytics`; this
 * file moves rows), and THE MODEL RUNNER every synthesis route uses: the AI
 * readiness check, the project's meter (one metered AI_REQUEST per call), the
 * keyed fence nonce, the fake provider's stand-in — one place, so every call is
 * metered and fenced the same way.
 */

/** a 0070 table missing says so (not the 0065 message); anything else as qualStore's check */
function chk<T>(r: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (r.error && missingSynthesisMigration(r.error.message)) throw new QualStoreError(SYNTHESIS_MIGRATION_MESSAGE, 503, "migration_required");
  return checkRow(r, what);
}

/* ------------------------------------------------------------ the model */

export interface ModelCall { system: string; prompt: (nonce: string) => string; maxTokens: number; schema: Record<string, unknown>; schemaName: string; fake: () => unknown; seed: string }
export interface ModelRunner { fake: boolean; calls: number; run(c: ModelCall): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> }

/** a runner for this request, or the response that says why there is none (no provider, a refused wallet) */
export async function modelRunner(user: AuthedUser | null, surveyId: string, operation: string, capability: "analytics.edit" | "responses.manage" = "analytics.edit", scripted?: unknown[] | null): Promise<ModelRunner | { response: NextResponse }> {
  if (!(await aiReadyFor(user, surveyId, operation))) return { response: json({ error: "No AI provider is configured for this project, so this cannot be written by AI. The coded data, counts and quotes are all still available.", code: "ai_unconfigured" }, 503) };
  const billing = await billingProjectFor(user, surveyId, capability);
  if ("response" in billing) return { response: billing.response };
  const fake = aiProviderName() === "fake";
  const started = Date.now();
  let i = 0;
  const runner: ModelRunner = {
    fake, calls: 0,
    async run(c) {
      const nonce = fenceNonceFor(`${surveyId}\u0000${user?.userId ?? "sandbox"}\u0000${operation}\u0000${c.seed}`);
      const prompt = c.prompt(nonce);
      const k = i++;
      const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: c.system + prompt, maxTokens: c.maxTokens, operation }, async () =>
        fake ? (scripted?.[k] ?? c.fake()) : completeJson(c.system, prompt, c.maxTokens, { schema: { name: c.schemaName, schema: c.schema }, timeoutMs: 90_000, operation, deadline: started + 280_000 }));
      if (!m.ok) return { ok: false, response: refusalResponse(m) };
      runner.calls++;
      return { ok: true, value: m.value };
    },
  };
  return runner;
}

/* ------------------------------------------------------------ syntheses */

export async function synthesisRows(db: SupabaseClient, surveyId: string): Promise<SynthesisRow[]> {
  return (chk(await db.from("qual_syntheses").select("id, kind, target, version, status, content, fingerprint, provider, created_by, created_at").eq("survey_id", surveyId).order("version", { ascending: false }).limit(2000), "syntheses") as SynthesisRow[]) ?? [];
}
export async function latestVersion(db: SupabaseClient, surveyId: string, kind: string, target: string): Promise<number> {
  const r = chk(await db.from("qual_syntheses").select("version").eq("survey_id", surveyId).eq("kind", kind).eq("target", target).order("version", { ascending: false }).limit(1).maybeSingle(), "syntheses") as { version: number } | null;
  return r?.version ?? 0;
}
/** insert the next version; null when another write took that version first */
export async function insertSynthesis(db: SupabaseClient, surveyId: string, r: { kind: "theme" | "insights"; target: string; version: number; status: "ai" | "edited"; content: unknown; fingerprint: string; provider?: string; userId: string }): Promise<number | null> {
  const ins = await db.from("qual_syntheses").insert({ survey_id: surveyId, kind: r.kind, target: r.target, version: r.version, status: r.status, content: r.content, fingerprint: r.fingerprint, provider: r.provider ?? null, created_by: r.userId });
  if (ins.error) { if (/duplicate key|unique/i.test(ins.error.message)) return null; chk(ins, "synthesis"); }
  return r.version;
}

/* ------------------------------------------------------------ jobs */

interface JobRow { id: string; kind: QualJob["kind"]; key: string; status: QualJob["status"]; source_ids: string[]; settings: Record<string, unknown>; progress: Record<string, unknown>; cursor: Record<string, unknown>; error: string | null; lease_until: string | null; created_at: string; updated_at: string }
const JOB_COLUMNS = "id, kind, key, status, source_ids, settings, progress, cursor, error, lease_until, created_at, updated_at";
export const jobView = (r: JobRow): QualJob & { settings: Record<string, unknown> } => ({ id: r.id, kind: r.kind, key: r.key, status: r.status, sourceIds: r.source_ids ?? [], progress: r.progress ?? {}, cursor: r.cursor ?? {}, error: r.error, leaseUntil: r.lease_until, createdAt: r.created_at, updatedAt: r.updated_at, settings: r.settings ?? {} });

export async function listJobs(db: SupabaseClient, surveyId: string, limit = 50) {
  return ((chk(await db.from("qual_jobs").select(JOB_COLUMNS).eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(limit), "jobs") as JobRow[]) ?? []).map(jobView);
}
export async function jobByKey(db: SupabaseClient, surveyId: string, key: string) {
  const r = chk(await db.from("qual_jobs").select(JOB_COLUMNS).eq("survey_id", surveyId).eq("key", key).maybeSingle(), "job") as JobRow | null;
  return r ? jobView(r) : null;
}
/** create a job, or return the one with that key (idempotent) */
export async function ensureJob(db: SupabaseClient, surveyId: string, j: { kind: QualJob["kind"]; key: string; sourceIds: string[]; settings?: Record<string, unknown>; userId: string | null }) {
  const ins = await db.from("qual_jobs").insert({ survey_id: surveyId, kind: j.kind, key: j.key, source_ids: j.sourceIds, settings: j.settings ?? {}, created_by: j.userId }).select(JOB_COLUMNS).single();
  if (ins.error) { if (/duplicate key|unique/i.test(ins.error.message)) return { job: (await jobByKey(db, surveyId, j.key))!, created: false }; chk(ins, "job"); }
  return { job: jobView(ins.data as JobRow), created: true };
}
/** take the job's lease (null when someone else holds it) */
export async function claimJob(db: SupabaseClient, surveyId: string, id: string, seconds = 280) {
  const now = new Date();
  const r = await db.from("qual_jobs").update({ lease_until: new Date(now.getTime() + seconds * 1000).toISOString(), status: "running" }).eq("survey_id", surveyId).eq("id", id).in("status", ["queued", "running"]).or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`).select(JOB_COLUMNS);
  const rows = chk(r, "job") as JobRow[] | null;
  return rows?.length ? jobView(rows[0]) : null;
}
export async function saveJob(db: SupabaseClient, surveyId: string, id: string, patch: { status?: QualJob["status"]; progress?: unknown; cursor?: unknown; error?: string | null; release?: boolean; finished?: boolean }) {
  chk(await db.from("qual_jobs").update({ ...(patch.status ? { status: patch.status } : {}), ...(patch.progress !== undefined ? { progress: patch.progress } : {}), ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}), ...(patch.error !== undefined ? { error: patch.error } : {}), ...(patch.release ? { lease_until: null } : {}), ...(patch.finished ? { finished_at: new Date().toISOString() } : {}) }).eq("survey_id", surveyId).eq("id", id).select("id"), "job");
}

/* ------------------------------------------------------------ double-coding */

interface AssignmentRow { id: string; name: string; coder_a: string; coder_b: string; units: string[]; overlap_pct: number; seed: number; code_ids: string[]; status: CodingAssignment["status"]; submitted: Record<string, string>; resolutions: CodingAssignment["resolutions"]; version: number; created_by: string | null; created_at: string }
const ASSIGN_COLUMNS = "id, name, coder_a, coder_b, units, overlap_pct, seed, code_ids, status, submitted, resolutions, version, created_by, created_at";
export const assignmentOf = (r: AssignmentRow): CodingAssignment & { version: number } => ({ id: r.id, name: r.name, coderA: r.coder_a, coderB: r.coder_b, units: r.units ?? [], overlapPct: r.overlap_pct, seed: Number(r.seed), codeIds: r.code_ids ?? [], status: r.status, submitted: r.submitted ?? {}, resolutions: r.resolutions ?? [], createdBy: r.created_by ?? "", createdAt: r.created_at, version: r.version });

export async function listAssignments(db: SupabaseClient, surveyId: string) {
  return ((chk(await db.from("qual_coding_assignments").select(ASSIGN_COLUMNS).eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(50), "assignments") as AssignmentRow[]) ?? []).map(assignmentOf);
}
export async function getAssignment(db: SupabaseClient, surveyId: string, id: string) {
  const r = chk(await db.from("qual_coding_assignments").select(ASSIGN_COLUMNS).eq("survey_id", surveyId).eq("id", id).maybeSingle(), "assignment") as AssignmentRow | null;
  return r ? assignmentOf(r) : null;
}
export async function insertAssignment(db: SupabaseClient, surveyId: string, a: CodingAssignment, userId: string): Promise<string> {
  const r = chk(await db.from("qual_coding_assignments").insert({ survey_id: surveyId, name: a.name, coder_a: a.coderA, coder_b: a.coderB, units: a.units, overlap_pct: a.overlapPct, seed: a.seed, code_ids: a.codeIds, status: a.status, created_by: userId }).select("id").single(), "assignment") as { id: string };
  chk(await db.from("qual_assignment_codings").insert([{ assignment_id: r.id, survey_id: surveyId, coder: a.coderA }, { assignment_id: r.id, survey_id: surveyId, coder: a.coderB }]).select("coder"), "assignment codings");
  return r.id;
}
/** compare-and-set on the version; false on a conflict */
export async function saveAssignment(db: SupabaseClient, surveyId: string, a: CodingAssignment, expected: number): Promise<boolean> {
  const r = chk(await db.from("qual_coding_assignments").update({ status: a.status, submitted: a.submitted, resolutions: a.resolutions, version: expected + 1 }).eq("survey_id", surveyId).eq("id", a.id).eq("version", expected).select("id"), "assignment") as unknown[] | null;
  return !!r?.length;
}
export async function coderSets(db: SupabaseClient, surveyId: string, assignmentId: string): Promise<(CoderSet & { version: number })[]> {
  return ((chk(await db.from("qual_assignment_codings").select("coder, excerpts, version").eq("survey_id", surveyId).eq("assignment_id", assignmentId), "assignment codings") as { coder: string; excerpts: CoderSet["excerpts"]; version: number }[]) ?? []).map((r) => ({ coder: r.coder, excerpts: r.excerpts ?? [], version: r.version }));
}
export async function saveCoderSet(db: SupabaseClient, surveyId: string, assignmentId: string, set: CoderSet, expected: number): Promise<boolean> {
  const r = chk(await db.from("qual_assignment_codings").update({ excerpts: set.excerpts, version: expected + 1, updated_at: new Date().toISOString() }).eq("survey_id", surveyId).eq("assignment_id", assignmentId).eq("coder", set.coder).eq("version", expected).select("coder"), "assignment codings") as unknown[] | null;
  return !!r?.length;
}

/* ------------------------------------------------------------ highlights */

interface ReelRow { id: string; name: string; description: string | null; items: HighlightReel["items"]; version: number; created_by: string | null; created_at: string; updated_at: string }
export const reelOf = (r: ReelRow): HighlightReel => ({ id: r.id, name: r.name, ...(r.description ? { description: r.description } : {}), items: r.items ?? [], version: r.version, createdBy: r.created_by ?? "", createdAt: r.created_at, updatedAt: r.updated_at });
export async function listReels(db: SupabaseClient, surveyId: string) {
  return ((chk(await db.from("qual_highlights").select("id, name, description, items, version, created_by, created_at, updated_at").eq("survey_id", surveyId).order("created_at", { ascending: true }), "highlights") as ReelRow[]) ?? []).map(reelOf);
}
export async function insertReel(db: SupabaseClient, surveyId: string, r: { name: string; description?: string; items: HighlightReel["items"] }, userId: string): Promise<string> {
  return (chk(await db.from("qual_highlights").insert({ survey_id: surveyId, name: r.name, description: r.description ?? null, items: r.items, created_by: userId }).select("id").single(), "highlight") as { id: string }).id;
}
export async function saveReel(db: SupabaseClient, surveyId: string, r: HighlightReel, expected: number): Promise<boolean> {
  const x = chk(await db.from("qual_highlights").update({ name: r.name, description: r.description ?? null, items: r.items, version: expected + 1 }).eq("survey_id", surveyId).eq("id", r.id).eq("version", expected).select("id"), "highlight") as unknown[] | null;
  return !!x?.length;
}

/* ------------------------------------------------------------ group sessions: the DB store */

interface GroupDbRow { id: string; survey_id: string; join_code: string; status: string; state: GroupSession; version: number; transcript_id?: string | null; qual_session_id?: string | null; lease_until?: string | null; created_at?: string }
const toGroupRow = (r: GroupDbRow): GroupRow & { transcriptId?: string | null; createdAt?: string } => ({ id: r.id, surveyId: r.survey_id, joinCode: r.join_code, status: r.status, state: r.state, version: r.version, transcriptId: r.transcript_id ?? null, createdAt: r.created_at });
const GROUP_COLUMNS = "id, survey_id, join_code, status, state, version, transcript_id, qual_session_id, lease_until, created_at";

export async function listGroups(db: SupabaseClient, surveyId: string) {
  return ((chk(await db.from("qual_group_sessions").select(GROUP_COLUMNS).eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(100), "group sessions") as GroupDbRow[]) ?? []).map(toGroupRow);
}
export async function getGroup(db: SupabaseClient, surveyId: string, id: string) {
  const r = chk(await db.from("qual_group_sessions").select(GROUP_COLUMNS).eq("survey_id", surveyId).eq("id", id).maybeSingle(), "group session") as GroupDbRow | null;
  return r ? toGroupRow(r) : null;
}
export async function insertGroup(db: SupabaseClient, surveyId: string, g: { title: string; joinCode: string; state: GroupSession }, userId: string): Promise<string> {
  return (chk(await db.from("qual_group_sessions").insert({ survey_id: surveyId, title: g.title, join_code: g.joinCode, status: g.state.status, state: g.state, created_by: userId }).select("id").single(), "group session") as { id: string }).id;
}
export async function claimGroupLease(db: SupabaseClient, surveyId: string, id: string, seconds = 120): Promise<boolean> {
  const now = new Date();
  const r = chk(await db.from("qual_group_sessions").update({ lease_until: new Date(now.getTime() + seconds * 1000).toISOString() }).eq("survey_id", surveyId).eq("id", id).or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`).select("id"), "group session") as unknown[] | null;
  return !!r?.length;
}
export async function releaseGroupLease(db: SupabaseClient, surveyId: string, id: string): Promise<void> {
  await db.from("qual_group_sessions").update({ lease_until: null }).eq("survey_id", surveyId).eq("id", id);
}
export async function linkGroup(db: SupabaseClient, surveyId: string, id: string, transcriptId: string, qualSessionId: string): Promise<void> {
  chk(await db.from("qual_group_sessions").update({ transcript_id: transcriptId, qual_session_id: qualSessionId }).eq("survey_id", surveyId).eq("id", id).select("id"), "group session");
}
export async function setParticipantSegment(db: SupabaseClient, surveyId: string, groupId: string, participantId: string, segment: string | null): Promise<boolean> {
  const r = chk(await db.from("qual_group_participants").update({ segment }).eq("survey_id", surveyId).eq("group_session_id", groupId).eq("id", participantId).select("id"), "participant") as unknown[] | null;
  return !!r?.length;
}

/** the GroupStore over Supabase — the same one the runtime uses for participants (`@rescript/analytics` qual/groupStoreDb.ts) */
export const dbGroupStore = (db: SupabaseClient, surveyId: string | null): GroupStore => supabaseGroupStore(db as never, { surveyId });

/** an error from a database without migration 0070 */
export const missingSynthesisMigration = (message: string | undefined): boolean => /qual_(?:syntheses|jobs|coding_assignments|assignment_codings|highlights|transcript_revisions|group_\w+)|column .*revision/i.test(message ?? "") && /does not exist|schema cache/i.test(message ?? "");
export const SYNTHESIS_MIGRATION_MESSAGE = "AI synthesis, double-coding, highlights, transcript correction and group sessions need database migration 0070. Ask an administrator to apply it; coding and the report still work.";
