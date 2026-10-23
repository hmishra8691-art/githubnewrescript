/**
 * LIVE HUMAN-MODERATED SESSIONS — THE ROOM (2026-10-22, G2).
 *
 * A live focus group or in-depth interview run in the browser: a MODERATOR (a researcher, from the Studio),
 * PARTICIPANTS (from their own join link, in the respondent app) and silent OBSERVERS (the "back room": project
 * members from the Studio, or a client from an observer link) whom participants never see — not in the roster,
 * not as a peer connection (observers receive the room relayed through the moderator's browser), not in any
 * reply a participant's browser gets.
 *
 * This file is the pure part: the room's state, who may do what (`applyRoomOp`), who may connect to whom
 * (`canSignal`), what each role is told (`viewFor`), and the validation of what the Studio sends when it
 * schedules a session. I/O is the store's (`service.ts`); media is the browser's (`client.ts`).
 */

export type LiveRole = "moderator" | "participant" | "observer";
export type LiveRoomStatus = "scheduled" | "open" | "live" | "ended" | "cancelled";
export type LiveMemberState = "waiting" | "admitted" | "left" | "removed" | "denied";
export type LiveTransport = "mesh" | "sfu";

export interface LiveSettings {
  maxParticipants: number;
  maxObservers: number;
  record: boolean;
  recordVideo: boolean;
  /** each recording chunk is a standalone file of this many seconds */
  chunkSeconds: number;
  assist: boolean;
  transport: LiveTransport;
  waitingRoom: boolean;
  durationMinutes: number;
}
export interface LiveStimulus { id: string; name: string; kind: "image" | "video" | "concept"; url?: string; text?: string }
export interface LiveSectionPlan { id: string; title: string; minutes: number }
export interface LiveGuideQuestion { id: string; sectionId: string; text: string }
export interface LiveConsent { statement: string; recordingDisclosure: string; dataUse: string }
export interface LiveStage { stimulusId: string | null; spotlight: string | null; section: { id: string; startedAt: string; minutes: number } | null }
export interface LiveLogEntry { at: string; by: string; op: string; detail: string }

export interface LiveRoomState {
  id: string;
  title: string;
  kind: "focus_group" | "interview";
  status: LiveRoomStatus;
  scheduledAt: string | null;
  timeZone: string | null;
  segment: string | null;
  settings: LiveSettings;
  consent: LiveConsent;
  stimuli: LiveStimulus[];
  sections: LiveSectionPlan[];
  questions: LiveGuideQuestion[];
  objectives: string[];
  openedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  stage: LiveStage;
  log: LiveLogEntry[];
}

export interface LiveMember {
  id: string;
  roomId: string;
  role: LiveRole;
  /** P1, P2 … for participants (all anyone else sees of them); "Moderator"; "Observer n" */
  handle: string;
  /** the invite's label or the staff member's name — shown to the moderator and observers only */
  label?: string;
  state: LiveMemberState;
  segment?: string;
  inviteId?: string;
  userId?: string;
  consentAt?: string;
  recordingConsent: boolean;
  joinedAt: string;
  lastSeenAt?: string;
  media: { audio: boolean; video: boolean; screen: boolean };
  mutedByModerator: boolean;
  device?: { camera: boolean; microphone: boolean };
}

export class LiveError extends Error { constructor(readonly status: number, message: string, readonly code?: string) { super(message); } }

/** the built-in mesh: every sender uploads one stream per peer, so it stays small */
export const MESH_MAX_PARTICIPANTS = 6;
export const MESH_MAX_OBSERVERS = 3;
export const SFU_MAX_PARTICIPANTS = 30;
export const SFU_MAX_OBSERVERS = 20;
/** a member not heard from for this long is shown as reconnecting; peers tear the connection down (a slow server makes polls late: generous) */
export const ONLINE_MS = 45_000;
const LOG_MAX = 300;

/* ------------------------------------------------------------ scheduling input */

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown, lo: number, hi: number, dflt: number): number => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const safeUrl = (u: unknown): string | undefined => { const s = str(u, 2000); return s && /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : undefined; };

