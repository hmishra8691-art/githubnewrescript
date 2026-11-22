import { NextRequest } from "next/server";
import { platformDb } from "@/lib/db";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { noStore, recruitmentActor, refuseManage } from "@/lib/recruitment/access";
import { trustScore, type TrustHistory } from "@rescript/quality";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * TRUST SCORE WITH ACTIONS (F6, 2026-11-29).
 *
 *   GET  ?trustId=…                       the identity's trust score, confidence, recommended action and every
 *                                         component behind it, from its record in this organisation
 *   POST { action: "open_review", trustId, note }
 *                                         open a manual case for a person to review — the one action this route
 *                                         takes. It holds payment like any case; clearing or upholding it goes
 *                                         through the existing resolve action, which is what moves the identity.
 *
 * The score recommends and never acts by itself: no route here quarantines, blocks or reinstates directly.
 * Reading and acting both need the organisation's managing role, as for the rest of fraud intelligence.
 */
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
type Db = ReturnType<typeof platformDb>;

async function historyFor(db: Db, customerId: string, trustId: string): Promise<{ history: TrustHistory } | { error: string; status: number }> {
  const { data: id, error } = await db.from("respondent_trust_ids")
    .select("id, completions, rejections, duplicates, risk_score, status, first_seen_at")
    .eq("customer_id", customerId).eq("id", trustId).maybeSingle();
  if (error) return { error: error.message, status: 500 };
  if (!id) return { error: "No such respondent in this organisation.", status: 404 };
  const row = id as { completions: number; rejections: number; duplicates: number; risk_score: number | string; status: TrustHistory["status"]; first_seen_at: string | null };
  const [{ data: cases }, { data: ledger }] = await Promise.all([
    db.from("fraud_cases").select("status, kind, risk_score, evidence").eq("customer_id", customerId).eq("trust_id", trustId).limit(500),
    db.from("participation_ledger").select("response_id").eq("customer_id", customerId).eq("trust_id", trustId).eq("state", "completed").not("response_id", "is", null).limit(1000),
  ]);
  const responseIds = (ledger ?? []).map((l) => String((l as { response_id: string }).response_id));
  const classified: NonNullable<TrustHistory["classified"]> = {};
  for (let i = 0; i < responseIds.length; i += 500) {
    const { data: resp } = await db.from("responses").select("quality").in("id", responseIds.slice(i, i + 500));
    for (const r of resp ?? []) {
      const k = (r as { quality: { classification?: string } | null }).quality?.classification as keyof typeof classified | undefined;
      if (k) classified[k] = (classified[k] ?? 0) + 1;
    }
  }
  const caseRows = (cases ?? []) as { status: NonNullable<TrustHistory["cases"]>[number]["status"]; kind: string; risk_score: number | string; evidence: Record<string, unknown> | null }[];
  return {
    history: {
      completes: Math.max(Number(row.completions ?? 0), responseIds.length),
      classified, rejections: Number(row.rejections ?? 0), duplicates: Number(row.duplicates ?? 0),
      cases: caseRows.map((c) => ({ status: c.status, kind: c.kind, risk: Number(c.risk_score) })),
      crossSurveyStrong: caseRows.filter((c) => c.status === "open" && c.evidence?.source === "cross_survey" && c.evidence?.strength === "strong").length,
      standingRisk: Number(row.risk_score ?? 0), status: row.status, firstSeen: row.first_seen_at,
    },
  };
}

export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();
  const trustId = str(new URL(req.url).searchParams.get("trustId"));
  if (!trustId) return noStore({ error: "Which respondent? Pass trustId." }, 400);
  /* tenancy: the trust tables are shared fraud intelligence, central until step 4 (docs/TENANCY); every read is scoped by customer_id */
  const h = await historyFor(platformDb(), actor.customerId, trustId);
  if ("error" in h) return noStore({ error: h.error }, h.status);
  return noStore({ trustId, history: h.history, trust: trustScore(h.history) });
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return noStore({ error: "Expected a JSON body." }, 400); }
  if (str(body.action) !== "open_review") return noStore({ error: "The only action is open_review." }, 400);
  const trustId = str(body.trustId), note = str(body.note);
  if (!trustId) return noStore({ error: "Which respondent?" }, 400);
  if (!note) return noStore({ error: "Say why this respondent should be reviewed — the case holds payment and they may appeal." }, 400);
  const db = platformDb();
  const h = await historyFor(db, actor.customerId, trustId);
  if ("error" in h) return noStore({ error: h.error }, h.status);
  const t = trustScore(h.history);
  const { data: open } = await db.from("fraud_cases").select("id").eq("customer_id", actor.customerId).eq("trust_id", trustId).in("status", ["open", "appealed"]).limit(1);
  if (open && open.length) return noStore({ error: "This respondent already has an open case; review that one.", caseId: (open[0] as { id: string }).id }, 409);
  const { data, error } = await db.from("fraud_cases").insert({
    customer_id: actor.customerId, trust_id: trustId, kind: "manual", risk_score: Math.max(0, Math.min(100, Math.round(100 - t.score))),
    reasons: [note, t.why], evidence: { source: "trust_score", score: t.score, confidence: t.confidence, action: t.action, components: t.components, openedBy: actor.userId },
  }).select("id").single();
  if (error) return noStore({ error: error.message }, 400);
  await audit({ action: "fraud.trust.review", userId: actor.userId, customerId: actor.customerId, entity: "respondent_trust_id", entityId: trustId, detail: { score: t.score, action: t.action, note } });
  return noStore({ ok: true, caseId: (data as { id: string }).id, trust: t });
}
