import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { AudienceSpecification, canTransition, type AllocationStrategy, type FeasibilityEstimate, type RecruitmentProjectStatus } from "@rescript/schema";
import {
  allocate, blendedCpi, budgetState, canCommit, compareVendors, comparisonSource, costPerValidComplete,
  selectPricing, totalCost, LIVE_ADAPTER_SLUGS, planRecruitment, planQuotas, proposeReallocation, recommend,
  type AllocationCandidate, type FeasibilityInput, type ObservedVendor,
} from "@rescript/recruitment";
import { parseQuotaMapping } from "@rescript/identity";
import { audit, isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { liveRegistry, LIVE_FEASIBILITY_MS } from "@/lib/recruitment/live";
import { researcherPlan } from "@/lib/recruitment/abstraction";
import { openCredentials } from "@/lib/recruitment/credentials";
import { supabaseService } from "@/lib/authServer";
import { noStore, recruitmentActor, refuseSpend, refuseVendorVisibility } from "@/lib/recruitment/access";
import { recruitmentStore } from "@/lib/recruitment/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A STUDY'S RECRUITMENT (2026-11-03) — Fieldwork → Smart Recruitment.
 *
 *   GET                                 the recruitment project, the vendor comparison for its audience, the
 *                                       allocation revisions, the orders and what they have actually delivered,
 *                                       and the orchestrator's log
 *   POST { action: "project", requiredCompletes, budget, currency?, deadline?, loiMinutes?, expectedIr?, strategy?, audience? }
 *   POST { action: "compare" }          re-run the comparison and record VendorFeasibilityReceived
 *   POST { action: "markets", markets: [{market, requiredCompletes, expectedIr?, loiMinutes?}] }
 *                                       a completes target per country; the optimiser then solves each one
 *                                       against its own rate cards (0082)
 *   POST { action: "optimise", strategy?, weights?, maxVendorShare?, exclude? }
 *                                       PROPOSE an allocation. It is not saved and nothing is ordered: the
 *                                       answer is a plan, with the arithmetic behind every row, for a human to
 *                                       read and then allocate.
 *   POST { action: "allocate", rows }   write an allocation revision — the budget and the required completes are
 *                                       ceilings the DATABASE enforces, not warnings this route prints
 *   POST { action: "authorize" }        the researcher's authorisation; after this, orders may be placed
 *   POST { action: "order", integrationId, completes, cpi }   place one order against the authorised allocation
 *   POST { action: "progress", orderId, delivered, accepted, rejected?, duplicates?, spend?, status?, vendorRef? }
 *                                       record what a vendor has actually delivered. Counts are ABSOLUTE and the
 *                                       write is idempotent, so entering the same sync twice changes nothing.
 *
 * Reading: `fieldwork.read`. Allocating, authorising, ordering and recording spend: `deploy.manage` — the nearest
 * existing capability to committing the organisation's money, and deliberately narrower than reading.
 *
 * PHASE 1 CALLS NO VENDOR. `compare` reads the rate cards an operator configured; `order` records an order for an
 * operator to place in the vendor's own portal; `progress` is what that operator enters back. Every figure
 * carries the provenance of the rate card behind it, and the response says so in `source`.
 */

type Body = Record<string, unknown>;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v
  : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

/** Everything the comparison needs, assembled from the organisation's own configuration. */
async function comparisonFor(customerId: string, project: Record<string, unknown> | null) {
  const store = recruitmentStore();
  const [integrations, pricing, vendors] = await Promise.all([
    store.integrations(customerId), store.pricing(customerId), store.vendors(customerId),
  ]);
  const history = await store.history(customerId, integrations.map((i) => i.id));
  const nameOf = new Map(vendors.map((v) => [v.id, v.name]));

  const inputs: FeasibilityInput[] = integrations.filter((i) => i.enabled).map((i) => ({
    integrationId: i.id,
    vendorName: nameOf.get(i.vendorId) ?? "Vendor",
    mode: i.mode,
    markupBps: i.markupBps,
    currency: i.currency,
    pricing: pricing[i.id] ?? [],
    ...(history[i.id] ? { history: history[i.id] } : {}),
  }));

  const audience = AudienceSpecification.parse(
    (project?.audience as unknown) ?? { demographics: { countries: [] } },
  );
  const req = {
    audience,
    requiredCompletes: Number(project?.required_completes ?? 0) || 1,
    loiMinutes: Number(project?.loi_minutes ?? 15) || 15,
    expectedIr: Number(project?.expected_ir ?? 100) || 100,
  };
  const rows = compareVendors(inputs, req);

  /*
   * LIVE FEASIBILITY (Phase 6b). Every row above came from a rate card. For an integration actually in `api`
   * mode, ask the vendor instead and replace the row — but only replace it on success. A vendor that is down
   * must leave the researcher with the rate-card estimate and a note, not with a hole in the comparison, and
   * `source` then still tells them which figure they are reading.
   *
   * The calls run together and each is bounded, because a comparison across eight vendors must not take eight
   * timeouts' worth of wall clock. Credentials are opened here, used, and never returned.
   */
  const live = integrations.filter((i) => i.enabled && i.mode === "api" && i.hasCredentials);
  if (live.length) {
    const registry = liveRegistry();
    const slugOf = new Map(vendors.map((v) => [v.id, v.slug]));
    const settled = await Promise.allSettled(live.map(async (i) => {
      const slug = slugOf.get(i.vendorId) ?? "";
      const sealed = await store.sealedCredentials(customerId, i.id);
      if (!sealed) throw new Error("no sealed credentials");
      const ctx = {
        integrationId: i.id, vendorName: nameOf.get(i.vendorId) ?? "Vendor", mode: i.mode,
        customerId, currency: i.currency, markupBps: i.markupBps,
        credentials: openCredentials(customerId, i.id, sealed),
        signal: AbortSignal.timeout(LIVE_FEASIBILITY_MS),
      };
      const estimate = await registry.invoke(
        { integrationId: i.id, vendorName: ctx.vendorName, vendorSlug: slug, mode: i.mode, recorded: [] },
        "feasibility", "feasibility",
        (adapter, c) => adapter.feasibility!(c, req),
        ctx,
      );
      return { integrationId: i.id, estimate: estimate as FeasibilityEstimate };
    }));

    for (const [n, result] of settled.entries()) {
      const target = live[n];
      const at = rows.findIndex((r) => r.integrationId === target.id);
      if (at < 0) continue;
      if (result.status === "fulfilled") {
        rows[at] = { ...rows[at], ...result.value.estimate };
      } else {
        const why = result.reason instanceof Error ? result.reason.message : "the vendor could not be reached";
        const note = `Live figures unavailable, so this row is from the rate card: ${why}`;
        rows[at] = {
          ...rows[at],
          caveat: rows[at].caveat ? `${rows[at].caveat} ${note}` : note,
        };
      }
    }
  }

  return { rows, source: comparisonSource(rows), vendorNames: nameOf, integrations };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, "fieldwork.read");
  if (isFailure(gate)) return gate.response;
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;

  const store = recruitmentStore();
  const db = supabaseService();
  const project = await store.project(params.id);
  const audienceFor = project
    ? { ...project, audience: await loadAudience(project.audience_spec_id as string | null) }
    : null;
  const { rows, source, vendorNames } = await comparisonFor(actor.customerId, audienceFor);

  const [allocations, orders, events, markets] = project
    ? await Promise.all([
        store.allocations(project.id as string), store.orders(project.id as string),
        store.events(project.id as string, 50), store.markets(project.id as string),
      ])
    : [[], [], [], []];
  const capacity = await store.capacity(actor.customerId);

  // the dashboard's totals, from the orders themselves — nothing here is an estimate dressed as an actual
  const spend = orders.reduce((s, o) => s + Number(o.spend_amount ?? 0), 0);
  const accepted = orders.reduce((s, o) => s + Number(o.accepted_completes ?? 0), 0);
  const delivered = orders.reduce((s, o) => s + Number(o.delivered_completes ?? 0), 0);
  const rejected = orders.reduce((s, o) => s + Number(o.rejected_completes ?? 0), 0);
  const duplicates = orders.reduce((s, o) => s + Number(o.duplicate_attempts ?? 0), 0);
  const required = Number(project?.required_completes ?? 0);
  const budget = Number(project?.budget_amount ?? 0);

  /*
   * TWO PAYLOADS, NOT ONE FILTERED.
   *
   * A researcher gets the plan and the progress; a platform administrator additionally gets the supply chain
   * behind it. The researcher's version is BUILT, not stripped — the per-vendor arrays are never spread into
   * it — because a `{ ...row }` written in a hurry is exactly how a vendor field comes back, and a filter can
   * only remove what somebody remembered to list.
   *
   * `lib/recruitment/abstraction.ts` holds the mapper, and its test walks the result for forbidden keys and for
   * this organisation's own vendor names, so the guarantee is checked rather than asserted in a comment.
   */
  /*
   * Read on its own and guarded, not added to `store.project()`'s select. A column named in that select does
   * not exist until 0089 is applied, and naming it there would take the whole recruitment panel down for every
   * project on a database that has not run the migration yet — the same shape of failure as the `market`
   * column in 0082. An unmigrated database here simply has no mapping, which is true.
   */
  let quotaMapping: Record<string, unknown> = {};
  if (actor.canSeeVendors && project) {
    try {
      const { data } = await db.from("recruitment_projects").select("quota_mapping").eq("id", project.id as string).maybeSingle();
      const raw = (data as { quota_mapping?: unknown } | null)?.quota_mapping;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) quotaMapping = raw as Record<string, unknown>;
    } catch { /* 0089 not applied: no mapping */ }
  }

  const supplyChain = actor.canSeeVendors ? {
    comparison: { rows, source },
    capacity,
    allocations: allocations.map((a) => ({ ...a, vendorName: vendorNames.get(String(a.integration_id)) ?? null })),
    orders: orders.map((o) => ({ ...o, vendorName: vendorNames.get(String(o.integration_id)) ?? null })),
    liveAdaptersAvailable: LIVE_ADAPTER_SLUGS.length > 0,
    /*
     * The vendor parameter mapping (0089) is here and not beside the quota counts, for the same reason as the
     * rest of this block: the criterion is the researcher's, but the parameter NAMES are the suppliers'. Read
     * back, they would say how many different suppliers a project has and roughly who they are.
     */
    quotaMapping,
  } : {};

  /*
   * Quota progress (0088). Counts and targets only — a quota cell is the researcher's own targeting and
   * carries nothing about the supply chain, so unlike the commercial figures it is not narrowed to
   * administrators.
   */
  const quotas = project
    ? (await db.from("quota_progress")
        .select("cell_id, label, dimension, target, accepted, in_progress, turned_away, last_complete_at")
        .eq("recruitment_project_id", project.id as string)
        .order("dimension", { ascending: true })
        .order("cell_id", { ascending: true })).data ?? []
    : [];

  const plan = researcherPlan({
    currency: String(project?.budget_currency ?? "USD"),
    requiredCompletes: required,
    markets: (markets as Array<Record<string, unknown>>).map((m) => {
      const code = String(m.market);
      const forMarket = allocations.filter((a) => String(a.market ?? "") === code);
      const ordersFor = orders.filter((o) => forMarket.some((a) => a.integration_id === o.integration_id));
      return {
        market: code,
        required: Number(m.required_completes ?? 0),
        allocated: forMarket.reduce((t, a) => t + Number(a.allocated_completes ?? 0), 0),
        delivered: ordersFor.reduce((t, o) => t + Number(o.delivered_completes ?? 0), 0),
        accepted: ordersFor.reduce((t, o) => t + Number(o.accepted_completes ?? 0), 0),
        cost: forMarket.reduce((t, a) => t + Number(a.allocated_completes ?? 0) * Number(a.cpi ?? 0), 0),
        expectedDeliveryDays: forMarket.length
          ? Math.max(...forMarket.map((a) => Number(a.expected_delivery_days ?? 0)))
          : null,
      };
    }),
    sourceCount: new Set(allocations.map((a) => String(a.integration_id))).size,
    price: budget,
    feasible: rows.some((r) => r.rankable),
    shortfall: Math.max(required - accepted, 0),
    expectedDeliveryDays: null,
    qualityScore: null,
    qualityConfidence: "none",
  });

  return noStore({
    ok: true,
    project: project ?? null,
    markets,
    /** the audience the study is currently looking for, from the definition (0082 / define_audience) */
    audience: audienceFor?.audience ?? null,
    /** one plan, in markets — never a per-source breakdown */
    plan,
    quotas,
    canSeeVendors: actor.canSeeVendors,
    ...supplyChain,
    events,
    /*
     * COUNTS FOR EVERYBODY, COST FOR ADMINISTRATORS.
     *
     * `spend`, `committed` and `blendedCpi` are what the sample cost US — the acquisition figures, before any
     * margin. They sat in this object and reached every researcher, which is the exact leak the abstraction
     * layer exists to prevent; the first version of its guard missed them because it matched key names
     * exactly and the key is called `blendedCpi`, not `cpi`.
     *
     * `budget` stays: it is the researcher's own approved ceiling, not a supplier's price.
     */
    totals: {
      required, accepted, delivered, rejected, duplicates,
      remaining: Math.max(required - accepted, 0),
      budget,
      ...(actor.canSeeVendors ? {
        spend: Math.round(spend * 100) / 100,
        budgetRemaining: Math.round((budget - spend) * 100) / 100,
        blendedCpi: blendedCpi(orders.map((o) => ({ completes: Number(o.accepted_completes ?? 0), cpi: Number(o.agreed_cpi ?? 0) }))),
        committed: totalCost(orders.map((o) => ({ completes: Number(o.ordered_completes ?? 0), cpi: Number(o.agreed_cpi ?? 0) }))),
      } : {}),
    },
    /*
     * Budget headroom is budget minus COMMITTED, never minus spent. A dashboard built on the second number tells
     * a researcher they have money they have already promised to three vendors.
     */
    budget: budgetState({
      budget,
      committed: totalCost(orders.filter((o) => ["placed", "live", "paused", "complete"].includes(String(o.status)))
        .map((o) => ({ completes: Number(o.ordered_completes ?? 0), cpi: Number(o.agreed_cpi ?? 0) }))),
      spent: spend,
      accepted,
      required,
      plannedCostPerValidComplete: latestPlanned(allocations),
      alertBps: Number(project?.budget_alert_bps ?? 8000),
    }),
  });
}