export function readSettings(v: unknown, opts: { sfuAvailable?: boolean } = {}): LiveSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const transport: LiveTransport = o.transport === "sfu" && opts.sfuAvailable ? "sfu" : "mesh";
  const maxP = transport === "sfu" ? SFU_MAX_PARTICIPANTS : MESH_MAX_PARTICIPANTS;
  const maxO = transport === "sfu" ? SFU_MAX_OBSERVERS : MESH_MAX_OBSERVERS;
  return {
    maxParticipants: int(o.maxParticipants, 1, maxP, Math.min(6, maxP)),
    maxObservers: int(o.maxObservers, 0, maxO, Math.min(3, maxO)),
    record: o.record !== false,
    recordVideo: o.recordVideo === true,
    chunkSeconds: int(o.chunkSeconds, 5, 120, 30),
    assist: o.assist !== false,
    transport,
    waitingRoom: o.waitingRoom !== false,
    durationMinutes: int(o.durationMinutes, 15, 240, 90),
  };
}

/** the guide's parts a room needs, snapshotted when it is scheduled (editing the guide later never changes a booked room) */
export function guideSnapshot(guide: unknown): { consent: LiveConsent; stimuli: LiveStimulus[]; sections: LiveSectionPlan[]; questions: LiveGuideQuestion[]; objectives: string[]; kind: "focus_group" | "interview" | null } {
  const g = (guide && typeof guide === "object" ? guide : {}) as Record<string, unknown>;
  const c = (g.consent && typeof g.consent === "object" ? g.consent : {}) as Record<string, unknown>;
  const sections = (Array.isArray(g.sections) ? g.sections : []) as Record<string, unknown>[];
  const stimuli: LiveStimulus[] = [];
  const seen = new Set<string>();
  const aiStimuli = (((g.aiModeration as Record<string, unknown> | undefined)?.stimuli) ?? []) as Record<string, unknown>[];
  const byName = new Map(aiStimuli.map((s) => [String(s.name ?? "").toLowerCase(), s]));
  const addStim = (raw: unknown) => {
    const s = (typeof raw === "string" ? { name: raw } : raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
    if (!s) return;
    const name = str(s.name ?? s.title ?? s.label, 120);
    if (!name || seen.has(name.toLowerCase())) return;
    const rich = byName.get(name.toLowerCase()) ?? s;
    const url = safeUrl(rich.url ?? rich.src);
    const text = str(rich.text ?? rich.description ?? rich.body, 4000);
    const kind = rich.kind === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(url ?? "") ? "video" : url ? "image" : "concept";
    seen.add(name.toLowerCase());
    stimuli.push({ id: `st${stimuli.length + 1}`, name, kind, ...(url ? { url } : {}), ...(text || !url ? { text: text ?? name } : {}) });
  };
  for (const s of sections) for (const x of (Array.isArray(s.stimuli) ? s.stimuli : [])) addStim(x);
  for (const x of aiStimuli) addStim(x);
  const plan: LiveSectionPlan[] = sections.map((s, i) => ({ id: str(s.id, 40) ?? `s${i + 1}`, title: str(s.title, 160) ?? `Section ${i + 1}`, minutes: int(s.minutes ?? s.durationMinutes, 1, 240, 10) }));
  const questions: LiveGuideQuestion[] = sections.flatMap((s, i) => (Array.isArray(s.questions) ? s.questions : []).map((q: Record<string, unknown>, k: number) => ({ id: str(q.id, 40) ?? `s${i + 1}q${k + 1}`, sectionId: plan[i].id, text: str(q.text, 600) ?? "" })).filter((q) => q.text));
  return {
    consent: { statement: str(c.statement, 4000) ?? "", recordingDisclosure: str(c.recordingDisclosure ?? c.recording, 4000) ?? "", dataUse: str(c.dataUse, 4000) ?? "" },
    stimuli: stimuli.slice(0, 40), sections: plan.slice(0, 40), questions: questions.slice(0, 200),
    objectives: (Array.isArray(g.objectives) ? g.objectives : []).map((o) => str(o, 400)).filter((o): o is string => !!o).slice(0, 20),
    kind: g.kind === "focus_group" ? "focus_group" : g.kind === "interview" ? "interview" : null,
  };
}

export interface ScheduleInput { title: string; kind: "focus_group" | "interview"; scheduledAt: string | null; timeZone: string | null; segment: string | null; settings: LiveSettings }

/** a session the Studio asks to schedule — or the sentence that says what is wrong */
export function readScheduleInput(raw: unknown, opts: { sfuAvailable?: boolean; now?: number } = {}): { ok: true; value: ScheduleInput } | { ok: false; error: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const title = str(o.title, 200);
  if (!title) return { ok: false, error: "Give the session a title." };
  let scheduledAt: string | null = null;
  if (o.scheduledAt != null && o.scheduledAt !== "") {
    const t = Date.parse(String(o.scheduledAt));
    if (!Number.isFinite(t)) return { ok: false, error: "The session time is not a date." };
    scheduledAt = new Date(t).toISOString();
  }
  const settings = readSettings({ ...o, ...((o.settings && typeof o.settings === "object" ? o.settings : {}) as Record<string, unknown>) }, opts);
  if (o.transport === "sfu" && !opts.sfuAvailable) return { ok: false, error: "LiveKit is not configured on this installation (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) — the session uses the built-in connection, which carries at most 6 participants." };
  const asked = Number((o.settings as Record<string, unknown> | undefined)?.maxParticipants ?? o.maxParticipants);
  if (Number.isFinite(asked) && asked > settings.maxParticipants) return { ok: false, error: settings.transport === "mesh" ? `The built-in browser connection carries at most ${MESH_MAX_PARTICIPANTS} participants (each browser sends its video to every other); for ${asked} configure LiveKit (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).` : `At most ${SFU_MAX_PARTICIPANTS} participants.` };
  const tz = str(o.timeZone, 64) ?? null;
  return { ok: true, value: { title, kind: o.kind === "interview" ? "interview" : "focus_group", scheduledAt, timeZone: tz, segment: str(o.segment, 120) ?? null, settings } };
}

export function newRoomState(id: string, input: ScheduleInput, guide: unknown): LiveRoomState {
  const g = guideSnapshot(guide);
  return {
    id, title: input.title, kind: input.kind, status: "scheduled", scheduledAt: input.scheduledAt, timeZone: input.timeZone, segment: input.segment,
    settings: input.settings, consent: g.consent, stimuli: g.stimuli, sections: g.sections, questions: g.questions, objectives: g.objectives,
    openedAt: null, startedAt: null, endedAt: null, stage: { stimulusId: null, spotlight: null, section: null }, log: [],
  };
}

/** what must be true before anyone can join (a consent statement; a recording disclosure when recording) */
export function joinProblems(room: LiveRoomState): string[] {
  const out: string[] = [];
  if (!room.consent.statement.trim()) out.push("The guide has no consent statement — add one (Guide tab or Intelligent Mode) before inviting participants.");
  if (room.settings.record && !room.consent.recordingDisclosure.trim()) out.push("The session is recorded but the guide has no recording disclosure — participants must be told before they agree.");
  return out;
}

/* ------------------------------------------------------------ consent gating */

export interface ConsentInput { agree?: unknown; recording?: unknown; confidentiality?: unknown }

/** null when this person may join with what they agreed to; else the refusal (no consent → no room) */
export function consentRefusal(room: LiveRoomState, role: LiveRole, c: ConsentInput): LiveError | null {
  if (role === "participant") {
    const problems = joinProblems(room);
    if (problems.length) return new LiveError(409, "This session is not ready for participants yet. Please contact the research team.", "not_ready");
    if (c.agree !== true) return new LiveError(400, "Please read the consent statement and agree to take part.", "consent_required");
    if (room.settings.record && c.recording !== true) return new LiveError(400, "This session is recorded. You can only join if you agree to the recording.", "recording_consent_required");
  }
  if (role === "observer" && c.confidentiality !== true) return new LiveError(400, "Please confirm you will keep what you see confidential and stay silent.", "confidentiality_required");
  return null;
}

/* ------------------------------------------------------------ the operations */

export type LiveOp =
  | { op: "open" } | { op: "start" } | { op: "end" } | { op: "cancel" }
  | { op: "admit"; member: string } | { op: "admit_all" } | { op: "deny"; member: string } | { op: "remove"; member: string }
  | { op: "mute"; member: string } | { op: "mute_all" }
  | { op: "spotlight"; member: string | null }
  | { op: "stimulus"; id: string | null }
  | { op: "section"; id: string | null }
  | { op: "media"; audio?: boolean; video?: boolean; screen?: boolean }
  | { op: "leave" };

const MODERATOR_OPS = new Set(["open", "start", "end", "cancel", "admit", "admit_all", "deny", "remove", "mute", "mute_all", "spotlight", "stimulus", "section"]);

export function parseLiveOp(raw: unknown): LiveOp | string {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const op = String(o.op ?? "");
  const id = (k: string) => (typeof o[k] === "string" && /^[\w-]{1,80}$/.test(o[k] as string) ? (o[k] as string) : null);
  switch (op) {
    case "open": case "start": case "end": case "cancel": case "admit_all": case "mute_all": case "leave": return { op } as LiveOp;
    case "admit": case "deny": case "remove": case "mute": { const m = id("member"); return m ? { op, member: m } as LiveOp : "which member"; }
    case "spotlight": return o.member === null || o.member === undefined ? { op, member: null } : (id("member") ? { op, member: id("member")! } : "which member");
    case "stimulus": return o.id === null || o.id === undefined ? { op, id: null } : (id("id") ? { op, id: id("id")! } : "which stimulus");
    case "section": return o.id === null || o.id === undefined ? { op, id: null } : (id("id") ? { op, id: id("id")! } : "which section");
    case "media": return { op, ...(typeof o.audio === "boolean" ? { audio: o.audio } : {}), ...(typeof o.video === "boolean" ? { video: o.video } : {}), ...(typeof o.screen === "boolean" ? { screen: o.screen } : {}) };
    default: return "unknown operation";
  }
}

export interface OpResult { room: LiveRoomState; patches: { memberId: string; patch: Partial<LiveMember> }[]; detail: string; roomChanged: boolean }

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * One operation by one member. Moderator-only operations are refused (403) to anyone else; a participant or an
 * observer can only change their own media state or leave. Throws LiveError; never touches I/O.
 */
export function applyRoomOp(room: LiveRoomState, members: readonly LiveMember[], actor: LiveMember, op: LiveOp, now: string): OpResult {
  if (MODERATOR_OPS.has(op.op) && actor.role !== "moderator") throw new LiveError(403, "Only the moderator can do that.", "forbidden");
  /* someone in the waiting room may still set their microphone / camera or leave */
  if (actor.state !== "admitted" && !(actor.state === "waiting" && (op.op === "media" || op.op === "leave"))) throw new LiveError(403, "You are not in the room.", "not_in_room");
  const r = clone(room);
  const patches: OpResult["patches"] = [];
  const target = (id: string, role?: LiveRole) => {
    const m = members.find((x) => x.id === id);
    if (!m || (role && m.role !== role)) throw new LiveError(404, "No such person in this session.", "no_member");
    return m;
  };
  const admittedParticipants = () => members.filter((m) => m.role === "participant" && m.state === "admitted").length;
  const log = (o: string, detail: string) => { r.log.push({ at: now, by: actor.handle, op: o, detail }); if (r.log.length > LOG_MAX) r.log.splice(0, r.log.length - LOG_MAX); };
  const notOver = () => { if (r.status === "ended" || r.status === "cancelled") throw new LiveError(409, "The session is over.", "ended"); };
  switch (op.op) {
    case "open":
      if (r.status !== "scheduled") throw new LiveError(409, r.status === "open" || r.status === "live" ? "The room is open already." : "The session is over.", "status");
      r.status = "open"; r.openedAt = now; log("open", "opened the room"); break;
    case "start":
      notOver();
      if (r.status === "live") throw new LiveError(409, "The session has started already.", "status");
      r.status = "live"; r.startedAt = now; r.openedAt ??= now; log("start", "started the session"); break;
    case "end":
      if (r.status !== "live" && r.status !== "open") throw new LiveError(409, "The session is not running.", "status");
      r.status = "ended"; r.endedAt = now; r.stage = { stimulusId: null, spotlight: null, section: null }; log("end", "ended the session"); break;
    case "cancel":
      if (r.status === "live" || r.status === "ended") throw new LiveError(409, "A session that has run cannot be cancelled — end it instead.", "status");
      r.status = "cancelled"; r.endedAt = now; log("cancel", "cancelled the session"); break;
    case "admit": {
      notOver();
      const m = target(op.member, "participant");
      if (m.state === "admitted") return { room, patches: [], detail: `${m.handle} is in the room already`, roomChanged: false };
      if (m.state !== "waiting") throw new LiveError(409, `${m.handle} is not waiting.`, "state");
      if (admittedParticipants() >= r.settings.maxParticipants) throw new LiveError(409, `The room is full (${r.settings.maxParticipants} participants).`, "full");
      patches.push({ memberId: m.id, patch: { state: "admitted" } }); log("admit", `admitted ${m.handle}`); break;
    }
    case "admit_all": {
      notOver();
      let room_ = r.settings.maxParticipants - admittedParticipants();
      for (const m of members.filter((x) => x.role === "participant" && x.state === "waiting").sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))) {
        if (room_ <= 0) break;
        patches.push({ memberId: m.id, patch: { state: "admitted" } }); room_--;
      }
      log("admit_all", `admitted ${patches.length}`); break;
    }
    case "deny": { const m = target(op.member, "participant"); if (m.state !== "waiting") throw new LiveError(409, `${m.handle} is not waiting.`, "state"); patches.push({ memberId: m.id, patch: { state: "denied" } }); log("deny", `did not admit ${m.handle}`); break; }
    case "remove": {
      const m = target(op.member);
      if (m.role === "moderator") throw new LiveError(409, "The moderator cannot be removed.", "state");
      patches.push({ memberId: m.id, patch: { state: "removed" } });
      if (r.stage.spotlight === m.id) r.stage.spotlight = null;
      log("remove", `removed ${m.handle}`); break;
    }
    case "mute": { const m = target(op.member); if (m.role === "observer") throw new LiveError(409, "Observers are never heard.", "state"); patches.push({ memberId: m.id, patch: { mutedByModerator: true, media: { ...m.media, audio: false } } }); log("mute", `muted ${m.handle}`); break; }
    case "mute_all": for (const m of members.filter((x) => x.role === "participant" && x.state === "admitted")) patches.push({ memberId: m.id, patch: { mutedByModerator: true, media: { ...m.media, audio: false } } }); log("mute_all", "muted everyone"); break;
    case "spotlight": if (op.member) { const m = target(op.member); if (m.role === "observer") throw new LiveError(409, "Observers are not on stage.", "state"); } r.stage.spotlight = op.member; log("spotlight", op.member ? `spotlighted ${target(op.member).handle}` : "cleared the spotlight"); break;
    case "stimulus": {
      notOver();
      if (op.id && !r.stimuli.some((s) => s.id === op.id)) throw new LiveError(404, "No such stimulus in the guide.", "no_stimulus");
      r.stage.stimulusId = op.id;
      log("stimulus", op.id ? `showed “${r.stimuli.find((s) => s.id === op.id)!.name}” to everyone` : "took the stimulus down"); break;
    }
    case "section": {
      if (op.id) {
        const s = r.sections.find((x) => x.id === op.id);
        if (!s) throw new LiveError(404, "No such section in the guide.", "no_section");
        r.stage.section = { id: s.id, startedAt: now, minutes: s.minutes };
        log("section", `started “${s.title}” (${s.minutes} min)`);
      } else { r.stage.section = null; log("section", "stopped the section timer"); }
      break;
    }
    case "media": {
      const media = { ...actor.media, ...(op.audio !== undefined ? { audio: op.audio } : {}), ...(op.video !== undefined ? { video: op.video } : {}), ...(op.screen !== undefined ? { screen: op.screen } : {}) };
      if (actor.role === "observer") { media.audio = false; media.video = false; media.screen = false; }
      /* unmuting oneself clears the moderator's mute (as in any meeting); the moderator saw it happen */
      patches.push({ memberId: actor.id, patch: { media, ...(op.audio === true ? { mutedByModerator: false } : {}) } });
      return { room, patches, detail: "", roomChanged: false };
    }
    case "leave":
      patches.push({ memberId: actor.id, patch: { state: "left" } });
      if (r.stage.spotlight === actor.id) { r.stage.spotlight = null; return { room: r, patches, detail: `${actor.handle} left`, roomChanged: true }; }
      return { room, patches, detail: `${actor.handle} left`, roomChanged: false };
  }
  return { room: r, patches, detail: r.log[r.log.length - 1]?.detail ?? "", roomChanged: true };
}

