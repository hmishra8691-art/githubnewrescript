import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { SurveyDefinition } from "@rescript/schema";
import { aiConfigured, aiProviderName, completeJson, embedTexts, aiEmbeddingsModelName } from "@rescript/ai";
import { applySurveyActions, diffSurveys, reviewSurvey } from "@rescript/engine";
import { ResearchIndex } from "@rescript/import/research";
import { isFailure, requireUser, type AuthedUser } from "@/lib/guard";
import { billingProjectFor, meteredAi, refusalResponse } from "@/lib/metering";
import { describeThemeImage, withThemeImage } from "@/lib/copilot/themeImageText";
import { COPILOT_SYSTEM_PROMPT, classifyRequest, coerceCopilotReply, copilotUserPrompt, analysisIntent, translationIntent, referencedQuestions, surveyLanguageOf, type RequestMode, type TurnMemory } from "@/lib/copilot/prompt";
import { researchCards, researchPassages } from "@/lib/copilot/research";
import { researchStoreFor } from "@/lib/copilot/store";
import { copilotOutline } from "@/lib/copilot/outline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * ONE COPILOT TURN (the copilot brief §15): reasoning → structured actions →
 * validation → preview. Nothing is written here.
 *
 *   1  what the request needs (classifyRequest): generate / edit / review /
 *      question, and whether it is about the research at all
 *   2  the RELEVANT context only: a compact outline of the survey with the
 *      questions the request names in full; the research cards and the few
 *      passages that match — only when the request is about the research;
 *      the conversation memory and the last turns; for a review, what the
 *      engine's own checks already found (so the model adds meaning, not a
 *      second copy of the facts)
 *   3  the model, metered, with an identical request answered from a short
 *      cache instead of paying twice
 *   4  the gate: coerceCopilotReply, then every action applied to a CLONE of
 *      the survey by the engine — refused actions are reported with their
 *      reasons, destructive ones flagged, the diff computed
 *
 * The browser shows the preview; Apply is the researcher's, one undoable
 * edit, saved by the ordinary save path (which validates again).
 *
 * Body: { surveyId, message, definition, selectedId?, memory?, mode? }.
 * TEST SEAM, fake provider only: `fake` (a reply object) stands in for the
 * model, which the fake cannot be; ignored with a real provider.
 */

