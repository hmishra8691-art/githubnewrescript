import type { GroupStore, GroupRow } from "./groupService.js";
import type { GroupSession, GroupParticipant, GroupAnswer, GroupVote } from "./groups.js";

/**
 * THE GROUP-SESSION STORE OVER SUPABASE (migration 0070), shared by the Studio
 * (moderator routes) and the runtime (participant routes) so both read and
 * write the same rows the same way. The client is injected (the caller's
 * service-role client); this file holds no credentials and opens no connection.
 * A participant's token is never stored — only its hash, and that hash is never
 * selected back out.
 */

/* the slice of the supabase-js query builder used here, typed loosely so the package does not depend on it */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;
export interface MinimalSupabase { from(table: string): Q }
type Res<T> = { data: T | null; error: { message: string } | null };

const ok = <T>(r: Res<T>, what: string): T => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data as T; };
const dup = (r: Res<unknown>) => !!r.error && /duplicate key|unique/i.test(r.error.message);

interface GroupDbRow { id: string; survey_id: string; join_code: string; status: string; state: GroupSession; version: number; transcript_id?: string | null; created_at?: string }
export const GROUP_COLUMNS = "id, survey_id, join_code, status, state, version, transcript_id, qual_session_id, lease_until, created_at";
export const toGroupRow = (r: GroupDbRow): GroupRow & { transcriptId?: string | null; createdAt?: string } => ({ id: r.id, surveyId: r.survey_id, joinCode: r.join_code, status: r.status, state: r.state, version: r.version, transcriptId: r.transcript_id ?? null, ...(r.created_at ? { createdAt: r.created_at } : {}) });

export function supabaseGroupStore(db: MinimalSupabase, opts: { surveyId?: string | null } = {}): GroupStore {
  return {
    async byCode(code) {
      let q = db.from("qual_group_sessions").select(GROUP_COLUMNS).eq("join_code", code);
      if (opts.surveyId) q = q.eq("survey_id", opts.surveyId);
      const r = ok(await q.maybeSingle() as Res<GroupDbRow>, "group session");
      return r ? toGroupRow(r) : null;
    },
    async participants(g) {
      const rows = ok(await db.from("qual_group_participants").select("id, handle, segment, joined_at, last_seen_at").eq("group_session_id", g).order("joined_at") as Res<{ id: string; handle: string; segment: string | null; joined_at: string; last_seen_at: string | null }[]>, "participants") ?? [];
      return rows.map((p) => ({ id: p.id, handle: p.handle, joinedAt: p.joined_at, ...(p.segment ? { group: p.segment } : {}), ...(p.last_seen_at ? { lastSeenAt: p.last_seen_at } : {}) }));
    },
    async participantByHash(g, h) {
      const p = ok(await db.from("qual_group_participants").select("id, handle, segment, joined_at").eq("group_session_id", g).eq("token_hash", h).maybeSingle() as Res<{ id: string; handle: string; segment: string | null; joined_at: string }>, "participant");
      return p ? { id: p.id, handle: p.handle, joinedAt: p.joined_at, ...(p.segment ? { group: p.segment } : {}) } : null;
    },
    async addParticipant(g, s, p) {
      const r = await db.from("qual_group_participants").insert({ group_session_id: g, survey_id: s, handle: p.handle, token_hash: p.tokenHash, consent_at: p.consentAt, segment: p.group ?? null }).select("id, handle, joined_at").single() as Res<{ id: string; handle: string; joined_at: string }>;
      if (dup(r)) return "handle_taken";
      const d = ok(r, "participant");
      return { id: d.id, handle: d.handle, joinedAt: d.joined_at } as GroupParticipant;
    },
    async seen(pid, at) { await db.from("qual_group_participants").update({ last_seen_at: at }).eq("id", pid); },
    async answers(g, promptId) {
      let q = db.from("qual_group_answers").select("id, prompt_id, participant_id, text, created_at").eq("group_session_id", g);
      if (promptId) q = q.eq("prompt_id", promptId);
      const rows = ok(await q.order("created_at").limit(5000) as Res<{ id: string; prompt_id: string; participant_id: string; text: string; created_at: string }[]>, "answers") ?? [];
      return rows.map((a) => ({ id: a.id, promptId: a.prompt_id, participantId: a.participant_id, text: a.text, at: a.created_at }));
    },
    async upsertAnswer(g, s, a) {
      const r = ok(await db.from("qual_group_answers").upsert({ group_session_id: g, survey_id: s, prompt_id: a.promptId, participant_id: a.participantId, text: a.text, updated_at: a.at }, { onConflict: "group_session_id,prompt_id,participant_id" }).select("id, created_at").single() as Res<{ id: string; created_at: string }>, "answer");
      return { id: r.id, promptId: a.promptId, participantId: a.participantId, text: a.text, at: r.created_at } as GroupAnswer;
    },
    async votes(g) {
      const rows = ok(await db.from("qual_group_votes").select("answer_id, voter_id, vote, created_at").eq("group_session_id", g).limit(20000) as Res<{ answer_id: string; voter_id: string; vote: number; created_at: string }[]>, "votes") ?? [];
      return rows.map((v) => ({ answerId: v.answer_id, voterId: v.voter_id, vote: v.vote as GroupVote["vote"], at: v.created_at }));
    },
    async addVote(g, s, v) {
      const r = await db.from("qual_group_votes").insert({ answer_id: v.answerId, voter_id: v.voterId, group_session_id: g, survey_id: s, vote: v.vote }) as Res<unknown>;
      if (dup(r)) return "duplicate";
      ok(r, "vote");
      return "ok";
    },
    async saveState(g, state, expected) {
      const r = ok(await db.from("qual_group_sessions").update({ state, status: state.status, version: expected + 1 }).eq("id", g).eq("version", expected).select("id") as Res<unknown[]>, "group session");
      return !!r?.length;
    },
  };
}
