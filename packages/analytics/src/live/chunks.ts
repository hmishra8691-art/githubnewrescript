import { chunkRefusal, readChunk, type LiveDeps, type LiveReply, type LiveStore } from "./service.js";
import type { LiveRole } from "./room.js";

/**
 * RECORDED CHUNKS → PRIVATE STORAGE (2026-10-22, G2). Each person's browser uploads its own chunks through the
 * existing three-step media upload (`ticket` → PUT to a signed URL, resumable by part → `confirm`, verified by the
 * store), keyed by the room, the person, the track and the chunk's number — so a retried chunk is the SAME upload,
 * never a second object. Who may upload: someone in the session who agreed to the recording, while it is live (or
 * just ended, for the last chunk). The media I/O is injected (`@rescript/media` in the apps, a temp folder in the
 * sandbox), so both apps and the sandbox share this one gate.
 */

export interface ChunkMediaOps {
  begin(req: { customerId: string | null; surveyId: string; sessionId: string; fileName: string; mimeType: string; bytes: number | null; durationSeconds: number | null; clientToken: string }): Promise<{ mediaId: string } & Record<string, unknown>>;
  resume(mediaId: string, bytes: number | null): Promise<Record<string, unknown>>;
  confirm(mediaId: string, observed: { bytes: number | null; durationSeconds: number | null }, parts: { partNumber: number; etag: string }[]): Promise<{ bytes?: number | null }>;
}

const TOKEN = /^[A-Za-z0-9_-]{24,120}$/;
const err = (status: number, error: string, code?: string): LiveReply => ({ status, body: { error, ...(code ? { code } : {}) } });

export async function chunkAction(store: LiveStore, action: string, raw: unknown, deps: LiveDeps, ops: ChunkMediaOps, opts: { allowRoles?: LiveRole[]; surveyId?: string } = {}): Promise<LiveReply> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const token = String(b.token ?? "");
  if (!TOKEN.test(token)) return err(401, "Join the session first.", "not_joined");
  const me = await store.memberByHash(deps.hash(token));
  if (!me) return err(401, "This tab is no longer in the session.", "not_joined");
  if (opts.allowRoles && !opts.allowRoles.includes(me.role)) return err(403, "Not here.", "forbidden");
  const row = await store.room(me.roomId);
  if (!row || (opts.surveyId && row.surveyId !== opts.surveyId)) return err(404, "This session does not exist.", "no_room");
  const nowMs = Date.parse(deps.now());

  if (action === "ticket") {
    const c = readChunk(b);
    if (typeof c === "string") return err(400, c, "invalid");
    const refusal = chunkRefusal(row, me, c.kind, nowMs);
    if (refusal) return err(refusal.status, refusal.message, refusal.code);
    const mimeType = typeof b.mimeType === "string" ? b.mimeType.split(";")[0].trim().slice(0, 60) : "";
    if (!/^(audio|video)\/[\w.+-]+$/.test(mimeType) || (c.kind === "audio" && !mimeType.startsWith("audio/"))) return err(415, `a recording chunk is audio or video (this is ${mimeType || "an unknown type"})`, "type");
    const ext = /mp4|m4a/.test(mimeType) ? (c.kind === "audio" ? "m4a" : "mp4") : /ogg/.test(mimeType) ? "ogg" : "webm";
    const ticket = await ops.begin({
      customerId: row.customerId, surveyId: row.surveyId, sessionId: row.qualSessionId ?? row.id,
      fileName: `live-${me.handle.replace(/\s+/g, "")}-${c.kind}-${String(c.seq).padStart(4, "0")}.${ext}`, mimeType,
      bytes: Number(b.bytes) || null, durationSeconds: c.durationMs ? Math.round(c.durationMs / 1000) : null,
      clientToken: `live:${row.id}:${me.id}:${c.kind}:${c.seq}`,
    });
    await store.upsertTrack({ roomId: row.id, memberId: me.id, kind: c.kind, seq: c.seq, startMs: c.startMs, durationMs: c.durationMs, mediaId: ticket.mediaId, mimeType, bytes: Number(b.bytes) || null, ...(ticket.alreadyStored ? { status: "stored" as const } : {}) });
    return { status: 200, body: { ok: true, ...ticket } };
  }

  const mediaId = String(b.mediaId ?? "");
  const track = (await store.tracks(row.id)).find((t) => t.mediaId === mediaId && t.memberId === me.id);
  if (!track) return err(404, "no such recording chunk", "no_chunk");
  if (action === "parts") return { status: 200, body: { ok: true, ...(await ops.resume(mediaId, Number(b.bytes) || null)) } };
  if (action === "confirm") {
    const parts = (Array.isArray(b.parts) ? b.parts : []).map((p) => ({ partNumber: Number((p as { partNumber?: unknown })?.partNumber), etag: String((p as { etag?: unknown })?.etag ?? "").replace(/"/g, "") })).filter((p) => Number.isInteger(p.partNumber) && p.partNumber > 0 && !!p.etag);
    const durationSeconds = Number(b.durationSeconds) || null;
    const stored = await ops.confirm(mediaId, { bytes: Number(b.bytes) || Number(b.bytesRecorded) || null, durationSeconds }, parts);
    if (track.status === "uploading" || track.status === "failed") await store.updateTrack(track.id, { status: "stored", bytes: stored.bytes ?? track.bytes ?? null, ...(durationSeconds && !track.durationMs ? { durationMs: Math.round(durationSeconds * 1000) } : {}) });
    await store.touch(row.id);
    return { status: 200, body: { ok: true, mediaId, bytes: stored.bytes ?? null } };
  }
  return err(404, "ticket, parts or confirm", "invalid");
}
