import {
  applyRoomOp, canSignal, checkSignals, consentRefusal, parseLiveOp, viewFor, LiveError, SIGNAL_TTL_MS,
  type LiveMember, type LiveRole, type LiveRoomState, type LiveSignal, type LiveView,
} from "./room.js";
import type { LiveTrack } from "./merge.js";

/**
 * LIVE SESSIONS OVER ANY STORE (2026-10-22, G2) — the orchestration both apps run: the respondent app
 * (participants and external observers, by their link) and the Studio (the moderator and member observers, after
 * the Studio's own access check). The Supabase store (`storeDb.ts`, migration 0071) and the in-memory store (the
 * Studio's sandbox, the tests) implement the same interface, so one code path is tested.
 *
 * CREDENTIALS. An invitation link carries a random-looking token derived by the Studio; a person joining gets a
 * MEMBER token for this tab. Only SHA-256 hashes of either are stored. Joining again with the same link (a reload,
 * a crash, a new device) takes the same place back with a fresh member token — that is reconnection — and the old
 * tab's token stops working.
 *
 * SIGNALLING is HTTP long-polling (Vercel-compatible; no websocket server): a member POSTs its connection messages
 * (`signal`) and long-polls (`poll`) for the messages addressed to it and for changes to the room. Messages live
 * for two minutes (`SIGNAL_TTL_MS`) and are swept.
 */

export interface LiveRoomRow { id: string; surveyId: string; customerId: string | null; state: LiveRoomState; version: number; rev: number; qualSessionId: string | null; transcriptId: string | null; createdAt?: string }
export type LiveInviteStatus = "pending" | "joined" | "no_show" | "revoked";
export interface LiveInvite { id: string; roomId: string; role: "participant" | "observer"; label?: string; email?: string; segment?: string; status: LiveInviteStatus; linkVersion: number; memberId?: string; remindedAt?: string; invitedAt?: string; createdAt: string }
export interface LiveNote { id: string; roomId: string; memberId: string; kind: "chat" | "note"; author: string; text: string; offsetSeconds: number | null; at: string }

export interface LiveStore {
  readonly kind: "memory" | "supabase";
  room(id: string): Promise<LiveRoomRow | null>;
  rooms(surveyId: string): Promise<LiveRoomRow[]>;
  insertRoom(r: { surveyId: string; customerId: string | null; state: LiveRoomState; userId?: string | null }): Promise<string>;
  /** compare-and-set on the version (bumps the rev too); false when someone else wrote first */
  saveRoom(id: string, state: LiveRoomState, expectedVersion: number): Promise<boolean>;
  link(id: string, patch: { qualSessionId?: string | null; transcriptId?: string | null }): Promise<void>;
  /** something about the room's people changed: wake the long-polls */
  touch(id: string): Promise<void>;
  members(roomId: string): Promise<LiveMember[]>;
  memberByHash(hash: string): Promise<LiveMember | null>;
  insertMember(m: Omit<LiveMember, "id">, tokenHash: string): Promise<LiveMember | "handle_taken">;
  updateMember(id: string, patch: Partial<LiveMember> & { tokenHash?: string }): Promise<void>;
  invites(roomId: string): Promise<LiveInvite[]>;
  inviteByHash(hash: string): Promise<LiveInvite | null>;
  insertInvite(i: Omit<LiveInvite, "id" | "createdAt" | "status" | "linkVersion">, tokenHashFor: (id: string, version: number) => string): Promise<LiveInvite>;
  updateInvite(id: string, patch: Partial<LiveInvite> & { tokenHash?: string }): Promise<void>;
  /** the room's rev and the signals to this member after a cursor */
  poll(roomId: string, memberId: string, after: number): Promise<{ rev: number; signals: LiveSignal[] }>;
  addSignals(roomId: string, from: string, list: { to: string; type: LiveSignal["type"]; payload: unknown }[], expiresAt: string): Promise<void>;
  sweepSignals(now: string): Promise<number>;
  notes(roomId: string): Promise<LiveNote[]>;
  addNote(n: Omit<LiveNote, "id">): Promise<LiveNote>;
  tracks(roomId: string): Promise<LiveTrack[]>;
  upsertTrack(t: Omit<LiveTrack, "id" | "status" | "transcript" | "error"> & { status?: LiveTrack["status"] }): Promise<LiveTrack>;
  updateTrack(id: string, patch: Partial<LiveTrack>): Promise<void>;
  /** one transcriber at a time per chunk: true when this caller holds it until `until` */
  claimTrack(id: string, now: string, until: string): Promise<boolean>;
}

