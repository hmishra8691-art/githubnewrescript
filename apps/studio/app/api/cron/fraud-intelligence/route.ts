import "server-only";
import { NextResponse } from "next/server";
import { platformDb } from "@/lib/db";
import { timingSafeEqual } from "node:crypto";
import { detectClusters, DEFAULT_CLUSTER_CONFIG, crossSurveyDuplicates, textsFromAnswers, type ClusterIdentity, type SignalKind, type CrossSurveyRecord, type VendorMapping } from "@rescript/quality";
import { forecast } from "@rescript/recruitment";
import { supabaseService } from "@/lib/authServer";

/**
 * THE BACKGROUND PASS (2026-11-03, Phase 5).
 *
 * Four jobs that can only be done across many arrivals, run hourly for each organisation that has any:
 *
 *   1. THE GRAPH        group identities by the probabilistic signals they share, and open ONE case per ring.
 *                       0084 scores each arrival alone and cannot see that forty of them are one operation.
 *   2. VENDOR QUALITY   recompute each vendor's rates from real outcomes, with the Wilson interval. Since the
 *                       Studio reads this rather than recomputing it, this pass is now the ONLY thing that
 *                       turns orders into a score — if it does not run, every vendor is honestly unknown.
 *   3. FORECASTS        project completion and final cost for every fielding project — or write down why not.
 *   4. VENDOR HEALTH    ok / degraded / failing / unknown from the API calls actually made in the last hour.
 *   5. CROSS-SURVEY     the same open-ended paragraph from different respondents in different surveys, and one
 *                       identity behind several participant IDs of one vendor (F3, @rescript/quality crossSurvey).
 *                       Opens a 'duplicate' case per finding, once (by signature), WITHOUT holding payment: it is
 *                       "show me this", and a reviewer decides.
 *                       Without it `vendor_integrations.health` keeps whatever it last said, which is worse
 *                       than saying nothing: a vendor that failed at nine still reads "ok" at five.
 *
 * ## Which organisations
 *
 * The identity table used to decide this on its own, which quietly made jobs 2, 3 and 4 conditional on
 * something none of them is about. An organisation buying sample through manual relationships has no
 * respondent trust ids at all, so it got no vendor scores, no forecasts and no health — and nothing said so.
 * The list is now the union of organisations with recent identity traffic and organisations with a vendor
 * relationship of any kind.
 *
 * And then it evaluates itself: `rescript_model_evaluate` measures precision and the false-positive rate over
 * RESOLVED cases. With none resolved it writes `insufficient` and no numbers, which is the honest state today
 * and will stay the honest state until reviewers have worked the queue.
 *
 * ## What the pass does not do
 *
 * It opens cases. It does not refuse anybody, void a complete, or mark an identity. A quarantined complete is
 * held from billing and waits for a human — the Phase 4 rule, unchanged, because a graph with an unmeasured
 * false-positive rate acting on its own findings is how a platform bans its own panel.
 *
 * Authorised by CRON_SECRET like the other eight jobs, and bounded in time so a large organisation never
 * starves the rest: whatever is left is picked up next hour.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUDGET_MS = 45_000;
const MAX_CUSTOMERS = 50;
/** identities to pull per organisation. Beyond this the graph is a job for a worker, not a 60-second route. */
const MAX_IDENTITIES = 4000;
const WINDOW_DAYS = 30;

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// the bearer token is checked in each handler's FIRST statement (the auth-guard audit's rule for a scheduler route), and again in run()
export async function GET(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }
export async function POST(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }

type Db = ReturnType<typeof supabaseService>;

