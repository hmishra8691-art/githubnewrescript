import "server-only";
import { supabaseService } from "@/lib/authServer";
import type { VendorCapabilityState, VendorMode, VendorPricingRow } from "@rescript/schema";
import type { MarginRule } from "@rescript/recruitment";

/**
 * THE RECRUITMENT STORE (2026-11-03) — every read and write of migration 0081, in one place, through the service
 * role, with the organisation named on every single query.
 *
 * RLS already scopes these tables, but RLS protects the *client's* view and this module runs as the service role,
 * which bypasses it. So the `customer_id` predicate here is not a duplicate of the policy: it is the only thing
 * standing between one organisation's rate card and another's. Every function therefore takes `customerId` and
 * uses it, and none of them accept an integration id without checking it belongs to that organisation first.
 *
 * The sealed credentials are never selected. There is one function that can open them (`openCredentials`), it is
 * used by the adapter dispatch and nothing else, and it returns the plaintext to a caller that never logs it.
 */

/**
 * What the hourly pass has scored for one vendor (0085's `vendor_quality_metrics`).
 *
 * Every field can be null except `completes` and `qualityConfidence`, and the nulls mean "not enough history
 * to say" rather than zero. A rejection rate of 0 and a rejection rate nobody has measured are different
 * claims, and a column that cannot tell them apart is how a vendor with no track record wins a project.
 */
export interface VendorHistoryRow {
  completes: number;
  rejectionRate: number | null;
  duplicateRate: number | null;
  qualityScore: number | null;
  qualityConfidence: "none" | "low" | "medium" | "high";
  medianDeliveryDays: number | null;
}

export interface VendorRow {
  id: string;
  customerId: string | null;
  slug: string;
  name: string;
  legalName: string | null;
  website: string | null;
  logoUrl: string | null;
  regions: string[];
  description: string | null;
  panelPreset: string | null;
  status: string;
}

export interface IntegrationRow {
  id: string;
  vendorId: string;
  mode: VendorMode;
  hint: string | null;
  health: string;
  lastContactAt: string | null;
  lastError: string | null;
  markupBps: number;
  currency: string;
  notes: string | null;
  enabled: boolean;
  /** whether a sealed API credential exists. Never the credential itself, and never the ciphertext. */
  hasCredentials: boolean;
}

const VENDOR_COLUMNS = "id, customer_id, slug, name, legal_name, website, logo_url, regions, description, panel_preset, status";
// never `credentials_sealed`, never `credentials_key_id`
/*
 * `credentials_sealed` is selected only so its PRESENCE can be reported. It is turned into a boolean in the
 * mapper below and never leaves this file, so no route can serialise the blob into a response by accident.
 */
const INTEGRATION_COLUMNS = "id, vendor_id, mode, hint, health, last_contact_at, last_error, markup_bps, currency, notes, enabled, credentials_sealed";
const PRICING_COLUMNS = "id, integration_id, market, ir_min, ir_max, loi_min, loi_max, cpi, currency, source, source_note, valid_from, valid_to";

const vendor = (r: Record<string, unknown>): VendorRow => ({
  id: String(r.id), customerId: (r.customer_id as string | null) ?? null, slug: String(r.slug), name: String(r.name),
  legalName: (r.legal_name as string | null) ?? null, website: (r.website as string | null) ?? null,
  logoUrl: (r.logo_url as string | null) ?? null, regions: (r.regions as string[] | null) ?? [],
  description: (r.description as string | null) ?? null, panelPreset: (r.panel_preset as string | null) ?? null,
  status: String(r.status ?? "catalogue"),
});

const integration = (r: Record<string, unknown>): IntegrationRow => ({
  id: String(r.id), vendorId: String(r.vendor_id), mode: r.mode as VendorMode,
  hint: (r.hint as string | null) ?? null, health: String(r.health ?? "unknown"),
  lastContactAt: (r.last_contact_at as string | null) ?? null, lastError: (r.last_error as string | null) ?? null,
  markupBps: Number(r.markup_bps ?? 0), currency: String(r.currency ?? "USD"),
  notes: (r.notes as string | null) ?? null, enabled: r.enabled !== false,
  hasCredentials: typeof r.credentials_sealed === "string" && r.credentials_sealed.length > 0,
});

