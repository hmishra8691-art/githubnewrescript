import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QualHistoryEntry, QualState } from "@rescript/analytics";
import { can } from "@rescript/access";
import type { ProjectContext } from "@/lib/guard";
import { missingQualMigration, QUAL_MIGRATION_MESSAGE, toWorkspace, type CodingRow, type EventRow, type SessionRow, type TranscriptRow, type QualWorkspace } from "./qualWorkspace";
import { qualRefusal, type QualOperation } from "./qualAccess";

/**
 * THE QUALITATIVE TABLES (migration 0065), read and written with the service
 * role behind the routes' guard. The rules live in `qualWorkspace.ts` (pure,
 * tested); this file only moves rows.
 *
 * The codebook and its excerpts are one row per survey, written with the
 * version the writer read: a second coder saving on top of a change they have
 * not seen is answered 409 and reloads, never overwritten silently.
 */

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/** the 403 for an operation's further capabilities (the guard checked the first) */
export function refuse(gate: ProjectContext, op: QualOperation): NextResponse | null {
  const r = qualRefusal(gate.grant, op);
  return r ? json(r, 403) : null;
}
export const hasPii = (gate: ProjectContext): boolean => can(gate.grant, "responses.read_pii");

export class QualStoreError extends Error { constructor(message: string, readonly status = 500, readonly code?: string) { super(message); } }
const check = <T>(r: { data: T | null; error: { message: string; code?: string } | null }, what: string): T => {
  if (r.error) {
    if (missingQualMigration(r.error.message)) throw new QualStoreError(QUAL_MIGRATION_MESSAGE, 503, "migration_required");
    throw new QualStoreError(`${what}: ${r.error.message}`);
  }
  return r.data as T;
};
/** a store error as the route's answer */
export function storeFailure(e: unknown): NextResponse {
  if (e instanceof QualStoreError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
  return json({ error: (e as Error).message ?? "the qualitative data could not be read" }, 500);
}

const SESSION_COLUMNS = "id, kind, title, scheduled_at, moderator, participants, consent, notes, observations, status, recording_media_id, created_at, updated_at";
const TRANSCRIPT_COLUMNS = "id, session_id, title, source, format, language, segments, speakers, status, error, char_count, media_id, meta, created_at";

export async function loadRows(db: SupabaseClient, surveyId: string): Promise<{ sessions: SessionRow[]; transcripts: TranscriptRow[]; coding: CodingRow | null; events: EventRow[] }> {
  const [s, t, c, e] = await Promise.all([
    db.from("qual_sessions").select(SESSION_COLUMNS).eq("survey_id", surveyId).order("scheduled_at", { ascending: true, nullsFirst: false }).order("created_at", { ascending: true }),
    db.from("qual_transcripts").select(TRANSCRIPT_COLUMNS).eq("survey_id", surveyId).order("created_at", { ascending: true }),
    db.from("qual_codings").select("codebook, excerpts, version, settings").eq("survey_id", surveyId).maybeSingle(),
    db.from("qual_events").select("id, actor, actor_label, action, detail, ids, created_at").eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(300),
  ]);
  return {
    sessions: check(s, "sessions") as SessionRow[],
    transcripts: check(t, "transcripts") as TranscriptRow[],
    coding: check(c, "coding") as CodingRow | null,
    events: ((check(e, "history") as EventRow[]) ?? []).reverse(),
  };
}

export async function loadWorkspace(db: SupabaseClient, gate: ProjectContext): Promise<QualWorkspace> {
  return toWorkspace(await loadRows(db, gate.surveyId), { pii: hasPii(gate) });
}

export async function loadSettings(db: SupabaseClient, surveyId: string): Promise<{ redactNames: string[] }> {
  const r = await db.from("qual_codings").select("settings").eq("survey_id", surveyId).maybeSingle();
  const row = check(r, "settings") as { settings?: { redactNames?: unknown } } | null;
  const names = Array.isArray(row?.settings?.redactNames) ? (row!.settings!.redactNames as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { redactNames: names };
}

/** write the codebook and excerpts if nobody else has since `expected`; the new version, or null on a conflict */
export async function saveCoding(db: SupabaseClient, surveyId: string, state: QualState, expected: number, userId: string): Promise<number | null> {
  const next = expected + 1;
  const now = new Date().toISOString();
  if (expected === 0) {
    const existing = check(await db.from("qual_codings").select("version").eq("survey_id", surveyId).maybeSingle(), "coding") as { version: number } | null;
    if (!existing) {
      const ins = await db.from("qual_codings").insert({ survey_id: surveyId, codebook: state.codebook, excerpts: state.excerpts, version: next, updated_by: userId, updated_at: now });
      if (ins.error) { if (/duplicate key|unique/i.test(ins.error.message)) return null; check(ins, "coding"); }
      return next;
    }
    if (existing.version !== 0) return null;
  }
  const up = await db.from("qual_codings").update({ codebook: state.codebook, excerpts: state.excerpts, version: next, updated_by: userId, updated_at: now }).eq("survey_id", surveyId).eq("version", expected).select("version");
  const rows = check(up, "coding") as { version: number }[] | null;
  return rows && rows.length ? next : null;
}

export async function saveSettings(db: SupabaseClient, surveyId: string, patch: { redactNames: string[]; autoCode?: unknown }, userId: string): Promise<void> {
  const existing = check(await db.from("qual_codings").select("survey_id, settings").eq("survey_id", surveyId).maybeSingle(), "settings") as { settings?: unknown } | null;
  /* F2 2026-10-22: the settings object also carries `autoCode` — a write MERGES what it names, never drops the rest */
  const settings = { ...(existing?.settings && typeof existing.settings === "object" ? existing.settings as Record<string, unknown> : {}), ...patch };
  if (existing) check(await db.from("qual_codings").update({ settings, updated_by: userId }).eq("survey_id", surveyId).select("survey_id"), "settings");
  else check(await db.from("qual_codings").insert({ survey_id: surveyId, settings, updated_by: userId }).select("survey_id"), "settings");
}

/** append to the history; a failed write is logged, never fails the action it describes */
export async function recordEvents(db: SupabaseClient, gate: ProjectContext, entries: Omit<QualHistoryEntry, "at">[]): Promise<void> {
  if (!entries.length) return;
  const label = gate.user.fullName || gate.user.email || gate.user.userId;
  const r = await db.from("qual_events").insert(entries.map((e) => ({ survey_id: gate.surveyId, actor: e.actor === "ai" ? null : gate.user.userId, actor_label: e.actor === "ai" ? "AI (suggested)" : label, action: e.action.slice(0, 60), detail: e.detail.slice(0, 4000), ids: e.ids })));
  if (r.error) console.warn("[rescript:qual] history not recorded", JSON.stringify({ survey: gate.surveyId, error: r.error.message }));
}

export async function transcriptRow(db: SupabaseClient, surveyId: string, id: string): Promise<TranscriptRow | null> {
  return check(await db.from("qual_transcripts").select(TRANSCRIPT_COLUMNS).eq("survey_id", surveyId).eq("id", id).maybeSingle(), "transcript") as TranscriptRow | null;
}
export async function sessionRow(db: SupabaseClient, surveyId: string, id: string): Promise<SessionRow | null> {
  return check(await db.from("qual_sessions").select(SESSION_COLUMNS).eq("survey_id", surveyId).eq("id", id).maybeSingle(), "session") as SessionRow | null;
}
export { check as checkRow };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
