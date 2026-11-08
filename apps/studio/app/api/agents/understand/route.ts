import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { completeJson } from "@rescript/ai";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { billingProjectFor, meteredAi } from "@/lib/metering";
import { aiReadyFor } from "@/lib/byok/connect";
import { NORMALISE_SYSTEM_PROMPT, normaliseUserPrompt, coerceNormalised } from "@/lib/intelligent/voice";
import { understand } from "@/lib/agents/understand";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 2026-11-07: 5× the old limit — no AI request fails at an arbitrary 60 s

/**
 * POST /api/agents/understand { surveyId, text, english?, language?, definition } — what the researcher's sentence
 * asks the agents to do (lib/agents/understand.ts): the agent, its fields, what was understood, the assumptions and
 * the questions still open. Nothing is planned, started or charged as a task here.
 *
 * Spoken input arrives already read into English by /api/ai/transcribe. A TYPED sentence in another script is read
 * the same way — the transcription route's own normaliser, metered as one AI request — when AI is available to this
 * caller; otherwise the readers work on the original words (they know Hindi as well as English) and the reply says so.
 *
 * `project.read`: understanding a sentence changes nothing. The sandbox may ask without a session.
 */
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const NON_LATIN = /[Ѐ-ӿ֐-ۿऀ-෿฀-໿぀-ヿ一-鿿가-힯]/;

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  let body: { surveyId?: unknown; text?: unknown; english?: unknown; language?: unknown; definition?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId.trim() : "";
  if (!surveyId) return json({ error: "surveyId is required" }, 400);
  if (surveyId !== "sandbox") {
    if (isFailure(user)) return user.response;
    const ctx = await requireProjectFor(user, surveyId, "project.read");
    if (isFailure(ctx)) return ctx.response;
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  if (!text) return json({ error: "say what you want (text)" }, 400);
  const parsed = SurveyDefinition.safeParse(body.definition);
  if (!parsed.success) return json({ error: "send the survey as it is open (definition)" }, 400);
  let english = typeof body.english === "string" && body.english.trim() ? body.english.trim().slice(0, 4000) : undefined;
  let language = typeof body.language === "string" && body.language.trim() ? body.language.trim().slice(0, 12) : undefined;
  let note: string | null = null;

  if (!english && NON_LATIN.test(text)) {
    const authed = isFailure(user) ? null : user;
    try {
      if (await aiReadyFor(authed, surveyId === "sandbox" ? null : surveyId, "intelligent_voice_normalise")) {
        const billing = await billingProjectFor(authed, surveyId, "project.read");
        if (!("response" in billing)) {
          const prompt = normaliseUserPrompt(text, language ?? null);
          const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: NORMALISE_SYSTEM_PROMPT + prompt, maxTokens: 300, operation: "intelligent_voice_normalise" }, () => completeJson(NORMALISE_SYSTEM_PROMPT, prompt, 300, { timeoutMs: 100_000 }));
          const n = m.ok ? coerceNormalised(m.value) : null;
          if (n) { english = n.english; if (n.language && n.language !== "und") language = n.language; }
        }
      }
    } catch (e) { console.warn("[rescript:agents] understand normalisation failed", JSON.stringify({ error: (e as Error).message.slice(0, 200) })); }
    if (!english) note = "This was read in its own words — no model was available to read it into English, so less may have been understood. Check the fields before starting.";
  }
  const u = understand({ text, ...(english ? { english } : {}), ...(language ? { language } : {}), survey: parsed.data });
  return json({ ok: true, understanding: u, english: english ?? null, language: language ?? null, note });
}