/* ------------------------------------------------------------ who connects to whom */

const inRoom = (m: LiveMember) => m.state === "admitted";
export const online = (m: LiveMember, nowMs: number) => !!m.lastSeenAt && nowMs - Date.parse(m.lastSeenAt) < ONLINE_MS;

/**
 * May `from` send a connection message to `to`? Both in the room, the room open or live, and a pair the room
 * allows: the moderator ↔ anyone; participant ↔ participant; an observer ↔ the moderator ONLY (observers are
 * never connected to a participant — that is what keeps them invisible).
 */
export function canSignal(room: Pick<LiveRoomState, "status">, from: LiveMember | undefined, to: LiveMember | undefined): boolean {
  if (!from || !to || from.id === to.id || from.roomId !== to.roomId) return false;
  if (room.status !== "open" && room.status !== "live") return false;
  if (!inRoom(from) || !inRoom(to)) return false;
  if (from.role === "moderator" || to.role === "moderator") return true;
  return from.role === "participant" && to.role === "participant";
}

/** the peers a member's browser connects to */
export function peersOf(room: LiveRoomState, members: readonly LiveMember[], me: LiveMember): LiveMember[] {
  return members.filter((m) => canSignal(room, me, m));
}

/** perfect negotiation: the "polite" side yields on a collision; decided by id so both sides agree */
export const politeTowards = (myId: string, peerId: string) => myId > peerId;