interface CustomerResult {
  customerId: string;
  identities: number;
  clusters: number;
  casesOpened: number;
  vendorsScored: number;
  forecasts: { made: number; insufficient: number };
  /** integrations whose health was recomputed from calls actually made; 0 means nobody called anybody */
  vendorsHealthChecked: number;
  evaluation: string | null;
  /** cross-survey duplicates (F3): completes compared, findings, and the cases this pass opened */
  crossSurvey?: { sessions: number; findings: number; casesOpened: number };
  skipped?: string;
}

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });
  /* tenancy: its functions (rescript_cluster_upsert, rescript_model_evaluate, rescript_vendor_quality_recompute) join the shared fraud and trust tables with each client's cases and orders, so it runs on the primary until that is split (docs/TENANCY, step 4) */
  const db = platformDb();
  const startedAt = Date.now();

  /*
   * Organisations with recent identity traffic (the graph) OR a vendor relationship (quality, forecasts,
   * health). An organisation that has switched on neither costs two rows of these queries and nothing else —
   * the pass must not become a tax on everybody for a feature few use.
   */
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const [identities, vendors] = await Promise.all([
    db.from("respondent_trust_ids").select("customer_id").gte("last_seen_at", since).limit(20_000),
    db.from("vendor_integrations").select("customer_id").limit(5_000),
  ]);
  if (identities.error) return NextResponse.json({ error: identities.error.message }, { status: 500 });

  const customerIds = [...new Set([
    ...(identities.data ?? []).map((r) => String((r as { customer_id: string }).customer_id)),
    /* a database without 0081 has no vendor table; that is no vendors, not a failed pass */
    ...(vendors.error ? [] : (vendors.data ?? []).map((r) => String((r as { customer_id: string }).customer_id))),
  ])]
    .sort()
    .slice(0, MAX_CUSTOMERS);

  const results: CustomerResult[] = [];
  for (const customerId of customerIds) {
    if (Date.now() - startedAt > BUDGET_MS) {
      results.push({ customerId, identities: 0, clusters: 0, casesOpened: 0, vendorsScored: 0,
        forecasts: { made: 0, insufficient: 0 }, vendorsHealthChecked: 0, evaluation: null,
        skipped: "time budget spent — next hour" });
      continue;
    }
    results.push(await oneCustomer(db, customerId));
  }

  return NextResponse.json({
    ok: true,
    customers: results.length,
    elapsedMs: Date.now() - startedAt,
    results,
  });
}

