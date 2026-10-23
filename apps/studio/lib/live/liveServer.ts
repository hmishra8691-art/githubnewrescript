import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { beginUpload, confirmUpload, resumeUpload, type MediaDb } from "@rescript/media";
import { aiProviderName, transcribe } from "@rescript/ai";
import {
  memoryLiveStore, supabaseLiveStore, MESH_MAX_PARTICIPANTS,
  type LiveStore, type MemoryLiveStore, type LiveRoomRow, type LiveDeps, type LiveTrack, type LiveMember, type LiveInvite, type ChunkMediaOps,
} from "@rescript/analytics/live";
import { iceServersFor, livekitConfig, livekitToken, inviteToken, linkSecret, sha256Hex, newMemberToken, turnStatus, TURN_WARNING } from "@rescript/analytics/live/server";
import { runtimeBaseUrl } from "@/lib/runtime-url";
import { supabaseService } from "@/lib/authServer";

/**
 * LIVE SESSIONS — THE STUDIO'S SERVER HALF (2026-10-22, G2). The room logic is `@rescript/analytics/live`
 * (pure, shared with the respondent app); this file picks the store (Supabase, migration 0071 — or, for the
 * unsaved sandbox against the FAKE provider only, an in-memory store kept in a temp file so a restarted dev server
 * keeps a live test room), mints connection credentials (ICE / TURN, LiveKit), derives invitation links, and
 * transcribes recorded chunks under the meter.
 */

export const liveDeps: LiveDeps = { now: () => new Date().toISOString(), hash: sha256Hex, newToken: newMemberToken, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
export const isSandbox = (surveyId: string) => surveyId === "sandbox";
/** the database-less sandbox runs live sessions only against the fake provider, never in production */
export const sandboxReady = () => aiProviderName() === "fake" && process.env.NODE_ENV !== "production";

/* ------------------------------------------------------------ the sandbox store (memory + a temp file) */

const DIR = join(tmpdir(), "rescript-live-sandbox");
const FILE = join(DIR, "store.json");
const MUTATING = new Set(["insertRoom", "saveRoom", "link", "touch", "insertMember", "updateMember", "insertInvite", "updateInvite", "addSignals", "sweepSignals", "addNote", "upsertTrack", "updateTrack", "claimTrack"]);
interface SandboxGlobal { store?: LiveStore; mem?: MemoryLiveStore; secret?: string; timer?: ReturnType<typeof setTimeout> | null }
const G = (): SandboxGlobal => { const g = globalThis as unknown as { __rescriptLiveSandbox?: SandboxGlobal }; return (g.__rescriptLiveSandbox ??= {}); };

function persist(): void {
  const g = G();
  if (g.timer) return;
  g.timer = setTimeout(() => {
    g.timer = null;
    try { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(g.mem!.dump())); } catch { /* best effort */ }
  }, 150);
}

export function sandboxStore(): LiveStore {
  const g = G();
  if (!g.store) {
    const mem = memoryLiveStore();
    try { mem.load(JSON.parse(readFileSync(FILE, "utf8"))); } catch { /* none yet */ }
    g.mem = mem;
    g.store = new Proxy(mem, { get(target, prop, recv) { const v = Reflect.get(target, prop, recv); if (typeof v === "function" && MUTATING.has(String(prop))) return (...a: unknown[]) => { const out = (v as (...x: unknown[]) => unknown).apply(target, a); persist(); return out; }; return v; } }) as LiveStore;
  }
  return g.store;
}

function sandboxSecret(): string {
  const g = G();
  if (g.secret) return g.secret;
  const f = join(DIR, "secret");
  try { g.secret = readFileSync(f, "utf8").trim(); } catch { /* new */ }
  if (!g.secret || g.secret.length < 16) { g.secret = randomBytes(24).toString("hex"); try { mkdirSync(DIR, { recursive: true }); writeFileSync(f, g.secret); } catch { /* */ } }
  return g.secret;
}

const BLOBS = join(DIR, "blobs");
const safeId = (id: string) => id.replace(/[^\w-]/g, "").slice(0, 80);
export function writeSandboxBlob(mediaId: string, bytes: Uint8Array): void { mkdirSync(BLOBS, { recursive: true }); writeFileSync(join(BLOBS, safeId(mediaId)), bytes); }
export function readSandboxBlob(mediaId: string): Uint8Array | null { try { return new Uint8Array(readFileSync(join(BLOBS, safeId(mediaId)))); } catch { return null; } }
export const sandboxBlobExists = (mediaId: string) => existsSync(join(BLOBS, safeId(mediaId)));

/* ------------------------------------------------------------ the store for a project */

export function storeFor(surveyId: string): LiveStore {
  return isSandbox(surveyId) ? sandboxStore() : supabaseLiveStore(supabaseService() as never);
}

