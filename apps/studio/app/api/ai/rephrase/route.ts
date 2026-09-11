import { NextRequest, NextResponse } from "next/server";
import { rephraseForSpeech } from "@rescript/ai";
import { requireAiCaller } from "@/lib/aiGate";

export const dynamic = "force-dynamic";

/**
 * A SPOKEN-FRIENDLY VERSION OF ONE QUESTION, for the programmer to approve.
 *
 * Body: { text, instruction?, variation?, style? } → { ok, question } — the
 * rewording, or null when the provider had nothing usable. Nothing is stored:
 * the Studio shows the result under the question's Spoken text as an
 * "AI version" and the programmer approves, edits or discards it. The
 * displayed question text is never changed by this route or by that approval.
 *
 * Who may ask: a signed-in Studio user. Unconfigured provider → 501. The one
 * carve-out mirrors the runtime's: against the FAKE provider (free,
 * deterministic) the sandbox may call this without a session, so the browser
 * suite and a local developer can see the mechanism work.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAiCaller(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) return NextResponse.json({ error: "text is required" }, { status: 400 });
  const variation = ["low", "medium", "high"].includes(body?.variation) ? body.variation as "low" | "medium" | "high" : "low";
  try {
    const question = await rephraseForSpeech({ questionText: text, instruction: typeof body?.instruction === "string" ? body.instruction : undefined, variation, style: typeof body?.style === "string" ? body.style : undefined });
    return NextResponse.json({ ok: true, question });
  } catch (e) {
    console.warn("[rescript:ai] rephrase failed", JSON.stringify({ error: (e as Error).message }));
    return NextResponse.json({ ok: true, question: null });
  }
}
