import type { LiveMember, LiveRoomState } from "./room.js";

/**
 * ONE TRANSCRIPT FROM EVERYONE'S OWN RECORDING (2026-10-22, G2).
 *
 * In a live session each person's browser records their OWN microphone (with their consent) in short standalone
 * chunks, so every chunk has exactly one speaker: attribution is perfect, no diarization is needed. Each chunk is
 * transcribed on its own; here the chunks' timed segments are moved onto the session's clock (seconds from the
 * start) and merged by time into one transcript with the moderator and the participants as speakers — the shape
 * the qualitative tables already hold (`qual_transcripts.segments` / `speakers`), so coding, synthesis, highlights
 * and reports read it unchanged. Each segment keeps a pointer to the chunk it came from (`meta.media`), which is
 * how a highlight clip plays the right file from the right second. Pure.
 */

export type LiveTrackStatus = "uploading" | "stored" | "transcribing" | "transcribed" | "failed" | "empty";
export interface LiveChunkTranscript { text: string; segments?: { start: number; end: number; text: string }[]; model?: string; language?: string }
export interface LiveTrack {
  id: string; roomId: string; memberId: string; kind: "audio" | "video"; seq: number;
  /** when the chunk started, on the server's clock (epoch ms) */
  startMs: number; durationMs: number;
  mediaId: string | null; status: LiveTrackStatus; transcript?: LiveChunkTranscript | null; error?: string | null;
  mimeType?: string | null; bytes?: number | null;
}

