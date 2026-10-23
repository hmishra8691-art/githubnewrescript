import { NextRequest } from "next/server";
import { freshUrl, MediaError } from "@rescript/media";
import { applyReelOp, reelItemStates, excerptClip, redactText, type HighlightReel } from "@rescript/analytics";
import { liveClip } from "@rescript/analytics/live";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { qualGuardCapability, qualRefusal } from "@/lib/qual/qualAccess";
import { hasPii, json, recordEvents, refuse, storeFailure, UUID } from "@/lib/qual/qualStore";
import { parseReelOp } from "@/lib/qual/synthesisWorkspace";
import { insertReel, listReels, saveReel } from "@/lib/qual/synthesisStore";
import { synthesisContext } from "@/lib/qual/synthesisContext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * HIGHLIGHT REELS (2026-10-22).
 *
 *   GET                         the reels, each item's state (current / changed / removed) and whether a clip
 *                               can be played (its source has a recording and the segment a timestamp) — Data view
 *   GET ?clip=<excerptId>       a 15-minute signed URL of the recording with the clip's start and end — Data view
 *                               + contact details (a voice cannot be redacted), logged like any playback
 *   POST { action: "create", name, description?, excerptIds? }      Data view + Analytics edit
 *   POST { action: "op", reelId, version, op }                     add / remove / move / note / rename
 *   POST { action: "delete", reelId }
 *   exports: POST qual/export { type: "highlights", reelId, format: "docx" | "pptx" } — Data view + report downloads
 *
 * Clips play the turn a quote is in (no word timings); they are not stitched into one video. The sandbox (fake
 * provider) exports the reel it sends; it has no recordings.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (isFailure(authed)) return authed.response;
  const clip = req.nextUrl.searchParams.get("clip");
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability(clip ? "playback" : "read"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, clip ? "playback" : "read");
  if (refused) return refused;
  const db = supabaseService();
  try {
    const ctx = await synthesisContext(db, params.id);
    const mediaOf = (sourceId: string) => { const t = ctx.full.transcripts.find((x) => x.id === sourceId); return t?.mediaId ?? ctx.full.sessions.find((s) => s.id === t?.sessionId)?.recordingMediaId ?? null; };
    if (clip) {
      const e = ctx.state.excerpts.find((x) => x.id === clip);
      if (!e) return json({ error: "no such excerpt" }, 404);
      /* the excerpt's own words when the transcript has word timings (#17), else the whole turn */
      let range = excerptClip(e, ctx.segments);
      let mediaId = mediaOf(e.sourceId);
      /* G2 2026-10-22: a live session's transcript is made of per-speaker chunks — the clip plays the chunk the turn was said in */
      const live = range ? liveClip(ctx.rows.transcripts.find((t) => t.id === e.sourceId)?.meta, e.segmentId, range) : null;
      if (live && range) { mediaId = live.mediaId; range = { ...range, start: live.start, end: live.end }; }
      if (!range || !mediaId) return json({ error: "This excerpt has no clip: its transcript has no recording or no timestamps.", code: "no_clip" }, 404);
      const handle = mediaDbOrResponse();
      if ("response" in handle) return handle.response;
      const { data: owned } = await handle.db.from("media_objects").select("id, survey_id, kind").eq("id", mediaId).maybeSingle();
      if (!owned || owned.survey_id !== params.id) return json({ error: "no such recording" }, 404);
      const { url } = await freshUrl(handle.db, mediaId, { seconds: 15 * 60 });
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: "recording.clip_played", detail: `Played the clip of ${e.id} (${Math.round(range.start)}–${Math.round(range.end)} s)`, ids: [mediaId, e.id] }]);
      return json({ ok: true, url, start: range.start, end: range.end, approximate: range.approximate, byWords: range.byWords, expiresInSeconds: 15 * 60 });
    }
    const reels = await listReels(db, params.id);
    const pii = hasPii(gate);
    const red = (t: string) => (pii ? t : redactText(t, { names: ctx.names }).text);
    const can = { playback: qualRefusal(gate.grant, "playback") === null, edit: qualRefusal(gate.grant, "code") === null, export: qualRefusal(gate.grant, "report") === null };
    return json({ ok: true, can, reels: reels.map((r) => ({ ...r, items: r.items.map((it) => ({ ...it, ...(it.note ? { note: red(it.note) } : {}), snapshot: { ...it.snapshot, quote: red(it.snapshot.quote) }, clip: (!!mediaOf(it.snapshot.sourceId) || !!liveClip(ctx.rows.transcripts.find((t) => t.id === it.snapshot.sourceId)?.meta, it.snapshot.segmentId, { start: 0, end: 0 })) && it.snapshot.start != null })), states: reelItemStates(r, ctx.state, ctx.segments) })) });
  } catch (e) {
    if (e instanceof MediaError) return json({ error: e.message }, e.status);
    return storeFailure(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return isFailure(authed) ? authed.response : json({ error: "expected a JSON body" }, 400);
  const action = String(body.action ?? "");

  /* the sandbox keeps its reels in the page; its exports go through qual/export (type "highlights") */
  if (params.id === "sandbox") return json({ error: "the sandbox keeps its reels in the page" }, 400);

  if (isFailure(authed)) return authed.response;
  const op = "code";
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability(op));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, op);
  if (refused) return refused;
  const db = supabaseService();
  try {
    const ctx = await synthesisContext(db, params.id);
    const reels = await listReels(db, params.id);
    const reelId = String(body.reelId ?? "");
    const reel = reels.find((r) => r.id === reelId);
    const nowIso = new Date().toISOString();
    if (action === "create") {
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : "";
      if (!name) return json({ error: "a reel needs a name" }, 400);
      let draft: HighlightReel = { id: "new", name, ...(typeof body.description === "string" && body.description.trim() ? { description: body.description.trim().slice(0, 1000) } : {}), items: [], createdBy: gate.user.userId, createdAt: nowIso, updatedAt: nowIso, version: 0 };
      const ex = Array.isArray(body.excerptIds) ? body.excerptIds.map(String).slice(0, 100) : [];
      if (ex.length) { try { draft = applyReelOp(draft, { op: "add", excerptIds: ex }, ctx.state, ctx.segments, nowIso); } catch (e) { return json({ error: (e as Error).message }, 400); } }
      const id = await insertReel(db, params.id, draft, gate.user.userId);
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: "highlights.created", detail: `Made the highlight reel “${name}” (${draft.items.length} quote${draft.items.length === 1 ? "" : "s"})`, ids: [id] }]);
      return json({ ok: true, id, reels: await listReels(db, params.id) });
    }
    if (!UUID.test(reelId) || !reel) return json({ error: "no such reel" }, 404);
    if (action === "op") {
      const o = parseReelOp(body.op);
      if (typeof o === "string") return json({ error: o }, 400);
      if (Number(body.version) !== reel.version) return json({ error: "The reel changed since you loaded it — reload, then try again.", code: "version_conflict" }, 409);
      let next: HighlightReel;
      try { next = applyReelOp(reel, o, ctx.state, ctx.segments, nowIso); } catch (e) { return json({ error: (e as Error).message }, 400); }
      if (!(await saveReel(db, params.id, next, reel.version))) return json({ error: "The reel changed at the same moment — reload, then try again.", code: "version_conflict" }, 409);
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: `highlights.${o.op}`, detail: `Highlight reel “${next.name}”: ${o.op}`, ids: [reel.id] }]);
      return json({ ok: true, reels: await listReels(db, params.id) });
    }
    if (action === "delete") {
      await db.from("qual_highlights").delete().eq("survey_id", params.id).eq("id", reel.id);
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: "highlights.deleted", detail: `Deleted the highlight reel “${reel.name}”`, ids: [reel.id] }]);
      return json({ ok: true, reels: await listReels(db, params.id) });
    }
    return json({ error: "action is create, op or delete (exports: qual/export, type “highlights”)" }, 400);
  } catch (e) { return storeFailure(e); }
}