const CACHE = new Map<string, { at: number; value: unknown }>();
const TTL = 15 * 60_000;

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  let body: { surveyId?: unknown; message?: unknown; definition?: unknown; selectedId?: unknown; memory?: TurnMemory; mode?: unknown; fake?: unknown; scope?: unknown; themeImage?: unknown };
  try { body = await req.json(); } catch { return isFailure(authed) ? authed.response : NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  let user: AuthedUser | null = null;
  if (isFailure(authed)) {
    if (!(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;
  } else user = authed;
  if (!aiConfigured()) return NextResponse.json({ error: "No language model is configured on this Studio (AI_API_URL). The built-in grammar still handles common edits.", code: "ai_unconfigured" }, { status: 501 });
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 8000) : "";
  if (!message) return NextResponse.json({ error: "say what you want" }, { status: 400 });
  const parsed = SurveyDefinition.safeParse(body.definition);
  if (!parsed.success) return NextResponse.json({ error: "send the survey as it is open in the editor (definition)" }, { status: 400 });
  const def = parsed.data;
  const billing = await billingProjectFor(user, surveyId);
  if ("response" in billing) return billing.response;
  const { meter, ctx } = billing;

  /* 1–2: the context this request needs, and no more */
  const store = await researchStoreFor(surveyId);
  const docs = await store.list(surveyId);
  const classified = classifyRequest(message, def.questions.length, docs.length);
  // the Branding panel's theme assistant: a look-only request by construction
  const themeScope = body.scope === "theme";
  const cls = themeScope ? { ...classified, mode: "ux" as RequestMode, ux: true, uxOnly: true } : classified;
  const mode: RequestMode = body.mode === "review" ? "review" : body.mode === "generate" ? "generate" : cls.mode;
  /* an image to build the theme from: its colours go to the model, its address stays here */
  const ti = body.themeImage && typeof body.themeImage === "object" ? body.themeImage as { url?: unknown; name?: unknown; dominant?: unknown; palette?: unknown; dark?: unknown } : null;
  const themeImageUrl = ti && typeof ti.url === "string" && (/^https:\/\/[^\s"'()<>\\]+$/i.test(ti.url) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(ti.url) || /^\/[^\s"'()<>\\]+$/.test(ti.url)) ? ti.url : null;
  const themeImageText = ti && themeImageUrl ? describeThemeImage({ name: typeof ti.name === "string" ? ti.name.slice(0, 80) : undefined, dominant: Array.isArray(ti.dominant) ? ti.dominant.filter((c): c is string => typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c)).slice(0, 8) : [], palette: ti.palette && typeof ti.palette === "object" ? Object.fromEntries(Object.entries(ti.palette as Record<string, unknown>).filter(([k, v]) => /^[a-z]{2,20}$/i.test(k) && typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)).slice(0, 16)) as Record<string, string> : {}, dark: ti.dark === true }) : undefined;
  const selectedId = typeof body.selectedId === "string" ? body.selectedId : null;
  // a request about the look and behaviour gets the UX guide, the theme and the UX of the questions it names
  const uxTurn = cls.ux || mode === "ux";
  // the analysis framework: a request about it, or a generation (the design arrives with its analysis)
  const analysisTurn = analysisIntent(message) || mode === "generate";
  // languages: the translation guide, and the named questions' elements with their existing translations
  const translationTurn = translationIntent(message);
  const outline = copilotOutline(def, { selectedId, focusIds: referencedQuestions(def, message), ux: uxTurn, analysis: analysisTurn, translation: translationTurn });
  let research = "";
  let passageIds: string[] = [];
  let charge = 0;
  if (docs.length && (cls.research || mode === "generate" && def.questions.length < 3)) {
    const chunks = await store.chunks(surveyId);
    const embeddings = new Map(chunks.filter((c) => c.embedding).map((c) => [c.id, c.embedding!]));
    let queryEmbedding: number[] | undefined;
    if (embeddings.size && aiEmbeddingsModelName()) {
      const m = await meteredAi(meter, ctx, "AI_REQUEST", { estimateText: message, maxTokens: 1, operation: "copilot_query_embedding" }, () => embedTexts([message]));
      if (!m.ok) return refusalResponse(m);
      charge += m.event?.customerCharge ?? 0;
      queryEmbedding = m.value?.[0];
    }
    const index = new ResearchIndex(chunks, embeddings);
    const cards = researchCards(docs.map((d) => ({ id: d.ref, name: d.name, summary: d.summary })));
    const p = researchPassages(index, docs.map((d) => ({ id: d.ref, name: d.name })), message, { k: mode === "generate" ? 10 : 6, maxChars: mode === "generate" ? 12_000 : 7000, ...(queryEmbedding ? { queryEmbedding } : {}) });
    research = `${cards}${p.text ? `\n\nPASSAGES:\n${p.text}` : ""}`;
    passageIds = p.ids;
  }
  const deterministic = mode === "review" ? reviewSurvey(def) : null;
  const prompt = copilotUserPrompt({
    message, outline, surveyLanguage: surveyLanguageOf(def), mode,
    memory: sanitizeMemory(body.memory), research: research || undefined,
    deterministicFindings: deterministic?.findings.slice(0, 40).map((f) => `${f.severity}: ${f.message}`),
    selected: selectedId ? def.questions.find((q) => q.id === selectedId)?.code ?? null : null,
    ux: uxTurn, uxOnly: cls.uxOnly,
    analysis: analysisTurn, translation: translationTurn,
    ...(themeImageText ? { themeImage: themeImageText } : {}),
    ...(themeScope ? { themeOnly: true } : {}),
  });

  /* 3: the model — or the cache, for exactly the same request */
  const maxTokens = mode === "generate" ? 8000 : mode === "review" ? 3000 : uxTurn ? 3500 : 2500;
  const key = createHash("sha256").update(`${COPILOT_SYSTEM_PROMPT}\u0000${prompt}\u0000${maxTokens}`).digest("hex");
  // the browser suites stand in for the model: one reply, or [reply, the reply to the repair request]
  const fakes = aiProviderName() === "fake" && body.fake && typeof body.fake === "object" ? (Array.isArray(body.fake) ? body.fake : [body.fake]) : [];
  const fake = fakes[0] ?? null;
  let raw: unknown;
  let cached = false;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL && !fake) { raw = hit.value; cached = true; }
  else {
    try {
      const m = await meteredAi(meter, ctx, "AI_REQUEST", { estimateText: COPILOT_SYSTEM_PROMPT + prompt, maxTokens, operation: `copilot_${mode}` },
        () => completeJson(COPILOT_SYSTEM_PROMPT, prompt, maxTokens, { timeoutMs: mode === "generate" ? 170_000 : 90_000 }));
      if (!m.ok) return refusalResponse(m);
      charge += m.event?.customerCharge ?? 0;
      raw = fake ?? m.value;
      if (raw && !fake) { CACHE.set(key, { at: Date.now(), value: raw }); if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value!); }
    } catch (e) {
      console.warn("[rescript:copilot] turn failed", JSON.stringify({ error: (e as Error).message }));
      return NextResponse.json({ ok: false, error: `The language model did not answer: ${(e as Error).message}. Nothing was changed.` }, { status: 502 });
    }
  }

  /* 4: the gate, and the engine's validation on a clone */
  const coerced = coerceCopilotReply(raw);
  let reply = coerced && themeImageUrl ? { ...coerced, actions: withThemeImage(coerced.actions, themeImageUrl) } : coerced;
  if (!reply) {
    return NextResponse.json({ ok: true, reply: null, message: aiProviderName() === "fake" ? "The FAKE provider cannot reason about surveys; configure a real model to use the copilot." : "The model's answer had nothing I could use. Try rephrasing — nothing was changed.", context: { mode, researchUsed: !!research, passages: passageIds, promptChars: prompt.length, cached }, usage: { charge }, ...(deterministic ? { review: deterministic } : {}) });
  }
  // a look-only request cannot change the structure: the engine refuses structural actions and proves the rest left it alone
  let applied = reply.actions.length ? applySurveyActions(def, reply.actions, { uxOnly: cls.uxOnly }) : null;
  /*
   * ONE REPAIR. The model sometimes proposes something the Studio refuses — a
   * script reaching for the page, an event that does not exist, an option that
   * is not there. Rather than offer a proposal whose Apply can do nothing, the
   * refusals go back to the model once, with its answer, and it corrects
   * them. The corrected answer is used only if the Studio accepts more of it.
   */
  let repair: { refused: string[]; fixed: boolean } | undefined;
  // the failed actions, each "what it was: why" — the first entries of errors, in order
  const refused = applied ? applied.errors.slice(0, applied.results.filter((x) => !x.ok).length) : [];
  if (applied && refused.length && !cached && (aiProviderName() !== "fake" || fakes.length > 1)) {
    const repairPrompt = `${prompt}\n\nYOUR PREVIOUS ANSWER:\n${JSON.stringify(raw).slice(0, 14_000)}\n\nTHE STUDIO REFUSED ${refused.length} OF ITS ${reply.actions.length} ACTIONS:\n${refused.map((e) => `- ${e}`).join("\n")}\n\nAnswer again in the same JSON shape. Keep the accepted actions as they were; correct each refused action using only the actions, events and rs api described above, or drop it and say plainly in "reply" what the Studio cannot do. Do not mention the refusal to the user unless something could not be done.`;
    try {
      const m = await meteredAi(meter, ctx, "AI_REQUEST", { estimateText: COPILOT_SYSTEM_PROMPT + repairPrompt, maxTokens, operation: `copilot_${mode}_repair` },
        () => completeJson(COPILOT_SYSTEM_PROMPT, repairPrompt, maxTokens, { timeoutMs: 90_000 }));
      if (m.ok) {
        charge += m.event?.customerCharge ?? 0;
        const raw2 = fakes[1] ?? m.value;
        const c2 = coerceCopilotReply(raw2);
        const r2 = c2 && themeImageUrl ? { ...c2, actions: withThemeImage(c2.actions, themeImageUrl) } : c2;
        const a2 = r2 && r2.actions.length ? applySurveyActions(def, r2.actions, { uxOnly: cls.uxOnly }) : null;
        const okCount = (a: typeof applied) => (a ? a.results.filter((x) => x.ok).length - a.results.filter((x) => !x.ok).length : -Infinity);
        if (r2 && (okCount(a2) > okCount(applied) || (!a2 && !applied.results.some((x) => x.ok)))) {
          reply = r2; applied = a2;
          if (!fakes.length) { CACHE.set(key, { at: Date.now(), value: raw2 }); }
          repair = { refused, fixed: !a2 || a2.results.every((x) => x.ok) };
        } else repair = { refused, fixed: false };
      }
    } catch (e) {
      console.warn("[rescript:copilot] repair failed", JSON.stringify({ error: (e as Error).message }));
    }
  }
  const diff = applied?.valid ? diffSurveys(def, applied.def) : null;
  const passages = passageIds.length || reply.sources.length ? await describePassages(store, surveyId, docs, [...passageIds, ...reply.sources.flatMap((x) => x.passages)]) : {};
  // a citation to a passage that does not exist is not a citation: dropped, and a "document" claim with none left is only a recommendation
  for (const src of reply.sources) {
    src.passages = src.passages.filter((p) => passages[p]);
    if (src.support === "document" && !src.passages.length) src.support = "recommendation";
  }
  return NextResponse.json({
    ok: true, reply,
    validation: applied ? { valid: applied.valid, results: applied.results, errors: applied.errors, destructive: applied.destructive, warnings: applied.warnings, summary: diff?.summary ?? [], diff, uxOnly: applied.uxOnly, structureUnchanged: applied.structureUnchanged } : null,
    ...(deterministic ? { review: deterministic } : {}),
    passages,
    context: { mode, researchUsed: !!research, passages: passageIds, promptChars: prompt.length, outlineChars: outline.length, cached, ux: uxTurn, uxOnly: cls.uxOnly, analysis: analysisTurn, translation: translationTurn, ...(repair ? { repair } : {}) },
    usage: { charge },
  });
}

function sanitizeMemory(m: TurnMemory | undefined): TurnMemory | undefined {
  if (!m || typeof m !== "object") return undefined;
  const history = Array.isArray(m.history) ? m.history.filter((h) => h && (h.role === "user" || h.role === "copilot") && typeof h.text === "string").slice(-6).map((h) => ({ role: h.role, text: h.text.slice(0, 500) })) : [];
  return { ...(typeof m.memory === "string" ? { memory: m.memory.slice(0, 1000) } : {}), history };
}

async function describePassages(store: Awaited<ReturnType<typeof researchStoreFor>>, surveyId: string, docs: { ref: string; name: string }[], ids: string[]): Promise<Record<string, { doc: string; page: number; heading?: string; excerpt: string }>> {
  const want = new Set(ids);
  if (!want.size) return {};
  const name = new Map(docs.map((d) => [d.ref, d.name]));
  const out: Record<string, { doc: string; page: number; heading?: string; excerpt: string }> = {};
  for (const c of await store.chunks(surveyId)) if (want.has(c.id)) out[c.id] = { doc: name.get(c.docId) ?? c.docId, page: c.page, ...(c.heading ? { heading: c.heading } : {}), excerpt: c.text.slice(0, 280) };
  return out;
}
