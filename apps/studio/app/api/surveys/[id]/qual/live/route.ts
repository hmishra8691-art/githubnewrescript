import { NextRequest } from "next/server";
import { readObject } from "@rescript/media";
import {
  readScheduleInput, newRoomState, joinProblems, joinStaff, mergeLiveTranscript, applyRoomOp, LiveError,
  type LiveRoomRow, type LiveStore, type LiveMember, type LiveInvite, type LiveTrack,
} from "@rescript/analytics/live";
import { livekitConfig } from "@rescript/analytics/live/server";
import { isFailure, requireProjectFor, requireUser, type AuthedUser, type ProjectContext } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { loadDefinition } from "@/lib/analytics";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { sttPrecheck } from "@/lib/byok/connect";
import { billingProjectFor, meteredSttCall, refusalResponse } from "@/lib/metering";
import { mailConfig, sendMail } from "@/lib/mail";
import { qualGuardCapability, qualRefusal } from "@/lib/qual/qualAccess";
import { checkRow, hasPii, json, recordEvents, refuse, storeFailure } from "@/lib/qual/qualStore";
import { enqueueAutoCode } from "@/lib/qual/autoCode";
import {
  connectionFor, inviteHashFor, inviteLink, isSandbox, linkSecretFor, liveDeps, readSandboxBlob, roomOf, sandboxReady, storeFor,
  trackSummary, transcribeChunks, transportInfo, liveMigrationMissing, LIVE_MIGRATION_MESSAGE, type Meter,
} from "@/lib/live/liveServer";
/* G3 2026-10-22: live-session no-shows as alerts */
import { emitNotifyEvent, sendNotification, studioLink } from "@/lib/notify/service";
import { notifyDeps } from "@/lib/notify/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * LIVE HUMAN-MODERATED SESSIONS — SCHEDULING AND MANAGEMENT (2026-10-22, G2). Research Tools → Qualitative →
 * Live sessions. The room itself (polling, signalling, moderation) is `live/room`; recorded chunks are `live/media`.
 *
 *   GET                         the project's sessions (status, time, invitations / joined / no-shows), the transport
 *                               (built-in mesh, TURN or not — with the warning — LiveKit or not), whether e-mail is on   Data view
 *   GET ?id=…                   one session: invitations (links for Data edit; names and e-mails only with contact
 *                               details), people, recording chunks, back-room chat and notes                         Data view
 *   POST { action: "schedule", sessions: [{ title, kind, scheduledAt, timeZone, segment, settings, slots?, people? }] }
 *                               rooms snapshotted from the guide (consent, stimuli, timed sections), each with a
 *                               "planned" session record and participant slots with unique links                     Data edit
 *   POST { action: "update" | "cancel", id, … }                                                                      Data edit
 *   POST { action: "invite", id, role, count? | people? } · { action: "revoke" | "relink", id, inviteId }            Data edit
 *   POST { action: "send", id, kind: "invite" | "reminder", inviteIds? }   e-mail through the configured sender      Data edit
 *   POST { action: "join", id, role: "moderator" | "observer" }   a member token for the console               Data edit / view
 *   POST { action: "finalize", id }   transcribe what is left (202 + continue until done), merge per speaker into one
 *                               transcript, complete the session record, no-shows marked, auto-coding queued        Data edit
 *
 * THE SANDBOX (an unsaved project, FAKE provider only) keeps rooms in this process and a temp file; nothing is sent.
 */

type Who = { user: AuthedUser | null; gate: ProjectContext | null; manage: boolean; read: boolean; pii: boolean; sandbox: boolean };
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}$/;
const fmtLocal = (iso: string | null, tz: string | null) => {
  if (!iso) return "time to be confirmed";
  try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso)); } catch { return iso; }
};

