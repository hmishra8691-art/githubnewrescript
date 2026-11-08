import { NextRequest, NextResponse } from "next/server";
import { aiProviderName, completeJson, fenceUntrusted, UNTRUSTED_DATA_RULE } from "@rescript/ai";
import { applyDecisions, askable, choicesListing, clarifications, coerceSuggestions, fakeSuggest, surveyListing, withSuggestions, SUGGEST_SYSTEM_PROMPT, type CanonicalSurvey, type Decision } from "@rescript/import";
import { requireAiCaller } from "@/lib/aiGate";
import { billingProjectFor, meteredAi, refusalResponse } from "@/lib/metering";
import { canSee, notFound } from "@/lib/import/sessionAccess";
import { importSessionStore } from "@/lib/import/sessionsServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300; // 2026-11-07: 5× the old limit — no AI request fails at an arbitrary 60 s

/**
 * AI SUGGESTIONS FOR AN IMPORT'S OPEN QUESTIONS (I6). Body: `{ surveyId }` (the project the call is billed to,
 * `sandbox` for the fixture). The model sees the questionnaire listing and, per open question that has no
 * recommendation, the instruction's words and the NUMBERED choices the engine built — fenced as untrusted data —
 * and may only pick one of those choices (or none). Reply: the open questions with the AI's picks as labelled,
 * not pre-selected, recommendations. One AI_REQUEST, metered and refused like every other. Nothing is applied.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireAiCaller(req);
  if (!gate.ok) return gate.response;
  const store = importSessionStore();
  const s = await store.get(params.id).catch(() => null);
  if (!s || !canSee(s, { user: gate.user, customerId: gate.user?.customerId ?? null })) return notFound();
  if (s.status !== "analyzed") return NextResponse.json({ error: `This import is already ${s.status.replace("_", " ")}.` }, { status: 409 });
  if (!s.canonical) return NextResponse.json({ error: "This import's reconstructed model was not kept; import the file again." }, { status: 410 });
  let body: { surveyId?: unknown };
  try { body = await req.json(); } catch { body = {}; }

  /* the questions as they stand after the decisions already made */
  const canonical = applyDecisions(s.canonical as CanonicalSurvey, (s.decisions as Decision[]) ?? []).canonical;
  const asks = clarifications(canonical);
  const open = askable(asks);
  if (!open.length) return NextResponse.json({ ok: true, clarifications: asks, suggested: 0, note: "Every open question already has a recommended answer, or nothing to choose from." });

  const billing = await billingProjectFor(gate.user, body.surveyId ?? (s.customerId === null ? "sandbox" : s.surveyId));
  if ("response" in billing) return billing.response;
  const nonce = `imp${s.id.replace(/[^\w]/g, "").slice(-12)}`;
  const user = `${fenceUntrusted(surveyListing(canonical), { source: `questionnaire ${s.fileName}`, nonce, maxChars: 40_000 })}\n\nOpen questions:\n${fenceUntrusted(choicesListing(open), { source: "open questions", nonce, maxChars: 20_000 })}`;
  const system = `${SUGGEST_SYSTEM_PROMPT}\n\n${UNTRUSTED_DATA_RULE}`;
  try {
    const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: system + user, maxTokens: 900, operation: "import_suggest" },
      async () => aiProviderName() === "fake" ? fakeSuggest(canonical, open) : completeJson(system, user, 900, { timeoutMs: 225_000 }));
    if (!m.ok) return refusalResponse(m);
    const sug = coerceSuggestions(m.value, open);
    return NextResponse.json({ ok: true, clarifications: withSuggestions(asks, sug), suggested: sug.length, asked: open.length });
  } catch (e) {
    console.warn("[rescript:ai] import suggestions failed", JSON.stringify({ error: (e as Error).message }));
    return NextResponse.json({ ok: false, error: "The AI suggestions could not be made. Nothing was changed — answer the questions yourself." }, { status: 502 });
  }
}