/** the room, only when it belongs to this project */
export async function roomOf(store: LiveStore, surveyId: string, roomId: unknown): Promise<LiveRoomRow | null> {
  const id = String(roomId ?? "");
  if (!/^[\w-]{8,80}$/.test(id)) return null;
  const row = await store.room(id).catch(() => null);
  return row && row.surveyId === surveyId ? row : null;
}

/* ------------------------------------------------------------ invitation links */

export function linkSecretFor(surveyId: string): string | null { return isSandbox(surveyId) ? sandboxSecret() : linkSecret(process.env); }
export const inviteHashFor = (secret: string) => (id: string, version: number) => sha256Hex(inviteToken(secret, id, version));
export const inviteLink = (secret: string, inv: Pick<LiveInvite, "id" | "linkVersion">) => `${runtimeBaseUrl()}/live/${inviteToken(secret, inv.id, inv.linkVersion)}`;

/* ------------------------------------------------------------ connections */

export function transportInfo() {
  const t = turnStatus(process.env);
  const lk = livekitConfig(process.env);
  return { mesh: { maxParticipants: MESH_MAX_PARTICIPANTS }, turn: t.mode, ...(t.mode === "none" ? { turnWarning: TURN_WARNING } : {}), sfu: !!lk, sfuClient: !!lk?.clientUrl };
}

/** what one member's browser needs to connect: ICE servers (TURN credentials minted for them) and, for an SFU room, a LiveKit token once admitted */
export async function connectionFor(row: LiveRoomRow, member: Pick<LiveMember, "id" | "role" | "handle" | "state">) {
  const ice = await iceServersFor(process.env, { identity: member.id });
  const lk = row.state.settings.transport === "sfu" ? livekitConfig(process.env) : null;
  return {
    iceServers: ice.iceServers, turn: ice.turn, ...(ice.warning ? { warning: ice.warning } : {}),
    ...(lk && member.state === "admitted" ? { livekit: { url: lk.url, clientUrl: lk.clientUrl, token: livekitToken(lk, { identity: member.id, name: member.handle, room: row.id, canPublish: member.role !== "observer", hidden: member.role === "observer" }) } } : {}),
  };
}

/* ------------------------------------------------------------ transcription of recorded chunks */

export type Meter = <T>(seconds: number, fn: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false; refusal: unknown }>;

/**
 * Transcribe stored audio chunks (each one speaker, standalone, ≤ 2 minutes — far under the 25 MB a request takes,
 * so no splitting is needed). One transcriber per chunk (a lease); each call metered per minute of audio; a chunk
 * the provider hears nothing in is "empty", a failure is kept and retried by the next call. Bounded by count and time.
 */
export async function transcribeChunks(o: { store: LiveStore; row: LiveRoomRow; readBytes: (t: LiveTrack) => Promise<Uint8Array | null>; meter: Meter; max?: number; budgetMs?: number; language?: string; retryFailed?: boolean }): Promise<{ done: number; failed: number; remaining: number; refusal?: unknown }> {
  const started = Date.now();
  const tracks = (await o.store.tracks(o.row.id)).filter((t) => t.kind === "audio");
  const todo = tracks.filter((t) => t.status === "stored" || (o.retryFailed && t.status === "failed")).sort((a, b) => a.startMs - b.startMs);
  let done = 0, failed = 0;
  for (const t of todo.slice(0, o.max ?? 4)) {
    if (Date.now() - started > (o.budgetMs ?? 40_000)) break;
    const now = new Date();
    if (!(await o.store.claimTrack(t.id, now.toISOString(), new Date(now.getTime() + 120_000).toISOString()))) continue;
    await o.store.updateTrack(t.id, { status: "transcribing" });
    const bytes = await o.readBytes(t).catch(() => null);
    if (!bytes || !bytes.length) { await o.store.updateTrack(t.id, { status: "failed", error: "the recording chunk could not be read from storage" }); failed++; continue; }
    const seconds = Math.max(1, Math.round((t.durationMs || bytes.length / 4) / 1000));
    const m = await o.meter(seconds, () => transcribe(bytes, { segments: true, mimeType: t.mimeType ?? "audio/webm", fileName: `chunk-${t.seq}.${/mp4/.test(t.mimeType ?? "") ? "m4a" : /ogg/.test(t.mimeType ?? "") ? "ogg" : "webm"}`, durationSeconds: seconds, language: o.language || undefined, timeoutMs: 60_000 }));
    if (!m.ok) { await o.store.updateTrack(t.id, { status: "stored" }); return { done, failed, remaining: todo.length - done - failed, refusal: m.refusal }; }
    const heard = m.value;
    if (!heard.ok) { await o.store.updateTrack(t.id, { status: "failed", error: heard.reason.slice(0, 500) }); failed++; continue; }
    const v = heard.value;
    const text = (v.text ?? "").trim();
    await o.store.updateTrack(t.id, text ? { status: "transcribed", error: null, transcript: { text, ...(v.segments?.length ? { segments: v.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) } : {}), model: v.model, ...(v.language ? { language: v.language } : {}) } } : { status: "empty", transcript: { text: "", model: v.model } });
    done++;
  }
  const after = (await o.store.tracks(o.row.id)).filter((t) => t.kind === "audio" && (t.status === "stored" || t.status === "transcribing" || t.status === "uploading"));
  return { done, failed, remaining: after.length };
}