export interface LiveTranscriptSegment { id: string; index: number; speaker: string; start: number; end: number; text: string }
export interface LiveTranscript {
  title: string;
  segments: LiveTranscriptSegment[];
  speakers: Record<string, { role: "moderator" | "participant"; group?: string }>;
  participants: { id: string; label: string; segment?: string }[];
  meta: {
    origin: "live_session"; roomId: string; attribution: "separate tracks";
    /** segment id → the chunk it was said in: the audio (and video) media and the chunk's start on the session clock */
    media: Record<string, { audio: string; video?: string; offset: number }>;
    tracks: { transcribed: number; pending: number; failed: number; empty: number };
    durationSeconds: number | null; warnings: string[]; model?: string;
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export const speakerLabel = (m: Pick<LiveMember, "role" | "handle">) => (m.role === "moderator" ? "Moderator" : m.handle);

/** the session's clock origin: when it started (else the first chunk) */
export function sessionOrigin(room: Pick<LiveRoomState, "startedAt">, tracks: readonly LiveTrack[]): number {
  const s = room.startedAt ? Date.parse(room.startedAt) : NaN;
  if (Number.isFinite(s)) return s;
  return tracks.length ? Math.min(...tracks.map((t) => t.startMs)) : 0;
}

/**
 * Merge every transcribed audio chunk into one transcript. Consecutive pieces by the same speaker in the same
 * chunk (≤ 1.5 s apart) become one turn; speech that overlaps another speaker's stays a separate turn, ordered by
 * when it started (the moderator first on a tie).
 */
export function mergeLiveTranscript(input: { room: LiveRoomState; members: readonly LiveMember[]; tracks: readonly LiveTrack[]; title?: string }): LiveTranscript {
  const { room, members, tracks } = input;
  const origin = sessionOrigin(room, tracks);
  const byId = new Map(members.map((m) => [m.id, m]));
  const video = new Map(tracks.filter((t) => t.kind === "video" && t.mediaId && (t.status === "stored" || t.status === "transcribed")).map((t) => [`${t.memberId}:${t.seq}`, t.mediaId!]));
  const audio = tracks.filter((t) => t.kind === "audio");
  type Piece = { member: LiveMember; track: LiveTrack; start: number; end: number; text: string; offset: number };
  const pieces: Piece[] = [];
  let model: string | undefined;
  for (const t of audio) {
    const m = byId.get(t.memberId);
    if (!m || m.role === "observer" || t.status !== "transcribed" || !t.transcript) continue;
    model ??= t.transcript.model;
    const offset = Math.max(0, (t.startMs - origin) / 1000);
    const dur = Math.max(0.5, t.durationMs / 1000);
    const segs = (t.transcript.segments ?? []).filter((s) => s && typeof s.text === "string" && s.text.trim());
    if (segs.length) for (const s of segs) pieces.push({ member: m, track: t, start: offset + Math.max(0, Number(s.start) || 0), end: offset + Math.min(dur, Math.max(Number(s.end) || 0, Number(s.start) || 0)), text: s.text.trim(), offset });
    else if (t.transcript.text.trim()) pieces.push({ member: m, track: t, start: offset, end: offset + dur, text: t.transcript.text.trim(), offset });
  }
  const rank = (m: LiveMember) => (m.role === "moderator" ? 0 : 1);
  pieces.sort((a, b) => a.start - b.start || rank(a.member) - rank(b.member) || a.member.handle.localeCompare(b.member.handle, undefined, { numeric: true }));
  const turns: Piece[] = [];
  for (const p of pieces) {
    const last = turns[turns.length - 1];
    if (last && last.member.id === p.member.id && last.track.id === p.track.id && p.start - last.end <= 1.5) { last.text = `${last.text} ${p.text}`; last.end = Math.max(last.end, p.end); continue; }
    turns.push({ ...p });
  }
  let overlaps = 0;
  for (let i = 1; i < turns.length; i++) if (turns[i].start < turns[i - 1].end - 0.25 && turns[i].member.id !== turns[i - 1].member.id) overlaps++;
  const segments: LiveTranscriptSegment[] = [];
  const media: LiveTranscript["meta"]["media"] = {};
  turns.forEach((t, i) => {
    const id = `l${i + 1}`;
    segments.push({ id, index: i, speaker: speakerLabel(t.member), start: r2(t.start), end: r2(t.end), text: t.text });
    const v = video.get(`${t.member.id}:${t.track.seq}`);
    if (t.track.mediaId) media[id] = { audio: t.track.mediaId, ...(v ? { video: v } : {}), offset: r2(t.offset) };
  });
  const speakers: LiveTranscript["speakers"] = {};
  const people = members.filter((m) => m.role !== "observer" && (m.role === "moderator" || m.state === "admitted" || m.state === "left" || m.state === "removed" || audio.some((t) => t.memberId === m.id)));
  for (const m of people) speakers[speakerLabel(m)] = { role: m.role === "moderator" ? "moderator" : "participant", ...(m.segment ? { group: m.segment } : {}) };
  const participants = people.filter((m) => m.role === "participant").sort((a, b) => a.handle.localeCompare(b.handle, undefined, { numeric: true })).map((m) => ({ id: m.handle.toLowerCase(), label: m.handle, ...(m.segment ? { segment: m.segment } : {}) }));
  const count = (s: LiveTrack["status"] | LiveTrack["status"][]) => audio.filter((t) => (Array.isArray(s) ? s : [s]).includes(t.status)).length;
  const tr = { transcribed: count("transcribed"), pending: count(["uploading", "stored", "transcribing"]), failed: count("failed"), empty: count("empty") };
  const warnings: string[] = [];
  if (tr.pending) warnings.push(`${tr.pending} recording chunk${tr.pending === 1 ? " was" : "s were"} not transcribed yet — finalize again once they have uploaded.`);
  if (tr.failed) warnings.push(`${tr.failed} recording chunk${tr.failed === 1 ? "" : "s"} did not reach us or could not be transcribed (what was stored is kept).`);
  if (overlaps) warnings.push(`${overlaps} place${overlaps === 1 ? "" : "s"} where people spoke over each other — kept as separate turns in the order they started.`);
  for (const m of people) if (m.role === "participant" && m.recordingConsent && !audio.some((t) => t.memberId === m.id)) warnings.push(`No recording reached us from ${m.handle} (their browser may not support recording, or they never spoke while the session was live).`);
  const ends = room.endedAt && room.startedAt ? (Date.parse(room.endedAt) - Date.parse(room.startedAt)) / 1000 : null;
  return {
    title: input.title ?? `${room.title} (live session)`,
    segments, speakers, participants,
    meta: { origin: "live_session", roomId: room.id, attribution: "separate tracks", media, tracks: tr, durationSeconds: ends != null && Number.isFinite(ends) ? Math.round(ends) : null, warnings, ...(model ? { model } : {}) },
  };
}

/** a highlight clip inside a live-session transcript: the chunk's media and the time inside it */
export function liveClip(meta: unknown, segmentId: string, range: { start: number; end: number }, prefer: "video" | "audio" = "video"): { mediaId: string; start: number; end: number } | null {
  const m = (meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {});
  if (m.origin !== "live_session") return null;
  const p = ((m.media ?? {}) as Record<string, { audio?: string; video?: string; offset?: number }>)[segmentId];
  if (!p?.audio) return null;
  const off = Number(p.offset) || 0;
  return { mediaId: (prefer === "video" && p.video) || p.audio, start: Math.max(0, r2(range.start - off)), end: Math.max(0, r2(range.end - off)) };
}