export interface LiveDeps { now(): string; hash(token: string): string; newToken(): string; sleep(ms: number): Promise<void> }
export type LiveReply = { status: number; body: Record<string, unknown> };

const TOKEN = /^[A-Za-z0-9_-]{24,120}$/;
const err = (status: number, error: string, code?: string): LiveReply => ({ status, body: { error, ...(code ? { code } : {}) } });
const fromError = (e: unknown): LiveReply => { if (e instanceof LiveError) return err(e.status, e.message, e.code); throw e; };
export const nextHandle = (taken: readonly string[]) => { let n = 1; while (taken.includes(`P${n}`)) n++; return `P${n}`; };

/* ------------------------------------------------------------ joining */

/** a participant or an external observer joins from their invitation link (consent first — no consent, no room) */
export async function joinWithInvite(store: LiveStore, raw: unknown, deps: LiveDeps): Promise<LiveReply> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const link = String(b.invite ?? "");
  if (!TOKEN.test(link)) return err(404, "This link is not valid.", "no_invite");
  const invite = await store.inviteByHash(deps.hash(link));
  if (!invite || invite.status === "revoked") return err(404, "This link is not valid any more. Please contact the research team.", "no_invite");
  const row = await store.room(invite.roomId);
  if (!row) return err(404, "This session does not exist.", "no_room");
  const room = row.state;
  if (room.status === "ended" || room.status === "cancelled") return err(409, room.status === "ended" ? "This session has ended. Thank you." : "This session has been cancelled.", room.status);
  if (b.consent === undefined) return { status: 200, body: { ok: true, preview: true, ...joinPreview(room, invite.role) } };
  const consent = (b.consent && typeof b.consent === "object" ? b.consent : {}) as Record<string, unknown>;
  const refusal = consentRefusal(room, invite.role, consent);
  if (refusal) return err(refusal.status, refusal.message, refusal.code);
  const now = deps.now();
  const token = deps.newToken();
  const device = readDevice(b.device);
  const members = await store.members(row.id);
  const existing = invite.memberId ? members.find((m) => m.id === invite.memberId) : undefined;
  if (existing) {
    if (existing.state === "removed" || existing.state === "denied") return err(403, existing.state === "removed" ? "The moderator has removed you from this session." : "The moderator could not admit you to this session.", existing.state);
    const state = existing.state === "left" ? (invite.role === "observer" || !room.settings.waitingRoom ? "admitted" : "waiting") : existing.state;
    await store.updateMember(existing.id, { tokenHash: deps.hash(token), state, lastSeenAt: now, recordingConsent: consent.recording === true || existing.recordingConsent, ...(device ? { device } : {}) });
    await store.touch(row.id);
    return { status: 200, body: { ok: true, token, memberId: existing.id, role: existing.role, handle: existing.handle, rejoined: true } };
  }
  if (invite.role === "observer" && members.filter((m) => m.role === "observer" && m.state === "admitted").length >= room.settings.maxObservers) return err(409, "The back room is full.", "full");
  let added: LiveMember | "handle_taken" = "handle_taken";
  for (let attempt = 0; attempt < 5 && added === "handle_taken"; attempt++) {
    const taken = (await store.members(row.id)).map((m) => m.handle);
    const handle = invite.role === "observer" ? `Observer ${taken.filter((h) => h.startsWith("Observer")).length + 1 + attempt}` : nextHandle(taken);
    added = await store.insertMember({
      roomId: row.id, role: invite.role, handle, ...(invite.label ? { label: invite.label } : {}), ...(invite.segment ?? room.segment ? { segment: invite.segment ?? room.segment ?? undefined } : {}), inviteId: invite.id,
      state: invite.role === "observer" || (!room.settings.waitingRoom && (room.status === "open" || room.status === "live")) ? "admitted" : "waiting",
      consentAt: now, recordingConsent: invite.role === "participant" && consent.recording === true, joinedAt: now, lastSeenAt: now,
      media: { audio: invite.role === "participant", video: invite.role === "participant", screen: false }, mutedByModerator: false, ...(device ? { device } : {}),
    }, deps.hash(token));
  }
  if (added === "handle_taken") return err(503, "Too many people are joining at once — try again in a moment.", "busy");
  await store.updateInvite(invite.id, { status: "joined", memberId: added.id });
  await store.touch(row.id);
  return { status: 200, body: { ok: true, token, memberId: added.id, role: added.role, handle: added.handle } };
}

