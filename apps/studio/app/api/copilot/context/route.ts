import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { aiProviderName } from "@rescript/ai";
import { isFailure, requireUser, type AuthedUser } from "@/lib/guard";
import { billingProjectFor } from "@/lib/metering";
import { contextOwner, deriveResearchContext, reconcileContext, renderResearchContext, type StoredResearchContext } from "@/lib/copilot/researchContext";
import { researchContextStoreFor } from "@/lib/copilot/researchContextStore";

export const dynamic = "force-dynamic";

/**
 * THE RESEARCH CONTEXT OF A SURVEY'S LONG BRIEF (§3, 2026-10-18; migration 0067).
 *
 *   GET  ?surveyId=                       → { context | null, rendered, workflow, durable }
 *        (project read; the definition, when sent as POST below, is the authority — GET reports what is stored)
 *   POST { surveyId, action: "check", definition }       → the stored context checked against the survey's
 *        research design (a material change marks it stale) → same shape
 *   POST { surveyId, action: "regenerate", definition? } → re-derived from the stored brief (version + 1, fresh)
 *        (edit right)
 *
 * Keyed by survey AND owner (the organisation, else the person): another survey's or another organisation's
 * context is never returned. The brief itself is not sent back — only its size and reference; its exact
 * passages go to the model, not to the page.
 */

async function gate(authed: Awaited<ReturnType<typeof requireUser>>, surveyId: string, write: boolean): Promise<{ owner: string; userId: string | null } | NextResponse> {
  let user: AuthedUser | null = null;
  if (isFailure(authed)) {
    if (!(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;
  } else user = authed;
  const billing = await billingProjectFor(user, surveyId, write ? "survey.edit" : "project.read");
  if ("response" in billing) return billing.response;
  return { owner: contextOwner({ customerId: billing.ctx.customerId, userId: billing.ctx.userId }), userId: billing.ctx.userId ?? null };
}

function view(rec: StoredResearchContext | null, durable: boolean) {
  if (!rec) return { context: null, rendered: null, workflow: null, durable };
  const c = rec.context;
  return {
    context: { version: c.version, status: c.status, ...(c.staleReason ? { staleReason: c.staleReason } : {}), derivedAt: c.derivedAt, briefChars: c.fingerprint.briefChars, ref: c.fingerprint.brief.slice(0, 12), hypotheses: c.hypotheses, hypothesesSource: c.hypothesesSource, sections: c.sections, progress: c.progress, omitted: c.omitted },
    rendered: renderResearchContext(c),
    workflow: rec.workflow ?? null,
    updatedAt: rec.updatedAt,
    durable,
  };
}

export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const surveyId = req.nextUrl.searchParams.get("surveyId") ?? "";
  if (isFailure(authed) && !(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;
  if (!surveyId) return NextResponse.json({ error: "surveyId is required" }, { status: 400 });
  const g = await gate(authed, surveyId, false);
  if (g instanceof NextResponse) return g;
  const store = await researchContextStoreFor(surveyId);
  return NextResponse.json(view(await store.get(surveyId, g.owner), store.durable), { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  const body = await req.json().catch(() => ({})) as { surveyId?: unknown; action?: unknown; definition?: unknown };
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  if (isFailure(authed) && !(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;
  if (!surveyId) return NextResponse.json({ error: "surveyId is required" }, { status: 400 });
  const action = body.action === "regenerate" ? "regenerate" : body.action === "check" ? "check" : null;
  if (!action) return NextResponse.json({ error: "action is check or regenerate" }, { status: 400 });
  const parsed = body.definition === undefined ? null : SurveyDefinition.safeParse(body.definition);
  if (parsed && !parsed.success) return NextResponse.json({ error: "send the survey as it is open in the editor (definition)" }, { status: 400 });
  const def = parsed?.success ? parsed.data : null;
  const g = await gate(authed, surveyId, action === "regenerate");
  if (g instanceof NextResponse) return g;
  const store = await researchContextStoreFor(surveyId);
  let rec = await store.get(surveyId, g.owner);
  if (!rec) return NextResponse.json(view(null, store.durable));
  if (action === "check") {
    if (def) { const r = reconcileContext(rec.context, def); if (r.changed) rec = await store.put({ ...rec, context: r.context }, { userId: g.userId }); }
    return NextResponse.json(view(rec, store.durable));
  }
  const fresh = deriveResearchContext({ brief: rec.brief, def, previous: rec.context });
  rec = await store.put({ ...rec, context: { ...fresh, progress: rec.context.progress } }, { userId: g.userId });
  return NextResponse.json(view(rec, store.durable));
}
