import { NextRequest, NextResponse } from "next/server";
import { aiProviderName, completeJson } from "@rescript/ai";
import { DESIGN_READING_RULES, DESIGN_READING_SCHEMA, mergeDesignReading, readDesignRequest } from "@rescript/designs";
import { isFailure, requireUser } from "@/lib/guard";
import { dbConfigured } from "@/lib/copilot/durable";
import { aiReadyFor } from "@/lib/byok/connect";
import { billingProjectFor, meteredAi } from "@/lib/metering";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/designs/interpret { text, surveyId, useAi? } — DESCRIBE IT, READ (Design Generators phase 2, 2026-11-09).
 *
 * The rules (`readDesignRequest`) always read the request. With a model available, a project the user may read
 * (`project.read` — nothing is written) and useAi not false, a model reads it too — one AI request metered on that project
 * ("design_interpret"; free on the user's own provider) — and `mergeDesignReading` adds what the rules missed, keeping
 * only names the researcher actually said. Any refusal or failure returns the rules' reading with the reason, so the
 * researcher always gets a reading. Nothing is saved; the design is generated only from the guided form.
 */
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  if (isFailure(authed) && dbConfigured()) return authed.response;
  const user = isFailure(authed) ? null : authed;
  let body: { text?: unknown; surveyId?: unknown; useAi?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  if (text.length < 6) return json({ error: "Describe the design first." }, 400);
  const rules = readDesignRequest(text);
  const surveyId = typeof body.surveyId === "string" ? body.surveyId.slice(0, 64) : "";
  const modelAvailable = aiProviderName() !== null && aiProviderName() !== "fake";
  if (body.useAi === false) return json({ ok: true, read: rules, source: "rules", note: null, usage: { charge: 0 } });
  if (!modelAvailable || !user || !surveyId || surveyId === "sandbox") {
    return json({ ok: true, read: rules, source: "rules", note: !modelAvailable ? null : "Read by the rules — open a project to have the AI read it too.", usage: { charge: 0 } });
  }
  if (!(await aiReadyFor(user, surveyId, "design_interpret").catch(() => false))) return json({ ok: true, read: rules, source: "rules", note: "Read by the rules — AI is not available for this project.", usage: { charge: 0 } });
  const billing = await billingProjectFor(user, surveyId, "project.read");
  if ("response" in billing) return billing.response;
  const prompt = `The researcher wrote (or said):\n"""\n${text}\n"""`;
  try {
    const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: DESIGN_READING_RULES + prompt, maxTokens: 1200, operation: "design_interpret" },
      () => completeJson(DESIGN_READING_RULES, prompt, 1200, { schema: { name: "design_reading", schema: DESIGN_READING_SCHEMA as unknown as Record<string, unknown> }, timeoutMs: 45_000, retries: 1 }));
    if (!m.ok) return json({ ok: true, read: rules, source: "rules", note: `Read by the rules — ${(m as { message?: string }).message ?? "AI is not available for this project"}.`, usage: { charge: 0 } });
    const merged = mergeDesignReading(rules, m.value, text);
    const charge = Number((m as { event?: { customerCharge?: number } }).event?.customerCharge ?? 0) || 0;
    const note = merged.added.length
      ? `The AI added ${merged.added.length} thing${merged.added.length === 1 ? "" : "s"} the rules missed (marked “read by the AI”)${merged.dropped ? `; ${merged.dropped} name${merged.dropped === 1 ? "" : "s"} it suggested ${merged.dropped === 1 ? "was" : "were"} not in your words and ${merged.dropped === 1 ? "was" : "were"} left out` : ""}.`
      : `The AI found nothing the rules had missed${merged.dropped ? ` (${merged.dropped} name${merged.dropped === 1 ? "" : "s"} not in your words left out)` : ""}.`;
    return json({ ok: true, read: merged.read, source: merged.added.length ? "ai" : "rules", note, usage: { charge } });
  } catch (e) {
    console.warn("[rescript:designs] interpret failed", JSON.stringify({ error: (e as Error).message.slice(0, 200) }));
    return json({ ok: true, read: rules, source: "rules", note: "Read by the rules — the AI could not read it just now.", usage: { charge: 0 } });
  }
}
