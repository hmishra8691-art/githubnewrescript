import { NextRequest } from "next/server";
import { codesOfTheme, emergingThemes, emotionPrompt, emotionSummary, gateEmotions, EMOTION_SYSTEM, redactText } from "@rescript/analytics";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { hasPii, json, recordEvents, refuse, storeFailure } from "@/lib/qual/qualStore";
import { modelRunner } from "@/lib/qual/synthesisStore";
import { synthesisContext } from "@/lib/qual/synthesisContext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * QUALITATIVE DEPTH (Intelligent Mode IM9, 2026-11-06).
 *
 *   POST { action: "emerging", since: ISO date }   which themes are new, rising or fading in the transcripts added since
 *                                                  the date against the earlier ones — the code's, no model
 *   POST { action: "emotion", theme: id | name }   a language model's reading of the emotion in a theme's excerpts
 *                                                  (≤ 40), each tied to a verbatim cue or dropped; redacted and fenced
 *                                                  like every qualitative call; metered; the answer only — nothing stored
 */
const EMOTION_SCHEMA = { type: "object", properties: { readings: { type: "array", items: { type: "object", properties: { id: { type: "string" }, emotion: { type: "string" }, polarity: { type: "string" }, cue: { type: "string" } }, required: ["id", "emotion", "polarity", "cue"] } } }, required: ["readings"] };

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("code"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "code");
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "expected a JSON body" }, 400);
  try {
    const db = supabaseService();
    const ctx = await synthesisContext(db, params.id);
    if (body.action === "emerging") {
      const since = typeof body.since === "string" && !Number.isNaN(Date.parse(body.since)) ? Date.parse(body.since) : null;
      if (since === null) return json({ error: "since is a date (YYYY-MM-DD) — the transcripts added after it are the recent ones" }, 400);
      const recent = new Set(ctx.full.transcripts.filter((t) => t.createdAt && Date.parse(t.createdAt) >= since).map((t) => t.id));
      if (!recent.size) return json({ ok: true, emerging: null, note: "No transcript was added since that date — nothing to compare." });
      if (recent.size === ctx.full.transcripts.length) return json({ ok: true, emerging: null, note: "Every transcript was added since that date — there is no earlier period to compare against." });
      return json({ ok: true, emerging: emergingThemes(ctx.state, ctx.segments, recent), recentSources: recent.size, earlierSources: ctx.full.transcripts.length - recent.size });
    }
    if (body.action === "emotion") {
      const key = String(body.theme ?? "").trim().toLowerCase();
      const theme = ctx.state.codebook.themes.find((t) => t.id === key || t.name.toLowerCase() === key) ?? ctx.state.codebook.themes.find((t) => t.name.toLowerCase().includes(key));
      if (!theme) return json({ error: `No theme called “${String(body.theme ?? "")}” — the themes are ${ctx.state.codebook.themes.map((t) => t.name).join(", ")}.` }, 404);
      const codes = new Set(codesOfTheme(ctx.state, theme.id).map((c) => c.id));
      const redact = (t: string) => redactText(t, { names: ctx.names }).text;
      const excerpts = ctx.state.excerpts.filter((e) => codes.has(e.codeId) && e.status !== "rejected").slice(0, 40).map((e) => ({ id: e.id, quote: redact(e.quote) }));
      if (!excerpts.length) return json({ ok: true, emotion: null, note: `“${theme.name}” has no coded excerpts to read.` });
      const runner = await modelRunner(gate.user, params.id, "qual_emotion");
      if ("response" in runner) return runner.response;
      const m = await runner.run({ system: EMOTION_SYSTEM, prompt: (nonce: string) => emotionPrompt(excerpts, nonce), maxTokens: 60 * excerpts.length + 200, schema: EMOTION_SCHEMA, schemaName: "qual_emotion", fake: () => ({ readings: excerpts.map((e, i) => ({ id: String(i + 1), emotion: "neutral", polarity: "neutral", cue: e.quote.slice(0, Math.min(20, e.quote.length)) })) }), seed: `emotion:${theme.id}` });
      if (!m.ok) return m.response;
      const g = gateEmotions(m.value, excerpts);
      const s = emotionSummary(g.kept, excerpts.length);
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: "synthesis.emotion", detail: `Read the emotion in “${theme.name}”: ${s.lines[0]}`.slice(0, 500), ids: [theme.id] }]);
      return json({ ok: true, theme: theme.name, emotion: { ...s, readings: g.kept.map((k) => ({ ...k, quote: (excerpts.find((e) => e.id === k.excerptId)?.quote ?? "").slice(0, 300) })) }, calls: runner.calls, piiShown: hasPii(gate) });
    }
    return json({ error: "action is emerging or emotion" }, 400);
  } catch (e) { return storeFailure(e); }
}