/* ------------------------------------------------------------ what each role is told */

export interface PeerView { id: string; role: "moderator" | "participant" | "observer"; handle: string; label?: string; segment?: string; media: LiveMember["media"]; mutedByModerator: boolean; online: boolean; polite: boolean }
export interface MemberSummary { id: string; role: LiveRole; handle: string; label?: string; segment?: string; state: LiveMemberState; media: LiveMember["media"]; mutedByModerator: boolean; online: boolean; recordingConsent: boolean; joinedAt: string; device?: LiveMember["device"] }

export interface LiveView {
  room: { id: string; title: string; kind: LiveRoomState["kind"]; status: LiveRoomStatus; scheduledAt: string | null; startedAt: string | null; endedAt: string | null; durationMinutes: number; record: boolean; recordVideo: boolean; chunkSeconds: number; transport: LiveTransport; assist?: boolean };
  me: { id: string; role: LiveRole; handle: string; state: LiveMemberState; mutedByModerator: boolean; media: LiveMember["media"]; recordingConsent: boolean };
  stage: { stimulus: LiveStimulus | null; spotlight: string | null; section?: { id: string; title: string; startedAt: string; minutes: number } | null };
  peers: PeerView[];
  /** participants: how many people are taking part (never observers); waiting: their place */
  counts: { participants: number; waiting?: number; observers?: number };
  /** the moderator and observers only */
  members?: MemberSummary[];
  stimuli?: LiveStimulus[];
  sections?: LiveSectionPlan[];
  log?: LiveLogEntry[];
  message: string | null;
}

