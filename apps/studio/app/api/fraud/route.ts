import { NextRequest } from "next/server";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { noStore, recruitmentActor, refuseManage } from "@/lib/recruitment/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE FRAUD INTELLIGENCE CENTRE (2026-11-03, Phase 5) — the review queue behind §19 and §20.
 *
 *   GET ?status=open&limit=50     the queue: cases with their reasons and evidence, the networks the graph has
 *                                 found, the vendor quality table, and the model's own evaluation
 *   POST { action: "resolve", caseId, status: "cleared"|"upheld"|"withdrawn", note? }
 *   POST { action: "cluster", clusterId, status: "cleared"|"upheld", note? }
 *                                 resolve every open case belonging to one ring in a single act, because a
 *                                 reviewer shown forty cases from one click farm should not have to click forty
 *                                 times and may not notice they are the same ring
 *
 * ## Why resolution needs `canManage` and not a project capability
 *
 * Clearing a case releases a complete for billing and upholding one withholds payment from a supplier. Both are
 * commercial acts against the organisation's money, and the brief's §30 hangs billing off exactly this status.
 * It is therefore the organisation's own managing roles, not whoever can read a study.
 *
 * ## What this route will not do
 *
 * There is no bulk "uphold everything open", no filter that selects by score and resolves the selection, and no
 * action that marks an identity permanently. A false-positive rate nobody has measured (no traffic has been
 * through shadow mode yet) is not a thing to automate against, and §20's appeal right is worth little if a
 * thousand cases can be upheld with one click.
 */

const RESOLUTIONS = new Set(["cleared", "upheld", "withdrawn"]);
const CLUSTER_RESOLUTIONS = new Set(["cleared", "upheld"]);

