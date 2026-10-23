import { NextRequest } from "next/server";
import { readObject } from "@rescript/media";
import {
  memberAction, joinWithInvite, mergeLiveTranscript, guideProgress, assistInput, assistPrompt, readAssist, fakeAssistReply,
  LIVE_ASSIST_SYSTEM, LIVE_ASSIST_SCHEMA, LIVE_ASSIST_MAX_TOKENS,
  type LiveStore, type LiveTrack, type LiveRoomRow, type LiveMember,
} from "@rescript/analytics/live";
import { isFailure, requireProjectFor, requireUser, type AuthedUser } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { sttPrecheck } from "@/lib/byok/connect";
import { billingProjectFor, meteredSttCall, refusalResponse } from "@/lib/metering";
import { qualGuardCapability, qualRefusal } from "@/lib/qual/qualAccess";
import { json, loadSettings, refuse, storeFailure } from "@/lib/qual/qualStore";
import { modelRunner } from "@/lib/qual/synthesisStore";
import { supabaseService } from "@/lib/authServer";
import { connectionFor, isSandbox, liveDeps, readSandboxBlob, sandboxReady, storeFor, trackSummary, transcribeChunks, liveMigrationMissing, LIVE_MIGRATION_MESSAGE, type Meter } from "@/lib/live/liveServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * A LIVE SESSION'S ROOM — THE STUDIO'S MEMBERS (2026-10-22, G2): the moderator's console and member observers.
 * POST { action, token, … } with the member token the console got from `live` (join):
 *
 *   poll     long-poll (≤ 8 s): the room for this member, the connection messages addressed to it, the back room
 *   signal   WebRTC offers / answers / candidates / stream names to peers this member may connect to
 *   op       moderation (admit, mute, remove, spotlight, stimulus, section timer, start / end) — the moderator only;
 *            anyone: their own microphone / camera / screen state, leave
 *   chat     the back room: moderator ↔ observers;   note   an observer's timestamped note
 *   work     the moderator's console transcribes a few recorded chunks (metered) and gets the rolling transcript
 *   assist   the moderator's AI side panel: guide progress by code, then ONE metered call for probes / missed
 *            objectives (redacted, fenced, checked) — never spoken to participants
 *   ice      fresh connection credentials (TURN minted per person)
 *
 * Access: every request passes the Studio guard (Data view) AND carries a member token of a room in THIS project;
 * moderation, work and assist need the moderator's seat (taken with Data edit). In the SANDBOX (fake provider only)
 * the respondent app forwards its participants here (`via: "runtime"`): join by invitation, and their own actions.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return isFailure(authed) ? authed.response : json({ error: "expected a JSON body" }, 400);
  const action = String(body.action ?? "");
  const sandbox = isSandbox(params.id);
  let user: AuthedUser | null = null;
  let manage = true;
  if (sandbox) {
    if (!sandboxReady()) return isFailure(authed) ? authed.response : json({ error: "the sandbox runs live sessions only against the fake provider" }, 403);
    user = isFailure(authed) ? null : authed;
  } else {
    if (isFailure(authed)) return authed.response;
    const gate = await requireProjectFor(authed, params.id, qualGuardCapability("read"));
    if (isFailure(gate)) return gate.response;
    const refused = refuse(gate, "read");
    if (refused) return refused;
    user = authed;
    manage = qualRefusal(gate.grant, "manage") === null;
  }
  const store = storeFor(params.id);
  try {
    /* the respondent app's participants, forwarded server to server (sandbox only) */
    if (body.via === "runtime") {
      if (!sandbox) return json({ error: "not here" }, 403);
      if (action === "join") { const r = await joinWithInvite(store, body, liveDeps); return json(await withConnection(store, r), r.status); }
      if (action === "ice") { const m = await memberOf(store, body.token, params.id); return m && m.member.role !== "moderator" ? json({ ok: true, connection: connectionFor(m.row, m.member) }) : json({ error: "Join the session first.", code: "not_joined" }, 401); }
      const r = await memberAction(store, body, liveDeps, { allowRoles: ["participant", "observer"], onPoll: sfuConnection });
      return json(r.body, r.status);
    }
    /* a member of a room in THIS project */
    const me = await memberOf(store, body.token, params.id);
    if (!me) return json({ error: "This console is no longer in the session — open it again.", code: "not_joined" }, 401);
    if (me.member.role === "participant") return json({ error: "not here" }, 403);
    if (action === "ice") return json({ ok: true, connection: connectionFor(me.row, me.member) });
    if (action === "work" || action === "assist") {
      if (me.member.role !== "moderator" || !manage) return json({ error: "Only the moderator can do that.", code: "forbidden" }, 403);
      return action === "work" ? work(store, me.row, user, params.id) : assist(store, me.row, user, params.id, body);
    }
    if (action === "op" && me.member.role === "moderator" && !manage) return json({ error: "Moderating needs Data: Edit.", code: "forbidden" }, 403);
    const r = await memberAction(store, body, liveDeps, { allowRoles: ["moderator", "observer"], onPoll: sfuConnection });
    return json(r.body, r.status);
  } catch (e) { return liveMigrationMissing(e) ? json({ error: LIVE_MIGRATION_MESSAGE, code: "migration_required" }, 503) : storeFailure(e); }
}

async function memberOf(store: LiveStore, token: unknown, surveyId: string): Promise<{ member: LiveMember; row: LiveRoomRow } | null> {
  const t = String(token ?? "");
  if (!/^[A-Za-z0-9_-]{24,120}$/.test(t)) return null;
  const member = await store.memberByHash(liveDeps.hash(t));
  if (!member) return null;
  const row = await store.room(member.roomId);
  return row && row.surveyId === surveyId ? { member, row } : null;
}

