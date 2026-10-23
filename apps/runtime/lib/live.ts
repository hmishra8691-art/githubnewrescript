import "server-only";
import { NextResponse } from "next/server";
import { beginUpload, confirmUpload, resumeUpload, type MediaDb } from "@rescript/media";
import { supabaseLiveStore, type ChunkMediaOps, type LiveDeps, type LiveMember, type LiveRoomRow, type LiveStore } from "@rescript/analytics/live";
import { iceServersFor, livekitConfig, livekitToken, newMemberToken, sha256Hex } from "@rescript/analytics/live/server";
import { supabaseAdmin } from "@/lib/admin";

/**
 * LIVE SESSIONS — THE RESPONDENT APP'S SERVER HALF (2026-10-22, G2). Participants and external observers join a
 * live session from their own link (`/live/<token>`); the room logic is `@rescript/analytics/live`, the same code
 * the Studio runs, over the same 0071 tables (service role, after checking the person's member token).
 *
 * Without a database (a developer machine running the Studio's sandbox against the FAKE provider, never in
 * production) every request is forwarded server-to-server to the Studio's sandbox, whose address comes from the
 * environment only (STUDIO_SANDBOX_URL, default http://localhost:3000).
 */

export const liveDeps: LiveDeps = { now: () => new Date().toISOString(), hash: sha256Hex, newToken: newMemberToken, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
export const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
export const hasDatabase = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
export const sandboxForwarding = () => !hasDatabase() && process.env.AI_API_URL === "fake:" && process.env.NODE_ENV !== "production";
export const studioSandbox = () => (process.env.STUDIO_SANDBOX_URL ?? "http://localhost:3000").replace(/\/+$/, "");
export const liveStore = (): LiveStore => supabaseLiveStore(supabaseAdmin() as never);

/** a forwarded request to the Studio's sandbox (fake provider, no database) */
export async function forward(path: string, body: Record<string, unknown>): Promise<NextResponse> {
  try {
    const r = await fetch(`${studioSandbox()}/api/surveys/sandbox/qual/live${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, via: "runtime" }), cache: "no-store", signal: AbortSignal.timeout(30_000) });
    return reply(await r.json().catch(() => ({ error: "the sandbox did not answer" })), r.status);
  } catch { return reply({ error: "The session service is not reachable — trying again." }, 503); }
}

/** ICE servers (TURN credentials minted for this person) and, for an SFU room once admitted, a LiveKit token */
export async function connectionFor(row: LiveRoomRow, member: Pick<LiveMember, "id" | "role" | "handle" | "state">) {
  const ice = await iceServersFor(process.env, { identity: member.id });
  const lk = row.state.settings.transport === "sfu" ? livekitConfig(process.env) : null;
  return {
    iceServers: ice.iceServers, turn: ice.turn, ...(ice.warning ? { warning: ice.warning } : {}),
    ...(lk && member.state === "admitted" ? { livekit: { url: lk.url, clientUrl: lk.clientUrl, token: livekitToken(lk, { identity: member.id, name: member.handle, room: row.id, canPublish: member.role !== "observer", hidden: member.role === "observer" }) } } : {}),
  };
}

/** the media pipeline for a participant's chunks (private bucket, kind qual_recording, resumable, verified) */
export function mediaChunkOps(db: MediaDb): ChunkMediaOps {
  return {
    async begin(r) {
      if (!r.customerId) throw new Error("this session has no workspace to store recordings against");
      const t = await beginUpload(db, { kind: "qual_recording", customerId: r.customerId, surveyId: r.surveyId, sessionId: r.sessionId, fileName: r.fileName, mimeType: r.mimeType, bytes: r.bytes, durationSeconds: r.durationSeconds, clientToken: r.clientToken });
      return { ...t } as unknown as { mediaId: string } & Record<string, unknown>;
    },
    async resume(mediaId, bytes) { const t = await resumeUpload(db, mediaId, bytes); return { kind: t.kind, complete: t.alreadyStored || (t.kind === "multipart" && t.parts.length === 0), uploadUrl: t.uploadUrl, uploadId: t.uploadId, partBytes: t.partBytes, partCount: t.partCount, uploaded: t.uploaded, parts: t.parts }; },
    async confirm(mediaId, observed, parts) { const s = await confirmUpload(db, mediaId, observed, parts); return { bytes: s.bytes ?? null }; },
  };
}