/** what the join page shows before anyone agrees: the title, the time, the consent text — nothing about anyone else */
export function joinPreview(room: LiveRoomState, role: "participant" | "observer") {
  return { role, title: room.title, kind: room.kind, status: room.status, scheduledAt: room.scheduledAt, timeZone: room.timeZone, durationMinutes: room.settings.durationMinutes, record: room.settings.record, recordVideo: room.settings.recordVideo, consent: role === "participant" ? room.consent : null };
}

function readDevice(v: unknown): LiveMember["device"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  return { camera: o.camera === true, microphone: o.microphone === true };
}

/** the moderator or a member observer joins from the Studio (the Studio checked their access first) */
export async function joinStaff(store: LiveStore, row: LiveRoomRow, who: { role: "moderator" | "observer"; userId: string; name: string }, deps: LiveDeps): Promise<LiveReply> {
  const room = row.state;
  if (room.status === "cancelled") return err(409, "This session has been cancelled.", "cancelled");
  const now = deps.now();
  const token = deps.newToken();
  const members = await store.members(row.id);
  /* one moderator seat: a second researcher opening the console takes it over (the first console is told) */
  const mine = who.role === "moderator" ? members.find((m) => m.role === "moderator") : members.find((m) => m.role === "observer" && m.userId === who.userId);
  if (mine) {
    await store.updateMember(mine.id, { tokenHash: deps.hash(token), state: "admitted", userId: who.userId, label: who.name.slice(0, 120), lastSeenAt: now });
    await store.touch(row.id);
    return { status: 200, body: { ok: true, token, memberId: mine.id, role: who.role, handle: mine.handle } };
  }
  if (who.role === "observer" && members.filter((m) => m.role === "observer" && m.state === "admitted").length >= room.settings.maxObservers) return err(409, `The back room is full (${room.settings.maxObservers} observers on the built-in connection).`, "full");
  const handle = who.role === "moderator" ? "Moderator" : `Observer ${members.filter((m) => m.role === "observer").length + 1}`;
  const added = await store.insertMember({ roomId: row.id, role: who.role, handle, label: who.name.slice(0, 120), userId: who.userId, state: "admitted", recordingConsent: who.role === "moderator", consentAt: now, joinedAt: now, lastSeenAt: now, media: { audio: who.role === "moderator", video: who.role === "moderator", screen: false }, mutedByModerator: false }, deps.hash(token));
  if (added === "handle_taken") return err(409, "Someone else joined at the same moment — try again.", "busy");
  await store.touch(row.id);
  return { status: 200, body: { ok: true, token, memberId: added.id, role: who.role, handle: added.handle } };
}

/* ------------------------------------------------------------ a member's requests */

/**
 * One request from a member holding a member token: { action: "poll" | "signal" | "op" | "chat" | "note" | "view", token, … }.
 * `allowRoles` lets an app refuse roles it does not serve (the respondent app never serves the moderator).
 */