async function who(req: NextRequest, surveyId: string, authed: AuthedUser | Awaited<ReturnType<typeof requireUser>>, op: "read" | "manage"): Promise<Who | { response: Response }> {
  if (isSandbox(surveyId)) {
    if (!sandboxReady()) return { response: isFailure(authed) ? authed.response : json({ error: "the sandbox runs live sessions only against the fake provider" }, 403) };
    return { user: isFailure(authed) ? null : authed, gate: null, manage: true, read: true, pii: true, sandbox: true };
  }
  if (isFailure(authed)) return { response: authed.response };
  const gate = await requireProjectFor(authed, surveyId, qualGuardCapability(op));
  if (isFailure(gate)) return { response: gate.response };
  const refused = refuse(gate, op);
  if (refused) return { response: refused };
  return { user: authed, gate, manage: qualRefusal(gate.grant, "manage") === null, read: true, pii: hasPii(gate), sandbox: false };
}

function summary(row: LiveRoomRow, members: LiveMember[], invites: LiveInvite[]) {
  const s = row.state;
  const parts = members.filter((m) => m.role === "participant");
  return {
    id: row.id, title: s.title, kind: s.kind, status: s.status, scheduledAt: s.scheduledAt, timeZone: s.timeZone, segment: s.segment, settings: s.settings,
    startedAt: s.startedAt, endedAt: s.endedAt, qualSessionId: row.qualSessionId, transcriptId: row.transcriptId, problems: joinProblems(s),
    counts: { invited: invites.filter((i) => i.role === "participant" && i.status !== "revoked").length, joined: parts.length, inRoom: parts.filter((m) => m.state === "admitted").length, waiting: parts.filter((m) => m.state === "waiting").length, noShow: invites.filter((i) => i.status === "no_show").length, observers: invites.filter((i) => i.role === "observer" && i.status !== "revoked").length },
  };
}

function inviteView(inv: LiveInvite, w: Who, secret: string | null) {
  return { id: inv.id, role: inv.role, status: inv.status, segment: inv.segment ?? null, ...(w.pii ? { label: inv.label ?? null, email: inv.email ?? null } : { label: inv.label ? "(hidden)" : null, email: inv.email ? "(hidden)" : null }), remindedAt: inv.remindedAt ?? null, invitedAt: inv.invitedAt ?? null, memberId: inv.memberId ?? null, ...(w.manage && secret && inv.status !== "revoked" ? { link: inviteLink(secret, inv) } : {}) };
}

function readPeople(v: unknown, fallbackSegment: string | null): { label?: string; email?: string; segment?: string }[] | string {
  if (!Array.isArray(v)) return [];
  const out: { label?: string; email?: string; segment?: string }[] = [];
  for (const p of v.slice(0, 50) as Record<string, unknown>[]) {
    const label = typeof p?.label === "string" && p.label.trim() ? p.label.trim().slice(0, 120) : undefined;
    const email = typeof p?.email === "string" && p.email.trim() ? p.email.trim().toLowerCase() : undefined;
    if (email && !EMAIL.test(email)) return `“${email}” is not an e-mail address.`;
    const segment = typeof p?.segment === "string" && p.segment.trim() ? p.segment.trim().slice(0, 120) : fallbackSegment ?? undefined;
    out.push({ ...(label ? { label } : {}), ...(email ? { email } : {}), ...(segment ? { segment } : {}) });
  }
  return out;
}