/**
 * The cost per valid complete the current allocation expects — what the budget projection falls back on until
 * enough completes have actually been accepted to have a real rate. Null when nothing has been allocated.
 */
function latestPlanned(allocations: Record<string, unknown>[]): number | null {
  if (!allocations.length) return null;
  const revision = Math.max(...allocations.map((a) => Number(a.revision)));
  const rows = allocations.filter((a) => Number(a.revision) === revision && a.cost_per_valid_complete !== null);
  if (!rows.length) return null;
  const completes = rows.reduce((t, a) => t + Number(a.allocated_completes ?? 0), 0);
  if (completes <= 0) return null;
  return rows.reduce((t, a) => t + Number(a.allocated_completes ?? 0) * Number(a.cost_per_valid_complete), 0) / completes;
}

/**
 * Write the researcher's quota cells down where the runtime can check against them (0088's `quota_sync`).
 *
 * Called whenever the specification or the completes target changes, because a percentage cell's absolute
 * target is a function of both: "40% aged 18–34" is 400 completes at 1,000 and 600 at 1,500, and a cell left
 * at its old number steers recruitment at a target nobody asked for. `accepted` survives the rewrite — a
 * researcher raising a target has not un-recruited the people already counted.
 *
 * An invalid specification is NOT written. A dimension summing to 120% is a mistake worth seeing, and
 * syncing it would put the mistake in front of every arriving respondent instead.
 */