export async function memberAction(store: LiveStore, raw: unknown, deps: LiveDeps, opts: { allowRoles?: LiveRole[]; onPoll?: (row: LiveRoomRow, member: LiveMember) => Promise<Record<string, unknown> | void> } = {}): Promise<LiveReply> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const token = String(b.token ?? "");
  if (!TOKEN.test(token)) return err(401, "Join the session first.", "not_joined");
  let me = await store.memberByHash(deps.hash(token));
  if (!me) return err(401, "This tab is no longer in the session (you may have joined from another tab). Reload to join again.", "not_joined");
  if (opts.allowRoles && !opts.allowRoles.includes(me.role)) return err(403, "Not here.", "forbidden");
  let row = await store.room(me.roomId);
  if (!row) return err(404, "This session does not exist.", "no_room");
  const now = deps.now();
  const nowMs = Date.parse(now);
  if (!me.lastSeenAt || nowMs - Date.parse(me.lastSeenAt) > 5000) { await store.updateMember(me.id, { lastSeenAt: now }); me = { ...me, lastSeenAt: now }; }
  const action = String(b.action ?? "view");
  try {
    switch (action) {
      case "signal": {
        if (me.state !== "admitted") return err(409, "You are not in the room yet.", "not_in_room");
        const members = await store.members(row.id);
        const c = checkSignals(row.state, members, me, b.signals);
        if (c.error) return err(400, c.error, "invalid");
        if (c.ok.length) await store.addSignals(row.id, me.id, c.ok, new Date(nowMs + SIGNAL_TTL_MS).toISOString());
        return { status: 200, body: { ok: true, sent: c.ok.length, refused: c.refused } };
      }
      case "op": {
        const op = parseLiveOp(b.op);
        if (typeof op === "string") return err(400, op, "invalid");
        for (let attempt = 0; attempt < 4; attempt++) {
          const members = await store.members(row.id);
          const fresh = members.find((m) => m.id === me!.id) ?? me;
          const r = applyRoomOp(row.state, members, fresh, op, now);
          if (r.roomChanged && !(await store.saveRoom(row.id, r.room, row.version))) { row = (await store.room(row.id)) ?? row; continue; }
          for (const p of r.patches) await store.updateMember(p.memberId, p.patch);
          /* a removed or denied person's link stops working; a no-show is decided at the end */
          if (op.op === "remove" || op.op === "deny") { const t = members.find((m) => m.id === (op as { member: string }).member); if (t?.inviteId) await store.updateInvite(t.inviteId, { status: "revoked" }); }
          if (!r.roomChanged || r.patches.length) await store.touch(row.id);
          return { status: 200, body: { ok: true, detail: r.detail } };
        }
        return err(409, "The room kept changing — try again.", "version_conflict");
      }
      case "chat": case "note": {
        /* the back room: the moderator and observers only — a participant can neither write nor read it */
        if (me.role === "participant") return err(403, "Not here.", "forbidden");
        const text = String(b.text ?? "").replace(/\r/g, "").trim().slice(0, 2000);
        if (!text) return err(400, "Write something first.", "invalid");
        const started = row.state.startedAt ? Date.parse(row.state.startedAt) : NaN;
        const offset = Number.isFinite(started) ? Math.max(0, Math.round((nowMs - started) / 1000)) : null;
        const n = await store.addNote({ roomId: row.id, memberId: me.id, kind: action, author: me.role === "moderator" ? "Moderator" : me.label || me.handle, text, offsetSeconds: offset, at: now });
        await store.touch(row.id);
        return { status: 200, body: { ok: true, note: n } };
      }
      case "poll": case "view": {
        const after = Math.max(0, Math.floor(Number(b.after) || 0));
        const known = Number.isFinite(Number(b.rev)) ? Number(b.rev) : -1;
        const wait = action === "poll" ? Math.max(0, Math.min(8000, Number(b.wait) || 0)) : 0;
        const step = store.kind === "memory" ? 250 : 600;
        const started = Date.parse(deps.now());
        let p = await store.poll(row.id, me.id, after);
        while (!p.signals.length && p.rev === known && Date.parse(deps.now()) - started < wait) { await deps.sleep(step); p = await store.poll(row.id, me.id, after); }
        row = (await store.room(row.id)) ?? row;
        const members = await store.members(row.id);
        const self = members.find((m) => m.id === me!.id) ?? me;
        if (self.state === "removed") return { status: 200, body: { ok: true, gone: "removed", view: viewFor(row.state, members, self, Date.parse(deps.now())), rev: p.rev, cursor: after, signals: [], serverNow: deps.now() } };
        const view: LiveView = viewFor(row.state, members, self, Date.parse(deps.now()));
        const extra: Record<string, unknown> = {};
        if (self.role !== "participant") {
          const notes = await store.notes(row.id);
          extra.chat = notes.filter((n) => n.kind === "chat").slice(-100);
          extra.notes = notes.filter((n) => n.kind === "note").slice(-200);
        }
        if (opts.onPoll) Object.assign(extra, (await opts.onPoll(row, self)) ?? {});
        /* signals only flow between people who may connect now (a removed peer's late answer is dropped) */
        const ok = p.signals.filter((s) => canSignal(row!.state, members.find((m) => m.id === s.from), self));
        const cursor = p.signals.reduce((n, s) => Math.max(n, s.id), after);
        if (Math.random() < 0.05) void store.sweepSignals(deps.now()).catch(() => 0);
        return { status: 200, body: { ok: true, view, signals: ok, cursor, rev: p.rev, serverNow: deps.now(), ...extra } };
      }
      default: return err(400, "unknown action", "invalid");
    }
  } catch (e) { return fromError(e); }
}

