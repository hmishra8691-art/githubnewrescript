"use client";
import type { RecordedChunk, LiveSettings, LiveStimulus, LiveSectionPlan } from "@rescript/analytics/live";
import { QualApiError } from "./qualApi";

/**
 * LIVE SESSIONS — THE STUDIO'S CLIENT (2026-10-22, G2): the management route (`qual/live`), the room route for the
 * console (`qual/live/room`, member token) and the console's own chunk uploads (`qual/live/media/*`, through the
 * existing resumable RecordingUploader). The same calls for a saved project and the sandbox (`surveys/sandbox`).
 */

export interface LiveRoomSummary {
  id: string; title: string; kind: "focus_group" | "interview"; status: string; scheduledAt: string | null; timeZone: string | null; segment: string | null; settings: LiveSettings;
  startedAt: string | null; endedAt: string | null; qualSessionId: string | null; transcriptId: string | null; problems: string[];
  counts: { invited: number; joined: number; inRoom: number; waiting: number; noShow: number; observers: number };
}
export interface LiveInviteView { id: string; role: "participant" | "observer"; status: string; segment: string | null; label: string | null; email: string | null; remindedAt: string | null; invitedAt: string | null; memberId: string | null; link?: string }
export interface LiveTransport { mesh: { maxParticipants: number }; turn: "rest" | "static" | "none"; turnWarning?: string; sfu: boolean; sfuClient: boolean }
export interface LiveList { rooms: LiveRoomSummary[]; transport: LiveTransport; mail: { configured: boolean }; can: { manage: boolean; pii: boolean }; sandbox: boolean }
export interface LiveDetail extends Omit<LiveList, "rooms"> {
  room: LiveRoomSummary; stimuli: LiveStimulus[]; sections: LiveSectionPlan[]; consent: { statement: string; recordingDisclosure: string; dataUse: string };
  invites: LiveInviteView[]; people: { id: string; role: string; handle: string; label?: string; segment: string | null; state: string; recordingConsent: boolean; joinedAt: string }[];
  recording: { chunks: number; transcribed: number; stored: number; uploading: number; failed: number; empty: number; people: { handle: string; chunks: number; transcribed: number }[] };
  chat: { id: string; author: string; text: string; offsetSeconds: number | null; at: string }[]; notes: { id: string; author: string; text: string; offsetSeconds: number | null; at: string }[];
}
export interface JoinResult { token: string; memberId: string; role: "moderator" | "observer"; handle: string; connection: { iceServers: RTCIceServer[]; turn: string; warning?: string; livekit?: { url: string; clientUrl: string | null; token: string } } }

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok && r.status !== 202) throw Object.assign(new QualApiError(String(j.error ?? `The request failed (${r.status}).`), r.status, j.code as string | undefined), { body: j });
  return j as T;
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function liveApi(surveyId: string) {
  const base = `/api/surveys/${surveyId}/qual/live`;
  return {
    list: () => call<LiveList>(base),
    detail: (id: string) => call<LiveDetail>(`${base}?id=${encodeURIComponent(id)}`),
    schedule: (sessions: Record<string, unknown>[], guide?: unknown) => call<{ rooms: (LiveRoomSummary & { invites: LiveInviteView[] })[] }>(base, post({ action: "schedule", sessions, ...(guide !== undefined ? { guide } : {}) })),
    update: (id: string, patch: Record<string, unknown>) => call(base, post({ action: "update", id, ...patch })),
    cancel: (id: string) => call(base, post({ action: "cancel", id })),
    invite: (id: string, role: "participant" | "observer", opts: { count?: number; people?: { label?: string; email?: string; segment?: string }[] }) => call<{ invites: LiveInviteView[] }>(base, post({ action: "invite", id, role, ...opts })),
    revoke: (id: string, inviteId: string) => call(base, post({ action: "revoke", id, inviteId })),
    relink: (id: string, inviteId: string) => call(base, post({ action: "relink", id, inviteId })),
    send: (id: string, kind: "invite" | "reminder") => call<{ sent: number; results: { id: string; sent: boolean; reason?: string }[] }>(base, post({ action: "send", id, kind })),
    join: (id: string, role: "moderator" | "observer") => call<JoinResult>(base, post({ action: "join", id, role })),
    /** finalize answers 202 { continue } while chunks are still being transcribed: keep calling */
    async finalize(id: string, onProgress?: (p: unknown) => void): Promise<Record<string, unknown>> {
      for (let i = 0; i < 120; i++) {
        const r = await call<Record<string, unknown>>(base, post({ action: "finalize", id }));
        if (!r.continue) return r;
        onProgress?.(r.progress);
        await new Promise((ok) => setTimeout(ok, 1500));
      }
      throw new QualApiError("The recordings are still being transcribed — press Finalize again in a minute.", 202);
    },
    /** the room route, for one console's member token */
    roomCall: (token: string) => async (body: Record<string, unknown>) => {
      const r = await fetch(`${base}/room`, { ...post({ ...body, token }), cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw Object.assign(new Error(String(j.error ?? `HTTP ${r.status}`)), { code: j.code, status: r.status });
      return j;
    },
    /** the console's own recorded chunk, through the existing resumable uploader */
    uploader: (token: string) => async (c: RecordedChunk) => {
      const { RecordingUploader } = await import("@rescript/storage/uploader");
      const up = new RecordingUploader({
        endpoints: { begin: `${base}/media/ticket`, parts: `${base}/media/parts`, complete: `${base}/media/confirm` },
        token, mimeType: c.mimeType, estimatedBytes: c.blob.size, clientToken: `live:${c.track}:${c.seq}`,
        beginExtra: { track: c.track, seq: c.seq, startMs: c.startMs, durationMs: c.durationMs }, completeExtra: { track: c.track, seq: c.seq },
        onState: () => {},
      });
      await up.begin();
      up.push(c.blob);
      const out = await up.finish(Math.round(c.durationMs / 1000));
      if (!out.ok) throw new Error(out.error);
    },
  };
}
export type LiveApi = ReturnType<typeof liveApi>;

/** a local date-time input value (YYYY-MM-DDTHH:mm) in a time zone → ISO instant */
export function zonedInputToIso(value: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = (at: number) => {
    const p: Record<string, number> = {};
    for (const x of new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at))) if (x.type !== "literal") p[x.type] = Number(x.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
  };
  try { let t = guess - off(guess); t = guess - off(t); return new Date(t).toISOString(); } catch { return null; }
}

export function formatWhen(iso: string | null, tz: string | null): string {
  if (!iso) return "no time set";
  try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz || undefined, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso)); } catch { return iso; }
}
