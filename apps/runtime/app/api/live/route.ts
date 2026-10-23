import { NextRequest } from "next/server";
import { joinWithInvite, memberAction, type LiveRoomRow, type LiveMember } from "@rescript/analytics/live";
import { connectionFor, forward, hasDatabase, liveDeps, liveStore, reply, sandboxForwarding } from "@/lib/live";
import { panelParams, runtimePanels } from "@/lib/panels";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * A PARTICIPANT OR AN EXTERNAL OBSERVER IN A LIVE SESSION (2026-10-22, G2) — POST { action, … }.
 *
 *   join   { invite, consent?, device? }   without `consent`: what the join page shows (the title, the time, the
 *          consent text — nothing about anyone else); with it: consent checked (no agreement → no room; a recorded
 *          session needs the recording consent; an observer confirms confidentiality), a handle (P1 …) and a member
 *          token for this tab (only its hash is stored), ICE servers. The same link again = the same place back.
 *   poll / signal / op / view / chat / note / ice   { token, … } — see `memberAction` in @rescript/analytics/live.
 *
 * Who may call: anyone holding a link (like a survey link). A participant only ever learns the moderator and the
 * other participants in the room — never an observer, never a name, never the back room. An observer link opens the
 * back room (receive-only, relayed by the moderator; chat with the moderator; timestamped notes).
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return reply({ error: "bad json" }, 400); }
  if (!body || typeof body !== "object") return reply({ error: "bad request" }, 400);
  if (!hasDatabase()) return sandboxForwarding() ? forward("/room", body) : reply({ error: "Live sessions are not available on this installation." }, 503);
  try {
    const store = liveStore();
    /* G3 2026-10-22: a panel participant's end link, once the session has ended — { action: "panel", token } */
    if (body.action === "panel") {
      const m = /^[A-Za-z0-9_-]{24,120}$/.test(String(body.token ?? "")) ? await store.memberByHash(liveDeps.hash(String(body.token))) : null;
      if (!m || m.role !== "participant" || !m.inviteId) return reply({ ok: true, panel: null });
      const row = await store.room(m.roomId);
      const panels = runtimePanels();
      if (!row || !panels || row.state.status !== "ended") return reply({ ok: true, panel: null });
      const out = await panels.exit({ sessionRef: `live:${m.inviteId}`, outcome: "complete", status: "live_ended" });
      return reply({ ok: true, panel: out ? { url: out.url, code: out.showCode ? out.code : null } : null });
    }
    /* G3 2026-10-22: a panel participant joining with consent — matched to the study's panel by the link's parameters;
       refused without the panel's id, or when that id already took part (a rejoin through the same invite is welcome) */
    let panelEntry: { entryId: string } | null = null;
    const panelsForJoin = body.action === "join" && body.consent !== undefined ? runtimePanels() : null;
    if (panelsForJoin && typeof body.invite === "string") {
      const invite = await store.inviteByHash(liveDeps.hash(String(body.invite)));
      const row = invite && invite.role === "participant" ? await store.room(invite.roomId) : null;
      if (invite && row) {
        const e = await panelsForJoin.enter({ surveyId: row.surveyId, target: "live_session", targetRef: row.id, params: panelParams(body.params), isTest: false });
        if (e.kind === "duplicate" && e.sessionRef !== `live:${invite.id}`) return reply({ error: e.message, code: "panel_duplicate" }, 409);
        if (e.kind === "refused") return reply({ error: e.message, code: "panel_refused" }, 409);
        if (e.kind === "over_quota") return reply({ error: e.message, code: "panel_over_quota", panel: { url: e.redirect.url, code: e.redirect.showCode ? e.redirect.code : null } }, 409);
        if (e.kind === "admitted") { await panelsForJoin.attach(e.entryId, `live:${invite.id}`); panelEntry = { entryId: e.entryId }; }
      }
    }
    void panelEntry;
    if (body.action === "join") {
      const { params: _params, ...joinBody } = body;
      const r = await joinWithInvite(store, joinBody, liveDeps);
      if (r.status !== 200 || !r.body.token) return reply(r.body, r.status);
      const m = (await store.memberByHash(liveDeps.hash(String(r.body.token))))!;
      const row = (await store.room(m.roomId))!;
      return reply({ ...r.body, connection: await connectionFor(row, m) });
    }
    if (body.action === "ice") {
      const m = /^[A-Za-z0-9_-]{24,120}$/.test(String(body.token ?? "")) ? await store.memberByHash(liveDeps.hash(String(body.token))) : null;
      if (!m || m.role === "moderator") return reply({ error: "Join the session first.", code: "not_joined" }, 401);
      const row = (await store.room(m.roomId))!;
      return reply({ ok: true, connection: await connectionFor(row, m) });
    }
    const r = await memberAction(store, body, liveDeps, { allowRoles: ["participant", "observer"], onPoll: async (row: LiveRoomRow, m: LiveMember) => (row.state.settings.transport === "sfu" && m.state === "admitted" ? { connection: await connectionFor(row, m) } : undefined) });
    return reply(r.body, r.status);
  } catch (e) {
    console.warn("[rescript:live] request failed", JSON.stringify({ action: String(body.action ?? ""), error: (e as Error).message }));
    return reply({ error: "Something went wrong — trying again." }, 500);
  }
}
