import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { AudienceSpecification, canTransition, type AllocationStrategy, type FeasibilityEstimate, type RecruitmentProjectStatus } from "@rescript/schema";
import {
  allocate, blendedCpi, budgetState, canCommit, compareVendors, comparisonSource, costPerValidComplete,
  selectPricing, totalCost, LIVE_ADAPTER_SLUGS, type AllocationCandidate, type FeasibilityInput,
} from "@rescript/recruitment";
import { audit, isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { liveRegistry, LIVE_FEASIBILITY_MS } from "@/lib/recruitment/live";
import { researcherPlan } from "@/lib/recruitment/abstraction";
import { openCredentials } from "@/lib/recruitment/credentials";
import { supabaseService } from "@/lib/authServer";
import { noStore, recruitmentActor, refuseSpend } from "@/lib/recruitment/access";
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
  const supplyChain = actor.canSeeVendors ? {
    comparison: { rows, source },
    capacity,
    allocations: allocations.map((a) => ({ ...a, vendorName: vendorNames.get(String(a.integration_id)) ?? null })),
    orders: orders.map((o) => ({ ...o, vendorName: vendorNames.get(String(o.integration_id)) ?? null })),
    liveAdaptersAvailable: LIVE_ADAPTER_SLUGS.length > 0,
  } : {};

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
      if (body.audience !== undefined && body.audience !== null) {
        const parsed = AudienceSpecification.safeParse(body.audience);
        if (!parsed.success) return noStore({ error: "The audience specification is not valid", detail: parsed.error.issues.slice(0, 5) }, 400);
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

      if (existing) {
        const { error } = await db.from("recruitment_projects").update(row).eq("id", existing.id);
        if (error) throw new Error(error.message);
        return noStore({ ok: true, projectId: existing.id });
      }
      const { data, error } = await db.from("recruitment_projects").insert({
        ...row, customer_id: actor.customerId, survey_id: params.id, created_by: actor.userId, status: "draft",
      }).select("id").single();
      if (error) throw new Error(error.message);
      await store.recordEvent(data.id as string, "RecruitmentRequested", `req:${data.id}`, { requiredCompletes, budget }, actor.userId);
      return noStore({ ok: true, projectId: data.id });
    }

    const project = await store.project(params.id);
    if (!project) return noStore({ error: "This study has no recruitment project yet." }, 409);
    const projectId = project.id as string;
    const status = String(project.status) as RecruitmentProjectStatus;

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
          const n = h?.completes ?? 0;
          return [{
            integrationId: i.id, vendorName: vendorNames.get(i.vendorId) ?? "Vendor",
            cpi: Math.round(row.cpi * (1 + i.markupBps / 10_000) * 100) / 100,
            currency: row.currency,
            capacity: cap?.available ?? null,
            rejectionRate: h?.rejectionRate ?? null,
            duplicateRate: h?.duplicateRate ?? null,
            deliveryDays: cap?.deliveryDays ?? null,
            qualityScore: null,
            qualityConfidence: n >= 1000 ? "high" : n >= 300 ? "medium" : n >= 50 ? "low" : "none",
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