/** may this member upload a recording chunk now? (consent, the room recording, live — or just ended, for the last chunk) */
export function chunkRefusal(row: LiveRoomRow, me: LiveMember, kind: "audio" | "video", nowMs: number): LiveError | null {
  const r = row.state;
  if (!r.settings.record) return new LiveError(403, "This session is not recorded.", "not_recorded");
  if (kind === "video" && !r.settings.recordVideo) return new LiveError(403, "Video is not recorded in this session.", "not_recorded");
  if (me.role === "observer") return new LiveError(403, "Observers are not recorded.", "forbidden");
  if (me.role === "participant" && !me.recordingConsent) return new LiveError(403, "You did not agree to the recording, so nothing is recorded.", "no_consent");
  if (me.state !== "admitted" && !(me.state === "left" || me.state === "removed")) return new LiveError(403, "You are not in the room.", "not_in_room");
  const endedRecently = r.status === "ended" && r.endedAt && nowMs - Date.parse(r.endedAt) < 15 * 60_000;
  if (r.status !== "live" && !endedRecently) return new LiveError(409, "The session is not running.", "status");
  return null;
}

/** the chunk's place in the session, from what the browser says (bounded) */
export function readChunk(b: Record<string, unknown>): { kind: "audio" | "video"; seq: number; startMs: number; durationMs: number } | string {
  const kind = b.track === "video" ? "video" : b.track === "audio" || b.track === undefined ? "audio" : null;
  const seq = Math.floor(Number(b.seq));
  const startMs = Math.floor(Number(b.startMs));
  const durationMs = Math.floor(Number(b.durationMs ?? b.durationSeconds));
  if (!kind || !Number.isInteger(seq) || seq < 0 || seq > 100_000) return "which chunk (seq)";
  if (!Number.isFinite(startMs) || startMs < 1_600_000_000_000) return "when the chunk started (startMs)";
  return { kind, seq, startMs, durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.min(durationMs, 10 * 60_000) : 0 };
}

/* ------------------------------------------------------------ an in-memory store (the Studio's sandbox, the tests) */

export interface MemoryLiveStore extends LiveStore {
  dump(): unknown;
  load(snapshot: unknown): void;
}