async function oneCustomer(db: Db, customerId: string): Promise<CustomerResult> {
  const out: CustomerResult = {
    customerId, identities: 0, clusters: 0, casesOpened: 0, vendorsScored: 0,
    forecasts: { made: 0, insufficient: 0 }, vendorsHealthChecked: 0, evaluation: null,
  };

  /* ---------------------------------------------------------------- 1. the graph */

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { data: tokens } = await db
    .from("identity_match_tokens")
    .select("trust_id, kind, token, first_seen_at")
    .eq("customer_id", customerId)
    .eq("strength", "probabilistic")
    .in("kind", ["device", "network", "behaviour"])
    .gte("last_seen_at", since)
    .limit(MAX_IDENTITIES * 3);

  const byIdentity = new Map<string, ClusterIdentity>();
  for (const r of tokens ?? []) {
    const row = r as { trust_id: string; kind: string; token: string; first_seen_at: string | null };
    const id = String(row.trust_id);
    const existing = byIdentity.get(id) ?? { id, signals: [], firstSeen: row.first_seen_at };
    existing.signals.push({ kind: row.kind as SignalKind, token: String(row.token) });
    // the EARLIEST sighting of this identity, which is what the burst check means by "appeared"
    if (row.first_seen_at && (!existing.firstSeen || row.first_seen_at < existing.firstSeen)) {
      existing.firstSeen = row.first_seen_at;
    }
    byIdentity.set(id, existing);
  }
  const identities = [...byIdentity.values()].slice(0, MAX_IDENTITIES);
  out.identities = identities.length;

  const clusters = identities.length >= DEFAULT_CLUSTER_CONFIG.minSize ? detectClusters(identities) : [];
  out.clusters = clusters.length;

  for (const c of clusters) {
    /*
     * `p_open_case` only above the farm threshold. A cluster that scores past `minScore` is worth recording and
     * showing a reviewer; it is not automatically worth holding people's money over. The two thresholds are
     * deliberately different numbers, because "show me this" and "stop paying for this" are different decisions.
     */
    const openCase = c.identitiesPerDevice !== null && c.identitiesPerDevice >= DEFAULT_CLUSTER_CONFIG.farmRatio;
    const { data, error } = await db.rpc("rescript_cluster_upsert", {
      p_customer: customerId,
      p_signature: c.signature,
      p_members: c.members,
      p_devices: c.devices,
      p_networks: c.networks,
      p_score: c.score,
      p_signals: c.signals,
      p_evidence: c.evidence,
      p_survey: null,
      p_open_case: openCase,
    });
    if (error) continue;
    const row = Array.isArray(data) ? data[0] : data;
    if (row && (row as { case_id?: string }).case_id && (row as { created?: boolean }).created) out.casesOpened++;
  }


  /* ---------------------------------------------------------------- 1b. cross-survey duplicates (F3) */

  out.crossSurvey = await crossSurveyPass(db, customerId, since);

  /* ---------------------------------------------------------------- 2. vendor quality */

  const { data: scored } = await db.rpc("rescript_vendor_quality_recompute", {
    p_customer: customerId, p_window_days: 90,
  });
  out.vendorsScored = typeof scored === "number" ? scored : 0;

  /* ---------------------------------------------------------------- 2b. vendor health (0086)

     From the calls actually made in the last hour, not from an operator's opinion. A vendor nobody has called
     keeps `unknown`, which is neither healthy nor failing — the same refusal the quality score makes. Run
     beside the quality pass because both are about the same relationship and both need the hourly cadence. */

  const { data: health, error: hErr } = await db.rpc("rescript_vendor_health_recompute", {
    p_customer: customerId, p_window_minutes: 60,
  });
  /* 0086 not applied, or no api-mode vendors: no health to recompute, and nothing about that is an error */
  if (!hErr) out.vendorsHealthChecked = typeof health === "number" ? health : 0;

  /* ---------------------------------------------------------------- 3. forecasts */

  const { data: projects } = await db
    .from("recruitment_projects")
    .select("id, required_completes, budget_amount, budget_currency, created_at, status")
    .eq("customer_id", customerId)
    .in("status", ["fielding", "authorized"])
    .limit(100);

  for (const p of projects ?? []) {
    const proj = p as {
      id: string; required_completes: number; budget_amount: string | number;
      budget_currency: string; created_at: string;
    };
    const { data: orders } = await db
      .from("recruitment_orders")
      .select("accepted_completes, rejected_completes, spend_amount, placed_at")
      .eq("recruitment_project_id", proj.id);

    const accepted = (orders ?? []).reduce((s, o) => s + Number((o as { accepted_completes: number }).accepted_completes ?? 0), 0);
    const rejected = (orders ?? []).reduce((s, o) => s + Number((o as { rejected_completes: number }).rejected_completes ?? 0), 0);
    const spend = (orders ?? []).reduce((s, o) => s + Number((o as { spend_amount: string | number }).spend_amount ?? 0), 0);
    /*
     * Field started when the FIRST order was placed, not when the project row was created. A project drafted in
     * March and fielded in June would otherwise show a rate of a few completes per week and a finish date in 2031.
     */
    const placed = (orders ?? [])
      .map((o) => (o as { placed_at: string | null }).placed_at)
      .filter((v): v is string => typeof v === "string")
      .sort();
    const startedAt = placed[0] ?? proj.created_at;

    const f = forecast({
      startedAt,
      target: Number(proj.required_completes),
      accepted, rejected,
      spend: spend > 0 ? spend : null,
      budget: Number(proj.budget_amount),
      currency: proj.budget_currency,
    });

    if (f.status === "forecast") {
      out.forecasts.made++;
      await db.from("recruitment_forecasts").insert({
        recruitment_project_id: proj.id,
        projected_completion: f.completionAt,
        projected_final_cost: f.projectedCost,
        projected_valid_completes: f.target,
        completes_per_day: Math.round(f.ratePerHour * 24 * 100) / 100,
        basis: {
          accepted: f.completes, hoursElapsed: f.hoursElapsed, ratePerHour: f.ratePerHour,
          range: f.completionRange, overBudget: f.overBudget, startedAt,
        },
        insufficient_reason: null,
      });
    } else {
      out.forecasts.insufficient++;
      await db.from("recruitment_forecasts").insert({
        recruitment_project_id: proj.id,
        projected_completion: null, projected_final_cost: null,
        projected_valid_completes: null, completes_per_day: null,
        basis: { accepted: f.completes, hoursElapsed: f.hoursElapsed, needCompletes: f.needCompletes, needHours: f.needHours, startedAt },
        insufficient_reason: f.explanation,
      });
    }
  }

  /* ---------------------------------------------------------------- 4. does any of it work */

  const { data: evaluation } = await db.rpc("rescript_model_evaluate", {
    p_customer: customerId, p_window_days: 90,
  });
  const evalRow = Array.isArray(evaluation) ? evaluation[0] : evaluation;
  out.evaluation = evalRow ? String((evalRow as { status: string }).status) : null;

  return out;
}