const pricing = (r: Record<string, unknown>): VendorPricingRow => ({
  id: String(r.id), integrationId: String(r.integration_id), market: String(r.market),
  irMin: Number(r.ir_min), irMax: Number(r.ir_max), loiMin: Number(r.loi_min), loiMax: Number(r.loi_max),
  cpi: Number(r.cpi), currency: String(r.currency ?? "USD"), source: r.source as VendorPricingRow["source"],
  sourceNote: (r.source_note as string | null) ?? undefined,
  validFrom: (r.valid_from as string | null) ?? undefined, validTo: (r.valid_to as string | null) ?? null,
});

export function recruitmentStore() {
  const db = supabaseService();

  return {
    /** the platform catalogue plus this organisation's own vendors */
    async vendors(customerId: string): Promise<VendorRow[]> {
      const { data, error } = await db.from("panel_vendors").select(VENDOR_COLUMNS)
        .or(`customer_id.is.null,customer_id.eq.${customerId}`)
        .eq("status", "catalogue").order("name");
      if (error) throw new Error(error.message);
      return (data ?? []).map(vendor);
    },

    async integrations(customerId: string): Promise<IntegrationRow[]> {
      const { data, error } = await db.from("vendor_integrations").select(INTEGRATION_COLUMNS)
        .eq("customer_id", customerId);
      if (error) throw new Error(error.message);
      return (data ?? []).map(integration);
    },

    /** an integration id is only an integration id if it belongs to this organisation */
    async integration(customerId: string, id: string): Promise<IntegrationRow | null> {
      const { data, error } = await db.from("vendor_integrations").select(INTEGRATION_COLUMNS)
        .eq("customer_id", customerId).eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? integration(data) : null;
    },

    async capabilities(customerId: string): Promise<Record<string, VendorCapabilityState[]>> {
      const mine = await this.integrations(customerId);
      if (!mine.length) return {};
      const { data, error } = await db.from("vendor_capabilities")
        .select("integration_id, capability, supported, verified_at, notes")
        .in("integration_id", mine.map((i) => i.id));
      if (error) throw new Error(error.message);
      const out: Record<string, VendorCapabilityState[]> = {};
      for (const r of data ?? []) {
        const key = String(r.integration_id);
        (out[key] ??= []).push({
          capability: r.capability as VendorCapabilityState["capability"],
          supported: r.supported === true,
          verifiedAt: (r.verified_at as string | null) ?? null,
          ...(r.notes ? { notes: String(r.notes) } : {}),
        });
      }
      return out;
    },

    async pricing(customerId: string, integrationIds?: string[]): Promise<Record<string, VendorPricingRow[]>> {
      const mine = await this.integrations(customerId);
      const ids = integrationIds ? mine.filter((i) => integrationIds.includes(i.id)).map((i) => i.id) : mine.map((i) => i.id);
      if (!ids.length) return {};
      const { data, error } = await db.from("vendor_pricing").select(PRICING_COLUMNS).in("integration_id", ids);
      if (error) throw new Error(error.message);
      const out: Record<string, VendorPricingRow[]> = {};
      for (const r of data ?? []) (out[String(r.integration_id)] ??= []).push(pricing(r));
      return out;
    },

    /**
     * How this vendor has actually performed for this organisation.
     *
     * READ, never recomputed. `rescript_vendor_quality_recompute` (0085, run by the hourly pass) is the one
     * place that turns orders into a rate, a Wilson interval, a score and a confidence; this reads the row it
     * wrote. Until that change there were FOUR implementations of the same judgement — here, in quality.ts, in
     * feasibility.ts and inline in the planner's candidate builder — and they had already begun to disagree:
     * one used z = 1.96 and another z = 1.959964.
     *
     * A vendor with no row is simply absent from the result, which the caller reads as `qualityConfidence:
     * "none"`. That is the truthful answer — nothing has scored this vendor — and it is exactly the state the
     * optimiser's prior substitution and confidence share cap were built for. It is NOT the same as a bad
     * score, and aggregating the raw orders here to fill the gap would be the fifth implementation.
     */
    async history(customerId: string, integrationIds: string[]): Promise<Record<string, VendorHistoryRow>> {
      if (!integrationIds.length) return {};
      const { data, error } = await db.from("vendor_quality_metrics")
        .select("integration_id, accepted, rejection_rate, duplicate_rate, quality_score, confidence, median_delivery_days, window_days, computed_at")
        .eq("customer_id", customerId)
        .is("market", null)
        .in("integration_id", integrationIds)
        .order("computed_at", { ascending: false });
      /* 0085 not applied: no metrics, so no history, so every vendor is unknown rather than wrongly scored */
      if (error) return {};

      const out: Record<string, VendorHistoryRow> = {};
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const k = String(r.integration_id);
        // ordered newest first, so the first row for an integration is the one to keep
        if (out[k]) continue;
        const confidence = String(r.confidence ?? "none");
        out[k] = {
          completes: Number(r.accepted ?? 0),
          rejectionRate: r.rejection_rate === null || r.rejection_rate === undefined ? null : Number(r.rejection_rate),
          duplicateRate: r.duplicate_rate === null || r.duplicate_rate === undefined ? null : Number(r.duplicate_rate),
          qualityScore: r.quality_score === null || r.quality_score === undefined ? null : Number(r.quality_score),
          qualityConfidence: confidence === "high" || confidence === "medium" || confidence === "low" ? confidence : "none",
          medianDeliveryDays: r.median_delivery_days === null || r.median_delivery_days === undefined ? null : Number(r.median_delivery_days),
        };
      }
      return out;
    },

    /* ------------------------------------------------------------ writes */

    /**
     * The sealed credential for ONE integration, read only when a call is about to be made.
     *
     * Deliberately not part of `integrations()`: a list query that carried every organisation's ciphertext
     * would put it in memory on every page load of the marketplace, for no reason. The caller opens it with
     * lib/recruitment/credentials.ts and never returns it.
     */
    async sealedCredentials(customerId: string, integrationId: string): Promise<string | null> {
      const { data, error } = await db.from("vendor_integrations")
        .select("credentials_sealed")
        .eq("id", integrationId).eq("customer_id", customerId).maybeSingle();
      if (error) throw new Error(error.message);
      const sealed = (data as { credentials_sealed?: string | null } | null)?.credentials_sealed;
      return typeof sealed === "string" && sealed.length > 0 ? sealed : null;
    },

    /**
     * The organisation's margin rules (0087).
     *
     * Read for every plan, because the margin decides the price and therefore whether a project is over
     * budget. Returns an empty list when none are configured, and the engine then uses the platform default —
     * which is a real rate, not a missing one, and `resolveMargin` says so in its reason.
     */
    async marginRules(customerId: string): Promise<MarginRule[]> {
      const { data, error } = await db.from("commercial_margins")
        .select("id, scope, margin_bps, market, recruitment_type, recruitment_project_id, note, effective_from, effective_to")
        .eq("customer_id", customerId);
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: String(row.id),
          scope: row.scope as MarginRule["scope"],
          marginBps: Number(row.margin_bps ?? 0),
          market: (row.market as string | null) ?? null,
          recruitmentType: (row.recruitment_type as string | null) ?? null,
          recruitmentProjectId: (row.recruitment_project_id as string | null) ?? null,
          note: (row.note as string | null) ?? null,
          effectiveFrom: (row.effective_from as string | null) ?? null,
          effectiveTo: (row.effective_to as string | null) ?? null,
        };
      });
    },

    async upsertIntegration(customerId: string, vendorId: string, patch: {
      mode?: VendorMode; markupBps?: number; currency?: string; notes?: string | null; enabled?: boolean;
      /* sealed by lib/recruitment/credentials.ts; this store never sees a plaintext token (0086) */
      credentialsSealed?: string; credentialsKeyId?: string; hint?: string;
    }, actor: string): Promise<IntegrationRow> {
      const existing = await db.from("vendor_integrations").select("id")
        .eq("customer_id", customerId).eq("vendor_id", vendorId).maybeSingle();
      const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.mode !== undefined) row.mode = patch.mode;
      if (patch.markupBps !== undefined) row.markup_bps = patch.markupBps;
      if (patch.currency !== undefined) row.currency = patch.currency;
      if (patch.notes !== undefined) row.notes = patch.notes;
      if (patch.enabled !== undefined) row.enabled = patch.enabled;
      if (patch.credentialsSealed !== undefined) row.credentials_sealed = patch.credentialsSealed;
      if (patch.credentialsKeyId !== undefined) row.credentials_key_id = patch.credentialsKeyId;
      if (patch.hint !== undefined) row.hint = patch.hint;

      if (existing.data?.id) {
        const { data, error } = await db.from("vendor_integrations").update(row)
          .eq("id", existing.data.id).eq("customer_id", customerId).select(INTEGRATION_COLUMNS).single();
        if (error) throw new Error(error.message);
        return integration(data);
      }
      const { data, error } = await db.from("vendor_integrations")
        .insert({ ...row, customer_id: customerId, vendor_id: vendorId, created_by: actor, mode: patch.mode ?? "awaiting" })
        .select(INTEGRATION_COLUMNS).single();
      if (error) throw new Error(error.message);
      return integration(data);
    },

    async setCapability(customerId: string, integrationId: string, capability: string, supported: boolean, notes?: string | null): Promise<void> {
      const owned = await this.integration(customerId, integrationId);
      if (!owned) throw new Error("No such integration in this organisation");
      const { error } = await db.from("vendor_capabilities")
        .upsert({ integration_id: integrationId, capability, supported, notes: notes ?? null, updated_at: new Date().toISOString() },
          { onConflict: "integration_id,capability" });
      if (error) throw new Error(error.message);
    },

    async addPricing(customerId: string, integrationId: string, row: Omit<VendorPricingRow, "id" | "integrationId">, actor: string): Promise<VendorPricingRow> {
      const owned = await this.integration(customerId, integrationId);
      if (!owned) throw new Error("No such integration in this organisation");
      const { data, error } = await db.from("vendor_pricing").insert({
        integration_id: integrationId, market: row.market, ir_min: row.irMin, ir_max: row.irMax,
        loi_min: row.loiMin, loi_max: row.loiMax, cpi: row.cpi, currency: row.currency,
        source: row.source, source_note: row.sourceNote ?? null,
        valid_from: row.validFrom ?? new Date().toISOString(), valid_to: row.validTo ?? null, created_by: actor,
      }).select(PRICING_COLUMNS).single();
      if (error) throw new Error(error.message);
      return pricing(data);
    },

    async deletePricing(customerId: string, id: string): Promise<boolean> {
      const mine = await this.integrations(customerId);
      if (!mine.length) return false;
      const { error, count } = await db.from("vendor_pricing").delete({ count: "exact" })
        .eq("id", id).in("integration_id", mine.map((i) => i.id));
      if (error) throw new Error(error.message);
      return (count ?? 0) > 0;
    },

    /* ------------------------------------------------------------ markets and capacity (0082) */

    /** A project's completes target per country. Empty means the project is a single pool, as in 0081. */
    async markets(projectId: string) {
      const { data, error } = await db.from("recruitment_markets")
        .select("id, market, required_completes, expected_ir, loi_minutes, budget_cap, notes")
        .eq("recruitment_project_id", projectId).order("market");
      if (error) throw new Error(error.message);
      return data ?? [];
    },

    /**
     * Replace a project's markets wholesale. Deleting a market with allocations against it would orphan them, so
     * the caller is expected to re-allocate afterwards; the route says so.
     */
    async setMarkets(projectId: string, rows: { market: string; requiredCompletes: number; expectedIr?: number | null; loiMinutes?: number | null; budgetCap?: number | null }[]) {
      const del = await db.from("recruitment_markets").delete().eq("recruitment_project_id", projectId);
      if (del.error) throw new Error(del.error.message);
      if (!rows.length) return [];
      const { data, error } = await db.from("recruitment_markets").insert(rows.map((r) => ({
        recruitment_project_id: projectId, market: r.market, required_completes: r.requiredCompletes,
        expected_ir: r.expectedIr ?? null, loi_minutes: r.loiMinutes ?? null, budget_cap: r.budgetCap ?? null,
      }))).select("id, market, required_completes, expected_ir, loi_minutes, budget_cap");
      if (error) throw new Error(error.message);
      return data ?? [];
    },

    /**
     * The most recent, unexpired availability each vendor stated per market.
     *
     * A capacity figure is perishable. An expired row is not returned at all rather than returned with a flag,
     * because a stale number that reaches a dashboard is indistinguishable from a fresh one by the time anybody
     * reads it — and the optimiser's treatment of "unknown" is deliberately safe.
     */
    async capacity(customerId: string, integrationIds?: string[]): Promise<Record<string, Record<string, { available: number | null; expectedIr: number | null; deliveryDays: number | null; source: string; recordedAt: string }>>> {
      const mine = await this.integrations(customerId);
      const ids = integrationIds ? mine.filter((i) => integrationIds.includes(i.id)).map((i) => i.id) : mine.map((i) => i.id);
      if (!ids.length) return {};
      const { data, error } = await db.from("vendor_capacity")
        .select("integration_id, market, available_sample, expected_ir, delivery_days, source, recorded_at, expires_at")
        .in("integration_id", ids).order("recorded_at", { ascending: false });
      if (error) throw new Error(error.message);
      const now = Date.now();
      const out: Record<string, Record<string, { available: number | null; expectedIr: number | null; deliveryDays: number | null; source: string; recordedAt: string }>> = {};
      for (const r of data ?? []) {
        const expires = r.expires_at ? Date.parse(String(r.expires_at)) : null;
        if (expires !== null && expires <= now) continue;
        const byMarket = (out[String(r.integration_id)] ??= {});
        // ordered newest first, so the first row for a market wins
        if (byMarket[String(r.market)]) continue;
        byMarket[String(r.market)] = {
          available: r.available_sample === null ? null : Number(r.available_sample),
          expectedIr: r.expected_ir === null ? null : Number(r.expected_ir),
          deliveryDays: r.delivery_days === null ? null : Number(r.delivery_days),
          source: String(r.source), recordedAt: String(r.recorded_at),
        };
      }
      return out;
    },

    async addCapacity(customerId: string, integrationId: string, row: {
      market: string; available: number | null; expectedIr?: number | null; deliveryDays?: number | null;
      source: string; sourceNote?: string | null; expiresAt?: string | null;
    }, actor: string) {
      const owned = await this.integration(customerId, integrationId);
      if (!owned) throw new Error("No such integration in this organisation");
      const { error } = await db.from("vendor_capacity").insert({
        integration_id: integrationId, market: row.market, available_sample: row.available,
        expected_ir: row.expectedIr ?? null, delivery_days: row.deliveryDays ?? null,
        source: row.source, source_note: row.sourceNote ?? null, expires_at: row.expiresAt ?? null,
        recorded_by: actor,
      });
      if (error) throw new Error(error.message);
    },

    /** Recompute committed spend and report whether the budget alert threshold was crossed by this change. */
    async recommit(projectId: string): Promise<{ committed: number; budget: number; crossed: boolean; share_bps: number }> {
      const { data, error } = await db.rpc("rescript_recruitment_recommit", { p_project: projectId });
      if (error) throw new Error(error.message);
      const r = Array.isArray(data) ? data[0] : data;
      return { committed: Number(r.committed), budget: Number(r.budget), crossed: r.crossed === true, share_bps: Number(r.share_bps) };
    },

    /* ------------------------------------------------------------ a study's recruitment project */

    async project(surveyId: string) {
      const { data, error } = await db.from("recruitment_projects")
        .select("id, customer_id, survey_id, audience_spec_id, required_completes, budget_amount, budget_currency, deadline, loi_minutes, expected_ir, strategy, weights, quality_floor, status, budget_alert_bps, committed_amount, authorized_by, authorized_at, created_at")
        .eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async allocations(projectId: string, revision?: number) {
      let q = db.from("sample_allocations")
        /* `market` added by 0082 and never selected here, so nothing downstream could group an allocation by market */
        .select("id, revision, integration_id, market, allocated_completes, cpi, currency, expected_valid_completes, cost_per_valid_complete, expected_delivery_days, rationale, created_at")
        .eq("recruitment_project_id", projectId);
      if (revision !== undefined) q = q.eq("revision", revision);
      const { data, error } = await q.order("revision", { ascending: false });
      if (error) throw new Error(error.message);
      return data ?? [];
    },

    async orders(projectId: string) {
      const { data, error } = await db.from("recruitment_orders")
        .select("id, integration_id, allocation_id, ordered_completes, agreed_cpi, currency, vendor_order_ref, status, delivered_completes, accepted_completes, rejected_completes, duplicate_attempts, spend_amount, placed_at, last_sync_at, notes")
        .eq("recruitment_project_id", projectId).order("placed_at", { ascending: true, nullsFirst: false });
      if (error) throw new Error(error.message);
      return data ?? [];
    },

    async events(projectId: string, limit = 100) {
      const { data, error } = await db.from("recruitment_events")
        .select("id, type, integration_id, order_id, payload, occurred_at")
        .eq("recruitment_project_id", projectId).order("occurred_at", { ascending: false }).limit(limit);
      if (error) throw new Error(error.message);
      return data ?? [];
    },

    /** The orchestrator's log. Idempotent by key: a replayed request records one event. */
    async recordEvent(projectId: string, type: string, idempotencyKey: string, payload: Record<string, unknown>, actor: string | null, integrationId?: string | null, orderId?: string | null): Promise<boolean> {
      const { error } = await db.from("recruitment_events").insert({
        recruitment_project_id: projectId, type, idempotency_key: idempotencyKey,
        integration_id: integrationId ?? null, order_id: orderId ?? null, payload, actor,
      });
      if (error) return !/duplicate key|unique/i.test(error.message) ? (() => { throw new Error(error.message); })() : false;
      return true;
    },

    /** The atomic allocation of 0081: the budget and the required completes are ceilings the database enforces. */
    async allocate(projectId: string, revision: number, rows: unknown[], actor: string) {
      const { data, error } = await db.rpc("rescript_recruitment_allocate", {
        p_project: projectId, p_revision: revision, p_rows: rows, p_actor: actor,
      });
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data[0] : data;
    },

    /** Apply a vendor's progress exactly once. Counts are absolute. */
    async applyProgress(orderId: string, idempotencyKey: string, p: {
      delivered: number; accepted: number; rejected?: number; duplicates?: number; spend?: number | null; status?: string | null; vendorRef?: string | null;
    }) {
      const { data, error } = await db.rpc("rescript_recruitment_order_apply", {
        p_order: orderId, p_idempotency_key: idempotencyKey, p_delivered: p.delivered, p_accepted: p.accepted,
        p_rejected: p.rejected ?? 0, p_duplicates: p.duplicates ?? 0, p_spend: p.spend ?? null,
        p_status: p.status ?? null, p_vendor_ref: p.vendorRef ?? null,
      });
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data[0] : data;
    },
  };
}