/** an SFU room hands each admitted member their LiveKit token with the poll */
async function sfuConnection(row: LiveRoomRow, member: LiveMember) {
  return row.state.settings.transport === "sfu" && member.state === "admitted" ? { connection: connectionFor(row, member) } : undefined;
}

async function withConnection(store: LiveStore, r: { status: number; body: Record<string, unknown> }) {
  if (r.status !== 200 || !r.body.memberId) return r.body;
  const m = (await store.memberByHash(liveDeps.hash(String(r.body.token))))!;
  const row = (await store.room(m.roomId))!;
  return { ...r.body, connection: connectionFor(row, m) };
}

async function meterFor(user: AuthedUser | null, surveyId: string): Promise<Meter | { response: Response }> {
  const billing = await billingProjectFor(isSandbox(surveyId) ? null : user, isSandbox(surveyId) ? "sandbox" : surveyId, "responses.manage");
  if ("response" in billing) return { response: billing.response };
  return async (seconds, fn) => { const m = await meteredSttCall(billing.meter, billing.ctx, "qual_live_transcription", seconds, fn); return m.ok ? { ok: true, value: m.value } : { ok: false, refusal: m }; };
}

function bytesReader(surveyId: string): ((t: LiveTrack) => Promise<Uint8Array | null>) | { response: Response } {
  if (isSandbox(surveyId)) return async (t) => (t.mediaId ? readSandboxBlob(t.mediaId) : null);
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle;
  return async (t) => {
    if (!t.mediaId) return null;
    const { data: media } = await handle.db.from("media_objects").select("bucket, path, storage_provider, status, survey_id").eq("id", t.mediaId).maybeSingle();
    if (!media || media.survey_id !== surveyId || media.status !== "stored") return null;
    return readObject(handle.db, { bucket: media.bucket, path: media.path, storage_provider: media.storage_provider } as never);
  };
}

/** the moderator's console: a few chunks transcribed (when speech-to-text is configured), the rolling transcript */
async function work(store: LiveStore, row: LiveRoomRow, user: AuthedUser | null, surveyId: string) {
  let stt: { ready: boolean; reason?: string } = { ready: true };
  const pending = (await store.tracks(row.id)).some((t) => t.kind === "audio" && t.status === "stored");
  if (pending && row.state.settings.record) {
    const ready = isSandbox(surveyId) ? { ok: true as const } : await sttPrecheck(user, surveyId, "qual_live_transcription");
    if (!ready.ok) stt = { ready: false, reason: ready.error };
    else {
      const meter = await meterFor(user, surveyId);
      const read = bytesReader(surveyId);
      if ("response" in meter) stt = { ready: false, reason: "the project's wallet refused the transcription" };
      else if ("response" in read) stt = { ready: false, reason: "media storage is not configured" };
      else {
        const t = await transcribeChunks({ store, row, readBytes: read, meter, max: 3, budgetMs: 25_000 });
        if (t.refusal) return refusalResponse(t.refusal as never);
      }
    }
  }
  const [members, tracks] = await Promise.all([store.members(row.id), store.tracks(row.id)]);
  const tr = mergeLiveTranscript({ room: row.state, members, tracks });
  return json({ ok: true, stt, recording: trackSummary(tracks, members), transcript: tr.segments.slice(-200), warnings: tr.meta.warnings });
}

/** the AI side panel (on request): progress by code; one metered, fenced, redacted call; checked suggestions */
async function assist(store: LiveStore, row: LiveRoomRow, user: AuthedUser | null, surveyId: string, body: Record<string, unknown>) {
  if (!row.state.settings.assist) return json({ error: "AI assist is off for this session." }, 409);
  const [members, tracks] = await Promise.all([store.members(row.id), store.tracks(row.id)]);
  const tr = mergeLiveTranscript({ room: row.state, members, tracks });
  const now = Date.parse(liveDeps.now());
  const progress = guideProgress(row.state, tr.segments, now);
  if (!tr.segments.some((s) => s.speaker !== "Moderator")) return json({ ok: true, assist: { at: liveDeps.now(), origin: "none", probes: [], heldBack: [], missedObjectives: [], note: tr.segments.length ? "No participant has been transcribed yet." : "Nothing has been transcribed yet — suggestions start once participants' recordings are transcribed (recording and speech-to-text must be on).", progress, turnsSeen: 0 }, calls: 0 });
  const names = isSandbox(surveyId) ? [] : (await loadSettings(supabaseService(), surveyId)).redactNames;
  const input = assistInput(row.state, tr.segments, progress, { names });
  const runner = await modelRunner(isSandbox(surveyId) ? null : user, surveyId, "qual_live_assist", "responses.manage", Array.isArray(body.fake) ? body.fake : null);
  if ("response" in runner) return runner.response;
  const r = await runner.run({ system: LIVE_ASSIST_SYSTEM, prompt: (nonce) => assistPrompt(input, { nonce }), maxTokens: LIVE_ASSIST_MAX_TOKENS, schema: LIVE_ASSIST_SCHEMA as unknown as Record<string, unknown>, schemaName: "live_assist", fake: () => fakeAssistReply(input), seed: `assist:${row.id}:${tr.segments.length}` });
  if (!r.ok) return r.response;
  return json({ ok: true, assist: readAssist(r.value, input, { at: liveDeps.now(), origin: runner.fake ? "fake" : "ai" }), calls: runner.calls });
}
