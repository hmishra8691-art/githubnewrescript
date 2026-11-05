import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { detectClusters, DEFAULT_CLUSTER_CONFIG, type ClusterIdentity, type SignalKind } from "@rescript/quality";
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
  skipped?: string;
}

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });
  const db = supabaseService();
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