async function syncQuotaCells(
  db: ReturnType<typeof supabaseService>, projectId: string, spec: unknown, requiredCompletes: number,
): Promise<{ cells: number; ok: boolean; statement: string; warning: string | null }> {
  const cells = Array.isArray((spec as { quotas?: unknown[] } | null)?.quotas)
    ? (spec as { quotas: never[] }).quotas : [];
  const plan = planQuotas(cells, requiredCompletes);
  if (!plan.ok) return { cells: 0, ok: false, statement: plan.statement, warning: null };

  const { error } = await db.rpc("rescript_quota_sync", {
    p_project: projectId,
    p_cells: plan.cells.map((c) => ({
      id: c.id, label: c.label, dimension: c.dimension, criteria: c.criteria, targetCompletes: c.targetCompletes,
    })),
  });
  /* a database without 0088 has nowhere to put them; the specification is still saved and still valid */
  if (error) return { cells: 0, ok: true, statement: plan.statement, warning: "Quota cells could not be written down yet." };

  /*
   * The gap worth naming out loud: cells with no mapping are counted at the END of every interview and
   * enforced at the START of none, because nothing can tell from a vendor's URL which cell somebody is in.
   * The quota still holds — it just costs a full interview per person turned away instead of thirty seconds.
   */
  let warning: string | null = null;
  if (plan.cells.length) {
    const { data } = await db.from("recruitment_projects").select("quota_mapping").eq("id", projectId).maybeSingle();
    const mapping = (data as { quota_mapping?: unknown } | null)?.quota_mapping;
    if (!mapping || typeof mapping !== "object" || !Object.keys(mapping as object).length) {
      warning = "These cells are counted when an interview finishes, but nobody can be turned away at the door until a vendor parameter mapping is declared.";
    }
  }
  return { cells: plan.cells.length, ok: true, statement: plan.statement, warning };
}