/** completes compared per organisation per pass; beyond this the comparison is a job for a worker */
const MAX_CROSS_SURVEY_RESPONSES = 4000;

async function crossSurveyPass(db: Db, customerId: string, since: string): Promise<{ sessions: number; findings: number; casesOpened: number }> {
  const res = { sessions: 0, findings: 0, casesOpened: 0 };
  /* the organisation's own surveys only — the tenant boundary is the survey list, never a global response scan */
  const { data: surveys } = await db.from("surveys").select("id").eq("customer_id", customerId).in("status", ["live", "closed"]).limit(500);
  const surveyIds = (surveys ?? []).map((s) => String((s as { id: string }).id));
  if (surveyIds.length < 2) return res;
  const { data: rows } = await db.from("responses")
    .select("id, survey_id, session_id, answers, completed_at")
    .in("survey_id", surveyIds).eq("status", "complete").eq("is_test", false).is("deleted_at", null)
    .gte("completed_at", since).order("completed_at", { ascending: false }).limit(MAX_CROSS_SURVEY_RESPONSES);
  const responses = (rows ?? []) as { id: string; survey_id: string; session_id: string; answers: Record<string, unknown>; completed_at: string | null }[];
  if (!responses.length) return res;
  /* identities from the participation ledger, when identity resolution is in use; otherwise each session stands alone */
  const identityOf = new Map<string, string>();
  for (let i = 0; i < responses.length; i += 500) {
    const ids = responses.slice(i, i + 500).map((r) => r.id);
    const { data: ledger } = await db.from("participation_ledger").select("response_id, trust_id").eq("customer_id", customerId).in("response_id", ids);
    for (const l of ledger ?? []) { const x = l as { response_id: string | null; trust_id: string }; if (x.response_id) identityOf.set(x.response_id, String(x.trust_id)); }
  }
  const records: CrossSurveyRecord[] = responses.map((r) => ({
    customerId, surveyId: String(r.survey_id), sessionId: String(r.session_id), responseId: String(r.id),
    identity: identityOf.get(String(r.id)) ?? null, completedAt: r.completed_at, texts: textsFromAnswers(r.answers),
  }));
  res.sessions = records.length;
  const { data: maps } = await db.from("vendor_participant_mappings").select("trust_id, integration_id, participant_id").eq("customer_id", customerId).gte("last_seen_at", since).limit(20_000);
  const mappings: VendorMapping[] = (maps ?? []).map((m) => { const x = m as { trust_id: string; integration_id: string; participant_id: string }; return { customerId, identity: String(x.trust_id), integrationId: String(x.integration_id), participantId: String(x.participant_id) }; });
  const report = crossSurveyDuplicates(records, mappings);
  const actionable = report.findings.filter((f) => f.strength !== "informational");
  res.findings = actionable.length;
  for (const f of actionable) {
    const { data: existing } = await db.from("fraud_cases").select("id").eq("customer_id", customerId).eq("kind", "duplicate").contains("evidence", { signature: f.signature }).limit(1);
    if (existing && existing.length) continue;
    const { error } = await db.from("fraud_cases").insert({
      customer_id: customerId,
      survey_id: f.surveys[0] ?? null,
      trust_id: f.members.find((m) => m.identity)?.identity ?? null,
      kind: "duplicate",
      risk_score: f.riskScore,
      reasons: [f.reason],
      evidence: { source: "cross_survey", signature: f.signature, finding: f.kind, strength: f.strength, surveys: f.surveys, members: f.members, ...(f.sample ? { sample: f.sample } : {}), ...(f.participantIds ? { participantIds: f.participantIds } : {}) },
      holds_payment: false,
    });
    if (!error) res.casesOpened++;
  }
  return res;
}