export function viewFor(room: LiveRoomState, members: readonly LiveMember[], me: LiveMember, nowMs: number): LiveView {
  const staff = me.role !== "participant";
  const stimulus = room.stage.stimulusId ? room.stimuli.find((s) => s.id === room.stage.stimulusId) ?? null : null;
  const peer = (m: LiveMember): PeerView => ({ id: m.id, role: m.role, handle: m.handle, ...(staff && m.label ? { label: m.label } : {}), ...(staff && m.segment ? { segment: m.segment } : {}), media: m.media, mutedByModerator: m.mutedByModerator, online: online(m, nowMs), polite: politeTowards(me.id, m.id) });
  const participants = members.filter((m) => m.role === "participant" && m.state === "admitted");
  const waiting = members.filter((m) => m.role === "participant" && m.state === "waiting").sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  const section = room.stage.section ? { ...room.stage.section, title: room.sections.find((s) => s.id === room.stage.section!.id)?.title ?? "" } : null;
  const message = room.status === "ended" ? "The session has ended. Thank you for taking part."
    : room.status === "cancelled" ? "This session has been cancelled."
    : me.state === "removed" ? "The moderator has removed you from the session."
    : me.state === "denied" ? "The moderator could not admit you to this session. Thank you for your time."
    : me.state === "left" ? "You left the session."
    : me.state === "waiting" ? (room.status === "scheduled" ? "The room is not open yet. Please wait — the moderator will let you in." : "Please wait — the moderator will let you in shortly.")
    : room.status === "scheduled" || room.status === "open" ? "Waiting for the moderator to start the session." : null;
  const view: LiveView = {
    room: { id: room.id, title: room.title, kind: room.kind, status: room.status, scheduledAt: room.scheduledAt, startedAt: room.startedAt, endedAt: room.endedAt, durationMinutes: room.settings.durationMinutes, record: room.settings.record, recordVideo: room.settings.recordVideo, chunkSeconds: room.settings.chunkSeconds, transport: room.settings.transport, ...(staff ? { assist: room.settings.assist } : {}) },
    me: { id: me.id, role: me.role, handle: me.handle, state: me.state, mutedByModerator: me.mutedByModerator, media: me.media, recordingConsent: me.recordingConsent },
    stage: { stimulus, spotlight: room.stage.spotlight, ...(staff ? { section } : {}) },
    peers: me.state === "admitted" ? peersOf(room, members, me).map(peer) : [],
    counts: { participants: participants.length, ...(me.role === "participant" && me.state === "waiting" ? { waiting: waiting.findIndex((w) => w.id === me.id) + 1 } : {}), ...(staff ? { waiting: waiting.length, observers: members.filter((m) => m.role === "observer" && m.state === "admitted").length } : {}) },
    message,
  };
  if (staff) {
    /* observers see the room's people (the moderator and the participants in it), never the waiting room's contact labels beyond the label */
    const visible = me.role === "moderator" ? members : members.filter((m) => m.role !== "participant" || m.state === "admitted");
    view.members = visible.map((m) => ({ id: m.id, role: m.role, handle: m.handle, ...(m.label ? { label: m.label } : {}), ...(m.segment ? { segment: m.segment } : {}), state: m.state, media: m.media, mutedByModerator: m.mutedByModerator, online: online(m, nowMs), recordingConsent: m.recordingConsent, joinedAt: m.joinedAt, ...(m.device ? { device: m.device } : {}) }));
    view.stimuli = room.stimuli; view.sections = room.sections;
    if (me.role === "moderator") view.log = room.log.slice(-50);
  }
  return view;
}