/** chunks a moderator's console shows: counts by status, per person */
export function trackSummary(tracks: readonly LiveTrack[], members: readonly LiveMember[]) {
  const audio = tracks.filter((t) => t.kind === "audio");
  const by = (s: LiveTrack["status"]) => audio.filter((t) => t.status === s).length;
  return {
    chunks: audio.length, video: tracks.filter((t) => t.kind === "video").length,
    uploading: by("uploading"), stored: by("stored"), transcribing: by("transcribing"), transcribed: by("transcribed"), empty: by("empty"), failed: by("failed"),
    people: members.filter((m) => m.role !== "observer").map((m) => ({ handle: m.handle, chunks: audio.filter((t) => t.memberId === m.id).length, transcribed: audio.filter((t) => t.memberId === m.id && t.status === "transcribed").length })),
  };
}

/* ------------------------------------------------------------ chunk storage: the media pipeline, or the sandbox's temp folder */


/** the media pipeline (private bucket `rescript-qual`, kind qual_recording, resumable, verified on confirm) */
export function mediaChunkOps(db: MediaDb, createdBy: string | null): ChunkMediaOps {
  return {
    async begin(r) {
      if (!r.customerId) throw new Error("this session has no workspace to store recordings against");
      const t = await beginUpload(db, { kind: "qual_recording", customerId: r.customerId, surveyId: r.surveyId, sessionId: r.sessionId, fileName: r.fileName, mimeType: r.mimeType, bytes: r.bytes, durationSeconds: r.durationSeconds, clientToken: r.clientToken, createdBy });
      return { ...t } as unknown as { mediaId: string } & Record<string, unknown>;
    },
    async resume(mediaId, bytes) { const t = await resumeUpload(db, mediaId, bytes); return { kind: t.kind, complete: t.alreadyStored || (t.kind === "multipart" && t.parts.length === 0), uploadUrl: t.uploadUrl, uploadId: t.uploadId, partBytes: t.partBytes, partCount: t.partCount, uploaded: t.uploaded, parts: t.parts }; },
    async confirm(mediaId, observed, parts) { const s = await confirmUpload(db, mediaId, observed, parts); return { bytes: s.bytes ?? null }; },
  };
}

/** the sandbox keeps chunks in a temp folder; the PUT address carries an HMAC so only an issued chunk can be written */
export const sandboxBlobKey = (mediaId: string) => createHmac("sha256", sandboxSecret()).update(`blob:${mediaId}`).digest("base64url").slice(0, 32);
export function sandboxChunkOps(putBase: string): ChunkMediaOps {
  return {
    async begin(r) {
      const mediaId = `sbx-${createHmac("sha256", sandboxSecret()).update(r.clientToken).digest("hex").slice(0, 24)}`;
      const already = sandboxBlobExists(mediaId);
      return { mediaId, kind: "single", uploadUrl: already ? null : `${putBase}?m=${mediaId}&k=${sandboxBlobKey(mediaId)}`, uploadHeaders: {}, uploadId: null, partBytes: 0, partCount: 1, parts: [], uploaded: [], alreadyStored: already };
    },
    async resume(mediaId) { return { kind: "single", complete: sandboxBlobExists(mediaId), uploadUrl: `${putBase}?m=${mediaId}&k=${sandboxBlobKey(mediaId)}`, uploadId: null, partBytes: 0, partCount: 1, uploaded: [], parts: [] }; },
    async confirm(mediaId) { const b = readSandboxBlob(mediaId); if (!b) throw Object.assign(new Error("The recording chunk did not reach the sandbox."), { status: 409 }); return { bytes: b.length }; },
  };
}

/** a store failure as the route's answer; a database without migration 0071 is named as such */
export function liveMigrationMissing(e: unknown): boolean {
  const m = String((e as Error)?.message ?? "");
  return /live_room|rescript_live_/.test(m) && /does not exist|schema cache|Could not find/i.test(m);
}
export const LIVE_MIGRATION_MESSAGE = "Live sessions need database migration 0071 (supabase/migrations/0071_live_sessions.sql). Apply it, then reload.";