type Body = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();

  const db = supabaseService();
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "open";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));

  const [cases, clusters, quality, evaluation, counts] = await Promise.all([
    db.from("fraud_cases")
      .select("id, survey_id, trust_id, ledger_id, decision_id, kind, risk_score, reasons, evidence, status, holds_payment, opened_at, resolved_at, resolution_note, appealed_at, appeal_note, cluster_id")
      .eq("customer_id", actor.customerId)
      .in("status", status === "all" ? ["open", "cleared", "upheld", "appealed", "withdrawn"] : [status])
      .order("risk_score", { ascending: false })
      .order("opened_at", { ascending: false })
      .limit(limit),
    db.from("fraud_network_clusters")
      .select("id, survey_id, signature, members, member_count, devices, networks, identities_per_device, score, signals, evidence, status, first_seen_at, last_seen_at")
      .eq("customer_id", actor.customerId)
      .order("score", { ascending: false })
      .limit(50),
    db.from("vendor_quality_metrics")
      .select("integration_id, market, window_days, completes, accepted, rejected, duplicates, fraud_cases, rejection_rate, rejection_low, rejection_high, duplicate_rate, quality_score, confidence, computed_at")
      .eq("customer_id", actor.customerId)
      .order("rejection_high", { ascending: true, nullsFirst: false })
      .limit(100),
    db.from("model_evaluations")
      .select("rule_id, window_days, true_positives, false_positives, false_negatives, precision, recall, false_positive_rate, status, resolved_cases, note, computed_at")
      .eq("customer_id", actor.customerId)
      .is("rule_id", null)
      .maybeSingle(),
    db.from("fraud_cases").select("status", { count: "exact", head: false })
      .eq("customer_id", actor.customerId).limit(1000),
  ]);

  if (cases.error) return noStore({ error: cases.error.message }, 500);

  const tally: Record<string, number> = { open: 0, cleared: 0, upheld: 0, appealed: 0, withdrawn: 0 };
  for (const r of counts.data ?? []) {
    const s = String((r as { status: string }).status);
    tally[s] = (tally[s] ?? 0) + 1;
  }

  /*
   * THE DOOR'S OWN RECORD (platform audit 2026-11-05, piping defects 4 and 5). `admission_decisions` holds, per
   * arrival, the evidence the gateway's decision rested on, and `identity_match_events` how each arrival was
   * linked to an identity — both written since 0083/0084 and read by nothing. A fraud reviewer or a vendor
   * dispute needs exactly this. The last hundred decisions with their evidence, and seven-day tallies of both,
   * so shadow mode's false-positive exposure (`would_block` events with `shadow = true`) is a number on a screen
   * rather than a query somebody has to know to run.
   */
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [decisions, decisionTally, identityTally] = await Promise.all([
    db.from("admission_decisions")
      .select("id, survey_id, trust_id, integration_id, decision, risk_score, risk_band, reasons, evidence, resolution, decided_in_ms, occurred_at")
      .eq("customer_id", actor.customerId)
      .order("occurred_at", { ascending: false })
      .limit(100),
    db.from("admission_decisions").select("decision, risk_band").eq("customer_id", actor.customerId).gte("occurred_at", since).limit(5000),
    db.from("identity_match_events").select("kind, shadow, would_block").eq("customer_id", actor.customerId).gte("occurred_at", since).limit(5000),
  ]);
  const byDecision: Record<string, number> = {};
  const byBand: Record<string, number> = {};
  for (const r of (decisionTally.data ?? []) as { decision: string; risk_band: string }[]) {
    byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
    byBand[r.risk_band] = (byBand[r.risk_band] ?? 0) + 1;
  }
  const byKind: Record<string, number> = {};
  let shadowBlocks = 0;
  for (const r of (identityTally.data ?? []) as { kind: string; shadow: boolean; would_block: boolean }[]) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (r.would_block && r.shadow) shadowBlocks++;
  }
  /*
   * The vendor names, resolved in one query rather than per row. An integration with no name is shown by its id
   * rather than hidden: a quality row the reviewer cannot attribute is worse than an ugly one.
   */
  const integrationIds = [...new Set([
    ...(quality.data ?? []).map((r) => String((r as { integration_id: string }).integration_id)),
    ...((decisions.data ?? []) as { integration_id: string | null }[]).map((d) => d.integration_id).filter((x): x is string => !!x),
  ])];
  const names = new Map<string, string>();
  if (integrationIds.length) {
    const { data } = await db.from("vendor_integrations")
      .select("id, panel_vendors(name)").in("id", integrationIds);
    for (const row of data ?? []) {
      const r = row as { id: string; panel_vendors?: { name?: string } | { name?: string }[] | null };
      const v = Array.isArray(r.panel_vendors) ? r.panel_vendors[0] : r.panel_vendors;
      if (v?.name) names.set(String(r.id), String(v.name));
    }
  }

  const evalRow = evaluation.data as { status?: string; resolved_cases?: number; note?: string } | null;

  const decisionSurveys = [...new Set(((decisions.data ?? []) as { survey_id: string }[]).map((d) => d.survey_id))];
  const surveyTitle = new Map<string, string>();
  if (decisionSurveys.length) {
    const { data } = await db.from("surveys").select("id, code, title").in("id", decisionSurveys);
    for (const s of (data ?? []) as { id: string; code: string; title: string }[]) surveyTitle.set(s.id, `${s.code} — ${s.title}`);
  }

  return noStore({
    cases: cases.data ?? [],
    clusters: clusters.data ?? [],
    quality: (quality.data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return { ...row, vendorName: names.get(String(row.integration_id)) ?? null };
    }),
    evaluation: evalRow ?? {
      status: "insufficient",
      resolved_cases: 0,
      note: "No evaluation has been computed yet. Precision and the false-positive rate are measured over resolved cases, and there are none.",
    },
    counts: tally,
    admissions: {
      recent: ((decisions.data ?? []) as Record<string, unknown>[]).map((d) => ({ ...d, project: surveyTitle.get(String(d.survey_id)) ?? null, vendorName: d.integration_id ? names.get(String(d.integration_id)) ?? null : null })),
      sevenDays: { decisions: byDecision, bands: byBand, identity: byKind, shadowBlocks, available: !decisions.error },
    },
    /*
     * Said in the payload rather than only in the UI, so an integrator reading this API is told the same thing
     * a reviewer is: these scores have never been checked against outcomes.
     */
    calibration: evalRow?.status === "computed"
      ? null
      : "These risk scores have not been validated against outcomes. Treat every case as a question, not a verdict.",
  });
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;
  if (!actor.canManage) return refuseManage();

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return noStore({ error: "Expected a JSON body." }, 400); }
  const action = str(body.action);
  const db = supabaseService();

  if (action === "resolve") {
    const caseId = str(body.caseId);
    const status = str(body.status);
    const note = str(body.note);
    if (!caseId) return noStore({ error: "Which case?" }, 400);
    if (!status || !RESOLUTIONS.has(status)) {
      return noStore({ error: `A case is resolved as ${[...RESOLUTIONS].join(", ")} — nothing else.` }, 400);
    }
    /*
     * Upholding a case withholds a supplier's payment, so the reason is not optional. "Upheld" with no note is
     * an accusation nobody can answer, and §20 gives the respondent a right of appeal that is worthless without
     * a stated reason to appeal against.
     */
    if (status === "upheld" && !note) {
      return noStore({ error: "Upholding a case withholds payment and marks a respondent. Say why — they may appeal it." }, 400);
    }

    const { data, error } = await db.rpc("rescript_fraud_resolve", {
      p_case: caseId, p_status: status, p_by: actor.userId, p_note: note,
    });
    if (error) return noStore({ error: error.message }, 400);
    const row = Array.isArray(data) ? data[0] : data;

    await audit({
      action: "fraud.case.resolve", userId: actor.userId, customerId: actor.customerId,
      entity: "fraud_case", entityId: caseId, detail: { status, note: note ?? undefined },
    });
    return noStore({ ok: true, case: row });
  }

  if (action === "cluster") {
    const clusterId = str(body.clusterId);
    const status = str(body.status);
    const note = str(body.note);
    if (!clusterId) return noStore({ error: "Which network?" }, 400);
    if (!status || !CLUSTER_RESOLUTIONS.has(status)) {
      return noStore({ error: "A network is cleared or upheld." }, 400);
    }
    if (status === "upheld" && !note) {
      return noStore({ error: "Upholding a network withholds payment for every member. Say why." }, 400);
    }

    const { data: cluster, error: readError } = await db.from("fraud_network_clusters")
      .select("id, members, member_count, status")
      .eq("id", clusterId).eq("customer_id", actor.customerId).maybeSingle();
    if (readError) return noStore({ error: readError.message }, 500);
    if (!cluster) return noStore({ error: "That network is not one of yours." }, 404);

    /*
     * Resolve the OPEN cases of this ring, one at a time through the same function a single resolution uses —
     * so the billing hold, the audit row and the identity's risk update all happen exactly as they would for a
     * case resolved on its own. A bulk UPDATE would skip every one of those.
     */
    const { data: open } = await db.from("fraud_cases")
      .select("id").eq("customer_id", actor.customerId).eq("cluster_id", clusterId).eq("status", "open");

    const resolved: string[] = [];
    const failed: { caseId: string; error: string }[] = [];
    for (const r of open ?? []) {
      const id = String((r as { id: string }).id);
      const { error } = await db.rpc("rescript_fraud_resolve", {
        p_case: id, p_status: status, p_by: actor.userId,
        p_note: note ? `${note} (resolved with network ${clusterId})` : `Resolved with network ${clusterId}`,
      });
      if (error) failed.push({ caseId: id, error: error.message }); else resolved.push(id);
    }

    await db.from("fraud_network_clusters")
      .update({ status: status === "upheld" ? "upheld" : "cleared", last_seen_at: new Date().toISOString() })
      .eq("id", clusterId).eq("customer_id", actor.customerId);

    await audit({
      action: "fraud.cluster.resolve", userId: actor.userId, customerId: actor.customerId,
      entity: "fraud_network_cluster", entityId: clusterId,
      detail: { status, resolved: resolved.length, failed: failed.length, note: note ?? undefined },
    });
    return noStore({ ok: true, clusterId, status, resolved: resolved.length, failed });
  }

  return noStore({ error: "Unknown action." }, 400);
}