/* ------------------------------------------------------------ signalling messages */

export type SignalType = "offer" | "answer" | "candidate" | "meta" | "bye";
export interface LiveSignal { id: number; from: string; to: string; type: SignalType; payload: unknown; at: string }
export const SIGNAL_TTL_MS = 2 * 60_000;
const SIGNAL_TYPES = new Set<SignalType>(["offer", "answer", "candidate", "meta", "bye"]);

/** a batch of signals from one member, checked: types, sizes, and that each recipient may be connected to */
export function checkSignals(room: LiveRoomState, members: readonly LiveMember[], from: LiveMember, raw: unknown): { ok: { to: string; type: SignalType; payload: unknown }[]; refused: number; error?: string } {
  const list = Array.isArray(raw) ? raw.slice(0, 200) : [];
  if (!list.length) return { ok: [], refused: 0, error: "no signals" };
  const ok: { to: string; type: SignalType; payload: unknown }[] = [];
  let refused = 0;
  for (const s of list as Record<string, unknown>[]) {
    const type = String(s?.type ?? "") as SignalType;
    const to = members.find((m) => m.id === s?.to);
    const size = JSON.stringify(s?.payload ?? null).length;
    const cap = type === "offer" || type === "answer" ? 120_000 : type === "meta" ? 8_000 : 2_000;
    if (!SIGNAL_TYPES.has(type) || size > cap || !canSignal(room, from, to)) { refused++; continue; }
    /* a relay map (moderator → observer) may only name members of the room */
    ok.push({ to: to!.id, type, payload: s.payload ?? null });
  }
  return { ok, refused };
}
