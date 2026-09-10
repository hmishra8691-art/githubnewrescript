import { NextRequest, NextResponse } from "next/server";
import { geocode, geocodeConfigured, geocodeProviderName } from "@/lib/geocode";
import { definitionForProviderCall } from "@/lib/aiSession";

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
  const hits = await geocode(text);
  return NextResponse.json({ ok: true, hits });
}