export function memoryLiveStore(): MemoryLiveStore {
  let rooms = new Map<string, LiveRoomRow>();
  let members: (LiveMember & { tokenHash: string })[] = [];
  let invites: (LiveInvite & { tokenHash: string })[] = [];
  let signals: (LiveSignal & { roomId: string; expiresAt: string })[] = [];
  let notes: LiveNote[] = [];
  let tracks: (LiveTrack & { leaseUntil?: string })[] = [];
  let seq = 0;
  let n = 0;
  const id = (p: string) => `${p}-${(++n).toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const c = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const strip = <T extends { tokenHash?: string }>(x: T) => { const { tokenHash: _t, ...rest } = x; void _t; return c(rest); };
  return {
    kind: "memory",
    dump: () => ({ rooms: [...rooms.values()], members, invites, signals, notes, tracks, seq }),
    load(s) {
      const o = (s ?? {}) as Record<string, unknown>;
      rooms = new Map(((o.rooms ?? []) as LiveRoomRow[]).map((r) => [r.id, r]));
      members = (o.members ?? []) as typeof members; invites = (o.invites ?? []) as typeof invites; signals = (o.signals ?? []) as typeof signals; notes = (o.notes ?? []) as LiveNote[]; tracks = (o.tracks ?? []) as typeof tracks; seq = Number(o.seq) || 0;
    },
    async room(rid) { const r = rooms.get(rid); return r ? c(r) : null; },
    async rooms(sid) { return [...rooms.values()].filter((r) => r.surveyId === sid).map(c); },
    async insertRoom(r) { const rid = id("room"); rooms.set(rid, { id: rid, surveyId: r.surveyId, customerId: r.customerId, state: c({ ...r.state, id: rid }), version: 0, rev: 0, qualSessionId: null, transcriptId: null, createdAt: new Date().toISOString() }); return rid; },
    async saveRoom(rid, state, expected) { const r = rooms.get(rid); if (!r || r.version !== expected) return false; rooms.set(rid, { ...r, state: c(state), version: expected + 1, rev: r.rev + 1 }); return true; },
    async link(rid, patch) { const r = rooms.get(rid); if (r) rooms.set(rid, { ...r, ...(patch.qualSessionId !== undefined ? { qualSessionId: patch.qualSessionId } : {}), ...(patch.transcriptId !== undefined ? { transcriptId: patch.transcriptId } : {}) }); },
    async touch(rid) { const r = rooms.get(rid); if (r) r.rev++; },
    async members(rid) { return members.filter((m) => m.roomId === rid).map(strip); },
    async memberByHash(h) { const m = members.find((x) => x.tokenHash === h); return m ? strip(m) : null; },
    async insertMember(m, h) { if (members.some((x) => x.roomId === m.roomId && x.handle === m.handle)) return "handle_taken"; const row = { ...c(m), id: id("m"), tokenHash: h }; members.push(row); return strip(row); },
    async updateMember(mid, patch) { const m = members.find((x) => x.id === mid); if (m) Object.assign(m, c(patch)); },
    async invites(rid) { return invites.filter((i) => i.roomId === rid).map(strip); },
    async inviteByHash(h) { const i = invites.find((x) => x.tokenHash === h); return i ? strip(i) : null; },
    async insertInvite(i, hashFor) { const iid = id("inv"); const row = { ...c(i), id: iid, status: "pending" as const, linkVersion: 1, createdAt: new Date().toISOString(), tokenHash: hashFor(iid, 1) }; invites.push(row); return strip(row); },
    async updateInvite(iid, patch) { const i = invites.find((x) => x.id === iid); if (i) Object.assign(i, c(patch)); },
    async poll(rid, mid, after) { return { rev: rooms.get(rid)?.rev ?? 0, signals: signals.filter((s) => s.roomId === rid && s.to === mid && s.id > after).map(({ roomId: _r, expiresAt: _e, ...s }) => { void _r; void _e; return c(s); }) }; },
    async addSignals(rid, from, list, expiresAt) { const at = new Date().toISOString(); for (const s of list) signals.push({ id: ++seq, roomId: rid, from, to: s.to, type: s.type, payload: c(s.payload), at, expiresAt }); },
    async sweepSignals(now) { const before = signals.length; signals = signals.filter((s) => s.expiresAt > now); return before - signals.length; },
    async notes(rid) { return notes.filter((x) => x.roomId === rid).map(c); },
    async addNote(x) { const row = { ...c(x), id: id("n") }; notes.push(row); return c(row); },
    async tracks(rid) { return tracks.filter((t) => t.roomId === rid).map(({ leaseUntil: _l, ...t }) => { void _l; return c(t); }); },
    async upsertTrack(t) {
      const ex = tracks.find((x) => x.roomId === t.roomId && x.memberId === t.memberId && x.kind === t.kind && x.seq === t.seq);
      if (ex) { Object.assign(ex, c({ ...t, status: t.status ?? ex.status })); return c(ex); }
      const row = { ...c(t), id: id("t"), status: t.status ?? "uploading", transcript: null, error: null } as LiveTrack;
      tracks.push(row); return c(row);
    },
    async updateTrack(tid, patch) { const t = tracks.find((x) => x.id === tid); if (t) Object.assign(t, c(patch)); },
    async claimTrack(tid, now, until) { const t = tracks.find((x) => x.id === tid); if (!t || (t.leaseUntil && t.leaseUntil > now)) return false; t.leaseUntil = until; return true; },
  };
}
