import type { LiveMember, LiveRoomState, LiveSignal } from "./room.js";
import type { LiveTrack } from "./merge.js";
import type { LiveInvite, LiveNote, LiveRoomRow, LiveStore } from "./service.js";

/**
 * THE LIVE-SESSION STORE OVER SUPABASE (migration 0071), shared by the Studio (moderator, member observers,
 * scheduling, transcription) and the respondent app (participants, external observers). The client is injected
 * (the caller's service-role client); this file holds no credentials. Token hashes are written, looked up by
 * equality, and never selected back out.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;
export interface MinimalSupabase { from(table: string): Q; rpc(fn: string, args: Record<string, unknown>): Q }
type Res<T> = { data: T | null; error: { message: string } | null };
const ok = <T>(r: Res<T>, what: string): T => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data as T; };
const dup = (r: Res<unknown>) => !!r.error && /duplicate key|unique/i.test(r.error.message);

const ROOM_COLUMNS = "id, survey_id, customer_id, state, version, rev, qual_session_id, transcript_id, created_at";
const MEMBER_COLUMNS = "id, room_id, role, handle, label, segment, state, invite_id, user_id, recording_consent, consent_at, media, muted_by_moderator, device, joined_at, last_seen_at";
const INVITE_COLUMNS = "id, room_id, role, label, email, segment, status, link_version, member_id, invited_at, reminded_at, created_at";
const TRACK_COLUMNS = "id, room_id, member_id, kind, seq, start_ms, duration_ms, media_id, mime_type, bytes, status, transcript, error";

interface RoomDb { id: string; survey_id: string; customer_id: string | null; state: LiveRoomState; version: number; rev: number | string; qual_session_id: string | null; transcript_id: string | null; created_at?: string }
interface MemberDb { id: string; room_id: string; role: LiveMember["role"]; handle: string; label: string | null; segment: string | null; state: LiveMember["state"]; invite_id: string | null; user_id: string | null; recording_consent: boolean; consent_at: string | null; media: Record<string, unknown> | null; muted_by_moderator: boolean; device: Record<string, unknown> | null; joined_at: string; last_seen_at: string | null }
interface InviteDb { id: string; room_id: string; role: LiveInvite["role"]; label: string | null; email: string | null; segment: string | null; status: LiveInvite["status"]; link_version: number; member_id: string | null; invited_at: string | null; reminded_at: string | null; created_at: string }
interface TrackDb { id: string; room_id: string; member_id: string; kind: "audio" | "video"; seq: number; start_ms: number | string; duration_ms: number; media_id: string | null; mime_type: string | null; bytes: number | string | null; status: LiveTrack["status"]; transcript: LiveTrack["transcript"]; error: string | null }

const toRoom = (r: RoomDb): LiveRoomRow => ({ id: r.id, surveyId: r.survey_id, customerId: r.customer_id, state: { ...r.state, id: r.id }, version: r.version, rev: Number(r.rev), qualSessionId: r.qual_session_id, transcriptId: r.transcript_id, ...(r.created_at ? { createdAt: r.created_at } : {}) });
const toMember = (m: MemberDb): LiveMember => ({
  id: m.id, roomId: m.room_id, role: m.role, handle: m.handle, ...(m.label ? { label: m.label } : {}), ...(m.segment ? { segment: m.segment } : {}), state: m.state,
  ...(m.invite_id ? { inviteId: m.invite_id } : {}), ...(m.user_id ? { userId: m.user_id } : {}), recordingConsent: m.recording_consent, ...(m.consent_at ? { consentAt: m.consent_at } : {}),
  joinedAt: m.joined_at, ...(m.last_seen_at ? { lastSeenAt: m.last_seen_at } : {}),
  media: { audio: m.media?.audio === true, video: m.media?.video === true, screen: m.media?.screen === true }, mutedByModerator: m.muted_by_moderator,
  ...(m.device ? { device: { camera: m.device.camera === true, microphone: m.device.microphone === true } } : {}),
});
const toInvite = (i: InviteDb): LiveInvite => ({ id: i.id, roomId: i.room_id, role: i.role, ...(i.label ? { label: i.label } : {}), ...(i.email ? { email: i.email } : {}), ...(i.segment ? { segment: i.segment } : {}), status: i.status, linkVersion: i.link_version, ...(i.member_id ? { memberId: i.member_id } : {}), ...(i.invited_at ? { invitedAt: i.invited_at } : {}), ...(i.reminded_at ? { remindedAt: i.reminded_at } : {}), createdAt: i.created_at });
const toTrack = (t: TrackDb): LiveTrack => ({ id: t.id, roomId: t.room_id, memberId: t.member_id, kind: t.kind, seq: t.seq, startMs: Number(t.start_ms), durationMs: t.duration_ms, mediaId: t.media_id, status: t.status, transcript: t.transcript ?? null, error: t.error, mimeType: t.mime_type, bytes: t.bytes == null ? null : Number(t.bytes) });

function memberRow(p: Partial<LiveMember> & { tokenHash?: string }): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (p.state !== undefined) o.state = p.state;
  if (p.label !== undefined) o.label = p.label;
  if (p.segment !== undefined) o.segment = p.segment;
  if (p.userId !== undefined) o.user_id = p.userId;
  if (p.recordingConsent !== undefined) o.recording_consent = p.recordingConsent;
  if (p.consentAt !== undefined) o.consent_at = p.consentAt;
  if (p.media !== undefined) o.media = p.media;
  if (p.mutedByModerator !== undefined) o.muted_by_moderator = p.mutedByModerator;
  if (p.device !== undefined) o.device = p.device;
  if (p.lastSeenAt !== undefined) o.last_seen_at = p.lastSeenAt;
  if (p.tokenHash !== undefined) o.token_hash = p.tokenHash;
  return o;
}

export function supabaseLiveStore(db: MinimalSupabase): LiveStore {
  const surveyOf = new Map<string, string>();
  const surveyFor = async (roomId: string): Promise<string> => {
    if (!surveyOf.has(roomId)) { const r = ok(await db.from("live_rooms").select("survey_id").eq("id", roomId).maybeSingle() as Res<{ survey_id: string }>, "room"); if (!r) throw new Error("room: not found"); surveyOf.set(roomId, r.survey_id); }
    return surveyOf.get(roomId)!;
  };
  return {
    kind: "supabase",
    async room(id) { const r = ok(await db.from("live_rooms").select(ROOM_COLUMNS).eq("id", id).maybeSingle() as Res<RoomDb>, "room"); if (r) surveyOf.set(r.id, r.survey_id); return r ? toRoom(r) : null; },
    async rooms(surveyId) { return (ok(await db.from("live_rooms").select(ROOM_COLUMNS).eq("survey_id", surveyId).order("scheduled_at", { ascending: true, nullsFirst: false }).order("created_at").limit(500) as Res<RoomDb[]>, "rooms") ?? []).map(toRoom); },
    async insertRoom(r) {
      const row = ok(await db.from("live_rooms").insert({ survey_id: r.surveyId, customer_id: r.customerId, title: r.state.title, kind: r.state.kind, status: r.state.status, scheduled_at: r.state.scheduledAt, time_zone: r.state.timeZone, state: r.state, created_by: r.userId ?? null }).select("id").single() as Res<{ id: string }>, "room");
      ok(await db.from("live_rooms").update({ state: { ...r.state, id: row.id } }).eq("id", row.id) as Res<unknown>, "room");
      surveyOf.set(row.id, r.surveyId);
      return row.id;
    },
    async saveRoom(id, state, expected) {
      const r = ok(await db.rpc("rescript_live_save", { p_room: id, p_state: state, p_expected: expected }) as Res<boolean>, "room");
      if (r) await db.from("live_rooms").update({ title: state.title, scheduled_at: state.scheduledAt, time_zone: state.timeZone }).eq("id", id);
      return !!r;
    },
    async link(id, patch) { ok(await db.from("live_rooms").update({ ...(patch.qualSessionId !== undefined ? { qual_session_id: patch.qualSessionId } : {}), ...(patch.transcriptId !== undefined ? { transcript_id: patch.transcriptId } : {}) }).eq("id", id) as Res<unknown>, "room"); },
    async touch(id) { ok(await db.rpc("rescript_live_touch", { p_room: id }) as Res<unknown>, "room"); },
    async members(roomId) { return (ok(await db.from("live_room_members").select(MEMBER_COLUMNS).eq("room_id", roomId).order("joined_at") as Res<MemberDb[]>, "members") ?? []).map(toMember); },
    async memberByHash(h) { const m = ok(await db.from("live_room_members").select(MEMBER_COLUMNS).eq("token_hash", h).maybeSingle() as Res<MemberDb>, "member"); return m ? toMember(m) : null; },
    async insertMember(m, tokenHash) {
      const r = await db.from("live_room_members").insert({ room_id: m.roomId, survey_id: await surveyFor(m.roomId), role: m.role, handle: m.handle, label: m.label ?? null, segment: m.segment ?? null, state: m.state, invite_id: m.inviteId ?? null, user_id: m.userId ?? null, token_hash: tokenHash, recording_consent: m.recordingConsent, consent_at: m.consentAt ?? null, media: m.media, muted_by_moderator: m.mutedByModerator, device: m.device ?? null, joined_at: m.joinedAt, last_seen_at: m.lastSeenAt ?? null }).select(MEMBER_COLUMNS).single() as Res<MemberDb>;
      if (dup(r) && /handle/i.test(r.error!.message)) return "handle_taken";
      return toMember(ok(r, "member"));
    },
    async updateMember(id, patch) { const row = memberRow(patch); if (Object.keys(row).length) ok(await db.from("live_room_members").update(row).eq("id", id) as Res<unknown>, "member"); },
    async invites(roomId) { return (ok(await db.from("live_room_invites").select(INVITE_COLUMNS).eq("room_id", roomId).order("created_at") as Res<InviteDb[]>, "invites") ?? []).map(toInvite); },
    async inviteByHash(h) { const i = ok(await db.from("live_room_invites").select(INVITE_COLUMNS).eq("token_hash", h).maybeSingle() as Res<InviteDb>, "invite"); return i ? toInvite(i) : null; },
    async insertInvite(i, hashFor) {
      /* the id is chosen here so the token (derived from it) can be hashed before the row exists */
      const id = (globalThis.crypto as Crypto).randomUUID();
      const r = ok(await db.from("live_room_invites").insert({ id, room_id: i.roomId, survey_id: await surveyFor(i.roomId), role: i.role, label: i.label ?? null, email: i.email ?? null, segment: i.segment ?? null, token_hash: hashFor(id, 1), invited_at: i.invitedAt ?? null }).select(INVITE_COLUMNS).single() as Res<InviteDb>, "invite");
      return toInvite(r);
    },
    async updateInvite(id, patch) {
      const o: Record<string, unknown> = {};
      if (patch.status !== undefined) o.status = patch.status;
      if (patch.memberId !== undefined) o.member_id = patch.memberId;
      if (patch.remindedAt !== undefined) o.reminded_at = patch.remindedAt;
      if (patch.invitedAt !== undefined) o.invited_at = patch.invitedAt;
      if (patch.linkVersion !== undefined) o.link_version = patch.linkVersion;
      if (patch.label !== undefined) o.label = patch.label;
      if (patch.email !== undefined) o.email = patch.email;
      if (patch.segment !== undefined) o.segment = patch.segment;
      if (patch.tokenHash !== undefined) o.token_hash = patch.tokenHash;
      if (Object.keys(o).length) ok(await db.from("live_room_invites").update(o).eq("id", id) as Res<unknown>, "invite");
    },
    async poll(roomId, memberId, after) {
      const r = ok(await db.rpc("rescript_live_poll", { p_room: roomId, p_member: memberId, p_after: after }) as Res<{ rev: number | string; signals: LiveSignal[] }>, "poll");
      return { rev: Number(r?.rev ?? 0), signals: (r?.signals ?? []).map((s) => ({ ...s, id: Number(s.id) })) };
    },
    async addSignals(roomId, from, list, expiresAt) { if (list.length) ok(await db.from("live_room_signals").insert(list.map((s) => ({ room_id: roomId, from_member: from, to_member: s.to, type: s.type, payload: s.payload ?? null, expires_at: expiresAt }))) as Res<unknown>, "signals"); },
    async sweepSignals(now) { return Number(ok(await db.rpc("rescript_live_sweep", { p_now: now }) as Res<number>, "sweep") ?? 0); },
    async notes(roomId) { return (ok(await db.from("live_room_notes").select("id, room_id, member_id, kind, author, text, offset_seconds, created_at").eq("room_id", roomId).order("created_at").limit(1000) as Res<{ id: string; room_id: string; member_id: string | null; kind: "chat" | "note"; author: string; text: string; offset_seconds: number | null; created_at: string }[]>, "notes") ?? []).map((n) => ({ id: n.id, roomId: n.room_id, memberId: n.member_id ?? "", kind: n.kind, author: n.author, text: n.text, offsetSeconds: n.offset_seconds, at: n.created_at })); },
    async addNote(n) {
      const r = ok(await db.from("live_room_notes").insert({ room_id: n.roomId, survey_id: await surveyFor(n.roomId), member_id: n.memberId || null, kind: n.kind, author: n.author.slice(0, 120) || "—", text: n.text, offset_seconds: n.offsetSeconds, created_at: n.at }).select("id").single() as Res<{ id: string }>, "note");
      return { ...n, id: r.id } as LiveNote;
    },
    async tracks(roomId) { return (ok(await db.from("live_room_tracks").select(TRACK_COLUMNS).eq("room_id", roomId).order("start_ms").limit(5000) as Res<TrackDb[]>, "tracks") ?? []).map(toTrack); },
    async upsertTrack(t) {
      const r = ok(await db.from("live_room_tracks").upsert({ room_id: t.roomId, survey_id: await surveyFor(t.roomId), member_id: t.memberId, kind: t.kind, seq: t.seq, start_ms: t.startMs, duration_ms: t.durationMs, media_id: t.mediaId, mime_type: t.mimeType ?? null, bytes: t.bytes ?? null, ...(t.status ? { status: t.status } : {}) }, { onConflict: "room_id,member_id,kind,seq" }).select(TRACK_COLUMNS).single() as Res<TrackDb>, "track");
      return toTrack(r);
    },
    async updateTrack(id, patch) {
      const o: Record<string, unknown> = {};
      if (patch.status !== undefined) o.status = patch.status;
      if (patch.transcript !== undefined) o.transcript = patch.transcript;
      if (patch.error !== undefined) o.error = patch.error;
      if (patch.mediaId !== undefined) o.media_id = patch.mediaId;
      if (patch.durationMs !== undefined) o.duration_ms = patch.durationMs;
      if (patch.bytes !== undefined) o.bytes = patch.bytes;
      if (Object.keys(o).length) ok(await db.from("live_room_tracks").update(o).eq("id", id) as Res<unknown>, "track");
    },
    async claimTrack(id, now, until) { return !!ok(await db.rpc("rescript_live_claim_track", { p_track: id, p_now: now, p_until: until }) as Res<boolean>, "track"); },
  };
}
