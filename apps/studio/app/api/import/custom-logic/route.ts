import { NextRequest, NextResponse } from "next/server";
import { completeJson } from "@rescript/ai";
import { requireAiCaller } from "@/lib/aiGate";
import { billingProjectFor, meteredAi, refusalResponse } from "@/lib/metering";
import { CUSTOM_LOGIC_SYSTEM_PROMPT, customLogicUserPrompt, coerceCustomLogic, type CustomLogicItem } from "@/lib/import/customLogic";

export const dynamic = "force-dynamic";

/**
 * DEEP CUSTOM LOGIC ANALYSIS of one imported item (the import brief §9–§12,
 * §33). Body: { surveyId, context (the survey listing, as the Intelligent
 * mode builds it), item: { language, code, location, role, refs,
 * questionCode? } }.
 *
 * Reply: { ok, analysis: { explanation, effect, dependencies, equivalent,
 * risk, intent } | null, usage: { charge } | null }. The intent is only a
 * PROPOSAL: the browser plans it against the real survey and shows it for
 * review; nothing here reads or writes a survey. One AI_REQUEST, metered and
 * refused like every other (a frozen wallet says so, and says how much).
 */
export async function POST(req: NextRequest) {
  const gate = await requireAiCaller(req);
  if (!gate.ok) return gate.response;
  let body: { surveyId?: unknown; context?: unknown; item?: Partial<CustomLogicItem> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const it = body.item ?? {};
  if (typeof it.code !== "string" || !it.code.trim()) return NextResponse.json({ error: "item.code is required" }, { status: 400 });
  const item: CustomLogicItem = {
    language: String(it.language ?? "javascript").slice(0, 20), code: it.code.slice(0, 8000), location: String(it.location ?? "").slice(0, 120),
    role: String(it.role ?? "custom code").slice(0, 80), refs: Array.isArray(it.refs) ? it.refs.map(String).slice(0, 40) : [],
    questionCode: typeof it.questionCode === "string" ? it.questionCode.slice(0, 60) : null,
  };
  const context = typeof body.context === "string" ? body.context.slice(0, 60_000) : "";
  const billing = await billingProjectFor(gate.user, body.surveyId);
  if ("response" in billing) return billing.response;
  const user = customLogicUserPrompt(context, item);
  try {
    const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: CUSTOM_LOGIC_SYSTEM_PROMPT + user, maxTokens: 700, operation: "import_custom_logic" },
      () => completeJson(CUSTOM_LOGIC_SYSTEM_PROMPT, user, 700, { timeoutMs: 45_000 }));
    if (!m.ok) return refusalResponse(m);
    return NextResponse.json({ ok: true, analysis: coerceCustomLogic(m.value), usage: m.event ? { charge: m.event.customerCharge } : null });
  } catch (e) {
    console.warn("[rescript:ai] custom logic analysis failed", JSON.stringify({ error: (e as Error).message }));
    return NextResponse.json({ ok: false, error: "The analysis could not be completed. Nothing was changed." }, { status: 502 });
  }
}
