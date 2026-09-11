import { NextRequest, NextResponse } from "next/server";
import { geocode, geocodeConfigured, geocodeProviderName } from "@/lib/geocode";
import { definitionForProviderCall } from "@/lib/aiSession";
import { getMeter, contextOf } from "@/lib/metering";

export const dynamic = "force-dynamic";

/**
 * GEOCODE AN ADDRESS for a `geo` question in address mode.
 *
 * Body: `{ sessionId, questionId, q }` (+ `definition` for a preview). Reply:
 * `{ hits: [{ formatted, lat, lng, city?, region?, country?, postal? }] }`.
 * The provider and its key live here (lib/geocode.ts); the browser never
 * holds them. Who may call it — a live session, or a preview against the fake
 * provider only — is the same gate the AI routes use, because this too spends
 * a paid provider's calls. Unconfigured → 501 and the renderer keeps the
 * typed address.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const gate = await definitionForProviderCall(body, {
    configured: geocodeConfigured(), fake: geocodeProviderName() === "fake",
    what: "the geocoding provider", unconfigured: "geocoding is not configured on this runtime",
  });
  if ("response" in gate) return gate.response;
  const { def } = gate;
  const q = def.questions.find((x) => x.id === body?.questionId);
  if (!q || q.type !== "geo") return NextResponse.json({ error: "that question is not a location question" }, { status: 400 });
  const text = typeof body?.q === "string" ? body.q.trim() : "";
  if (!text) return NextResponse.json({ ok: true, hits: [] });
  /*
   * METERED: one GEOCODE_REQUEST per lookup on the session's project. A
   * refused wallet returns no hits and the respondent keeps the typed
   * address — the same fallback as an unconfigured provider.
   */
  if (gate.billing) {
    const fake = geocodeProviderName() === "fake" && process.env.BILLING_SIMULATE_FAKE_COSTS !== "1";
    const r = await getMeter().record(contextOf(gate.billing), { eventType: "GEOCODE_REQUEST", provider: fake ? "fake" : "geocode", service: "lookup", model: null, quantity: 1, metadata: { operation: "geocode", sessionId: gate.billing.sessionId.slice(0, 8) } }).catch((e) => { console.warn("[rescript:billing] geocode not metered", (e as Error).message); return { ok: true as const, event: null }; });
    if (!r.ok) return NextResponse.json({ ok: true, hits: [], refused: r.message });
  }
  const hits = await geocode(text);
  return NextResponse.json({ ok: true, hits });
}