async function loadAudience(specId: string | null): Promise<unknown> {
  if (!specId) return null;
  const { data } = await supabaseService().from("audience_specifications").select("spec").eq("id", specId).maybeSingle();
  return data?.spec ?? null;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (isFailure(authed)) return authed.response;
  const actor = recruitmentActor(authed);
  if (isFailure(actor)) return actor.response;

  let body: Body;
  try { body = await req.json(); } catch { return noStore({ error: "bad json" }, 400); }
  const action = String(body.action ?? "");

  // reading-shaped actions need only fieldwork.read; everything that commits money needs deploy.manage
  const spending = ["allocate", "authorize", "order", "progress"].includes(action);
  const gate = await requireProjectFor(authed, params.id, spending ? "deploy.manage" : "fieldwork.read");
  if (isFailure(gate)) return spending ? refuseSpend() : gate.response;

  const db = supabaseService();
  const store = recruitmentStore();

  try {
    if (action === "project") {
      const requiredCompletes = num(body.requiredCompletes);
      const budget = num(body.budget);
      if (requiredCompletes === null || requiredCompletes <= 0) return noStore({ error: "requiredCompletes is required" }, 400);
      if (budget === null || budget < 0) return noStore({ error: "budget is required" }, 400);

      let specId: string | null = null;
      let parsedAudience: unknown = null;
      if (body.audience !== undefined && body.audience !== null) {
        const parsed = AudienceSpecification.safeParse(body.audience);
        if (!parsed.success) return noStore({ error: "The audience specification is not valid", detail: parsed.error.issues.slice(0, 5) }, 400);
        parsedAudience = parsed.data;
        const { data, error } = await db.from("audience_specifications").insert({
          customer_id: actor.customerId, survey_id: params.id, spec: parsed.data,
          natural_language: parsed.data.naturalLanguage ?? null, created_by: actor.userId,
        }).select("id").single();
        if (error) throw new Error(error.message);
        specId = data.id as string;
      }

      const existing = await store.project(params.id);
      const row: Record<string, unknown> = {
        required_completes: Math.round(requiredCompletes), budget_amount: budget,
        budget_currency: String(body.currency ?? existing?.budget_currency ?? "USD").toUpperCase(),
        deadline: body.deadline ? String(body.deadline) : null,
        loi_minutes: num(body.loiMinutes), expected_ir: num(body.expectedIr),
        strategy: String(body.strategy ?? existing?.strategy ?? "balanced"),
        updated_at: new Date().toISOString(),
      };
      if (specId) row.audience_spec_id = specId;

      let projectId: string;
      if (existing) {
        const { error } = await db.from("recruitment_projects").update(row).eq("id", existing.id);
        if (error) throw new Error(error.message);
        projectId = existing.id as string;
      } else {
        const { data, error } = await db.from("recruitment_projects").insert({
          ...row, customer_id: actor.customerId, survey_id: params.id, created_by: actor.userId, status: "draft",
        }).select("id").single();
        if (error) throw new Error(error.message);
        projectId = data.id as string;
        await store.recordEvent(projectId, "RecruitmentRequested", `req:${projectId}`, { requiredCompletes, budget }, actor.userId);
      }

      /*
       * The quota cells follow the project, not a separate save. Both inputs they depend on are settled here:
       * the specification and the completes target. Leaving the sync to its own button is how a researcher
       * edits a quota, sees it in the form, and recruits against the old one for a week.
       */
      const quotas = await syncQuotaCells(
        db, projectId,
        specId ? parsedAudience : await loadAudience((existing?.audience_spec_id as string | null) ?? null),
        Math.round(requiredCompletes),
      );
      return noStore({ ok: true, projectId, quotas });
    }

    const project = await store.project(params.id);
    if (!project) return noStore({ error: "This study has no recruitment project yet." }, 409);
    const projectId = project.id as string;
    const status = String(project.status) as RecruitmentProjectStatus;

    /*
     * THE VENDOR PARAMETER MAPPING (0089) — PLATFORM ADMINISTRATORS ONLY.
     *
     * What `?gender=m` means. It is the one piece of quota configuration that is about a VENDOR rather than
     * about the research: the criterion is the researcher's, the parameter name and its codes belong to
     * whoever is supplying the sample, and reading them back would tell a researcher how many different
     * suppliers a project has and what each of them is called. Same gate as the vendor directory, for the
     * same reason — the API not sending it is the only version of that boundary that holds.
     *
     * GET is through the main handler's `supplyChain` payload; this writes.
     */
    if (action === "mapping") {
      if (!actor.canSeeVendors) return refuseVendorVisibility();
      const check = parseQuotaMapping(body.mapping ?? {});
      if (!check.ok) {
        /*
         * Every problem, and nothing saved. A mapping half of which resolves is worse than none: it reads
         * some respondents correctly and silently drops the rest into "attributes unknown", where they are
         * admitted, hold no slot, and are counted only on whatever the screener happened to ask.
         */
        return noStore({ error: "This mapping cannot be used as written.", problems: check.problems }, 400);
      }
      const { error } = await db.from("recruitment_projects")
        .update({ quota_mapping: check.mapping, updated_at: new Date().toISOString() })
        .eq("id", projectId);
      if (error) {
        /* the column arrives with 0089; say which migration rather than relaying a column-not-found */
        if (/quota_mapping/.test(error.message)) {
          return noStore({ error: "This database has not run migration 0089 yet, so there is nowhere to keep the mapping.", code: "migration_missing" }, 409);
        }
        throw new Error(error.message);
      }
      const criteria = [...new Set(Object.values(check.mapping).map((m) => m.criterion))].sort();
      await audit({
        action: "recruitment.mapping_set", userId: actor.userId, customerId: actor.customerId, surveyId: params.id,
        entity: "recruitment_project", entityId: projectId,
        /* the parameter NAMES, never a respondent's values — this is a configuration change, not sample data */
        detail: { parameters: Object.keys(check.mapping).length, criteria: criteria.join(", ") },
      });
      return noStore({
        ok: true,
        mapping: check.mapping,
        statement: Object.keys(check.mapping).length
          ? `${Object.keys(check.mapping).length} parameter${Object.keys(check.mapping).length === 1 ? "" : "s"} now resolve to ${criteria.join(", ")}. Respondents arriving with anything else are admitted and counted on what the survey asks them.`
          : "No mapping is declared, so nobody will be turned away at the door. Quota cells are still counted when an interview finishes.",
      });
    }

    if (action === "compare") {
      const withAudience = { ...project, audience: await loadAudience(project.audience_spec_id as string | null) };
      const { rows, source } = await comparisonFor(actor.customerId, withAudience);
      await store.recordEvent(projectId, "VendorFeasibilityReceived", `feas:${projectId}:${Date.now()}`,
        { vendors: rows.length, rankable: rows.filter((r) => r.rankable).length, source }, actor.userId);
      if (status === "draft") await db.from("recruitment_projects").update({ status: "feasibility" }).eq("id", projectId);
      return noStore({ ok: true, comparison: { rows, source } });
    }

    if (action === "allocate") {
      const rows = Array.isArray(body.rows) ? body.rows : null;
      if (!rows?.length) return noStore({ error: "rows is required" }, 400);
      // every integration in the allocation must be this organisation's
      const mine = new Set((await store.integrations(actor.customerId)).map((i) => i.id));
      for (const r of rows as Record<string, unknown>[]) {
        if (!mine.has(String(r.integration_id ?? r.integrationId ?? ""))) {
          return noStore({ error: "An allocation names a vendor that is not yours" }, 400);
        }
      }
      const existing = await store.allocations(projectId);
      const revision = existing.length ? Math.max(...existing.map((a) => Number(a.revision))) + 1 : 0;
      const normalised = (rows as Record<string, unknown>[]).map((r) => ({
        integration_id: String(r.integration_id ?? r.integrationId),
        allocated_completes: Math.round(num(r.allocated_completes ?? r.completes) ?? 0),
        cpi: num(r.cpi) ?? 0,
        currency: String(r.currency ?? project.budget_currency ?? "USD"),
        expected_valid_completes: num(r.expected_valid_completes ?? r.expectedValidCompletes),
        cost_per_valid_complete: num(r.cost_per_valid_complete ?? r.costPerValidComplete),
        expected_delivery_days: num(r.expected_delivery_days ?? r.expectedDeliveryDays),
        rationale: (r.rationale as Record<string, unknown>) ?? {},
      }));

      let result: { revision: number; vendors: number; total_completes: number; total_cost: number };
      try {
        result = await store.allocate(projectId, revision, normalised, actor.userId);
      } catch (e) {
        // the database refused: over budget, or more completes than the project needs. Say which.
        return noStore({ error: e instanceof Error ? e.message : "The allocation was refused", code: "allocation_refused" }, 409);
      }
      await store.recordEvent(projectId, "AllocationProposed", `alloc:${projectId}:${revision}`,
        { revision, vendors: result.vendors, completes: result.total_completes, cost: result.total_cost }, actor.userId);
      if (canTransition(status, "allocated")) await db.from("recruitment_projects").update({ status: "allocated" }).eq("id", projectId);
      await audit({
        action: "recruitment.allocation_proposed", userId: actor.userId, customerId: actor.customerId, surveyId: params.id,
        entity: "recruitment_project", entityId: projectId,
        detail: { revision, vendors: result.vendors, completes: result.total_completes, cost: result.total_cost },
      });
      return noStore({ ok: true, allocation: result });
    }

    if (action === "authorize") {
      if (!canTransition(status, "authorized")) {
        return noStore({ error: `A project that is ${status} cannot be authorised. Propose an allocation first.`, code: "bad_transition" }, 409);
      }
      const latest = await store.allocations(projectId);
      if (!latest.length) return noStore({ error: "There is no allocation to authorise." }, 409);
      const revision = Math.max(...latest.map((a) => Number(a.revision)));
      const rows = latest.filter((a) => Number(a.revision) === revision);
      const cost = totalCost(rows.map((a) => ({ completes: Number(a.allocated_completes), cpi: Number(a.cpi) })));
      const completes = rows.reduce((s, a) => s + Number(a.allocated_completes), 0);

      const { error } = await db.from("recruitment_projects")
        .update({ status: "authorized", authorized_by: actor.userId, authorized_at: new Date().toISOString() })
        .eq("id", projectId).eq("status", status);
      if (error) throw new Error(error.message);
      await store.recordEvent(projectId, "AllocationApproved", `auth:${projectId}:${revision}`, { revision, completes, cost }, actor.userId);
      await audit({
        action: "recruitment.allocation_authorized", userId: actor.userId, customerId: actor.customerId, surveyId: params.id,
        entity: "recruitment_project", entityId: projectId, detail: { revision, completes, cost },
      });
      return noStore({ ok: true, revision, completes, cost });
    }

    if (action === "order") {
      if (status !== "authorized" && status !== "fielding") {
        return noStore({ error: "Orders can only be placed once the allocation is authorised.", code: "not_authorized" }, 409);
      }
      const integrationId = String(body.integrationId ?? "");
      const integ = await store.integration(actor.customerId, integrationId);
      if (!integ) return noStore({ error: "No such vendor in this organisation" }, 404);
      const completes = num(body.completes);
      const cpi = num(body.cpi);
      if (completes === null || completes <= 0) return noStore({ error: "completes is required" }, 400);
      if (cpi === null || cpi < 0) return noStore({ error: "cpi is required" }, 400);

      /*
       * The database stops an ALLOCATION exceeding the budget; this stops an ORDER exceeding what is left of it
       * after everything already promised. Those are different numbers and both have to hold.
       */
      {
        const placed = (await store.orders(projectId)).filter((o) => ["placed", "live", "paused", "complete"].includes(String(o.status)));
        const state = budgetState({
          budget: Number(project.budget_amount),
          committed: totalCost(placed.map((o) => ({ completes: Number(o.ordered_completes ?? 0), cpi: Number(o.agreed_cpi ?? 0) }))),
          spent: placed.reduce((t, o) => t + Number(o.spend_amount ?? 0), 0),
          accepted: placed.reduce((t, o) => t + Number(o.accepted_completes ?? 0), 0),
          required: Number(project.required_completes),
          alertBps: Number(project.budget_alert_bps ?? 8000),
        });
        const verdict = canCommit(state, completes * cpi);
        if (!verdict.ok) return noStore({ error: verdict.reason, code: "over_budget" }, 409);
      }

      const { data, error } = await db.from("recruitment_orders").insert({
        recruitment_project_id: projectId, integration_id: integrationId,
        ordered_completes: Math.round(completes), agreed_cpi: cpi, currency: integ.currency,
        status: "placed", placed_at: new Date().toISOString(), placed_by: actor.userId,
        notes: body.notes ? String(body.notes).slice(0, 1000) : null,
      }).select("id").single();
      if (error) throw new Error(error.message);

      await store.recordEvent(projectId, "RecruitmentOrderCreated", `order:${data.id}`,
        { completes, cpi, integrationId }, actor.userId, integrationId, data.id as string);

      // committed spend is recomputed in the database, which also reports a threshold CROSSING (once, not every order)
      const commit = await store.recommit(projectId);
      if (commit.crossed) {
        await store.recordEvent(projectId, "BudgetThresholdReached", `budget:${projectId}:${commit.share_bps}`,
          { committed: commit.committed, budget: commit.budget, shareBps: commit.share_bps }, actor.userId);
      }
      if (canTransition(status, "fielding")) await db.from("recruitment_projects").update({ status: "fielding" }).eq("id", projectId);
      await audit({
        action: "recruitment.order_placed", userId: actor.userId, customerId: actor.customerId, surveyId: params.id,
        entity: "recruitment_order", entityId: data.id as string, detail: { completes, cpi, integrationId },
      });
      return noStore({
        ok: true, orderId: data.id, committed: commit.committed, budgetThresholdCrossed: commit.crossed,
        // Phase 1 is honest about what placing an order here does
        note: "Recorded. No vendor was contacted: send the vendor your recruitment link and enter their job number and progress here.",
      });
    }

    if (action === "progress") {
      const orderId = String(body.orderId ?? "");
      const orders = await store.orders(projectId);
      if (!orders.some((o) => String(o.id) === orderId)) return noStore({ error: "No such order on this project" }, 404);
      const delivered = num(body.delivered);
      const accepted = num(body.accepted);
      if (delivered === null || accepted === null) return noStore({ error: "delivered and accepted are required" }, 400);
      if (accepted > delivered) return noStore({ error: "More completes cannot be accepted than were delivered." }, 400);

      // the caller may supply its own key (a vendor webhook's delivery id); an operator's entry gets a fresh one
      const key = body.idempotencyKey ? String(body.idempotencyKey).slice(0, 200) : `manual:${orderId}:${randomUUID()}`;
      const result = await store.applyProgress(orderId, key, {
        delivered: Math.round(delivered), accepted: Math.round(accepted),
        rejected: Math.round(num(body.rejected) ?? 0), duplicates: Math.round(num(body.duplicates) ?? 0),
        spend: num(body.spend), status: body.status ? String(body.status) : null,
        vendorRef: body.vendorRef ? String(body.vendorRef).slice(0, 200) : null,
      });
      if (result?.applied) {
        await audit({
          action: "recruitment.progress_recorded", userId: actor.userId, customerId: actor.customerId, surveyId: params.id,
          entity: "recruitment_order", entityId: orderId, detail: { delivered, accepted, spend: result.spend },
        });
      }
      return noStore({ ok: true, ...result });
    }

    if (action === "markets") {
      const given = Array.isArray(body.markets) ? body.markets as Record<string, unknown>[] : null;
      if (!given) return noStore({ error: "markets is required" }, 400);
      const rows = given.map((m) => ({
        market: String(m.market ?? "").toUpperCase(),
        requiredCompletes: Math.round(num(m.requiredCompletes ?? m.required) ?? 0),
        expectedIr: num(m.expectedIr), loiMinutes: num(m.loiMinutes),
      }));
      for (const r of rows) {
        if (!/^[A-Z]{2}$/.test(r.market)) return noStore({ error: `"${r.market}" is not a two-letter country code` }, 400);
        if (r.requiredCompletes <= 0) return noStore({ error: `${r.market} needs a completes target` }, 400);
      }
      const sum = rows.reduce((t, r) => t + r.requiredCompletes, 0);
      const required = Number(project.required_completes);
      if (sum !== required) {
        return noStore({
          error: `The markets add up to ${sum.toLocaleString()} completes but the project needs ${required.toLocaleString()}. Change the markets or the project's total.`,
          code: "markets_do_not_sum",
        }, 400);
      }
      const saved = await store.setMarkets(projectId, rows);
      return noStore({ ok: true, markets: saved, note: "Re-run Optimise: allocations made before this change were against the old markets." });
    }

    /*
     * PLAN (Phase 3). Six inputs — completes, budget, LOI, incidence, markets, timeline — and a verdict,
     * computed and returned without writing anything. A researcher should learn that a project is over budget
     * BEFORE it is saved, not after authorising it.
     *
     * It builds the same candidates `optimise` does, from the same rate cards, so the verdict and the eventual
     * allocation cannot disagree. What it adds is the margin: the budget is the researcher's PRICE ceiling, and
     * `planRecruitment` holds the optimiser to the cost that corresponds to it.
     */
    if (action === "plan") {
      const completes = num(body.requiredCompletes) ?? Number(project?.required_completes ?? 0);
      const budget = num(body.budget) ?? Number(project?.budget_amount ?? 0);
      const loi = num(body.loiMinutes) ?? Number(project?.loi_minutes ?? 15) ?? 15;
      const ir = num(body.expectedIr) ?? Number(project?.expected_ir ?? 35) ?? 35;
      const timelineDays = num(body.timelineDays) ?? 14;
      const currency = String(body.currency ?? project?.budget_currency ?? "USD");
      const askedMarkets = Array.isArray(body.markets)
        ? (body.markets as Array<Record<string, unknown>>)
            .map((m) => ({ market: String(m.market ?? "").toUpperCase(), completes: Math.round(num(m.completes) ?? 0) }))
            .filter((m) => /^[A-Z]{2}$/.test(m.market) && m.completes > 0)
        : [];

      if (!completes || !budget) return noStore({ error: "requiredCompletes and budget are needed to plan." }, 400);
      if (!askedMarkets.length) return noStore({ error: "At least one market with a completes target is needed." }, 400);

      const withAudience = { ...(project ?? {}), audience: await loadAudience((project?.audience_spec_id as string | null) ?? null) };
      const { integrations, vendorNames } = await comparisonFor(actor.customerId, withAudience);
      const [pricing, capacity] = await Promise.all([
        store.pricing(actor.customerId), store.capacity(actor.customerId),
      ]);
      const history = await store.history(actor.customerId, integrations.map((i) => i.id));

      const candidates = askedMarkets.map((t) => ({
        market: t.market,
        candidates: integrations.filter((i) => i.enabled && (i.mode === "manual" || i.mode === "api")).flatMap((i): AllocationCandidate[] => {
          const row = selectPricing(pricing[i.id] ?? [], { market: t.market, ir, loiMinutes: loi });
          if (!row) return [];
          const cap = capacity[i.id]?.[t.market] ?? null;
          const h = history[i.id];
          return [{
            integrationId: i.id, vendorName: vendorNames.get(i.vendorId) ?? "Vendor",
            /* the vendor's own rate. The MARGIN is applied by the planner, not here — one place, not two. */
            cpi: row.cpi,
            currency: row.currency,
            capacity: cap?.available ?? null,
            rejectionRate: h?.rejectionRate ?? null,
            duplicateRate: h?.duplicateRate ?? null,
            deliveryDays: h?.medianDeliveryDays ?? cap?.deliveryDays ?? null,
            /*
             * Score and confidence from the hourly pass (0085), not from a ladder written out here. This was
             * `qualityScore: null` with the thresholds inline, which meant the project's quality floor could
             * never bite and the quality weight was always applied to nothing.
             */
            qualityScore: h?.qualityScore ?? null,
            qualityConfidence: h?.qualityConfidence ?? "none",
            source: row.source,
          }];
        }),
      }));

      const marginRules = await store.marginRules(actor.customerId);
      const planned = planRecruitment(
        { requiredCompletes: completes, budget, currency, loiMinutes: loi, expectedIr: ir, markets: askedMarkets, timelineDays },
        candidates, marginRules,
        project ? { recruitmentProjectId: String(project.id) } : {},
      );

      /*
       * The cost, the margin and the rule behind them are ADMINISTRATOR information. A researcher gets the
       * verdict, what it would cost them, and what stands in the way — nothing about what we paid for it.
       */
      /*
       * Recommendations are computed from the plan that was just produced, by re-planning each candidate change.
       * They cost a handful of extra solves and they are the difference between "over budget" and something a
       * researcher can act on without guessing.
       */
      const advice = recommend(planned, {
        requiredCompletes: completes, budget, currency, loiMinutes: loi, expectedIr: ir,
        markets: askedMarkets, timelineDays,
      }, { candidates, marginRules, ...(project ? { recruitmentProjectId: String(project.id) } : {}) });

      const forResearcher = {
        advice,
        verdict: planned.verdict,
        summary: planned.summary,
        blockers: planned.blockers,
        markets: planned.markets,
        expectedDeliveryDays: planned.expectedDeliveryDays,
        totalShortfall: planned.totalShortfall,
        price: planned.pricing?.price ?? null,
        pricePerComplete: planned.pricing?.pricePerComplete ?? null,
        fullPrice: planned.fullPrice,
        currency,
      };

      return noStore({
        ok: true,
        plan: forResearcher,
        ...(actor.canSeeVendors ? { commercial: planned.pricing, sourceCount: planned.sourceCount } : {}),
        note: "Nothing has been saved. This is what the plan would cost and whether it can be filled.",
      });
    }

    /*
     * REALLOCATION (Phase 5) — what to do when a vendor is not delivering what the plan assumed.
     *
     * Detects, then proposes. It never applies: `requiresApproval` is a literal `true` on the type, and the
     * only way completes move is a human posting the revised rows to `allocate` afterwards. An alert that
     * silently rewrites a project is worse than no alert, and this one would be rewriting it with money.
     *
     * Two payloads, like everything else here. A researcher learns that a market is behind, by how much, and
     * whether it can still recover; an administrator additionally learns which supplier, what the replacement
     * costs, and what is left uncommitted. The deviation sentences themselves name no vendor — they are counts
     * and percentages — so the researcher's half is BUILT from the fields, not filtered out of the full one.
     */
    if (action === "reallocate") {
      const allocations = await store.allocations(projectId);
      const orders = await store.orders(projectId);
      if (!orders.length) {
        return noStore({
          ok: true, deviations: [], reSource: [],
          statement: "Nothing has been ordered for this project yet, so there is nothing to reallocate.",
        });
      }

      /*
       * How much of the field period has gone. From the FIRST order placed to the deadline — not from the
       * project row's creation, which would make a project drafted in March and fielded in June look nine
       * tenths elapsed on its first day.
       */
      const placedAts = orders.map((o) => o.placed_at as string | null).filter((v): v is string => !!v).sort();
      const startedAt = placedAts[0] ? Date.parse(placedAts[0]) : Date.parse(String(project.created_at));
      const deadline = project.deadline ? Date.parse(String(project.deadline)) : null;
      const now = Date.now();
      const elapsedFraction = deadline && deadline > startedAt
        ? Math.min(1, Math.max(0, (now - startedAt) / (deadline - startedAt)))
        : null;
      if (elapsedFraction === null) {
        /* without a deadline there is no pro-rata expectation, and inventing one would invent the deviations too */
        return noStore({
          ok: true, deviations: [], reSource: [],
          statement: "This project has no deadline, so there is no pace to be behind. Set one to see delivery against it.",
          code: "no_deadline",
        }, 200);
      }

      const marketOf = new Map(allocations.map((a) => [String(a.id), String(a.market ?? "")]));
      const assumedOf = new Map(allocations.map((a) => {
        const expected = Number(a.expected_valid_completes ?? 0);
        const allocated = Number(a.allocated_completes ?? 0);
        /* what the plan assumed would be rejected, read back out of the two numbers it was built from */
        const assumed = allocated > 0 && expected > 0 ? ((allocated - expected) / allocated) * 100 : null;
        return [String(a.id), assumed];
      }));

      const observed: ObservedVendor[] = orders
        .filter((o) => ["placed", "live", "paused", "complete"].includes(String(o.status)))
        .map((o) => ({
          integrationId: String(o.integration_id),
          market: marketOf.get(String(o.allocation_id ?? "")) || String(body.market ?? "") || "--",
          ordered: Number(o.ordered_completes ?? 0),
          delivered: Number(o.delivered_completes ?? 0),
          accepted: Number(o.accepted_completes ?? 0),
          rejected: Number(o.rejected_completes ?? 0),
          assumedRejectionRate: assumedOf.get(String(o.allocation_id ?? "")) ?? null,
          cpi: Number(o.agreed_cpi ?? 0),
          currency: String(o.currency ?? project.budget_currency ?? "USD"),
          spend: Number(o.spend_amount ?? 0) || null,
        }));

      const markets = [...new Set(observed.map((o) => o.market))].filter((m) => /^[A-Z]{2}$/.test(m));
      const withAudience = { ...project, audience: await loadAudience(project.audience_spec_id as string | null) };
      const { integrations, vendorNames } = await comparisonFor(actor.customerId, withAudience);
      const [pricing, capacity, history] = await Promise.all([
        store.pricing(actor.customerId), store.capacity(actor.customerId),
        store.history(actor.customerId, integrations.map((i) => i.id)),
      ]);
      const loi = Number(project.loi_minutes ?? 15) || 15;
      const ir = Number(project.expected_ir ?? 35) || 35;

      const candidates = markets.map((market) => ({
        market,
        candidates: integrations.filter((i) => i.enabled && (i.mode === "manual" || i.mode === "api")).flatMap((i): AllocationCandidate[] => {
          const row = selectPricing(pricing[i.id] ?? [], { market, ir, loiMinutes: loi });
          if (!row) return [];
          const cap = capacity[i.id]?.[market] ?? null;
          const h = history[i.id];
          return [{
            integrationId: i.id, vendorName: vendorNames.get(i.vendorId) ?? "Vendor",
            cpi: row.cpi, currency: row.currency,
            capacity: cap?.available ?? null,
            rejectionRate: h?.rejectionRate ?? null,
            duplicateRate: h?.duplicateRate ?? null,
            deliveryDays: h?.medianDeliveryDays ?? cap?.deliveryDays ?? null,
            qualityScore: h?.qualityScore ?? null,
            qualityConfidence: h?.qualityConfidence ?? "none",
            source: row.source,
          }];
        }),
      }));

      const proposal = proposeReallocation({
        elapsedFraction,
        observed,
        candidates,
        budget: Number(project.budget_amount ?? 0),
        committed: Number(project.committed_amount ?? 0),
        currency: String(project.budget_currency ?? "USD"),
        strategy: String(project.strategy ?? "balanced") as AllocationStrategy,
        ...(project.weights && typeof project.weights === "object" && Object.keys(project.weights).length
          ? { weights: project.weights as { cost: number; quality: number; speed: number } } : {}),
      });

      await audit({
        action: "recruitment.reallocation_proposed", userId: actor.userId, customerId: actor.customerId, surveyId: params.id,
        entity: "recruitment_project", entityId: projectId,
        detail: {
          deviations: proposal.deviations.length,
          moves: proposal.reSource.reduce((t, r) => t + r.completes, 0),
          elapsed: Math.round(elapsedFraction * 100),
        },
      });

      const act = proposal.deviations.filter((d) => d.severity === "act").length;
      return noStore({
        ok: true,
        /* no integrationId: which supplier is behind is supply-chain information, the fact that one is is not */
        deviations: proposal.deviations.map((d) => ({
          market: d.market, kind: d.kind, severity: d.severity, shortfall: d.shortfall, detail: d.detail,
        })),
        reSource: proposal.reSource,
        requiresApproval: true,
        statement: !proposal.deviations.length
          ? `Delivery is tracking the plan with ${Math.round(elapsedFraction * 100)}% of the field period gone.`
          : act
            ? `${proposal.reSource.reduce((t, r) => t + r.completes, 0).toLocaleString()} completes need re-sourcing. Nothing has been changed — this is a proposal.`
            : "Something is worth watching, but nothing is far enough off plan to move completes yet.",
        ...(actor.canSeeVendors ? {
          supplyChain: {
            deviations: proposal.deviations,
            revisedPlan: proposal.revisedPlan,
            headroom: proposal.headroom,
            currency: proposal.currency,
            notes: proposal.notes,
            observed: observed.length,
          },
        } : {}),
      });
    }

    if (action === "optimise") {
      const strategy = String(body.strategy ?? project.strategy ?? "balanced") as AllocationStrategy;
      const withAudience = { ...project, audience: await loadAudience(project.audience_spec_id as string | null) };
      const { integrations, vendorNames } = await comparisonFor(actor.customerId, withAudience);
      const [pricing, capacity, markets] = await Promise.all([
        store.pricing(actor.customerId), store.capacity(actor.customerId), store.markets(projectId),
      ]);
      const history = await store.history(actor.customerId, integrations.map((i) => i.id));

      const required = Number(project.required_completes);
      const loi = Number(project.loi_minutes ?? 15) || 15;
      const ir = Number(project.expected_ir ?? 100) || 100;
      const targets = markets.length
        ? markets.map((m) => ({ market: String(m.market), required: Number(m.required_completes), ir: Number(m.expected_ir ?? ir) || ir, loi: Number(m.loi_minutes ?? loi) || loi }))
        : [{ market: "--", required, ir, loi }];

      /*
       * One candidate per vendor per market, priced from THAT market's rate card. A vendor with no price in a
       * market simply is not a candidate there — which is how a US-only rate card stops being quoted for Japan.
       */
      const marketInputs = targets.map((t) => ({
        market: t.market,
        required: t.required,
        candidates: integrations.filter((i) => i.enabled && (i.mode === "manual" || i.mode === "api")).flatMap((i): AllocationCandidate[] => {
          const row = t.market === "--" ? null : selectPricing(pricing[i.id] ?? [], { market: t.market, ir: t.ir, loiMinutes: t.loi });
          if (!row) return [];
          const cap = capacity[i.id]?.[t.market] ?? null;
          const h = history[i.id];
          return [{
            integrationId: i.id, vendorName: vendorNames.get(i.vendorId) ?? "Vendor",
            cpi: Math.round(row.cpi * (1 + i.markupBps / 10_000) * 100) / 100,
            currency: row.currency,
            capacity: cap?.available ?? null,
            rejectionRate: h?.rejectionRate ?? null,
            duplicateRate: h?.duplicateRate ?? null,
            deliveryDays: h?.medianDeliveryDays ?? cap?.deliveryDays ?? null,
            qualityScore: h?.qualityScore ?? null,
            qualityConfidence: h?.qualityConfidence ?? "none",
            source: row.source,
          }];
        }),
      }));

      const plan = allocate({
        markets: marketInputs,
        budget: Number(project.budget_amount),
        currency: String(project.budget_currency ?? "USD"),
        strategy,
        ...(body.weights ? { weights: body.weights as never } : {}),
        ...(num(body.maxVendorShare) !== null ? { maxVendorShare: num(body.maxVendorShare)! } : {}),
        ...(project.quality_floor !== null && project.quality_floor !== undefined ? { qualityFloor: Number(project.quality_floor) } : {}),
        ...(Array.isArray(body.exclude) ? { excludeIntegrationIds: (body.exclude as unknown[]).map(String) } : {}),
      });

      await store.recordEvent(projectId, "AllocationProposed", `optimise:${projectId}:${Date.now()}`,
        { strategy, feasible: plan.feasible, completes: plan.totalCompletes, cost: plan.totalCost, costPressure: plan.costPressure }, actor.userId);

      return noStore({
        ok: true, plan,
        // proposing is not allocating: nothing was written and nothing was ordered
        note: "This is a proposal. Nothing has been allocated or ordered — review it, then Allocate.",
      });
    }

    return noStore({ error: "unknown action" }, 400);
  } catch (e) {
    return noStore({ error: e instanceof Error ? e.message : "Could not save" }, 400);
  }
}
