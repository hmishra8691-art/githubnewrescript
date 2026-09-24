import { NextRequest, NextResponse } from "next/server";
import { completeJson } from "@rescript/ai";
import { requireAiCaller } from "@/lib/aiGate";
import { billingProjectFor, meteredAi, refusalResponse } from "@/lib/metering";
import { LOGIC_SYSTEM_PROMPT, coerceIntent, logicUserPrompt } from "@/lib/intelligent/ai";

export const dynamic = "force-dynamic";

/**
 * A SENTENCE ABOUT THE SURVEY → A STRUCTURED INTENT, for the programmer to review.
 *
 * Body: { text, context, selected?, surveyId? } → { ok, intent } — the
 * model's reading of the sentence in the Intelligent mode's intent shape, or
 * null when it had nothing usable. `context` is the compact survey listing
 * the Studio builds client-side (`surveyContext`); the route never loads a
 * survey and never writes one. The intent is turned into a proposal and
 * validated against the real survey in the browser, and applied only when
 * the programmer presses Apply. This route cannot change a survey.
 *
 * Who may ask, and who pays, follow the rephrase route exactly: a signed-in
 * Studio user; 501 when no provider is configured; the fake provider is
 * open to the sandbox. The key is read by the ai package from the
 * environment and never passes through here.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAiCaller(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
  const context = typeof body?.context === "string" ? body.context.slice(0, 60_000) : "";
  const selected = typeof body?.selected === "string" ? body.selected : null;
  const billing = await billingProjectFor(gate.user, body?.surveyId);
  if ("response" in billing) return billing.response;
  const user = logicUserPrompt(context, text, selected);
  try {
    const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: LOGIC_SYSTEM_PROMPT + user, maxTokens: 300, operation: "logic_intent" },
      () => completeJson(LOGIC_SYSTEM_PROMPT, user, 300, { timeoutMs: 20_000 }));
    if (!m.ok) return refusalResponse(m);
    return NextResponse.json({ ok: true, intent: coerceIntent(m.value), usage: m.event ? { charge: m.event.customerCharge, tokens: m.event.quantity } : null });
  } catch (e) {
    console.warn("[rescript:ai] logic intent failed", JSON.stringify({ error: (e as Error).message }));
    return NextResponse.json({ ok: true, intent: null });
  }
}