async function addInvites(store: LiveStore, row: LiveRoomRow, secret: string, role: "participant" | "observer", people: { label?: string; email?: string; segment?: string }[]) {
  const made: LiveInvite[] = [];
  for (const p of people) made.push(await store.insertInvite({ roomId: row.id, role, ...p }, inviteHashFor(secret)));
  return made;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  /* signed in, except the sandbox (fake provider only — checked in `who`) */
  if (isFailure(authed) && !isSandbox(params.id)) return authed.response;
  const w = await who(req, params.id, authed, "read");
  if ("response" in w) return w.response;
  try {
    const store = storeFor(params.id);
    const mail = mailConfig();
    const base = { ok: true, transport: transportInfo(), mail: { configured: !w.sandbox && mail.configured }, can: { manage: w.manage, pii: w.pii }, sandbox: w.sandbox };
    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      const rows = await store.rooms(params.id);
      const out = [];
      for (const r of rows) out.push(summary(r, await store.members(r.id), await store.invites(r.id)));
      return json({ ...base, rooms: out });
    }
    const row = await roomOf(store, params.id, id);
    if (!row) return json({ error: "no such live session" }, 404);
    const [members, invites, tracks, notes] = await Promise.all([store.members(row.id), store.invites(row.id), store.tracks(row.id), store.notes(row.id)]);
    const secret = w.manage ? linkSecretFor(params.id) : null;
    return json({
      ...base, room: summary(row, members, invites), stimuli: row.state.stimuli, sections: row.state.sections, consent: row.state.consent,
      invites: invites.map((i) => inviteView(i, w, secret)),
      people: members.map((m) => ({ id: m.id, role: m.role, handle: m.handle, ...(w.pii && m.label ? { label: m.label } : {}), segment: m.segment ?? null, state: m.state, recordingConsent: m.recordingConsent, joinedAt: m.joinedAt })),
      recording: trackSummary(tracks, members), chat: notes.filter((n) => n.kind === "chat"), notes: notes.filter((n) => n.kind === "note"), log: row.state.log.slice(-100),
    });
  } catch (e) { return liveMigrationMissing(e) ? json({ error: LIVE_MIGRATION_MESSAGE, code: "migration_required" }, 503) : storeFailure(e); }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return isFailure(authed) ? authed.response : json({ error: "expected a JSON body" }, 400);
  const action = String(body.action ?? "");
  const w = await who(req, params.id, authed, action === "join" && body.role === "observer" ? "read" : "manage");
  if ("response" in w) return w.response;
  const store = storeFor(params.id);
  const db = w.sandbox ? null : supabaseService();
  const actorName = w.user ? (w.user.fullName || w.user.email || "Moderator") : "You (sandbox)";
  const event = async (a: string, detail: string, ids: string[]) => { if (db && w.gate) await recordEvents(db, w.gate, [{ actor: w.gate.user.userId, action: a, detail, ids }]); };
  try {
    /* ---------------------------------------------------------------- schedule */
    if (action === "schedule") {
      const secret = linkSecretFor(params.id);
      if (!secret) return json({ error: "Invitation links need a server secret (LIVE_LINK_SECRET, or the database's service key)." }, 503);
      const list = Array.isArray(body.sessions) ? (body.sessions as unknown[]).slice(0, 12) : [body];
      let guide: unknown = null;
      if (w.sandbox) guide = body.guide ?? null;
      else { const loaded = await loadDefinition(db!, params.id).catch(() => null); guide = loaded && !("error" in loaded) ? loaded.def.qualStudy ?? null : null; }
      const sfuAvailable = !!livekitConfig(process.env);
      const inputs = [];
      for (const raw of list) {
        const f = readScheduleInput(raw, { sfuAvailable });
        if (!f.ok) return json({ error: f.error }, 400);
        const people = readPeople((raw as Record<string, unknown>)?.people, f.value.segment);
        if (typeof people === "string") return json({ error: people }, 400);
        const slots = Math.max(0, Math.min(20, Math.round(Number((raw as Record<string, unknown>)?.slots) || 0)));
        inputs.push({ f: f.value, people: people.length ? people : Array.from({ length: slots }, () => (f.value.segment ? { segment: f.value.segment } : {})) });
      }
      const created = [];
      for (const { f, people } of inputs) {
        const state = newRoomState("new", f, guide);
        const rid = await store.insertRoom({ surveyId: params.id, customerId: w.gate?.survey.customer_id ?? null, state, userId: w.user?.userId ?? null });
        let row = (await store.room(rid))!;
        if (db) {
          /* the session record exists from the moment it is booked ("planned"); Finalize completes it */
          const qs = checkRow(await db.from("qual_sessions").insert({ survey_id: params.id, kind: f.kind, title: f.title, scheduled_at: f.scheduledAt, moderator: actorName, participants: [], consent: {}, notes: `Live session in Rescript (${f.settings.transport === "sfu" ? "LiveKit" : "built-in browser connection"}), booked for ${fmtLocal(f.scheduledAt, f.timeZone)}.`, status: "planned", created_by: w.user!.userId, updated_by: w.user!.userId }).select("id").single(), "session") as { id: string };
          await store.link(rid, { qualSessionId: qs.id });
          row = (await store.room(rid))!;
        }
        const invites = await addInvites(store, row, secret, "participant", people);
        await event("live.scheduled", `Scheduled the live ${f.kind === "focus_group" ? "focus group" : "interview"} “${f.title}” for ${fmtLocal(f.scheduledAt, f.timeZone)} with ${invites.length} participant link${invites.length === 1 ? "" : "s"}`, [rid, ...(row.qualSessionId ? [row.qualSessionId] : [])]);
        created.push({ ...summary(row, [], invites), invites: invites.map((i) => inviteView(i, w, secret)) });
      }
      return json({ ok: true, rooms: created });
    }

    const row = await roomOf(store, params.id, body.id);
    if (!row) return json({ error: "no such live session" }, 404);

    /* ---------------------------------------------------------------- update / cancel */
    if (action === "update") {
      if (row.state.status !== "scheduled") return json({ error: "Only a session that has not opened can be changed." }, 409);
      const next = { ...row.state };
      if (typeof body.title === "string" && body.title.trim()) next.title = body.title.trim().slice(0, 200);
      if (body.scheduledAt !== undefined) { const t = Date.parse(String(body.scheduledAt)); if (!Number.isFinite(t)) return json({ error: "The session time is not a date." }, 400); next.scheduledAt = new Date(t).toISOString(); }
      if (typeof body.timeZone === "string") next.timeZone = body.timeZone.slice(0, 64) || null;
      if (typeof body.segment === "string") next.segment = body.segment.trim().slice(0, 120) || null;
      if (!(await store.saveRoom(row.id, next, row.version))) return json({ error: "The session changed at the same moment — try again.", code: "version_conflict" }, 409);
      if (db && row.qualSessionId) await db.from("qual_sessions").update({ title: next.title, scheduled_at: next.scheduledAt, updated_by: w.user!.userId }).eq("id", row.qualSessionId).eq("survey_id", params.id);
      await event("live.updated", `Changed the live session “${next.title}” (${fmtLocal(next.scheduledAt, next.timeZone)})`, [row.id]);
      return json({ ok: true });
    }
    if (action === "cancel") {
      const staff = { id: "x", roomId: row.id, role: "moderator" as const, handle: "Moderator", state: "admitted" as const, recordingConsent: true, joinedAt: "", media: { audio: false, video: false, screen: false }, mutedByModerator: false };
      const r = applyRoomOp(row.state, [], staff, { op: "cancel" }, liveDeps.now());
      if (!(await store.saveRoom(row.id, r.room, row.version))) return json({ error: "The session changed at the same moment — try again.", code: "version_conflict" }, 409);
      await store.touch(row.id);
      if (db && row.qualSessionId) await db.from("qual_sessions").update({ status: "cancelled", updated_by: w.user!.userId }).eq("id", row.qualSessionId).eq("survey_id", params.id);
      await event("live.cancelled", `Cancelled the live session “${row.state.title}”`, [row.id]);
      return json({ ok: true });
    }

    /* ---------------------------------------------------------------- invitations */
    if (action === "invite") {
      const secret = linkSecretFor(params.id);
      if (!secret) return json({ error: "Invitation links need a server secret (LIVE_LINK_SECRET)." }, 503);
      if (row.state.status === "ended" || row.state.status === "cancelled") return json({ error: "The session is over." }, 409);
      const role = body.role === "observer" ? "observer" : "participant";
      let people = readPeople(body.people, role === "participant" ? row.state.segment : null);
      if (typeof people === "string") return json({ error: people }, 400);
      if (!people.length) people = Array.from({ length: Math.max(1, Math.min(20, Math.round(Number(body.count) || 1))) }, () => (role === "participant" && row.state.segment ? { segment: row.state.segment } : {}));
      const made = await addInvites(store, row, secret, role, people);
      await event("live.invited", `Added ${made.length} ${role} link${made.length === 1 ? "" : "s"} to “${row.state.title}”`, [row.id]);
      return json({ ok: true, invites: made.map((i) => inviteView(i, w, secret)) });
    }
    if (action === "revoke" || action === "relink") {
      const inv = (await store.invites(row.id)).find((i) => i.id === body.inviteId);
      if (!inv) return json({ error: "no such invitation" }, 404);
      const secret = linkSecretFor(params.id);
      if (!secret) return json({ error: "Invitation links need a server secret (LIVE_LINK_SECRET)." }, 503);
      if (action === "revoke") await store.updateInvite(inv.id, { status: "revoked" });
      else { const v = inv.linkVersion + 1; await store.updateInvite(inv.id, { linkVersion: v, tokenHash: inviteHashFor(secret)(inv.id, v), ...(inv.status === "revoked" ? { status: inv.memberId ? "joined" : "pending" } : {}) }); }
      await event(`live.${action}`, `${action === "revoke" ? "Revoked" : "Issued a new link for"} an invitation to “${row.state.title}”`, [row.id, inv.id]);
      const fresh = (await store.invites(row.id)).find((i) => i.id === inv.id)!;
      return json({ ok: true, invite: inviteView(fresh, w, secret) });
    }
    if (action === "send") {
      if (w.sandbox) return json({ error: "The sandbox sends no e-mail — copy the links instead." }, 400);
      const cfg = mailConfig();
      if (!cfg.configured) return json({ error: "E-mail is not configured on this installation (RESEND_API_KEY, MAIL_FROM) — copy the links and send them yourself.", code: "mail_unconfigured" }, 503);
      if (!w.pii) return json({ error: "Sending invitations needs access to contact details." }, 403);
      const secret = linkSecretFor(params.id)!;
      const kind = body.kind === "reminder" ? "reminder" : "invite";
      const ids = Array.isArray(body.inviteIds) ? new Set((body.inviteIds as unknown[]).map(String)) : null;
      const targets = (await store.invites(row.id)).filter((i) => i.email && i.status !== "revoked" && i.status !== "no_show" && (!ids || ids.has(i.id)) && (kind === "invite" ? !i.invitedAt : true));
      const when = fmtLocal(row.state.scheduledAt, row.state.timeZone);
      const results: { id: string; sent: boolean; reason?: string }[] = [];
      for (const inv of targets) {
        const link = inviteLink(secret, inv);
        const observer = inv.role === "observer";
        const text = [
          `Hello${inv.label ? ` ${inv.label}` : ""},`, "",
          kind === "reminder" ? `A reminder: the research ${observer ? "session you are observing" : "discussion you agreed to join"} — “${row.state.title}” — is on ${when}.` : `You are invited to ${observer ? "observe" : "take part in"} a live research ${row.state.kind === "focus_group" ? "group discussion" : "interview"}, “${row.state.title}”, on ${when} (about ${row.state.settings.durationMinutes} minutes).`,
          "", `Join from your browser with this personal link (please do not share it): ${link}`, "",
          observer ? "You will watch from the back room: participants cannot see or hear you." : `Before you join you will read the consent information${row.state.settings.record ? " (the session is recorded)" : ""} and test your camera and microphone. A computer or phone with a recent Chrome, Edge, Firefox or Safari works best.`,
        ].join("\n");
        const dedupeKey = `live:${inv.id}:${kind}:${kind === "reminder" ? new Date().toISOString().slice(0, 13) : `v${inv.linkVersion}`}`;
        /* G3's direct-message sender (lib/notify: the live-session templates, a delivery log, one message per key); the
           plain mail sender if the notification tables are not there yet (migration 0072) */
        let r: { sent: boolean; reason?: string };
        try {
          const n = await sendNotification(notifyDeps(), { channel: "email", to: inv.email!, template: kind === "reminder" ? "live_session_reminder" : "live_session_invite", data: { title: row.state.title, joinUrl: link, startsAt: when, minutes: row.state.settings.durationMinutes, senderName: actorName, note: text.split("\n").slice(-1)[0] }, surveyId: params.id, customerId: w.gate?.survey.customer_id ?? null, dedupeKey });
          r = { sent: n.status === "sent" || n.status === "skipped", ...(n.status === "sent" || n.status === "skipped" ? {} : { reason: n.reason ?? n.status }) };
          if (/^http:/.test(link)) r = { sent: r.sent, reason: "the link is not https, so the message carried no link — copy it instead" };
        } catch {
          const m = await sendMail({ to: inv.email!, subject: `${kind === "reminder" ? "Reminder" : "Invitation"}: ${row.state.title} — ${when}`, text, kind: "respondent_invitation", stream: "bulk", dedupeKey, surveyId: params.id, customerId: w.gate?.survey.customer_id ?? null, userId: w.user!.userId });
          r = { sent: m.sent, ...(m.sent ? {} : { reason: m.reason }) };
        }
        results.push({ id: inv.id, sent: r.sent, ...(r.reason ? { reason: r.reason } : {}) });
        if (r.sent) await store.updateInvite(inv.id, kind === "invite" ? { invitedAt: liveDeps.now() } : { remindedAt: liveDeps.now() });
      }
      await event(`live.${kind === "invite" ? "invitations" : "reminders"}_sent`, `Sent ${results.filter((r) => r.sent).length} of ${results.length} ${kind === "invite" ? "invitations" : "reminders"} for “${row.state.title}”`, [row.id]);
      return json({ ok: true, results, sent: results.filter((r) => r.sent).length });
    }

    /* ---------------------------------------------------------------- join the console */
    if (action === "join") {
      const role = body.role === "observer" ? "observer" : "moderator";
      if (role === "moderator" && !w.manage) return json({ error: "Moderating needs Data: Edit." }, 403);
      const r = await joinStaff(store, row, { role, userId: w.user?.userId ?? "sandbox-user", name: actorName }, liveDeps);
      if (r.status !== 200) return json(r.body, r.status);
      const m = (await store.members(row.id)).find((x) => x.id === r.body.memberId)!;
      await event(`live.joined_${role}`, `Joined “${row.state.title}” as ${role}`, [row.id]);
      return json({ ...r.body, connection: connectionFor(row, m) });
    }

    /* ---------------------------------------------------------------- finalize → the qualitative source */
    if (action === "finalize") {
      if (row.state.status === "live" || row.state.status === "open") return json({ error: "End the session first (in the room)." }, 409);
      if (row.state.status !== "ended") return json({ error: "This session never ran." }, 409);
      if (row.transcriptId && !w.sandbox) return json({ ok: true, transcriptId: row.transcriptId, sessionId: row.qualSessionId, already: true });
      /* transcription under the meter: the moderator's project pays, as for any session recording */
      let meter: Meter;
      if (w.sandbox) {
        const billing = await billingProjectFor(null, "sandbox");
        if ("response" in billing) return billing.response;
        meter = async (seconds, fn) => { const m = await meteredSttCall(billing.meter, billing.ctx, "qual_live_transcription", seconds, fn); return m.ok ? { ok: true, value: m.value } : { ok: false, refusal: m }; };
      } else {
        const pending = (await store.tracks(row.id)).some((t) => t.kind === "audio" && (t.status === "stored" || t.status === "failed"));
        if (pending) { const ready = await sttPrecheck(w.user, params.id, "qual_live_transcription"); if (!ready.ok) return json({ error: ready.error, code: ready.code }, ready.status); }
        const billing = await billingProjectFor(w.user, params.id, "responses.manage");
        if ("response" in billing) return billing.response;
        meter = async (seconds, fn) => { const m = await meteredSttCall(billing.meter, billing.ctx, "qual_live_transcription", seconds, fn); return m.ok ? { ok: true, value: m.value } : { ok: false, refusal: m }; };
      }
      const handle = w.sandbox ? null : mediaDbOrResponse();
      if (handle && "response" in handle) return handle.response;
      const readBytes = async (t: LiveTrack) => {
        if (!t.mediaId) return null;
        if (w.sandbox) return readSandboxBlob(t.mediaId);
        const { data: media } = await handle!.db.from("media_objects").select("bucket, path, storage_provider, status, survey_id").eq("id", t.mediaId).maybeSingle();
        if (!media || media.survey_id !== params.id || media.status !== "stored") return null;
        return readObject(handle!.db, { bucket: media.bucket, path: media.path, storage_provider: media.storage_provider } as never);
      };
      const t = await transcribeChunks({ store, row, readBytes, meter, max: 12, budgetMs: 80_000, retryFailed: body.retry === true });
      if (t.refusal) return refusalResponse(t.refusal as never);
      let tracks = await store.tracks(row.id);
      const ended = row.state.endedAt ? Date.parse(row.state.endedAt) : Date.now();
      /* the last chunks upload in the seconds after the end: wait up to two minutes for the ones that started in the
         final chunk window; an upload that never completed earlier (a tab closed or reloaded mid-upload) is lost */
      const lastWindow = ended - (row.state.settings.chunkSeconds + 15) * 1000;
      const stillUploading = tracks.filter((x) => x.kind === "audio" && x.status === "uploading" && x.startMs >= lastWindow && Date.now() - ended < 120_000).length;
      if (tracks.some((x) => x.kind === "audio" && (x.status === "stored" || x.status === "transcribing")) || stillUploading) return json({ ok: true, continue: true, progress: trackSummary(tracks, await store.members(row.id)) }, 202);
      for (const x of tracks.filter((y) => y.status === "uploading")) await store.updateTrack(x.id, { status: "failed", error: "the upload never completed (the tab was closed or reloaded mid-upload)" });
      tracks = await store.tracks(row.id);
      const members = await store.members(row.id);
      const invites = await store.invites(row.id);
      const tr = mergeLiveTranscript({ room: row.state, members, tracks });
      const notes = (await store.notes(row.id)).filter((n) => n.kind === "note");
      const hms = (s: number | null) => (s == null ? undefined : `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`);
      const noShows = invites.filter((i) => i.role === "participant" && (i.status === "pending" || (!i.memberId && i.status !== "revoked")));
      for (const i of noShows) await store.updateInvite(i.id, { status: "no_show" });
      /* G3 2026-10-22: no-shows are an alert (lib/notify): once per session, pseudonymous (slot labels are the researcher's, so only the count and segments travel) */
      if (noShows.length) await emitNotifyEvent(notifyDeps(), { type: "live_session.no_show", surveyId: params.id, studyTitle: row.state.title, ref: row.id, idempotencyKey: `live_session.no_show:${row.id}`, link: studioLink(params.id, { tab: "qualitative", qual: "live" }), detail: { no_shows: noShows.length, invited: invites.filter((i) => i.role === "participant" && i.status !== "revoked").length, segments: [...new Set(noShows.map((i) => i.segment).filter(Boolean))].join(", ") || null } }).catch(() => null);
      const attended = members.filter((m) => m.role === "participant" && m.state !== "waiting" && m.state !== "denied");
      const sessionNotes = `Live session run in Rescript (${row.state.settings.transport === "sfu" ? "LiveKit" : "built-in browser connection"}): ${attended.length} participant${attended.length === 1 ? "" : "s"} took part${noShows.length ? `, ${noShows.length} no-show${noShows.length === 1 ? "" : "s"}` : ""}; ${tr.meta.tracks.transcribed} recording chunk${tr.meta.tracks.transcribed === 1 ? "" : "s"} transcribed per speaker.${tr.meta.warnings.length ? ` ${tr.meta.warnings.join(" ")}` : ""}`;
      const observations = notes.map((n) => ({ ...(hms(n.offsetSeconds) ? { at: hms(n.offsetSeconds) } : {}), text: `${n.author}: ${n.text}` }));
      const consent = { captured: true, recording: row.state.settings.record, method: "accepted on the live-session consent screen before joining", at: row.state.startedAt ?? undefined };
      if (w.sandbox) {
        return json({ ok: true, sandbox: true, transcript: tr, session: { title: row.state.title, kind: row.state.kind, scheduledAt: row.state.scheduledAt ?? row.state.startedAt, moderator: actorName, participants: tr.participants, consent, notes: sessionNotes, observations, status: "completed" } });
      }
      if (!tr.segments.length) return json({ error: "Nothing was transcribed from this session (no recording reached us, or nobody spoke while it was live). The session record is kept.", code: "empty", progress: trackSummary(tracks, members) }, 422);
      const sessionId = row.qualSessionId ?? (checkRow(await db!.from("qual_sessions").insert({ survey_id: params.id, kind: row.state.kind, title: row.state.title, scheduled_at: row.state.scheduledAt, moderator: actorName, status: "planned", created_by: w.user!.userId, updated_by: w.user!.userId }).select("id").single(), "session") as { id: string }).id;
      await db!.from("qual_sessions").update({ participants: [...tr.participants, ...noShows.map((i, k) => ({ id: `noshow${k + 1}`, label: `No-show ${k + 1}`, ...(i.segment ? { segment: i.segment } : {}) }))], consent, notes: sessionNotes, observations, status: "completed", scheduled_at: row.state.scheduledAt ?? row.state.startedAt, updated_by: w.user!.userId }).eq("id", sessionId).eq("survey_id", params.id);
      const ins = checkRow(await db!.from("qual_transcripts").insert({ survey_id: params.id, session_id: sessionId, title: tr.title.slice(0, 200), source: "stt", format: "stt", segments: tr.segments, speakers: tr.speakers, char_count: tr.segments.reduce((n, s) => n + s.text.length, 0), meta: { ...tr.meta, warnings: tr.meta.warnings }, status: "ready", created_by: w.user!.userId }).select("id").single(), "transcript") as { id: string };
      await store.link(row.id, { qualSessionId: sessionId, transcriptId: ins.id });
      await enqueueAutoCode(db!, params.id, ins.id, w.user!.userId).catch(() => null);
      await event("live.finalized", `Finalized the live session “${row.state.title}”: one transcript of ${tr.segments.length} turns from ${Object.keys(tr.speakers).length} speakers (separate tracks), ${noShows.length} no-show${noShows.length === 1 ? "" : "s"}`, [row.id, ins.id, sessionId]);
      return json({ ok: true, transcriptId: ins.id, sessionId, turns: tr.segments.length, warnings: tr.meta.warnings });
    }
    return json({ error: "action is schedule, update, cancel, invite, revoke, relink, send, join or finalize" }, 400);
  } catch (e) {
    if (e instanceof LiveError) return json({ error: e.message, code: e.code }, e.status);
    if (liveMigrationMissing(e)) return json({ error: LIVE_MIGRATION_MESSAGE, code: "migration_required" }, 503);
    return storeFailure(e);
  }
}
