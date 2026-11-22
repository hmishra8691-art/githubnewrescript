import { NextRequest } from "next/server";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { surveyDb } from "@/lib/db";
import { freshUrl, MediaError } from "@rescript/media";
import { planReel, renderReel, loadReportFonts, type ReelSource, type ReelItemIn } from "@rescript/reportvideo";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { qualGuardCapability, qualRefusal } from "@/lib/qual/qualAccess";
import { json, recordEvents, refuse, storeFailure, UUID } from "@/lib/qual/qualStore";
import { listReels } from "@/lib/qual/synthesisStore";
import { synthesisContext } from "@/lib/qual/synthesisContext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * A HIGHLIGHT REEL AS ONE VIDEO (Q4, 2026-11-29).
 *
 * POST { reelId, plan?: true, withoutConsent?: "card" | "skip", maxSeconds? }
 *   plan: true   what would be cut, as text: each item footage / card / skip with the reason (recording consent from
 *                the session, the recording, the quote's time range) — Data view
 *   otherwise    the MP4: title card, consented clips with the quote burned in, text cards for the rest —
 *                needs playback (a voice cannot be redacted) and report downloads; logged like a playback.
 *
 * Speakers are shown as Participant 1, 2… — never names. A participant whose session does not record recording
 * consent as given is never shown on video. Rendering runs on this instance (ffmpeg), so a long reel needs a
 * deployment that allows a long request; up to 20 clips and 180 seconds.
 */
const MAX_FOOTAGE = 20;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (isFailure(authed)) return authed.response;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const planOnly = body?.plan === true;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability(planOnly ? "read" : "playback"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, planOnly ? "read" : "playback");
  if (refused) return refused;
  if (!planOnly && qualRefusal(gate.grant, "report")) return json({ error: "Rendering a reel needs report downloads as well as playback.", code: "insufficient_role" }, 403);
  const reelId = typeof body?.reelId === "string" && UUID.test(body.reelId) ? body.reelId : null;
  if (!reelId) return json({ error: "Which reel? Pass reelId." }, 400);
  const db = gate.db;
  try {
    const [ctx, reels] = await Promise.all([synthesisContext(db, params.id), listReels(db, params.id)]);
    const reel = reels.find((r) => r.id === reelId);
    if (!reel) return json({ error: "No such reel." }, 404);
    const mediaOf = (sourceId: string) => { const t = ctx.full.transcripts.find((x) => x.id === sourceId); return t?.mediaId ?? ctx.full.sessions.find((s) => s.id === t?.sessionId)?.recordingMediaId ?? null; };
    const consentOf = (sourceId: string) => { const t = ctx.full.transcripts.find((x) => x.id === sourceId); return ctx.full.sessions.find((s) => s.id === t?.sessionId)?.consent ?? null; };
    const items: ReelItemIn[] = reel.items.map((it) => ({ excerptId: it.excerptId, sourceId: it.snapshot.sourceId, quote: it.snapshot.quote, ...(it.snapshot.start != null ? { start: it.snapshot.start } : {}), ...(it.snapshot.end != null ? { end: it.snapshot.end } : {}) }));
    const ids = [...new Set(items.map((i) => i.sourceId))];
    const sources: ReelSource[] = ids.map((sourceId) => ({ sourceId, file: mediaOf(sourceId) ? `media:${mediaOf(sourceId)}` : null, hasVideo: true, consent: consentOf(sourceId) }));
    const opts = { brand: { title: reel.name, ...(reel.description ? { subtitle: reel.description } : {}) }, withoutConsent: body?.withoutConsent === "skip" ? "skip" as const : "card" as const, maxSeconds: Math.min(180, Math.max(10, Number(body?.maxSeconds) || 180)) };
    const plan = planReel(items, sources, opts);
    if (planOnly) return json({ ok: true, plan: { ...plan, clips: plan.clips.map(({ file: _f, ...c }) => c) } });
    const footage = plan.clips.filter((c) => c.mode === "footage");
    if (footage.length > MAX_FOOTAGE) return json({ error: `This reel has ${footage.length} clips with footage; up to ${MAX_FOOTAGE} are rendered at once. Split it, or shorten it.` }, 413);
    /* fetch each recording once, after the same ownership check as playback */
    const dir = mkdtempSync(join(tmpdir(), "reelsrc-"));
    try {
      const handle = await mediaDbOrResponse(() => surveyDb(params.id));
      if ("response" in handle) return handle.response;
      const local = new Map<string, string>();
      for (const c of footage) {
        const mediaId = c.file!.slice("media:".length);
        if (local.has(mediaId)) { c.file = local.get(mediaId)!; continue; }
        const { data: owned } = await handle.db.from("media_objects").select("id, survey_id, kind").eq("id", mediaId).maybeSingle();
        if (!owned || owned.survey_id !== params.id) return json({ error: "A recording in this reel is not this survey's." }, 404);
        const { url } = await freshUrl(handle.db, mediaId, { seconds: 15 * 60 });
        const res = await fetch(url);
        if (!res.ok) return json({ error: `A recording could not be fetched (${res.status}).` }, 502);
        const file = join(dir, `${mediaId}`);
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        local.set(mediaId, file); c.file = file;
        c.hasVideo = !/^audio/.test(String(owned.kind ?? "")) && owned.kind !== "audio";
      }
      const out = await renderReel(plan, loadReportFonts(join(process.cwd(), "public", "report-fonts")), { signal: req.signal });
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: "reel.rendered", detail: `Rendered the reel “${reel.name}”: ${out.footage} clip${out.footage === 1 ? "" : "s"}, ${out.cards} text card${out.cards === 1 ? "" : "s"}, ${Math.round(out.seconds)} s`, ids: [reel.id] }]);
      const name = reel.name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "reel";
      return new Response(new Uint8Array(out.bytes), { headers: { "content-type": "video/mp4", "content-disposition": `attachment; filename="${name}.mp4"`, "cache-control": "no-store", "x-reel-notes": encodeURIComponent(plan.notes.join(" ")) } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } catch (e) {
    if (e instanceof MediaError) return json({ error: e.message }, e.status);
    return storeFailure(e);
  }
}
